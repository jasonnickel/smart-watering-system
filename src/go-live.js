// smart-water go-live
// Safety-checked transition from shadow mode to live mode.
// Verifies the system has been running successfully before enabling actuation.

import './env.js';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import CONFIG from './config.js';
import { initDB, getRunsSince } from './db/state.js';
import { getEnvFilePath, readShadowMode, writeEnvValue } from './env.js';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');
const ENV_PATH = getEnvFilePath();

const rl = createInterface({ input: process.stdin, output: process.stdout });
function confirm(question) {
  return new Promise(resolve => {
    rl.question(`${question} (y/n): `, answer => {
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function runGoLive() {
  console.log(`\n${BOLD}Smart Water System - Go Live${RESET}\n`);

  // Check current mode
  if (!readShadowMode()) {
    console.log(`${GREEN}System is already in live mode.${RESET}`);
    rl.close();
    return;
  }

  console.log(`Current mode: ${YELLOW}SHADOW${RESET} (decisions logged, Rachio not actuated)\n`);

  // Pre-flight checks
  let passed = 0;
  let failed = 0;

  initDB(DB_PATH);

  // Check: has the system been running?
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const recentRuns = getRunsSince(weekAgo);
  const decisions = recentRuns.filter(r => r.phase === 'DECIDE');
  const shadowRuns = recentRuns.filter(r => r.shadow === 1);

  if (decisions.length >= 7) {
    console.log(`  ${GREEN}OK${RESET}  ${decisions.length} decisions logged in the last 7 days`);
    passed++;
  } else if (decisions.length > 0) {
    console.log(`  ${YELLOW}!!${RESET}  Only ${decisions.length} decisions in 7 days (recommend at least 7)`);
  } else {
    console.log(`  ${RED}FAIL${RESET}  No decisions logged. Run in shadow mode for at least a week first.`);
    failed++;
  }

  // Check: any command failures?
  const failures = recentRuns.filter(r => r.phase === 'COMMAND' && r.success === 0);
  if (failures.length === 0) {
    console.log(`  ${GREEN}OK${RESET}  No command failures in recent history`);
    passed++;
  } else {
    console.log(`  ${YELLOW}!!${RESET}  ${failures.length} command failure(s) in recent history`);
  }

  // Check: API keys configured?
  if (CONFIG.api.rachio.apiKey && CONFIG.api.rachio.apiKey !== 'your-rachio-api-key') {
    console.log(`  ${GREEN}OK${RESET}  Rachio API key configured`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET}  No Rachio API key. Run: smart-water setup`);
    failed++;
  }

  // Check: zones configured?
  const zoneCount = Object.keys(CONFIG.watering.zoneProfiles).length;
  if (zoneCount > 0) {
    console.log(`  ${GREEN}OK${RESET}  ${zoneCount} zones configured`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET}  No zones configured`);
    failed++;
  }

  console.log('');

  if (failed > 0) {
    console.log(`${RED}Cannot go live: ${failed} check(s) failed.${RESET} Fix the issues above first.\n`);
    rl.close();
    return;
  }

  // Confirmation
  console.log(`${BOLD}Going live means:${RESET}`);
  console.log(`  - The system will send real watering commands to your Rachio controller`);
  console.log(`  - Your sprinklers will turn on when the system decides to water`);
  console.log(`  - You can switch back to shadow mode at any time by running:`);
  console.log(`    ${BOLD}smart-water shadow${RESET}\n`);

  const proceed = await confirm(`${BOLD}Enable live mode?${RESET}`);

  if (!proceed) {
    console.log('Staying in shadow mode.');
    rl.close();
    return;
  }

  // Update .env
  try {
    writeEnvValue('SHADOW_MODE', 'false');
    console.log(`\n${GREEN}Live mode enabled.${RESET} SHADOW_MODE=false written to ${ENV_PATH}`);
    console.log(`\nThe system will actuate Rachio on the next watering decision.`);
    console.log(`To switch back: run ${BOLD}smart-water shadow${RESET}\n`);
  } catch (err) {
    console.log(`\n${RED}Could not update .env: ${err.message}${RESET}`);
    console.log(`Manually set SHADOW_MODE=false in ${ENV_PATH}\n`);
  }

  rl.close();
}
