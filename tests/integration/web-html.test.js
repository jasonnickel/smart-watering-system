import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, selectedAttr, button, badge, csrfField,
  moistureBar, currentNotice, noticeBanner, layout,
} from '../../src/web/html.js';

describe('HTML helpers', () => {
  describe('escapeHtml', () => {
    it('escapes all five HTML-sensitive characters', () => {
      assert.equal(escapeHtml('<script>"a&b\'c</script>'),
        '&lt;script&gt;&quot;a&amp;b&#39;c&lt;/script&gt;');
    });

    it('handles null and undefined gracefully', () => {
      assert.equal(escapeHtml(null), '');
      assert.equal(escapeHtml(undefined), '');
    });

    it('coerces numbers to strings', () => {
      assert.equal(escapeHtml(42), '42');
    });

    it('passes through safe strings unchanged', () => {
      assert.equal(escapeHtml('hello world'), 'hello world');
    });
  });

  describe('selectedAttr', () => {
    it('returns selected attribute when values match', () => {
      assert.equal(selectedAttr('lawn', 'lawn'), ' selected');
    });

    it('returns empty string when values differ', () => {
      assert.equal(selectedAttr('lawn', 'drip'), '');
    });
  });

  describe('button', () => {
    it('renders a primary button by default', () => {
      const html = button('Save');
      assert.match(html, /class="btn btn-primary"/);
      assert.match(html, />Save</);
    });

    it('renders a secondary button with variant', () => {
      const html = button('Cancel', 'secondary');
      assert.match(html, /class="btn btn-secondary"/);
    });
  });

  describe('badge', () => {
    it('renders a neutral badge by default', () => {
      const html = badge('Optional');
      assert.match(html, /badge-neutral/);
      assert.match(html, />Optional</);
    });

    it('escapes badge label', () => {
      const html = badge('<script>');
      assert.match(html, /&lt;script&gt;/);
      assert.doesNotMatch(html, /<script>/);
    });
  });

  describe('moistureBar', () => {
    it('renders red color for low moisture', () => {
      const html = moistureBar(20);
      assert.match(html, /#b42318/);
      assert.match(html, /20%/);
    });

    it('renders yellow color for medium moisture', () => {
      const html = moistureBar(50);
      assert.match(html, /#a15c00/);
    });

    it('renders green color for high moisture', () => {
      const html = moistureBar(80);
      assert.match(html, /#0f7b3e/);
    });

    it('caps width at 100%', () => {
      const html = moistureBar(150);
      assert.match(html, /width:100%/);
    });
  });

  describe('currentNotice', () => {
    it('returns notice object for known message codes', () => {
      const query = new URLSearchParams('msg=zones-saved');
      const notice = currentNotice(query);
      assert.equal(notice.tone, 'success');
      assert.match(notice.text, /Zone configuration saved/);
    });

    it('returns null for unknown message codes', () => {
      const query = new URLSearchParams('msg=unknown-code');
      assert.equal(currentNotice(query), null);
    });

    it('returns null when no msg param is present', () => {
      const query = new URLSearchParams('');
      assert.equal(currentNotice(query), null);
    });
  });

  describe('noticeBanner', () => {
    it('returns empty string for no notice', () => {
      assert.equal(noticeBanner(new URLSearchParams('')), '');
    });

    it('renders an alert role for error notices', () => {
      const html = noticeBanner(new URLSearchParams('msg=bad-auth'));
      assert.match(html, /role="alert"/);
      assert.match(html, /notice-error/);
    });

    it('renders a status role for non-error notices', () => {
      const html = noticeBanner(new URLSearchParams('msg=zones-saved'));
      assert.match(html, /role="status"/);
    });
  });

  describe('csrfField', () => {
    it('renders a hidden input with the token', () => {
      const html = csrfField('abc123');
      assert.match(html, /type="hidden"/);
      assert.match(html, /name="_csrf"/);
      assert.match(html, /value="abc123"/);
    });

    it('returns empty string for empty token', () => {
      assert.equal(csrfField(''), '');
    });

    it('escapes HTML in token value', () => {
      const html = csrfField('"><script>');
      assert.match(html, /&quot;&gt;&lt;script&gt;/);
    });
  });

  describe('layout', () => {
    it('renders a complete HTML document', () => {
      const html = layout('Test Page', '<p>content</p>', 'dashboard');
      assert.match(html, /<!DOCTYPE html>/);
      assert.match(html, /<title>Test Page - Smart Water<\/title>/);
      assert.match(html, /href="\/styles\.css(?:\?v=\d+)?"/);
      assert.match(html, /<p>content<\/p>/);
    });

    it('marks the active tab with aria-current', () => {
      const html = layout('Logs', '', 'logs');
      assert.match(html, /href="\/logs" aria-current="page"/);
      assert.doesNotMatch(html, /href="\/" aria-current/);
    });

    it('hides nav when showNav is false', () => {
      const html = layout('Login', '', '', { showNav: false });
      assert.doesNotMatch(html, /<nav/);
    });

    it('shows logout button only when authEnabled', () => {
      const withAuth = layout('Test', '', 'dashboard', { authEnabled: true });
      const noAuth = layout('Test', '', 'dashboard', { authEnabled: false });
      assert.match(withAuth, /action="\/logout"/);
      assert.doesNotMatch(noAuth, /action="\/logout"/);
    });

    it('links stylesheet and theme script instead of inline CSS', () => {
      const html = layout('Test', '', 'dashboard');
      assert.match(html, /rel="stylesheet" href="\/styles\.css(?:\?v=\d+)?"/);
      assert.match(html, /src="\/theme\.js"/);
      assert.doesNotMatch(html, /<style>/);
    });

    it('includes dark mode toggle button', () => {
      const html = layout('Test', '', 'dashboard');
      assert.match(html, /id="theme-toggle"/);
      assert.match(html, /class="theme-toggle"/);
    });
  });
});
