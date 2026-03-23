// Advisory-only insights inspired by FUTURE_WORK.
// This foundation is deterministic today and can be extended with model calls later.

import {
  getFlowCalibrationSuggestions,
  getRecentDiscrepancies,
  getRecentPrecipitationAudits,
} from '../db/state.js';

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function signedPrecipBiasPct(audit) {
  const ambient = toNumber(audit.ambient_inches);
  const openmeteo = toNumber(audit.openmeteo_inches);
  const scale = Math.max(Math.abs(ambient), Math.abs(openmeteo));
  if (scale === 0) return 0;
  return ((ambient - openmeteo) / scale) * 100;
}

function severityRank(severity) {
  switch (severity) {
    case 'critical': return 0;
    case 'warning': return 1;
    default: return 2;
  }
}

export function aiNarrationEnabled() {
  return Boolean(process.env.AI_API_KEY);
}

export function collectAdvisorInsights(options = {}) {
  const {
    discrepancyHours = 24,
    precipitationAuditDays = 7,
    maxInsights = 4,
  } = options;

  const insights = [];

  const discrepancies = getRecentDiscrepancies(discrepancyHours);
  if (discrepancies.length >= 3) {
    const maxDiff = discrepancies.reduce((largest, entry) => {
      const diff = Math.abs(toNumber(entry.ambient_value) - toNumber(entry.openmeteo_value));
      return Math.max(largest, diff);
    }, 0);

    insights.push({
      kind: 'forecast-confidence',
      severity: discrepancies.length >= 5 || maxDiff >= 0.3 ? 'warning' : 'info',
      title: 'Forecast confidence is reduced',
      summary: `Ambient Weather and Open-Meteo disagreed ${discrepancies.length} times in the last ${discrepancyHours} hours, by as much as ${maxDiff.toFixed(2)} inches of rain. Treat automatic rain skips conservatively until the sources line up again.`,
    });
  }

  const precipitationAudits = getRecentPrecipitationAudits(precipitationAuditDays);
  if (precipitationAudits.length >= 3) {
    const biasedDays = precipitationAudits
      .map(audit => ({ ...audit, biasPct: signedPrecipBiasPct(audit) }))
      .filter(audit => Math.abs(audit.biasPct) >= 20);

    if (biasedDays.length >= 3) {
      const averageBias = biasedDays.reduce((sum, audit) => sum + audit.biasPct, 0) / biasedDays.length;
      const direction = averageBias > 0
        ? 'Ambient Weather has been reading wetter than Open-Meteo'
        : 'Ambient Weather has been reading drier than Open-Meteo';

      insights.push({
        kind: 'rain-gauge-bias',
        severity: 'warning',
        title: 'Rain gauge may need inspection',
        summary: `${direction} on ${biasedDays.length} of the last ${precipitationAudits.length} audited days (average bias ${Math.abs(averageBias).toFixed(0)}%). Check the gauge for debris, leveling issues, or calibration drift.`,
      });
    }
  }

  const flowSuggestions = getFlowCalibrationSuggestions()
    .sort((left, right) => Math.abs(toNumber(right.avg_deviation)) - Math.abs(toNumber(left.avg_deviation)));

  for (const suggestion of flowSuggestions) {
    const avgDeviation = toNumber(suggestion.avg_deviation);
    const severity = Math.abs(avgDeviation) >= 25 ? 'warning' : 'info';
    const direction = avgDeviation > 0 ? 'higher' : 'lower';
    const likelyCause = avgDeviation > 0
      ? 'Possible causes are nozzle mismatch, a leak, or an underestimated flow rate.'
      : 'Possible causes are clogging, pressure loss, or an overestimated flow rate.';

    insights.push({
      kind: 'flow-calibration',
      severity,
      title: `Zone ${suggestion.zone_number} flow is ${Math.abs(avgDeviation).toFixed(0)}% ${direction} than expected`,
      summary: `Flow meter readings have stayed ${direction} than the model for ${suggestion.run_count} runs. ${likelyCause}`,
    });
  }

  return insights
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity))
    .slice(0, maxInsights);
}

export function formatAdvisorInsight(insight) {
  return `${insight.title}. ${insight.summary}`;
}

function extractMessageText(message) {
  if (typeof message === 'string') {
    return message.trim();
  }
  if (Array.isArray(message)) {
    return message
      .map(part => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

export async function callAdvisorModel(messages, options = {}) {
  if (!aiNarrationEnabled()) {
    return null;
  }

  const baseUrl = (process.env.AI_API_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
  const model = process.env.AI_MODEL || 'moonshot-v1-8k';
  const timeoutSignal = globalThis.AbortSignal?.timeout
    ? globalThis.AbortSignal.timeout(options.timeoutMs ?? 15000)
    : undefined;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 220,
      messages,
    }),
    signal: timeoutSignal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AI provider returned ${response.status}: ${body.slice(0, 160)}`);
  }

  const payload = await response.json();
  const content = extractMessageText(payload?.choices?.[0]?.message?.content);
  return content || null;
}

export async function generateSummaryNarrative(context = {}) {
  if (!aiNarrationEnabled()) {
    return null;
  }

  const payload = {
    overnightSummary: context.overnightSummary || 'No overnight summary available',
    weatherStatus: context.weatherStatus || 'Unknown',
    forecastText: context.forecastText || 'Forecast unavailable',
    yesterdayUsage: context.yesterdayUsage || { gallons: 0, cost: 0 },
    monthlyUsage: context.monthlyUsage || { gallons: 0, cost: 0 },
    discrepancyCount: Array.isArray(context.discrepancies) ? context.discrepancies.length : 0,
    advisorInsights: Array.isArray(context.advisorInsights)
      ? context.advisorInsights.map(formatAdvisorInsight)
      : [],
  };

  return callAdvisorModel([
    {
      role: 'system',
      content: 'You are an irrigation operations advisor. Write 2-4 concise sentences for a homeowner. Use only the supplied facts, stay advisory-only, and never invent measurements or recommendations that are not grounded in the input.',
    },
    {
      role: 'user',
      content: `Summarize this smart irrigation status into a brief narrative with any noteworthy risks or tuning opportunities:\n${JSON.stringify(payload)}`,
    },
  ]);
}
