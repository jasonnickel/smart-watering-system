import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { publishHADiscovery, setMQTTClientForTesting } from '../../src/mqtt.js';

afterEach(() => {
  setMQTTClientForTesting(null);
});

describe('Home Assistant discovery publishing', () => {
  it('publishes discovery configs at the root HA topic while keeping app state topics prefixed', () => {
    const publishes = [];
    setMQTTClientForTesting({
      connected: true,
      publish(topic, message, options, callback) {
        publishes.push({ topic, message, options });
        callback?.();
      },
    });

    publishHADiscovery([{ zone: 1, name: 'Front Lawn' }]);

    const zoneConfig = publishes.find(entry => entry.topic === 'homeassistant/sensor/smart_water_zone_1_moisture/config');
    assert.ok(zoneConfig, 'Expected zone discovery config on root homeassistant topic');
    assert.equal(zoneConfig.options.retain, true);

    const payload = JSON.parse(zoneConfig.message);
    assert.equal(payload.state_topic, 'smart-water/zone/1/moisture');

    assert.ok(
      publishes.every(entry => !entry.topic.startsWith('smart-water/homeassistant/')),
      `Unexpected prefixed HA discovery topic(s): ${publishes.map(entry => entry.topic).join(', ')}`
    );
  });
});
