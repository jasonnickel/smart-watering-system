// Weather data coordinator with degraded-mode fallback,
// cross-validation (1.2), and data quality alerts (1.3)

import CONFIG from './config.js';
import { getCurrentWeather } from './api/ambient.js';
import { getYesterdayWeather, getForecast } from './api/openmeteo.js';
import {
  getCachedWeather, setCachedWeather,
  logWeatherDiscrepancy, logPrecipitationAudit,
  getSystemState, setSystemState,
} from './db/state.js';
import { log } from './log.js';
import { notify } from './notify.js';

const PRECIP_DISCREPANCY_THRESHOLD = 0.15; // inches

/**
 * Get current weather with degraded-mode fallback and quality alerts.
 * Priority: Ambient Weather station -> cached Ambient -> OpenMeteo -> defaults
 *
 * @returns {Promise<{data: object, source: string, stale: boolean}>}
 */
export async function resolveCurrentWeather() {
  // Try Ambient Weather station first
  try {
    const data = await getCurrentWeather();
    setCachedWeather('ambient', data);
    // Clear stale alert state since station is responding
    setSystemState('ambient_stale_alerted', '');
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

    // [1.3] Weather data quality alert - station is stale
    await alertWeatherStale(ageMinutes);
    log(1, `Ambient cache is stale (${Math.round(ageMinutes)} min old)`);
  } else {
    // No cache at all - station has never reported
    await alertWeatherStale(null);
  }

  // Try OpenMeteo forecast for today as fallback for current conditions
  try {
    const forecast = await getForecast();
    if (forecast?.[0]) {
      const today = forecast[0];
      const fallbackData = {
        temp: (today.tmax + today.tmin) / 2,
        humidity: today.humidity,
        windSpeed: 5,
        solarRadiation: today.solarRadiation,
        rainLast24h: 0, // Don't fabricate rain data from forecast
        hourlyRain: 0,
        timestamp: new Date().toISOString(),
      };
      log(1, 'DEGRADED MODE: Using OpenMeteo forecast as current weather proxy');
      return { data: fallbackData, source: 'openmeteo-fallback', stale: true };
    }
  } catch (err) {
    log(1, `OpenMeteo fallback also unavailable: ${err.message}`);
  }

  // Last resort: conservative defaults
  log(0, 'DEGRADED MODE: All weather sources unavailable, using conservative defaults');
  await notify('weather', 'critical', 'All Weather Sources Down',
    'Both Ambient Weather and OpenMeteo are unavailable. Using conservative defaults (85F, 30% humidity). Check your weather station and internet connectivity.');
  return {
    data: { ...CONFIG.degradedMode.defaults, hourlyRain: 0, timestamp: new Date().toISOString() },
    source: 'defaults',
    stale: true,
  };
}

/**
 * Get yesterday's weather with caching and precipitation cross-validation (1.2, 2.2).
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

  let openmeteoData = null;
  try {
    openmeteoData = await getYesterdayWeather(dateStr);
    setCachedWeather(cacheKey, openmeteoData);
  } catch (err) {
    log(1, `Yesterday weather unavailable: ${err.message}`);
    return {
      tmax: 85, tmin: 65, tavg: 75,
      precipitation_sum: 0, humidity: 50, solarRadiation: 15,
    };
  }

  // [1.2] Cross-validate precipitation against Ambient Weather's daily total
  const ambientCache = getCachedWeather('ambient');
  if (ambientCache && openmeteoData) {
    const ambientData = JSON.parse(ambientCache.data_json);
    const ambientRain = ambientData.rainLast24h ?? 0;
    const openmeteoRain = openmeteoData.precipitation_sum ?? 0;

    // [2.2] Log precipitation audit
    logPrecipitationAudit(dateStr, ambientRain, openmeteoRain, openmeteoData.precipitation_sum);

    const diff = Math.abs(ambientRain - openmeteoRain);
    if (diff > PRECIP_DISCREPANCY_THRESHOLD) {
      const usedValue = openmeteoData.precipitation_sum;
      logWeatherDiscrepancy(
        'precipitation',
        ambientRain,
        openmeteoRain,
        usedValue,
        `Discrepancy of ${diff.toFixed(2)}" between Ambient (${ambientRain.toFixed(2)}") and OpenMeteo (${openmeteoRain.toFixed(2)}")`
      );
      log(1, `WEATHER DISCREPANCY: Ambient rain=${ambientRain.toFixed(2)}", OpenMeteo rain=${openmeteoRain.toFixed(2)}" (diff=${diff.toFixed(2)}")`);
    }
  }

  return openmeteoData;
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

// --- Internal helpers ---

/**
 * [1.3] Send escalating alerts when the weather station is stale.
 * Throttled by alert level to avoid spam.
 */
async function alertWeatherStale(ageMinutes) {
  const lastAlertLevel = getSystemState('ambient_stale_alerted') || '';

  let severity, level;
  if (ageMinutes === null || ageMinutes >= 1440) {
    severity = 'critical';
    level = 'critical';
  } else if (ageMinutes >= 720) {
    severity = 'warning';
    level = 'warning';
  } else if (ageMinutes >= 240) {
    severity = 'info';
    level = 'info';
  } else {
    return; // Not stale enough to alert
  }

  // Only escalate, don't repeat the same level
  const levels = ['info', 'warning', 'critical'];
  if (levels.indexOf(level) <= levels.indexOf(lastAlertLevel)) return;

  const ageStr = ageMinutes != null ? `${Math.round(ageMinutes)} minutes` : 'never reported';

  await notify('weather', severity, 'Weather Station Offline',
    `Your Ambient Weather station has been offline for ${ageStr}. ` +
    `The system is using ${ageMinutes != null && ageMinutes < 1440 ? 'OpenMeteo forecast' : 'conservative defaults'} as a fallback. ` +
    'Check your station power and WiFi connection.');

  setSystemState('ambient_stale_alerted', level);
}
