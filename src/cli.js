#!/usr/bin/env node

// Smart Water System CLI
// Entry point for all operations: scheduled runs, manual triggers, status checks
//
// Usage:
//   smart-water run [--shadow]    Run the hourly decision cycle
//   smart-water water             Manual watering trigger (all deficit zones)
//   smart-water status            Show current system status
//   smart-water status --json     Machine-readable status for n8n
//   smart-water cleanup           Remove old data beyond retention period

import './env.js';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import CONFIG from './config.js';
import { getEnvFilePath, writeEnvValue } from './env.js';
import { log } from './log.js';
import { localDateStr, localYesterdayStr, localHour, localMonth } from './time.js';
import {
  initDB, logRun, getSoilMoisture, bulkSetSoilMoisture,
  getFinanceData, updateFinance, getDailyUsage, updateDailyUsage,
  getFertilizerLog, getStatus, getStatusJSON, cleanupOldData,
  getSystemState, setSystemState, acquireRunLock, releaseRunLock,
} from './db/state.js';
import { resolveCurrentWeather, resolveYesterdayWeather, resolveForecast } from './weather.js';
import { getZones, buildProfiles, startMultiZoneRun } from './api/rachio.js';
import { getLiveRainCheck } from './api/ambient.js';
import { updateDailyBalances, inchesAdded, totalCapacity } from './core/soil-moisture.js';
import { getWateringDecision, getEmergencyCoolingDecision, currentWindow } from './core/rule-engine.js';
import { calculateCost, needsBillingReset } from './core/finance.js';
import { runDoctor } from './doctor.js';
import { runSetup } from './setup.js';
import { runGoLive } from './go-live.js';
import { generateStatusPage } from './status-page.js';
import { analyzeTuning } from './core/tuning.js';
import { getStatusJSON as getStatusJSONFromDB } from './db/state.js';
import { connectMQTT, publishState, publishHADiscovery, disconnectMQTT } from './mqtt.js';

const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');

// Track whether a command failure occurred for exit code
let commandFailed = false;

async function main() {
  const command = process.argv[2] || 'run';
  const flags = process.argv.slice(3);
  const shadow = flags.includes('--shadow') || CONFIG.system.shadowMode;

  initDB(DB_PATH);

  switch (command) {
    case 'run':
      await runScheduledCycle(shadow);
      break;
    case 'water':
      await runManualWatering(shadow);
      break;
    case 'status':
      if (flags.includes('--json')) {
        console.log(JSON.stringify(getStatusJSON(localDateStr()), null, 2));
      } else {
        printStatus();
      }
      break;
    case 'cleanup':
      cleanupOldData(90);
      break;
    case 'doctor':
      process.exit(await runDoctor());
      break;
    case 'web':
      await import('./web.js'); // web.js starts its own server
      return;
    case 'setup':
      await runSetup();
      return;
    case 'go-live':
      await runGoLive();
      return;
    case 'shadow':
      enableShadowMode();
      return;
    case 'smoke-test':
      await runSmokeTest(flags);
      break;
    default:
      console.log('');
      console.log('  Smart Water System');
      console.log('');
      console.log('  Usage: smart-water <command> [options]');
      console.log('');
      console.log('  Getting started:');
      console.log('    setup          Configure API keys and zones interactively');
      console.log('    doctor         Check system health and connectivity');
      console.log('    go-live        Switch from shadow mode to live mode');
      console.log('    shadow         Force the system back into shadow mode');
      console.log('    smoke-test     Run one short live commissioning test on a single zone');
      console.log('');
      console.log('  Daily operations:');
      console.log('    run [--shadow] Run the hourly decision cycle');
      console.log('    water          Manual watering trigger');
      console.log('    status [--json] Show current system status');
      console.log('    web            Start the browser-based UI (127.0.0.1:3000)');
      console.log('    cleanup        Remove data older than 90 days');
      console.log('');
      process.exit(command === 'help' || command === '--help' ? 0 : 1);
  }

  // [FIX P1] Exit nonzero when command/verify failed so watchdog catches it
  if (commandFailed) {
    process.exit(2);
  }
}

function enableShadowMode() {
  const envPath = getEnvFilePath();
  writeEnvValue('SHADOW_MODE', 'true');
  console.log(`Shadow mode enabled. Updated ${envPath}`);
}

function getFlagValue(flags, name) {
  const index = flags.indexOf(name);
  if (index === -1 || index === flags.length - 1) {
    return '';
  }
  return flags[index + 1];
}

async function confirmAction(question) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} (y/n): `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

async function runSmokeTest(flags) {
  if (CONFIG.system.shadowMode) {
    console.log('Smoke test requires live mode. Run smart-water go-live first, then re-run this command.');
    return;
  }

  const zoneNumber = parseInt(getFlagValue(flags, '--zone'), 10);
  const minutes = parseInt(getFlagValue(flags, '--minutes') || '1', 10);
  const skipPrompt = flags.includes('--yes');

  if (!Number.isFinite(zoneNumber) || zoneNumber <= 0) {
    console.log('Usage: smart-water smoke-test --zone <number> [--minutes 1-3] [--yes]');
    process.exit(1);
  }
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 3) {
    console.log('Smoke test duration must be between 1 and 3 minutes.');
    process.exit(1);
  }

  if (!skipPrompt) {
    const confirmed = await confirmAction(`Start a live smoke test on zone ${zoneNumber} for ${minutes} minute(s)? This will actuate your Rachio controller.`);
    if (!confirmed) {
      console.log('Smoke test cancelled.');
      return;
    }
  }

  if (!acquireRunLock()) {
    log(1, 'Another run is in progress, exiting');
    return;
  }

  try {
    const enabledZones = (await getZones()).filter(zone => zone.enabled !== false);
    const profiles = buildProfiles(enabledZones);
    const profile = profiles.find(item => item.zoneNumber === zoneNumber);

    if (!profile) {
      console.log(`Zone ${zoneNumber} is not configured or is not enabled on Rachio.`);
      process.exit(1);
    }

    const finance = getFinanceData();
    const gallons = profile.gallonsPerMinute * minutes;
    const cost = calculateCost(gallons, finance.cumulative_gallons);

    const plan = {
      decision: 'WATER',
      reason: `Live smoke test - Zone ${zoneNumber} (${profile.name}) for ${minutes} minute(s)`,
      zones: [{ id: profile.id, name: profile.name, duration: minutes, priority: profile.priority }],
      originalZones: [{ id: profile.id, name: profile.name, duration: minutes, gallons, priority: profile.priority, profile }],
      gallons,
      cost,
    };

    log(1, `Starting smoke test for zone ${zoneNumber} (${profile.name}) for ${minutes} minute(s)`);
    await executePlan(plan, 'smoke-test', false);
  } finally {
    releaseRunLock();
  }
}

/**
 * Main scheduled cycle - called hourly by systemd timer.
 * Determines the current window and runs the appropriate decision flow.
 */
async function runScheduledCycle(shadow) {
  // [FIX P1] Acquire run lock to prevent overlap with manual triggers
  if (!acquireRunLock()) {
    log(1, 'Another run is in progress, exiting');
    return;
  }

  try {
    const now = new Date();
    const hour = localHour(now);
    const month = localMonth(now);

    const window = currentWindow(hour, month);
    log(1, `Scheduled run: hour=${hour}, month=${month}, window=${window}, shadow=${shadow}`);

    if (window === 'none') {
      log(1, 'Not in a watering window, exiting');
      return;
    }

    const ctx = await buildContext();

    // [FIX P0] Run daily soil moisture update with date guard
    runSoilUpdate(ctx, now);

    if (window === 'daily') {
      await executePlan(getWateringDecision(ctx), 'daily', shadow);
      // [4.2] Run adaptive tuning analysis after daily watering
      analyzeTuning(ctx.profiles);
    } else if (window === 'emergency') {
      await executePlan(getEmergencyCoolingDecision(ctx), 'emergency', shadow);
    }

    // [2.3] Regenerate status page after every run
    generateStatusPage();

    // [5.1] Publish to MQTT if configured
    await publishToMQTT(ctx);
  } finally {
    releaseRunLock();
  }
}

/**
 * Manual watering - forces watering for all zones with a deficit.
 * [FIX P2] Overrides forecast, budget, and fertilizer skips. Only safety stops it.
 */
async function runManualWatering(shadow) {
  // [FIX P1] Acquire run lock
  if (!acquireRunLock()) {
    log(1, 'Another run is in progress, exiting');
    return;
  }

  try {
    log(1, 'Manual watering trigger');
    const ctx = await buildContext();

    const plan = getWateringDecision(ctx);

    if (plan.decision === 'SKIP') {
      // [FIX P2] Only honor safety skips for manual triggers
      if (plan.reason.startsWith('Current Conditions')) {
        log(0, 'Safety conditions prevent watering even in manual mode');
        logRun({ window: 'manual', phase: 'DECIDE', decision: 'SKIP', reason: plan.reason, success: true, shadow });
        return;
      }

      // Override non-safety skips: re-run decision with relaxed context
      log(1, `Overriding skip reason for manual trigger: ${plan.reason}`);
      const relaxedCtx = {
        ...ctx,
        // Remove forecast to bypass forecast skip
        forecast: null,
        // Remove budget limits
        dailyUsage: { gallons: 0, cost: 0 },
        // Remove fertilizer guards
        fertilizerLog: {},
      };
      const overridePlan = getWateringDecision(relaxedCtx);

      if (overridePlan.decision === 'WATER') {
        await executePlan(overridePlan, 'manual', shadow);
        return;
      }
    }

    if (plan.decision === 'WATER') {
      await executePlan(plan, 'manual', shadow);
    } else {
      log(1, 'No zones need water');
      logRun({ window: 'manual', phase: 'DECIDE', decision: 'SKIP', reason: plan.reason, success: true, shadow });
    }
  } finally {
    releaseRunLock();
  }
}

/**
 * Three-phase execution: DECIDE -> COMMAND -> VERIFY
 */
async function executePlan(plan, window, shadow) {
  // Phase 1: DECIDE
  logRun({
    window,
    phase: 'DECIDE',
    decision: plan.decision,
    reason: plan.reason,
    zones: plan.originalZones?.map(z => ({ name: z.name, duration: z.duration, gallons: z.gallons })),
    gallons: plan.gallons,
    cost: plan.cost,
    success: true,
    shadow,
  });

  if (plan.decision !== 'WATER') {
    log(1, `Decision: SKIP - ${plan.reason}`);
    return;
  }

  log(1, `Decision: WATER - ${plan.reason} (${plan.originalZones.length} zones, ${plan.gallons?.toFixed(0)} gal, $${plan.cost?.toFixed(2)})`);

  // [1.1] Real-time rain check before sending command
  const rainCheck = await getLiveRainCheck();
  if (rainCheck) {
    const rainThreshold = CONFIG.schedule.skipConditions.rainInches;
    if (rainCheck.hourlyRain > 0.02 || rainCheck.dailyRain > rainThreshold) {
      const reason = `Aborted - Active Rain Detected (hourly: ${rainCheck.hourlyRain.toFixed(2)}", daily: ${rainCheck.dailyRain.toFixed(2)}")`;
      log(1, reason);
      logRun({ window, phase: 'COMMAND', decision: 'SKIP', reason, success: true, shadow });
      return;
    }
    log(2, `Rain check passed: hourly=${rainCheck.hourlyRain}", daily=${rainCheck.dailyRain}"`);
  }

  // Phase 2: COMMAND
  if (shadow) {
    log(1, 'SHADOW MODE: Skipping Rachio command');
    logRun({ window, phase: 'COMMAND', decision: 'WATER', reason: 'Shadow mode - not sent', success: true, shadow: true });
    logRun({ window, phase: 'VERIFY', decision: 'WATER', reason: 'Shadow mode - not verified', success: true, shadow: true });
    return;
  }

  let commandSuccess = false;
  try {
    commandSuccess = await startMultiZoneRun(plan.zones);
    logRun({ window, phase: 'COMMAND', decision: 'WATER', reason: plan.reason, zones: plan.zones?.map(z => ({ id: z.id, name: z.name, duration: z.duration })), success: commandSuccess });
  } catch (err) {
    log(0, `COMMAND failed: ${err.message}`);
    logRun({ window, phase: 'COMMAND', decision: 'WATER', reason: plan.reason, success: false, error: err.message });
    // [FIX P1] Mark command failure for nonzero exit
    commandFailed = true;
    return;
  }

  if (!commandSuccess) {
    log(0, 'Rachio did not accept the watering command');
    // [FIX P1] Mark command failure for nonzero exit
    commandFailed = true;
    return;
  }

  // Phase 3: VERIFY (Rachio accepted the command)
  log(1, 'Rachio accepted watering command');
  logRun({ window, phase: 'VERIFY', decision: 'WATER', reason: plan.reason, gallons: plan.gallons, cost: plan.cost, success: true });

  // [FIX P1] Persist cooling time for emergency runs
  if (window === 'emergency') {
    setSystemState('last_cooling_time', new Date().toISOString());
  }

  // Update state after verified execution
  updateStateAfterRun(plan);
}

/**
 * Build the execution context from all data sources.
 */
async function buildContext() {
  const [weatherResult, zones, forecast] = await Promise.all([
    resolveCurrentWeather(),
    getZones(),
    resolveForecast(),
  ]);

  // [FIX] Filter out disabled Rachio zones
  const enabledZones = zones.filter(z => z.enabled !== false);
  const profiles = buildProfiles(enabledZones);

  const now = new Date();
  // [FIX P1] Use local timezone for all date accounting
  const todayStr = localDateStr(now);
  const yesterdayStr = localYesterdayStr(now);
  const yesterdayWeather = await resolveYesterdayWeather(yesterdayStr);

  const soilMoisture = getSoilMoisture();
  const financeData = getFinanceData();
  const dailyUsage = getDailyUsage(todayStr);
  const fertilizerLog = getFertilizerLog();

  // Check for billing cycle reset
  if (needsBillingReset(financeData.last_reset, now)) {
    log(1, 'Resetting billing cycle');
    updateFinance({ cumulative_gallons: 0, monthly_gallons: 0, monthly_cost: 0, last_reset: now.toISOString() });
  }

  if (weatherResult.stale) {
    log(1, `Weather source: ${weatherResult.source} (DEGRADED MODE)`);
  }

  // [FIX P1] Read last cooling time from persistent state
  const lastCoolingTime = getSystemState('last_cooling_time');

  // [FIX] Re-read finance after potential reset
  const currentFinance = getFinanceData();

  return {
    weather: weatherResult.data,
    weatherSource: weatherResult.source,
    forecast,
    yesterdayWeather,
    profiles,
    soilMoisture,
    financeData: {
      cumulativeGallons: currentFinance.cumulative_gallons,
    },
    dailyUsage: {
      gallons: dailyUsage.gallons,
      cost: dailyUsage.cost,
    },
    fertilizerLog,
    lastCoolingTime,
  };
}

/**
 * Run daily soil moisture update.
 * [FIX P0] Guarded by local date - only runs once per calendar day.
 */
function runSoilUpdate(ctx, now) {
  const todayStr = localDateStr(now);
  const lastUpdate = getSystemState('soil_last_updated');

  if (lastUpdate === todayStr) {
    log(2, 'Soil moisture already updated today, skipping');
    return;
  }

  const month = localMonth(now);

  const updatedBalances = updateDailyBalances(
    ctx.soilMoisture,
    ctx.yesterdayWeather,
    ctx.profiles,
    month
  );

  bulkSetSoilMoisture(updatedBalances, ctx.profiles);
  setSystemState('soil_last_updated', todayStr);

  // Update context in place for the decision engine
  ctx.soilMoisture = updatedBalances;

  log(1, 'Soil moisture balances updated');
}

/**
 * Update all state after a verified watering run.
 */
function updateStateAfterRun(plan) {
  // [FIX P1] Use local date for daily usage tracking
  const todayStr = localDateStr();

  // Update soil moisture
  const currentBalances = getSoilMoisture();
  for (const zone of plan.originalZones) {
    const added = inchesAdded(zone.duration, zone.profile);
    const capacity = totalCapacity(zone.profile);
    const current = currentBalances[zone.id] ?? 0;
    currentBalances[zone.id] = Math.min(capacity, current + added);
  }
  bulkSetSoilMoisture(currentBalances, plan.originalZones.map(z => z.profile));

  // Update daily usage
  const zonesMap = {};
  for (const z of plan.originalZones) {
    zonesMap[z.id] = z.duration;
  }
  updateDailyUsage(todayStr, plan.gallons, plan.cost, JSON.stringify(zonesMap));

  // Update finance
  const finance = getFinanceData();
  updateFinance({
    cumulative_gallons: finance.cumulative_gallons + plan.gallons,
    monthly_gallons: finance.monthly_gallons + plan.gallons,
    monthly_cost: finance.monthly_cost + plan.cost,
    last_reset: finance.last_reset,
  });

  log(1, `State updated: +${plan.gallons.toFixed(0)} gal, +$${plan.cost.toFixed(2)}`);
}

/**
 * Print current system status.
 */
function printStatus() {
  const todayStr = localDateStr();
  const status = getStatus(todayStr);

  console.log('\n=== Smart Water System Status ===\n');

  if (status.lastRun) {
    console.log(`Last run: ${status.lastRun.timestamp} [${status.lastRun.window}] ${status.lastRun.decision} - ${status.lastRun.reason}`);
  } else {
    console.log('No runs recorded yet');
  }

  console.log('\nSoil Moisture:');
  for (const zone of status.moisture) {
    const pct = zone.total_capacity > 0
      ? ((zone.balance_inches / zone.total_capacity) * 100).toFixed(0)
      : '?';
    console.log(`  Zone ${zone.zone_number} (${zone.zone_name}): ${pct}% (${zone.balance_inches.toFixed(2)}/${zone.total_capacity.toFixed(2)} in)`);
  }

  console.log(`\nToday's usage: ${status.todayUsage.gallons.toFixed(0)} gal, $${status.todayUsage.cost.toFixed(2)}`);

  if (status.finance) {
    console.log(`Monthly: ${status.finance.monthly_gallons.toFixed(0)} gal, $${status.finance.monthly_cost.toFixed(2)}`);
    console.log(`Billing cycle: ${status.finance.cumulative_gallons.toFixed(0)} gal cumulative`);
  }

  console.log('');
}

/**
 * [5.1] Publish system state to MQTT for Home Assistant.
 */
async function publishToMQTT(ctx) {
  if (!process.env.MQTT_BROKER_URL) return;

  const connected = await connectMQTT();
  if (!connected) return;

  try {
    const todayStr = localDateStr();
    const status = getStatusJSONFromDB(todayStr);

    publishState({
      status,
      weather: ctx.weather,
      weatherSource: ctx.weatherSource,
      lastDecision: status.lastRun,
    });

    // Publish HA discovery on first run only
    const discoveryPublished = getSystemState('mqtt_discovery_published');
    if (!discoveryPublished && status.moisture.length > 0) {
      publishHADiscovery(status.moisture);
      setSystemState('mqtt_discovery_published', 'true');
    }
  } finally {
    await disconnectMQTT();
  }
}

main().catch(err => {
  log(0, `Fatal error: ${err.message}\n${err.stack}`);
  process.exit(1);
});
