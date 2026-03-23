import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDB, initDB } from '../../src/db/state.js';
import { initAuth } from '../../src/web/auth.js';
import { createRequestHandler } from '../../src/web/routes.js';

const tempDirs = [];
let server = null;

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
});
