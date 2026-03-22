// [5.1] MQTT publisher for Home Assistant integration
// Publishes system state to MQTT topics after each run.
// Uses retain flag so HA gets current state on restart.

import './env.js';
import { log } from './log.js';

const BROKER_URL = process.env.MQTT_BROKER_URL;
const TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX || 'smart-water';
const HA_DISCOVERY_PREFIX = process.env.HA_DISCOVERY_PREFIX || 'homeassistant';

let client = null;

/**
 * Connect to MQTT broker. No-op if MQTT is not configured.
 *
 * @returns {Promise<boolean>} true if connected
 */
export async function connectMQTT() {
  if (!BROKER_URL) {
    log(2, 'MQTT not configured (no MQTT_BROKER_URL)');
    return false;
  }

  try {
    // Dynamic import - mqtt package is optional
    const mqtt = await import('mqtt');
    client = mqtt.default.connect(BROKER_URL, {
      clientId: `smart-water-${process.pid}`,
      clean: true,
      connectTimeout: 5000,
    });

    return new Promise((resolve) => {
      client.on('connect', () => {
        log(1, `MQTT connected to ${BROKER_URL}`);
        resolve(true);
      });
      client.on('error', (err) => {
        log(0, `MQTT connection error: ${err.message}`);
        client = null;
        resolve(false);
      });
      // Timeout after 5 seconds
      setTimeout(() => {
        if (!client?.connected) {
          log(1, 'MQTT connection timed out');
          resolve(false);
        }
      }, 5000);
    });
  } catch (err) {
    log(2, `MQTT module not installed (npm install mqtt): ${err.message}`);
    return false;
  }
}

/**
 * Publish a retained message to a topic.
 */
function pub(topic, payload, { prefix = true } = {}) {
  if (!client?.connected) return;
  const fullTopic = prefix ? `${TOPIC_PREFIX}/${topic}` : topic;
  const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
  client.publish(fullTopic, message, { retain: true }, (err) => {
    if (err) log(0, `MQTT publish error on ${fullTopic}: ${err.message}`);
  });
}

/**
 * Test helper to inject a fake MQTT client.
 *
 * @param {object|null} testClient
 */
export function setMQTTClientForTesting(testClient) {
  client = testClient;
}

/**
 * Publish full system state after a run.
 *
 * @param {object} opts
 * @param {object} opts.status - From getStatusJSON()
 * @param {object} opts.weather - Current weather data
 * @param {string} opts.weatherSource - Weather source name
 * @param {string} opts.lastDecision - Last decision reason
 */
export function publishState({ status, weather, weatherSource, lastDecision }) {
  if (!client?.connected) return;

  // Overall status
  pub('status', {
    lastRun: status.lastRun,
    weatherSource,
    todayUsage: status.todayUsage,
    timestamp: new Date().toISOString(),
  });

  // Per-zone moisture
  for (const zone of status.moisture) {
    pub(`zone/${zone.zone}/moisture`, zone.pct);
    pub(`zone/${zone.zone}/balance`, zone.inches.toFixed(3));
    pub(`zone/${zone.zone}/name`, zone.name);
  }

  // Decision
  if (lastDecision) {
    pub('decision', lastDecision);
  }

  // Weather
  if (weather) {
    pub('weather', { ...weather, source: weatherSource });
  }

  // Finance
  if (status.finance) {
    pub('finance', status.finance);
  }

  log(2, 'MQTT state published');
}

/**
 * Publish Home Assistant MQTT discovery configs.
 * Creates sensor entities in HA automatically.
 *
 * @param {Array} zones - Zone status objects with zone number and name
 */
export function publishHADiscovery(zones) {
  if (!client?.connected) return;

  const device = {
    identifiers: ['smart_water_system'],
    name: 'Smart Water System',
    manufacturer: 'DIY',
    model: 'Smart Water v1',
  };

  // Per-zone moisture sensors
  for (const zone of zones) {
    const id = `smart_water_zone_${zone.zone}_moisture`;
    pub(`${HA_DISCOVERY_PREFIX}/sensor/${id}/config`, {
      name: `${zone.name} Moisture`,
      unique_id: id,
      state_topic: `${TOPIC_PREFIX}/zone/${zone.zone}/moisture`,
      unit_of_measurement: '%',
      device_class: 'humidity',
      device,
    }, { prefix: false });
  }

  // Today's usage sensor
  pub(`${HA_DISCOVERY_PREFIX}/sensor/smart_water_daily_gallons/config`, {
    name: 'Smart Water Daily Gallons',
    unique_id: 'smart_water_daily_gallons',
    state_topic: `${TOPIC_PREFIX}/status`,
    value_template: '{{ value_json.todayUsage.gallons | round(0) }}',
    unit_of_measurement: 'gal',
    device,
  }, { prefix: false });

  // Weather source sensor
  pub(`${HA_DISCOVERY_PREFIX}/sensor/smart_water_weather_source/config`, {
    name: 'Smart Water Weather Source',
    unique_id: 'smart_water_weather_source',
    state_topic: `${TOPIC_PREFIX}/status`,
    value_template: '{{ value_json.weatherSource }}',
    device,
  }, { prefix: false });

  log(1, 'HA MQTT discovery configs published');
}

/**
 * Disconnect from MQTT broker.
 */
export async function disconnectMQTT() {
  if (!client) return;
  return new Promise((resolve) => {
    client.end(false, {}, () => {
      log(2, 'MQTT disconnected');
      resolve();
    });
  });
}
