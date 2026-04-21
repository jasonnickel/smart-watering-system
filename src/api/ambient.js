// Ambient Weather API client
// Fetches current conditions from personal weather station

import CONFIG from '../config.js';
import { fetchWithRetry } from './http.js';
import { log } from '../log.js';

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Fetch current weather from the Ambient Weather station.
 *
 * @returns {Promise<object>} { temp, humidity, windSpeed, solarRadiation, rainLast24h, hourlyRain, timestamp }
 * @throws {Error} If API call fails (caller handles fallback)
 */
export async function getCurrentWeather() {
  const { apiKey, appKey, macAddress } = CONFIG.api.ambientWeather;

  const url = `https://rt.ambientweather.net/v1/devices/${macAddress}`
    + `?apiKey=${apiKey}&applicationKey=${appKey}&limit=1`;

  const data = await fetchWithRetry(url, {}, 'AmbientWeather');
  const reading = Array.isArray(data) ? data[0] : data;

  if (!reading) {
    throw new Error('AmbientWeather: Empty response');
  }

  const result = {
    temp: reading.tempf ?? null,
    humidity: reading.humidity ?? null,
    windSpeed: asNumber(reading.windspeedmph),
    solarRadiation: asNumber(reading.solarradiation),
    rainLast24h: asNumber(reading['24hourrainin'] ?? reading.dailyrainin),
    hourlyRain: asNumber(reading.hourlyrainin),
    timestamp: new Date().toISOString(),
  };

  log(2, `AmbientWeather: ${result.temp}F, ${result.humidity}% RH, wind ${result.windSpeed} mph, hourly rain ${result.hourlyRain}"`);

  return result;
}

/**
 * Fetch a fresh (uncached) rain reading for real-time rain check.
 * Used between DECIDE and COMMAND to catch rain that started after the decision.
 *
 * @returns {Promise<{hourlyRain: number, dailyRain: number}>}
 */
export async function getLiveRainCheck() {
  const { apiKey, appKey, macAddress } = CONFIG.api.ambientWeather;

  const url = `https://rt.ambientweather.net/v1/devices/${macAddress}`
    + `?apiKey=${apiKey}&applicationKey=${appKey}&limit=1`;

  try {
    const data = await fetchWithRetry(url, {}, 'AmbientWeather-RainCheck');
    const reading = Array.isArray(data) ? data[0] : data;

    if (!reading) return null;

    return {
      hourlyRain: asNumber(reading.hourlyrainin),
      dailyRain: asNumber(reading['24hourrainin'] ?? reading.dailyrainin),
    };
  } catch (err) {
    log(1, `Live rain check failed: ${err.message}`);
    return null;
  }
}
