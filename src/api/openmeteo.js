// OpenMeteo API client
// Fetches historical weather (yesterday) and multi-day forecast
// No authentication required - public API

import CONFIG from '../config.js';
import { fetchWithRetry } from './http.js';
import { log } from '../log.js';
import { saveWeatherDay } from '../db/state.js';

/**
 * Fetch yesterday's weather for ET calculation.
 *
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Promise<object>} { tmax, tmin, tavg, precipitation_sum, humidity, solarRadiation }
 */
export async function getYesterdayWeather(dateStr) {
  const { lat, lon, timezone } = CONFIG.location;

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    start_date: dateStr,
    end_date: dateStr,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_mean,shortwave_radiation_sum',
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'inch',
    timezone,
  });

  const url = `https://archive-api.open-meteo.com/v1/archive?${params}`;
  const data = await fetchWithRetry(url, {}, 'OpenMeteo-Archive');
  const daily = data.daily;

  if (!daily?.temperature_2m_max?.[0]) {
    throw new Error('OpenMeteo: No historical data returned');
  }

  const tmax = daily.temperature_2m_max[0];
  const tmin = daily.temperature_2m_min[0];

  const result = {
    tmax,
    tmin,
    tavg: (tmax + tmin) / 2,
    precipitation_sum: daily.precipitation_sum[0] ?? 0,
    humidity: daily.relative_humidity_2m_mean?.[0] ?? 50,
    solarRadiation: daily.shortwave_radiation_sum[0] ?? 15,
  };

  log(2, `OpenMeteo yesterday: high ${result.tmax}F, low ${result.tmin}F, rain ${result.precipitation_sum}"`);

  // Persist to weather history
  try {
    saveWeatherDay(dateStr, 'openmeteo', {
      tempMax: result.tmax, tempMin: result.tmin, tempAvg: result.tavg,
      humidity: result.humidity, precipitation: result.precipitation_sum,
      solarRadiation: result.solarRadiation,
    });
  } catch { /* DB may not be initialized */ }

  return result;
}

/**
 * Fetch 4-day forecast.
 *
 * @returns {Promise<Array>} Array of { date, tmax, tmin, humidity, precipitation, solarRadiation }
 */
export async function getForecast() {
  const { lat, lon, timezone } = CONFIG.location;

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    daily: 'temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,precipitation_sum,shortwave_radiation_sum',
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'inch',
    timezone,
    forecast_days: '4',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const data = await fetchWithRetry(url, {}, 'OpenMeteo-Forecast');
  const daily = data.daily;

  if (!daily?.time?.length) {
    throw new Error('OpenMeteo: No forecast data returned');
  }

  const days = [];
  for (let i = 0; i < daily.time.length && i < 4; i++) {
    days.push({
      date: daily.time[i],
      tmax: daily.temperature_2m_max[i],
      tmin: daily.temperature_2m_min[i],
      humidity: daily.relative_humidity_2m_mean[i],
      precipitation: daily.precipitation_sum[i],
      solarRadiation: daily.shortwave_radiation_sum[i],
    });
  }

  log(2, `OpenMeteo forecast: ${days.length} days loaded`);

  return days;
}

/**
 * Fetch a range of historical daily weather and persist to weather_history.
 * OpenMeteo archive API supports ranges up to several years in a single call.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {Promise<number>} Number of days saved
 */
export async function getHistoricalWeather(startDate, endDate) {
  const { lat, lon, timezone } = CONFIG.location;

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    start_date: startDate,
    end_date: endDate,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_mean,shortwave_radiation_sum,wind_speed_10m_max,wind_gusts_10m_max,et0_fao_evapotranspiration',
    temperature_unit: 'fahrenheit',
    precipitation_unit: 'inch',
    wind_speed_unit: 'mph',
    timezone,
  });

  const url = `https://archive-api.open-meteo.com/v1/archive?${params}`;
  const data = await fetchWithRetry(url, {}, 'OpenMeteo-Archive');
  const daily = data.daily;

  if (!daily?.time?.length) {
    throw new Error('OpenMeteo: No historical data returned');
  }

  let saved = 0;
  for (let i = 0; i < daily.time.length; i++) {
    const tmax = daily.temperature_2m_max[i];
    const tmin = daily.temperature_2m_min[i];
    try {
      saveWeatherDay(daily.time[i], 'openmeteo', {
        tempMax: tmax,
        tempMin: tmin,
        tempAvg: (tmax + tmin) / 2,
        humidity: daily.relative_humidity_2m_mean?.[i] ?? null,
        precipitation: daily.precipitation_sum?.[i] ?? null,
        solarRadiation: daily.shortwave_radiation_sum?.[i] ?? null,
        windSpeed: daily.wind_speed_10m_max?.[i] ?? null,
        windGust: daily.wind_gusts_10m_max?.[i] ?? null,
        etReference: daily.et0_fao_evapotranspiration?.[i] ?? null,
      });
      saved++;
    } catch {
      // Skip duplicates (INSERT OR REPLACE handles this, but catch other errors)
    }
  }

  log(1, `OpenMeteo historical: ${saved} days saved (${startDate} to ${endDate})`);
  return saved;
}

/**
 * Backfill historical weather data in 90-day chunks.
 *
 * @param {object} options
 * @param {number} [options.years] - How many years back (default: 2)
 * @returns {Promise<number>} Total days saved
 */
export async function backfillWeatherHistory(options = {}) {
  const years = options.years || 2;
  const endDate = new Date(Date.now() - 86400000); // yesterday
  const startDate = new Date(endDate.getTime() - years * 365 * 86400000);
  const chunkDays = 90;
  let totalSaved = 0;

  log(1, `Weather backfill: fetching ${years} years (${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)})`);

  let chunkStart = new Date(startDate);
  while (chunkStart < endDate) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + chunkDays * 86400000, endDate.getTime()));
    try {
      const saved = await getHistoricalWeather(
        chunkStart.toISOString().slice(0, 10),
        chunkEnd.toISOString().slice(0, 10)
      );
      totalSaved += saved;
      log(1, `Weather backfill: ${saved} days for ${chunkStart.toISOString().slice(0, 10)} to ${chunkEnd.toISOString().slice(0, 10)}`);
    } catch (err) {
      log(0, `Weather backfill chunk failed: ${err.message}`);
    }
    // Small delay between chunks to be kind to the API
    await new Promise(resolve => setTimeout(resolve, 500));
    chunkStart = new Date(chunkEnd.getTime() + 86400000);
  }

  log(1, `Weather backfill complete: ${totalSaved} total days`);
  return totalSaved;
}
