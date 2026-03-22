#!/usr/bin/env node

// Smart Water System CLI
// Entry point for all operations: scheduled runs, manual triggers, status checks
//
// Usage:
//   smart-water run [--shadow]    Run the hourly decision cycle
//   smart-water water             Manual watering trigger (all deficit zones)
//   smart-water status            Show current system status
//   smart-water cleanup           Remove old data beyond retention period

import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

// Load .env from project dir or ~/.smart-water/
const projectEnv = join(import.meta.dirname, '..', '.env');
const homeEnv = join(homedir(), '.smart-water', '.env');
loadEnv({ path: existsSync(projectEnv) ? projectEnv : homeEnv });

import CONFIG from './config.js';
import { log } from './log.js';
import { initDB, logRun, getSoilMoisture, bulkSetSoilMoisture, getFinanceData, updateFinance, getDailyUsage, updateDailyUsage, getFertilizerLog, getStatus, cleanupOldData } from './db/state.js';
import { resolveCurrentWeather, resolveYesterdayWeather, resolveForecast } from './weather.js';
import { getZones, buildProfiles, startMultiZoneRun } from './api/rachio.js';
import { updateDailyBalances, inchesAdded, totalCapacity } from './core/soil-moisture.js';
import { getWateringDecision, getEmergencyCoolingDecision, currentWindow } from './core/rule-engine.js';
import { calculateCost, needsBillingReset } from './core/finance.js';

const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');

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
      printStatus();
      break;
    case 'cleanup':
      cleanupOldData(90);
      break;
    default:
      console.log('Usage: smart-water [run|water|status|cleanup] [--shadow]');
      process.exit(1);
  }
}

/**
 * Main scheduled cycle - called hourly by systemd timer.
 * Determines the current window and runs the appropriate decision flow.
 */
async function runScheduledCycle(shadow) {
  const now = new Date();
  const hour = parseInt(now.toLocaleString('en-US', { timeZone: CONFIG.location.timezone, hour: 'numeric', hour12: false }), 10);
  const month = parseInt(now.toLocaleString('en-US', { timeZone: CONFIG.location.timezone, month: 'numeric' }), 10);

  const window = currentWindow(hour, month);
  log(1, `Scheduled run: hour=${hour}, month=${month}, window=${window}, shadow=${shadow}`);

  if (window === 'none') {
    log(1, 'Not in a watering window, exiting');
    return;
  }

  const ctx = await buildContext();

  // Run daily soil moisture update (idempotent - checks date internally)
  await runSoilUpdate(ctx, now);

  if (window === 'daily') {
    await executePlan(getWateringDecision(ctx), 'daily', shadow);
  } else if (window === 'emergency') {
    await executePlan(getEmergencyCoolingDecision(ctx), 'emergency', shadow);
  }
}

/**
 * Manual watering - runs all zones with a deficit regardless of schedule window.
 */
async function runManualWatering(shadow) {
  log(1, 'Manual watering trigger');
  const ctx = await buildContext();

  // Force a watering decision ignoring schedule windows
  const plan = getWateringDecision(ctx);
  if (plan.decision === 'SKIP') {
    log(1, `Manual run would skip: ${plan.reason}`);
    // For manual, override skip unless it's a safety condition
    if (plan.reason.startsWith('Current Conditions')) {
      log(0, 'Safety conditions prevent watering even in manual mode');
      logRun({ window: 'manual', phase: 'DECIDE', decision: 'SKIP', reason: plan.reason, success: true, shadow });
      return;
    }
  }

  if (plan.decision === 'WATER') {
    await executePlan(plan, 'manual', shadow);
  } else {
    log(1, 'No zones need water');
    logRun({ window: 'manual', phase: 'DECIDE', decision: 'SKIP', reason: plan.reason, success: true, shadow });
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
    return;
  }

  if (!commandSuccess) {
    log(0, 'Rachio did not accept the watering command');
    return;
  }

  // Phase 3: VERIFY (Rachio accepted the command)
  log(1, 'Rachio accepted watering command');
  logRun({ window, phase: 'VERIFY', decision: 'WATER', reason: plan.reason, gallons: plan.gallons, cost: plan.cost, success: true });

  // Update state after verified execution
  await updateStateAfterRun(plan);
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

  const profiles = buildProfiles(zones);

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const yesterdayWeather = await resolveYesterdayWeather(yesterday);

  const soilMoisture = getSoilMoisture();
  const financeData = getFinanceData();
  const dailyUsage = getDailyUsage(dateStr);
  const fertilizerLog = getFertilizerLog();

  // Check for billing cycle reset
  if (needsBillingReset(financeData.last_reset, now)) {
    log(1, 'Resetting billing cycle');
    updateFinance({ cumulative_gallons: 0, monthly_gallons: 0, monthly_cost: 0, last_reset: now.toISOString() });
  }

  if (weatherResult.stale) {
    log(1, `Weather source: ${weatherResult.source} (DEGRADED MODE)`);
  }

  return {
    weather: weatherResult.data,
    weatherSource: weatherResult.source,
    forecast,
    yesterdayWeather,
    profiles,
    soilMoisture,
    financeData: {
      cumulativeGallons: financeData.cumulative_gallons,
    },
    dailyUsage: {
      gallons: dailyUsage.gallons,
      cost: dailyUsage.cost,
    },
    fertilizerLog,
    lastCoolingTime: null, // TODO: read from runs table
  };
}

/**
 * Run daily soil moisture update.
 */
async function runSoilUpdate(ctx, now) {
  const dateStr = now.toISOString().slice(0, 10);
  const month = parseInt(now.toLocaleString('en-US', { timeZone: CONFIG.location.timezone, month: 'numeric' }), 10);

  const updatedBalances = updateDailyBalances(
    ctx.soilMoisture,
    ctx.yesterdayWeather,
    ctx.profiles,
    month
  );

  bulkSetSoilMoisture(updatedBalances, ctx.profiles);

  // Update context in place for the decision engine
  ctx.soilMoisture = updatedBalances;

  log(1, 'Soil moisture balances updated');
}

/**
 * Update all state after a verified watering run.
 */
async function updateStateAfterRun(plan) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

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
  updateDailyUsage(dateStr, plan.gallons, plan.cost, JSON.stringify(zonesMap));

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
  const status = getStatus();

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

main().catch(err => {
  log(0, `Fatal error: ${err.message}\n${err.stack}`);
  process.exit(1);
});
