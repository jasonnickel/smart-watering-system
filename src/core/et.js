// Evapotranspiration calculations using simplified Penman-Monteith (Hargreaves variant)
// All inputs in imperial units. Output in inches/day.

import CONFIG from '../config.js';

/**
 * Calculate reference ET (ET0) from daily weather data.
 * Uses Hargreaves equation with humidity and seasonal correction.
 *
 * @param {object} weather - { tmax, tmin, tavg, humidity, solarRadiation }
 *   tmax/tmin/tavg in Fahrenheit, humidity in %, solarRadiation in MJ/m2/day
 * @param {number} month - 1-12
 * @returns {number} ET0 in inches/day
 */
export function calculateDailyET(weather, month) {
  if (!weather) return 0.15;

  const tAvg = weather.tavg ?? (weather.tmax + weather.tmin) / 2;
  if (Number.isNaN(tAvg)) return 0.15;

  const tAvgC = (tAvg - 32) * 5 / 9;
  const ra = weather.solarRadiation ?? 15.0;
  const tempRange = (weather.tmax ?? 85) - (weather.tmin ?? 65);

  // Hargreaves ET0 estimate (mm/day), converted to inches via 0.408 factor
  const et0 = 0.0023 * ra * Math.sqrt(Math.max(0, tempRange)) * (tAvgC + 17.8) * 0.408;

  // Humidity correction: drier air = more ET
  const humidityFactor = weather.humidity != null
    ? (100 - weather.humidity) / 100
    : 0.5;

  const baseET = Math.max(0.05, Math.min(0.35, et0 * (0.5 + 0.5 * humidityFactor)));

  const seasonalFactor = CONFIG.watering.seasonalAdjustment[month] ?? 1.0;

  return baseET * seasonalFactor;
}

/**
 * Calculate zone-adjusted ET based on sun exposure and irrigation type.
 *
 * @param {number} baseET - Reference ET0 in inches/day
 * @param {object} profile - Zone profile with sunExposure and type
 * @returns {number} Adjusted ET in inches/day
 */
export function adjustETForZone(baseET, profile) {
  const sunFactor = profile.sunExposure ?? 1.0;
  const typeFactor = profile.type === 'drip' ? 0.7 : 1.0;
  return baseET * sunFactor * typeFactor;
}
