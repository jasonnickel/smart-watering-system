import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const deployDir = join(process.cwd(), 'deploy');

describe('Deployment assets', () => {
  it('installs and enables the daily summary units', () => {
    const installScript = readFileSync(join(deployDir, 'install.sh'), 'utf8');

    assert.match(installScript, /taproot-summary\.service/);
    assert.match(installScript, /taproot-summary\.timer/);
    assert.match(installScript, /systemctl enable --now taproot-summary\.timer/);
  });

  it('uses the same /home/jason layout as the other systemd units', () => {
    const summaryService = readFileSync(join(deployDir, 'taproot-summary.service'), 'utf8');

    assert.match(summaryService, /^User=jason$/m);
    assert.match(summaryService, /^WorkingDirectory=\/home\/jason\/taproot$/m);
    assert.match(summaryService, /^EnvironmentFile=\/home\/jason\/\.taproot\/\.env$/m);
  });
});
