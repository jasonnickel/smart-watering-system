// Tiered water cost calculations
// Supports AWC-based tier structures (like City of Golden, CO).
// Rate configuration loaded from rates.yaml at startup.

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
 * Get a cost breakdown showing which tier each gallon falls into.
 * Useful for the dashboard and briefing to show tier placement.
 *
 * @param {number} totalGallons - Total gallons used this billing cycle
 * @returns {Array<{name: string, gallons: number, rate: number, cost: number}>}
 */
export function getCostBreakdown(totalGallons) {
  const rates = [...CONFIG.finance.waterRates].sort(
    (a, b) => a.thresholdGallons - b.thresholdGallons
  );

  const breakdown = [];
  let remaining = totalGallons;
  let previousThreshold = 0;

  for (const tier of rates) {
    if (remaining <= 0) break;

    const tierCapacity = tier.thresholdGallons - previousThreshold;
    if (tierCapacity <= 0) continue;

    const gallonsInTier = Math.min(remaining, tierCapacity);
    breakdown.push({
      name: tier.name || `Tier (up to ${tier.thresholdGallons} gal)`,
      gallons: gallonsInTier,
      rate: tier.ratePer1000Gal,
      cost: (gallonsInTier / 1000) * tier.ratePer1000Gal,
    });

    remaining -= gallonsInTier;
    previousThreshold = tier.thresholdGallons;
  }

  if (remaining > 0) {
    const topRate = rates[rates.length - 1];
    breakdown.push({
      name: topRate.name || 'Top tier (overflow)',
      gallons: remaining,
      rate: topRate.ratePer1000Gal,
      cost: (remaining / 1000) * topRate.ratePer1000Gal,
    });
  }

  return breakdown;
}

/**
 * Get the monthly fixed charges that apply regardless of water usage.
 *
 * @returns {{ waterBaseFee: number, wastewaterService: number, drainage: number, total: number }}
 */
export function getFixedCharges() {
  const charges = CONFIG.finance.fixedCharges || {};
  const waterBaseFee = charges.waterBaseFee || 0;
  const wastewaterService = charges.wastewaterService || 0;
  const drainage = charges.drainage || 0;
  return {
    waterBaseFee,
    wastewaterService,
    drainage,
    total: waterBaseFee + wastewaterService + drainage,
  };
}

/**
 * Get the rate schedule summary for display.
 *
 * @returns {{ provider: string, effectiveDate: string, awcGallons: number, tiers: Array, fixedTotal: number }}
 */
export function getRateSchedule() {
  return {
    provider: CONFIG.finance.provider || 'Unknown',
    effectiveDate: CONFIG.finance.effectiveDate || '',
    awcGallons: CONFIG.finance.awcGallons || 5000,
    tiers: CONFIG.finance.waterRates.map(t => ({
      name: t.name,
      thresholdGallons: t.thresholdGallons,
      ratePer1000Gal: t.ratePer1000Gal,
    })),
    fixedCharges: getFixedCharges(),
  };
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
