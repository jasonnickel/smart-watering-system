// taproot setup
// Interactive wizard that configures the system without editing files.
// Writes ~/.taproot/.env and zones.yaml.

import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { geocodeAddress } from './api/geocode.js';
import {
  getDefaultStartupService,
  getStartupServicePlatformLabel,
  installWebStartupService,
} from './startup-service.js';
import {
  TAPROOT_ENV_PATH,
  TAPROOT_HOME_DIR,
  ensureTaprootHomeMigration,
} from './paths.js';
import {
  DEFAULT_WEB_PORT,
  deriveBookmarkUrl,
  hostForDashboardAccess,
} from './web-runtime.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const APP_ROOT = join(import.meta.dirname, '..');
const ENV_DIR = TAPROOT_HOME_DIR;
const ENV_PATH = TAPROOT_ENV_PATH;
const DEFAULT_STARTUP_SERVICE = getDefaultStartupService();

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question, defaultValue) {
  const prompt = defaultValue
    ? `${question} ${DIM}[${defaultValue}]${RESET}: `
    : `${question}: `;
  return new Promise(resolve => {
    rl.question(prompt, answer => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function confirm(question, defaultYes = false) {
  return new Promise(resolve => {
    const suffix = defaultYes ? ' (Y/n): ' : ' (y/n): ';
    rl.question(`${question}${suffix}`, answer => {
      const normalized = answer.trim().toLowerCase();
      if (!normalized) {
        resolve(defaultYes);
        return;
      }
      resolve(normalized === 'y');
    });
  });
}

function askChoice(question, options, defaultValue) {
  const optionsText = options.map(option => `${option.key}=${option.label}`).join(', ');
  return ask(`${question} ${DIM}[${optionsText}]${RESET}`, defaultValue);
}

async function detectAvailablePort(startPort = DEFAULT_WEB_PORT) {
  for (let offset = 0; offset < 20; offset++) {
    const candidate = startPort + offset;
    const available = await new Promise(resolve => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => {
        server.close(() => resolve(true));
      });
    });

    if (available) {
      return candidate;
    }
  }

  return startPort;
}

export async function runSetup() {
  console.log(`\n${BOLD}Taproot - Setup Wizard${RESET}\n`);
  const migration = ensureTaprootHomeMigration();

  if (migration.legacyHomeDetected) {
    console.log(`${DIM}Legacy Smart Water data was detected and Taproot is using the migrated home directory when needed.${RESET}`);
  }

  if (existsSync(ENV_PATH)) {
    console.log(`${YELLOW}An existing configuration was found at ${ENV_PATH}${RESET}`);
    const proceed = await confirm('Overwrite it?');
    if (!proceed) {
      console.log('Setup cancelled.');
      rl.close();
      return;
    }
  }

  console.log(`This wizard will walk you through configuring the system.`);
  console.log(`You'll need your API keys ready. Press Enter to accept defaults.\n`);

  // --- Rachio ---
  console.log(`${BOLD}1. Rachio Controller${RESET}`);
  console.log(`${DIM}Find your API key at: https://rachio.com -> Account Settings -> Get API Key${RESET}`);
  const rachioKey = await ask('Rachio API key');
  if (!rachioKey) {
    console.log(`${YELLOW}Warning: Rachio API key is required for the system to work.${RESET}`);
  }

  // --- Ambient Weather ---
  console.log(`\n${BOLD}2. Ambient Weather Station${RESET} ${DIM}(optional but recommended)${RESET}`);
  console.log(`${DIM}Find your keys at: https://ambientweather.net -> My Account -> API Keys${RESET}`);
  const useAmbient = await confirm('Do you have an Ambient Weather station?');

  let ambientKey = '', ambientApp = '', ambientMac = '';
  if (useAmbient) {
    ambientKey = await ask('Ambient Weather API key');
    ambientApp = await ask('Ambient Weather Application key');
    ambientMac = await ask('Station MAC address');
  }

  // --- Notifications ---
  console.log(`\n${BOLD}3. Notifications${RESET}`);
  console.log(`${DIM}Notifications currently go through an optional webhook receiver such as n8n.${RESET}`);
  const webhookUrl = await ask('n8n webhook URL (or leave blank to skip)');
  const email = await ask('Notification email address (optional, for your webhook flow)');

  // --- Location ---
  console.log(`\n${BOLD}4. Location${RESET}`);
  console.log(`${DIM}Used for forecasts, soil lookups, timezone-aware scheduling, and dashboard maps.${RESET}`);
  let lat = '39.73220';
  let lon = '-105.21940';
  let timezone = 'America/Denver';
  let locationAddress = '';
  const useAddress = await confirm('Look up your location from an address or place?', true);
  if (useAddress) {
    const query = await ask('Address, place, or ZIP code', 'Golden, CO 80401');
    try {
      const match = await geocodeAddress(query);
      lat = String(match.latitude);
      lon = String(match.longitude);
      timezone = match.timezone;
      locationAddress = match.displayName;
      console.log(`${GREEN}OK${RESET}  Resolved ${locationAddress}`);
      console.log(`${DIM}${lat}, ${lon} - ${timezone}${RESET}`);
    } catch (err) {
      console.log(`${YELLOW}Address lookup failed:${RESET} ${err.message}`);
      lat = await ask('Latitude', '39.73220');
      lon = await ask('Longitude', '-105.21940');
      timezone = await ask('Timezone', 'America/Denver');
    }
  } else {
    lat = await ask('Latitude', '39.73220');
    lon = await ask('Longitude', '-105.21940');
    timezone = await ask('Timezone', 'America/Denver');
  }

  // --- Dashboard ---
  console.log(`\n${BOLD}5. Dashboard${RESET}`);
  const accessChoice = await askChoice('Who should be able to open the dashboard?', [
    { key: '1', label: 'Only this computer' },
    { key: '2', label: 'Other devices on my local network' },
    { key: '3', label: 'Use a custom bind address' },
  ], '1');
  const dashboardAccess = accessChoice === '2' ? 'network' : accessChoice === '3' ? 'custom' : 'local';
  let customHost = '';
  if (dashboardAccess === 'custom') {
    customHost = await ask('Custom bind address', '192.168.1.50');
  }
  const suggestedPort = await detectAvailablePort(DEFAULT_WEB_PORT);
  const webPort = await ask('Dashboard port', String(suggestedPort));
  const webHost = hostForDashboardAccess(dashboardAccess, customHost);
  const suggestedBookmarkUrl = deriveBookmarkUrl({ host: webHost, port: webPort });
  const publicBaseUrl = await ask('Bookmark URL', suggestedBookmarkUrl);

  let startupService = 'manual';
  const startupPlatform = getStartupServicePlatformLabel();
  if (DEFAULT_STARTUP_SERVICE !== 'manual') {
    const installService = await confirm(`Start the dashboard automatically on ${startupPlatform}?`, true);
    startupService = installService ? DEFAULT_STARTUP_SERVICE : 'manual';
  }

  // --- MQTT ---
  console.log(`\n${BOLD}6. Home Assistant Integration${RESET} ${DIM}(optional)${RESET}`);
  const useMqtt = await confirm('Connect to an MQTT broker for Home Assistant?');
  let mqttUrl = '';
  if (useMqtt) {
    mqttUrl = await ask('MQTT broker URL', 'mqtt://192.168.68.110:1883');
  }

  // --- Debug ---
  console.log(`\n${BOLD}7. Debug Level${RESET}`);
  const debugLevel = await ask('Debug level (0=errors, 1=info, 2=debug)', '1');

  // --- Write .env ---
  console.log(`\n${BOLD}Writing configuration...${RESET}`);

  if (!existsSync(ENV_DIR)) {
    mkdirSync(ENV_DIR, { recursive: true });
  }

  const envContent = [
    '# Taproot Configuration',
    `# Generated by setup wizard on ${new Date().toISOString()}`,
    '',
    '# Rachio',
    `RACHIO_API_KEY=${rachioKey}`,
    '',
    '# Ambient Weather',
    `AMBIENT_API_KEY=${ambientKey}`,
    `AMBIENT_APP_KEY=${ambientApp}`,
    `AMBIENT_MAC_ADDRESS=${ambientMac}`,
    '',
    '# Notifications',
    `NOTIFICATION_EMAIL=${email}`,
    webhookUrl ? `N8N_WEBHOOK_URL=${webhookUrl}` : '# N8N_WEBHOOK_URL=',
    '',
    '# MQTT',
    mqttUrl ? `MQTT_BROKER_URL=${mqttUrl}` : '# MQTT_BROKER_URL=',
    '',
    '# System',
    `DEBUG_LEVEL=${debugLevel}`,
    'SHADOW_MODE=true',
    `WEB_HOST=${webHost}`,
    `WEB_PORT=${webPort}`,
    `WEB_STARTUP_SERVICE=${startupService}`,
    `PUBLIC_BASE_URL=${publicBaseUrl}`,
    '',
    '# Location',
    locationAddress ? `LOCATION_ADDRESS=${locationAddress}` : '# LOCATION_ADDRESS=',
    `LAT=${lat}`,
    `LON=${lon}`,
    `LOCATION_TIMEZONE=${timezone}`,
  ].join('\n') + '\n';

  writeFileSync(ENV_PATH, envContent, { mode: 0o600 });
  console.log(`${GREEN}OK${RESET}  Wrote ${ENV_PATH}`);

  let serviceMessage = `Dashboard startup service: manual. Run ${BOLD}taproot web${RESET} when you want to use it.`;
  if (startupService !== 'manual') {
    try {
      const result = installWebStartupService(startupService, APP_ROOT);
      serviceMessage = `${result.detail} (${result.filePath})`;
      console.log(`${GREEN}OK${RESET}  ${serviceMessage}`);
    } catch (err) {
      serviceMessage = `Could not install ${startupService}: ${err.message}`;
      console.log(`${RED}FAIL${RESET}  ${serviceMessage}`);
    }
  }

  // --- Summary ---
  console.log(`\n${BOLD}Setup complete!${RESET}\n`);
  console.log(`${YELLOW}Shadow mode is ON by default.${RESET} The system will log decisions`);
  console.log(`but will NOT send commands to your Rachio controller.\n`);
  console.log(`Dashboard URL: ${BOLD}${publicBaseUrl}${RESET}`);
  console.log(`${serviceMessage}\n`);
  console.log(`Next steps:`);
  console.log(`  1. Run ${BOLD}taproot doctor${RESET} to verify connectivity`);
  console.log(`  2. Open ${BOLD}${publicBaseUrl}${RESET} in your browser`);
  console.log(`  3. Run ${BOLD}taproot run --shadow${RESET} to test a decision cycle`);
  console.log(`  4. Edit ${BOLD}zones.yaml${RESET} if your zone layout differs from defaults`);
  console.log(`  5. After a week of shadow runs, run ${BOLD}taproot go-live${RESET}`);
  console.log('');

  rl.close();
}
