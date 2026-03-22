#!/usr/bin/env node

// Watchdog: Alerts if no successful daily run occurred
// Runs at 2am via systemd timer (1 hour after the daily watering window closes)
//
// [FIX P1] Checks for successful terminal outcomes, not just DECIDE phase.
// A run that decided to WATER but failed at COMMAND is not healthy.

import './env.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

import CONFIG from './config.js';
import { log } from './log.js';
import { initDB, getRunsSince } from './db/state.js';
import { formatTimestamp, localMonth } from './time.js';

const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

async function sendAlert(message) {
  log(0, message);

  if (WEBHOOK_URL) {
    try {
      await fetch(`${WEBHOOK_URL}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'watchdog', severity: 'critical', message }),
      });
      log(1, 'Watchdog alert sent via n8n webhook');
    } catch (err) {
      log(0, `Failed to send webhook alert: ${err.message}`);
    }
  }
}

async function main() {
  initDB(DB_PATH);

  const month = localMonth();
  const seasonalFactor = CONFIG.watering.seasonalAdjustment[month] ?? 0;

  if (seasonalFactor === 0) {
    log(2, 'Watchdog: Dormant season, no alert needed');
    return;
  }

  // Look for runs in the last 24 hours
  const since = formatTimestamp(new Date(Date.now() - 86400000));
  const recentRuns = getRunsSince(since);

  if (recentRuns.length === 0) {
    await sendAlert('WATCHDOG ALERT: No runs recorded in the last 24 hours!');
    process.exit(1);
  }

  // Check for successful terminal outcomes:
  // - SKIP decisions with successful DECIDE are fine (system ran, decided not to water)
  // - WATER decisions need a successful VERIFY to be healthy
  const decisions = recentRuns.filter(r => r.phase === 'DECIDE' && r.success === 1);
  if (decisions.length === 0) {
    await sendAlert('WATCHDOG ALERT: Runs exist but no successful DECIDE phase in 24 hours');
    process.exit(1);
  }

  // Check if any WATER decisions failed at COMMAND/VERIFY
  const waterDecisions = decisions.filter(r => r.decision === 'WATER');
  if (waterDecisions.length > 0) {
    const verifiedRuns = recentRuns.filter(r => r.phase === 'VERIFY' && r.success === 1 && !r.shadow);
    const failedCommands = recentRuns.filter(r => r.phase === 'COMMAND' && r.success === 0);

    if (failedCommands.length > 0 && verifiedRuns.length === 0) {
      await sendAlert(
        `WATCHDOG ALERT: System decided to water but all ${failedCommands.length} command(s) failed. ` +
        `Last error: ${failedCommands[0].error_message || 'unknown'}`
      );
      process.exit(1);
    }
  }

  log(1, `Watchdog: OK - ${recentRuns.length} run(s) in last 24 hours`);
}

main().catch(err => {
  log(0, `Watchdog fatal: ${err.message}`);
  process.exit(1);
});
