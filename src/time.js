// Centralized local-time helpers for America/Denver
// All business dates (daily usage, billing, soil updates) must use local time, not UTC.

import CONFIG from './config.js';

const TZ = CONFIG.location.timezone;

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
