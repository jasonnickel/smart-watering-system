// Weekly intelligence briefing
// Comprehensive trend analysis with multi-period windows and year-over-year comparison.
// Runs as a Sunday morning systemd timer alongside the daily summary.

import { getDB, getRecentETValidation, getNDVIHistory } from '../db/state.js';
import { localDateStr } from '../time.js';
import { collectAdvisorInsights } from './advisor.js';
import { callAdvisorModel, aiNarrationEnabled } from './advisor.js';
import { getETCorrection } from '../core/tuning.js';

// -- Data collectors ---------------------------------------------------------

function queryUsageByPeriod(startDate, endDate) {
  const db = getDB();
  const row = db.prepare(`
    SELECT COALESCE(SUM(gallons), 0) AS gallons,
           COALESCE(SUM(cost), 0) AS cost,
           COUNT(*) AS days_with_usage
    FROM daily_usage
    WHERE date >= ? AND date <= ?
  `).get(startDate, endDate);
  return row;
}

function queryDecisionsByPeriod(sinceISO) {
  const db = getDB();
  const rows = db.prepare(`
    SELECT decision, COUNT(*) AS count
    FROM runs
    WHERE phase = 'DECIDE' AND success = 1 AND timestamp >= ?
    GROUP BY decision
  `).all(sinceISO);

  const result = { water: 0, skip: 0 };
  for (const r of rows) {
    if (r.decision === 'WATER') result.water = r.count;
    if (r.decision === 'SKIP') result.skip = r.count;
  }
  result.total = result.water + result.skip;
  return result;
}

function querySkipReasons(sinceISO) {
  const db = getDB();
  return db.prepare(`
    SELECT reason, COUNT(*) AS count
    FROM runs
    WHERE phase = 'DECIDE' AND decision = 'SKIP' AND success = 1 AND timestamp >= ?
    GROUP BY reason
    ORDER BY count DESC
    LIMIT 5
  `).all(sinceISO);
}

function queryPrecipTotals(startDate, endDate) {
  const db = getDB();
  const row = db.prepare(`
    SELECT COALESCE(SUM(used_inches), 0) AS total_rain,
           COUNT(*) AS rainy_days
    FROM precipitation_audit
    WHERE date >= ? AND date <= ? AND used_inches > 0.01
  `).get(startDate, endDate);
  return row;
}

function dateNDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

function dateLastYear(dateStr) {
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function seasonStartDate() {
  const now = new Date();
  const year = now.getFullYear();
  // Irrigation season roughly April 1 through October 31
  const seasonStart = new Date(year, 3, 1);
  if (now < seasonStart) {
    // If before April, use last year's season start
    return new Date(year - 1, 3, 1).toISOString().slice(0, 10);
  }
  return seasonStart.toISOString().slice(0, 10);
}

// -- Period analysis ---------------------------------------------------------

function analyzePeriod(label, startDate, endDate, sinceISO) {
  const usage = queryUsageByPeriod(startDate, endDate);
  const decisions = queryDecisionsByPeriod(sinceISO);
  const skipReasons = querySkipReasons(sinceISO);
  const precip = queryPrecipTotals(startDate, endDate);

  return {
    label,
    startDate,
    endDate,
    gallons: usage.gallons,
    cost: usage.cost,
    daysWithUsage: usage.days_with_usage,
    waterDecisions: decisions.water,
    skipDecisions: decisions.skip,
    totalDecisions: decisions.total,
    skipRate: decisions.total > 0 ? Math.round((decisions.skip / decisions.total) * 100) : 0,
    topSkipReasons: skipReasons,
    totalRainInches: precip.total_rain,
    rainyDays: precip.rainy_days,
  };
}

// -- Main briefing builder ---------------------------------------------------

export function buildBriefingContext() {
  const today = localDateStr();

  // Multi-period analysis
  const periods = {
    week: analyzePeriod('Last 7 days', dateNDaysAgo(7), today, new Date(Date.now() - 7 * 86400000).toISOString()),
    twoWeeks: analyzePeriod('Last 14 days', dateNDaysAgo(14), today, new Date(Date.now() - 14 * 86400000).toISOString()),
    month: analyzePeriod('Last 30 days', dateNDaysAgo(30), today, new Date(Date.now() - 30 * 86400000).toISOString()),
    quarter: analyzePeriod('Last 90 days', dateNDaysAgo(90), today, new Date(Date.now() - 90 * 86400000).toISOString()),
    season: analyzePeriod('This season', seasonStartDate(), today, new Date(seasonStartDate()).toISOString()),
  };

  // Year-over-year comparison (same 30-day window last year)
  const yoyStart = dateLastYear(dateNDaysAgo(30));
  const yoyEnd = dateLastYear(today);
  const yoySinceISO = new Date(yoyStart).toISOString();
  const lastYear = analyzePeriod('Same period last year', yoyStart, yoyEnd, yoySinceISO);

  const yoyComparison = {
    gallonsDelta: periods.month.gallons - lastYear.gallons,
    costDelta: periods.month.cost - lastYear.cost,
    skipRateDelta: periods.month.skipRate - lastYear.skipRate,
    lastYear,
  };

  // Trend: is usage increasing or decreasing week over week?
  const prevWeekStart = dateNDaysAgo(14);
  const prevWeekEnd = dateNDaysAgo(7);
  const prevWeekUsage = queryUsageByPeriod(prevWeekStart, prevWeekEnd);
  const weekTrend = {
    thisWeekGallons: periods.week.gallons,
    lastWeekGallons: prevWeekUsage.gallons,
    direction: periods.week.gallons > prevWeekUsage.gallons * 1.1 ? 'increasing'
      : periods.week.gallons < prevWeekUsage.gallons * 0.9 ? 'decreasing'
      : 'stable',
  };

  // ET correction factors
  const db = getDB();
  const moistureRows = db.prepare('SELECT zone_id, zone_number, zone_name, balance_inches, total_capacity FROM soil_moisture').all();
  const etCorrections = moistureRows.map(z => ({
    zoneNumber: z.zone_number,
    zoneName: z.zone_name,
    moisturePct: z.total_capacity > 0 ? Math.round((z.balance_inches / z.total_capacity) * 100) : 0,
    etCorrection: getETCorrection(z.zone_id),
  }));

  // Active advisor insights (now includes ET drift, soil mismatch, NDVI trend)
  const insights = collectAdvisorInsights();

  // ET model accuracy over the last 30 days
  let etAccuracy = null;
  try {
    const etValidation = getRecentETValidation(30);
    if (etValidation.length > 0) {
      const avgDev = etValidation.reduce((s, r) => s + r.deviation_pct, 0) / etValidation.length;
      etAccuracy = {
        samples: etValidation.length,
        avgDeviationPct: Math.round(avgDev),
        assessment: Math.abs(avgDev) < 15 ? 'accurate' : avgDev > 0 ? 'running high' : 'running low',
      };
    }
  } catch { /* empty */ }

  // NDVI vegetation trend
  let ndviTrend = null;
  try {
    const ndvi = getNDVIHistory(90);
    if (ndvi.length >= 2) {
      ndviTrend = {
        latest: ndvi[0].ndvi_mean,
        previous: ndvi[1].ndvi_mean,
        changePct: ndvi[1].ndvi_mean > 0 ? Math.round(((ndvi[0].ndvi_mean - ndvi[1].ndvi_mean) / ndvi[1].ndvi_mean) * 100) : 0,
        latestDate: ndvi[0].period_from,
      };
    }
  } catch { /* empty */ }

  return {
    today,
    periods,
    yoyComparison,
    weekTrend,
    etCorrections,
    etAccuracy,
    ndviTrend,
    insights,
  };
}

export async function generateBriefingNarrative(context) {
  if (!aiNarrationEnabled()) {
    return null;
  }

  const result = await callAdvisorModel([
    {
      role: 'system',
      content: `You are an irrigation intelligence analyst writing a weekly briefing for a homeowner. Think carefully through the data, identify the most important trends and anomalies, then write a structured briefing with these sections:

HEADLINE: One sentence capturing the most important finding this week.
THIS WEEK: 2-3 sentences on what happened in the last 7 days.
TRENDS: 2-3 sentences on 30-day and seasonal patterns - is usage going up or down, and why?
YEAR OVER YEAR: 1-2 sentences comparing to the same period last year (if data exists).
RECOMMENDATIONS: 1-3 specific, actionable suggestions based on the data.

Use specific numbers. Be direct. No fluff.`,
    },
    {
      role: 'user',
      content: `Generate a weekly intelligence briefing from this irrigation data:\n${JSON.stringify(context)}`,
    },
  ], { maxTokens: 2048, timeoutMs: 45000 });

  return result;
}

export function buildBriefingHTML(context, narrative) {
  const p = context.periods;
  const yoy = context.yoyComparison;
  const trend = context.weekTrend;

  const periodRows = [p.week, p.month, p.quarter, p.season].map(period => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${period.label}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${period.gallons.toFixed(0)} gal</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">$${period.cost.toFixed(2)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${period.waterDecisions}W / ${period.skipDecisions}S</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${period.skipRate}%</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${period.totalRainInches.toFixed(2)}"</td>
    </tr>
  `).join('');

  const trendArrow = trend.direction === 'increasing' ? '&#9650;'
    : trend.direction === 'decreasing' ? '&#9660;' : '&#9644;';
  const trendColor = trend.direction === 'increasing' ? '#e65100'
    : trend.direction === 'decreasing' ? '#2e7d32' : '#666';

  const yoySection = yoy.lastYear.totalDecisions > 0 ? `
    <h3 style="background:#e3f2fd;padding:8px;border-radius:4px;margin-top:20px;">Year Over Year (same 30 days)</h3>
    <p>Last year: ${yoy.lastYear.gallons.toFixed(0)} gal / $${yoy.lastYear.cost.toFixed(2)} | Skip rate: ${yoy.lastYear.skipRate}%</p>
    <p>Delta: ${yoy.gallonsDelta > 0 ? '+' : ''}${yoy.gallonsDelta.toFixed(0)} gal / ${yoy.costDelta > 0 ? '+' : ''}$${yoy.costDelta.toFixed(2)} | Skip rate ${yoy.skipRateDelta > 0 ? '+' : ''}${yoy.skipRateDelta}%</p>
  ` : '';

  const correctionRows = context.etCorrections
    .filter(z => z.etCorrection !== 1.0)
    .map(z => `<li>Zone ${z.zoneNumber} (${z.zoneName}): ET correction ${z.etCorrection.toFixed(2)}x, moisture ${z.moisturePct}%</li>`)
    .join('');

  const narrativeSection = narrative?.content ? `
    <div style="background:#f3e5f5;padding:14px;border-radius:8px;margin-top:20px;line-height:1.6;">
      ${narrative.content.replace(/\n/g, '<br>')}
    </div>
  ` : '';

  return `<div style="font-family:-apple-system,Segoe UI,Helvetica Neue,Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
    <h2 style="color:#1565c0;">Weekly Intelligence Briefing - ${context.today}</h2>

    ${narrativeSection}

    <h3 style="background:#e8f5e9;padding:8px;border-radius:4px;margin-top:20px;">Usage Trend <span style="color:${trendColor}">${trendArrow} ${trend.direction}</span></h3>
    <p>This week: ${trend.thisWeekGallons.toFixed(0)} gal | Last week: ${trend.lastWeekGallons.toFixed(0)} gal</p>

    <h3 style="background:#fff8e1;padding:8px;border-radius:4px;margin-top:20px;">Period Comparison</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f5f5f5;">
          <th style="padding:6px 10px;text-align:left;">Period</th>
          <th style="padding:6px 10px;text-align:left;">Gallons</th>
          <th style="padding:6px 10px;text-align:left;">Cost</th>
          <th style="padding:6px 10px;text-align:left;">Decisions</th>
          <th style="padding:6px 10px;text-align:left;">Skip %</th>
          <th style="padding:6px 10px;text-align:left;">Rain</th>
        </tr>
      </thead>
      <tbody>${periodRows}</tbody>
    </table>

    ${yoySection}

    ${correctionRows ? `<h3 style="background:#fff3e0;padding:8px;border-radius:4px;margin-top:20px;">Active ET Corrections</h3><ul>${correctionRows}</ul>` : ''}

    <p style="margin-top:30px;font-size:11px;color:#999;">Smart Water System - Weekly Intelligence Briefing</p>
  </div>`;
}
