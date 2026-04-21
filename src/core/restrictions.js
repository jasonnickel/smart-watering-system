// Water restrictions - deterministic constraint layer on watering decisions.
//
// When a municipality declares drought restrictions (e.g. City of Golden
// Stage 1: max 2 days/week, 6pm-10am only), Taproot enforces them as a
// hard SKIP in the decision pipeline. This is separate from normal
// scheduling windows - restrictions always win.
//
// Configured via restrictions.yaml (shipped default: disabled) with optional
// per-user override at ~/.taproot/restrictions.yaml.

import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { log } from '../log.js';
import { PROJECT_ROOT, TAPROOT_RESTRICTIONS_PATH } from '../paths.js';
import { join } from 'node:path';
import { localDateStr, localHour, localWeekday } from '../time.js';

const PROJECT_PATH = join(PROJECT_ROOT, 'restrictions.yaml');
const HOME_PATH = TAPROOT_RESTRICTIONS_PATH;

const DEFAULT_RESTRICTIONS = {
  enabled: false,
  stage: 0,
  maxDaysPerWeek: 7,
  allowedHours: [{ start: 0, end: 24 }],
  exemptZoneTypes: [],
  allowedDays: [],
  penaltyFirstOffense: '',
  penaltyMax: '',
  leakAlertGallonsPerDay: 0,
  leakRepairGraceDays: 0,
  sourceUrl: '',
  effectiveFrom: '',
  effectiveUntil: '',
};

let cachedRestrictions = null;

/**
 * Load restrictions configuration, preferring ~/.taproot/restrictions.yaml
 * over the repo-level default.
 */
export function loadRestrictions({ reload = false } = {}) {
  if (cachedRestrictions && !reload) return cachedRestrictions;

  const path = [HOME_PATH, PROJECT_PATH].find(p => existsSync(p));
  if (!path) {
    cachedRestrictions = { ...DEFAULT_RESTRICTIONS };
    return cachedRestrictions;
  }

  try {
    const raw = readFileSync(path, 'utf-8');
    const data = yaml.load(raw);
    cachedRestrictions = mergeRestrictions(data);
    if (cachedRestrictions.enabled) {
      log(1, `Restrictions loaded from ${path}: stage ${cachedRestrictions.stage}, ${cachedRestrictions.maxDaysPerWeek} days/week, windows=${describeHours(cachedRestrictions.allowedHours)}`);
    }
    return cachedRestrictions;
  } catch (err) {
    log(0, `Failed to load restrictions.yaml: ${err.message}`);
    cachedRestrictions = { ...DEFAULT_RESTRICTIONS };
    return cachedRestrictions;
  }
}

function mergeRestrictions(data) {
  if (!data) return { ...DEFAULT_RESTRICTIONS };
  return {
    ...DEFAULT_RESTRICTIONS,
    enabled: Boolean(data.enabled),
    stage: Number(data.stage ?? 0),
    maxDaysPerWeek: Number(data.max_days_per_week ?? DEFAULT_RESTRICTIONS.maxDaysPerWeek),
    allowedHours: normalizeHours(data.allowed_hours),
    exemptZoneTypes: Array.isArray(data.exempt_zone_types) ? data.exempt_zone_types.map(s => String(s).toLowerCase()) : [],
    allowedDays: Array.isArray(data.allowed_days) ? data.allowed_days.map(Number) : [],
    penaltyFirstOffense: String(data.penalty_first_offense || ''),
    penaltyMax: String(data.penalty_max || ''),
    leakAlertGallonsPerDay: Number(data.leak_alert_gallons_per_day ?? 0),
    leakRepairGraceDays: Number(data.leak_repair_grace_days ?? 0),
    sourceUrl: String(data.source_url || ''),
    effectiveFrom: String(data.effective_from || ''),
    effectiveUntil: String(data.effective_until || ''),
  };
}

function normalizeHours(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [{ start: 0, end: 24 }];
  }
  return raw
    .map(h => ({ start: Number(h.start), end: Number(h.end) }))
    .filter(h => Number.isFinite(h.start) && Number.isFinite(h.end));
}

function describeHours(windows) {
  return windows.map(w => `${w.start}-${w.end}`).join(', ');
}

/**
 * Does a given hour fall inside one of the allowed windows?
 * Windows wrap midnight if start > end (e.g. 18-10 = 6pm through 10am).
 */
export function isHourAllowed(hour, windows) {
  for (const w of windows) {
    if (w.start === w.end) continue;
    if (w.start < w.end) {
      if (hour >= w.start && hour < w.end) return true;
    } else {
      // Wraps midnight
      if (hour >= w.start || hour < w.end) return true;
    }
  }
  return false;
}

/**
 * Check whether restrictions are currently active based on effective dates.
 */
export function isRestrictionWindowActive(restrictions, now = new Date()) {
  if (!restrictions.enabled) return false;
  const today = localDateStr(now);
  if (restrictions.effectiveFrom) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(restrictions.effectiveFrom)) {
      if (today < restrictions.effectiveFrom) return false;
    } else {
      const from = new Date(restrictions.effectiveFrom);
      if (Number.isFinite(from.getTime()) && now < from) return false;
    }
  }
  if (restrictions.effectiveUntil) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(restrictions.effectiveUntil)) {
      if (today > restrictions.effectiveUntil) return false;
    } else {
      const until = new Date(restrictions.effectiveUntil);
      if (Number.isFinite(until.getTime()) && now > until) return false;
    }
  }
  return true;
}

/**
 * Decide whether a zone is permitted to water right now.
 *
 * @param {object} zone - Zone profile with { id, type, ... }
 * @param {Date}   now  - Current time
 * @param {Set<string>} wateringDates - YYYY-MM-DD dates this zone has
 *                                      already watered in the rolling
 *                                      7-day window.
 * @param {object} restrictions - Loaded restrictions config
 * @returns {{ allowed: boolean, reason: string, meta: object }}
 */
export function checkZoneRestriction(zone, now, wateringDates, restrictions) {
  if (!isRestrictionWindowActive(restrictions, now)) {
    return { allowed: true, reason: '', meta: null };
  }

  const zoneType = String(zone.type || '').toLowerCase();
  if (restrictions.exemptZoneTypes.includes(zoneType)) {
    return { allowed: true, reason: '', meta: { exempt: true, type: zoneType } };
  }

  const hour = localHour(now);
  if (!isHourAllowed(hour, restrictions.allowedHours)) {
    return {
      allowed: false,
      reason: `Restricted hours (stage ${restrictions.stage}) - ${formatWindows(restrictions.allowedHours)}`,
      meta: { hour, windows: restrictions.allowedHours },
    };
  }

  if (restrictions.maxDaysPerWeek === 0) {
    return {
      allowed: false,
      reason: `Stage ${restrictions.stage} - no watering permitted`,
      meta: { stage: restrictions.stage },
    };
  }

  const today = localDateStr(now);
  const daysUsed = new Set(wateringDates);
  const alreadyUsed = daysUsed.has(today);
  const effectiveCount = daysUsed.size + (alreadyUsed ? 0 : 0);

  // If watering today would push count over the limit, block.
  const wouldBeCount = alreadyUsed ? effectiveCount : effectiveCount + 1;
  if (wouldBeCount > restrictions.maxDaysPerWeek) {
    return {
      allowed: false,
      reason: `Max ${restrictions.maxDaysPerWeek} watering days/week reached (used ${daysUsed.size} in last 7d)`,
      meta: { used: daysUsed.size, max: restrictions.maxDaysPerWeek, days: [...daysUsed].sort() },
    };
  }

  if (restrictions.allowedDays.length > 0) {
    const dow = localWeekday(now);
    if (!restrictions.allowedDays.includes(dow)) {
      return {
        allowed: false,
        reason: `Today (day ${dow}) not in allowed days ${JSON.stringify(restrictions.allowedDays)}`,
        meta: { dow, allowedDays: restrictions.allowedDays },
      };
    }
  }

  return {
    allowed: true,
    reason: '',
    meta: { daysUsedThisWeek: daysUsed.size, maxDaysPerWeek: restrictions.maxDaysPerWeek },
  };
}

function formatWindows(windows) {
  return windows
    .map(w => `${fmtHour(w.start)}-${fmtHour(w.end)}`)
    .join(', ');
}

function fmtHour(h) {
  const hour = h % 24;
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  if (hour < 12) return `${hour}am`;
  return `${hour - 12}pm`;
}

/**
 * Filter a list of zones-to-water down to only those permitted right now.
 * Returns { allowedZones, blockedZones } where blockedZones have .reason.
 */
export function applyZoneRestrictions(zones, now, wateringDatesByZone, restrictions) {
  const allowedZones = [];
  const blockedZones = [];
  for (const z of zones) {
    const dates = wateringDatesByZone.get(z.id) || new Set();
    const check = checkZoneRestriction(z.profile || z, now, dates, restrictions);
    if (check.allowed) {
      allowedZones.push({ ...z, restrictionMeta: check.meta });
    } else {
      blockedZones.push({ ...z, restrictionReason: check.reason });
    }
  }
  return { allowedZones, blockedZones };
}

/**
 * Build a human-readable summary of active restrictions for logs/dashboards.
 */
export function describeRestrictions(restrictions) {
  if (!restrictions.enabled) return 'disabled';
  return [
    `Stage ${restrictions.stage}`,
    `max ${restrictions.maxDaysPerWeek} days/week`,
    `hours ${formatWindows(restrictions.allowedHours)}`,
    restrictions.exemptZoneTypes.length ? `exempt: ${restrictions.exemptZoneTypes.join(', ')}` : null,
  ].filter(Boolean).join(', ');
}
