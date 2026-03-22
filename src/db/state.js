// SQLite state management
// All persistent state reads/writes go through this module.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { log } from '../log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

let db = null;

/**
 * Initialize the database connection and apply schema.
 *
 * @param {string} dbPath - Path to SQLite database file
 * @returns {Database} The database instance
 */
export function initDB(dbPath) {
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
 * Get the active database instance.
 */
export function getDB() {
  if (!db) throw new Error('Database not initialized - call initDB first');
  return db;
}

// --- Runs ---

export function logRun({ window, phase, decision, reason, zones, gallons, cost, success, shadow, error }) {
  return getDB().prepare(`
    INSERT INTO runs (window, phase, decision, reason, zones_json, total_gallons, total_cost, success, shadow, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    ORDER BY timestamp DESC LIMIT 1
  `).get(window);
}

export function getRunsSince(since) {
  return getDB().prepare(`
    SELECT * FROM runs WHERE timestamp >= ? ORDER BY timestamp DESC
  `).all(since);
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

export function setSoilMoisture(zoneId, zoneNumber, zoneName, balanceInches, totalCapacity) {
  getDB().prepare(`
    INSERT INTO soil_moisture (zone_id, zone_number, zone_name, balance_inches, total_capacity, last_updated)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(zone_id) DO UPDATE SET
      balance_inches = excluded.balance_inches,
      total_capacity = excluded.total_capacity,
      last_updated = excluded.last_updated
  `).run(zoneId, zoneNumber, zoneName, balanceInches, totalCapacity);
}

export function bulkSetSoilMoisture(balances, profiles) {
  const stmt = getDB().prepare(`
    INSERT INTO soil_moisture (zone_id, zone_number, zone_name, balance_inches, total_capacity, last_updated)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
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
        stmt.run(profile.id, profile.zoneNumber, profile.name, balance, capacity);
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
  getDB().prepare(`
    INSERT INTO daily_usage (date, gallons, cost, zones_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      gallons = gallons + excluded.gallons,
      cost = cost + excluded.cost,
      zones_json = excluded.zones_json
  `).run(dateStr, gallons, cost, zonesJson);
}

// --- Weather Cache ---

export function getCachedWeather(source) {
  return getDB().prepare('SELECT * FROM weather_cache WHERE source = ?').get(source);
}

export function setCachedWeather(source, data) {
  getDB().prepare(`
    INSERT INTO weather_cache (source, data_json, fetched_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(source) DO UPDATE SET
      data_json = excluded.data_json,
      fetched_at = excluded.fetched_at
  `).run(source, JSON.stringify(data));
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
  getDB().prepare(`
    INSERT INTO fertilizer_log (zone_id, applied_at)
    VALUES (?, datetime('now'))
    ON CONFLICT(zone_id) DO UPDATE SET applied_at = excluded.applied_at
  `).run(zoneId);
}

// --- Cleanup ---

export function cleanupOldData(retentionDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString();

  const runsDeleted = getDB().prepare('DELETE FROM runs WHERE timestamp < ?').run(cutoffStr).changes;
  const usageDeleted = getDB().prepare('DELETE FROM daily_usage WHERE date < ?').run(cutoffStr.slice(0, 10)).changes;

  if (runsDeleted + usageDeleted > 0) {
    log(1, `Cleanup: removed ${runsDeleted} runs, ${usageDeleted} daily_usage records`);
  }
}

// --- Weather Discrepancy ---

export function logWeatherDiscrepancy(field, ambientValue, openmeteoValue, usedValue, reason) {
  getDB().prepare(`
    INSERT INTO weather_discrepancy (field, ambient_value, openmeteo_value, used_value, reason)
    VALUES (?, ?, ?, ?, ?)
  `).run(field, ambientValue, openmeteoValue, usedValue, reason);
}

export function getRecentDiscrepancies(hours = 24) {
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  return getDB().prepare('SELECT * FROM weather_discrepancy WHERE timestamp >= ? ORDER BY timestamp DESC').all(since);
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
  getDB().prepare(`
    INSERT INTO flow_audit (zone_id, zone_number, expected_gallons, actual_gallons, deviation_pct)
    VALUES (?, ?, ?, ?, ?)
  `).run(zoneId, zoneNumber, expectedGallons, actualGallons, deviationPct);
}

export function getFlowAuditsForZone(zoneId, limit = 20) {
  return getDB().prepare(
    'SELECT * FROM flow_audit WHERE zone_id = ? ORDER BY timestamp DESC LIMIT ?'
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
  getDB().prepare(`
    INSERT INTO zone_tuning (zone_id, parameter, original_value, suggested_value)
    VALUES (?, ?, ?, ?)
  `).run(zoneId, parameter, originalValue, suggestedValue);
}

export function getUnappliedTuning() {
  return getDB().prepare(
    'SELECT * FROM zone_tuning WHERE applied = 0 ORDER BY timestamp DESC'
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
  const lock = getSystemState('run_lock');
  if (lock) {
    const lockTime = new Date(lock).getTime();
    // Stale lock detection: if lock is older than 10 minutes, force release
    if (Date.now() - lockTime < 600000) {
      return false;
    }
    log(1, 'Releasing stale run lock');
  }
  setSystemState('run_lock', new Date().toISOString());
  return true;
}

export function releaseRunLock() {
  getDB().prepare('DELETE FROM system_state WHERE key = ?').run('run_lock');
}

// --- Status ---

export function getStatus(localDateStr) {
  const lastRun = getDB().prepare('SELECT * FROM runs ORDER BY timestamp DESC LIMIT 1').get();
  const moisture = getDB().prepare('SELECT * FROM soil_moisture ORDER BY zone_number').all();
  const finance = getFinanceData();
  const todayUsage = getDailyUsage(localDateStr || new Date().toISOString().slice(0, 10));

  return { lastRun, moisture, finance, todayUsage };
}

/**
 * Get status as a JSON-serializable object for n8n webhook consumption.
 */
export function getStatusJSON(localDateStr) {
  const status = getStatus(localDateStr);
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
