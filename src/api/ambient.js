// Ambient Weather API client
// Fetches current conditions from personal weather station

import CONFIG from '../config.js';
import { fetchWithRetry } from './http.js';
import { log } from '../log.js';

/**
 * Fetch current weather from the Ambient Weather station.
 *
 * @returns {Promise<object>} { temp, humidity, windSpeed, solarRadiation, rainLast24h, timestamp }
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
    windSpeed: reading.windspeedmph ?? 0,
    solarRadiation: reading.solarradiation ?? 0,
    rainLast24h: reading.dailyrainin ?? 0,
    timestamp: new Date().toISOString(),
  };

  log(2, `AmbientWeather: ${result.temp}F, ${result.humidity}% RH, wind ${result.windSpeed} mph`);

  return result;
}
