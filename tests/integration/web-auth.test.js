import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initAuth, authEnabled, createSession, hasValidSession,
  clearSession, verifyPassword, safeNextPath, getCsrfToken,
  verifyCsrf, checkLoginRate, recordLoginFailure, clearLoginFailures,
  AUTH_COOKIE_NAME,
} from '../../src/web/auth.js';

function fakeReq(cookieHeader = '') {
  return { headers: { cookie: cookieHeader }, socket: { remoteAddress: '127.0.0.1' } };
}

describe('Web auth module', () => {
  beforeEach(() => {
    initAuth('');
  });

  describe('authEnabled', () => {
    it('returns false when no password is set', () => {
      initAuth('');
      assert.equal(authEnabled(), false);
    });

    it('returns true when a password is set', () => {
      initAuth('secret123');
      assert.equal(authEnabled(), true);
    });
  });

  describe('verifyPassword', () => {
    it('accepts the correct password', () => {
      initAuth('hunter2');
      assert.equal(verifyPassword('hunter2'), true);
    });

    it('rejects an incorrect password', () => {
      initAuth('hunter2');
      assert.equal(verifyPassword('wrong'), false);
    });

    it('rejects a password with different length via constant-time compare', () => {
      initAuth('short');
      assert.equal(verifyPassword('a-much-longer-password'), false);
    });
  });

  describe('session lifecycle', () => {
    it('creates a session that validates', () => {
      initAuth('pass');
      const { token, csrfToken } = createSession();
      assert.ok(token.length > 0);
      assert.ok(csrfToken.length > 0);
      const req = fakeReq(`${AUTH_COOKIE_NAME}=${token}`);
      assert.equal(hasValidSession(req), true);
    });

    it('rejects a request with no session cookie', () => {
      initAuth('pass');
      assert.equal(hasValidSession(fakeReq()), false);
    });

    it('rejects a request with a bogus session token', () => {
      initAuth('pass');
      const req = fakeReq(`${AUTH_COOKIE_NAME}=bogus-token-abc`);
      assert.equal(hasValidSession(req), false);
    });

    it('clears a session so it no longer validates', () => {
      initAuth('pass');
      const { token } = createSession();
      const req = fakeReq(`${AUTH_COOKIE_NAME}=${token}`);
      assert.equal(hasValidSession(req), true);
      clearSession(req);
      assert.equal(hasValidSession(req), false);
    });

    it('allows all requests when auth is disabled', () => {
      initAuth('');
      assert.equal(hasValidSession(fakeReq()), true);
    });
  });

  describe('CSRF protection', () => {
    it('returns a CSRF token for a valid session', () => {
      initAuth('pass');
      const { token } = createSession();
      const req = fakeReq(`${AUTH_COOKIE_NAME}=${token}`);
      const csrf = getCsrfToken(req);
      assert.ok(csrf.length > 0);
    });

    it('returns empty CSRF when auth is disabled', () => {
      initAuth('');
      assert.equal(getCsrfToken(fakeReq()), '');
    });

    it('validates correct CSRF token', () => {
      initAuth('pass');
      const { token, csrfToken } = createSession();
      const req = fakeReq(`${AUTH_COOKIE_NAME}=${token}`);
      const body = new URLSearchParams({ _csrf: csrfToken });
      assert.equal(verifyCsrf(req, body), true);
    });

    it('rejects incorrect CSRF token', () => {
      initAuth('pass');
      const { token } = createSession();
      const req = fakeReq(`${AUTH_COOKIE_NAME}=${token}`);
      const body = new URLSearchParams({ _csrf: 'wrong-token' });
      assert.equal(verifyCsrf(req, body), false);
    });

    it('rejects missing CSRF token', () => {
      initAuth('pass');
      const { token } = createSession();
      const req = fakeReq(`${AUTH_COOKIE_NAME}=${token}`);
      const body = new URLSearchParams({});
      assert.equal(verifyCsrf(req, body), false);
    });

    it('passes CSRF check when auth is disabled', () => {
      initAuth('');
      const body = new URLSearchParams({});
      assert.equal(verifyCsrf(fakeReq(), body), true);
    });
  });

  describe('login rate limiting', () => {
    it('allows attempts below the limit', () => {
      initAuth('pass');
      assert.equal(checkLoginRate('1.2.3.4'), true);
      recordLoginFailure('1.2.3.4');
      assert.equal(checkLoginRate('1.2.3.4'), true);
    });

    it('blocks after too many failures', () => {
      initAuth('pass');
      for (let i = 0; i < 5; i++) {
        recordLoginFailure('5.6.7.8');
      }
      assert.equal(checkLoginRate('5.6.7.8'), false);
    });

    it('clears failures on success', () => {
      initAuth('pass');
      for (let i = 0; i < 4; i++) {
        recordLoginFailure('9.0.1.2');
      }
      clearLoginFailures('9.0.1.2');
      assert.equal(checkLoginRate('9.0.1.2'), true);
    });
  });

  describe('safeNextPath', () => {
    it('returns a valid absolute path unchanged', () => {
      assert.equal(safeNextPath('/settings'), '/settings');
    });

    it('returns / for empty input', () => {
      assert.equal(safeNextPath(''), '/');
      assert.equal(safeNextPath(null), '/');
      assert.equal(safeNextPath(undefined), '/');
    });

    it('blocks protocol-relative URLs', () => {
      assert.equal(safeNextPath('//evil.com'), '/');
    });

    it('blocks relative paths', () => {
      assert.equal(safeNextPath('evil.com'), '/');
    });

    it('preserves query strings on valid paths', () => {
      assert.equal(safeNextPath('/zones?msg=saved'), '/zones?msg=saved');
    });
  });
});
