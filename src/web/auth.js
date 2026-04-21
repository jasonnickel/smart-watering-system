// Session-based authentication for the web UI.

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const AUTH_COOKIE_NAME = 'taproot_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// session token -> { expiresAt, csrfToken }
const sessions = new Map();

// IP -> { count, lockedUntil }
const loginAttempts = new Map();

let _password = '';

export function initAuth(password) {
  const nextPassword = password || '';
  if (nextPassword !== _password) {
    sessions.clear();
  }
  _password = nextPassword;
}

export function authEnabled() {
  return _password.length > 0;
}

// Compare with constant-length digests to avoid leaking password length
function safeCompare(left, right) {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
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
    try {
      cookies[name] = decodeURIComponent(rest.join('='));
    } catch {
      cookies[name] = rest.join('=');
    }
  }
  return cookies;
}

export function createSession() {
  pruneSessions();
  const token = randomBytes(24).toString('hex');
  const csrfToken = randomBytes(24).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, csrfToken });
  return { token, csrfToken };
}

export function clearSession(req) {
  const cookies = parseCookies(req);
  if (cookies[AUTH_COOKIE_NAME]) {
    sessions.delete(cookies[AUTH_COOKIE_NAME]);
  }
}

function getSession(req) {
  const token = parseCookies(req)[AUTH_COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(token);
    return null;
  }
  return session;
}

export function hasValidSession(req) {
  if (!authEnabled()) return true;
  pruneSessions();
  return getSession(req) !== null;
}

export function getCsrfToken(req) {
  if (!authEnabled()) return '';
  const session = getSession(req);
  return session ? session.csrfToken : '';
}

export function verifyCsrf(req, body) {
  if (!authEnabled()) return true;
  const session = getSession(req);
  if (!session) return false;
  const submitted = body.get('_csrf') || '';
  if (!submitted) return false;
  return safeCompare(submitted, session.csrfToken);
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

// Rate limiting for login attempts
export function checkLoginRate(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
    return false;
  }
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
    loginAttempts.delete(ip);
    return true;
  }
  return true;
}

export function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count++;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
  }
  loginAttempts.set(ip, entry);
}

export function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

export { AUTH_COOKIE_NAME, SESSION_TTL_MS };
