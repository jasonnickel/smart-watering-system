// Centralized local-time helpers for America/Denver
// All business dates (daily usage, billing, soil updates) must use local time, not UTC.

import CONFIG from './config.js';

const TZ = CONFIG.location.timezone;

/**
 * Format a value as a canonical UTC ISO timestamp.
 *
 * @param {Date|string|number} value
 * @returns {string}
 */
export function formatTimestamp(value = new Date()) {
  const parsed = parseStoredTimestamp(value);
  if (!parsed) {
    throw new Error(`Invalid timestamp: ${value}`);
  }
  return parsed.toISOString();
}

/**
 * Parse timestamps stored by the app.
 * Accepts canonical ISO strings plus legacy SQLite `datetime('now')` text.
 *
 * @param {Date|string|number} value
 * @returns {Date|null}
 */
export function parseStoredTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const parsedNumber = new Date(value);
    return Number.isNaN(parsedNumber.getTime()) ? null : parsedNumber;
  }

  const raw = String(value).trim();
  if (!raw) return null;

  let normalized = raw;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    normalized = `${raw.replace(' ', 'T')}.000Z`;
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+$/.test(raw)) {
    normalized = `${raw.replace(' ', 'T')}Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) {
    normalized = `${raw}.000Z`;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Compute age in minutes from a stored timestamp.
 *
 * @param {Date|string|number} value
 * @param {number} nowMs
 * @returns {number}
 */
export function minutesSinceTimestamp(value, nowMs = Date.now()) {
  const parsed = parseStoredTimestamp(value);
  if (!parsed) return Number.POSITIVE_INFINITY;
  return (nowMs - parsed.getTime()) / 60000;
}

/**
 * Get today's date string in local timezone.
 * @returns {string} YYYY-MM-DD in America/Denver
 */
export function localDateStr(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: TZ }); // en-CA gives YYYY-MM-DD
}

/**
 * Get yesterday's date string in local timezone.
 * @returns {string} YYYY-MM-DD in America/Denver
 */
export function localYesterdayStr(date = new Date()) {
  const yesterday = new Date(date.getTime() - 86400000);
  return localDateStr(yesterday);
}

/**
 * Get current hour in local timezone.
 * @returns {number} 0-23
 */
export function localHour(date = new Date()) {
  return parseInt(date.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }), 10);
}

/**
 * Get current month in local timezone.
 * @returns {number} 1-12
 */
export function localMonth(date = new Date()) {
  return parseInt(date.toLocaleString('en-US', { timeZone: TZ, month: 'numeric' }), 10);
}
