import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDailyET, adjustETForZone } from '../../src/core/et.js';

describe('ET Calculations', () => {
  it('returns default ET when no weather data provided', () => {
    assert.equal(calculateDailyET(null, 6), 0.15);
  });

  it('returns zero in dormant months (seasonal factor = 0)', () => {
    const weather = { tmax: 85, tmin: 65, humidity: 50, solarRadiation: 15 };
    const et = calculateDailyET(weather, 1); // January
    assert.equal(et, 0);
  });

  it('produces higher ET in hot, dry conditions', () => {
    // Use low solar radiation to stay below the 0.35 base ET cap
    const hot = { tmax: 90, tmin: 70, humidity: 30, solarRadiation: 2 };
    const mild = { tmax: 65, tmin: 50, humidity: 70, solarRadiation: 1 };

    const etHot = calculateDailyET(hot, 6); // June, factor 1.1
    const etMild = calculateDailyET(mild, 6);

    assert.ok(etHot > etMild, `Hot ET (${etHot}) should exceed mild ET (${etMild})`);
  });

  it('stays within reasonable bounds (0.05 - 0.35 base)', () => {
    const extreme = { tmax: 110, tmin: 80, humidity: 10, solarRadiation: 30 };
    const et = calculateDailyET(extreme, 7); // July, factor 1.1

    // base capped at 0.35, times 1.1 seasonal = max 0.385
    assert.ok(et > 0, 'ET should be positive');
    assert.ok(et <= 0.4, `ET ${et} exceeds reasonable maximum`);
  });

  it('adjusts ET for zone sun exposure', () => {
    const fullSun = adjustETForZone(0.2, { sunExposure: 1.0, type: 'lawn' });
    const shade = adjustETForZone(0.2, { sunExposure: 0.6, type: 'lawn' });

    assert.ok(fullSun > shade, 'Full sun ET should exceed shade ET');
    assert.equal(fullSun, 0.2);
    assert.equal(shade, 0.12);
  });

  it('reduces ET for drip zones', () => {
    const lawn = adjustETForZone(0.2, { sunExposure: 1.0, type: 'lawn' });
    const drip = adjustETForZone(0.2, { sunExposure: 1.0, type: 'drip' });

    assert.equal(lawn, 0.2);
    assert.ok(Math.abs(drip - 0.14) < 0.001, `Expected ~0.14, got ${drip}`);
  });
});
