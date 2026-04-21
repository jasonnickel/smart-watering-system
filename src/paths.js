import Database from 'better-sqlite3';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PROJECT_ROOT = join(import.meta.dirname, '..');
export const PROJECT_ENV_PATH = join(PROJECT_ROOT, '.env');

export const TAPROOT_HOME_DIR = join(homedir(), '.taproot');
export const LEGACY_HOME_DIR = join(homedir(), '.smart-water');

export const TAPROOT_ENV_PATH = join(TAPROOT_HOME_DIR, '.env');
export const LEGACY_ENV_PATH = join(LEGACY_HOME_DIR, '.env');

export const TAPROOT_DB_PATH = join(TAPROOT_HOME_DIR, 'taproot.db');
export const LEGACY_DB_PATH = join(LEGACY_HOME_DIR, 'smart-water.db');

export const TAPROOT_ZONES_PATH = join(TAPROOT_HOME_DIR, 'zones.yaml');
export const LEGACY_ZONES_PATH = join(LEGACY_HOME_DIR, 'zones.yaml');

export const TAPROOT_RATES_PATH = join(TAPROOT_HOME_DIR, 'rates.yaml');
export const LEGACY_RATES_PATH = join(LEGACY_HOME_DIR, 'rates.yaml');

export const TAPROOT_RESTRICTIONS_PATH = join(TAPROOT_HOME_DIR, 'restrictions.yaml');

export const TAPROOT_STATUS_PAGE_PATH = join(TAPROOT_HOME_DIR, 'status.html');
export const LEGACY_STATUS_PAGE_PATH = join(LEGACY_HOME_DIR, 'status.html');

const FILE_MIGRATIONS = [
  { label: 'environment file', legacy: LEGACY_ENV_PATH, target: TAPROOT_ENV_PATH },
  { label: 'zone config', legacy: LEGACY_ZONES_PATH, target: TAPROOT_ZONES_PATH },
  { label: 'rate config', legacy: LEGACY_RATES_PATH, target: TAPROOT_RATES_PATH },
  { label: 'status page', legacy: LEGACY_STATUS_PAGE_PATH, target: TAPROOT_STATUS_PAGE_PATH },
];

let migrationSummary = null;

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function copyIfMissing(legacyPath, targetPath) {
  if (!existsSync(legacyPath) || existsSync(targetPath)) {
    return false;
  }

  ensureParentDir(targetPath);
  copyFileSync(legacyPath, targetPath);
  return true;
}

function countRowsIfTableExists(db, tableName) {
  const table = db.prepare(
    'SELECT name FROM sqlite_master WHERE type = ? AND name = ?'
  ).get('table', tableName);

  if (!table) {
    return 0;
  }

  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count || 0;
}

function databaseHasMeaningfulData(dbPath) {
  if (!existsSync(dbPath)) {
    return false;
  }

  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return (
        countRowsIfTableExists(db, 'runs') > 0
        || countRowsIfTableExists(db, 'soil_moisture') > 0
        || countRowsIfTableExists(db, 'weather_cache') > 0
      );
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function backupExistingFile(filePath) {
  const backupPath = `${filePath}.bak-${Date.now()}`;
  if (!existsSync(filePath)) {
    return '';
  }
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function migrateDatabase() {
  if (!existsSync(LEGACY_DB_PATH)) {
    return { migrated: false, backupPath: '', reason: 'missing-legacy-db' };
  }

  if (!existsSync(TAPROOT_DB_PATH)) {
    ensureParentDir(TAPROOT_DB_PATH);
    copyFileSync(LEGACY_DB_PATH, TAPROOT_DB_PATH);
    return { migrated: true, backupPath: '', reason: 'copied-missing-db' };
  }

  const legacyStats = statSync(LEGACY_DB_PATH);
  let taprootStats;
  try {
    taprootStats = statSync(TAPROOT_DB_PATH);
  } catch {
    ensureParentDir(TAPROOT_DB_PATH);
    copyFileSync(LEGACY_DB_PATH, TAPROOT_DB_PATH);
    return { migrated: true, backupPath: '', reason: 'copied-raced-db' };
  }
  const legacyHasData = databaseHasMeaningfulData(LEGACY_DB_PATH);
  const taprootHasData = databaseHasMeaningfulData(TAPROOT_DB_PATH);

  if (!legacyHasData || taprootHasData) {
    return { migrated: false, backupPath: '', reason: taprootHasData ? 'taproot-has-data' : 'legacy-empty' };
  }

  if (legacyStats.size <= taprootStats.size) {
    return { migrated: false, backupPath: '', reason: 'taproot-not-smaller' };
  }

  const backupPath = backupExistingFile(TAPROOT_DB_PATH);
  copyFileSync(LEGACY_DB_PATH, TAPROOT_DB_PATH);
  return { migrated: true, backupPath, reason: 'replaced-empty-db' };
}

export function ensureTaprootHomeMigration() {
  if (migrationSummary) {
    return migrationSummary;
  }

  mkdirSync(TAPROOT_HOME_DIR, { recursive: true });

  const copied = [];
  for (const migration of FILE_MIGRATIONS) {
    if (copyIfMissing(migration.legacy, migration.target)) {
      copied.push(migration.label);
    }
  }

  const database = migrateDatabase();

  migrationSummary = {
    legacyHomeDetected: existsSync(LEGACY_HOME_DIR),
    copied,
    databaseMigrated: database.migrated,
    databaseBackupPath: database.backupPath,
    databaseReason: database.reason,
  };

  return migrationSummary;
}

ensureTaprootHomeMigration();

export function getDefaultEnvPath() {
  return existsSync(PROJECT_ENV_PATH) ? PROJECT_ENV_PATH : TAPROOT_ENV_PATH;
}

export function getDefaultDatabasePath() {
  return process.env.DB_PATH || TAPROOT_DB_PATH;
}

export function getProjectZonesPath() {
  return join(PROJECT_ROOT, 'zones.yaml');
}

export function getProjectRatesPath() {
  return join(PROJECT_ROOT, 'rates.yaml');
}
