import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readEnvValueFromContent, upsertEnvValue } from '../../src/env.js';

describe('Environment file helpers', () => {
  it('replaces an existing key without disturbing other lines', () => {
    const original = 'RACHIO_API_KEY=abc\nSHADOW_MODE=true\nDEBUG_LEVEL=1\n';
    const updated = upsertEnvValue(original, 'SHADOW_MODE', 'false');

    assert.equal(readEnvValueFromContent(updated, 'SHADOW_MODE'), 'false');
    assert.equal(readEnvValueFromContent(updated, 'RACHIO_API_KEY'), 'abc');
    assert.equal(readEnvValueFromContent(updated, 'DEBUG_LEVEL'), '1');
  });

  it('appends a missing key cleanly', () => {
    const original = 'RACHIO_API_KEY=abc\n';
    const updated = upsertEnvValue(original, 'SHADOW_MODE', 'true');

    assert.match(updated, /RACHIO_API_KEY=abc\nSHADOW_MODE=true\n$/);
  });
});

describe('Config location overrides', () => {
  it('reads LAT, LON, and LOCATION_TIMEZONE from the environment', () => {
    const script = `
      const { default: CONFIG } = await import('./src/config.js');
      process.stdout.write(JSON.stringify(CONFIG.location));
    `;

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        DEBUG_LEVEL: '0',
        LAT: '40.015',
        LON: '-105.2705',
        LOCATION_TIMEZONE: 'America/Chicago',
      },
    });

    assert.equal(result.status, 0, result.stderr);

    const location = JSON.parse(result.stdout);
    assert.equal(location.lat, 40.015);
    assert.equal(location.lon, -105.2705);
    assert.equal(location.timezone, 'America/Chicago');
  });
});
