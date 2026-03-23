# Taproot - Feature Roadmap

Each feature below addresses a specific, documented real-world complaint from Rachio community forums and power user communities. Features are ordered by impact and implementation complexity.

---

## Phase 1: Core Reliability (addresses the most common Rachio failures)

### 1.1 Real-Time Rain Check Before Actuating

**Problem it solves:** Rachio's #1 most-reported complaint. Weather Intelligence evaluates conditions 12 hours and 1 hour before a scheduled run. Rain starting in the final window does not trigger a skip. Users document watering during active heavy rainfall with 0.25"+ already accumulated.

**Implementation:**
- Add a final weather station read in `cli.js` between the DECIDE and COMMAND phases
- If `rainLast24h` exceeds the skip threshold OR rain rate indicates active precipitation, abort the run
- Log as a new decision reason: "Aborted - Active Rain Detected"
- The check uses live Ambient Weather data (not cached) to ensure real-time accuracy

**Files to modify:**
- `src/cli.js` - add rain check between decision and command
- `src/api/ambient.js` - add `getCurrentRainRate()` function using `hourlyrainin` field
- `src/db/schema.sql` - no changes needed, existing `runs` table handles the new reason

**Complexity:** Low (30 min)
**Impact:** High - directly prevents the most embarrassing irrigation failure mode

---

### 1.2 Multi-Source Weather Cross-Validation

**Problem it solves:** Users report Rachio showing 0.14" rainfall when local gauges read 0.35". Single-source weather data is unreliable. Sensor drift, station placement, and network issues all cause silent data quality degradation.

**Implementation:**
- When both Ambient Weather and OpenMeteo return precipitation data, compare them
- If they disagree by more than 0.15" (configurable threshold), log a discrepancy warning
- For skip decisions, use the higher rainfall value (conservative - less likely to water unnecessarily)
- For deficit calculations, use the lower rainfall value (conservative - less likely to under-water)
- Store both values in the weather cache for historical analysis

**Files to modify:**
- `src/weather.js` - add cross-validation logic in `resolveCurrentWeather()`
- `src/config.js` - add `weatherValidation.precipDiscrepancyThreshold`
- `src/db/schema.sql` - add `weather_discrepancy` table

**New table:**
```sql
CREATE TABLE IF NOT EXISTS weather_discrepancy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  field TEXT NOT NULL,
  ambient_value REAL,
  openmeteo_value REAL,
  used_value REAL,
  reason TEXT
);
```

**Complexity:** Medium (1 hour)
**Impact:** High - catches bad data before it causes bad decisions

---

### 1.3 Weather Data Quality Alerts

**Problem it solves:** Rachio silently falls back to distant weather stations when a user's PWS goes offline. No notification. Users discover weeks later that their "hyperlocal" data was actually from a station 2 miles away with different microclimate conditions.

**Implementation:**
- When degraded mode activates in `weather.js`, send an alert via the notification system
- Track how long the station has been offline and escalate severity
- Alert levels: INFO at 4 hours stale, WARNING at 12 hours, CRITICAL at 24 hours
- Include the fallback source in the alert ("Using OpenMeteo forecast" vs "Using conservative defaults")
- Daily summary includes current weather data source and staleness

**Files to modify:**
- `src/weather.js` - add alert triggers when degraded mode activates
- `src/notify.js` - new file, notification dispatch (webhook or SMTP)
- `src/config.js` - add `degradedMode.alertThresholds`

**Complexity:** Medium (1 hour)
**Impact:** High - users know immediately when data quality drops

---

## Phase 2: Observability (addresses "I can't see what it's doing")

### 2.1 Daily Summary Email

**Problem it solves:** Users want to know what the system did overnight without checking logs. The original GAS script had this and it was the most-used feature.

**Implementation:**
- New `src/summary.js` module that queries SQLite for overnight activity
- Morning email (6am systemd timer) containing:
  - Overnight decision: what happened and why (with full reasoning chain)
  - Current soil moisture per zone (percentage bar or table)
  - Today's forecast and whether emergency cooling is likely
  - Month-to-date water usage and cost
  - Weather data source status (ambient vs degraded)
  - Any discrepancy warnings from cross-validation
- HTML email template, plain text fallback
- Delivery via n8n webhook POST or direct SMTP (nodemailer)

**Files to create:**
- `src/summary.js` - build email content from SQLite data
- `src/notify.js` - dispatch via webhook or SMTP (shared with 1.3)
- `deploy/smart-water-summary.service` - systemd oneshot for 6am
- `deploy/smart-water-summary.timer` - daily at 6am

**Complexity:** Medium (2 hours)
**Impact:** High - the feature most likely to keep users engaged with the system

---

### 2.2 Rain Gauge Reconciliation Log

**Problem it solves:** Over time, weather station sensors drift. A rain gauge might read 20% low due to debris or spider webs. Without tracking, this silently corrupts every ET calculation.

**Implementation:**
- After each daily soil update, record both Ambient Weather and OpenMeteo precipitation for the previous day
- Store in a `precipitation_audit` table with both readings and the value used
- Weekly summary in the daily email showing any persistent bias
- If one source consistently reads higher/lower by more than 20% over 7 days, flag for sensor maintenance

**New table:**
```sql
CREATE TABLE IF NOT EXISTS precipitation_audit (
  date TEXT PRIMARY KEY,
  ambient_inches REAL,
  openmeteo_inches REAL,
  used_inches REAL,
  discrepancy_pct REAL
);
```

**Files to modify:**
- `src/weather.js` - record both readings during daily update
- `src/db/state.js` - add precipitation audit functions
- `src/summary.js` - include weekly bias report

**Complexity:** Low (45 min)
**Impact:** Medium - catches slow sensor degradation before it causes visible lawn damage

---

### 2.3 Simple Status Web Page

**Problem it solves:** Not everyone wants to SSH into a server and run CLI commands. A simple web page showing current state makes the system accessible to non-technical household members.

**Implementation:**
- Static HTML file regenerated after each run by the CLI
- Served by n8n (static file response on a webhook) or a lightweight file server
- Content: current soil moisture per zone (color-coded bars), last 5 decisions with reasons, today's forecast, month-to-date cost, weather source status
- No JavaScript framework - plain HTML with inline CSS
- Regenerated as `/root/.taproot/status.html` after each run

**Files to create:**
- `src/status-page.js` - generate HTML from SQLite data
- Modify `src/cli.js` - call status page generator after each run

**Complexity:** Medium (1.5 hours)
**Impact:** Medium - makes the system visible without CLI access

---

## Phase 3: Usability (addresses "too hard to configure")

### 3.1 Zone Profiles via YAML Config File

**Problem it solves:** Flex Daily's #2 complaint is sensitivity to zone calibration. Our zone profiles are hardcoded in `config.js`, which is intimidating for non-developers. A YAML file with comments explaining each parameter makes tuning accessible.

**Implementation:**
- New `zones.yaml` file with all zone profiles, soil profiles, and per-zone overrides
- Comments in the YAML explaining what each field does and how to measure it
- `config.js` reads YAML at startup, merges with defaults
- Validation on load: warn if any zone has suspicious values (e.g., area < 50 sqft, precipitation rate > 2 in/hr)
- Example zones.yaml with documentation for each field

**Example format:**
```yaml
# Zone Profiles - edit these to match your yard
# Run catch cup tests to measure actual precipitation rates

zones:
  1:
    name: Front Lawn East
    type: lawn
    area_sqft: 400
    sun_exposure: 1.0       # 0.0 (full shade) to 1.0 (full sun)
    priority: 1             # Lower = higher priority
    soil: frontYard2023

soil_profiles:
  frontYard2023:
    organic_matter_pct: 1.77
    soil_ph: 8.0
```

**Files to create:**
- `zones.yaml` - zone configuration with documentation
- `src/yaml-loader.js` - parse and validate YAML

**Files to modify:**
- `src/config.js` - load zones from YAML, merge with defaults
- `package.json` - add `js-yaml` dependency

**Complexity:** Medium (1.5 hours)
**Impact:** Medium - critical for adoption by anyone other than the original author

---

## Phase 4: Intelligence (addresses "it doesn't learn")

### 4.1 Flow Meter Integration

**Problem it solves:** The biggest Flex Daily usability complaint is that precipitation rates must be manually calibrated via catch cup tests. Most users never do this, so the model runs on wrong inputs from day one. A flow meter provides actual gallons-per-zone data, enabling auto-calibration.

**Implementation:**
- Support EveryDrop (Rachio's wired/wireless flow meter) data via Rachio API
- After each zone run, compare expected gallons (from precipitation rate * area * duration) vs actual gallons (from flow meter)
- If they diverge by more than 15% consistently over 5+ runs, suggest a precipitation rate adjustment
- Store flow data in a `flow_audit` table
- Optional: auto-adjust precipitation rate after sufficient confidence (20+ runs with consistent bias)

**New table:**
```sql
CREATE TABLE IF NOT EXISTS flow_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  zone_id TEXT NOT NULL,
  expected_gallons REAL,
  actual_gallons REAL,
  deviation_pct REAL
);
```

**API addition:**
- `src/api/rachio.js` - add `getZoneFlowData()` using Rachio's flow monitoring endpoints

**Files to modify:**
- `src/cli.js` - query flow data after verified run
- `src/db/state.js` - add flow audit functions
- `src/summary.js` - include calibration suggestions

**Prerequisite:** User must have an EveryDrop flow meter installed
**Complexity:** High (3 hours)
**Impact:** High for users with flow meters - eliminates the #1 setup barrier

---

### 4.2 Adaptive Zone Tuning

**Problem it solves:** Even with correct initial calibration, soil conditions change over time. Aeration, compaction, root growth, and organic matter decomposition all affect water holding capacity. Rachio's model uses fixed parameters forever.

**Implementation:**
- Track predicted vs actual soil moisture trends over 14-day windows
- If a zone consistently reaches its trigger point faster than predicted, the effective AWC or ET multiplier needs adjustment
- Calculate a rolling correction factor per zone
- Suggest adjustments in the daily summary email
- Optional: auto-apply corrections within bounds (0.8x to 1.2x of configured values)
- Store correction history for trend analysis

**New table:**
```sql
CREATE TABLE IF NOT EXISTS zone_tuning (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  zone_id TEXT NOT NULL,
  parameter TEXT NOT NULL,
  original_value REAL,
  suggested_value REAL,
  applied INTEGER DEFAULT 0
);
```

**Files to create:**
- `src/core/tuning.js` - analyze historical data, calculate corrections

**Files to modify:**
- `src/core/soil-moisture.js` - apply correction factors to ET calculations
- `src/summary.js` - include tuning suggestions

**Complexity:** High (4 hours)
**Impact:** High long-term - the system gets more accurate over time instead of degrading

---

## Phase 5: Ecosystem (addresses cloud lock-in and integration)

### 5.1 Home Assistant Integration via MQTT

**Problem it solves:** Power users on the Home Assistant community consistently cite lack of local control as their #1 reason for leaving Rachio. Publishing state to MQTT lets HA users build dashboards, automations, and alerts using their existing infrastructure.

**Implementation:**
- After each run, publish current state to MQTT topics:
  - `taproot/status` - overall system status (JSON)
  - `taproot/zone/{number}/moisture` - per-zone moisture percentage
  - `taproot/zone/{number}/balance` - per-zone balance in inches
  - `taproot/decision` - last decision with reason
  - `taproot/weather` - current weather data and source
  - `taproot/finance` - daily and monthly cost data
- HA auto-discovery via MQTT discovery protocol (optional)
- Retain messages so HA gets current state on restart
- Use the existing MQTT broker at 192.168.68.110

**Files to create:**
- `src/mqtt.js` - MQTT client with publish functions

**Files to modify:**
- `src/cli.js` - publish state after each run
- `src/config.js` - add MQTT configuration
- `package.json` - add `mqtt` dependency
- `.env.example` - add MQTT_BROKER_URL

**Complexity:** Medium (2 hours)
**Impact:** High for HA users - opens the system to the largest smart home platform

---

## Implementation Order

| Phase | Feature | Complexity | Impact | Dependencies |
| ----- | ------- | ---------- | ------ | ------------ |
| 1.1 | Real-time rain check | Low | High | None |
| 1.2 | Weather cross-validation | Medium | High | None |
| 1.3 | Weather data quality alerts | Medium | High | Notification system |
| 2.1 | Daily summary email | Medium | High | Notification system |
| 2.2 | Rain gauge reconciliation | Low | Medium | 1.2 |
| 2.3 | Status web page | Medium | Medium | None |
| 3.1 | YAML zone config | Medium | Medium | None |
| 4.1 | Flow meter integration | High | High | EveryDrop hardware |
| 4.2 | Adaptive zone tuning | High | High | 2+ weeks of run data |
| 5.1 | MQTT / Home Assistant | Medium | High | MQTT broker |

Phases 1 and 2 should be completed before go-live. Phase 3 before sharing publicly. Phases 4 and 5 can be built incrementally after the system has been running and collecting data.

---

## Shared Dependencies

Several features need a notification system (`src/notify.js`). Build this once during Phase 1.3 and reuse across:
- Weather data quality alerts (1.3)
- Daily summary email (2.1)
- Watchdog alerts (existing)
- Flow meter calibration suggestions (4.1)
- Adaptive tuning suggestions (4.2)

Notification dispatch options (configured via .env):
1. n8n webhook POST (preferred - n8n handles email delivery)
2. Direct SMTP via nodemailer (fallback if n8n is down)
