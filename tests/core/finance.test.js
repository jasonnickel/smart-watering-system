import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost, needsBillingReset, getCostBreakdown, getFixedCharges, getRateSchedule } from '../../src/core/finance.js';
import CONFIG from '../../src/config.js';

// Get the actual configured rates so tests stay correct if rates.yaml changes
const tier1Rate = CONFIG.finance.waterRates[0].ratePer1000Gal;
const tier2Rate = CONFIG.finance.waterRates[1].ratePer1000Gal;
const tier1Threshold = CONFIG.finance.waterRates[0].thresholdGallons;
const tier2Threshold = CONFIG.finance.waterRates[1].thresholdGallons;
const topRate = CONFIG.finance.waterRates[CONFIG.finance.waterRates.length - 1].ratePer1000Gal;

describe('Finance - Tiered Cost Calculations', () => {
  it('calculates tier 1 pricing correctly', () => {
    const cost = calculateCost(1000, 0);
    const expected = (1000 / 1000) * tier1Rate;
    assert.ok(Math.abs(cost - expected) < 0.01, `Expected ~${expected}, got ${cost}`);
  });

  it('crosses tier boundary correctly', () => {
    const gallons = tier1Threshold + 2000;
    const cost = calculateCost(gallons, 0);
    const expected = (tier1Threshold / 1000 * tier1Rate) + (2000 / 1000 * tier2Rate);
    assert.ok(Math.abs(cost - expected) < 0.01, `Expected ~${expected}, got ${cost}`);
  });

  it('handles top tier overflow', () => {
    const gallons = tier2Threshold + 5000;
    const cost = calculateCost(gallons, 0);
    const tier1Gallons = tier1Threshold;
    const tier2Gallons = tier2Threshold - tier1Threshold;
    const expected = (tier1Gallons / 1000 * tier1Rate) + (tier2Gallons / 1000 * tier2Rate) + (5000 / 1000 * topRate);
    assert.ok(Math.abs(cost - expected) < 0.01, `Expected ~${expected}, got ${cost}`);
  });

  it('accumulates across tiers with existing usage', () => {
    const startAt = tier1Threshold - 1000;
    const cost = calculateCost(2000, startAt);
    const expected = (1000 / 1000 * tier1Rate) + (1000 / 1000 * tier2Rate);
    assert.ok(Math.abs(cost - expected) < 0.01, `Expected ~${expected}, got ${cost}`);
  });

  it('handles zero gallons', () => {
    assert.equal(calculateCost(0, 0), 0);
  });
});

describe('Finance - Cost Breakdown', () => {
  it('breaks down usage by tier', () => {
    const breakdown = getCostBreakdown(tier1Threshold + 3000);
    assert.equal(breakdown.length, 2);
    assert.equal(breakdown[0].gallons, tier1Threshold);
    assert.equal(breakdown[1].gallons, 3000);
    assert.ok(breakdown[0].rate === tier1Rate);
    assert.ok(breakdown[1].rate === tier2Rate);
  });

  it('returns empty breakdown for zero usage', () => {
    const breakdown = getCostBreakdown(0);
    assert.equal(breakdown.length, 0);
  });
});

describe('Finance - Fixed Charges', () => {
  it('returns fixed monthly charges', () => {
    const charges = getFixedCharges();
    assert.ok(charges.waterBaseFee > 0);
    assert.ok(charges.total > 0);
    assert.equal(charges.total, charges.waterBaseFee + charges.wastewaterService + charges.drainage);
  });
});

describe('Finance - Rate Schedule', () => {
  it('returns rate schedule with provider info', () => {
    const schedule = getRateSchedule();
    assert.ok(schedule.provider.length > 0);
    assert.ok(schedule.tiers.length >= 2);
    assert.ok(schedule.awcGallons >= 5000);
  });
});

describe('Finance - Billing Cycle Reset', () => {
  it('resets when no prior reset exists', () => {
    assert.ok(needsBillingReset(null, new Date()));
  });

  it('does not reset within the same month', () => {
    const now = new Date('2026-03-26T12:00:00.000Z');
    const lastReset = '2026-03-25T00:00:00.000Z';
    assert.ok(!needsBillingReset(lastReset, now));
  });

  it('resets in a new month past the cycle day', () => {
    const lastReset = '2026-02-25T00:00:00.000Z';
    const now = new Date('2026-03-26T12:00:00.000Z');
    assert.ok(needsBillingReset(lastReset, now));
  });
});
