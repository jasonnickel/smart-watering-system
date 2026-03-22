import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  totalCapacity,
  dynamicAllowedDepletion,
  projectBalances,
  requiredMinutes,
  inchesAdded,
} from '../../src/core/soil-moisture.js';

// Mock profile matching zone 1 config
const lawnProfile = {
  type: 'lawn',
  sunExposure: 1.0,
  areaSqFt: 400,
  rootDepthInches: 6,
  baselineAWC: 0.17,
  availableWaterCapacity: 0.157, // after OM adjustment
  inchesPerMinute: 0.5 / 60,
  minRunTimeMinutes: 5,
  maxRunTimeMinutes: 50,
  allowedDepletion: {
    min: 0.35,
    max: 0.60,
    tempThreshold: { low: 65, high: 85 },
  },
};

describe('Soil Moisture - Capacity', () => {
  it('calculates total capacity from AWC and root depth', () => {
    const cap = totalCapacity(lawnProfile);
    assert.ok(Math.abs(cap - 0.942) < 0.01, `Expected ~0.942, got ${cap}`);
  });
});

describe('Soil Moisture - Dynamic Depletion', () => {
  it('returns max depletion at low temp', () => {
    const dep = dynamicAllowedDepletion(lawnProfile, 60);
    assert.equal(dep, 0.60);
  });

  it('returns min depletion at high temp', () => {
    const dep = dynamicAllowedDepletion(lawnProfile, 90);
    assert.equal(dep, 0.35);
  });

  it('interpolates at mid temp', () => {
    const dep = dynamicAllowedDepletion(lawnProfile, 75);
    assert.ok(dep > 0.35 && dep < 0.60, `Expected between 0.35-0.60, got ${dep}`);
  });
});

describe('Soil Moisture - Required Minutes', () => {
  it('returns zero when soil is full', () => {
    const cap = totalCapacity(lawnProfile);
    assert.equal(requiredMinutes(lawnProfile, cap), 0);
  });

  it('caps at max run time for severe deficit', () => {
    const minutes = requiredMinutes(lawnProfile, 0);
    assert.equal(minutes, lawnProfile.maxRunTimeMinutes);
  });

  it('enforces minimum run time', () => {
    const cap = totalCapacity(lawnProfile);
    // Tiny deficit that would calculate to < 5 minutes
    const minutes = requiredMinutes(lawnProfile, cap * 0.88);
    assert.ok(minutes >= lawnProfile.minRunTimeMinutes || minutes === 0);
  });
});

describe('Soil Moisture - Inches Added', () => {
  it('calculates water added from a run', () => {
    const added = inchesAdded(20, lawnProfile);
    // 20 min * (0.5/60) in/min * 0.85 efficiency
    const expected = 20 * (0.5 / 60) * 0.85;
    assert.ok(Math.abs(added - expected) < 0.001);
  });
});

describe('Soil Moisture - Forecast Projection', () => {
  it('uses each forecast day month when projecting ET across month boundaries', () => {
    const profile = { ...lawnProfile, id: 'zone-1' };
    const capacity = totalCapacity(profile);
    const forecast = [
      {
        date: '2026-03-31',
        tmax: 90,
        tmin: 70,
        humidity: 30,
        solarRadiation: 2,
        precipitation: 0,
      },
      {
        date: '2026-04-01',
        tmax: 90,
        tmin: 70,
        humidity: 30,
        solarRadiation: 2,
        precipitation: 0,
      },
    ];

    const projections = projectBalances({ 'zone-1': capacity }, forecast, [profile]);
    const [marchBalance, aprilBalance] = projections['zone-1'];
    const marchLoss = capacity - marchBalance;
    const aprilLoss = marchBalance - aprilBalance;

    assert.ok(aprilLoss > marchLoss, `Expected April ET loss (${aprilLoss}) to exceed March loss (${marchLoss})`);
  });
});
