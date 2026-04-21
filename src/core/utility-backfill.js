// Utility meter backfill - pulls historical readings from AquaHawk into utility_usage.
//
// Intervals:
//   - Monthly (25 readings for 2 years) - one request
//   - Daily (~730 readings) - one request
//   - Hourly (~17,500 readings) - chunked, respects portal rate limits

import CONFIG from '../config.js';
import { log } from '../log.js';
import { aquaHawkFromConfig, flattenTimesery } from '../api/aquahawk.js';
import { bulkUpsertUtilityUsage } from '../db/state.js';

const DEFAULT_LOOKBACK_DAYS = 730;

function lookbackRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  return { start, end };
}

/**
 * Backfill one interval in a single request.
 *
 * @returns {Promise<number>} rows written
 */
async function backfillSimple(client, interval, days) {
  const { start, end } = lookbackRange(days);
  const payload = await client.getUsage({ start, end, interval });
  const rows = (payload.timeseries || []).map(flattenTimesery);
  const written = bulkUpsertUtilityUsage(rows, 'aquahawk', client.accountNumber);
  log(1, `AquaHawk backfill [${interval}]: ${written} rows (${start.toISOString().slice(0, 10)} -> ${end.toISOString().slice(0, 10)})`);
  return written;
}

/**
 * Backfill hourly data in weekly chunks.
 */
async function backfillHourly(client, days) {
  const { start, end } = lookbackRange(days);
  const all = await client.getHourlyUsageChunked({
    start,
    end,
    onProgress: ({ chunkIndex, totalChunks, rows, cumulative }) => {
      log(2, `AquaHawk hourly chunk ${chunkIndex}/${totalChunks}: +${rows} (${cumulative} total)`);
    },
  });
  const rows = all.map(flattenTimesery);
  const written = bulkUpsertUtilityUsage(rows, 'aquahawk', client.accountNumber);
  log(1, `AquaHawk backfill [1 hour]: ${written} rows across ${Math.ceil(days / 7)} weekly chunks`);
  return written;
}

/**
 * Backfill monthly + daily + hourly into the utility_usage table.
 *
 * @param {object} [opts]
 * @param {number} [opts.days=730]
 * @param {Array<'1 month'|'1 day'|'1 hour'>} [opts.intervals]
 */
export async function backfillUtilityUsage({
  days = DEFAULT_LOOKBACK_DAYS,
  intervals = ['1 month', '1 day', '1 hour'],
} = {}) {
  const client = aquaHawkFromConfig();
  if (!client) {
    throw new Error(
      'AquaHawk is not configured. Set AQUAHAWK_DISTRICT, AQUAHAWK_USERNAME, ' +
      'AQUAHAWK_PASSWORD, AQUAHAWK_ACCOUNT_NUMBER in ~/.taproot/.env.'
    );
  }

  log(1, `AquaHawk backfill starting: ${days} days, intervals=${intervals.join(', ')}`);
  await client.authenticate();

  const results = {};
  for (const interval of intervals) {
    try {
      if (interval === '1 hour') {
        results[interval] = await backfillHourly(client, days);
      } else {
        results[interval] = await backfillSimple(client, interval, days);
      }
    } catch (err) {
      log(1, `AquaHawk backfill [${interval}] failed: ${err.message}`);
      results[interval] = { error: err.message };
    }
  }
  return results;
}

/**
 * Identify usage anomalies where gallons on a single day exceed a multiple
 * of the trailing-30-day median. Returns rows suitable for advisor alerts.
 *
 * Flags the kind of event we found in the 2024-06-05 audit: a 15.6k gal day
 * against a ~700 gal median that neither Rachio nor the utility caught.
 */
export function findUsageAnomalies(rows, { ratio = 10, minGallons = 5000 } = {}) {
  const daily = rows.filter(r => r.interval === '1 day' && r.gallons != null);
  if (daily.length < 31) return [];

  const sorted = daily.slice().sort((a, b) => a.start_time.localeCompare(b.start_time));
  const anomalies = [];
  for (let i = 30; i < sorted.length; i++) {
    const window = sorted.slice(i - 30, i).map(r => r.gallons).sort((a, b) => a - b);
    const median = window[15] || 0;
    const row = sorted[i];
    if (row.gallons >= minGallons && row.gallons >= median * ratio) {
      anomalies.push({
        date: row.start_time.slice(0, 10),
        gallons: row.gallons,
        trailing_median: median,
        ratio: median > 0 ? row.gallons / median : null,
      });
    }
  }
  return anomalies;
}

// Re-export for convenience
export { CONFIG };
