# Taproot

Smart Irrigation System

Standalone controller that takes over scheduling for a Rachio sprinkler system. Uses your weather station, USDA soil survey, satellite vegetation imagery, reference ET cross-validation, multi-day forecasting, and AI-powered insights to make watering decisions that Rachio's cloud cannot.

Fully deterministic decision engine. AI layer is advisory only - it never changes watering decisions.

## Data Sources

Six external sources, cross-validated against each other, stored in SQLite for 2-year historical analysis:

| Source | Data | Auth | Frequency |
| ------ | ---- | ---- | --------- |
| **Ambient Weather** | Live temperature, humidity, wind, rain, solar radiation | API key | Every run |
| **OpenMeteo** | 7-day forecast + 2-year daily archive (temp, rain, solar, wind, FAO-56 reference ET) | None | Daily + backfill |
| **USDA Soil Data Access** | Soil type, available water capacity, pH, organic matter, infiltration rate | None | Once (cached) |
| **CoAgMet** | Reference evapotranspiration from nearest Colorado ag weather station | None | Daily + 2-year backfill |
| **Sentinel-2 Satellite** | 10-meter NDVI vegetation health imagery and statistics | Free Copernicus account | Every 5 days |
| **Rachio API** | Zone control, run verification, device status | API key | Every run |

## Architecture

```mermaid
flowchart TB
    subgraph DATA["Data Sources"]
        WX["Ambient Weather\nLive Station"]
        OM["OpenMeteo\nForecast + 2yr Archive"]
        USDA["USDA Soil Survey\nAWC, pH, Texture"]
        COAG["CoAgMet\nReference ET"]
        SAT["Sentinel-2\nNDVI Satellite"]
    end

    subgraph ENGINE["Decision Engine"]
        DECIDE{"5-Stage Pipeline\nSafety - Forecast\nMoisture - Budget\nScheduling"}
        RAIN{"Live Rain\nCheck"}
    end

    subgraph LEARN["Learning Loop"]
        TUNE["Adaptive Tuning\n14-day Analysis"]
        ETVAL["ET Cross-Validation\nvs CoAgMet Reference"]
        NDVI["NDVI Trend\nVegetation Health"]
    end

    WX --> DECIDE
    OM --> DECIDE
    USDA -.->|soil properties| DECIDE
    DB[("SQLite\n18 Tables\n2yr History")] --> DECIDE

    DECIDE -->|WATER| RAIN
    DECIDE -->|SKIP| LOG["Log\nSkip Reason"]

    RAIN -->|Clear| RACHIO["Rachio\nWater Zones"]
    RAIN -->|Raining| ABORT["Abort"]

    RACHIO --> VERIFY["Verify"] --> DB

    DECIDE --> TUNE --> DB
    COAG --> ETVAL --> DB
    SAT --> NDVI --> DB
    TUNE -.->|correction factors| DECIDE

    TIMER(["Hourly Timer"]) -.-> DECIDE
    AI["Kimi K2 Thinking\nChat + Briefing + Alerts"] -.-> DB

    style DECIDE fill:#e65100,stroke:#bf360c,color:#fff
    style RAIN fill:#1565c0,stroke:#0d47a1,color:#fff
    style RACHIO fill:#2e7d32,stroke:#1b5e20,color:#fff
    style VERIFY fill:#2e7d32,stroke:#1b5e20,color:#fff
    style LOG fill:#c62828,stroke:#b71c1c,color:#fff
    style ABORT fill:#c62828,stroke:#b71c1c,color:#fff
    style WX fill:#1565c0,stroke:#0d47a1,color:#fff
    style OM fill:#1565c0,stroke:#0d47a1,color:#fff
    style USDA fill:#00695c,stroke:#004d40,color:#fff
    style COAG fill:#00695c,stroke:#004d40,color:#fff
    style SAT fill:#00695c,stroke:#004d40,color:#fff
    style DB fill:#1565c0,stroke:#0d47a1,color:#fff
    style TUNE fill:#f57f17,stroke:#e65100,color:#fff
    style ETVAL fill:#f57f17,stroke:#e65100,color:#fff
    style NDVI fill:#f57f17,stroke:#e65100,color:#fff
    style TIMER fill:#6a1b9a,stroke:#4a148c,color:#fff
    style AI fill:#6a1b9a,stroke:#4a148c,color:#fff
```

## Decision Pipeline

Every hour, 5-stage pipeline:

1. **Safety** - Skip on high wind, recent rain, or sub-freezing temps
2. **Forecast** - Skip if forecast rainfall exceeds threshold
3. **Soil moisture** - Per-zone water deficit via ET modeling from archived, forecast, and live weather
4. **Budget** - Daily gallon and cost limits from your utility's tiered rates
5. **Scheduling** - Optimized run with soak cycles for clay soil infiltration

Post-decision integrations run automatically:

- **ET cross-validation** against CoAgMet reference measurements
- **NDVI refresh** from Sentinel-2 if last reading > 5 days old
- **Adaptive tuning** with 14-day rolling analysis and auto-correction

Final live rain check before any command is sent. Verify step confirms Rachio accepted.

## Comparison

| | Taproot | [HAsmartirrigation](https://github.com/jeroenterheerdt/HAsmartirrigation) | [homebridge-smart-irrigation](https://github.com/MTry/homebridge-smart-irrigation) | [OpenSprinkler Weather](https://github.com/OpenSprinkler/OpenSprinkler-Weather) |
| --- | :---: | :---: | :---: | :---: |
| **Standalone** | Yes | No (HA) | No (Homebridge) | No (OpenSprinkler HW) |
| **Rachio API control** | Yes | No | No | No |
| **Local weather station** | Yes | No | No | No |
| **Weather cross-validation** | Yes | No | No | No |
| **Real-time rain abort** | Yes | No | No | No |
| **AI insights** | Yes (Kimi K2) | No | No | No |
| **Natural language chat** | Yes | No | No | No |
| **Satellite vegetation health** | Yes (Sentinel-2) | No | No | No |
| **USDA soil integration** | Yes | No | No | No |
| **Reference ET validation** | Yes (CoAgMet) | No | No | No |
| **Adaptive zone tuning** | Yes | No | No | No |
| **ET method** | Hargreaves + CoAgMet | FAO-56 PyETo | Penman-Monteith | ETo % scaling |
| **Per-zone moisture budget** | Yes | Yes | No | No |
| **Smart soak cycles** | Yes | No | No | No |
| **Utility rate tracking** | Yes (YAML) | No | No | No |
| **2-year historical data** | Yes | No | No | No |
| **MQTT / Home Assistant** | Optional | Native | Native | No |

## Features

**Shadow mode.** Run for a week before going live. All decisions are logged without actuating Rachio.

**Decision-Command-Verify.** Three-phase logging per run. State is never corrupted by failed commands. Watchdog catches silent failures.

**Ask Your Yard.** Natural language chat powered by Kimi K2 Thinking. Answers grounded in live data, 2-year weather archive, reference ET, and satellite vegetation readings.

**Decision storytelling.** Explain button on each Run History row generates a cached plain-English narrative.

**Satellite vegetation health.** Sentinel-2 NDVI at 10m resolution. Monthly overlay view with sharp orthophoto base image. NDVI drops > 10% trigger advisor alerts.

**Reference ET cross-validation.** Daily comparison of Hargreaves ET vs CoAgMet ASCE Penman-Monteith. Persistent 15%+ deviation triggers advisor insight and auto-correction via adaptive tuning. 2-year backfill for trend analysis.

**USDA soil integration.** Surveyed soil properties from USDA Soil Data Access API - AWC, infiltration rate, pH, organic matter, profile depth. Flags mismatches against configured values.

**Weekly intelligence briefing.** Sunday morning report with 7/14/30/90-day, seasonal, and year-over-year trends. ET accuracy score, NDVI trends, advisor insights. Kimi K2 generates structured narrative with recommendations.

**Advisor insights.** Deterministic analysis combining all data sources: forecast confidence, rain gauge bias, ET model drift, soil config mismatches, NDVI vegetation trends, flow calibration alerts.

**Adaptive zone tuning.** 14-day rolling analysis of actual vs predicted watering frequency. Auto-applies ET correction factors (0.8x-1.2x bounds) after 3 consecutive same-direction suggestions. Cross-validated against CoAgMet reference ET.

**Configurable water rates.** Tiered rate schedule in `rates.yaml`. AWC-based tiers, monthly fixed charges, multi-tier volume pricing.

**Home Assistant.** MQTT auto-discovery for per-zone moisture, weather data, cost, and decision state.

**Security.** CSRF tokens, 64KB body limits, login rate limiting, CSP headers, path traversal protection, timing-safe password comparison.

## Limitations

- Rachio cloud access required for zone actuation
- Notifications via webhook (n8n); no built-in SMTP
- Sentinel-2 requires free Copernicus Data Space account
- CoAgMet is Colorado-specific; other states need alternative reference ET source
- 112 tests cover core logic but are not a substitute for hardware smoke testing

## Setup

```bash
git clone https://github.com/jasonnickel/smart-watering-system.git ~/taproot
cd ~/taproot
npm install --production

node src/cli.js setup      # Configure API keys and zones
node src/cli.js doctor     # Verify connectivity
node src/cli.js web        # Web UI at http://127.0.0.1:3000
node src/cli.js run --shadow  # Test in shadow mode

bash deploy/install.sh     # Install systemd timers
node src/cli.js go-live    # Switch to live mode after validation
```

### AI Features

```bash
echo 'AI_API_KEY=sk-your-key-here' >> ~/.taproot/.env
echo 'AI_API_BASE_URL=https://api.moonshot.ai/v1' >> ~/.taproot/.env
echo 'AI_MODEL=kimi-k2-thinking' >> ~/.taproot/.env
```

Enables chat, decision narratives, AI-enriched alerts, weekly briefing, and daily summary narratives. ~$0.30/year at typical usage.

### Satellite Imagery

```bash
echo 'COPERNICUS_EMAIL=your-email@example.com' >> ~/.taproot/.env
echo 'COPERNICUS_PASSWORD=your-password' >> ~/.taproot/.env
```

### Historical Backfill

```bash
node backfill.js  # 730 days of weather + reference ET + USDA soil survey (~30 seconds)
```

## API

**GET endpoints:**

| Endpoint | Description |
| -------- | ----------- |
| `/api/status` | Current system status |
| `/api/charts` | Moisture history |
| `/api/soil?lat=&lon=` | USDA soil survey |
| `/api/reference-et` | Yesterday's CoAgMet reference ET |
| `/api/ndvi` | NDVI vegetation statistics |
| `/api/ndvi/image?date=&mode=` | Satellite image PNG |
| `/api/history/weather?days=730` | Historical daily weather |
| `/api/history/reference-et?days=730` | Historical reference ET |
| `/api/history/ndvi?days=730` | Historical NDVI readings |
| `/api/history/et-validation?days=730` | ET model vs reference |
| `/api/ai/status` | AI features enabled |

**POST endpoints (CSRF-protected):**

| Endpoint | Description |
| -------- | ----------- |
| `/api/ai/chat` | Natural language query |
| `/api/ai/narrative` | Decision explanation |
| `/api/ai/briefing` | Weekly intelligence briefing |
| `/api/backfill/weather` | Backfill weather data |
| `/api/backfill/reference-et` | Backfill reference ET |

## CLI

```bash
node src/cli.js setup                           # Configure API keys and zones
node src/cli.js doctor                          # System health check
node src/cli.js go-live                         # Shadow to live mode
node src/cli.js shadow                          # Force shadow mode
node src/cli.js smoke-test --zone 1 --minutes 1 # Live commissioning test
node src/cli.js run                             # Hourly decision cycle
node src/cli.js run --shadow                    # Shadow mode run
node src/cli.js water                           # Manual watering
node src/cli.js status                          # Current state
node src/cli.js status --json                   # Machine-readable status
node src/cli.js web                             # Start web UI
node src/cli.js cleanup                         # Remove data > 90 days
```

## Configuration

| File | Purpose |
| ---- | ------- |
| `zones.yaml` | Zone profiles - type, sun exposure, area, priority, soil profile |
| `rates.yaml` | Utility rate schedule - tiers, fixed charges, AWC threshold |
| `~/.taproot/.env` | API keys, location, MQTT, notifications, AI config |
| `.env.example` | All available environment variables |

## Development

```bash
npm test       # 112 tests (Node.js built-in runner)
npm run lint   # ESLint flat config
npm run check  # Lint + tests
```

## Requirements

- Node.js 20+
- Rachio controller with API access
- Ambient Weather station (recommended)
- systemd for scheduling
- Optional: MQTT broker (Home Assistant), Kimi API key (~$0.30/yr), Copernicus account (satellite)

## Community

- Questions: GitHub Discussions
- Bugs: GitHub Issues
- Security: `SECURITY.md`
- License: MIT
