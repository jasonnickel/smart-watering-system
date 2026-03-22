// smart-water doctor
// Checks all system components and prints green/yellow/red status.
// No stack traces, no jargon - just plain results.

import './env.js';
import CONFIG from './config.js';
import { log } from './log.js';
import { localDateStr } from './time.js';
import { initDB, getStatus, getRunsSince, getSystemState } from './db/state.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function ok(label, detail) { console.log(`  ${GREEN}OK${RESET}  ${label}${detail ? `  ${DIM}${detail}${RESET}` : ''}`); }
function warn(label, detail) { console.log(`  ${YELLOW}!!${RESET}  ${label}${detail ? `  ${DIM}${detail}${RESET}` : ''}`); }
function fail(label, detail) { console.log(`  ${RED}FAIL${RESET}  ${label}${detail ? `  ${DIM}${detail}${RESET}` : ''}`); }

let issues = 0;
let warnings = 0;

/**
 * Run all doctor checks and print results.
 */
export async function runDoctor() {
  console.log(`\n${BOLD}Smart Water System - Health Check${RESET}\n`);

  // 1. Configuration
  console.log(`${BOLD}Configuration${RESET}`);
  checkEnvFile();
  checkApiKeys();
  checkZonesConfig();
  console.log('');

  // 2. Connectivity
  console.log(`${BOLD}Connectivity${RESET}`);
  await checkRachio();
  await checkAmbientWeather();
  await checkOpenMeteo();
  console.log('');

  // 3. Database
  console.log(`${BOLD}Database${RESET}`);
  checkDatabase();
  console.log('');

  // 4. Operating Mode
  console.log(`${BOLD}Operating Mode${RESET}`);
  checkMode();
  console.log('');

  // 5. Recent Activity
  console.log(`${BOLD}Recent Activity${RESET}`);
  checkRecentRuns();
  console.log('');

  // Summary
  console.log(`${BOLD}Summary${RESET}`);
  if (issues === 0 && warnings === 0) {
    console.log(`  ${GREEN}All checks passed. System is healthy.${RESET}`);
  } else if (issues === 0) {
    console.log(`  ${YELLOW}${warnings} warning(s), no critical issues.${RESET}`);
  } else {
    console.log(`  ${RED}${issues} issue(s) need attention.${RESET}${warnings > 0 ? ` ${YELLOW}${warnings} warning(s).${RESET}` : ''}`);
  }
  console.log('');

  return issues;
}

function checkEnvFile() {
  const envPath = join(homedir(), '.smart-water', '.env');
  const projectEnv = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    ok('Environment file', envPath);
  } else if (existsSync(projectEnv)) {
    ok('Environment file', projectEnv);
  } else {
    fail('No .env file found', 'Run: smart-water setup');
    issues++;
  }
}

function checkApiKeys() {
  const rachio = CONFIG.api.rachio.apiKey;
  const ambientKey = CONFIG.api.ambientWeather.apiKey;
  const ambientApp = CONFIG.api.ambientWeather.appKey;
  const mac = CONFIG.api.ambientWeather.macAddress;

  if (rachio && rachio !== 'your-rachio-api-key') {
    ok('Rachio API key', 'configured');
  } else {
    fail('Rachio API key', 'missing or placeholder');
    issues++;
  }

  if (ambientKey && ambientKey !== 'your-ambient-api-key') {
    ok('Ambient Weather API key', 'configured');
  } else {
    warn('Ambient Weather API key', 'missing - will use OpenMeteo fallback');
    warnings++;
  }

  if (ambientApp && ambientApp !== 'your-ambient-app-key') {
    ok('Ambient Weather App key', 'configured');
  } else if (ambientKey && ambientKey !== 'your-ambient-api-key') {
    fail('Ambient Weather App key', 'missing but API key is set');
    issues++;
  }

  if (mac && mac !== 'your-mac-address') {
    ok('Ambient Weather MAC', 'configured');
  } else if (ambientKey && ambientKey !== 'your-ambient-api-key') {
    fail('Ambient Weather MAC', 'missing but API key is set');
    issues++;
  }
}

function checkZonesConfig() {
  const zonesPath = join(process.cwd(), 'zones.yaml');
  const homeZones = join(homedir(), '.smart-water', 'zones.yaml');
  if (existsSync(zonesPath)) {
    const zoneCount = Object.keys(CONFIG.watering.zoneProfiles).length;
    ok('Zone config', `${zoneCount} zones from zones.yaml`);
  } else if (existsSync(homeZones)) {
    ok('Zone config', 'from ~/.smart-water/zones.yaml');
  } else {
    ok('Zone config', 'using defaults from config.js');
  }
}

async function checkRachio() {
  try {
    const { fetchWithRetry } = await import('./api/http.js');
    const response = await fetchWithRetry(
      'https://api.rach.io/1/public/person/info',
      { headers: { 'Authorization': `Bearer ${CONFIG.api.rachio.apiKey}` } },
      'Rachio'
    );
    if (response?.id) {
      ok('Rachio API', 'connected');
    } else {
      fail('Rachio API', 'responded but no person ID returned');
      issues++;
    }
  } catch (err) {
    fail('Rachio API', err.message);
    issues++;
  }
}

async function checkAmbientWeather() {
  const { apiKey, appKey, macAddress } = CONFIG.api.ambientWeather;
  if (!apiKey || apiKey === 'your-ambient-api-key') {
    warn('Ambient Weather', 'not configured - skipping');
    return;
  }

  try {
    const { fetchWithRetry } = await import('./api/http.js');
    const url = `https://rt.ambientweather.net/v1/devices/${macAddress}?apiKey=${apiKey}&applicationKey=${appKey}&limit=1`;
    const data = await fetchWithRetry(url, {}, 'AmbientWeather');
    const reading = Array.isArray(data) ? data[0] : data;
    if (reading?.tempf != null) {
      ok('Ambient Weather', `${reading.tempf}F, ${reading.humidity}% humidity`);
    } else {
      warn('Ambient Weather', 'connected but no current reading');
      warnings++;
    }
  } catch (err) {
    fail('Ambient Weather', err.message);
    issues++;
  }
}

async function checkOpenMeteo() {
  try {
    const { fetchWithRetry } = await import('./api/http.js');
    const { lat, lon, timezone } = CONFIG.location;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=${timezone}&forecast_days=1`;
    const data = await fetchWithRetry(url, {}, 'OpenMeteo');
    if (data?.daily?.temperature_2m_max?.[0] != null) {
      ok('OpenMeteo', `forecast high ${data.daily.temperature_2m_max[0]}F`);
    } else {
      warn('OpenMeteo', 'connected but no forecast data');
      warnings++;
    }
  } catch (err) {
    fail('OpenMeteo', err.message);
    issues++;
  }
}

function checkDatabase() {
  try {
    initDB(DB_PATH);
    ok('Database', DB_PATH);

    const status = getStatus(localDateStr());
    ok('Soil moisture records', `${status.moisture.length} zones tracked`);

    if (status.finance) {
      ok('Finance data', `${status.finance.cumulative_gallons?.toFixed(0) || 0} gal this billing cycle`);
    }
  } catch (err) {
    fail('Database', err.message);
    issues++;
  }
}

function checkMode() {
  const shadow = CONFIG.system.shadowMode;
  const envShadow = process.env.SHADOW_MODE === 'true';

  if (shadow || envShadow) {
    warn('Shadow mode is ON', 'decisions are logged but Rachio will not be actuated');
    console.log(`       ${DIM}To go live: smart-water go-live${RESET}`);
  } else {
    ok('Live mode', 'Rachio will be actuated on WATER decisions');
  }

  // Check MQTT
  if (process.env.MQTT_BROKER_URL) {
    ok('MQTT', process.env.MQTT_BROKER_URL);
  } else {
    console.log(`  ${DIM}--${RESET}  MQTT  ${DIM}not configured (optional)${RESET}`);
  }

  // Check notifications
  if (process.env.N8N_WEBHOOK_URL) {
    ok('Notifications', 'via n8n webhook');
  } else {
    warn('Notifications', 'no N8N_WEBHOOK_URL - alerts will only appear in logs');
    warnings++;
  }
}

function checkRecentRuns() {
  try {
    const since = new Date(Date.now() - 86400000).toISOString();
    const runs = getRunsSince(since);

    if (runs.length === 0) {
      warn('No runs in the last 24 hours', 'system may not be scheduled yet');
      warnings++;
      return;
    }

    const decisions = runs.filter(r => r.phase === 'DECIDE');
    const waters = decisions.filter(r => r.decision === 'WATER');
    const skips = decisions.filter(r => r.decision === 'SKIP');
    const failures = runs.filter(r => r.phase === 'COMMAND' && r.success === 0);

    ok('Runs in last 24h', `${runs.length} total`);

    if (waters.length > 0) {
      ok('Watering decisions', `${waters.length} (last: ${waters[0].reason})`);
    }
    if (skips.length > 0) {
      ok('Skip decisions', `${skips.length} (last: ${skips[0].reason})`);
    }
    if (failures.length > 0) {
      fail('Command failures', `${failures.length} in last 24h`);
      issues++;
    }

    // Last successful run
    const lastVerify = runs.find(r => r.phase === 'VERIFY' && r.success === 1);
    if (lastVerify) {
      ok('Last successful watering', lastVerify.timestamp);
    }
  } catch (err) {
    warn('Could not check recent activity', err.message);
    warnings++;
  }
}
