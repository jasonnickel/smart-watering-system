import { config as loadEnv } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const PROJECT_ENV_PATH = join(import.meta.dirname, '..', '.env');
export const HOME_ENV_PATH = join(homedir(), '.smart-water', '.env');
export const ACTIVE_ENV_PATH = existsSync(PROJECT_ENV_PATH) ? PROJECT_ENV_PATH : HOME_ENV_PATH;

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
