import { config as loadEnv, parse as parseEnv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  TAPROOT_ENV_PATH,
  getDefaultEnvPath,
} from './paths.js';

export const HOME_ENV_PATH = TAPROOT_ENV_PATH;
export const ACTIVE_ENV_PATH = getDefaultEnvPath();
export const MANAGED_ENV_KEYS = [
  'RACHIO_API_KEY',
  'AMBIENT_API_KEY',
  'AMBIENT_APP_KEY',
  'AMBIENT_MAC_ADDRESS',
  'NOTIFICATION_EMAIL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'N8N_WEBHOOK_URL',
  'MQTT_BROKER_URL',
  'MQTT_TOPIC_PREFIX',
  'DEBUG_LEVEL',
  'SHADOW_MODE',
  'LAT',
  'LON',
  'LOCATION_TIMEZONE',
  'LOCATION_ADDRESS',
  'WEB_HOST',
  'WEB_PORT',
  'PUBLIC_BASE_URL',
  'WEB_STARTUP_SERVICE',
  'WEB_UI_PASSWORD',
];

loadEnv({ path: ACTIVE_ENV_PATH });

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function getEnvFilePath() {
  return ACTIVE_ENV_PATH;
}

export function readEnvFile() {
  if (!existsSync(ACTIVE_ENV_PATH)) {
    return '';
  }
  return readFileSync(ACTIVE_ENV_PATH, 'utf8');
}

export function readEnvValueFromContent(content, key) {
  const pattern = new RegExp(`^${escapeRegex(key)}=(.*)$`, 'm');
  const match = content.match(pattern);
  return match ? match[1] : null;
}

export function readEnvValue(key) {
  return readEnvValueFromContent(readEnvFile(), key);
}

export function syncManagedEnvFromContent(content) {
  const parsed = parseEnv(content || '');
  for (const key of MANAGED_ENV_KEYS) {
    if (Object.hasOwn(parsed, key)) {
      process.env[key] = parsed[key];
    } else {
      delete process.env[key];
    }
  }
}

export function upsertEnvValue(content, key, value) {
  // Strip newlines and carriage returns to prevent env injection
  const safeValue = String(value).replace(/[\r\n]/g, '');
  const pattern = new RegExp(`^${escapeRegex(key)}=.*$`, 'm');
  const nextLine = `${key}=${safeValue}`;

  if (pattern.test(content)) {
    return content.replace(pattern, nextLine);
  }

  const trimmed = content.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n${nextLine}\n` : `${nextLine}\n`;
}

export function deleteEnvValue(content, key) {
  const pattern = new RegExp(`^${escapeRegex(key)}=.*(?:\n|$)`, 'm');
  const next = content.replace(pattern, '');
  return next.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, match => match.includes('\n') ? '\n' : match);
}

export function writeEnvValue(key, value) {
  const nextContent = upsertEnvValue(readEnvFile(), key, value);
  mkdirSync(dirname(ACTIVE_ENV_PATH), { recursive: true });
  writeFileSync(ACTIVE_ENV_PATH, nextContent, { mode: 0o600 });
  process.env[key] = String(value);
}

export function readShadowMode() {
  const fileValue = readEnvValue('SHADOW_MODE');
  if (fileValue != null) {
    return fileValue === 'true';
  }
  return process.env.SHADOW_MODE === 'true';
}
