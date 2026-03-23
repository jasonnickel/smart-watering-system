import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyGuidedSettings,
  buildGuidedSettingsModel,
  buildZoneConfigYaml,
  normalizeSoilProfiles,
  normalizeZones,
  parseZoneConfig,
} from '../../src/web/forms.js';

describe('Guided settings editor', () => {
  it('preserves existing secrets when the guided form leaves them blank', () => {
    const existing = [
      'RACHIO_API_KEY=keep-me',
      'WEB_UI_PASSWORD=secret',
      'DEBUG_LEVEL=1',
      'SHADOW_MODE=true',
      'LAT=39.7',
      'LON=-105.2',
      'LOCATION_TIMEZONE=America/Denver',
      'N8N_WEBHOOK_URL=https://old.example/webhook',
    ].join('\n');

    const updated = applyGuidedSettings(existing, {
      rachioApiKey: '',
      ambientApiKey: '',
      ambientAppKey: '',
      ambientMacAddress: '',
      notificationEmail: 'yard@example.com',
      webhookUrl: '',
      locationAddress: '123 Main St, Golden, CO 80401',
      mqttBrokerUrl: '',
      mqttTopicPrefix: 'taproot',
      debugLevel: '2',
      shadowMode: false,
      lat: '40.015',
      lon: '-105.2705',
      locationTimezone: 'America/Chicago',
      webHost: '127.0.0.1',
      webPort: '3100',
      webUiPassword: '',
      disableWebUiPassword: false,
    });

    const model = buildGuidedSettingsModel(updated);
    assert.match(updated, /^RACHIO_API_KEY=keep-me$/m);
    assert.match(updated, /^WEB_UI_PASSWORD=secret$/m);
    assert.doesNotMatch(updated, /^N8N_WEBHOOK_URL=/m);
    assert.equal(model.notificationEmail, 'yard@example.com');
    assert.equal(model.locationAddress, '123 Main St, Golden, CO 80401');
    assert.equal(model.debugLevel, '2');
    assert.equal(model.shadowMode, false);
    assert.equal(model.lat, '40.015');
    assert.equal(model.lon, '-105.2705');
    assert.equal(model.locationTimezone, 'America/Chicago');
    assert.equal(model.webPort, '3100');
    assert.equal(model.webUiPasswordConfigured, true);
  });

  it('can remove the optional web password from guided settings', () => {
    const updated = applyGuidedSettings('WEB_UI_PASSWORD=secret\n', {
      rachioApiKey: '',
      ambientApiKey: '',
      ambientAppKey: '',
      ambientMacAddress: '',
      notificationEmail: '',
      webhookUrl: '',
      locationAddress: '',
      mqttBrokerUrl: '',
      mqttTopicPrefix: '',
      debugLevel: '1',
      shadowMode: true,
      lat: '39.7322',
      lon: '-105.2194',
      locationTimezone: 'America/Denver',
      webHost: '',
      webPort: '',
      webUiPassword: '',
      disableWebUiPassword: true,
    });

    assert.doesNotMatch(updated, /^WEB_UI_PASSWORD=/m);
  });
});

describe('Guided zone editor', () => {
  it('round trips guided zone data through YAML', () => {
    const soilProfiles = normalizeSoilProfiles([
      { name: 'default', organicMatterPct: '2.0', soilPh: '7.5' },
      { name: 'trees', organicMatterPct: '3.4', soilPh: '6.9' },
    ]);
    const zones = normalizeZones([
      { zoneNumber: '1', type: 'lawn', sunExposure: '1', areaSqFt: '400', priority: '1', soil: 'default' },
      { zoneNumber: '7', type: 'drip', sunExposure: '0.6', areaSqFt: '300', priority: '4', soil: 'trees' },
    ], soilProfiles.map(soil => soil.name));

    const yaml = buildZoneConfigYaml({ soilProfiles, zones });
    const parsed = parseZoneConfig(yaml, {});

    assert.equal(parsed.soilProfiles.length, 2);
    assert.equal(parsed.zones.length, 2);
    assert.equal(parsed.zones[1].soil, 'trees');
    assert.equal(parsed.zones[1].type, 'drip');
  });

  it('rejects zones that reference an unknown soil profile', () => {
    assert.throws(() => normalizeZones([
      { zoneNumber: '2', type: 'lawn', sunExposure: '0.8', areaSqFt: '300', priority: '2', soil: 'missing' },
    ], ['default']), /unknown soil profile/i);
  });
});
