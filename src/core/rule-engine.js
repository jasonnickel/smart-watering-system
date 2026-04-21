// 5-stage watering decision engine
// safety -> forecast -> needs -> budget -> scheduling
// Pure function: takes context, returns decision. No side effects.

import CONFIG from '../config.js';
import { parseStoredTimestamp } from '../time.js';
import {
  totalCapacity,
  triggerLevel,
  requiredMinutes,
  projectBalances,
} from './soil-moisture.js';
import { buildSoakSchedule } from './soak.js';
import { calculateCost } from './finance.js';
import {
  isRestrictionWindowActive,
  isHourAllowed,
  applyZoneRestrictions,
} from './restrictions.js';

/**
 * Make a daily watering decision.
 *
 * @param {object} ctx - Execution context
 * @param {object} ctx.weather - Current weather conditions
 * @param {Array}  ctx.forecast - Multi-day forecast array
 * @param {object} ctx.soilMoisture - { [zoneId]: balanceInches }
 * @param {Array}  ctx.profiles - Managed zone profiles
 * @param {object} ctx.financeData - { cumulativeGallons }
 * @param {object} ctx.dailyUsage - { gallons, cost }
 * @param {object} ctx.fertilizerLog - { [zoneId]: isoTimestamp }
 * @returns {object} { decision: 'WATER'|'SKIP', reason, zones?, gallons?, cost? }
 */
export function getWateringDecision(ctx) {
  const now = ctx.now || new Date();

  // Stage 0: Municipal water restrictions (global hour check)
  const restrictionSkip = checkGlobalRestrictions(now, ctx.restrictions);
  if (restrictionSkip) {
    return { decision: 'SKIP', reason: restrictionSkip };
  }

  // Stage 1: Safety checks
  const skipReasons = checkSkipConditions(ctx.weather, CONFIG.schedule.skipConditions);
  if (skipReasons.length > 0) {
    return { decision: 'SKIP', reason: `Current Conditions - ${skipReasons.join(', ')}` };
  }

  // Stage 2: Forecast check
  const forecastSkip = checkForecastSkip(ctx.forecast?.[0]);
  if (forecastSkip) {
    return { decision: 'SKIP', reason: `Forecast - ${forecastSkip}` };
  }

  // Stage 3: Soil moisture needs
  const { zonesToWater, reason } = assessWateringNeeds(ctx);
  if (zonesToWater.length === 0) {
    return { decision: 'SKIP', reason: 'No zones require watering' };
  }

  // Stage 3.5: Per-zone restriction filter (days-per-week, allowed days, type exemption)
  const filtered = applyPerZoneRestrictions(zonesToWater, now, ctx);
  if (filtered.allowedZones.length === 0) {
    const blockedNames = filtered.blockedZones.map(z => `${z.name} (${z.restrictionReason})`).join('; ');
    return {
      decision: 'SKIP',
      reason: `Water restrictions blocked all zones: ${blockedNames}`,
      blockedZones: filtered.blockedZones,
    };
  }

  // Sort by urgency score (lower = more urgent)
  filtered.allowedZones.sort((a, b) => a.score - b.score);
  const activeZones = filtered.allowedZones;

  // Stage 4: Budget check
  const totals = calculateRunTotals(activeZones, ctx.financeData.cumulativeGallons);

  if (ctx.dailyUsage.gallons + totals.gallons > CONFIG.schedule.maxDailyGallons) {
    return { decision: 'SKIP', reason: 'Budget - Daily gallon limit exceeded' };
  }
  if (ctx.dailyUsage.cost + totals.cost > CONFIG.schedule.maxDailyCost) {
    return { decision: 'SKIP', reason: 'Budget - Daily cost limit exceeded' };
  }

  // Stage 5: Build schedule with soak cycles
  const schedule = buildSoakSchedule(activeZones);

  const blockedNote = filtered.blockedZones.length > 0
    ? ` (restriction-blocked: ${filtered.blockedZones.map(z => z.name).join(', ')})`
    : '';

  return {
    decision: 'WATER',
    reason: reason + blockedNote,
    zones: schedule,
    originalZones: activeZones,
    blockedZones: filtered.blockedZones,
    gallons: totals.gallons,
    cost: totals.cost,
  };
}

/**
 * Make an emergency cooling decision.
 *
 * @param {object} ctx - Same context as getWateringDecision plus lastCoolingTime
 * @returns {object} Decision object
 */
export function getEmergencyCoolingDecision(ctx) {
  const now = ctx.now || new Date();

  // Municipal water restrictions apply to emergency cooling too.
  const restrictionSkip = checkGlobalRestrictions(now, ctx.restrictions);
  if (restrictionSkip) {
    return { decision: 'SKIP', reason: `Cooling ${restrictionSkip}` };
  }

  const skipReasons = checkSkipConditions(ctx.weather, CONFIG.emergency.skipConditions);
  if (skipReasons.length > 0) {
    return { decision: 'SKIP', reason: `Cooling Skip - ${skipReasons.join(', ')}` };
  }

  // Enforce cooling interval
  if (ctx.lastCoolingTime) {
    const lastCoolingTime = parseStoredTimestamp(ctx.lastCoolingTime);
    const elapsed = lastCoolingTime
      ? (Date.now() - lastCoolingTime.getTime()) / 60000
      : Number.POSITIVE_INFINITY;
    if (elapsed < CONFIG.schedule.coolingIntervalMinutes) {
      return { decision: 'SKIP', reason: 'Cooling interval not elapsed' };
    }
  }

  // Check temperature against dynamic trigger
  const triggerTemp = calculateEmergencyTrigger(ctx.weather);
  if (ctx.weather.temp < triggerTemp) {
    return {
      decision: 'SKIP',
      reason: `Temp ${ctx.weather.temp.toFixed(1)}F below trigger ${triggerTemp.toFixed(1)}F`,
    };
  }

  const duration = ctx.weather.temp >= CONFIG.emergency.triggers.severe
    ? CONFIG.emergency.durations.severe
    : CONFIG.emergency.durations.default;

  // Only cool lawn zones that have a moisture deficit
  const zonesToCool = ctx.profiles
    .filter(p => p.type === 'lawn')
    .filter(p => {
      const capacity = totalCapacity(p);
      const current = ctx.soilMoisture[p.id] ?? capacity * CONFIG.watering.initialMoistureLevel;
      const trigger = triggerLevel(p, ctx.weather.temp);
      return current < trigger;
    })
    .map(p => ({
      id: p.id,
      name: p.name,
      duration,
      gallons: p.gallonsPerMinute * duration,
      priority: p.priority,
      profile: p,
    }));

  if (zonesToCool.length === 0) {
    return { decision: 'SKIP', reason: 'No lawn zones need cooling' };
  }

  // Per-zone restriction filter also applies to cooling runs.
  const filteredCool = applyPerZoneRestrictions(zonesToCool, now, ctx);
  if (filteredCool.allowedZones.length === 0) {
    const blockedNames = filteredCool.blockedZones.map(z => `${z.name} (${z.restrictionReason})`).join('; ');
    return { decision: 'SKIP', reason: `Cooling blocked by restrictions: ${blockedNames}` };
  }
  const activeCoolZones = filteredCool.allowedZones;

  const totals = calculateRunTotals(activeCoolZones, ctx.financeData.cumulativeGallons);

  if (ctx.dailyUsage.gallons + totals.gallons > CONFIG.schedule.maxDailyGallons) {
    return { decision: 'SKIP', reason: 'Budget - Daily gallon limit exceeded' };
  }

  return {
    decision: 'WATER',
    reason: `Emergency Cooling (Temp: ${ctx.weather.temp.toFixed(1)}F)`,
    zones: activeCoolZones,
    originalZones: activeCoolZones,
    blockedZones: filteredCool.blockedZones,
    gallons: totals.gallons,
    cost: totals.cost,
  };
}

/**
 * Global restriction gate - returns a skip reason string, or null if allowed.
 * Blocks the entire run when the current hour is outside allowed windows.
 */
function checkGlobalRestrictions(now, restrictions) {
  if (!restrictions || !isRestrictionWindowActive(restrictions, now)) return null;
  const hour = now.getHours();
  if (!isHourAllowed(hour, restrictions.allowedHours)) {
    return `Restricted hours (stage ${restrictions.stage}) - hour ${hour} not in allowed windows`;
  }
  return null;
}

function applyPerZoneRestrictions(zones, now, ctx) {
  if (!ctx.restrictions || !isRestrictionWindowActive(ctx.restrictions, now)) {
    return { allowedZones: zones, blockedZones: [] };
  }
  const wateringDatesByZone = ctx.wateringDatesByZone || new Map();
  return applyZoneRestrictions(zones, now, wateringDatesByZone, ctx.restrictions);
}

// --- Internal helpers ---

export function checkSkipConditions(weather, conditions) {
  const reasons = [];
  if (weather.windSpeed > conditions.windMph) {
    reasons.push(`High Wind (${weather.windSpeed.toFixed(1)} mph)`);
  }
  if (weather.rainLast24h > conditions.rainInches) {
    reasons.push(`Recent Rain (${weather.rainLast24h.toFixed(2)}")`);
  }
  if (weather.temp < conditions.lowTemp) {
    reasons.push(`Low Temp (${weather.temp.toFixed(1)}F)`);
  }
  return reasons;
}

function checkForecastSkip(dayForecast) {
  if (!dayForecast) return null;
  if (dayForecast.precipitation >= CONFIG.watering.forecast.rainSkipThresholdInches) {
    return `Rain Forecasted (${dayForecast.precipitation.toFixed(2)}")`;
  }
  return null;
}

function assessWateringNeeds(ctx) {
  let reason = 'Daily Soil Moisture Run';
  const zonesToWater = [];
  const projections = projectBalances(ctx.soilMoisture, ctx.forecast, ctx.profiles);

  for (const profile of ctx.profiles) {
    if (isFertilizerGuardActive(profile.id, ctx.fertilizerLog)) continue;

    const capacity = totalCapacity(profile);
    const currentInches = ctx.soilMoisture[profile.id]
      ?? capacity * CONFIG.watering.initialMoistureLevel;

    const avgTemp = ctx.forecast?.[0]
      ? (ctx.forecast[0].tmax + ctx.forecast[0].tmin) / 2
      : ctx.weather.temp;
    const trigger = triggerLevel(profile, avgTemp);

    let minutes = 0;

    if (currentInches < trigger) {
      // Zone needs water now
      minutes = requiredMinutes(profile, currentInches);
    } else if (CONFIG.watering.proactive.enabled && projections) {
      // Check if zone will need water in the near future
      const dayIndex = CONFIG.watering.proactive.waterBeforeDepletionDays - 1;
      const projected = projections[profile.id]?.[dayIndex];
      if (projected != null && projected < trigger) {
        minutes = requiredMinutes(profile, currentInches);
        if (minutes > 0) reason = 'Proactive Watering (Forecast)';
      }
    }

    if (minutes > 0) {
      zonesToWater.push({
        id: profile.id,
        name: profile.name,
        duration: minutes,
        gallons: profile.gallonsPerMinute * minutes,
        priority: profile.priority ?? 99,
        profile,
        score: wateringScore(profile, currentInches, trigger, capacity),
      });
    }
  }

  return { zonesToWater, reason };
}

function wateringScore(profile, currentInches, trigger, capacity) {
  const staticPriority = profile.priority ?? 99;
  if (capacity <= 0) return staticPriority;
  const deficitRatio = (trigger - currentInches) / capacity;
  const sunFactor = (profile.sunExposure - 1.0) * 2;
  return staticPriority - (deficitRatio * 10) + sunFactor;
}

function isFertilizerGuardActive(zoneId, fertilizerLog) {
  if (!fertilizerLog?.[zoneId]) return false;
  const guardMs = CONFIG.agronomy.nutrientLeachingGuardDays * 86400000;
  const appliedAt = parseStoredTimestamp(fertilizerLog[zoneId]);
  if (!appliedAt) return false;
  return (Date.now() - appliedAt.getTime()) < guardMs;
}

function calculateRunTotals(zones, cumulativeGallons) {
  const gallons = zones.reduce((sum, z) => sum + z.gallons, 0);
  const cost = calculateCost(gallons, cumulativeGallons);
  return { gallons, cost };
}

export function calculateEmergencyTrigger(weather) {
  const adj = CONFIG.emergency.triggers.adjustments;
  let adjustment = 0;

  if (weather.solarRadiation > adj.highSolar.threshold) adjustment += adj.highSolar.adjustment;
  if (weather.humidity < adj.lowHumidity.threshold) adjustment += adj.lowHumidity.adjustment;
  if (weather.windSpeed > adj.highWind.threshold) adjustment += adj.highWind.adjustment;

  return Math.max(CONFIG.emergency.triggers.base + adjustment, 88);
}

/**
 * Determine which scheduling window the current hour falls into.
 *
 * @param {number} hour - Current hour (0-23)
 * @param {number} month - Current month (1-12)
 * @returns {'daily'|'emergency'|'none'}
 */
export function currentWindow(hour, month) {
  const s = CONFIG.schedule;
  if (hour >= s.dailyWateringWindow.start && hour < s.dailyWateringWindow.end) {
    return 'daily';
  }

  const seasonalFactor = CONFIG.watering.seasonalAdjustment[month] ?? 0;
  const inCoolingWindow = hour >= s.emergencyCoolingWindow.start
    && hour < s.emergencyCoolingWindow.end;
  const inPeakBlock = hour >= s.peakHeatBlock.start && hour < s.peakHeatBlock.end;

  if (seasonalFactor > 0 && inCoolingWindow && !inPeakBlock) {
    return 'emergency';
  }

  return 'none';
}
