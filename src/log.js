// Simple structured logger
// Writes to stdout for systemd journal capture

const LEVEL = parseInt(process.env.DEBUG_LEVEL || '1', 10);

/**
 * Log a message at the given level.
 * Level 0 = errors only, 1 = info, 2 = debug
 *
 * @param {number} level
 * @param {string} message
 */
export function log(level, message) {
  if (level > LEVEL) return;

  const prefix = level === 0 ? 'ERROR' : level === 1 ? 'INFO' : 'DEBUG';
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} [${prefix}] ${message}`);
}
