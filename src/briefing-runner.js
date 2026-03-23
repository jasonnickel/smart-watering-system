#!/usr/bin/env node

// Weekly Intelligence Briefing Runner
// Generates and sends the weekly briefing email.
// Run Sundays at 7am via systemd timer.

import './env.js';

import { log } from './log.js';
import { initDB } from './db/state.js';
import { sendSummaryEmail } from './notify.js';
import { buildBriefingContext, generateBriefingNarrative, buildBriefingHTML } from './ai/briefing.js';
import { getDefaultDatabasePath } from './paths.js';

const DB_PATH = getDefaultDatabasePath();

async function main() {
  initDB(DB_PATH);

  log(1, 'Building weekly intelligence briefing...');

  const context = buildBriefingContext();

  let narrative = null;
  try {
    narrative = await generateBriefingNarrative(context);
  } catch (err) {
    log(1, `AI briefing narrative unavailable: ${err.message}`);
  }

  const html = buildBriefingHTML(context, narrative);
  const subject = `Taproot Weekly Briefing - ${context.today}`;

  await sendSummaryEmail(subject, html);
  log(1, 'Weekly briefing sent');
}

main().catch(err => {
  log(0, `Briefing fatal: ${err.message}\n${err.stack}`);
  process.exit(1);
});
