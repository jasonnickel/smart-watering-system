import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isHourAllowed,
  isRestrictionWindowActive,
  checkZoneRestriction,
  applyZoneRestrictions,
} from '../../src/core/restrictions.js';

const GOLDEN_STAGE_1 = {
  enabled: true,
  stage: 1,
  maxDaysPerWeek: 2,
  allowedHours: [{ start: 18, end: 10 }], // 6pm-10am
  exemptZoneTypes: ['drip'],
  allowedDays: [],
  effectiveFrom: '',
  effectiveUntil: '',
};

describe('Restrictions - hour windows', () => {
  it('allows hours inside a normal window', () => {
    assert.equal(isHourAllowed(12, [{ start: 6, end: 14 }]), true);
    assert.equal(isHourAllowed(14, [{ start: 6, end: 14 }]), false);
    assert.equal(isHourAllowed(5, [{ start: 6, end: 14 }]), false);
  });

  it('handles a window that wraps midnight', () => {
    const windows = [{ start: 18, end: 10 }];
    assert.equal(isHourAllowed(18, windows), true);
    assert.equal(isHourAllowed(22, windows), true);
    assert.equal(isHourAllowed(0, windows), true);
    assert.equal(isHourAllowed(9, windows), true);
    assert.equal(isHourAllowed(10, windows), false);
    assert.equal(isHourAllowed(15, windows), false);
    assert.equal(isHourAllowed(17, windows), false);
  });
});

describe('Restrictions - active window dates', () => {
  it('is inactive when disabled', () => {
    assert.equal(isRestrictionWindowActive({ ...GOLDEN_STAGE_1, enabled: false }), false);
  });

  it('respects effectiveFrom', () => {
    const future = new Date('2099-01-01T00:00:00Z').toISOString();
    const r = { ...GOLDEN_STAGE_1, effectiveFrom: future };
    assert.equal(isRestrictionWindowActive(r, new Date('2026-01-01')), false);
  });

  it('respects effectiveUntil', () => {
    const past = new Date('2000-01-01T00:00:00Z').toISOString();
    const r = { ...GOLDEN_STAGE_1, effectiveUntil: past };
    assert.equal(isRestrictionWindowActive(r, new Date('2026-01-01')), false);
  });

  it('is active inside the window', () => {
    const r = { ...GOLDEN_STAGE_1, effectiveFrom: '2025-01-01', effectiveUntil: '2099-12-31' };
    assert.equal(isRestrictionWindowActive(r, new Date('2026-06-15')), true);
  });
});

describe('Restrictions - per-zone checks', () => {
  const lawnZone = { id: 'zone-1', name: 'Front Lawn', type: 'lawn' };
  const dripZone = { id: 'zone-7', name: 'Drip Bed', type: 'drip' };

  it('exempts drip zones regardless of time or day count', () => {
    const midafternoon = new Date('2026-06-15T14:00:00-06:00'); // 2pm local
    const manyDates = new Set(['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12']);
    const result = checkZoneRestriction(dripZone, midafternoon, manyDates, GOLDEN_STAGE_1);
    assert.equal(result.allowed, true);
    assert.equal(result.meta.exempt, true);
  });

  it('blocks lawn zones outside allowed hours', () => {
    const midafternoon = new Date('2026-06-15T14:00:00-06:00'); // 2pm
    const result = checkZoneRestriction(lawnZone, midafternoon, new Set(), GOLDEN_STAGE_1);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Restricted hours/);
  });

  it('allows lawn zones in allowed hours with under-limit days', () => {
    const earlyMorning = new Date('2026-06-15T07:00:00-06:00'); // 7am
    const dates = new Set(['2026-06-14']); // only 1 day this week
    const result = checkZoneRestriction(lawnZone, earlyMorning, dates, GOLDEN_STAGE_1);
    assert.equal(result.allowed, true);
  });

  it('blocks when max days per week is reached', () => {
    const earlyMorning = new Date('2026-06-15T07:00:00-06:00');
    const dates = new Set(['2026-06-14', '2026-06-12']); // 2 days already used
    const result = checkZoneRestriction(lawnZone, earlyMorning, dates, GOLDEN_STAGE_1);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /Max 2 watering days/);
  });

  it('allows re-watering on a day already used this week', () => {
    const earlyMorning = new Date('2026-06-15T07:00:00-06:00');
    const dates = new Set(['2026-06-14', '2026-06-15']); // today already counted
    const result = checkZoneRestriction(lawnZone, earlyMorning, dates, GOLDEN_STAGE_1);
    assert.equal(result.allowed, true);
  });

  it('treats stage 3 (0 days/week) as total ban', () => {
    const stage3 = { ...GOLDEN_STAGE_1, stage: 3, maxDaysPerWeek: 0 };
    const earlyMorning = new Date('2026-06-15T07:00:00-06:00');
    const result = checkZoneRestriction(lawnZone, earlyMorning, new Set(), stage3);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /no watering permitted/);
  });

  it('when disabled, allows everything', () => {
    const off = { ...GOLDEN_STAGE_1, enabled: false };
    const midafternoon = new Date('2026-06-15T14:00:00-06:00');
    const result = checkZoneRestriction(lawnZone, midafternoon, new Set(), off);
    assert.equal(result.allowed, true);
  });
});

describe('Restrictions - batch filter', () => {
  it('splits allowed vs blocked zones with reasons', () => {
    const lawnA = { id: 'zone-1', name: 'Front A', type: 'lawn' };
    const lawnB = { id: 'zone-2', name: 'Front B', type: 'lawn' };
    const drip = { id: 'zone-7', name: 'Drip Bed', type: 'drip' };
    const earlyMorning = new Date('2026-06-15T07:00:00-06:00');

    const dates = new Map([
      ['zone-1', new Set()], // under limit
      ['zone-2', new Set(['2026-06-13', '2026-06-14'])], // at limit
      ['zone-7', new Set()],
    ]);

    const zones = [
      { id: 'zone-1', name: 'Front A', profile: lawnA },
      { id: 'zone-2', name: 'Front B', profile: lawnB },
      { id: 'zone-7', name: 'Drip Bed', profile: drip },
    ];

    const { allowedZones, blockedZones } = applyZoneRestrictions(zones, earlyMorning, dates, GOLDEN_STAGE_1);
    assert.equal(allowedZones.length, 2);
    assert.equal(blockedZones.length, 1);
    assert.equal(blockedZones[0].id, 'zone-2');
    assert.match(blockedZones[0].restrictionReason, /Max 2/);
  });
});
