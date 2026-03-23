// "Ask Your Yard" - natural language chat grounded in live system data.
// Pulls a compact context snapshot from SQLite and lets the thinking model
// reason through it before answering.

import { localDateStr } from '../time.js';
import {
  getStatus, getRunsSince, getFinanceData, getDailyUsage,
  getSoilMoisture, getCachedWeather, getRecentDiscrepancies,
  getWeatherHistory, getRecentReferenceET, getNDVIHistory,
} from '../db/state.js';
import { collectAdvisorInsights } from './advisor.js';
import { callAdvisorModel } from './advisor.js';

function buildHistorySummary() {
  const lines = [];

  // Last 30 days weather summary
  try {
    const weather = getWeatherHistory(30, 'openmeteo');
    if (weather.length > 0) {
      const temps = weather.filter(w => w.temp_max != null);
      const rain = weather.filter(w => w.precipitation != null);
      if (temps.length > 0) {
        const avgHigh = temps.reduce((s, w) => s + w.temp_max, 0) / temps.length;
        const avgLow = temps.reduce((s, w) => s + w.temp_min, 0) / temps.length;
        lines.push(`WEATHER 30D: avg high ${avgHigh.toFixed(0)}F, avg low ${avgLow.toFixed(0)}F`);
      }
      if (rain.length > 0) {
        const totalRain = rain.reduce((s, w) => s + (w.precipitation || 0), 0);
        const rainyDays = rain.filter(w => w.precipitation > 0.01).length;
        lines.push(`RAIN 30D: ${totalRain.toFixed(2)}" total, ${rainyDays} rainy days`);
      }
    }
  } catch { /* DB may not have history yet */ }

  // Reference ET comparison
  try {
    const etData = getRecentReferenceET(7);
    if (etData.length > 0) {
      const avgETo = etData.reduce((s, e) => s + (e.reference_eto || 0), 0) / etData.length;
      lines.push(`REF ET 7D: avg ${avgETo.toFixed(3)}" grass ETo/day (CoAgMet)`);
    }
  } catch { /* empty */ }

  // NDVI latest
  try {
    const ndvi = getNDVIHistory(90);
    if (ndvi.length > 0) {
      const latest = ndvi[0];
      lines.push(`NDVI: ${latest.ndvi_mean?.toFixed(2) || '?'} (${latest.period_from?.slice(0, 10) || '?'})`);
    }
  } catch { /* empty */ }

  return lines.length > 0 ? lines.join('\n') : '';
}

function buildCompactContext() {
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

  // Compact weather - just the key fields, not the entire raw JSON
  let weatherLine = 'Weather station data not available';
  const ambientCache = getCachedWeather('ambient');
  if (ambientCache) {
    try {
      const w = JSON.parse(ambientCache.data_json);
      weatherLine = `${w.temp}F, ${w.humidity}% RH, wind ${w.windSpeed} mph, rain24h ${w.dailyrainin || 0}" (as of ${ambientCache.fetched_at})`;
    } catch { /* empty */ }
  }

  // Compact forecast - just high/low/rain for next 3 days
  let forecastLine = 'Forecast not available';
  const forecastCache = getCachedWeather('openmeteo_forecast');
  if (forecastCache) {
    try {
      const days = JSON.parse(forecastCache.data_json).slice(0, 3);
      forecastLine = days.map(d => `${d.date?.slice(5)}: ${d.tmax?.toFixed(0)}/${d.tmin?.toFixed(0)}F, ${d.precipitation?.toFixed(2)}" rain`).join(' | ');
    } catch { /* empty */ }
  }

  // Compact moisture - one line per zone
  const moistureLines = moisture.length > 0
    ? moisture.map(z => {
        const pct = z.total_capacity > 0 ? Math.round((z.balance_inches / z.total_capacity) * 100) : 0;
        return `Z${z.zone_number} ${z.zone_name}: ${pct}%`;
      }).join(', ')
    : 'No data';

  // Recent skip reasons - deduplicated
  const skipReasons = [...new Set(skipRuns.map(r => r.reason))].slice(0, 3).join('; ');

  // Discrepancies - just the count
  const discrepancies = getRecentDiscrepancies(48);

  // Advisor insights - compact
  const insights = collectAdvisorInsights();
  const insightLines = insights.length > 0
    ? insights.map(i => `[${i.severity}] ${i.title}`).join('; ')
    : 'None';

  const lastRun = status.lastRun;

  return `You are the AI assistant for the Smart Water System. Answer questions about the yard using ONLY this data. Be concise (2-5 sentences). Use specific numbers.

DATE: ${todayStr}
WEATHER: ${weatherLine}
FORECAST: ${forecastLine}
MOISTURE: ${moistureLines}
LAST DECISION: ${lastRun ? `${lastRun.decision} - ${lastRun.reason} (${lastRun.timestamp?.slice(0, 16)})${lastRun.shadow ? ' [shadow]' : ''}` : 'None'}
7-DAY ACTIVITY: ${decisions.length} decisions, ${waterRuns.length} watered, ${skipRuns.length} skipped${skipReasons ? ` (${skipReasons})` : ''}
USAGE: Today ${todayUsage?.gallons?.toFixed(0) || 0} gal/$${todayUsage?.cost?.toFixed(2) || '0.00'} | Month ${finance?.monthly_gallons?.toFixed(0) || 0} gal/$${finance?.monthly_cost?.toFixed(2) || '0.00'} | Cycle ${finance?.cumulative_gallons?.toFixed(0) || 0} gal
DISCREPANCIES: ${discrepancies.length} in last 48h
INSIGHTS: ${insightLines}
${buildHistorySummary()}
DATA SOURCES: Ambient Weather (live), OpenMeteo (forecast/archive + 2yr history), USDA soil survey, CoAgMet reference ET, Sentinel-2 NDVI satellite`;
}

export async function askYard(question) {
  const context = buildCompactContext();

  const result = await callAdvisorModel([
    { role: 'system', content: context },
    { role: 'user', content: question },
  ], { model: 'kimi-k2-thinking-turbo', maxTokens: 1024, timeoutMs: 60000 });

  return result;
}
