import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initDB,
  closeDB,
  getDB,
  getNDVIHistory,
  getRunsSince,
  getStatus,
  acquireRunLock,
  releaseRunLock,
  saveNDVIReading,
  setSystemState,
  getSystemState,
} from '../../src/db/state.js';
import { formatTimestamp } from '../../src/time.js';

const tempDirs = [];

afterEach(() => {
  closeDB();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDBPath() {
  const dir = mkdtempSync(join(tmpdir(), 'taproot-state-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

describe('SQLite timestamp interoperability', () => {
  it('includes same-day legacy SQLite timestamps in recent-run queries', () => {
    const dbPath = makeTempDBPath();
    initDB(dbPath);

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    getDB().prepare(`
      INSERT INTO runs (timestamp, window, phase, decision, reason, success, shadow)
      VALUES (?, 'daily', 'DECIDE', 'SKIP', 'legacy same-day run', 1, 0)
    `).run(`${today} 06:30:00`);
    getDB().prepare(`
      INSERT INTO runs (timestamp, window, phase, decision, reason, success, shadow)
      VALUES (?, 'daily', 'DECIDE', 'SKIP', 'older run', 1, 0)
    `).run(`${yesterday} 23:55:00`);

    const runs = getRunsSince(`${today}T06:00:00.000Z`);

    assert.equal(runs.length, 1);
    assert.equal(runs[0].reason, 'legacy same-day run');
    assert.equal(getStatus(today).lastRun.reason, 'legacy same-day run');
  });
});

describe('Run lock semantics', () => {
  it('takes over stale locks and releases only the acquired token', () => {
    const dbPath = makeTempDBPath();
    initDB(dbPath);

    const staleValue = `${formatTimestamp(new Date(Date.now() - 11 * 60000))}|stale-owner`;
    setSystemState('run_lock', staleValue);

    assert.equal(acquireRunLock(), true);
    assert.notEqual(getSystemState('run_lock'), staleValue);

    releaseRunLock();
    assert.equal(getSystemState('run_lock'), null);
  });

  it('rejects a fresh lock held by another runner', () => {
    const dbPath = makeTempDBPath();
    initDB(dbPath);

    setSystemState('run_lock', `${formatTimestamp()}|other-runner`);

    assert.equal(acquireRunLock(), false);
    assert.match(getSystemState('run_lock'), /\|other-runner$/);
  });
});

describe('NDVI history storage', () => {
  it('upserts the same NDVI period instead of duplicating it', () => {
    const dbPath = makeTempDBPath();
    initDB(dbPath);

    saveNDVIReading(39.7, -105.2, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-17T23:59:59Z',
      mean: 0.31,
      min: 0.15,
      max: 0.48,
      samples: 8,
    });
    saveNDVIReading(39.7, -105.2, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-17T23:59:59Z',
      mean: 0.42,
      min: 0.21,
      max: 0.63,
      samples: 12,
    });

    const rows = getDB().prepare('SELECT ndvi_mean, sample_count FROM ndvi_history').all();

    assert.equal(rows.length, 1);
    assert.equal(rows[0].ndvi_mean, 0.42);
    assert.equal(rows[0].sample_count, 12);
  });

  it('can scope NDVI history to a specific location', () => {
    const dbPath = makeTempDBPath();
    initDB(dbPath);

    saveNDVIReading(39.7, -105.2, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-17T23:59:59Z',
      mean: 0.42,
      min: 0.21,
      max: 0.63,
      samples: 12,
    });
    saveNDVIReading(39.8, -105.3, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-17T23:59:59Z',
      mean: 0.12,
      min: 0.05,
      max: 0.19,
      samples: 10,
    });

    const rows = getNDVIHistory(180, 39.7, -105.2);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].ndvi_mean, 0.42);
  });
});
