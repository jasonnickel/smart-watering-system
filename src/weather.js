// Weather data coordinator with degraded-mode fallback
// Handles caching, staleness detection, and conservative defaults

import CONFIG from './config.js';
import { getCurrentWeather } from './api/ambient.js';
import { getYesterdayWeather, getForecast } from './api/openmeteo.js';
import { getCachedWeather, setCachedWeather } from './db/state.js';
import { log } from './log.js';

/**
 * Get current weather with degraded-mode fallback.
 * Priority: Ambient Weather station -> OpenMeteo -> conservative defaults
 *
 * @returns {Promise<{data: object, source: string, stale: boolean}>}
 */
export async function resolveCurrentWeather() {
  // Try Ambient Weather station first
  try {
    const data = await getCurrentWeather();
    setCachedWeather('ambient', data);
    return { data, source: 'ambient', stale: false };
  } catch (err) {
    log(1, `Ambient Weather unavailable: ${err.message}`);
  }

  // Check cache staleness
  const cached = getCachedWeather('ambient');
  if (cached) {
    const ageMinutes = (Date.now() - new Date(cached.fetched_at).getTime()) / 60000;
    if (ageMinutes < CONFIG.degradedMode.ambientStaleThresholdMinutes) {
      log(1, `Using cached Ambient data (${Math.round(ageMinutes)} min old)`);
      return { data: JSON.parse(cached.data_json), source: 'ambient-cached', stale: false };
    }
    log(1, `Ambient cache is stale (${Math.round(ageMinutes)} min old)`);
  }

  // Try OpenMeteo forecast for today as fallback for current conditions
  try {
    const forecast = await getForecast();
    if (forecast?.[0]) {
      const today = forecast[0];
      // [FIX P2] Do NOT use forecast precipitation as rainLast24h.
      // Forecast precipitation is predicted future rain, not actual observed rain.
      // Setting rainLast24h from forecast would cause the rule engine to skip
      // watering due to "recent rain" that hasn't actually happened, and then
      // the forecast stage would also skip for the same predicted rain - double penalty.
      const fallbackData = {
        temp: (today.tmax + today.tmin) / 2,
        humidity: today.humidity,
        windSpeed: 5, // OpenMeteo daily doesn't provide wind
        solarRadiation: today.solarRadiation,
        rainLast24h: 0, // Unknown - don't fabricate rain data
        timestamp: new Date().toISOString(),
      };
      log(1, 'DEGRADED MODE: Using OpenMeteo forecast as current weather proxy');
      return { data: fallbackData, source: 'openmeteo-fallback', stale: true };
    }
  } catch (err) {
    log(1, `OpenMeteo fallback also unavailable: ${err.message}`);
  }

  // Last resort: conservative defaults (assume hot, dry - water conservatively)
  log(0, 'DEGRADED MODE: All weather sources unavailable, using conservative defaults');
  return {
    data: { ...CONFIG.degradedMode.defaults, timestamp: new Date().toISOString() },
    source: 'defaults',
    stale: true,
  };
}

/**
 * Get yesterday's weather with caching.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Promise<object>}
 */
export async function resolveYesterdayWeather(dateStr) {
  const cacheKey = `openmeteo_yesterday_${dateStr}`;
  const cached = getCachedWeather(cacheKey);
  if (cached) {
    return JSON.parse(cached.data_json);
  }

  try {
    const data = await getYesterdayWeather(dateStr);
    setCachedWeather(cacheKey, data);
    return data;
  } catch (err) {
    log(1, `Yesterday weather unavailable: ${err.message}`);
    // Return conservative defaults for ET calculation
    return {
      tmax: 85, tmin: 65, tavg: 75,
      precipitation_sum: 0, humidity: 50, solarRadiation: 15,
    };
  }
}

/**
 * Get forecast with caching.
 *
 * @returns {Promise<Array|null>}
 */
export async function resolveForecast() {
  const cached = getCachedWeather('openmeteo_forecast');
  if (cached) {
    const ageMinutes = (Date.now() - new Date(cached.fetched_at).getTime()) / 60000;
    if (ageMinutes < CONFIG.api.openMeteo.cacheMinutes) {
      return JSON.parse(cached.data_json);
    }
  }

  try {
    const data = await getForecast();
    setCachedWeather('openmeteo_forecast', data);
    return data;
  } catch (err) {
    log(1, `Forecast unavailable: ${err.message}`);
    return cached ? JSON.parse(cached.data_json) : null;
  }
}
