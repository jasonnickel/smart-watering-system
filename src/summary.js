#!/usr/bin/env node

// Daily Summary Email
// Generates and sends a morning status report.
// Run at 6am via systemd timer.

import './env.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

import CONFIG from './config.js';
import { log } from './log.js';
import { formatTimestamp, localDateStr, localYesterdayStr, localMonth, minutesSinceTimestamp } from './time.js';
import {
  initDB, getStatus, getRunsSince, getFinanceData,
  getDailyUsage, getRecentDiscrepancies, getRecentPrecipitationAudits,
  getCachedWeather,
} from './db/state.js';
import { sendSummaryEmail } from './notify.js';

const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');

async function main() {
  initDB(DB_PATH);

  const now = new Date();
  const todayStr = localDateStr(now);
  const yesterdayStr = localYesterdayStr(now);
  const month = localMonth(now);

  // Skip in dormant months
  const seasonalFactor = CONFIG.watering.seasonalAdjustment[month] ?? 0;
  if (seasonalFactor === 0) {
    log(2, 'Dormant season, no summary needed');
    return;
  }

  const status = getStatus(todayStr);
  const since = formatTimestamp(new Date(Date.now() - 86400000));
  const recentRuns = getRunsSince(since);
  const finance = getFinanceData();
  const yesterdayUsage = getDailyUsage(yesterdayStr);
  const discrepancies = getRecentDiscrepancies(24);
  const precipAudits = getRecentPrecipitationAudits(7);

  // Weather source status
  const ambientCache = getCachedWeather('ambient');
  let weatherStatus = 'Unknown';
  if (ambientCache) {
    const ageMin = minutesSinceTimestamp(ambientCache.fetched_at);
    weatherStatus = Number.isFinite(ageMin) && ageMin < CONFIG.degradedMode.ambientStaleThresholdMinutes
      ? `Ambient Weather (${Math.round(ageMin)} min ago)`
      : Number.isFinite(ageMin)
        ? `STALE (${Math.round(ageMin)} min since last update)`
        : 'STALE (last update unreadable)';
  }

  // Overnight decisions
  const overnightRuns = recentRuns.filter(r => r.phase === 'DECIDE');
  const waterRuns = overnightRuns.filter(r => r.decision === 'WATER');
  const skipRuns = overnightRuns.filter(r => r.decision === 'SKIP');

  // Forecast
  const forecastCache = getCachedWeather('openmeteo_forecast');
  let forecastText = 'Forecast data unavailable';
  let coolingLikely = false;
  if (forecastCache) {
    const forecast = JSON.parse(forecastCache.data_json);
    if (forecast?.[0]) {
      const today = forecast[0];
      forecastText = `High ${today.tmax?.toFixed(0) ?? '?'}F, Low ${today.tmin?.toFixed(0) ?? '?'}F`;
      if (today.precipitation > 0) {
        forecastText += `, ${today.precipitation.toFixed(2)}" rain expected`;
      }
      coolingLikely = (today.tmax ?? 0) > CONFIG.emergency.triggers.base;
      if (coolingLikely) {
        forecastText += ' - Emergency cooling likely';
      }
    }
  }

  // Build HTML
  const html = buildEmailHTML({
    todayStr,
    weatherStatus,
    overnightRuns,
    waterRuns,
    skipRuns,
    moisture: status.moisture,
    forecastText,
    coolingLikely,
    yesterdayUsage,
    finance,
    discrepancies,
    precipAudits,
  });

  const subject = `Smart Water Daily Report - ${todayStr}`;
  await sendSummaryEmail(subject, html);
  log(1, 'Daily summary sent');
}

function buildEmailHTML(d) {
  const moistureRows = d.moisture.map(z => {
    const pct = z.total_capacity > 0
      ? Math.round((z.balance_inches / z.total_capacity) * 100)
      : 0;
    const color = pct < 40 ? '#e53935' : pct < 60 ? '#f5a623' : '#4caf50';
    return `<tr>
      <td style="padding:4px 8px;">Zone ${z.zone_number} (${z.zone_name})</td>
      <td style="padding:4px 8px;">
        <div style="background:#eee;border-radius:4px;width:120px;height:16px;display:inline-block;">
          <div style="background:${color};border-radius:4px;height:16px;width:${Math.min(pct, 100)}%;"></div>
        </div>
        ${pct}%
      </td>
    </tr>`;
  }).join('');

  const overnightText = d.waterRuns.length > 0
    ? `Watered ${d.waterRuns.length} time(s): ${d.waterRuns.map(r => r.reason).join(', ')}`
    : d.skipRuns.length > 0
      ? `Skipped: ${d.skipRuns[0].reason}`
      : 'No activity recorded';

  const discrepancySection = d.discrepancies.length > 0
    ? `<h3 style="background:#fff3e0;padding:8px;border-radius:4px;margin-top:20px;">Weather Discrepancies (last 24h)</h3>
       <ul>${d.discrepancies.map(disc => `<li>${disc.reason}</li>`).join('')}</ul>`
    : '';

  // Weekly precipitation bias check
  let precipBiasSection = '';
  if (d.precipAudits.length >= 3) {
    const biased = d.precipAudits.filter(a => a.discrepancy_pct > 20);
    if (biased.length >= 3) {
      precipBiasSection = `<p style="color:#e65100;font-weight:bold;">
        Rain gauge discrepancy detected on ${biased.length} of the last ${d.precipAudits.length} days.
        Consider checking your weather station rain gauge for debris or calibration issues.</p>`;
    }
  }

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;max-width:600px;">
    <h2 style="color:#1565c0;border-bottom:2px solid #1565c0;padding-bottom:5px;">Smart Water Daily Report</h2>
    <p>${d.todayStr}</p>

    <h3 style="background:#e8f5e9;padding:8px;border-radius:4px;">Overnight Activity</h3>
    <p>${overnightText}</p>
    ${d.yesterdayUsage.gallons > 0 ? `<p>Yesterday: ${d.yesterdayUsage.gallons.toFixed(0)} gallons, $${d.yesterdayUsage.cost.toFixed(2)}</p>` : ''}

    <h3 style="background:#e3f2fd;padding:8px;border-radius:4px;margin-top:20px;">Today's Forecast</h3>
    <p>${d.forecastText}</p>

    <h3 style="background:#f3e5f5;padding:8px;border-radius:4px;margin-top:20px;">Soil Moisture</h3>
    <table style="border-collapse:collapse;width:100%;">
      ${moistureRows}
    </table>

    <h3 style="background:#fff8e1;padding:8px;border-radius:4px;margin-top:20px;">Monthly Summary</h3>
    <p>Gallons: ${d.finance?.monthly_gallons?.toFixed(0) ?? 0} | Cost: $${d.finance?.monthly_cost?.toFixed(2) ?? '0.00'} | Cumulative: ${d.finance?.cumulative_gallons?.toFixed(0) ?? 0} gal</p>

    <h3 style="background:#efebe9;padding:8px;border-radius:4px;margin-top:20px;">Weather Data Source</h3>
    <p>${d.weatherStatus}</p>

    ${discrepancySection}
    ${precipBiasSection}

    <p style="margin-top:30px;font-size:11px;color:#999;">Smart Water System - automated daily report</p>
  </div>`;
}

main().catch(err => {
  log(0, `Summary fatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
