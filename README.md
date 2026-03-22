# Smart Water System

Standalone irrigation controller that takes over scheduling for a Rachio sprinkler system using your weather station data plus forecast/archive weather APIs, ET-based soil moisture modeling, and multi-day forecasting. Gives you full control over the decision logic that Rachio keeps behind its app.

This repo is a working homelab-oriented controller, not a polished SaaS product. The core decision engine, weather fallback logic, status page, MQTT publishing, watchdog, and summary job are implemented. A few ideas in the codebase are still groundwork rather than finished features, and those are called out explicitly below.

## How It Works

```mermaid
flowchart LR
    WX["Weather Station\n+ Forecast APIs"] --> DECIDE
    DB[("SQLite\nSoil + Finance\nState")] --> DECIDE

    DECIDE{"Safe?\nSoil needs it?\nWithin budget?"}

    DECIDE -->|YES| RAIN{"Raining\nright now?"}
    DECIDE -->|NO| LOG["Log\nSkip Reason"]

    RAIN -->|NO| RACHIO["Rachio\nWater Zones"]
    RAIN -->|YES| ABORT["Abort\nActive Rain"]

    RACHIO --> VERIFY["Verify\nAccepted"]
    VERIFY --> DB

    TIMER(["Hourly\nsystemd timer"]) -.-> DECIDE
    PHONE(["Manual Trigger\nCLI / webhook"]) -.-> DECIDE

    style DECIDE fill:#e65100,stroke:#bf360c,color:#fff
    style RAIN fill:#1565c0,stroke:#0d47a1,color:#fff
    style RACHIO fill:#2e7d32,stroke:#1b5e20,color:#fff
    style VERIFY fill:#2e7d32,stroke:#1b5e20,color:#fff
    style LOG fill:#c62828,stroke:#b71c1c,color:#fff
    style ABORT fill:#c62828,stroke:#b71c1c,color:#fff
    style WX fill:#1565c0,stroke:#0d47a1,color:#fff
    style DB fill:#1565c0,stroke:#0d47a1,color:#fff
    style TIMER fill:#6a1b9a,stroke:#4a148c,color:#fff
    style PHONE fill:#6a1b9a,stroke:#4a148c,color:#fff
```

## What it does

Every hour, the system checks whether your lawn needs water by running a five-stage decision pipeline:

1. **Safety** - Skip if wind is too high, it rained recently, or temperatures are below the configured floor
2. **Forecast** - Skip if forecast rainfall exceeds the configured threshold
3. **Soil moisture** - Calculate per-zone water deficit using evapotranspiration (ET) modeling driven by archived, forecast, and live weather inputs
4. **Budget** - Enforce daily gallon and cost limits based on your tiered water rates
5. **Scheduling** - Build an optimized run with smart soak cycles for clay soil infiltration

If watering is needed, a final real-time rain check confirms it's not actively raining right now. Then the system sends the command to Rachio, verifies it was accepted, and updates all state. If not, it logs the skip reason and moves on.

## Rachio's Problems, Our Solutions

This project is aimed at homeowners who want an inspectable, self-hosted decision engine for common smart-irrigation pain points: stale weather data, opaque skip decisions, cloud dependency, and limited observability. The sections below describe what this repo actually does today.

### "It watered during a thunderstorm"

**The Rachio problem:** Weather Intelligence evaluates conditions 12 hours and 1 hour before a scheduled run. Rain that starts within that final window does not trigger a skip. Users on the Rachio community forum document watering during active heavy rainfall with 0.25"+ already accumulated. One user with a Tempest weather station confirmed that 0.25" of rain at a rate well above the skip threshold simply didn't register because it fell inside the timing blind spot.

**Our solution:** A live rain check hits your Ambient Weather station between the DECIDE and COMMAND phases of every run. If any measurable rainfall is detected (hourly rain > 0.02" or daily accumulation exceeds the skip threshold), the run is aborted and logged as "Active Rain Detected." This check uses a fresh, uncached API call - not data from minutes or hours ago. The system will never send water to your yard while it's already raining.

### "Weather Intelligence said 0.14 inches when my gauge read 0.35"

**The Rachio problem:** Rachio 3 routes weather data through Aeris Weather, which aggregates from CWOP, PWSWeather, and Weather Underground networks. Users report significant precipitation discrepancies between what their personal station measures and what Rachio records. There's no way to see the discrepancy or know which data source Rachio actually used. One user documented Rachio showing 0.14" for a day when local flood control confirmed 0.35".

**Our solution:** Every day, the system cross-validates precipitation readings between your Ambient Weather station and OpenMeteo's archive data. Discrepancies exceeding 0.15" are logged to a `weather_discrepancy` table with both values and what was used. The daily summary job also highlights repeated high-discrepancy days so you can investigate rain gauge drift or source mismatch. You can query exactly what data drove every decision.

### "My station went offline and Rachio never told me"

**The Rachio problem:** When a nearby personal weather station goes offline, Rachio silently falls back to more distant stations or interpolated grid data. There is no notification. Users discover weeks later that their "hyperlocal" 36-foot-resolution data was actually coming from a station miles away with different microclimate conditions. The system continues making decisions on degraded data without any indication.

**Our solution:** On each run, the controller checks how old the last Ambient Weather reading is. Once the cache age crosses 4 hours, 12 hours, and 24 hours, it escalates alerts and tells you whether it is falling back to OpenMeteo data or conservative defaults. The daily summary also reports the active weather source and its freshness. If all weather sources are unavailable, the controller falls back to conservative current-condition defaults instead of crashing or silently stopping decisions.

### "Flex Daily went 8 days without watering in 100-degree heat"

**The Rachio problem:** Flex Daily's ET model uses fixed parameters that don't account for extreme conditions well. Users in Phoenix and other high-heat climates document multi-day watering gaps during 100F+ temperatures. The model is also highly sensitive to precipitation rate calibration - without catch cup testing, users report 20-hour schedules or severe over/under-watering. Many users give up and revert to fixed schedules.

**Our solution:** Three layers of protection:
- **Emergency cooling** with dynamic temperature triggers that adjust based on solar radiation, humidity, and wind - not just air temperature. When conditions are genuinely dangerous for turf, the system waters regardless of what the daily schedule decided.
- **Degraded-mode policy** that never skips watering in summer because a data source is unavailable. If your weather station and forecast APIs both go down during a heat wave, conservative defaults ensure watering continues.
- **Tuning scaffolding** for future model calibration. Today the implemented tuning path is flow-based suggestion logging; ET correction storage exists, but automatic ET drift analysis is not finished yet.

### "Cycle and Soak activated on some zones but not others"

**The Rachio problem:** Users report Smart Cycle inconsistently activating across zones in the same schedule. Some zones get split into cycles with soak intervals, others don't, with no clear explanation in the app. One user had an 8-minute zone silently extended to 46 minutes.

**Our solution:** Smart soak is deterministic and transparent. Any lawn zone exceeding the configurable soak threshold (default: 20 minutes) gets split into two equal passes. The full schedule with all soak splits is logged in the decision record. You can see exactly which zones got split, what the half-times are, and why. No surprises.

### "I have no idea why it did that"

**The Rachio problem:** The app shows what happened (watered zone 3 for 25 minutes) but not why. Users can't determine whether a run was triggered by ET deficit, proactive forecast logic, or schedule. When the system skips, the reason shown is often generic ("Saturation Skip") even when the yard is visibly dry.

**Our solution:** Every run is logged across three phases (DECIDE, COMMAND, VERIFY) so you can tell whether the system chose to water, whether the command was sent, and whether Rachio accepted it. The logs include the decision reason, selected zones, gallons, cost totals, success/failure state, and any command error message. You can query it with `node src/cli.js status --json` or browse the SQLite database directly.

The daily summary job gives you the overnight recap without needing to touch a terminal.

### "If my internet goes down, I lose all control"

**The Rachio problem:** No local decision path. All schedule creation, modification, and manual triggering still depend on reachable Rachio cloud services.

**Our solution:** The decision engine runs on your own hardware, and SQLite stores all state locally. Weather inputs have fallback behavior, and the status/MQTT/history surfaces remain available locally. You still need the Rachio cloud API to actuate the controller, but the scheduling logic, history, and tuning state are yours.

### "I don't know my precipitation rates and I'm not doing catch cup tests"

**The Rachio problem:** Flex Daily's accuracy depends heavily on correct precipitation rate calibration for each zone. Most users never do catch cup tests, so the model runs on default values from day one. This is the #1 setup barrier and the primary reason Flex Daily produces absurd schedules (20-hour runs, week-long gaps) for many users.

**Current state in this repo:** The database tables and suggestion logic for flow-based calibration are present, but end-to-end flow audit collection is not wired into the main run loop yet. In other words: this repo lays the groundwork for flow-assisted calibration, but you should treat that part as incomplete rather than production-ready.

## Key Features

**Shadow mode.** Before going live, the system runs in shadow mode - makes all decisions and logs them, but doesn't actually send commands to Rachio. Run for a week to validate decisions before activating.

**Decision-Command-Verify.** Every watering run is logged in three phases. The decision is recorded before any command is sent. If Rachio rejects the command or doesn't respond, state is not corrupted. The watchdog catches silent failures.

**Daily summary job.** A 6am systemd timer generates an HTML morning report with overnight activity, current soil moisture per zone, today's forecast, weather source status, month-to-date cost, and discrepancy warnings. If `N8N_WEBHOOK_URL` is configured, the report is posted to the `/summary` webhook for delivery.

**Status page.** A static HTML file regenerated after every run, written to `~/.smart-water/status.html` by default. It includes soil moisture bars, forecast cards, recent decisions, and cost tracking. You can serve that file however you want; no JavaScript framework is required.

<img src="docs/dashboard-preview.png" alt="Smart Water System Dashboard" width="400">

**YAML zone config.** Zone profiles live in a documented `zones.yaml` file instead of buried in source code. Comments explain what each field means and how to measure it. Edit your zone areas, sun exposure, and soil profiles without touching JavaScript.

**Home Assistant integration.** Publishes retained MQTT messages after every run: per-zone moisture percentages, weather data with source, daily/monthly cost, and last decision. HA auto-discovery creates sensor entities automatically. Uses your existing MQTT broker.

**Watchdog.** A separate systemd timer runs at 2am. If no healthy run outcome completed in the past 24 hours during growing season, it sends an alert via the notification webhook path.

## Current Limitations

- Rachio cloud access is still required to start watering runs.
- Notification delivery and summary delivery currently go through n8n-style webhooks; built-in SMTP delivery is not implemented.
- Flow-meter-assisted calibration is scaffolded but not fully wired into the main execution loop.
- ET correction factors can be stored and read, but automatic ET drift analysis is not complete yet.
- The test suite now covers core logic plus a few integration edges, but it is still not a substitute for a live smoke test against your own Rachio account, MQTT broker, and timers.

## Project Structure

```
src/
  cli.js              Entry point - run/water/status/cleanup commands
  config.js            Configuration with env var support
  weather.js           Weather coordinator with cross-validation and fallback
  watchdog.js          Missed-run alert checker
  summary.js           Daily HTML summary generator
  status-page.js       Static HTML status page generator
  notify.js            Notification dispatch (webhook delivery)
  mqtt.js              MQTT publisher for Home Assistant
  time.js              Local timezone helpers (America/Denver)
  log.js               Structured logger for systemd journal
  yaml-loader.js       YAML zone config loader
  core/
    et.js              Evapotranspiration calculations (Hargreaves variant)
    soil-moisture.js   Per-zone moisture balance tracking
    rule-engine.js     5-stage decision engine
    soak.js            Smart soak cycle builder
    finance.js         Tiered cost calculations
    tuning.js          Adaptive zone tuning and flow calibration
  api/
    rachio.js          Rachio API client (zones, profiles, commands, flow)
    ambient.js         Ambient Weather API client (current + live rain check)
    openmeteo.js       OpenMeteo API client (archive + forecast)
    http.js            Shared fetch with retry and timeout
  db/
    schema.sql         SQLite table definitions (12 tables)
    state.js           All database read/write operations
zones.yaml             Zone configuration (edit this for your yard)
tests/                 42 tests covering core logic and selected integration paths
deploy/
  smart-water.service  systemd oneshot service
  smart-water.timer    Hourly timer
  smart-water-watchdog.service/timer
  smart-water-summary.service/timer
  install.sh           Deployment script
  n8n-workflows/       n8n integration design
```

## Requirements

- Node.js 20+
- SQLite (via better-sqlite3)
- Rachio irrigation controller (any model with API access)
- Ambient Weather station (optional but recommended)
- systemd (for scheduling)
- n8n or another webhook receiver (optional, for notifications and summary delivery)
- MQTT broker (optional, for Home Assistant)

## Setup

```bash
# Clone and install
git clone https://github.com/jasonnickel/smart-watering-system.git ~/smart-water
cd ~/smart-water
npm install --production

# Configure
mkdir -p ~/.smart-water
cp .env.example ~/.smart-water/.env
chmod 600 ~/.smart-water/.env
# Edit ~/.smart-water/.env with your API keys
# Edit zones.yaml with your zone areas, sun exposure, and soil profiles

# Test in shadow mode
node src/cli.js run --shadow

# Check status
node src/cli.js status
node src/cli.js status --json   # machine-readable for n8n

# Install systemd timers
bash deploy/install.sh

# View logs
journalctl -u smart-water -f
```

## Commands

| Command | Description |
|---------|-------------|
| `node src/cli.js run` | Run the hourly decision cycle |
| `node src/cli.js run --shadow` | Shadow mode (log decisions, don't actuate) |
| `node src/cli.js water` | Manual watering (overrides forecast/budget, respects safety) |
| `node src/cli.js status` | Current moisture, usage, and last run |
| `node src/cli.js status --json` | Machine-readable status for n8n/scripts |
| `node src/cli.js cleanup` | Remove data older than 90 days |

## Configuration

- **Zone profiles:** Edit `zones.yaml` - documented YAML with comments explaining each field
- **System settings:** `src/config.js` - thresholds, rates, schedule windows, emergency triggers
- **Secrets:** `~/.smart-water/.env` - API keys, MQTT broker, notification webhook
- **See** `.env.example` for all available environment variables

## Community

- Questions and setup help: GitHub Discussions
- Bugs and feature requests: GitHub Issues
- Contribution guide: `CONTRIBUTING.md`
- Security reporting: `SECURITY.md`
- Project license: MIT (`LICENSE`)
