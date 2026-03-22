-- Smart Water System SQLite Schema
-- WAL mode is set programmatically on connection

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  window TEXT NOT NULL,           -- 'daily', 'emergency', 'manual'
  phase TEXT NOT NULL,            -- 'DECIDE', 'COMMAND', 'VERIFY'
  decision TEXT NOT NULL,         -- 'WATER', 'SKIP'
  reason TEXT NOT NULL,
  zones_json TEXT,                -- JSON array of zone details
  total_gallons REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  success INTEGER DEFAULT 1,     -- 0 = failed, 1 = success
  shadow INTEGER DEFAULT 0,      -- 1 = shadow mode (not actuated)
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS soil_moisture (
  zone_id TEXT PRIMARY KEY,
  zone_number INTEGER NOT NULL,
  zone_name TEXT NOT NULL,
  balance_inches REAL NOT NULL,
  total_capacity REAL NOT NULL,
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finance (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  cumulative_gallons REAL DEFAULT 0,
  monthly_gallons REAL DEFAULT 0,
  monthly_cost REAL DEFAULT 0,
  last_reset TEXT
);

CREATE TABLE IF NOT EXISTS weather_cache (
  source TEXT PRIMARY KEY,        -- 'ambient', 'openmeteo_yesterday', 'openmeteo_forecast'
  data_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_usage (
  date TEXT PRIMARY KEY,          -- YYYY-MM-DD
  gallons REAL DEFAULT 0,
  cost REAL DEFAULT 0,
  zones_json TEXT                 -- { zoneId: minutes }
);

CREATE TABLE IF NOT EXISTS fertilizer_log (
  zone_id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config_overrides (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for recent run lookups
CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_runs_window ON runs(window, timestamp DESC);
