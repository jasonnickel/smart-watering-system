// Adaptive zone tuning
// Analyzes historical watering patterns to detect when zones consistently
// need more or less water than predicted. Suggests ET multiplier corrections.

import { log } from '../log.js';
import {
  getFlowCalibrationSuggestions, logTuningSuggestion,
  getSystemState, setSystemState, getRunsSince, getSoilMoisture,
} from '../db/state.js';

// Correction factor bounds - never adjust more than 20% from configured values
const MIN_FACTOR = 0.8;
const MAX_FACTOR = 1.2;
const ANALYSIS_DAYS = 14;
const MIN_DECISIONS_FOR_ANALYSIS = 7;
const CORRECTION_STEP = 0.03;

/**
 * Run adaptive tuning analysis.
 * Called after each daily watering cycle.
 *
 * @param {Array} profiles - Zone profiles
 * @returns {Array} Array of tuning suggestions for the daily summary
 */
export function analyzeTuning(profiles) {
  const suggestions = [];

  // Flow-based calibration suggestions (requires flow meter)
  const flowSuggestions = analyzeFlowCalibration(profiles);
  suggestions.push(...flowSuggestions);

  // ET correction based on watering frequency patterns (14-day rolling)
  const etSuggestions = analyzeWateringFrequency(profiles);
  suggestions.push(...etSuggestions);

  return suggestions;
}

/**
 * Flow meter calibration analysis.
 * Compares expected vs actual gallons per zone when flow data exists.
 */
function analyzeFlowCalibration(profiles) {
  const suggestions = [];
  const flowSuggestions = getFlowCalibrationSuggestions();

  for (const fs of flowSuggestions) {
    const profile = profiles.find(p => p.id === fs.zone_id);
    if (!profile) continue;

    const avgDev = fs.avg_deviation;
    const currentGPM = profile.gallonsPerMinute;
    const suggestedGPM = currentGPM * (1 + avgDev / 100);
    const clampedGPM = Math.max(currentGPM * MIN_FACTOR, Math.min(currentGPM * MAX_FACTOR, suggestedGPM));

    if (Math.abs(clampedGPM - currentGPM) / currentGPM > 0.05) {
      const suggestion = {
        zoneId: fs.zone_id,
        zoneNumber: fs.zone_number,
        zoneName: profile.name,
        parameter: 'gallonsPerMinute',
        currentValue: currentGPM,
        suggestedValue: clampedGPM,
        reason: `Flow meter shows ${avgDev > 0 ? '+' : ''}${avgDev.toFixed(0)}% deviation over ${fs.run_count} runs`,
      };
      suggestions.push(suggestion);
      logTuningSuggestion(fs.zone_id, 'gallonsPerMinute', currentGPM, clampedGPM);
      log(1, `Tuning suggestion: Zone ${fs.zone_number} GPM ${currentGPM.toFixed(2)} -> ${clampedGPM.toFixed(2)} (${suggestion.reason})`);
    }
  }

  return suggestions;
}

/**
 * Analyze 14-day watering frequency to detect ET model drift.
 * If a zone triggers watering significantly more or less often than
 * expected based on its moisture depletion rate, suggest an ET correction.
 *
 * Logic:
 * - Count how many times each zone appeared in WATER decisions over 14 days
 * - Compare against expected watering frequency based on zone capacity and avg ET
 * - If a zone waters 30%+ more often than expected, ET is underestimated (increase correction)
 * - If a zone waters 30%+ less often than expected, ET is overestimated (decrease correction)
 */
function analyzeWateringFrequency(profiles) {
  const suggestions = [];

  const since = new Date(Date.now() - ANALYSIS_DAYS * 86400000).toISOString();
  const recentRuns = getRunsSince(since);
  const decisions = recentRuns.filter(r => r.phase === 'DECIDE' && r.success === 1);

  if (decisions.length < MIN_DECISIONS_FOR_ANALYSIS) {
    return suggestions;
  }

  // Count watering events per zone
  const zoneWaterCount = {};
  for (const decision of decisions) {
    if (decision.decision !== 'WATER') continue;
    let zones = [];
    try { zones = JSON.parse(decision.zones_json || '[]'); } catch { /* empty */ }
    for (const zone of zones) {
      const key = zone.zone_id || zone.zoneId || zone.id;
      if (key) {
        zoneWaterCount[key] = (zoneWaterCount[key] || 0) + 1;
      }
    }
  }

  // Current moisture state for context
  const moisture = getSoilMoisture();
  const moistureMap = {};
  for (const m of moisture) {
    moistureMap[m.zone_id] = m;
  }

  // Analyze each profile
  for (const profile of profiles) {
    const waterCount = zoneWaterCount[profile.id] || 0;
    const currentCorrection = getETCorrection(profile.id);

    // Expected watering frequency: capacity / average daily ET loss
    // A zone with 1.5" capacity losing 0.2"/day should water every ~7.5 days
    // Over 14 days that's about 2 watering events
    const capacity = profile.availableWaterCapacity * profile.rootDepthInches;
    const depletionFraction = profile.allowedDepletion?.max ?? 0.5;
    const usableCapacity = capacity * depletionFraction;

    // Estimate average daily ET for this zone (use a moderate default)
    const avgDailyET = 0.15 * (profile.sunExposure ?? 1.0) * currentCorrection;
    if (avgDailyET <= 0) continue;

    const expectedInterval = usableCapacity / avgDailyET;
    const expectedWaterCount = Math.max(1, Math.round(ANALYSIS_DAYS / expectedInterval));

    if (expectedWaterCount === 0) continue;

    const ratio = waterCount / expectedWaterCount;

    // If watering 30%+ more often than expected, ET is underestimated
    if (ratio > 1.3 && waterCount >= 3) {
      const newCorrection = Math.min(MAX_FACTOR, currentCorrection + CORRECTION_STEP);
      if (newCorrection > currentCorrection) {
        suggestions.push({
          zoneId: profile.id,
          zoneNumber: profile.zoneNumber,
          zoneName: profile.name || `Zone ${profile.zoneNumber}`,
          parameter: 'etCorrection',
          currentValue: currentCorrection,
          suggestedValue: newCorrection,
          reason: `Watered ${waterCount} times in ${ANALYSIS_DAYS} days (expected ~${expectedWaterCount}). ET may be underestimated.`,
          waterCount,
          expectedWaterCount,
        });
        logTuningSuggestion(profile.id, 'etCorrection', currentCorrection, newCorrection);
        log(1, `Tuning: Zone ${profile.zoneNumber} watered ${waterCount}x vs expected ${expectedWaterCount}x - suggest ET correction ${currentCorrection.toFixed(2)} -> ${newCorrection.toFixed(2)}`);
      }
    }

    // If watering 30%+ less often than expected, ET is overestimated
    if (ratio < 0.7 && expectedWaterCount >= 3) {
      const currentMoisture = moistureMap[profile.id];
      const moisturePct = currentMoisture && currentMoisture.total_capacity > 0
        ? (currentMoisture.balance_inches / currentMoisture.total_capacity) * 100
        : null;

      // Only suggest decrease if moisture is actually high (confirming zone needs less water)
      if (moisturePct !== null && moisturePct > 60) {
        const newCorrection = Math.max(MIN_FACTOR, currentCorrection - CORRECTION_STEP);
        if (newCorrection < currentCorrection) {
          suggestions.push({
            zoneId: profile.id,
            zoneNumber: profile.zoneNumber,
            zoneName: profile.name || `Zone ${profile.zoneNumber}`,
            parameter: 'etCorrection',
            currentValue: currentCorrection,
            suggestedValue: newCorrection,
            reason: `Watered only ${waterCount} times in ${ANALYSIS_DAYS} days (expected ~${expectedWaterCount}) and moisture is at ${Math.round(moisturePct)}%. ET may be overestimated.`,
            waterCount,
            expectedWaterCount,
          });
          logTuningSuggestion(profile.id, 'etCorrection', currentCorrection, newCorrection);
          log(1, `Tuning: Zone ${profile.zoneNumber} watered ${waterCount}x vs expected ${expectedWaterCount}x at ${Math.round(moisturePct)}% moisture - suggest ET correction ${currentCorrection.toFixed(2)} -> ${newCorrection.toFixed(2)}`);
        }
      }
    }
  }

  return suggestions;
}

/**
 * Auto-apply tuning suggestions that have been consistently recommended.
 * Only applies if the same direction has been suggested 3+ times consecutively.
 *
 * @param {Array} suggestions - Current round of tuning suggestions
 */
export function autoApplyTuning(suggestions) {
  for (const suggestion of suggestions) {
    if (suggestion.parameter !== 'etCorrection') continue;

    const countKey = `tuning_streak_${suggestion.zoneId}`;
    const directionKey = `tuning_direction_${suggestion.zoneId}`;

    const direction = suggestion.suggestedValue > suggestion.currentValue ? 'up' : 'down';
    const lastDirection = getSystemState(directionKey);
    const streak = parseInt(getSystemState(countKey) || '0', 10);

    if (lastDirection === direction) {
      const newStreak = streak + 1;
      setSystemState(countKey, String(newStreak));

      if (newStreak >= 3) {
        setETCorrection(suggestion.zoneId, suggestion.suggestedValue);
        setSystemState(countKey, '0');
        log(1, `Auto-applied ET correction for zone ${suggestion.zoneNumber}: ${suggestion.currentValue.toFixed(2)} -> ${suggestion.suggestedValue.toFixed(2)} after ${newStreak} consecutive suggestions`);
      }
    } else {
      setSystemState(directionKey, direction);
      setSystemState(countKey, '1');
    }
  }
}

/**
 * Get the ET correction factor for a zone.
 * Applied in soil moisture calculations to adjust for real-world conditions.
 *
 * @param {string} zoneId
 * @returns {number} Correction factor (default 1.0)
 */
export function getETCorrection(zoneId) {
  try {
    const stored = getSystemState(`et_correction_${zoneId}`);
    if (!stored) return 1.0;
    const factor = parseFloat(stored);
    return Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, factor));
  } catch {
    return 1.0;
  }
}

/**
 * Set the ET correction factor for a zone.
 *
 * @param {string} zoneId
 * @param {number} factor - Correction factor (0.8 to 1.2)
 */
export function setETCorrection(zoneId, factor) {
  const clamped = Math.max(MIN_FACTOR, Math.min(MAX_FACTOR, factor));
  setSystemState(`et_correction_${zoneId}`, clamped.toString());
  log(1, `ET correction for zone ${zoneId} set to ${clamped.toFixed(2)}`);
}
