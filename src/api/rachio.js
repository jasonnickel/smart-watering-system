// Rachio irrigation controller API client
// Device discovery, zone profiles, and multi-zone watering control

import CONFIG from '../config.js';
import { fetchWithRetry } from './http.js';
import { log } from '../log.js';

const BASE_URL = 'https://api.rach.io/1/public';

function authHeaders() {
  return {
    'Authorization': `Bearer ${CONFIG.api.rachio.apiKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Fetch all zones from the first Rachio device.
 *
 * @returns {Promise<Array>} Array of { id, zoneNumber, name, enabled, deviceId }
 */
export async function getZones() {
  const personInfo = await fetchWithRetry(
    `${BASE_URL}/person/info`,
    { headers: authHeaders() },
    'Rachio-PersonInfo'
  );

  const personId = personInfo.id;
  const person = await fetchWithRetry(
    `${BASE_URL}/person/${personId}`,
    { headers: authHeaders() },
    'Rachio-Person'
  );

  const device = person.devices?.[0];
  if (!device) {
    throw new Error('Rachio: No device found on account');
  }

  const zones = (device.zones || []).map(z => ({
    id: z.id,
    zoneNumber: z.zoneNumber,
    name: z.name,
    enabled: z.enabled,
    deviceId: device.id,
  }));

  log(1, `Rachio: Found ${zones.length} zones on device ${device.name || device.id}`);

  return zones;
}

/**
 * Build enriched zone profiles by merging Rachio data with local config.
 *
 * @param {Array} rachioZones - Raw zones from getZones()
 * @returns {Array} Profiles with calculated fields (gallonsPerMinute, availableWaterCapacity, etc.)
 */
export function buildProfiles(rachioZones) {
  const profiles = [];

  for (const zone of rachioZones) {
    const profileConfig = CONFIG.watering.zoneProfiles[zone.zoneNumber];
    if (!profileConfig) continue;

    const baseProfile = CONFIG.watering[profileConfig.type];
    if (!baseProfile) continue;

    const soilProfile = CONFIG.watering.soilProfiles[profileConfig.soil]
      || CONFIG.watering.soilProfiles.default;

    // Organic matter modifies available water capacity
    const om = soilProfile.organicMatterPercent ?? 2.0;
    const omModifier = 1 + (om - 3.0) * 0.05;
    const effectiveAWC = baseProfile.baselineAWC * Math.max(0.75, Math.min(1.25, omModifier));

    const merged = {
      ...baseProfile,
      ...profileConfig,
      ...soilProfile,
      availableWaterCapacity: effectiveAWC,
      id: zone.id,
      zoneNumber: zone.zoneNumber,
      name: zone.name,
    };

    // Calculate flow rate from application rate and area
    const inchesPerHour = merged.inchesPerMinute * 60;
    merged.gallonsPerMinute = (inchesPerHour * merged.areaSqFt) / CONFIG.watering.gallonsPerCubicInchFactor;

    profiles.push(merged);
  }

  log(1, `Built ${profiles.length} managed zone profiles`);

  return profiles;
}

/**
 * [4.1] Get recent zone run activity from Rachio for flow data.
 * Requires an EveryDrop flow meter connected to the controller.
 *
 * @param {string} deviceId - Rachio device ID
 * @returns {Promise<Array|null>} Array of zone run events with flow data, or null
 */
export async function getDeviceActivity(deviceId) {
  if (!deviceId) return null;

  try {
    const data = await fetchWithRetry(
      `${BASE_URL}/device/${deviceId}/current_schedule`,
      { headers: authHeaders() },
      'Rachio-Activity'
    );

    // Rachio returns flow data in zone run events if a flow meter is connected
    if (data?.zones) {
      return data.zones.map(z => ({
        zoneId: z.zoneId,
        duration: z.duration, // seconds
        totalVolume: z.totalVolume ?? null, // gallons, null if no flow meter
      }));
    }
    return null;
  } catch (err) {
    log(2, `Device activity fetch failed (normal if no active schedule): ${err.message}`);
    return null;
  }
}

/**
 * Start a multi-zone watering run on Rachio.
 * This is the COMMAND phase - sends the instruction to the controller.
 *
 * @param {Array} zones - Array of { id, duration (minutes), priority }
 * @returns {Promise<boolean>} true if Rachio accepted the command
 */
export async function startMultiZoneRun(zones) {
  if (!zones || zones.length === 0) return true;

  const payload = {
    zones: zones.map((z, index) => ({
      id: z.id,
      duration: z.duration * 60, // Rachio expects seconds
      sortOrder: index,
    })),
  };

  log(1, `Rachio: Starting ${zones.length} zone run`);

  await fetchWithRetry(
    `${BASE_URL}/zone/start_multiple`,
    {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    },
    'Rachio-StartMultiple'
  );

  return true;
}
