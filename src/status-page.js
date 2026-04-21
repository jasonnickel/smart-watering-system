// [2.3] Static HTML status page generator
// Regenerated after each run. Served by n8n or any file server.

import './env.js';
import { writeFileSync } from 'node:fs';
import { log } from './log.js';
import { formatTimestamp, localDateStr, minutesSinceTimestamp } from './time.js';
import { collectAdvisorInsights, formatAdvisorInsight } from './ai/advisor.js';
import {
  getStatus, getRunsSince, getCachedWeather,
  getRecentDiscrepancies, getFinanceData,
} from './db/state.js';
import CONFIG from './config.js';
import { TAPROOT_STATUS_PAGE_PATH } from './paths.js';

const OUTPUT_PATH = process.env.STATUS_PAGE_PATH
  || TAPROOT_STATUS_PAGE_PATH;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Generate and write the status page HTML.
 */
export function generateStatusPage() {
  try {
    const todayStr = localDateStr();
    const status = getStatus(todayStr);
    const since = formatTimestamp(new Date(Date.now() - 86400000));
    const recentRuns = getRunsSince(since).filter(r => r.phase === 'DECIDE').slice(0, 5);
    const discrepancies = getRecentDiscrepancies(24);
    const finance = getFinanceData();
    const advisorInsights = collectAdvisorInsights({ maxInsights: 3 });

    // Weather source
    const ambientCache = getCachedWeather('ambient');
    let weatherSource = 'Unknown';
    let weatherColor = '#999';
    if (ambientCache) {
      const ageMin = minutesSinceTimestamp(ambientCache.fetched_at);
      if (Number.isFinite(ageMin) && ageMin < CONFIG.degradedMode.ambientStaleThresholdMinutes) {
        weatherSource = `Ambient Weather (${Math.round(ageMin)}m ago)`;
        weatherColor = '#4caf50';
      } else {
        weatherSource = Number.isFinite(ageMin)
          ? `STALE (${Math.round(ageMin)}m ago)`
          : 'STALE (last update unreadable)';
        weatherColor = '#e53935';
      }
    }

    // Forecast
    const forecastCache = getCachedWeather('openmeteo_forecast');
    let forecastHtml = '<p>No forecast data</p>';
    if (forecastCache) {
      const forecast = JSON.parse(forecastCache.data_json);
      if (forecast?.length > 0) {
        forecastHtml = forecast.map(d =>
          `<div class="card" style="flex:1;min-width:120px;">
            <div style="font-size:12px;color:#666;">${escapeHtml(d.date)}</div>
            <div style="font-size:18px;font-weight:bold;">${d.tmax?.toFixed(0) ?? '?'}F</div>
            <div style="font-size:12px;">Low ${d.tmin?.toFixed(0) ?? '?'}F</div>
            ${d.precipitation > 0 ? `<div style="color:#1565c0;">${d.precipitation.toFixed(2)}" rain</div>` : ''}
          </div>`
        ).join('');
        forecastHtml = `<div style="display:flex;gap:8px;flex-wrap:wrap;">${forecastHtml}</div>`;
      }
    }

    // Moisture bars
    const moistureHtml = status.moisture.map(z => {
      const pct = z.total_capacity > 0
        ? Math.round((z.balance_inches / z.total_capacity) * 100)
        : 0;
      const color = pct < 40 ? '#e53935' : pct < 60 ? '#f5a623' : '#4caf50';
      return `<div style="margin:6px 0;">
        <div style="display:flex;justify-content:space-between;font-size:13px;">
          <span>Zone ${z.zone_number} (${escapeHtml(z.zone_name)})</span>
          <span>${pct}%</span>
        </div>
        <div style="background:#e0e0e0;border-radius:4px;height:12px;">
          <div style="background:${color};border-radius:4px;height:12px;width:${Math.min(pct, 100)}%;"></div>
        </div>
      </div>`;
    }).join('');

    // Recent decisions
    const decisionsHtml = recentRuns.length > 0
      ? recentRuns.map(r => {
          const icon = r.decision === 'WATER' ? '&#128167;' : '&#9940;';
          return `<div style="padding:4px 0;border-bottom:1px solid #eee;font-size:13px;">
            ${icon} <strong>${escapeHtml(r.decision)}</strong> - ${escapeHtml(r.reason)}
            <span style="color:#999;float:right;">${r.timestamp.slice(11, 16)}</span>
          </div>`;
        }).join('')
      : '<p style="color:#999;">No recent activity</p>';

    const advisorHtml = advisorInsights.length > 0
      ? `<div class="card">
        <h2>Advisor Insights</h2>
        ${advisorInsights.map(insight => `<div style="padding:6px 0;border-bottom:1px solid #eee;font-size:13px;">
          ${escapeHtml(formatAdvisorInsight(insight))}
        </div>`).join('')}
      </div>`
      : '';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Taproot Status</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 16px; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { font-size: 20px; color: #1565c0; margin-bottom: 4px; }
    .subtitle { font-size: 12px; color: #999; margin-bottom: 16px; }
    .card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { font-size: 14px; text-transform: uppercase; color: #666; margin-bottom: 10px; letter-spacing: 0.5px; }
    .stat { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Taproot</h1>
    <div class="subtitle">Updated ${new Date().toLocaleString('en-US', { timeZone: CONFIG.location.timezone })}</div>

    <div class="card">
      <h2>Weather Source</h2>
      <div style="color:${weatherColor};font-weight:bold;">${escapeHtml(weatherSource)}</div>
      ${discrepancies.length > 0 ? `<div style="color:#e65100;font-size:12px;margin-top:4px;">&#9888; ${discrepancies.length} discrepancy warning(s) in last 24h</div>` : ''}
    </div>

    ${advisorHtml}

    <div class="card">
      <h2>Soil Moisture</h2>
      ${moistureHtml}
    </div>

    <div class="card">
      <h2>Forecast</h2>
      ${forecastHtml}
    </div>

    <div class="card">
      <h2>Recent Decisions</h2>
      ${decisionsHtml}
    </div>

    <div class="card">
      <h2>Today</h2>
      <div class="stat"><span>Gallons</span><span>${status.todayUsage.gallons.toFixed(0)}</span></div>
      <div class="stat"><span>Cost</span><span>$${status.todayUsage.cost.toFixed(2)}</span></div>
    </div>

    <div class="card">
      <h2>This Month</h2>
      <div class="stat"><span>Gallons</span><span>${finance?.monthly_gallons?.toFixed(0) ?? 0}</span></div>
      <div class="stat"><span>Cost</span><span>$${finance?.monthly_cost?.toFixed(2) ?? '0.00'}</span></div>
      <div class="stat"><span>Billing Cycle</span><span>${finance?.cumulative_gallons?.toFixed(0) ?? 0} gal</span></div>
    </div>
  </div>
</body>
</html>`;

    writeFileSync(OUTPUT_PATH, html);
    log(2, `Status page written to ${OUTPUT_PATH}`);
  } catch (err) {
    log(0, `Status page generation failed: ${err.message}`);
  }
}
