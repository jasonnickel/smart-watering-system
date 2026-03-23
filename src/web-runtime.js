import { hostname } from 'node:os';

export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 3000;
export const DEFAULT_PUBLIC_BASE_URL = '';

export function normalizeWebHost(value) {
  const trimmed = String(value || '').trim();
  return trimmed || DEFAULT_WEB_HOST;
}

export function normalizeWebPort(value) {
  const parsed = parseInt(String(value || DEFAULT_WEB_PORT), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return DEFAULT_WEB_PORT;
  }
  return parsed;
}

export function normalizePublicBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  const url = new URL(trimmed);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Bookmark URL must start with http:// or https://');
  }

  return url.toString().replace(/\/+$/, '');
}

export function dashboardAccessModeFromHost(host) {
  const normalized = normalizeWebHost(host);
  if (normalized === '127.0.0.1' || normalized === 'localhost') {
    return 'local';
  }
  if (normalized === '0.0.0.0' || normalized === '::') {
    return 'network';
  }
  return 'custom';
}

export function hostForDashboardAccess(mode, currentHost = DEFAULT_WEB_HOST) {
  if (mode === 'network') {
    return '0.0.0.0';
  }
  if (mode === 'custom') {
    return normalizeWebHost(currentHost);
  }
  return DEFAULT_WEB_HOST;
}

export function deriveBookmarkUrl({ host, port, publicBaseUrl }) {
  const normalizedHost = normalizeWebHost(host);
  const normalizedPort = normalizeWebPort(port);

  if (publicBaseUrl) {
    return normalizePublicBaseUrl(publicBaseUrl);
  }

  if (normalizedHost === '0.0.0.0' || normalizedHost === '::') {
    return `http://${hostname()}:${normalizedPort}`;
  }

  if (normalizedHost === 'localhost') {
    return `http://localhost:${normalizedPort}`;
  }

  return `http://${normalizedHost}:${normalizedPort}`;
}
