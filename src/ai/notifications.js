// Contextual AI-powered notification enrichment.
// Takes raw system alerts and transforms them into actionable,
// context-aware messages for the homeowner.

import { callAdvisorModel, aiNarrationEnabled, collectAdvisorInsights } from './advisor.js';
import { getCachedWeather, getRecentDiscrepancies, getSoilMoisture } from '../db/state.js';
import { localDateStr } from '../time.js';

function buildAlertContext(alert) {
  const moisture = getSoilMoisture();
  const discrepancies = getRecentDiscrepancies(24);
  const ambientCache = getCachedWeather('ambient');
  const forecastCache = getCachedWeather('openmeteo_forecast');
  const insights = collectAdvisorInsights();

  let weather = null;
  if (ambientCache) {
    try { weather = JSON.parse(ambientCache.data_json); } catch { /* empty */ }
  }

  let forecast = null;
  if (forecastCache) {
    try {
      const days = JSON.parse(forecastCache.data_json);
      forecast = days.slice(0, 3);
    } catch { /* empty */ }
  }

  const moistureSummary = moisture.length > 0
    ? moisture.map(z => {
        const pct = z.total_capacity > 0 ? Math.round((z.balance_inches / z.total_capacity) * 100) : 0;
        return `Zone ${z.zone_number}: ${pct}%`;
      }).join(', ')
    : 'no data';

  return {
    alertType: alert.type,
    alertMessage: alert.message,
    alertSeverity: alert.severity || 'info',
    today: localDateStr(),
    currentWeather: weather ? `${weather.temp}F, ${weather.humidity}% RH, wind ${weather.windSpeed} mph` : 'unavailable',
    forecast3day: forecast || 'unavailable',
    soilMoisture: moistureSummary,
    recentDiscrepancies: discrepancies.length,
    activeInsights: insights.map(i => `[${i.severity}] ${i.title}`),
  };
}

export async function enrichNotification(alert) {
  if (!aiNarrationEnabled()) {
    return { subject: alert.message, body: alert.message };
  }

  const context = buildAlertContext(alert);

  const result = await callAdvisorModel([
    {
      role: 'system',
      content: `You enrich system alerts for a homeowner's smart irrigation system. Given a raw alert and system context, write:
1. A short subject line (under 60 chars, no quotes)
2. A 2-4 sentence explanation with specific context about why this matters, what the system is doing about it, and whether the homeowner needs to act.

Format your response as:
SUBJECT: <subject line>
BODY: <explanation>`,
    },
    {
      role: 'user',
      content: `Enrich this alert with context:\n${JSON.stringify(context)}`,
    },
  ], { maxTokens: 1024, timeoutMs: 30000 });

  if (!result?.content) {
    return { subject: alert.message, body: alert.message };
  }

  const subjectMatch = result.content.match(/SUBJECT:\s*(.+)/i);
  const bodyMatch = result.content.match(/BODY:\s*([\s\S]+)/i);

  return {
    subject: subjectMatch ? subjectMatch[1].trim() : alert.message,
    body: bodyMatch ? bodyMatch[1].trim() : result.content,
    reasoning: result.reasoning,
  };
}

// Standard alert types the system can generate
export function weatherStaleAlert(ageMinutes) {
  return {
    type: 'weather-stale',
    severity: ageMinutes > 1440 ? 'critical' : ageMinutes > 720 ? 'warning' : 'info',
    message: `Weather station has not reported in ${Math.round(ageMinutes)} minutes`,
  };
}

export function missedRunAlert(hoursSinceLastRun) {
  return {
    type: 'missed-run',
    severity: 'warning',
    message: `No successful run in the last ${Math.round(hoursSinceLastRun)} hours`,
  };
}

export function commandFailureAlert(error) {
  return {
    type: 'command-failure',
    severity: 'critical',
    message: `Rachio command failed: ${error}`,
  };
}

export function budgetWarningAlert(pctUsed) {
  return {
    type: 'budget-warning',
    severity: pctUsed >= 100 ? 'critical' : 'warning',
    message: `Water budget is at ${Math.round(pctUsed)}% for this billing cycle`,
  };
}
