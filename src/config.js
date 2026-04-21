// Configuration for Taproot
// Zone profiles, thresholds, and rates live here. Secrets come from .env.
// [3.1] Zone profiles can be overridden by zones.yaml.

import './env.js';
import { loadZoneConfig, loadRateConfig } from './yaml-loader.js';

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return fallback;
  }

  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function currentEnvBackedConfig() {
  return {
    api: {
      ambientWeather: {
        apiKey: process.env.AMBIENT_API_KEY,
        appKey: process.env.AMBIENT_APP_KEY,
        macAddress: process.env.AMBIENT_MAC_ADDRESS,
      },
      rachio: {
        apiKey: process.env.RACHIO_API_KEY,
      },
      aquahawk: {
        district: process.env.AQUAHAWK_DISTRICT || '',
        username: process.env.AQUAHAWK_USERNAME || '',
        password: process.env.AQUAHAWK_PASSWORD || '',
        accountNumber: process.env.AQUAHAWK_ACCOUNT_NUMBER || '',
      },
    },

    system: {
      shadowMode: process.env.SHADOW_MODE === 'true',
      debugLevel: parseInt(process.env.DEBUG_LEVEL || '1', 10),
    },

    location: {
      lat: envNumber('LAT', 39.73220),
      lon: envNumber('LON', -105.21940),
      timezone: process.env.LOCATION_TIMEZONE || 'America/Denver',
      address: process.env.LOCATION_ADDRESS || '',
    },

    notifications: {
      email: process.env.NOTIFICATION_EMAIL || '',
      webhookUrl: process.env.N8N_WEBHOOK_URL || '',
      smtp: {
        host: process.env.SMTP_HOST || '',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
      },
    },

    mqtt: {
      brokerUrl: process.env.MQTT_BROKER_URL || '',
      topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'taproot',
    },
  };
}

const CONFIG = {
  api: {
    ambientWeather: {
      apiKey: process.env.AMBIENT_API_KEY,
      appKey: process.env.AMBIENT_APP_KEY,
      macAddress: process.env.AMBIENT_MAC_ADDRESS,
      cacheMinutes: 10,
    },
    rachio: {
      apiKey: process.env.RACHIO_API_KEY,
      cacheMinutes: 60,
    },
    openMeteo: {
      cacheMinutes: 180,
    },
    aquahawk: {
      district: process.env.AQUAHAWK_DISTRICT || '',
      username: process.env.AQUAHAWK_USERNAME || '',
      password: process.env.AQUAHAWK_PASSWORD || '',
      accountNumber: process.env.AQUAHAWK_ACCOUNT_NUMBER || '',
    },
  },

  system: {
    shadowMode: process.env.SHADOW_MODE === 'true',
    debugLevel: parseInt(process.env.DEBUG_LEVEL || '1', 10),
  },

  location: {
    lat: envNumber('LAT', 39.73220),
    lon: envNumber('LON', -105.21940),
    timezone: process.env.LOCATION_TIMEZONE || 'America/Denver',
    address: process.env.LOCATION_ADDRESS || '',
  },

  notifications: {
    email: process.env.NOTIFICATION_EMAIL || '',
    webhookUrl: process.env.N8N_WEBHOOK_URL || '',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },

  watering: {
    efficiencyFactor: 0.85,
    gallonsPerCubicInchFactor: 96.25,
    initialMoistureLevel: 0.8,

    proactive: {
      enabled: true,
      waterBeforeDepletionDays: 1,
    },

    soilProfiles: {
      frontYard2023: { organicMatterPercent: 1.77, soilPH: 8.0 },
      default: { organicMatterPercent: 2.0, soilPH: 7.5 },
    },

    zoneProfiles: {
      1: { type: 'lawn', sunExposure: 1.0, areaSqFt: 400, priority: 1, soil: 'frontYard2023' },
      2: { type: 'lawn', sunExposure: 1.0, areaSqFt: 400, priority: 1, soil: 'frontYard2023' },
      3: { type: 'lawn', sunExposure: 1.0, areaSqFt: 400, priority: 1, soil: 'frontYard2023' },
      4: { type: 'lawn', sunExposure: 1.0, areaSqFt: 400, priority: 1, soil: 'frontYard2023' },
      5: { type: 'lawn', sunExposure: 0.7, areaSqFt: 400, priority: 3, soil: 'default' },
      6: { type: 'lawn', sunExposure: 0.85, areaSqFt: 400, priority: 1, soil: 'default' },
      7: { type: 'drip', sunExposure: 0.6, areaSqFt: 300, priority: 4, soil: 'default' },
      8: { type: 'drip', sunExposure: 0.6, areaSqFt: 300, priority: 4, soil: 'default' },
      9: { type: 'drip', sunExposure: 0.6, areaSqFt: 300, priority: 4, soil: 'default' },
    },

    lawn: {
      inchesPerMinute: 0.5 / 60,
      maxRunTimeMinutes: 50,
      minRunTimeMinutes: 5,
      rootDepthInches: 6,
      baselineAWC: 0.17,
      allowedDepletion: {
        min: 0.35,
        max: 0.60,
        tempThreshold: { low: 65, high: 85 },
      },
      smartSoak: {
        enabled: true,
        soakThresholdMinutes: 20,
      },
    },

    drip: {
      inchesPerMinute: 0.9 / 60,
      maxRunTimeMinutes: 80,
      minRunTimeMinutes: 10,
      rootDepthInches: 12,
      baselineAWC: 0.17,
      allowedDepletion: {
        min: 0.40,
        max: 0.50,
        tempThreshold: { low: 65, high: 85 },
      },
    },

    // Seasonal crop coefficients by month (0 = dormant, no watering)
    seasonalAdjustment: {
      1: 0, 2: 0, 3: 0.4, 4: 0.6, 5: 0.9, 6: 1.1,
      7: 1.1, 8: 1.0, 9: 0.8, 10: 0.6, 11: 0, 12: 0,
    },

    forecast: {
      rainSkipThresholdInches: 0.5,
    },
  },

  schedule: {
    dailyWateringWindow: { start: 0, end: 1 },
    emergencyCoolingWindow: { start: 9, end: 21 },
    peakHeatBlock: { start: 13, end: 16 },
    coolingIntervalMinutes: 180,
    maxDailyGallons: 500,
    maxDailyCost: 10,
    skipConditions: {
      windMph: 10,
      rainInches: 0.5,
      lowTemp: 40,
    },
  },

  emergency: {
    triggers: {
      base: 95,
      severe: 100,
      adjustments: {
        highSolar: { threshold: 600, adjustment: -3 },
        lowHumidity: { threshold: 30, adjustment: -3 },
        highWind: { threshold: 10, adjustment: -2 },
      },
    },
    durations: { default: 8, severe: 15 },
    skipConditions: {
      windMph: 20,
      rainInches: 0.5,
      lowTemp: 40,
    },
  },

  agronomy: {
    nutrientLeachingGuardDays: 1,
  },

  finance: (() => {
    const rates = loadRateConfig();
    if (rates) {
      return {
        provider: rates.provider,
        effectiveDate: rates.effectiveDate,
        billingCycleStartDay: rates.billingCycleDay,
        awcGallons: rates.awcThousands * 1000,
        waterRates: rates.waterRates,
        fixedCharges: rates.fixedCharges,
        wastewaterRatePer1000Gal: rates.wastewaterRatePer1000Gal,
      };
    }
    // Fallback defaults if no rates.yaml exists
    return {
      provider: 'Default',
      effectiveDate: '',
      billingCycleStartDay: 25,
      awcGallons: 5000,
      waterRates: [
        { name: 'Tier 1', thresholdGallons: 5000, ratePer1000Gal: 6.44 },
        { name: 'Tier 2', thresholdGallons: 20000, ratePer1000Gal: 8.38 },
        { name: 'Tier 3', thresholdGallons: 999999, ratePer1000Gal: 9.65 },
      ],
      fixedCharges: { waterBaseFee: 13.23, wastewaterService: 12.85, drainage: 12.92 },
      wastewaterRatePer1000Gal: 3.86,
    };
  })(),

  // Conservative defaults when weather APIs are unavailable
  degradedMode: {
    ambientStaleThresholdMinutes: 240,
    defaults: {
      temp: 85,
      humidity: 30,
      windSpeed: 5,
      solarRadiation: 300,
      rainLast24h: 0,
    },
  },

  // [1.1] Real-time rain check thresholds
  rainCheck: {
    hourlyRainThreshold: 0.02, // inches/hour - any measurable rain aborts
  },

  // [1.2] Weather cross-validation
  weatherValidation: {
    precipDiscrepancyThreshold: 0.15, // inches - flag if sources disagree by this much
  },

  // [5.1] MQTT for Home Assistant
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || '',
    topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'taproot',
  },

  watchdog: {
    alertHour: 2,
  },
};

// [3.1] Override zone/soil profiles from zones.yaml if it exists
const yamlConfig = loadZoneConfig();
if (yamlConfig) {
  if (yamlConfig.zoneProfiles) {
    CONFIG.watering.zoneProfiles = yamlConfig.zoneProfiles;
  }
  if (yamlConfig.soilProfiles) {
    CONFIG.watering.soilProfiles = { ...CONFIG.watering.soilProfiles, ...yamlConfig.soilProfiles };
  }
}

export default CONFIG;

export function reloadConfigFromEnv() {
  const next = currentEnvBackedConfig();

  CONFIG.api.ambientWeather.apiKey = next.api.ambientWeather.apiKey;
  CONFIG.api.ambientWeather.appKey = next.api.ambientWeather.appKey;
  CONFIG.api.ambientWeather.macAddress = next.api.ambientWeather.macAddress;
  CONFIG.api.rachio.apiKey = next.api.rachio.apiKey;
  CONFIG.api.aquahawk.district = next.api.aquahawk.district;
  CONFIG.api.aquahawk.username = next.api.aquahawk.username;
  CONFIG.api.aquahawk.password = next.api.aquahawk.password;
  CONFIG.api.aquahawk.accountNumber = next.api.aquahawk.accountNumber;

  CONFIG.system.shadowMode = next.system.shadowMode;
  CONFIG.system.debugLevel = next.system.debugLevel;

  CONFIG.location.lat = next.location.lat;
  CONFIG.location.lon = next.location.lon;
  CONFIG.location.timezone = next.location.timezone;
  CONFIG.location.address = next.location.address;

  CONFIG.notifications.email = next.notifications.email;
  CONFIG.notifications.webhookUrl = next.notifications.webhookUrl;
  CONFIG.notifications.smtp.host = next.notifications.smtp.host;
  CONFIG.notifications.smtp.port = next.notifications.smtp.port;
  CONFIG.notifications.smtp.user = next.notifications.smtp.user;
  CONFIG.notifications.smtp.pass = next.notifications.smtp.pass;

  CONFIG.mqtt.brokerUrl = next.mqtt.brokerUrl;
  CONFIG.mqtt.topicPrefix = next.mqtt.topicPrefix;
}
