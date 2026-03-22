import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  initAuth, authEnabled, createSession, hasValidSession,
  clearSession, verifyPassword, safeNextPath,
  AUTH_COOKIE_NAME,
} from '../../src/web/auth.js';

function fakeReq(cookieHeader = '') {
  return { headers: { cookie: cookieHeader } };
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

    it('rejects a password with different length via timing-safe compare', () => {
      initAuth('short');
      assert.equal(verifyPassword('a-much-longer-password'), false);
    });
  });

  describe('session lifecycle', () => {
    it('creates a session token that validates', () => {
      initAuth('pass');
      const token = createSession();
      assert.ok(token.length > 0);
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
      const token = createSession();
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
