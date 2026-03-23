// AI-powered decision storytelling for run history entries.
// Generates rich natural language explanations for individual decisions,
// cached in the database to avoid repeated API calls.

import { callAdvisorModel, aiNarrationEnabled } from './advisor.js';
import { getDB } from '../db/state.js';

const NARRATIVE_TABLE = 'decision_narratives';

export function ensureNarrativeTable() {
  const db = getDB();
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${NARRATIVE_TABLE} (
      run_id INTEGER PRIMARY KEY,
      narrative TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function getCachedNarrative(runId) {
  const db = getDB();
  const row = db.prepare(`SELECT narrative, reasoning FROM ${NARRATIVE_TABLE} WHERE run_id = ?`).get(runId);
  return row || null;
}

function cacheNarrative(runId, narrative, reasoning) {
  const db = getDB();
  db.prepare(`INSERT OR REPLACE INTO ${NARRATIVE_TABLE} (run_id, narrative, reasoning) VALUES (?, ?, ?)`)
    .run(runId, narrative, reasoning);
}

function buildRunContext(run) {
  const parts = [
    `Timestamp: ${run.timestamp}`,
    `Phase: ${run.phase}`,
    `Decision: ${run.decision}`,
    `Reason: ${run.reason || 'none'}`,
  ];

  if (run.zones) parts.push(`Zones: ${run.zones}`);
  if (run.total_gallons > 0) parts.push(`Gallons: ${run.total_gallons}`);
  if (run.total_cost > 0) parts.push(`Cost: $${run.total_cost.toFixed(2)}`);
  if (run.shadow) parts.push('Mode: shadow (not actuated)');
  if (run.success === 0) parts.push(`Error: ${run.error || 'command failed'}`);

  return parts.join('\n');
}

export async function generateNarrative(run) {
  if (!aiNarrationEnabled()) {
    return null;
  }

  if (!run?.id) {
    return null;
  }

  const cached = getCachedNarrative(run.id);
  if (cached) {
    return cached;
  }

  const result = await callAdvisorModel([
    {
      role: 'system',
      content: `You explain irrigation system decisions to a homeowner in plain English. Write 2-4 sentences that tell the story of what happened and why. Include specific numbers from the data. Be conversational but precise. If it was a skip, explain why that was the right call. If it was a watering run, explain what triggered it and what was accomplished.`,
    },
    {
      role: 'user',
      content: `Explain this irrigation decision in plain English:\n${buildRunContext(run)}`,
    },
  ], { model: 'kimi-k2-thinking-turbo', maxTokens: 1024, timeoutMs: 60000 });

  if (result?.content) {
    cacheNarrative(run.id, result.content, result.reasoning);
  }

  return result ? { narrative: result.content, reasoning: result.reasoning } : null;
}
