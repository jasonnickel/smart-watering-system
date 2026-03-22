// OpenMeteo API client
// Fetches historical weather (yesterday) and multi-day forecast
// No authentication required - public API

import CONFIG from '../config.js';
import { fetchWithRetry } from './http.js';
import { log } from '../log.js';

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
