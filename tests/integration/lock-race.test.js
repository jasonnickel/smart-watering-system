import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDB, closeDB } from '../../src/db/state.js';

const tempDirs = [];

afterEach(() => {
  closeDB();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempDBPath() {
  const dir = mkdtempSync(join(tmpdir(), 'taproot-lock-'));
  tempDirs.push(dir);
  return join(dir, 'state.db');
}

function runLockAttempt(dbPath) {
  const script = `
    import { initDB, acquireRunLock, closeDB } from './src/db/state.js';
    initDB(${JSON.stringify(dbPath)});
    process.stdout.write(acquireRunLock() ? '1' : '0');
    closeDB();
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, DEBUG_LEVEL: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(stderr || `Child exited with ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

describe('Run lock concurrency', () => {
  it('allows only one concurrent winner across separate processes', async () => {
    const dbPath = makeTempDBPath();
    initDB(dbPath);
    closeDB();

    const attempts = await Promise.all(
      Array.from({ length: 6 }, () => runLockAttempt(dbPath))
    );
    const winners = attempts.filter(result => result.endsWith('1'));

    assert.equal(winners.length, 1, `Expected 1 lock winner, saw ${winners.length}: ${attempts.join(', ')}`);
  });
});
