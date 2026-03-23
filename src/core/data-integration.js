// Data source integration layer
// Wires USDA soil, CoAgMet reference ET, and NDVI satellite data into the
// decision engine, advisor, and tuning system. Called after each daily run.

import { log } from '../log.js';
import CONFIG from '../config.js';
import { calculateDailyET } from './et.js';
import { compareET, getYesterdayReferenceET } from '../api/coagmet.js';
import { ndviEnabled, getNDVIStats } from '../api/ndvi.js';
import { getSoilProfile } from '../api/usda-soil.js';
import {
  logETValidation, getRecentETValidation,
  getCachedSoilSurvey, getNDVIHistory,
} from '../db/state.js';

// -- CoAgMet ET cross-validation ---------------------------------------------

/**
 * Compare yesterday's calculated ET against CoAgMet reference ET.
 * Logs the deviation to et_validation table. Returns the comparison result.
 *
 * @param {object} yesterdayWeather - Weather data used for ET calculation
 * @param {number} month - Current month (1-12)
 * @returns {Promise<object|null>} { date, calculated, reference, deviationPct, assessment }
 */
export async function crossValidateET(yesterdayWeather, month) {
  if (!yesterdayWeather) return null;

  try {
    const ref = await getYesterdayReferenceET();
    if (!ref || ref.referenceETo == null) {
      log(2, 'ET cross-validation: no CoAgMet reference data for yesterday');
      return null;
    }

    const observedMonth = Number.parseInt(ref.date?.slice(5, 7) || '', 10);
    const calculatedET = calculateDailyET(yesterdayWeather, Number.isFinite(observedMonth) ? observedMonth : month);
    const { deviationPct, assessment } = compareET(calculatedET, ref.referenceETo);

    logETValidation(ref.date, ref.station, calculatedET, ref.referenceETo, deviationPct, assessment);

    if (Math.abs(deviationPct) > 25) {
      log(0, `ET cross-validation WARNING: ${deviationPct}% deviation (calculated ${calculatedET.toFixed(3)}" vs reference ${ref.referenceETo.toFixed(3)}" ETo) - ${assessment}`);
    } else {
      log(1, `ET cross-validation: ${deviationPct}% deviation (${assessment})`);
    }

    return {
      date: ref.date,
      calculated: calculatedET,
      reference: ref.referenceETo,
      deviationPct,
      assessment,
    };
  } catch (err) {
    log(1, `ET cross-validation failed: ${err.message}`);
    return null;
  }
}

/**
 * Analyze ET validation history for persistent drift.
 * Returns an advisor insight if the system ET has been consistently off.
 *
 * @returns {object|null} Advisor insight or null
 */
export function analyzeETDrift() {
  try {
    const recent = getRecentETValidation(14);
    if (recent.length < 5) return null;

    const avgDeviation = recent.reduce((sum, r) => sum + r.deviation_pct, 0) / recent.length;

    if (Math.abs(avgDeviation) < 15) return null;

    const direction = avgDeviation > 0 ? 'higher' : 'lower';
    return {
      kind: 'et-drift',
      severity: Math.abs(avgDeviation) > 30 ? 'warning' : 'info',
      title: `ET model running ${Math.abs(avgDeviation).toFixed(0)}% ${direction} than reference`,
      summary: `Over the last ${recent.length} days, your system's ET calculations have averaged ${Math.abs(avgDeviation).toFixed(0)}% ${direction} than the CoAgMet reference station (DEN01). ${direction === 'higher' ? 'This may cause slight overwatering.' : 'This may cause slight underwatering.'} The adaptive tuning system will compensate over time.`,
    };
  } catch {
    return null;
  }
}

// -- USDA Soil auto-populate -------------------------------------------------

/**
 * Get USDA soil data for the configured location.
 * Returns values that can directly improve zone profile accuracy.
 *
 * @returns {Promise<object|null>} { awcPerInch, ph, organicMatterPct, soilName, ... }
 */
export async function getSoilRecommendations() {
  const { lat, lon } = CONFIG.location;

  try {
    const profile = await getSoilProfile(lat, lon);
    if (!profile) return null;

    const currentAWC = CONFIG.watering.lawn.baselineAWC;
    const recommendedAWC = profile.awcPerInch;
    const awcDiff = Math.abs(currentAWC - recommendedAWC) / currentAWC * 100;

    const recommendations = {
      soilName: profile.soilName,
      recommendedAWC: recommendedAWC,
      currentAWC: currentAWC,
      awcDiffPct: Math.round(awcDiff),
      recommendedPH: profile.avgPH,
      recommendedOrganicMatter: profile.avgOrganicMatterPct,
      profileDepthInches: profile.profileDepthInches,
    };

    if (awcDiff > 10) {
      log(1, `USDA soil: configured AWC (${currentAWC}) differs ${awcDiff.toFixed(0)}% from surveyed value (${recommendedAWC.toFixed(3)}) for ${profile.soilName}`);
    }

    return recommendations;
  } catch (err) {
    log(1, `USDA soil recommendations failed: ${err.message}`);
    return null;
  }
}

/**
 * Generate an advisor insight if USDA data suggests the AWC config is wrong.
 *
 * @returns {object|null}
 */
export function analyzeSoilConfig() {
  const { lat, lon } = CONFIG.location;

  try {
    const cached = getCachedSoilSurvey(lat, lon);
    if (!cached) return null;

    const currentAWC = CONFIG.watering.lawn.baselineAWC;
    const surveyedAWC = cached.awc_per_inch;
    if (!surveyedAWC) return null;

    const diffPct = Math.abs(currentAWC - surveyedAWC) / currentAWC * 100;
    if (diffPct < 10) return null;

    const direction = surveyedAWC > currentAWC ? 'higher' : 'lower';
    return {
      kind: 'soil-config-mismatch',
      severity: diffPct > 25 ? 'warning' : 'info',
      title: `Soil AWC may be ${Math.round(diffPct)}% ${direction} than configured`,
      summary: `USDA soil survey shows ${cached.soil_name} soil at your address with AWC ${surveyedAWC.toFixed(3)}"/inch, but the system is configured at ${currentAWC.toFixed(3)}"/inch. ${direction === 'higher' ? 'Your soil holds more water than the model assumes, which may lead to slight overwatering.' : 'Your soil holds less water than assumed, which may cause the system to underwater during hot periods.'} Update baselineAWC in config.js or zones.yaml to ${surveyedAWC.toFixed(3)} to match your actual soil.`,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch latest NDVI data if stale (older than 5 days).
 * Called after daily runs to keep satellite data fresh.
 */
export async function refreshNDVIIfStale() {
  if (!ndviEnabled()) return;

  try {
    const history = getNDVIHistory(30, CONFIG.location.lat, CONFIG.location.lon);
    const latestDate = history.length > 0 ? history[0].period_to : null;

    // Monthly vegetation trends do not need daily refreshes.
    if (latestDate) {
      const daysSince = (Date.now() - new Date(latestDate).getTime()) / 86400000;
      if (daysSince < 10) {
        log(2, `NDVI: fresh data exists (${daysSince.toFixed(0)} days old), skipping refresh`);
        return;
      }
    }

    const { lat, lon } = CONFIG.location;
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString();
    const to = `${now.toISOString().slice(0, 10)}T23:59:59Z`;

    await getNDVIStats(lat, lon, {
      from,
      to,
      interval: 'P1M',
      lastIntervalBehavior: 'SHORTEN',
    });
    log(1, 'NDVI: monthly vegetation history refreshed');
  } catch (err) {
    log(1, `NDVI refresh failed: ${err.message}`);
  }
}

// -- Combined daily integration run ------------------------------------------

/**
 * Run all data source integrations after a daily decision cycle.
 * Called from cli.js after analyzeTuning().
 *
 * @param {object} ctx - Run context with yesterdayWeather, profiles, etc.
 * @param {number} month - Current month
 * @returns {Promise<object>} Integration results
 */
export async function runDailyIntegrations(ctx, month) {
  const results = {};

  // ET cross-validation
  results.etValidation = await crossValidateET(ctx.yesterdayWeather, month);

  // NDVI refresh (non-blocking, failures are logged but don't stop the run)
  refreshNDVIIfStale().catch(() => {});

  return results;
}
