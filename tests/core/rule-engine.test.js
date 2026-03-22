import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSkipConditions,
  calculateEmergencyTrigger,
  currentWindow,
} from '../../src/core/rule-engine.js';
import CONFIG from '../../src/config.js';

describe('Rule Engine - Skip Conditions', () => {
  const conditions = CONFIG.schedule.skipConditions;

  it('skips on high wind', () => {
    const weather = { temp: 80, windSpeed: 15, rainLast24h: 0 };
    const reasons = checkSkipConditions(weather, conditions);
    assert.ok(reasons.length > 0, 'Should have skip reasons');
    assert.ok(reasons[0].includes('Wind'));
  });

  it('skips on recent rain', () => {
    const weather = { temp: 80, windSpeed: 5, rainLast24h: 1.0 };
    const reasons = checkSkipConditions(weather, conditions);
    assert.ok(reasons.some(r => r.includes('Rain')));
  });

  it('skips on low temperature', () => {
    const weather = { temp: 35, windSpeed: 5, rainLast24h: 0 };
    const reasons = checkSkipConditions(weather, conditions);
    assert.ok(reasons.some(r => r.includes('Temp')));
  });

  it('does not skip in normal conditions', () => {
    const weather = { temp: 80, windSpeed: 5, rainLast24h: 0 };
    const reasons = checkSkipConditions(weather, conditions);
    assert.equal(reasons.length, 0);
  });
});

describe('Rule Engine - Emergency Trigger', () => {
  it('returns base trigger in moderate conditions', () => {
    const weather = { temp: 90, humidity: 50, solarRadiation: 400, windSpeed: 5 };
    const trigger = calculateEmergencyTrigger(weather);
    assert.equal(trigger, 95);
  });

  it('lowers trigger in extreme conditions', () => {
    const weather = { temp: 100, humidity: 15, solarRadiation: 700, windSpeed: 15 };
    const trigger = calculateEmergencyTrigger(weather);
    // -3 (solar) -3 (humidity) -2 (wind) = 87, but floor is 88
    assert.equal(trigger, 88);
  });

  it('never goes below 88', () => {
    const weather = { temp: 100, humidity: 5, solarRadiation: 900, windSpeed: 25 };
    const trigger = calculateEmergencyTrigger(weather);
    assert.ok(trigger >= 88, `Trigger ${trigger} should not go below 88`);
  });
});

describe('Rule Engine - Window Detection', () => {
  it('detects daily window at midnight', () => {
    assert.equal(currentWindow(0, 7), 'daily');
  });

  it('detects emergency window in summer afternoon', () => {
    assert.equal(currentWindow(10, 7), 'emergency');
  });

  it('blocks peak heat hours', () => {
    assert.equal(currentWindow(14, 7), 'none');
  });

  it('returns none in dormant months', () => {
    assert.equal(currentWindow(10, 1), 'none');
  });

  it('returns none outside all windows', () => {
    assert.equal(currentWindow(5, 7), 'none');
  });
});
