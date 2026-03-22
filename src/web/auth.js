// Session-based authentication for the web UI.

import { randomBytes, timingSafeEqual } from 'node:crypto';

const AUTH_COOKIE_NAME = 'smart_water_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

let _password = '';

export function initAuth(password) {
  _password = password || '';
}

export function authEnabled() {
  return _password.length > 0;
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of sessions.entries()) {
    if (expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const cookies = {};
  for (const pair of raw.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (!name) continue;
    cookies[name] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

export function createSession() {
  pruneSessions();
  const token = randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function clearSession(req) {
  const cookies = parseCookies(req);
  if (cookies[AUTH_COOKIE_NAME]) {
    sessions.delete(cookies[AUTH_COOKIE_NAME]);
  }
}

export function hasValidSession(req) {
  if (!authEnabled()) return true;
  pruneSessions();
  const token = parseCookies(req)[AUTH_COOKIE_NAME];
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function verifyPassword(candidate) {
  return safeCompare(candidate, _password);
}

export function safeNextPath(value) {
  const next = String(value || '').trim();
  if (!next.startsWith('/') || next.startsWith('//')) {
    return '/';
  }
  return next;
}

export { AUTH_COOKIE_NAME, SESSION_TTL_MS };
