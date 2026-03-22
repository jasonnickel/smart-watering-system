// Tiered water cost calculations
// Tracks cumulative usage within billing cycles for accurate tier placement.

import CONFIG from '../config.js';

/**
 * Calculate cost for a given number of gallons, accounting for current billing position.
 *
 * @param {number} gallons - Gallons to price
 * @param {number} cumulativeGallons - Gallons already used this billing cycle
 * @returns {number} Cost in dollars
 */
export function calculateCost(gallons, cumulativeGallons) {
  const rates = [...CONFIG.finance.waterRates].sort(
    (a, b) => a.thresholdGallons - b.thresholdGallons
  );

  let cost = 0;
  let remaining = gallons;
  let cumulative = cumulativeGallons;
  let previousThreshold = 0;

  for (const tier of rates) {
    if (remaining <= 0) break;

    const tierCapacity = tier.thresholdGallons - previousThreshold;
    if (tierCapacity <= 0) continue;

    const usedInTier = Math.max(0, cumulative - previousThreshold);
    const availableInTier = Math.max(0, tierCapacity - usedInTier);
    const gallonsInThisTier = Math.min(remaining, availableInTier);

    if (gallonsInThisTier > 0) {
      cost += (gallonsInThisTier / 1000) * tier.ratePer1000Gal;
      remaining -= gallonsInThisTier;
      cumulative += gallonsInThisTier;
    }

    previousThreshold = tier.thresholdGallons;
  }

  // Anything beyond the highest tier uses the top rate
  if (remaining > 0) {
    cost += (remaining / 1000) * rates[rates.length - 1].ratePer1000Gal;
  }

  return cost;
}

/**
 * Check if a billing cycle reset is needed.
 *
 * @param {string|null} lastReset - ISO date string of last reset
 * @param {Date} now - Current date
 * @returns {boolean}
 */
export function needsBillingReset(lastReset, now) {
  if (!lastReset) return true;

  const last = new Date(lastReset);
  const sameMonth = last.getFullYear() === now.getFullYear()
    && last.getMonth() === now.getMonth();

  if (sameMonth) return false;

  return now.getDate() >= CONFIG.finance.billingCycleStartDay;
}
