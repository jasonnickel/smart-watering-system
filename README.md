# Smart Water System

Standalone irrigation controller that takes over scheduling for a Rachio sprinkler system using your own weather station data, ET-based soil moisture modeling, and multi-day forecasting. Gives you full control over the decision logic that Rachio keeps behind its app.

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
    PHONE(["Water Now\nn8n webhook"]) -.-> DECIDE

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

1. **Safety** - Skip if wind is too high, it rained recently, or temps are below freezing
2. **Forecast** - Skip if significant rain is predicted in the next 24 hours
3. **Soil moisture** - Calculate per-zone water deficit using evapotranspiration (ET) modeling with data from your personal weather station
4. **Budget** - Enforce daily gallon and cost limits based on your tiered water rates
5. **Scheduling** - Build an optimized run with smart soak cycles for clay soil infiltration

If watering is needed, a final real-time rain check confirms it's not actively raining right now. Then the system sends the command to Rachio, verifies it was accepted, and updates all state. If not, it logs the skip reason and moves on.

## Rachio's Problems, Our Solutions

Rachio 3 includes solid smart watering at no recurring cost. Flex Daily, Weather Intelligence, Cycle and Soak, and PWS support are all free. But the community has documented persistent, reproducible failures across every major feature. This system was designed to address each one specifically.

### "It watered during a thunderstorm"

**The Rachio problem:** Weather Intelligence evaluates conditions 12 hours and 1 hour before a scheduled run. Rain that starts within that final window does not trigger a skip. Users on the Rachio community forum document watering during active heavy rainfall with 0.25"+ already accumulated. One user with a Tempest weather station confirmed that 0.25" of rain at a rate well above the skip threshold simply didn't register because it fell inside the timing blind spot.

**Our solution:** A live rain check hits your Ambient Weather station between the DECIDE and COMMAND phases of every run. If any measurable rainfall is detected (hourly rain > 0.02" or daily accumulation exceeds the skip threshold), the run is aborted and logged as "Active Rain Detected." This check uses a fresh, uncached API call - not data from minutes or hours ago. The system will never send water to your yard while it's already raining.

### "Weather Intelligence said 0.14 inches when my gauge read 0.35"

**The Rachio problem:** Rachio 3 routes weather data through Aeris Weather, which aggregates from CWOP, PWSWeather, and Weather Underground networks. Users report significant precipitation discrepancies between what their personal station measures and what Rachio records. There's no way to see the discrepancy or know which data source Rachio actually used. One user documented Rachio showing 0.14" for a day when local flood control confirmed 0.35".

**Our solution:** Every day, the system cross-validates precipitation readings between your Ambient Weather station and OpenMeteo's archive data. Discrepancies exceeding 0.15" are logged to a `weather_discrepancy` table with both values and what was used. The daily summary email flags persistent bias - if one source consistently reads higher or lower over 7 days, it alerts you to check your rain gauge for debris or calibration drift. You can query exactly what data drove every decision.

### "My station went offline and Rachio never told me"

**The Rachio problem:** When a nearby personal weather station goes offline, Rachio silently falls back to more distant stations or interpolated grid data. There is no notification. Users discover weeks later that their "hyperlocal" 36-foot-resolution data was actually coming from a station miles away with different microclimate conditions. The system continues making decisions on degraded data without any indication.

**Our solution:** Escalating alerts fire the moment your Ambient Weather station stops responding: informational at 4 hours, warning at 12 hours, critical at 24 hours. Each alert includes what fallback source is being used (OpenMeteo forecast vs conservative defaults). The system never silently degrades. The daily summary email always shows the current weather data source and its freshness. If all sources go down during growing season, the system uses conservative defaults (85F, 30% humidity, no rain) and waters anyway rather than skipping.

### "Flex Daily went 8 days without watering in 100-degree heat"

**The Rachio problem:** Flex Daily's ET model uses fixed parameters that don't account for extreme conditions well. Users in Phoenix and other high-heat climates document multi-day watering gaps during 100F+ temperatures. The model is also highly sensitive to precipitation rate calibration - without catch cup testing, users report 20-hour schedules or severe over/under-watering. Many users give up and revert to fixed schedules.

**Our solution:** Three layers of protection:
- **Emergency cooling** with dynamic temperature triggers that adjust based on solar radiation, humidity, and wind - not just air temperature. When conditions are genuinely dangerous for turf, the system waters regardless of what the daily schedule decided.
- **Degraded-mode policy** that never skips watering in summer because a data source is unavailable. If your weather station and forecast APIs both go down during a heat wave, conservative defaults ensure watering continues.
- **Adaptive zone tuning** that tracks whether predicted soil moisture matches reality over time. If a zone consistently hits its trigger point faster than the model predicts, the system suggests ET correction factors. Over weeks, the model self-corrects rather than drifting.

### "Cycle and Soak activated on some zones but not others"

**The Rachio problem:** Users report Smart Cycle inconsistently activating across zones in the same schedule. Some zones get split into cycles with soak intervals, others don't, with no clear explanation in the app. One user had an 8-minute zone silently extended to 46 minutes.

**Our solution:** Smart soak is deterministic and transparent. Any lawn zone exceeding the configurable soak threshold (default: 20 minutes) gets split into two equal passes. The full schedule with all soak splits is logged in the decision record. You can see exactly which zones got split, what the half-times are, and why. No surprises.

### "I have no idea why it did that"

**The Rachio problem:** The app shows what happened (watered zone 3 for 25 minutes) but not why. Users can't determine whether a run was triggered by ET deficit, proactive forecast logic, or schedule. When the system skips, the reason shown is often generic ("Saturation Skip") even when the yard is visibly dry.

**Our solution:** Every decision is logged across three phases (DECIDE, COMMAND, VERIFY) with full context:
- Which zones needed water and how much deficit each had in inches
- What temperature and weather data was used (and from which source)
- Why other zones were skipped (full soil, fertilizer guard, budget limit)
- Whether the forecast influenced the decision and what it predicted
- The exact cost calculation including billing tier position

Query it with `node src/cli.js status --json` or browse the SQLite database directly. The daily summary email gives you the overnight recap without needing to touch a terminal.

### "If my internet goes down, I lose all control"

**The Rachio problem:** No local control path. All schedule creation, modification, and manual triggering requires an active internet connection and reachable Rachio cloud servers. Rain Bird acquired Rachio in October 2025, and the community has drawn direct comparisons to Google's Nest acquisition where features and integrations were progressively deprecated.

**Our solution:** The decision engine runs entirely on your own hardware. SQLite stores all state locally. The only cloud dependencies are the weather APIs (with multi-level fallbacks including fully offline conservative defaults) and the Rachio API (for sending commands to the physical controller). If Rain Bird deprecates the Rachio cloud, your decision engine, all historical data, and every tuning parameter remain intact on your server. MQTT integration publishes state to your local Home Assistant instance, giving you dashboards and automations that work without any cloud service.

### "I don't know my precipitation rates and I'm not doing catch cup tests"

**The Rachio problem:** Flex Daily's accuracy depends heavily on correct precipitation rate calibration for each zone. Most users never do catch cup tests, so the model runs on default values from day one. This is the #1 setup barrier and the primary reason Flex Daily produces absurd schedules (20-hour runs, week-long gaps) for many users.

**Our solution:** If you install an EveryDrop flow meter (or any flow meter that reports through Rachio's API), the system compares expected gallons (from your configured precipitation rate and zone area) against actual gallons measured by the meter after every run. When deviation exceeds 15% over 5+ runs, it surfaces a calibration suggestion in the daily summary. Over 20+ runs, it can auto-adjust within safe bounds (80%-120% of configured values). The system gets more accurate over time instead of running on wrong assumptions forever.

## Key Features

**Shadow mode.** Before going live, the system runs in shadow mode - makes all decisions and logs them, but doesn't actually send commands to Rachio. Run for a week to validate decisions before activating.

**Decision-Command-Verify.** Every watering run is logged in three phases. The decision is recorded before any command is sent. If Rachio rejects the command or doesn't respond, state is not corrupted. The watchdog catches silent failures.

**Daily summary email.** Morning report at 6am with overnight activity (what ran and why), current soil moisture per zone with color-coded bars, today's forecast, whether emergency cooling is likely, weather source status, month-to-date cost, and any sensor discrepancy warnings.

**Status page.** A static HTML page regenerated after every run with mobile-friendly layout. Soil moisture bars, forecast cards, recent decisions, and cost tracking. Served via n8n webhook or any file server - no JavaScript framework needed.

<img src="docs/dashboard-preview.png" alt="Smart Water System Dashboard" width="400">

**YAML zone config.** Zone profiles live in a documented `zones.yaml` file instead of buried in source code. Comments explain what each field means and how to measure it. Edit your zone areas, sun exposure, and soil profiles without touching JavaScript.

**Home Assistant integration.** Publishes retained MQTT messages after every run: per-zone moisture percentages, weather data with source, daily/monthly cost, and last decision. HA auto-discovery creates sensor entities automatically. Uses your existing MQTT broker.

**Watchdog.** A separate systemd timer runs at 2am. If no successful run completed in the past 24 hours during growing season, it sends an alert via n8n webhook. Catches systemd failures, script crashes, and Rachio API outages.

**Dormant fallback.** A basic fixed schedule stays configured in the Rachio app on standby. If the homelab goes down entirely, manually activating this schedule provides emergency coverage.

## Project Structure

```
src/
  cli.js              Entry point - run/water/status/cleanup commands
  config.js            Configuration with env var support
  weather.js           Weather coordinator with cross-validation and fallback
  watchdog.js          Missed-run alert checker
  summary.js           Daily email report generator
  status-page.js       Static HTML status page generator
  notify.js            Notification dispatch (n8n webhook)
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
    schema.sql         SQLite table definitions (11 tables)
    state.js           All database read/write operations
zones.yaml             Zone configuration (edit this for your yard)
tests/                 34 tests covering core logic
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
- n8n (optional, for notifications and manual triggers)
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
