// Shared HTTP fetch with retry and timeout
// Replaces GAS UrlFetchApp with native Node.js fetch (available in Node 20+)

import { log } from '../log.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 15000;

/**
 * Fetch with exponential backoff retry.
 *
 * @param {string} url
 * @param {object} options - Standard fetch options
 * @param {string} label - Human-readable label for logging
 * @returns {Promise<object>} Parsed JSON response
 * @throws {Error} After all retries exhausted
 */
export async function fetchWithRetry(url, options = {}, label = 'API') {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let timeout;
    try {
      log(2, `${label} fetch attempt ${attempt}/${MAX_RETRIES}`);

      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`${label}: HTTP ${response.status} ${response.statusText}`);
      }

      if (response.status === 204) {
        return null;
      }

      const text = await response.text();
      if (!text.trim()) {
        return null;
      }

      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error(`${label}: Invalid JSON response (${err.message})`);
      }
    } catch (err) {
      log(1, `${label} error (attempt ${attempt}): ${err.message}`);

      if (attempt === MAX_RETRIES) throw err;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timeout);
    }
  }
}
