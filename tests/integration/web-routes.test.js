import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDB, getDB, initDB } from '../../src/db/state.js';
import { initAuth } from '../../src/web/auth.js';
import { createRequestHandler } from '../../src/web/routes.js';

const tempDirs = [];
let server = null;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_COPERNICUS_EMAIL = process.env.COPERNICUS_EMAIL;
const ORIGINAL_COPERNICUS_PASSWORD = process.env.COPERNICUS_PASSWORD;

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'smart-water-web-'));
  tempDirs.push(dir);
  return dir;
}

async function startServer({ password = '' } = {}) {
  const dir = makeTempDir();
  initDB(join(dir, 'state.db'));
  initAuth(password);

  const handler = createRequestHandler({
    host: '127.0.0.1',
    port: 0,
    appRoot: process.cwd(),
    envPath: join(dir, '.env'),
    zonesPath: join(process.cwd(), 'zones.yaml'),
    publicDir: join(process.cwd(), 'src', 'public'),
  });

  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_COPERNICUS_EMAIL == null) {
    delete process.env.COPERNICUS_EMAIL;
  } else {
    process.env.COPERNICUS_EMAIL = ORIGINAL_COPERNICUS_EMAIL;
  }
  if (ORIGINAL_COPERNICUS_PASSWORD == null) {
    delete process.env.COPERNICUS_PASSWORD;
  } else {
    process.env.COPERNICUS_PASSWORD = ORIGINAL_COPERNICUS_PASSWORD;
  }
  initAuth('');
  closeDB();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('Web routes', () => {
  it('serves login assets even when auth is enabled', async () => {
    const baseUrl = await startServer({ password: 'secret' });
    const response = await fetch(`${baseUrl}/styles.css`, { redirect: 'manual' });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /:root/);
  });

  it('returns JSON 401 for protected API routes without a session', async () => {
    const baseUrl = await startServer({ password: 'secret' });
    const response = await fetch(`${baseUrl}/api/charts`, { redirect: 'manual' });

    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await response.json(), { error: 'authentication required' });
  });

  it('falls back to a safe history window when hours is invalid', async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/logs?hours=banana`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /Run History/);
  });

  it('serves truecolor house imagery without Copernicus credentials', async () => {
    delete process.env.COPERNICUS_EMAIL;
    delete process.env.COPERNICUS_PASSWORD;

    globalThis.fetch = async (url) => {
      assert.match(String(url), /(DRAPP2022\/ImageServer\/exportImage|World_Imagery\/MapServer\/export)/);
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    };

    const baseUrl = await startServer();
    const response = await ORIGINAL_FETCH(`${baseUrl}/api/ndvi/image?mode=truecolor&size_meters=100`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /image\/jpeg/);
    assert.equal((await response.arrayBuffer()).byteLength, 3);
  });

  it('forwards NDVI query ranges without persisting ad hoc chart history', async () => {
    process.env.COPERNICUS_EMAIL = 'test@example.com';
    process.env.COPERNICUS_PASSWORD = 'secret';

    globalThis.fetch = async (url, init = {}) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (rawUrl.includes('/api/v1/statistics')) {
        const body = JSON.parse(init.body);
        assert.equal(body.aggregation.timeRange.from, '2026-01-01T00:00:00Z');
        assert.equal(body.aggregation.timeRange.to, '2026-01-31T23:59:59Z');
        assert.equal(body.aggregation.aggregationInterval.of, 'P30D');
        assert.equal(body.input.data[0].dataFilter.maxCloudCoverage, 15);
        return new Response(JSON.stringify({
          data: [{
            interval: {
              from: '2026-01-01T00:00:00Z',
              to: '2026-01-31T23:59:59Z',
            },
            outputs: {
              ndvi: {
                bands: {
                  B0: {
                    stats: {
                      mean: 0.42,
                      min: 0.21,
                      max: 0.71,
                      sampleCount: 12,
                    },
                  },
                },
              },
            },
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${rawUrl}`);
    };

    const baseUrl = await startServer();
    const response = await ORIGINAL_FETCH(`${baseUrl}/api/ndvi?from=2026-01-01&to=2026-01-31&interval=P30D&max_cloud_pct=15`);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).stats.length, 1);
    assert.equal(getDB().prepare('SELECT COUNT(*) AS count FROM ndvi_history').get().count, 0);
  });

  it('returns deterministic satellite analysis from the same monthly stats used by the UI', async () => {
    process.env.COPERNICUS_EMAIL = 'test@example.com';
    process.env.COPERNICUS_PASSWORD = 'secret';

    globalThis.fetch = async (url, init = {}) => {
      const rawUrl = String(url);
      if (rawUrl.includes('/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (rawUrl.includes('/api/v1/statistics')) {
        const body = JSON.parse(init.body);
        assert.equal(body.aggregation.timeRange.from, '2026-01-01T00:00:00Z');
        assert.equal(body.aggregation.timeRange.to, '2026-03-31T23:59:59Z');
        assert.equal(body.aggregation.aggregationInterval.of, 'P1M');
        assert.equal(body.aggregation.lastIntervalBehavior, 'SHORTEN');
        return new Response(JSON.stringify({
          data: [
            {
              interval: {
                from: '2026-01-01T00:00:00Z',
                to: '2026-01-31T23:59:59Z',
              },
              outputs: {
                ndvi: {
                  bands: {
                    B0: {
                      stats: {
                        mean: 0.22,
                        min: 0.10,
                        max: 0.40,
                        sampleCount: 10,
                      },
                    },
                  },
                },
              },
            },
            {
              interval: {
                from: '2026-02-01T00:00:00Z',
                to: '2026-02-28T23:59:59Z',
              },
              outputs: {
                ndvi: {
                  bands: {
                    B0: {
                      stats: {
                        mean: 0.31,
                        min: 0.17,
                        max: 0.49,
                        sampleCount: 12,
                      },
                    },
                  },
                },
              },
            },
            {
              interval: {
                from: '2026-03-01T00:00:00Z',
                to: '2026-03-31T23:59:59Z',
              },
              outputs: {
                ndvi: {
                  bands: {
                    B0: {
                      stats: {
                        mean: 0.39,
                        min: 0.20,
                        max: 0.57,
                        sampleCount: 14,
                      },
                    },
                  },
                },
              },
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${rawUrl}`);
    };

    const baseUrl = await startServer();
    const response = await ORIGINAL_FETCH(`${baseUrl}/api/satellite/analysis?from=2026-01-01&to=2026-03-31&interval=P1M`);

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.stats.length, 3);
    assert.equal(payload.analysis.latest.monthLabel, 'Mar 2026');
    assert.equal(payload.analysis.latest.categoryLabel, 'Moderate vegetation signal');
    assert.equal(payload.analysis.monthOverMonth.direction, 'up');
    assert.equal(payload.analysis.overall.direction, 'up');
    assert.equal(payload.analysis.strongestMonth.monthLabel, 'Mar 2026');
    assert.match(payload.analysis.readingGuide[0], /fixed alignment image/i);
    assert.match(payload.analysis.limitations[0], /10 meters wide/i);
  });
});
