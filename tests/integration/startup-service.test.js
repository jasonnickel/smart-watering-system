import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getStartupServiceOptions,
  normalizeStartupService,
  renderWebStartupServiceFile,
} from '../../src/startup-service.js';

describe('Startup service helpers', () => {
  it('offers launchd on macOS and systemd-user on Linux', () => {
    assert.deepEqual(
      getStartupServiceOptions('darwin').map(option => option.value),
      ['manual', 'launchd']
    );
    assert.deepEqual(
      getStartupServiceOptions('linux').map(option => option.value),
      ['manual', 'systemd-user']
    );
  });

  it('falls back to manual for unsupported startup-service values', () => {
    assert.equal(normalizeStartupService('banana', 'darwin'), 'manual');
    assert.equal(normalizeStartupService('launchd', 'linux'), 'manual');
  });

  it('renders a launchd plist with the Taproot CLI entrypoint', () => {
    const plist = renderWebStartupServiceFile('launchd', '/tmp/taproot-app');

    assert.match(plist, /com\.taproot\.web/);
    assert.match(plist, /src\/cli\.js/);
    assert.match(plist, /<key>RunAtLoad<\/key>/);
  });

  it('renders a systemd user service with the Taproot CLI entrypoint', () => {
    const unit = renderWebStartupServiceFile('systemd-user', '/tmp/taproot-app');

    assert.match(unit, /\[Unit\]/);
    assert.match(unit, /Description=Taproot Web UI/);
    assert.match(unit, /src\/cli\.js/);
    assert.match(unit, /WantedBy=default\.target/);
  });
});
