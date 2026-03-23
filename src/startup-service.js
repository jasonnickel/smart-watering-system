import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { TAPROOT_HOME_DIR } from './paths.js';

const WEB_LABEL = 'taproot-web';
const LAUNCHD_LABEL = 'com.taproot.web';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdQuote(value) {
  return `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
}

function runCommand(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function getStartupServiceOptions(platform = process.platform) {
  const options = [
    { value: 'manual', label: 'Manual start', description: 'Start the dashboard yourself with taproot web.' },
  ];

  if (platform === 'darwin') {
    options.push({ value: 'launchd', label: 'macOS login item', description: 'Start the dashboard automatically with launchd.' });
  } else if (platform === 'linux') {
    options.push({ value: 'systemd-user', label: 'Linux user service', description: 'Start the dashboard automatically with a user systemd service.' });
  }

  return options;
}

export function normalizeStartupService(value, platform = process.platform) {
  const normalized = String(value || '').trim();
  const supported = new Set(getStartupServiceOptions(platform).map(option => option.value));
  return supported.has(normalized) ? normalized : 'manual';
}

export function getDefaultStartupService(platform = process.platform) {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd-user';
  return 'manual';
}

export function getStartupServicePlatformLabel(platform = process.platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  return 'this platform';
}

export function getStartupServicePaths(platform = process.platform) {
  if (platform === 'darwin') {
    return {
      service: 'launchd',
      filePath: join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
      label: LAUNCHD_LABEL,
      logsDir: join(TAPROOT_HOME_DIR, 'logs'),
    };
  }

  if (platform === 'linux') {
    return {
      service: 'systemd-user',
      filePath: join(homedir(), '.config', 'systemd', 'user', `${WEB_LABEL}.service`),
      label: WEB_LABEL,
      logsDir: join(TAPROOT_HOME_DIR, 'logs'),
    };
  }

  return {
    service: 'manual',
    filePath: '',
    label: WEB_LABEL,
    logsDir: join(TAPROOT_HOME_DIR, 'logs'),
  };
}

function buildLaunchdPlist(appRoot) {
  const scriptPath = join(appRoot, 'src', 'cli.js');
  const { logsDir } = getStartupServicePaths('darwin');
  const stdoutPath = join(logsDir, 'web.stdout.log');
  const stderrPath = join(logsDir, 'web.stderr.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>web</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

function buildSystemdUserUnit(appRoot) {
  const scriptPath = join(appRoot, 'src', 'cli.js');

  return `[Unit]
Description=Taproot Web UI
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(scriptPath)} web
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

export function renderWebStartupServiceFile(service, appRoot) {
  const normalized = String(service || '').trim();
  if (normalized === 'launchd') {
    return buildLaunchdPlist(appRoot);
  }
  if (normalized === 'systemd-user') {
    return buildSystemdUserUnit(appRoot);
  }
  return '';
}

export function getWebStartupServiceStatus(service, platform = process.platform) {
  const normalized = normalizeStartupService(service, platform);
  const paths = getStartupServicePaths(platform);
  if (normalized === 'manual' || normalized !== paths.service) {
    return {
      supported: normalized === 'manual',
      installed: false,
      active: false,
      detail: normalized === 'manual' ? 'Manual start selected.' : `Unsupported on ${getStartupServicePlatformLabel(platform)}.`,
      filePath: paths.filePath,
    };
  }

  const installed = existsSync(paths.filePath);
  let active = false;
  let detail = installed ? 'Installed' : 'Not installed';

  try {
    if (normalized === 'launchd') {
      runCommand('launchctl', ['print', `gui/${process.getuid()}/${paths.label}`]);
      active = true;
      detail = 'Loaded in launchd';
    } else if (normalized === 'systemd-user') {
      const state = runCommand('systemctl', ['--user', 'is-active', `${paths.label}.service`]);
      active = state === 'active';
      detail = active ? 'Active in systemd --user' : 'Installed but not active';
    }
  } catch {
    if (installed) {
      detail = normalized === 'launchd' ? 'Installed but not loaded' : 'Installed but not active';
    }
  }

  return {
    supported: true,
    installed,
    active,
    detail,
    filePath: paths.filePath,
  };
}

export function installWebStartupService(service, appRoot, platform = process.platform) {
  const normalized = normalizeStartupService(service, platform);
  if (normalized === 'manual') {
    return {
      service: normalized,
      installed: false,
      detail: 'Manual start selected. No startup service was installed.',
      filePath: '',
    };
  }

  const paths = getStartupServicePaths(platform);
  if (normalized !== paths.service) {
    throw new Error(`Startup service "${normalized}" is not supported on ${getStartupServicePlatformLabel(platform)}`);
  }

  mkdirSync(dirname(paths.filePath), { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(paths.filePath, renderWebStartupServiceFile(normalized, appRoot));

  if (normalized === 'launchd') {
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, paths.filePath], { stdio: 'ignore' });
    } catch {
      // Ignore stale bootout failures; bootstrap below is authoritative.
    }
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, paths.filePath], { stdio: 'ignore' });
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${paths.label}`], { stdio: 'ignore' });
  } else if (normalized === 'systemd-user') {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', `${paths.label}.service`], { stdio: 'ignore' });
  }

  return {
    service: normalized,
    installed: true,
    detail: `Installed ${normalized} startup service.`,
    filePath: paths.filePath,
  };
}

export function removeWebStartupService(service, platform = process.platform) {
  const normalized = normalizeStartupService(service, platform);
  const paths = getStartupServicePaths(platform);
  if (normalized === 'manual' || normalized !== paths.service || !paths.filePath) {
    return {
      service: normalized,
      removed: false,
      detail: 'No startup service is configured for removal.',
      filePath: paths.filePath,
    };
  }

  try {
    if (normalized === 'launchd') {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, paths.filePath], { stdio: 'ignore' });
    } else if (normalized === 'systemd-user') {
      execFileSync('systemctl', ['--user', 'disable', '--now', `${paths.label}.service`], { stdio: 'ignore' });
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    }
  } catch {
    // Removing the file below is the important cleanup path.
  }

  rmSync(paths.filePath, { force: true });
  return {
    service: normalized,
    removed: true,
    detail: `Removed ${normalized} startup service.`,
    filePath: paths.filePath,
  };
}

export function readInstalledWebStartupServiceFile(service, platform = process.platform) {
  const normalized = normalizeStartupService(service, platform);
  const paths = getStartupServicePaths(platform);
  if (normalized === 'manual' || normalized !== paths.service || !existsSync(paths.filePath)) {
    return '';
  }
  return readFileSync(paths.filePath, 'utf8');
}
