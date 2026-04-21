// AquaHawk utility meter portal client
// Generic client for any municipality using UtilityHawk/AquaHawk.
// District is a configuration value (e.g. 'goco' -> goco.aquahawk.us).
//
// Reverse-engineered endpoints - AquaHawk has no public API. The web UI
// calls /login (form POST, session cookie auth) and /timeseries (JSON).
// Endpoint contract mirrors ablyler/aquahawk_client (Python, MIT).

import CONFIG from '../config.js';
import { log } from '../log.js';

const LOGIN_PATH = '/login';
const TIMESERIES_PATH = '/timeseries';
const FETCH_TIMEOUT_MS = 30000;
const HOURLY_CHUNK_DAYS = 7;
const HOURLY_SLEEP_MS = 1000;

const DEFAULT_METRICS = {
  waterUse: true,
  waterUseReading: true,
  temperature: true,
  rainfall: true,
};

export class AuthenticationError extends Error {
  constructor(message = 'AquaHawk authentication failed') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AquaHawkClient {
  constructor({ district, username, password, accountNumber }) {
    if (!district) throw new Error('AquaHawk: district is required');
    if (!username) throw new Error('AquaHawk: username is required');
    if (!password) throw new Error('AquaHawk: password is required');
    if (!accountNumber) throw new Error('AquaHawk: accountNumber is required');

    this.district = district;
    this.username = username;
    this.password = password;
    this.accountNumber = accountNumber;
    this.baseUrl = `https://${district}.aquahawk.us`;
    this._cookie = null;
  }

  _fetch(path, { method = 'GET', headers = {}, body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const finalHeaders = { accept: 'application/json', ...headers };
    if (this._cookie) finalHeaders.cookie = this._cookie;

    return fetch(`${this.baseUrl}${path}`, {
      method,
      headers: finalHeaders,
      body,
      signal: controller.signal,
      redirect: 'manual',
    }).finally(() => clearTimeout(timeout));
  }

  _captureSessionCookie(response) {
    const setCookie = response.headers.getSetCookie?.() || [];
    if (setCookie.length === 0) {
      const legacy = response.headers.get('set-cookie');
      if (legacy) setCookie.push(legacy);
    }
    if (setCookie.length === 0) return;
    const pairs = setCookie
      .map(c => c.split(';')[0].trim())
      .filter(p => p && !p.endsWith('='));
    if (pairs.length > 0) {
      this._cookie = pairs.join('; ');
    }
  }

  async authenticate() {
    const body = new URLSearchParams({
      username: this.username,
      password: this.password,
    }).toString();

    const response = await this._fetch(LOGIN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      throw new AuthenticationError(`HTTP ${response.status} ${response.statusText}`);
    }

    this._captureSessionCookie(response);

    const payload = await response.json();
    if (payload?.success !== true) {
      throw new AuthenticationError(payload?.message || 'Authentication failed');
    }
    if (!this._cookie) {
      throw new AuthenticationError('Login succeeded but no session cookie was set');
    }

    log(2, `AquaHawk: authenticated as ${this.username} on ${this.district}`);
  }

  /**
   * Fetch usage timeseries between two instants.
   *
   * @param {object} opts
   * @param {Date} opts.start - range start (inclusive)
   * @param {Date} opts.end - range end (exclusive)
   * @param {'1 hour'|'1 day'|'1 month'|'1 year'} opts.interval
   * @returns {Promise<object>} raw Usage JSON with { success, timeseries: [...], firstTime, lastTime, ... }
   */
  async getUsage({ start, end, interval = '1 day' }) {
    if (!this._cookie) await this.authenticate();

    const params = new URLSearchParams({
      _dc: String(Date.now()),
      districtName: this.district,
      accountNumber: this.accountNumber,
      startTime: formatIso(start),
      endTime: formatIso(end),
      interval,
      extraStartTime: 'true',
      extraEndTime: 'true',
      metrics: JSON.stringify(DEFAULT_METRICS),
    });

    const response = await this._fetch(`${TIMESERIES_PATH}?${params.toString()}`);

    if (response.status === 401 || response.status === 403) {
      this._cookie = null;
      await this.authenticate();
      return this.getUsage({ start, end, interval });
    }

    if (!response.ok) {
      throw new Error(`AquaHawk /timeseries: HTTP ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (payload?.success !== true) {
      throw new Error(`AquaHawk /timeseries: ${payload?.message || 'request failed'}`);
    }
    return payload;
  }

  /**
   * Fetch hourly usage across a long range, split into chunks to stay under
   * AquaHawk's per-request size limit. Returns a concatenated timeseries array.
   *
   * @param {object} opts
   * @param {Date} opts.start
   * @param {Date} opts.end
   * @param {number} [opts.chunkDays=7]
   * @param {number} [opts.sleepMs=1000] - delay between chunks (avoid overloading portal)
   * @param {function} [opts.onProgress] - optional ({chunkIndex, totalChunks, rows, cumulative}) => void
   */
  async getHourlyUsageChunked({
    start,
    end,
    chunkDays = HOURLY_CHUNK_DAYS,
    sleepMs = HOURLY_SLEEP_MS,
    onProgress,
  }) {
    const all = [];
    const chunkMs = chunkDays * 24 * 60 * 60 * 1000;
    const totalChunks = Math.ceil((end.getTime() - start.getTime()) / chunkMs);
    let cursor = new Date(start);
    let i = 0;

    while (cursor < end) {
      const chunkEnd = new Date(Math.min(cursor.getTime() + chunkMs, end.getTime()));
      i += 1;

      try {
        const payload = await this.getUsage({
          start: cursor,
          end: chunkEnd,
          interval: '1 hour',
        });
        const rows = payload.timeseries || [];
        all.push(...rows);
        onProgress?.({
          chunkIndex: i,
          totalChunks,
          chunkStart: cursor,
          chunkEnd,
          rows: rows.length,
          cumulative: all.length,
        });
      } catch (err) {
        log(1, `AquaHawk hourly chunk ${i}/${totalChunks} failed: ${err.message}`);
      }

      cursor = chunkEnd;
      if (cursor < end && sleepMs > 0) {
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }

    return all;
  }
}

/**
 * Flatten a raw AquaHawk Timesery object into scalar fields suitable for DB insert.
 */
export function flattenTimesery(ts) {
  const wu = ts.waterUseActual || ts.waterUse || null;
  return {
    start_time: ts.startTime,
    end_time: ts.endTime,
    interval: ts.interval,
    timezone: ts.timezone,
    gallons: wu?.gallons ?? null,
    gallons_min: wu?.min ?? null,
    gallons_max: wu?.max ?? null,
    gallons_samples: wu?.num ?? null,
    rainfall_in: ts.rainfall?.inches ?? null,
    high_temp_f: ts.highTemp?.fahrenheit ?? null,
    low_temp_f: ts.lowTemp?.fahrenheit ?? null,
    avg_temp_f: ts.avgTemp?.fahrenheit ?? null,
  };
}

/**
 * Build a client from CONFIG. Returns null if not configured.
 */
export function aquaHawkFromConfig() {
  const c = CONFIG.api.aquahawk;
  if (!c?.district || !c?.username || !c?.password || !c?.accountNumber) {
    return null;
  }
  return new AquaHawkClient({
    district: c.district,
    username: c.username,
    password: c.password,
    accountNumber: c.accountNumber,
  });
}

/**
 * AquaHawk wants timestamps like 2024-04-21T00:00:00+0000 (no colon in offset).
 */
function formatIso(date) {
  const iso = date.toISOString();
  return iso.replace(/\.\d{3}Z$/, '+0000');
}
