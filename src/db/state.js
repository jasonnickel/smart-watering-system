// SQLite state management
// All persistent state reads/writes go through this module.

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { log } from '../log.js';
import { formatTimestamp, localDateStr, parseStoredTimestamp } from '../time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');
const RUN_LOCK_KEY = 'run_lock';
const RUN_LOCK_STALE_SECONDS = 600;

let db = null;
let activeRunLockValue = null;

/**
 * Initialize the database connection and apply schema.
 *
 * @param {string} dbPath - Path to SQLite database file
 * @returns {Database} The database instance
 */
export function initDB(dbPath) {
  if (db) {
    db.close();
    db = null;
    activeRunLockValue = null;
  }

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);

  // Ensure finance singleton exists
  db.prepare(`
    INSERT OR IGNORE INTO finance (id, cumulative_gallons, monthly_gallons, monthly_cost)
    VALUES (1, 0, 0, 0)
  `).run();

  log(1, `Database initialized at ${dbPath}`);
  return db;
}

/**
 * Close the active database connection.
 */
export function closeDB() {
  if (!db) return;
  db.close();
  db = null;
  activeRunLockValue = null;
}

/**
 * Get the active database instance.
 */
export function getDB() {
  if (!db) throw new Error('Database not initialized - call initDB first');
  return db;
}

// --- Runs ---

export function logRun({ window, phase, decision, reason, zones, gallons, cost, success, shadow, error }) {
  const timestamp = formatTimestamp();
  return getDB().prepare(`
    INSERT INTO runs (timestamp, window, phase, decision, reason, zones_json, total_gallons, total_cost, success, shadow, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    timestamp,
    window, phase, decision, reason,
    zones ? JSON.stringify(zones) : null,
    gallons ?? 0, cost ?? 0,
    success ? 1 : 0, shadow ? 1 : 0,
    error ?? null
  );
}

export function getLastSuccessfulRun(window) {
  return getDB().prepare(`
    SELECT * FROM runs
    WHERE window = ? AND success = 1 AND phase = 'VERIFY'
    ORDER BY julianday(timestamp) DESC, id DESC LIMIT 1
  `).get(window);
}

export function getRunsSince(since) {
  const normalizedSince = formatTimestamp(since);
  return getDB().prepare(`
    SELECT * FROM runs
    WHERE julianday(timestamp) >= julianday(?)
    ORDER BY julianday(timestamp) DESC, id DESC
  `).all(normalizedSince);
}

// --- Soil Moisture ---

export function getSoilMoisture() {
  const rows = getDB().prepare('SELECT * FROM soil_moisture').all();
  const balances = {};
  for (const row of rows) {
    balances[row.zone_id] = row.balance_inches;
  }
  return balances;
}

export function getSoilMoistureRows() {
  return getDB().prepare('SELECT * FROM soil_moisture ORDER BY zone_number').all();
}

export function setSoilMoisture(zoneId, zoneNumber, zoneName, balanceInches, totalCapacity) {
  const timestamp = formatTimestamp();
  getDB().prepare(`
    INSERT INTO soil_moisture (zone_id, zone_number, zone_name, balance_inches, total_capacity, last_updated)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(zone_id) DO UPDATE SET
      balance_inches = excluded.balance_inches,
      total_capacity = excluded.total_capacity,
      last_updated = excluded.last_updated
  `).run(zoneId, zoneNumber, zoneName, balanceInches, totalCapacity, timestamp);
}

export function bulkSetSoilMoisture(balances, profiles) {
  const timestamp = formatTimestamp();
  const stmt = getDB().prepare(`
    INSERT INTO soil_moisture (zone_id, zone_number, zone_name, balance_inches, total_capacity, last_updated)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(zone_id) DO UPDATE SET
      balance_inches = excluded.balance_inches,
      total_capacity = excluded.total_capacity,
      last_updated = excluded.last_updated
  `);

  const tx = getDB().transaction(() => {
    for (const profile of profiles) {
      const balance = balances[profile.id];
      if (balance != null) {
        const capacity = profile.availableWaterCapacity * profile.rootDepthInches;
        stmt.run(profile.id, profile.zoneNumber, profile.name, balance, capacity, timestamp);
      }
    }
  });

  tx();
}

// --- Finance ---

export function getFinanceData() {
  return getDB().prepare('SELECT * FROM finance WHERE id = 1').get();
}

export function updateFinance(data) {
  getDB().prepare(`
    UPDATE finance SET
      cumulative_gallons = ?,
      monthly_gallons = ?,
      monthly_cost = ?,
      last_reset = ?
    WHERE id = 1
  `).run(data.cumulative_gallons, data.monthly_gallons, data.monthly_cost, data.last_reset);
}

// --- Daily Usage ---

export function getDailyUsage(dateStr) {
  return getDB().prepare('SELECT * FROM daily_usage WHERE date = ?').get(dateStr)
    || { date: dateStr, gallons: 0, cost: 0, zones_json: '{}' };
}

export function updateDailyUsage(dateStr, gallons, cost, zonesJson) {
  const existing = getDailyUsage(dateStr);
  let mergedZones = {};

  try {
    mergedZones = existing.zones_json ? JSON.parse(existing.zones_json) : {};
  } catch {
    mergedZones = {};
  }

  try {
    const incomingZones = zonesJson ? JSON.parse(zonesJson) : {};
    for (const [zoneId, minutes] of Object.entries(incomingZones)) {
      const parsedMinutes = Number(minutes);
      if (!Number.isFinite(parsedMinutes)) continue;
      mergedZones[zoneId] = (mergedZones[zoneId] || 0) + parsedMinutes;
    }
  } catch {
    // Ignore malformed per-zone detail rather than failing usage accounting.
  }

  getDB().prepare(`
    INSERT INTO daily_usage (date, gallons, cost, zones_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      gallons = gallons + excluded.gallons,
      cost = cost + excluded.cost,
      zones_json = excluded.zones_json
  `).run(dateStr, gallons, cost, JSON.stringify(mergedZones));
}

// --- Weather Cache ---

export function getCachedWeather(source) {
  return getDB().prepare('SELECT * FROM weather_cache WHERE source = ?').get(source);
}

export function setCachedWeather(source, data) {
  const fetchedAt = formatTimestamp();
  getDB().prepare(`
    INSERT INTO weather_cache (source, data_json, fetched_at)
    VALUES (?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      data_json = excluded.data_json,
      fetched_at = excluded.fetched_at
  `).run(source, JSON.stringify(data), fetchedAt);
}

// --- Fertilizer ---

export function getFertilizerLog() {
  const rows = getDB().prepare('SELECT * FROM fertilizer_log').all();
  const result = {};
  for (const row of rows) {
    result[row.zone_id] = row.applied_at;
  }
  return result;
}

export function logFertilizer(zoneId) {
  const appliedAt = formatTimestamp();
  getDB().prepare(`
    INSERT INTO fertilizer_log (zone_id, applied_at)
    VALUES (?, ?)
    ON CONFLICT(zone_id) DO UPDATE SET applied_at = excluded.applied_at
  `).run(zoneId, appliedAt);
}

// --- Cleanup ---

export function cleanupOldData(retentionDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = formatTimestamp(cutoff);

  const runsDeleted = getDB().prepare(
    'DELETE FROM runs WHERE julianday(timestamp) < julianday(?)'
  ).run(cutoffStr).changes;
  const usageDeleted = getDB().prepare('DELETE FROM daily_usage WHERE date < ?').run(cutoffStr.slice(0, 10)).changes;

  if (runsDeleted + usageDeleted > 0) {
    log(1, `Cleanup: removed ${runsDeleted} runs, ${usageDeleted} daily_usage records`);
  }
}

// --- Weather Discrepancy ---

export function logWeatherDiscrepancy(field, ambientValue, openmeteoValue, usedValue, reason) {
  const timestamp = formatTimestamp();
  getDB().prepare(`
    INSERT INTO weather_discrepancy (timestamp, field, ambient_value, openmeteo_value, used_value, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(timestamp, field, ambientValue, openmeteoValue, usedValue, reason);
}

export function getRecentDiscrepancies(hours = 24) {
  const since = formatTimestamp(new Date(Date.now() - hours * 3600000));
  return getDB().prepare(`
    SELECT * FROM weather_discrepancy
    WHERE julianday(timestamp) >= julianday(?)
    ORDER BY julianday(timestamp) DESC, id DESC
  `).all(since);
}

// --- Precipitation Audit ---

export function logPrecipitationAudit(dateStr, ambientInches, openmeteoInches, usedInches) {
  const discrepancyPct = ambientInches > 0 && openmeteoInches > 0
    ? Math.abs(ambientInches - openmeteoInches) / Math.max(ambientInches, openmeteoInches) * 100
    : 0;

  getDB().prepare(`
    INSERT INTO precipitation_audit (date, ambient_inches, openmeteo_inches, used_inches, discrepancy_pct)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      ambient_inches = excluded.ambient_inches,
      openmeteo_inches = excluded.openmeteo_inches,
      used_inches = excluded.used_inches,
      discrepancy_pct = excluded.discrepancy_pct
  `).run(dateStr, ambientInches, openmeteoInches, usedInches, discrepancyPct);
}

export function getRecentPrecipitationAudits(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return getDB().prepare('SELECT * FROM precipitation_audit WHERE date >= ? ORDER BY date DESC').all(since);
}

// --- Flow Audit ---

export function logFlowAudit(zoneId, zoneNumber, expectedGallons, actualGallons) {
  const deviationPct = expectedGallons > 0
    ? ((actualGallons - expectedGallons) / expectedGallons) * 100
    : 0;
  const timestamp = formatTimestamp();
  getDB().prepare(`
    INSERT INTO flow_audit (timestamp, zone_id, zone_number, expected_gallons, actual_gallons, deviation_pct)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(timestamp, zoneId, zoneNumber, expectedGallons, actualGallons, deviationPct);
}

export function getFlowAuditsForZone(zoneId, limit = 20) {
  return getDB().prepare(
    'SELECT * FROM flow_audit WHERE zone_id = ? ORDER BY julianday(timestamp) DESC, id DESC LIMIT ?'
  ).all(zoneId, limit);
}

export function getFlowCalibrationSuggestions() {
  // Find zones with consistent deviation over 5+ runs
  const zones = getDB().prepare(`
    SELECT zone_id, zone_number,
           AVG(deviation_pct) as avg_deviation,
           COUNT(*) as run_count
    FROM flow_audit
    GROUP BY zone_id
    HAVING COUNT(*) >= 5 AND ABS(AVG(deviation_pct)) > 15
  `).all();
  return zones;
}

// --- Zone Tuning ---

export function logTuningSuggestion(zoneId, parameter, originalValue, suggestedValue) {
  const timestamp = formatTimestamp();
  getDB().prepare(`
    INSERT INTO zone_tuning (timestamp, zone_id, parameter, original_value, suggested_value)
    VALUES (?, ?, ?, ?, ?)
  `).run(timestamp, zoneId, parameter, originalValue, suggestedValue);
}

export function getUnappliedTuning() {
  return getDB().prepare(
    'SELECT * FROM zone_tuning WHERE applied = 0 ORDER BY julianday(timestamp) DESC, id DESC'
  ).all();
}

export function markTuningApplied(id) {
  getDB().prepare('UPDATE zone_tuning SET applied = 1 WHERE id = ?').run(id);
}

// --- System State (key-value for date guards, cooling time, locks) ---

export function getSystemState(key) {
  const row = getDB().prepare('SELECT value FROM system_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSystemState(key, value) {
  getDB().prepare(`
    INSERT INTO system_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

/**
 * Acquire a run lock. Returns true if lock acquired, false if already held.
 */
export function acquireRunLock() {
  const acquiredAt = formatTimestamp();
  const lockValue = `${acquiredAt}|${process.pid}-${randomUUID()}`;
  const result = getDB().prepare(`
    INSERT INTO system_state (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE system_state.key = excluded.key
      AND (
        julianday(substr(system_state.value, 1, 24)) IS NULL
        OR (julianday(substr(excluded.value, 1, 24)) - julianday(substr(system_state.value, 1, 24))) * 86400.0 >= ?
      )
  `).run(RUN_LOCK_KEY, lockValue, RUN_LOCK_STALE_SECONDS);

  if (result.changes !== 1) {
    return false;
  }

  activeRunLockValue = lockValue;
  return true;
}

export function releaseRunLock() {
  if (!activeRunLockValue) return;
  getDB().prepare('DELETE FROM system_state WHERE key = ? AND value = ?').run(RUN_LOCK_KEY, activeRunLockValue);
  activeRunLockValue = null;
}

// --- Status ---

export function getStatus(dateStr) {
  const lastRun = getDB().prepare(
    'SELECT * FROM runs ORDER BY julianday(timestamp) DESC, id DESC LIMIT 1'
  ).get();
  const moisture = getDB().prepare('SELECT * FROM soil_moisture ORDER BY zone_number').all();
  const finance = getFinanceData();
  const todayUsage = getDailyUsage(dateStr || localDateStr());

  return { lastRun, moisture, finance, todayUsage };
}

/**
 * Get status as a JSON-serializable object for n8n webhook consumption.
 */
// -- Weather history ---------------------------------------------------------

export function saveWeatherDay(date, source, data) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO weather_history (date, source, temp_max, temp_min, temp_avg, humidity, precipitation, solar_radiation, wind_speed, wind_gust, et_reference) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(date, source, data.tempMax ?? null, data.tempMin ?? null, data.tempAvg ?? null, data.humidity ?? null, data.precipitation ?? null, data.solarRadiation ?? null, data.windSpeed ?? null, data.windGust ?? null, data.etReference ?? null);
}

export function getWeatherHistory(days = 365, source = null) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  if (source) {
    return db.prepare('SELECT * FROM weather_history WHERE date >= ? AND source = ? ORDER BY date DESC').all(since, source);
  }
  return db.prepare('SELECT * FROM weather_history WHERE date >= ? ORDER BY date DESC').all(since);
}

export function getWeatherHistoryRange(startDate, endDate, source = null) {
  const db = getDB();
  if (source) {
    return db.prepare('SELECT * FROM weather_history WHERE date >= ? AND date <= ? AND source = ? ORDER BY date ASC').all(startDate, endDate, source);
  }
  return db.prepare('SELECT * FROM weather_history WHERE date >= ? AND date <= ? ORDER BY date ASC').all(startDate, endDate);
}

// -- Soil survey cache -------------------------------------------------------

export function saveSoilSurvey(lat, lon, profile, horizons) {
  const db = getDB();
  db.prepare(`INSERT INTO soil_survey (lat, lon, soil_name, dominant_pct, total_awc_inches, awc_per_inch, profile_depth_inches, avg_ph, avg_organic_matter_pct, avg_infiltration_rate, horizons_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(lat, lon, profile.soilName, profile.dominantPct, profile.totalAwcInches, profile.awcPerInch, profile.profileDepthInches, profile.avgPH, profile.avgOrganicMatterPct, profile.avgInfiltrationRate, JSON.stringify(horizons));
}

export function getCachedSoilSurvey(lat, lon) {
  const db = getDB();
  // Match within ~100m (0.001 degrees)
  return db.prepare(`SELECT * FROM soil_survey WHERE abs(lat - ?) < 0.001 AND abs(lon - ?) < 0.001 ORDER BY fetched_at DESC LIMIT 1`).get(lat, lon) || null;
}

// -- Reference ET history ----------------------------------------------------

export function saveReferenceET(record, station) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO reference_et (date, station, reference_eto, reference_etr, temp_max, temp_min, solar_radiation, wind_speed, precipitation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.date, station, record.referenceETo, record.referenceETr, record.tempMax, record.tempMin, record.solarRadiation, record.windSpeed, record.precipitation);
}

export function getRecentReferenceET(days = 14) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`SELECT * FROM reference_et WHERE date >= ? ORDER BY date DESC`).all(since);
}

// -- NDVI history ------------------------------------------------------------

export function saveNDVIReading(lat, lon, reading) {
  const db = getDB();
  db.prepare(`
    INSERT INTO ndvi_history (lat, lon, period_from, period_to, ndvi_mean, ndvi_min, ndvi_max, sample_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(lat, lon, period_from, period_to) DO UPDATE SET
      ndvi_mean = excluded.ndvi_mean,
      ndvi_min = excluded.ndvi_min,
      ndvi_max = excluded.ndvi_max,
      sample_count = excluded.sample_count,
      fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(lat, lon, reading.from, reading.to, reading.mean, reading.min, reading.max, reading.samples);
}

export function getNDVIHistory(days = 180, lat = null, lon = null) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  if (lat != null && lon != null) {
    return db.prepare(`
      SELECT * FROM ndvi_history
      WHERE period_from >= ?
        AND abs(lat - ?) < 0.00001
        AND abs(lon - ?) < 0.00001
      ORDER BY period_from DESC
    `).all(since, lat, lon);
  }
  return db.prepare(`SELECT * FROM ndvi_history WHERE period_from >= ? ORDER BY period_from DESC`).all(since);
}

// -- ET cross-validation log -------------------------------------------------

export function logETValidation(date, station, calculatedET, referenceETo, deviationPct, assessment) {
  const db = getDB();
  db.prepare(`INSERT INTO et_validation (date, station, calculated_et, reference_eto, deviation_pct, assessment) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(date, station, calculatedET, referenceETo, deviationPct, assessment);
}

export function getRecentETValidation(days = 30) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`SELECT * FROM et_validation WHERE date >= ? ORDER BY date DESC`).all(since);
}

export function getStatusJSON(dateStr) {
  const status = getStatus(dateStr);
  return {
    lastRun: status.lastRun ? {
      timestamp: status.lastRun.timestamp,
      window: status.lastRun.window,
      decision: status.lastRun.decision,
      reason: status.lastRun.reason,
      gallons: status.lastRun.total_gallons,
      cost: status.lastRun.total_cost,
      success: status.lastRun.success === 1,
    } : null,
    moisture: status.moisture.map(z => ({
      zone: z.zone_number,
      name: z.zone_name,
      pct: z.total_capacity > 0 ? Math.round((z.balance_inches / z.total_capacity) * 100) : null,
      inches: z.balance_inches,
      capacity: z.total_capacity,
    })),
    todayUsage: { gallons: status.todayUsage.gallons, cost: status.todayUsage.cost },
    finance: status.finance ? {
      monthlyGallons: status.finance.monthly_gallons,
      monthlyCost: status.finance.monthly_cost,
      cumulativeGallons: status.finance.cumulative_gallons,
    } : null,
  };
}

// -- Utility usage history (for charts from AquaHawk ground truth) -----------

/**
 * Return daily actual water usage from utility_usage (AquaHawk meter readings).
 * Groups hourly rows into days when daily rows aren't present. Prefers daily
 * when available for accuracy.
 *
 * @param {number} days - rolling window size in days
 * @returns {Array<{date: string, gallons: number, rainfall_in: number|null}>}
 */
export function getUtilityUsageDaily(days = 30) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return db.prepare(`
    SELECT substr(start_time, 1, 10) AS date,
           SUM(gallons) AS gallons,
           MAX(rainfall_in) AS rainfall_in
    FROM utility_usage
    WHERE interval = '1 day' AND start_time >= ?
    GROUP BY date
    ORDER BY date ASC
  `).all(since);
}

/**
 * Return monthly utility bills within range, including tier breakdowns.
 */
export function getUtilityBillsHistory(days = 730) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT bill_date, period_start, period_end, days, usage_kgal, total,
           tier1_usage_kgal, tier1_rate, tier2_usage_kgal, tier2_rate,
           water_service, water_base_fee, wastewater, drainage
    FROM utility_bills
    WHERE period_end >= ?
    ORDER BY period_end ASC
  `).all(since);
}

/**
 * Return weather_history for a rolling window, coalesced to one row per date
 * (preferring ambient source over openmeteo when both exist for the same day).
 */
export function getWeatherHistoryForCharts(days = 30) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT date, temp_max, temp_min, temp_avg, humidity,
           precipitation, solar_radiation, wind_speed, source
    FROM weather_history
    WHERE date >= ?
    ORDER BY date ASC, source = 'ambient' DESC
  `).all(since);
}

/**
 * Return reference_et history (CoAgMet Penman-Monteith).
 */
export function getReferenceETForCharts(days = 30) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return db.prepare(`
    SELECT date, station, reference_eto, reference_etr,
           temp_max, temp_min, precipitation
    FROM reference_et
    WHERE date >= ?
    ORDER BY date ASC
  `).all(since);
}

// -- Watering days by zone (for rolling-window restriction checks) ------------

/**
 * For each zone, return the set of local YYYY-MM-DD dates on which that zone
 * received water in the last `days` days. Used to enforce max-days-per-week
 * restrictions without caching state elsewhere.
 *
 * @param {number} days - Rolling window size (days)
 * @returns {Map<string, Set<string>>} zoneId -> Set of date strings
 */
export function getWateringDatesByZone(days = 7) {
  const db = getDB();
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const runs = db.prepare(`
    SELECT timestamp, zones_json, shadow FROM runs
    WHERE julianday(timestamp) > julianday(?)
      AND phase = 'VERIFY'
      AND decision = 'WATER'
      AND success = 1
      AND shadow = 0
  `).all(since);

  const byZone = new Map();
  for (const r of runs) {
    if (!r.zones_json) continue;
    let zones;
    try {
      zones = JSON.parse(r.zones_json);
    } catch {
      continue;
    }
    if (!Array.isArray(zones)) continue;
    const parsedTimestamp = parseStoredTimestamp(r.timestamp);
    if (!parsedTimestamp) continue;
    const dateStr = localDateStr(parsedTimestamp);
    for (const z of zones) {
      const id = z.id ?? z.zoneId;
      if (!id) continue;
      if (!byZone.has(id)) byZone.set(id, new Set());
      byZone.get(id).add(dateStr);
    }
  }
  return byZone;
}

// -- Utility meter ground truth (AquaHawk / utility portal) -------------------

/**
 * Bulk upsert utility usage readings. Dedup key: (start_time, interval, source).
 * Expected row fields match the utility_usage table columns.
 *
 * @param {Array} rows
 * @param {string} source - e.g. 'aquahawk'
 * @param {string} accountNumber
 */
export function bulkUpsertUtilityUsage(rows, source, accountNumber) {
  if (!rows || rows.length === 0) return 0;
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO utility_usage (
      start_time, interval, end_time, gallons, gallons_min, gallons_max, gallons_samples,
      rainfall_in, high_temp_f, low_temp_f, avg_temp_f, source, account_number, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(start_time, interval, source) DO UPDATE SET
      end_time = excluded.end_time,
      gallons = excluded.gallons,
      gallons_min = excluded.gallons_min,
      gallons_max = excluded.gallons_max,
      gallons_samples = excluded.gallons_samples,
      rainfall_in = excluded.rainfall_in,
      high_temp_f = excluded.high_temp_f,
      low_temp_f = excluded.low_temp_f,
      avg_temp_f = excluded.avg_temp_f,
      account_number = excluded.account_number,
      fetched_at = excluded.fetched_at
  `);

  const tx = db.transaction(batch => {
    for (const r of batch) {
      stmt.run(
        r.start_time,
        r.interval,
        r.end_time ?? null,
        r.gallons ?? null,
        r.gallons_min ?? null,
        r.gallons_max ?? null,
        r.gallons_samples ?? null,
        r.rainfall_in ?? null,
        r.high_temp_f ?? null,
        r.low_temp_f ?? null,
        r.avg_temp_f ?? null,
        source,
        accountNumber ?? null
      );
    }
  });

  tx(rows);
  return rows.length;
}

export function getUtilityUsage({ interval, since, until } = {}) {
  const db = getDB();
  const clauses = [];
  const args = [];
  if (interval) {
    clauses.push('interval = ?');
    args.push(interval);
  }
  if (since) {
    clauses.push('start_time >= ?');
    args.push(since);
  }
  if (until) {
    clauses.push('start_time < ?');
    args.push(until);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM utility_usage ${where} ORDER BY start_time ASC`).all(...args);
}

export function latestUtilityUsageTimestamp(interval, source = 'aquahawk') {
  const row = getDB()
    .prepare(`SELECT MAX(start_time) AS ts FROM utility_usage WHERE interval = ? AND source = ?`)
    .get(interval, source);
  return row?.ts || null;
}

// -- Utility bills ------------------------------------------------------------

export function upsertUtilityBill(bill) {
  const db = getDB();
  db.prepare(`
    INSERT INTO utility_bills (
      bill_date, period_start, period_end, days,
      reading_start_kgal, reading_end_kgal, usage_kgal,
      awc_kgal,
      tier1_usage_kgal, tier1_rate,
      tier2_usage_kgal, tier2_rate,
      tier3_usage_kgal, tier3_rate,
      water_service, water_base_fee, wastewater, drainage, trash, other_charges, total,
      source_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bill_date) DO UPDATE SET
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      days = excluded.days,
      reading_start_kgal = excluded.reading_start_kgal,
      reading_end_kgal = excluded.reading_end_kgal,
      usage_kgal = excluded.usage_kgal,
      awc_kgal = excluded.awc_kgal,
      tier1_usage_kgal = excluded.tier1_usage_kgal,
      tier1_rate = excluded.tier1_rate,
      tier2_usage_kgal = excluded.tier2_usage_kgal,
      tier2_rate = excluded.tier2_rate,
      tier3_usage_kgal = excluded.tier3_usage_kgal,
      tier3_rate = excluded.tier3_rate,
      water_service = excluded.water_service,
      water_base_fee = excluded.water_base_fee,
      wastewater = excluded.wastewater,
      drainage = excluded.drainage,
      trash = excluded.trash,
      other_charges = excluded.other_charges,
      total = excluded.total,
      source_path = excluded.source_path,
      fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(
    bill.bill_date,
    bill.period_start,
    bill.period_end,
    bill.days ?? null,
    bill.reading_start_kgal ?? null,
    bill.reading_end_kgal ?? null,
    bill.usage_kgal ?? null,
    bill.awc_kgal ?? null,
    bill.tier1_usage_kgal ?? null,
    bill.tier1_rate ?? null,
    bill.tier2_usage_kgal ?? null,
    bill.tier2_rate ?? null,
    bill.tier3_usage_kgal ?? null,
    bill.tier3_rate ?? null,
    bill.water_service ?? null,
    bill.water_base_fee ?? null,
    bill.wastewater ?? null,
    bill.drainage ?? null,
    bill.trash ?? null,
    bill.other_charges ?? null,
    bill.total ?? null,
    bill.source_path ?? null
  );
}

export function getUtilityBills({ since } = {}) {
  const db = getDB();
  if (since) {
    return db.prepare(`SELECT * FROM utility_bills WHERE period_end >= ? ORDER BY bill_date ASC`).all(since);
  }
  return db.prepare(`SELECT * FROM utility_bills ORDER BY bill_date ASC`).all();
}

// -- Utility rate regime history ---------------------------------------------

export function upsertRateRegime(regime) {
  const db = getDB();
  db.prepare(`
    INSERT INTO utility_rate_schedule (
      effective_from, provider, awc_kgal,
      tier1_rate, tier2_rate, tier3_rate,
      water_base_fee, wastewater_fee, wastewater_rate_per_kgal,
      drainage_fee, trash_fee, source, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(effective_from) DO UPDATE SET
      provider = excluded.provider,
      awc_kgal = excluded.awc_kgal,
      tier1_rate = excluded.tier1_rate,
      tier2_rate = excluded.tier2_rate,
      tier3_rate = excluded.tier3_rate,
      water_base_fee = excluded.water_base_fee,
      wastewater_fee = excluded.wastewater_fee,
      wastewater_rate_per_kgal = excluded.wastewater_rate_per_kgal,
      drainage_fee = excluded.drainage_fee,
      trash_fee = excluded.trash_fee,
      source = excluded.source,
      notes = excluded.notes
  `).run(
    regime.effective_from,
    regime.provider ?? null,
    regime.awc_kgal ?? null,
    regime.tier1_rate ?? null,
    regime.tier2_rate ?? null,
    regime.tier3_rate ?? null,
    regime.water_base_fee ?? null,
    regime.wastewater_fee ?? null,
    regime.wastewater_rate_per_kgal ?? null,
    regime.drainage_fee ?? null,
    regime.trash_fee ?? null,
    regime.source ?? null,
    regime.notes ?? null
  );
}

export function getRateRegimeAt(date) {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM utility_rate_schedule
    WHERE effective_from <= ?
    ORDER BY effective_from DESC
    LIMIT 1
  `).get(date);
}
