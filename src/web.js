#!/usr/bin/env node

// Taproot - Local Web UI
// Lightweight HTTP server for browser-based management.
// No framework - plain Node.js http module with server-rendered HTML.
//
// Usage: node src/web.js
// Default port: 3000 (override with WEB_PORT env var)

import './env.js';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { getEnvFilePath } from './env.js';
import { log } from './log.js';
import { initDB } from './db/state.js';
import { initAuth } from './web/auth.js';
import { createRequestHandler } from './web/routes.js';
import { ensureNarrativeTable } from './ai/narratives.js';
import {
  TAPROOT_ZONES_PATH,
  getDefaultDatabasePath,
} from './paths.js';

const APP_ROOT = join(import.meta.dirname, '..');
const HOST = process.env.WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const DB_PATH = getDefaultDatabasePath();
const ENV_PATH = getEnvFilePath();
const ZONES_PATH = existsSync(join(APP_ROOT, 'zones.yaml'))
  ? join(APP_ROOT, 'zones.yaml')
  : TAPROOT_ZONES_PATH;
const PUBLIC_DIR = join(import.meta.dirname, 'public');

initDB(DB_PATH);
ensureNarrativeTable();
initAuth(process.env.WEB_UI_PASSWORD);

const handler = createRequestHandler({
  host: HOST,
  port: PORT,
  appRoot: APP_ROOT,
  envPath: ENV_PATH,
  zonesPath: ZONES_PATH,
  publicDir: PUBLIC_DIR,
});

const server = createServer(handler);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Web UI could not start because ${HOST}:${PORT} is already in use. Set WEB_PORT to another port or stop the existing server.`);
    process.exit(1);
  }

  log(0, `Web UI failed to start: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(1, `Web UI running at http://${HOST}:${PORT}`);
});
