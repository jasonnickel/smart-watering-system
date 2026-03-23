#!/usr/bin/env node

// Watchdog: Alerts if no successful daily run occurred
// Runs at 2am via systemd timer (1 hour after the daily watering window closes)
//
// Checks for successful terminal outcomes, not just DECIDE phase.
// A run that decided to WATER but failed at COMMAND is not healthy.
// Alerts are enriched with AI context when AI_API_KEY is configured.

import './env.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

import CONFIG from './config.js';
import { log } from './log.js';
import { initDB, getRunsSince } from './db/state.js';
import { formatTimestamp, localMonth } from './time.js';
import { notify } from './notify.js';
import { aiNarrationEnabled } from './ai/advisor.js';
import {
  enrichNotification, missedRunAlert, commandFailureAlert,
} from './ai/notifications.js';

const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');

async function sendAlert(alert) {
  let subject = alert.message;
  let body = alert.message;

  if (aiNarrationEnabled()) {
    try {
      const enriched = await enrichNotification(alert);
      subject = enriched.subject;
      body = enriched.body;
    } catch (err) {
      log(1, `AI enrichment failed, sending raw alert: ${err.message}`);
    }
  }

  await notify('watchdog', alert.severity || 'critical', subject, body);
}

async function main() {
  initDB(DB_PATH);

  const month = localMonth();
  const seasonalFactor = CONFIG.watering.seasonalAdjustment[month] ?? 0;

  if (seasonalFactor === 0) {
    log(2, 'Watchdog: Dormant season, no alert needed');
    return;
  }

  const since = formatTimestamp(new Date(Date.now() - 86400000));
  const recentRuns = getRunsSince(since);

  if (recentRuns.length === 0) {
    await sendAlert(missedRunAlert(24));
    process.exit(1);
  }

  const decisions = recentRuns.filter(r => r.phase === 'DECIDE' && r.success === 1);
  if (decisions.length === 0) {
    await sendAlert(missedRunAlert(24));
    process.exit(1);
  }

  const waterDecisions = decisions.filter(r => r.decision === 'WATER');
  if (waterDecisions.length > 0) {
    const verifiedRuns = recentRuns.filter(r => r.phase === 'VERIFY' && r.success === 1 && !r.shadow);
    const failedCommands = recentRuns.filter(r => r.phase === 'COMMAND' && r.success === 0);

    if (failedCommands.length > 0 && verifiedRuns.length === 0) {
      await sendAlert(commandFailureAlert(
        failedCommands[0].error_message || `${failedCommands.length} command(s) failed`
      ));
      process.exit(1);
    }
  }

  log(1, `Watchdog: OK - ${recentRuns.length} run(s) in last 24 hours`);
}

main().catch(err => {
  log(0, `Watchdog fatal: ${err.message}`);
  process.exit(1);
});
