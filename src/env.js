import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const projectEnv = join(import.meta.dirname, '..', '.env');
const homeEnv = join(homedir(), '.smart-water', '.env');

loadEnv({ path: existsSync(projectEnv) ? projectEnv : homeEnv });
