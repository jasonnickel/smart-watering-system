import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost, needsBillingReset } from '../../src/core/finance.js';

describe('Finance - Tiered Cost Calculations', () => {
  it('calculates tier 1 pricing correctly', () => {
    const cost = calculateCost(1000, 0);
    assert.ok(Math.abs(cost - 6.06) < 0.01, `Expected ~6.06, got ${cost}`);
  });

  it('crosses tier boundary correctly', () => {
    // 7000 gallons from 0: 5000 at $6.06/1000 + 2000 at $7.89/1000
    const cost = calculateCost(7000, 0);
    const expected = (5000 / 1000 * 6.06) + (2000 / 1000 * 7.89);
    assert.ok(Math.abs(cost - expected) < 0.01, `Expected ~${expected}, got ${cost}`);
  });

  it('handles top tier overflow', () => {
    // 25000 gallons: 5000@6.06 + 15000@7.89 + 5000@7.89 (top rate continues)
    const cost = calculateCost(25000, 0);
    const expected = (5000 / 1000 * 6.06) + (15000 / 1000 * 7.89) + (5000 / 1000 * 7.89);
    assert.ok(Math.abs(cost - expected) < 0.01, `Expected ~${expected}, got ${cost}`);
  });

  it('accumulates across tiers with existing usage', () => {
    // 2000 gallons starting at 4000 cumulative
    // 1000 remaining in tier 1 @ $6.06 + 1000 in tier 2 @ $7.89
    const cost = calculateCost(2000, 4000);
    const expected = (1000 / 1000 * 6.06) + (1000 / 1000 * 7.89);
    assert.ok(Math.abs(cost - expected) < 0.01, `Expected ~${expected}, got ${cost}`);
  });

  it('handles zero gallons', () => {
    assert.equal(calculateCost(0, 0), 0);
  });
});

describe('Finance - Billing Cycle Reset', () => {
  it('resets when no prior reset exists', () => {
    assert.ok(needsBillingReset(null, new Date()));
  });

  it('does not reset within the same month before cycle day', () => {
    // Billing cycle starts on the 15th
    const lastReset = '2026-03-15T00:00:00.000Z';
    const now = new Date('2026-03-20T12:00:00.000Z');
    assert.ok(!needsBillingReset(lastReset, now));
  });

  it('resets in a new month past the cycle day', () => {
    const lastReset = '2026-02-15T00:00:00.000Z';
    const now = new Date('2026-03-16T12:00:00.000Z');
    assert.ok(needsBillingReset(lastReset, now));
  });
});
