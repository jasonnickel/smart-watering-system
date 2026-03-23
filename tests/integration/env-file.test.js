import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readEnvValueFromContent, syncManagedEnvFromContent, upsertEnvValue } from '../../src/env.js';
import CONFIG, { reloadConfigFromEnv } from '../../src/config.js';

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

describe('Runtime env reload', () => {
  it('updates process.env and CONFIG after settings are saved', () => {
    const original = {
      RACHIO_API_KEY: process.env.RACHIO_API_KEY,
      LAT: process.env.LAT,
      LON: process.env.LON,
      LOCATION_TIMEZONE: process.env.LOCATION_TIMEZONE,
      LOCATION_ADDRESS: process.env.LOCATION_ADDRESS,
    };

    try {
      syncManagedEnvFromContent([
        'RACHIO_API_KEY=test-key',
        'LAT=40.015',
        'LON=-105.2705',
        'LOCATION_TIMEZONE=America/Chicago',
        'LOCATION_ADDRESS=123 Main St, Golden, CO 80401',
      ].join('\n'));
      reloadConfigFromEnv();

      assert.equal(process.env.RACHIO_API_KEY, 'test-key');
      assert.equal(CONFIG.api.rachio.apiKey, 'test-key');
      assert.equal(CONFIG.location.lat, 40.015);
      assert.equal(CONFIG.location.lon, -105.2705);
      assert.equal(CONFIG.location.timezone, 'America/Chicago');
      assert.equal(CONFIG.location.address, '123 Main St, Golden, CO 80401');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      reloadConfigFromEnv();
    }
  });
});

describe('Legacy Smart Water migration', () => {
  it('copies legacy env and database into the Taproot home when needed', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'taproot-home-'));

    try {
      const script = `
        import Database from 'better-sqlite3';
        import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
        import { homedir } from 'node:os';
        import { join } from 'node:path';

        const legacyDir = join(homedir(), '.smart-water');
        const taprootDir = join(homedir(), '.taproot');
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, '.env'), 'RACHIO_API_KEY=legacy-key\\nSHADOW_MODE=true\\n');

        const legacyDbPath = join(legacyDir, 'smart-water.db');
        const db = new Database(legacyDbPath);
        db.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY, timestamp TEXT, phase TEXT, decision TEXT, reason TEXT, success INTEGER);');
        db.prepare('INSERT INTO runs (timestamp, phase, decision, reason, success) VALUES (?, ?, ?, ?, ?)').run(
          '2026-03-23T12:00:00Z',
          'DECIDE',
          'SKIP',
          'legacy history',
          1
        );
        db.close();

        await import('./src/paths.js');

        process.stdout.write(JSON.stringify({
          envMigrated: existsSync(join(taprootDir, '.env')),
          envContent: readFileSync(join(taprootDir, '.env'), 'utf8'),
          dbMigrated: existsSync(join(taprootDir, 'taproot.db')),
        }));
      `;

      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tempHome,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.envMigrated, true);
      assert.equal(payload.dbMigrated, true);
      assert.match(payload.envContent, /RACHIO_API_KEY=legacy-key/);
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
