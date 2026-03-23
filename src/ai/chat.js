// "Ask Your Yard" - natural language chat grounded in live system data.
// Pulls context from SQLite, injects it into the prompt, and lets the
// thinking model reason through it before answering.

import { localDateStr } from '../time.js';
import {
  getStatus, getRunsSince, getFinanceData, getDailyUsage,
  getSoilMoisture, getCachedWeather, getRecentDiscrepancies,
  getRecentPrecipitationAudits, getFlowCalibrationSuggestions,
} from '../db/state.js';
import { collectAdvisorInsights } from './advisor.js';
import { callAdvisorModel } from './advisor.js';

function safeJSON(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return 'unavailable';
  }
}

function buildSystemContext() {
  const todayStr = localDateStr();
  const status = getStatus(todayStr);
  const finance = getFinanceData();
  const todayUsage = getDailyUsage(todayStr);
  const moisture = getSoilMoisture();

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentRuns = getRunsSince(weekAgo);
  const decisions = recentRuns.filter(r => r.phase === 'DECIDE');
  const waterRuns = decisions.filter(r => r.decision === 'WATER');
  const skipRuns = decisions.filter(r => r.decision === 'SKIP');

  const ambientCache = getCachedWeather('ambient');
  const forecastCache = getCachedWeather('openmeteo_forecast');
  const discrepancies = getRecentDiscrepancies(48);
  const precipAudits = getRecentPrecipitationAudits(14);
  const flowSuggestions = getFlowCalibrationSuggestions();
  const advisorInsights = collectAdvisorInsights();

  let currentWeather = null;
  if (ambientCache) {
    try { currentWeather = JSON.parse(ambientCache.data_json); } catch { /* empty */ }
  }

  let forecast = null;
  if (forecastCache) {
    try { forecast = JSON.parse(forecastCache.data_json); } catch { /* empty */ }
  }

  const lastRun = status.lastRun;

  return `You are the AI assistant for the Smart Water System, an ET-based smart irrigation controller for a Rachio sprinkler system. You answer questions about the yard, watering decisions, weather, costs, and system health. You have access to live data from the system database as of right now.

IMPORTANT RULES:
- Only use the data provided below. Never invent measurements, dates, or zone names.
- If you do not have enough data to answer, say so honestly.
- The watering decision engine is fully deterministic. You cannot change it. You are advisory only.
- Be concise (2-5 sentences) unless the user asks for detail.
- Use specific numbers from the data when relevant.

TODAY: ${todayStr}

CURRENT WEATHER (from Ambient Weather station):
${currentWeather ? safeJSON(currentWeather) : 'Weather station data not available'}
Cache age: ${ambientCache?.fetched_at || 'unknown'}

FORECAST (next 7 days from Open-Meteo):
${forecast ? safeJSON(forecast.slice(0, 7)) : 'Forecast not available'}

SOIL MOISTURE (per zone, current):
${moisture.length > 0 ? moisture.map(z => `Zone ${z.zone_number} (${z.zone_name}): ${z.balance_inches.toFixed(2)}" of ${z.total_capacity.toFixed(2)}" capacity (${z.total_capacity > 0 ? Math.round((z.balance_inches / z.total_capacity) * 100) : 0}%)`).join('\n') : 'No moisture data'}

LAST DECISION:
${lastRun ? `${lastRun.decision} - ${lastRun.reason} (${lastRun.timestamp})${lastRun.shadow ? ' [shadow mode]' : ''}` : 'No runs yet'}

RECENT ACTIVITY (last 7 days):
${decisions.length} decisions: ${waterRuns.length} watered, ${skipRuns.length} skipped
${waterRuns.length > 0 ? 'Last water: ' + safeJSON({ timestamp: waterRuns[0].timestamp, reason: waterRuns[0].reason, gallons: waterRuns[0].total_gallons }) : 'No watering in last 7 days'}
${skipRuns.slice(0, 3).map(r => `Skip: ${r.reason} (${r.timestamp?.slice(0, 16)})`).join('\n')}

WATER USAGE:
Today: ${todayUsage?.gallons?.toFixed(0) || 0} gal / $${todayUsage?.cost?.toFixed(2) || '0.00'}
This month: ${finance?.monthly_gallons?.toFixed(0) || 0} gal / $${finance?.monthly_cost?.toFixed(2) || '0.00'}
Billing cycle cumulative: ${finance?.cumulative_gallons?.toFixed(0) || 0} gal

WEATHER SOURCE DISCREPANCIES (last 48h):
${discrepancies.length > 0 ? discrepancies.slice(0, 5).map(d => `${d.field}: Ambient=${d.ambient_value}, OpenMeteo=${d.openmeteo_value}, Used=${d.used_value}`).join('\n') : 'No discrepancies'}

PRECIPITATION AUDITS (last 14 days):
${precipAudits.length > 0 ? precipAudits.slice(0, 7).map(a => `${a.date_str}: Ambient=${a.ambient_inches}", OpenMeteo=${a.openmeteo_inches}", Used=${a.used_inches}"`).join('\n') : 'No precipitation audits'}

FLOW CALIBRATION:
${flowSuggestions.length > 0 ? flowSuggestions.map(f => `Zone ${f.zone_number}: avg deviation ${f.avg_deviation}% over ${f.run_count} runs`).join('\n') : 'No flow calibration data'}

ADVISOR INSIGHTS:
${advisorInsights.length > 0 ? advisorInsights.map(i => `[${i.severity}] ${i.title}: ${i.summary}`).join('\n') : 'No active insights'}`;
}

export async function askYard(question) {
  const systemContext = buildSystemContext();

  const result = await callAdvisorModel([
    { role: 'system', content: systemContext },
    { role: 'user', content: question },
  ], { maxTokens: 2048, timeoutMs: 45000 });

  return result;
}
