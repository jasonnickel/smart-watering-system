// Smart soak cycle builder
// Splits long lawn runs into two halves with a soak interval between them.
// Improves water infiltration in clay-heavy Colorado soils.

import CONFIG from '../config.js';

/**
 * Build a soak-aware watering schedule from a list of zones.
 * Lawn zones exceeding the soak threshold get split into two cycles.
 * Non-lawn and short-duration zones run in a single pass.
 *
 * @param {Array} zones - Array of { id, name, duration, gallons, priority, profile }
 * @returns {Array} Reordered zone list with split runs
 */
export function buildSoakSchedule(zones) {
  const soakConfig = CONFIG.watering.lawn.smartSoak;
  if (!soakConfig.enabled) return zones;

  const cycle1 = [];
  const cycle2 = [];

  for (const zone of zones) {
    const needsSoak = zone.profile.type === 'lawn'
      && zone.duration > soakConfig.soakThresholdMinutes;

    if (needsSoak) {
      const halfTime = Math.ceil(zone.duration / 2);
      cycle1.push({ ...zone, duration: halfTime });
      cycle2.push({ ...zone, duration: zone.duration - halfTime });
    } else {
      cycle1.push({ ...zone });
    }
  }

  return [...cycle1, ...cycle2];
}
