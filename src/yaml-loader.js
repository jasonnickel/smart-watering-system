// [3.1] YAML zone config loader
// Reads zones.yaml and merges into CONFIG at startup.

import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
const parseYAML = yaml.load;
import { log } from './log.js';
import {
  TAPROOT_RATES_PATH,
  TAPROOT_ZONES_PATH,
  getProjectRatesPath,
  getProjectZonesPath,
} from './paths.js';

const YAML_PATHS = [
  getProjectZonesPath(),
  TAPROOT_ZONES_PATH,
];

const RATES_PATHS = [
  getProjectRatesPath(),
  TAPROOT_RATES_PATH,
];

/**
 * Load zone and soil profiles from zones.yaml.
 * Returns null if no YAML file is found (falls back to config.js defaults).
 *
 * @returns {{ zoneProfiles: object, soilProfiles: object } | null}
 */
export function loadZoneConfig() {
  const yamlPath = YAML_PATHS.find(p => existsSync(p));
  if (!yamlPath) {
    log(2, 'No zones.yaml found, using config.js defaults');
    return null;
  }

  try {
    const raw = readFileSync(yamlPath, 'utf-8');
    const data = parseYAML(raw);

    if (!data?.zones) {
      log(1, 'zones.yaml exists but has no "zones" key, using defaults');
      return null;
    }

    // Convert YAML format to config format
    const zoneProfiles = {};
    for (const [num, zone] of Object.entries(data.zones)) {
      const zoneNum = parseInt(num, 10);
      if (Number.isNaN(zoneNum)) {
        log(1, `zones.yaml: Skipping non-numeric zone key "${num}"`);
        continue;
      }

      // Validate
      if (!zone.type || !['lawn', 'drip'].includes(zone.type)) {
        log(0, `zones.yaml: Zone ${zoneNum} has invalid type "${zone.type}" (must be lawn or drip)`);
        continue;
      }
      if (zone.area_sqft != null && zone.area_sqft < 50) {
        log(1, `zones.yaml: Zone ${zoneNum} area (${zone.area_sqft} sqft) seems very small`);
      }
      if (zone.sun_exposure != null && (zone.sun_exposure < 0 || zone.sun_exposure > 1)) {
        log(1, `zones.yaml: Zone ${zoneNum} sun_exposure (${zone.sun_exposure}) should be 0.0-1.0`);
      }

      zoneProfiles[zoneNum] = {
        type: zone.type,
        sunExposure: zone.sun_exposure ?? 1.0,
        areaSqFt: zone.area_sqft ?? 400,
        priority: zone.priority ?? 2,
        soil: zone.soil ?? 'default',
      };
    }

    // Soil profiles
    const soilProfiles = {};
    if (data.soil_profiles) {
      for (const [name, profile] of Object.entries(data.soil_profiles)) {
        soilProfiles[name] = {
          organicMatterPercent: profile.organic_matter_pct ?? 2.0,
          soilPH: profile.soil_ph ?? 7.5,
        };
      }
    }

    log(1, `Loaded ${Object.keys(zoneProfiles).length} zones from ${yamlPath}`);
    return { zoneProfiles, soilProfiles };
  } catch (err) {
    log(0, `Failed to load zones.yaml: ${err.message}`);
    return null;
  }
}

/**
 * Load water rate configuration from rates.yaml.
 * Returns null if no YAML file is found (falls back to config.js defaults).
 *
 * @returns {object|null} Rate configuration
 */
export function loadRateConfig() {
  const ratesPath = RATES_PATHS.find(p => existsSync(p));
  if (!ratesPath) {
    log(2, 'No rates.yaml found, using config.js defaults');
    return null;
  }

  try {
    const raw = readFileSync(ratesPath, 'utf-8');
    const data = parseYAML(raw, { schema: yaml.JSON_SCHEMA });

    if (!data?.water_tiers || !Array.isArray(data.water_tiers)) {
      log(1, 'rates.yaml exists but has no valid water_tiers, using defaults');
      return null;
    }

    const waterRates = data.water_tiers.map(tier => ({
      name: tier.name || '',
      thresholdGallons: tier.threshold_gallons,
      ratePer1000Gal: tier.rate_per_1000_gal,
    })).sort((a, b) => a.thresholdGallons - b.thresholdGallons);

    const fixedCharges = data.fixed_charges || {};

    const result = {
      provider: data.provider || 'Unknown',
      effectiveDate: data.effective_date || '',
      billingCycleDay: data.billing_cycle_day || 25,
      awcThousands: data.awc_thousands || 5,
      waterRates,
      fixedCharges: {
        waterBaseFee: fixedCharges.water_base_fee || 0,
        wastewaterService: fixedCharges.wastewater_service || 0,
        drainage: fixedCharges.drainage || 0,
      },
      wastewaterRatePer1000Gal: data.wastewater_rate_per_1000_gal || 0,
    };

    log(1, `Loaded ${waterRates.length}-tier rate schedule from ${ratesPath} (${result.provider}, effective ${result.effectiveDate})`);
    return result;
  } catch (err) {
    log(0, `Failed to load rates.yaml: ${err.message}`);
    return null;
  }
}
