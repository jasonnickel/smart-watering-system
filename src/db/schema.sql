-- Smart Water System SQLite Schema
-- WAL mode is set programmatically on connection

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
  last_updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
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
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS weather_discrepancy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  field TEXT NOT NULL,
  ambient_value REAL,
  openmeteo_value REAL,
  used_value REAL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS precipitation_audit (
  date TEXT PRIMARY KEY,
  ambient_inches REAL,
  openmeteo_inches REAL,
  used_inches REAL,
  discrepancy_pct REAL
);

CREATE TABLE IF NOT EXISTS flow_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  zone_id TEXT NOT NULL,
  zone_number INTEGER,
  expected_gallons REAL,
  actual_gallons REAL,
  deviation_pct REAL
);

CREATE TABLE IF NOT EXISTS zone_tuning (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  zone_id TEXT NOT NULL,
  parameter TEXT NOT NULL,
  original_value REAL,
  suggested_value REAL,
  applied INTEGER DEFAULT 0
);

-- USDA soil survey cache (queried once per location, rarely changes)
CREATE TABLE IF NOT EXISTS soil_survey (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  soil_name TEXT,
  dominant_pct REAL,
  total_awc_inches REAL,
  awc_per_inch REAL,
  profile_depth_inches REAL,
  avg_ph REAL,
  avg_organic_matter_pct REAL,
  avg_infiltration_rate REAL,
  horizons_json TEXT,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- CoAgMet reference ET history (daily, for cross-validation)
CREATE TABLE IF NOT EXISTS reference_et (
  date TEXT NOT NULL,
  station TEXT NOT NULL,
  reference_eto REAL,
  reference_etr REAL,
  temp_max REAL,
  temp_min REAL,
  solar_radiation REAL,
  wind_speed REAL,
  precipitation REAL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (date, station)
);

-- Historical daily weather archive (from OpenMeteo + Ambient)
CREATE TABLE IF NOT EXISTS weather_history (
  date TEXT NOT NULL,
  source TEXT NOT NULL,
  temp_max REAL,
  temp_min REAL,
  temp_avg REAL,
  humidity REAL,
  precipitation REAL,
  solar_radiation REAL,
  wind_speed REAL,
  wind_gust REAL,
  et_reference REAL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (date, source)
);

-- Sentinel-2 NDVI readings (per observation period)
CREATE TABLE IF NOT EXISTS ndvi_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  ndvi_mean REAL,
  ndvi_min REAL,
  ndvi_max REAL,
  sample_count INTEGER,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ET cross-validation log (system ET vs reference ET comparison)
CREATE TABLE IF NOT EXISTS et_validation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  station TEXT NOT NULL,
  calculated_et REAL NOT NULL,
  reference_eto REAL NOT NULL,
  deviation_pct REAL NOT NULL,
  assessment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_weather_history_date ON weather_history(date DESC);
CREATE INDEX IF NOT EXISTS idx_reference_et_date ON reference_et(date DESC);
CREATE INDEX IF NOT EXISTS idx_ndvi_history_period ON ndvi_history(period_from DESC);
CREATE INDEX IF NOT EXISTS idx_et_validation_date ON et_validation(date DESC);

-- Index for recent run lookups
CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_runs_window ON runs(window, timestamp DESC);
