// API route handlers for the smart water web UI.
// GET handlers receive (req, res) or (req, res, url). POST handlers receive (req, res, body).

import { getMoistureHistory } from '../charts.js';
import { backfillWeatherHistory } from '../api/openmeteo.js';
import { localDateStr } from '../time.js';
import {
  getStatusJSON, getRunsSince,
  getRecentReferenceET, getNDVIHistory, getRecentETValidation,
  getWeatherHistory,
} from '../db/state.js';
import { log } from '../log.js';
import { aiNarrationEnabled } from '../ai/advisor.js';
import { askYard } from '../ai/chat.js';
import { generateNarrative } from '../ai/narratives.js';
import { buildBriefingContext, generateBriefingNarrative } from '../ai/briefing.js';
import { buildSatelliteAnalysis } from '../ai/satellite.js';
import CONFIG from '../config.js';
import { getSoilProfile } from '../api/usda-soil.js';
import { getYesterdayReferenceET, backfillReferenceET } from '../api/coagmet.js';
import { ndviEnabled, getNDVIStats, getNDVIImage } from '../api/ndvi.js';
import { serveJSON } from './http.js';

// -- Constants ---------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 60_000;

// -- Helpers -----------------------------------------------------------------

function parsePositiveNumber(rawValue, fallback, { min = 0, max = Infinity } = {}) {
  if (rawValue == null || rawValue === '') return fallback;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function parseLastIntervalBehavior(rawValue) {
  if (!rawValue) return undefined;
  const value = String(rawValue).toUpperCase();
  return ['SKIP', 'SHORTEN', 'EXTEND'].includes(value) ? value : undefined;
}

/**
 * Wrap an async operation with a timeout. Returns a promise that rejects
 * after REQUEST_TIMEOUT_MS if the inner promise has not settled.
 */
function withTimeout(promise, label = 'Request') {
  return new Promise((done, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);
    promise.then(
      (val) => { clearTimeout(timer); done(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Wrapper for AI handlers - checks that AI is enabled, runs the handler,
 * and returns a generic error on failure.
 */
async function withAI(res, label, fn) {
  if (!aiNarrationEnabled()) {
    return serveJSON(res, { error: 'AI not configured' }, 503);
  }
  try {
    const result = await withTimeout(fn(), label);
    return result;
  } catch (err) {
    log(0, `${label} error: ${err.message}`);
    return serveJSON(res, { error: 'AI request failed' }, 502);
  }
}

// -- GET: Status / Charts / AI status ----------------------------------------

export function handleStatus(_req, res) {
  return serveJSON(res, getStatusJSON(localDateStr()));
}

export function handleCharts(_req, res) {
  return serveJSON(res, getMoistureHistory(14));
}

export function handleAIStatus(_req, res) {
  return serveJSON(res, { enabled: aiNarrationEnabled() });
}

// -- GET: History / data endpoints -------------------------------------------

export function handleReferenceETHistory(req, res, url) {
  const days = parsePositiveNumber(url.searchParams.get('days'), 30, { min: 1, max: 730 });
  return serveJSON(res, { data: getRecentReferenceET(days) });
}

export function handleNDVIHistory(req, res, url) {
  const days = parsePositiveNumber(url.searchParams.get('days'), 180, { min: 1, max: 730 });
  const lat = parsePositiveNumber(url.searchParams.get('lat'), CONFIG.location.lat, { min: -90, max: 90 });
  const lon = parsePositiveNumber(url.searchParams.get('lon'), CONFIG.location.lon, { min: -180, max: 180 });
  return serveJSON(res, { data: getNDVIHistory(days, lat, lon) });
}

export function handleETValidationHistory(req, res, url) {
  const days = parsePositiveNumber(url.searchParams.get('days'), 30, { min: 1, max: 730 });
  return serveJSON(res, { data: getRecentETValidation(days) });
}

export function handleWeatherHistory(req, res, url) {
  const days = parsePositiveNumber(url.searchParams.get('days'), 365, { min: 1, max: 730 });
  const source = url.searchParams.get('source') || null;
  return serveJSON(res, { data: getWeatherHistory(days, source) });
}

// -- GET: Data source endpoints ----------------------------------------------

export async function handleSoil(req, res, url) {
  const lat = parsePositiveNumber(url.searchParams.get('lat'), CONFIG.location.lat, { min: -90, max: 90 });
  const lon = parsePositiveNumber(url.searchParams.get('lon'), CONFIG.location.lon, { min: -180, max: 180 });
  try {
    const profile = await getSoilProfile(lat, lon);
    return serveJSON(res, { profile });
  } catch (err) {
    return serveJSON(res, { error: err.message }, 502);
  }
}

export async function handleReferenceET(_req, res) {
  try {
    const ref = await getYesterdayReferenceET();
    return serveJSON(res, { referenceET: ref });
  } catch (err) {
    return serveJSON(res, { error: err.message }, 502);
  }
}

export async function handleNDVI(req, res, url) {
  if (!ndviEnabled()) return serveJSON(res, { error: 'NDVI not configured' }, 503);
  const lat = parsePositiveNumber(url.searchParams.get('lat'), CONFIG.location.lat, { min: -90, max: 90 });
  const lon = parsePositiveNumber(url.searchParams.get('lon'), CONFIG.location.lon, { min: -180, max: 180 });
  try {
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    const interval = url.searchParams.get('interval') || undefined;
    const maxCloudPct = parsePositiveNumber(url.searchParams.get('max_cloud_pct'), 20, { min: 0, max: 100 });
    const lastIntervalBehavior = parseLastIntervalBehavior(url.searchParams.get('last_interval_behavior'));
    const stats = await getNDVIStats(lat, lon, {
      from,
      to,
      interval,
      maxCloudPct,
      lastIntervalBehavior,
      persist: false,
    });
    return serveJSON(res, { stats });
  } catch (err) {
    return serveJSON(res, { error: err.message }, 502);
  }
}

export async function handleSatelliteAnalysis(req, res, url) {
  if (!ndviEnabled()) return serveJSON(res, { error: 'NDVI not configured' }, 503);
  const lat = parsePositiveNumber(url.searchParams.get('lat'), CONFIG.location.lat, { min: -90, max: 90 });
  const lon = parsePositiveNumber(url.searchParams.get('lon'), CONFIG.location.lon, { min: -180, max: 180 });
  try {
    const from = url.searchParams.get('from') || undefined;
    const to = url.searchParams.get('to') || undefined;
    const interval = url.searchParams.get('interval') || undefined;
    const maxCloudPct = parsePositiveNumber(url.searchParams.get('max_cloud_pct'), 20, { min: 0, max: 100 });
    const lastIntervalBehavior = parseLastIntervalBehavior(url.searchParams.get('last_interval_behavior'))
      || (interval === 'P1M' ? 'SHORTEN' : undefined);
    const stats = await getNDVIStats(lat, lon, {
      from,
      to,
      interval,
      maxCloudPct,
      lastIntervalBehavior,
      persist: false,
    });
    const analysis = buildSatelliteAnalysis(stats);
    return serveJSON(res, { stats, analysis });
  } catch (err) {
    return serveJSON(res, { error: err.message }, 502);
  }
}

export async function handleNDVIImage(req, res, url) {
  const lat = parsePositiveNumber(url.searchParams.get('lat'), CONFIG.location.lat, { min: -90, max: 90 });
  const lon = parsePositiveNumber(url.searchParams.get('lon'), CONFIG.location.lon, { min: -180, max: 180 });
  const date = url.searchParams.get('date') || '';
  const mode = url.searchParams.get('mode') || 'ndvi';
  if (mode !== 'truecolor' && !ndviEnabled()) { res.writeHead(503); res.end('NDVI not configured'); return; }
  const sizeMeters = parsePositiveNumber(url.searchParams.get('size_meters'), undefined, { min: 40, max: 2000 });
  try {
    const imageOpts = { mode };
    if (date) imageOpts.date = date;
    if (sizeMeters != null) imageOpts.sizeMeters = sizeMeters;
    const image = await getNDVIImage(lat, lon, imageOpts);
    res.writeHead(200, { 'Content-Type': image.contentType, 'Cache-Control': 'public, max-age=86400' });
    res.end(image.buffer);
  } catch {
    // Don't leak internal error details on the image endpoint
    res.writeHead(502);
    res.end('Image request failed');
  }
}

// -- POST: AI endpoints (CSRF-protected) -------------------------------------

export async function handleAIChat(_req, res, body) {
  const question = body.get('question') || '';
  if (!question.trim() || question.length > 500) {
    return serveJSON(res, { error: 'Question required (max 500 chars)' }, 400);
  }
  return withAI(res, 'AI chat', async () => {
    const result = await askYard(question.trim());
    return serveJSON(res, { answer: result?.content || 'No response', reasoning: result?.reasoning || null });
  });
}

export async function handleAINarrative(_req, res, body) {
  const runId = parsePositiveNumber(body.get('run_id'), 0, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (!runId) {
    return serveJSON(res, { error: 'Valid run_id required' }, 400);
  }
  return withAI(res, 'AI narrative', async () => {
    // Look back 30 days for the run
    const lookbackStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const runs = getRunsSince(lookbackStart);
    const run = runs.find(r => r.id === runId);
    if (!run) {
      return serveJSON(res, { error: 'Run not found' }, 404);
    }
    const result = await generateNarrative(run);
    return serveJSON(res, { narrative: result?.narrative || null, reasoning: result?.reasoning || null });
  });
}

export async function handleAIBriefing(_req, res) {
  return withAI(res, 'AI briefing', async () => {
    const context = buildBriefingContext();
    const narrative = await generateBriefingNarrative(context);
    return serveJSON(res, {
      narrative: narrative?.content || null,
      reasoning: narrative?.reasoning || null,
      context,
    });
  });
}

// -- POST: Backfill endpoints ------------------------------------------------

export async function handleBackfillReferenceET(_req, res, body) {
  try {
    const years = parsePositiveNumber(body.get('years'), 2, { min: 1, max: 5 });
    const total = await withTimeout(backfillReferenceET({ years }), 'Reference ET backfill');
    return serveJSON(res, { saved: total, years });
  } catch (err) {
    log(0, `Reference ET backfill error: ${err.message}`);
    return serveJSON(res, { error: err.message }, 502);
  }
}

export async function handleBackfillWeather(_req, res, body) {
  try {
    const years = parsePositiveNumber(body.get('years'), 2, { min: 1, max: 5 });
    const total = await withTimeout(backfillWeatherHistory({ years }), 'Weather backfill');
    return serveJSON(res, { saved: total, years });
  } catch (err) {
    log(0, `Weather backfill error: ${err.message}`);
    return serveJSON(res, { error: err.message }, 502);
  }
}
