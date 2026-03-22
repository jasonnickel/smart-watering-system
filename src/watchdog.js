#!/usr/bin/env node

// Watchdog: Alerts if no successful daily run occurred
// Runs at 2am via systemd timer (1 hour after the daily watering window closes)

import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const projectEnv = join(import.meta.dirname, '..', '.env');
const homeEnv = join(homedir(), '.smart-water', '.env');
loadEnv({ path: existsSync(projectEnv) ? projectEnv : homeEnv });

import CONFIG from './config.js';
import { log } from './log.js';
import { initDB, getRunsSince } from './db/state.js';

const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');

function main() {
  initDB(DB_PATH);

  // Check if the daily window is in a watering month
  const month = parseInt(new Date().toLocaleString('en-US', { timeZone: CONFIG.location.timezone, month: 'numeric' }), 10);
  const seasonalFactor = CONFIG.watering.seasonalAdjustment[month] ?? 0;

  if (seasonalFactor === 0) {
    log(2, 'Watchdog: Dormant season, no alert needed');
    return;
  }

  // Look for runs in the last 24 hours
  const since = new Date(Date.now() - 86400000).toISOString();
  const recentRuns = getRunsSince(since);

  if (recentRuns.length === 0) {
    log(0, 'WATCHDOG ALERT: No runs recorded in the last 24 hours!');
    // TODO: send notification via SMTP or n8n webhook
    process.exit(1);
  }

  const hasDecision = recentRuns.some(r => r.phase === 'DECIDE' && r.success === 1);
  if (!hasDecision) {
    log(0, 'WATCHDOG ALERT: Runs exist but no successful DECIDE phase in 24 hours');
    process.exit(1);
  }

  log(1, `Watchdog: OK - ${recentRuns.length} run(s) in last 24 hours`);
}

main();
