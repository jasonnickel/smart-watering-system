// Soil moisture balance tracking per zone
// Tracks available water in inches, updated daily based on ET and rainfall.

import CONFIG from '../config.js';
import { calculateDailyET, adjustETForZone } from './et.js';
import { getETCorrection } from './tuning.js';

/**
 * Calculate total water-holding capacity for a zone in inches.
 *
 * @param {object} profile - Merged zone profile
 * @returns {number} Total available water capacity in inches
 */
export function totalCapacity(profile) {
  return profile.availableWaterCapacity * profile.rootDepthInches;
}

/**
 * Calculate dynamic allowed depletion based on temperature.
 * Hotter temps = lower allowed depletion (water sooner to reduce stress).
 *
 * @param {object} profile - Zone profile with allowedDepletion config
 * @param {number} temp - Current or forecast temperature in Fahrenheit
 * @returns {number} Allowed depletion fraction (0-1)
 */
export function dynamicAllowedDepletion(profile, temp) {
  const { min, max, tempThreshold } = profile.allowedDepletion;

  if (temp <= tempThreshold.low) return max;
  if (temp >= tempThreshold.high) return min;

  const ratio = (temp - tempThreshold.low) / (tempThreshold.high - tempThreshold.low);
  return max - ratio * (max - min);
}

/**
 * Calculate the trigger point (in inches) below which watering is needed.
 *
 * @param {object} profile - Zone profile
 * @param {number} temp - Temperature for dynamic depletion
 * @returns {number} Trigger level in inches
 */
export function triggerLevel(profile, temp) {
  const capacity = totalCapacity(profile);
  const depletion = dynamicAllowedDepletion(profile, temp);
  return capacity * (1.0 - depletion);
}

/**
 * Update soil moisture balance for all zones based on yesterday's weather.
 * Returns a new balances object (does not mutate input).
 *
 * @param {object} currentBalances - { [zoneId]: balanceInches }
 * @param {object} yesterdayWeather - Weather data for ET calculation
 * @param {Array} profiles - All managed zone profiles
 * @param {number} month - Current month (1-12)
 * @returns {object} Updated balances
 */
export function updateDailyBalances(currentBalances, yesterdayWeather, profiles, month) {
  const baseET = calculateDailyET(yesterdayWeather, month);
  const rain = Math.max(0, yesterdayWeather?.precipitation_sum ?? 0);
  const updated = { ...currentBalances };

  for (const profile of profiles) {
    const capacity = totalCapacity(profile);
    const current = updated[profile.id] ?? capacity * CONFIG.watering.initialMoistureLevel;
    const adjustedET = adjustETForZone(baseET, profile) * getETCorrection(profile.id);
    const newBalance = Math.max(0, Math.min(capacity, current - adjustedET + rain));
    updated[profile.id] = newBalance;
  }

  return updated;
}

/**
 * Project future moisture balances using forecast data.
 *
 * @param {object} currentBalances - Current balances
 * @param {Array} forecast - Array of forecast day objects
 * @param {Array} profiles - Zone profiles
 * @returns {object} { [zoneId]: [day1Balance, day2Balance, ...] }
 */
export function projectBalances(currentBalances, forecast, profiles) {
  if (!forecast || forecast.length === 0) return null;

  const projections = {};

  for (const profile of profiles) {
    const capacity = totalCapacity(profile);
    let balance = currentBalances[profile.id] ?? capacity * CONFIG.watering.initialMoistureLevel;
    projections[profile.id] = [];

    for (const day of forecast) {
      const parsedForecastMonth = typeof day.date === 'string'
        ? parseInt(day.date.slice(5, 7), 10)
        : (new Date(day.date).getUTCMonth() + 1);
      const forecastMonth = Number.isFinite(parsedForecastMonth)
        ? parsedForecastMonth
        : (new Date().getUTCMonth() + 1);
      const predictedET = calculateDailyET(day, forecastMonth);
      const adjustedET = adjustETForZone(predictedET, profile);
      balance = Math.max(0, balance - adjustedET + (day.precipitation ?? 0));
      projections[profile.id].push(balance);
    }
  }

  return projections;
}

/**
 * Calculate how many minutes of watering are needed to refill a zone to 90% capacity.
 *
 * @param {object} profile - Zone profile
 * @param {number} currentInches - Current moisture in inches
 * @returns {number} Required run time in minutes (clamped to min/max)
 */
export function requiredMinutes(profile, currentInches) {
  const capacity = totalCapacity(profile);
  const deficitInches = (capacity * 0.9) - currentInches;
  if (deficitInches <= 0) return 0;

  const requiredInches = deficitInches / CONFIG.watering.efficiencyFactor;
  const duration = Math.ceil(requiredInches / profile.inchesPerMinute);

  return Math.max(profile.minRunTimeMinutes, Math.min(profile.maxRunTimeMinutes, duration));
}

/**
 * Calculate inches added by a watering run.
 *
 * @param {number} durationMinutes - Run duration
 * @param {object} profile - Zone profile
 * @returns {number} Inches of water added to soil
 */
export function inchesAdded(durationMinutes, profile) {
  return durationMinutes * profile.inchesPerMinute * CONFIG.watering.efficiencyFactor;
}
