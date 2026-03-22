#!/usr/bin/env node

// Smart Water System - Local Web UI
// Lightweight HTTP server for browser-based management.
// No framework - plain Node.js http module with server-rendered HTML.
//
// Usage: node src/web.js
// Default port: 3000 (override with WEB_PORT env var)

import './env.js';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';
import yaml from 'js-yaml';

import CONFIG from './config.js';
import { getEnvFilePath, readEnvFile, readShadowMode, writeEnvValue } from './env.js';
import {
  applyGuidedSettings,
  buildGuidedSettingsModel,
  buildZoneConfigYaml,
  normalizeSoilProfiles,
  normalizeZones,
  parseZoneConfig,
} from './web-forms.js';
import { log } from './log.js';
import { explainDecision, shortExplanation } from './explain.js';
import { chartsPageContent, getMoistureHistory } from './charts.js';
import { localDateStr, minutesSinceTimestamp } from './time.js';
import {
  initDB, getStatus, getStatusJSON, getRunsSince, getFinanceData,
  getCachedWeather,
} from './db/state.js';

const APP_ROOT = join(import.meta.dirname, '..');
const HOST = process.env.WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');
const ENV_PATH = getEnvFilePath();
const ZONES_PATH = existsSync(join(APP_ROOT, 'zones.yaml'))
  ? join(APP_ROOT, 'zones.yaml')
  : join(homedir(), '.smart-water', 'zones.yaml');

const WEB_UI_PASSWORD = process.env.WEB_UI_PASSWORD || '';
const AUTH_COOKIE_NAME = 'smart_water_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

initDB(DB_PATH);

function authEnabled() {
  return WEB_UI_PASSWORD.length > 0;
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

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const cookies = {};
  for (const pair of raw.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (!name) continue;
    cookies[name] = decodeURIComponent(rest.join('='));
  }
  return cookies;
}

function createSession() {
  pruneSessions();
  const token = randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function clearSession(req) {
  const cookies = parseCookies(req);
  if (cookies[AUTH_COOKIE_NAME]) {
    sessions.delete(cookies[AUTH_COOKIE_NAME]);
  }
}

function hasValidSession(req) {
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

function safeNextPath(value) {
  const next = String(value || '').trim();
  if (!next.startsWith('/') || next.startsWith('//')) {
    return '/';
  }
  return next;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function selectedAttr(value, expected) {
  return value === expected ? ' selected' : '';
}

function button(label, variant = 'primary', extra = '') {
  return `<button class="btn btn-${variant}" type="submit"${extra}>${label}</button>`;
}

function badge(label, tone = 'neutral') {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

function moistureBar(pct) {
  const color = pct < 40 ? '#b42318' : pct < 60 ? '#a15c00' : '#0f7b3e';
  return `<div class="meter" aria-label="${pct}% soil moisture">
    <div class="meter-track">
      <div class="meter-fill" style="width:${Math.min(pct, 100)}%;background:${color};"></div>
    </div>
    <span class="meter-value">${pct}%</span>
  </div>`;
}

function currentNotice(query) {
  const message = query?.get('msg');
  const notices = {
    'manual-started': { tone: 'info', text: 'Manual watering run started. Check Run History in a few seconds.' },
    'live-on': { tone: 'success', text: 'Live mode enabled. Future WATER decisions will actuate your Rachio controller.' },
    'shadow-on': { tone: 'warning', text: 'Shadow mode enabled. Future decisions will be logged without actuating Rachio.' },
    'zones-saved': { tone: 'success', text: 'Zone configuration saved.' },
    'zones-error': { tone: 'error', text: 'Zone configuration was not saved. Review the values and try again.' },
    'settings-saved': { tone: 'success', text: 'Settings saved. Restart the web UI if you changed the host, port, or login password.' },
    'settings-error': { tone: 'error', text: 'Settings were not saved. Review the form values and try again.' },
    'setup-saved': { tone: 'success', text: 'Guided setup saved. Run smart-water doctor or refresh the dashboard to verify connectivity.' },
    'setup-error': { tone: 'error', text: 'Guided setup was not saved. Review the form values and try again.' },
    'smoke-started': { tone: 'warning', text: 'Live smoke test started. Watch Run History and your controller for the result.' },
    'login-required': { tone: 'warning', text: 'Sign in to use the web UI.' },
    'bad-auth': { tone: 'error', text: 'The password was incorrect.' },
    'logged-out': { tone: 'info', text: 'You are signed out.' },
  };
  return notices[message] || null;
}

function noticeBanner(query) {
  const notice = currentNotice(query);
  if (!notice) return '';
  return `<div class="card notice notice-${notice.tone}" role="${notice.tone === 'error' ? 'alert' : 'status'}" aria-live="polite">
    ${escapeHtml(notice.text)}
  </div>`;
}

function layout(title, content, activeTab, options = {}) {
  const { showNav = true } = options;
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', path: '/' },
    { id: 'logs', label: 'Run History', path: '/logs' },
    { id: 'zones', label: 'Zones', path: '/zones' },
    { id: 'charts', label: 'Charts', path: '/charts' },
    { id: 'settings', label: 'Settings', path: '/settings' },
    { id: 'setup', label: 'Guided Setup', path: '/setup' },
  ];

  const navHtml = showNav
    ? `<nav class="nav" aria-label="Primary">
        ${tabs.map(tab => `<a href="${tab.path}"${activeTab === tab.id ? ' aria-current="page"' : ''}>${tab.label}</a>`).join('')}
      </nav>`
    : '';

  const logoutHtml = authEnabled() && showNav
    ? `<form method="POST" action="/logout" class="header-actions">
        ${button('Sign Out', 'secondary')}
      </form>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} - Smart Water</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0b5fff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Smart Water">
  <link rel="apple-touch-icon" href="/icon-192.svg">
  <style>
    :root {
      color-scheme: light;
      --bg: #edf2f7;
      --surface: #ffffff;
      --text: #102a43;
      --muted: #52606d;
      --border: #cbd2d9;
      --primary: #0b5fff;
      --primary-dark: #0843b5;
      --success: #0f7b3e;
      --warning: #a15c00;
      --danger: #b42318;
      --focus: #ffbf47;
      --shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(180deg, #f8fbff 0%, var(--bg) 100%);
      color: var(--text);
      line-height: 1.5;
    }
    a { color: var(--primary-dark); }
    a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }
    .skip-link {
      position: absolute;
      left: -999px;
      top: 12px;
      background: var(--focus);
      color: #111827;
      padding: 10px 14px;
      border-radius: 8px;
      font-weight: 700;
      z-index: 1000;
    }
    .skip-link:focus { left: 16px; }
    .header {
      background: rgba(255, 255, 255, 0.94);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 16px;
    }
    .header-inner {
      max-width: 980px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .header h1 {
      margin: 0;
      font-size: 1.25rem;
      color: var(--primary-dark);
    }
    .header p {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 0.95rem;
    }
    .header-actions {
      margin: 0;
      flex-shrink: 0;
    }
    .nav {
      max-width: 980px;
      margin: 0 auto;
      display: flex;
      gap: 6px;
      padding: 0 16px 16px;
      overflow-x: auto;
    }
    .nav a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      padding: 10px 14px;
      border-radius: 999px;
      color: var(--muted);
      border: 1px solid transparent;
      white-space: nowrap;
      font-weight: 600;
    }
    .nav a[aria-current="page"] {
      color: var(--primary-dark);
      background: #e7f0ff;
      border-color: #bfd4ff;
    }
    .container {
      max-width: 980px;
      margin: 0 auto;
      padding: 0 16px 32px;
    }
    .grid {
      display: grid;
      gap: 16px;
    }
    .grid-2 {
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .card {
      background: var(--surface);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 16px;
      box-shadow: var(--shadow);
      padding: 18px;
      margin-bottom: 16px;
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 1rem;
      letter-spacing: 0.02em;
    }
    .card h3 {
      margin: 0 0 10px;
      font-size: 0.95rem;
    }
    .helper {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .small {
      font-size: 0.84rem;
      color: var(--muted);
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 16px;
      border-radius: 10px;
      border: 1px solid transparent;
      cursor: pointer;
      text-decoration: none;
      font-weight: 700;
      font-size: 0.95rem;
    }
    .btn-primary {
      background: var(--primary);
      color: white;
    }
    .btn-primary:hover { background: var(--primary-dark); }
    .btn-secondary {
      background: #eef2f7;
      color: var(--text);
      border-color: var(--border);
    }
    .btn-success {
      background: var(--success);
      color: white;
    }
    .btn-warning {
      background: var(--warning);
      color: white;
    }
    .btn-danger {
      background: var(--danger);
      color: white;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .stat-list {
      display: grid;
      gap: 8px;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid #eef2f7;
    }
    .stat:last-child { border-bottom: 0; }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.82rem;
      font-weight: 700;
    }
    .badge-success { background: #e6f6ec; color: var(--success); }
    .badge-warning { background: #fff4e5; color: var(--warning); }
    .badge-error { background: #feeceb; color: var(--danger); }
    .badge-neutral { background: #eef2f7; color: var(--text); }
    .notice { border-left: 6px solid var(--primary); }
    .notice-success { border-left-color: var(--success); }
    .notice-warning { border-left-color: var(--warning); }
    .notice-error { border-left-color: var(--danger); }
    form { margin: 0; }
    fieldset {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      margin: 0 0 14px;
    }
    legend {
      font-weight: 700;
      padding: 0 8px;
    }
    .form-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .form-row {
      display: grid;
      gap: 6px;
    }
    label {
      font-weight: 600;
      color: var(--text);
      font-size: 0.94rem;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      font: inherit;
      color: var(--text);
      background: white;
    }
    textarea {
      min-height: 180px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 1.45;
    }
    .checkbox-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      margin-top: 4px;
    }
    .checkbox-row input {
      width: auto;
      margin-top: 2px;
    }
    .table-wrapper {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    th, td {
      text-align: left;
      padding: 10px 8px;
      border-bottom: 1px solid #eef2f7;
      vertical-align: top;
    }
    th {
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
    }
    caption {
      text-align: left;
      font-weight: 700;
      padding-bottom: 10px;
    }
    details {
      border-top: 1px solid #eef2f7;
      padding-top: 14px;
      margin-top: 14px;
    }
    summary {
      cursor: pointer;
      font-weight: 700;
      color: var(--primary-dark);
    }
    .meter {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .meter-track {
      flex: 1;
      background: #e4e7eb;
      border-radius: 999px;
      height: 12px;
      overflow: hidden;
    }
    .meter-fill {
      height: 12px;
      border-radius: 999px;
    }
    .meter-value {
      min-width: 42px;
      text-align: right;
      font-weight: 700;
      font-size: 0.88rem;
    }
    .setup-cta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
    }
    .inline-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #eef2f7;
      border-radius: 8px;
      padding: 2px 6px;
    }
    @media (max-width: 640px) {
      .header-inner {
        flex-direction: column;
        align-items: flex-start;
      }
      .actions, .setup-cta {
        flex-direction: column;
        align-items: stretch;
      }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <header class="header">
    <div class="header-inner">
      <div>
        <h1>Smart Water System</h1>
        <p>Optional browser setup for non-coders, plus the same file-and-CLI workflow for power users.</p>
      </div>
      ${logoutHtml}
    </div>
  </header>
  ${navHtml}
  <main id="main" class="container">
    ${content}
  </main>
  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  </script>
</body>
</html>`;
}

function loginPage(query) {
  if (!authEnabled()) {
    return layout('Login', `<div class="card"><h2>Web Login Is Disabled</h2><p class="helper">Set <span class="inline-code">WEB_UI_PASSWORD</span> in your env file and restart the web UI if you want an optional sign-in layer.</p></div>`, '', { showNav: false });
  }

  const next = safeNextPath(query.get('next'));
  return layout('Sign In', `
    ${noticeBanner(query)}
    <div class="card">
      <h2>Sign In</h2>
      <p class="helper">This local web UI is protected by an optional password. Coders can still manage the project directly through the CLI and config files.</p>
      <form method="POST" action="/login">
        <input type="hidden" name="next" value="${escapeHtml(next)}">
        <div class="form-row">
          <label for="login-password">Web UI password</label>
          <input id="login-password" name="password" type="password" autocomplete="current-password" required>
        </div>
        <div class="actions">
          ${button('Sign In')}
        </div>
      </form>
    </div>
  `, '', { showNav: false });
}

function configuredSetupCard() {
  return `<div class="card">
    <h2>Choose Your Workflow</h2>
    <div class="setup-cta">
      <p class="helper">Prefer terminal and files? Keep using <span class="inline-code">smart-water setup</span>, <span class="inline-code">smart-water doctor</span>, and the raw editors below. Prefer a guided browser flow? Use the Guided Setup tab.</p>
      <a class="btn btn-secondary" href="/setup">Open Guided Setup</a>
    </div>
  </div>`;
}

function renderGuidedSettingsForm(model, options = {}) {
  const {
    action = '/settings/guided-save',
    submitLabel = 'Save Guided Settings',
    intro = '',
    showDisablePassword = true,
  } = options;

  const rachioHint = model.rachioConfigured
    ? 'A Rachio key is already saved. Leave blank to keep it.'
    : 'Paste your Rachio API key here.';
  const ambientHint = model.ambientApiConfigured || model.ambientAppConfigured || model.ambientMacConfigured
    ? 'Ambient Weather credentials are already saved. Leave blank to keep them.'
    : 'Leave blank if you want to rely on Open-Meteo fallback data.';
  const authHint = model.webUiPasswordConfigured
    ? 'A web login password is already saved. Leave blank to keep it.'
    : 'Leave blank to keep the web UI open on localhost without a password.';

  return `
    ${intro}
    <form method="POST" action="${action}">
      <fieldset>
        <legend>Rachio Controller</legend>
        <p class="helper">${rachioHint}</p>
        <div class="form-grid">
          <div class="form-row">
            <label for="rachio-api-key">Rachio API key</label>
            <input id="rachio-api-key" name="rachio_api_key" type="password" autocomplete="off" placeholder="${model.rachioConfigured ? 'Saved. Leave blank to keep.' : 'Paste Rachio API key'}">
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Weather Station</legend>
        <p class="helper">${ambientHint}</p>
        <div class="form-grid">
          <div class="form-row">
            <label for="ambient-api-key">Ambient Weather API key</label>
            <input id="ambient-api-key" name="ambient_api_key" type="password" autocomplete="off" placeholder="${model.ambientApiConfigured ? 'Saved. Leave blank to keep.' : 'Optional'}">
          </div>
          <div class="form-row">
            <label for="ambient-app-key">Ambient Weather application key</label>
            <input id="ambient-app-key" name="ambient_app_key" type="password" autocomplete="off" placeholder="${model.ambientAppConfigured ? 'Saved. Leave blank to keep.' : 'Optional'}">
          </div>
          <div class="form-row">
            <label for="ambient-mac-address">Ambient station MAC address</label>
            <input id="ambient-mac-address" name="ambient_mac_address" type="password" autocomplete="off" placeholder="${model.ambientMacConfigured ? 'Saved. Leave blank to keep.' : 'Optional'}">
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Notifications</legend>
        <p class="helper">Notifications currently go through an optional webhook receiver such as n8n.</p>
        <div class="form-grid">
          <div class="form-row">
            <label for="notification-email">Notification email</label>
            <input id="notification-email" name="notification_email" type="email" value="${escapeHtml(model.notificationEmail)}" placeholder="optional@example.com">
          </div>
          <div class="form-row">
            <label for="webhook-url">Webhook URL</label>
            <input id="webhook-url" name="webhook_url" type="url" value="${escapeHtml(model.webhookUrl)}" placeholder="https://your-n8n.example/webhook/smart-water">
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Location</legend>
        <p class="helper">Used for Open-Meteo forecasts and local schedule timing.</p>
        <div class="form-grid">
          <div class="form-row">
            <label for="lat">Latitude</label>
            <input id="lat" name="lat" type="text" inputmode="decimal" value="${escapeHtml(model.lat)}">
          </div>
          <div class="form-row">
            <label for="lon">Longitude</label>
            <input id="lon" name="lon" type="text" inputmode="decimal" value="${escapeHtml(model.lon)}">
          </div>
          <div class="form-row">
            <label for="location-timezone">Timezone</label>
            <input id="location-timezone" name="location_timezone" type="text" value="${escapeHtml(model.locationTimezone)}" placeholder="America/Denver">
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Home Assistant And MQTT</legend>
        <div class="form-grid">
          <div class="form-row">
            <label for="mqtt-broker-url">MQTT broker URL</label>
            <input id="mqtt-broker-url" name="mqtt_broker_url" type="text" value="${escapeHtml(model.mqttBrokerUrl)}" placeholder="mqtt://192.168.1.50:1883">
          </div>
          <div class="form-row">
            <label for="mqtt-topic-prefix">MQTT topic prefix</label>
            <input id="mqtt-topic-prefix" name="mqtt_topic_prefix" type="text" value="${escapeHtml(model.mqttTopicPrefix)}" placeholder="smart-water">
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Web UI And Safety</legend>
        <div class="form-grid">
          <div class="form-row">
            <label for="shadow-mode">Operating mode</label>
            <select id="shadow-mode" name="shadow_mode">
              <option value="true"${selectedAttr(model.shadowMode ? 'true' : 'false', 'true')}>Shadow mode (safe default)</option>
              <option value="false"${selectedAttr(model.shadowMode ? 'true' : 'false', 'false')}>Live mode</option>
            </select>
          </div>
          <div class="form-row">
            <label for="debug-level">Debug level</label>
            <select id="debug-level" name="debug_level">
              <option value="0"${selectedAttr(model.debugLevel, '0')}>0 - errors only</option>
              <option value="1"${selectedAttr(model.debugLevel, '1')}>1 - info</option>
              <option value="2"${selectedAttr(model.debugLevel, '2')}>2 - debug</option>
            </select>
          </div>
          <div class="form-row">
            <label for="web-host">Web host</label>
            <input id="web-host" name="web_host" type="text" value="${escapeHtml(model.webHost)}" placeholder="127.0.0.1">
          </div>
          <div class="form-row">
            <label for="web-port">Web port</label>
            <input id="web-port" name="web_port" type="text" inputmode="numeric" value="${escapeHtml(model.webPort)}" placeholder="3000">
          </div>
          <div class="form-row">
            <label for="web-ui-password">Optional web UI password</label>
            <input id="web-ui-password" name="web_ui_password" type="password" autocomplete="new-password" placeholder="${model.webUiPasswordConfigured ? 'Saved. Leave blank to keep.' : 'Optional'}">
            <p class="small">${authHint}</p>
          </div>
        </div>
        ${showDisablePassword ? `<label class="checkbox-row">
          <input name="disable_web_ui_password" type="checkbox">
          <span>Disable the web UI password and return to localhost-only access</span>
        </label>` : ''}
      </fieldset>

      <div class="actions">
        ${button(submitLabel)}
      </div>
    </form>
  `;
}

function renderAdvancedSettingsEditor(rawEnv, query) {
  const advancedOpen = query.get('advanced') === '1' ? ' open' : '';
  return `<details${advancedOpen}>
    <summary>Advanced Raw Editor</summary>
    <p class="helper">This is the original plain-text env editor for people who prefer files and direct control.</p>
    <form method="POST" action="/settings/save">
      <div class="form-row">
        <label for="raw-env">Environment file</label>
        <textarea id="raw-env" name="env" rows="18">${escapeHtml(rawEnv)}</textarea>
      </div>
      <div class="actions">
        ${button('Save Raw Env', 'secondary')}
      </div>
    </form>
  </details>`;
}

function loadZoneEditorData() {
  const fallback = {
    zoneProfiles: CONFIG.watering.zoneProfiles,
    soilProfiles: CONFIG.watering.soilProfiles,
  };

  let rawYaml = '';
  if (existsSync(ZONES_PATH)) {
    rawYaml = readFileSync(ZONES_PATH, 'utf-8');
  }

  let parseError = '';
  let model;
  try {
    model = parseZoneConfig(rawYaml, fallback);
  } catch (err) {
    parseError = err.message;
    model = parseZoneConfig('', fallback);
  }

  return {
    rawYaml: rawYaml || buildZoneConfigYaml(model),
    parseError,
    ...model,
  };
}

function zoneNameMap() {
  const names = {};
  const status = getStatus(localDateStr());
  for (const zone of status.moisture) {
    names[zone.zone_number] = zone.zone_name;
  }
  return names;
}

function renderGuidedZonesForm(zoneData) {
  const names = zoneNameMap();

  const zoneCards = zoneData.zones.map(zone => {
    const label = names[zone.zoneNumber] || `Zone ${zone.zoneNumber}`;
    return `<fieldset>
      <legend>Zone ${zone.zoneNumber}</legend>
      <p class="helper">${escapeHtml(label)}</p>
      <input type="hidden" name="zone_number" value="${zone.zoneNumber}">
      <div class="form-grid">
        <div class="form-row">
          <label for="type-${zone.zoneNumber}">Irrigation type</label>
          <select id="type-${zone.zoneNumber}" name="type">
            <option value="lawn"${selectedAttr(zone.type, 'lawn')}>Lawn spray</option>
            <option value="drip"${selectedAttr(zone.type, 'drip')}>Drip</option>
          </select>
        </div>
        <div class="form-row">
          <label for="sun-${zone.zoneNumber}">Sun exposure</label>
          <input id="sun-${zone.zoneNumber}" name="sun_exposure" type="text" inputmode="decimal" value="${escapeHtml(zone.sunExposure)}">
        </div>
        <div class="form-row">
          <label for="area-${zone.zoneNumber}">Area (sq ft)</label>
          <input id="area-${zone.zoneNumber}" name="area_sqft" type="text" inputmode="decimal" value="${escapeHtml(zone.areaSqFt)}">
        </div>
        <div class="form-row">
          <label for="priority-${zone.zoneNumber}">Priority</label>
          <input id="priority-${zone.zoneNumber}" name="priority" type="text" inputmode="numeric" value="${escapeHtml(zone.priority)}">
        </div>
        <div class="form-row">
          <label for="soil-${zone.zoneNumber}">Soil profile</label>
          <select id="soil-${zone.zoneNumber}" name="soil">
            ${zoneData.soilProfiles.map(soil => `<option value="${escapeHtml(soil.name)}"${selectedAttr(zone.soil, soil.name)}>${escapeHtml(soil.name)}</option>`).join('')}
          </select>
        </div>
      </div>
    </fieldset>`;
  }).join('');

  const soilCards = zoneData.soilProfiles.map((soil, index) => `<fieldset>
    <legend>Soil Profile: ${escapeHtml(soil.name)}</legend>
    <input type="hidden" name="soil_name" value="${escapeHtml(soil.name)}">
    <div class="form-grid">
      <div class="form-row">
        <label for="om-${index}">Organic matter (%)</label>
        <input id="om-${index}" name="organic_matter_pct" type="text" inputmode="decimal" value="${escapeHtml(soil.organicMatterPct)}">
      </div>
      <div class="form-row">
        <label for="ph-${index}">Soil pH</label>
        <input id="ph-${index}" name="soil_ph" type="text" inputmode="decimal" value="${escapeHtml(soil.soilPh)}">
      </div>
    </div>
  </fieldset>`).join('');

  return `
    <form method="POST" action="/zones/guided-save">
      <div class="grid grid-2">
        <div class="card">
          <h2>Zone Setup</h2>
          <p class="helper">These are the common fields most people actually need to change. Use the raw editor below if you want to add or remove zones or edit YAML directly.</p>
          ${zoneCards}
        </div>
        <div class="card">
          <h2>Soil Profiles</h2>
          <p class="helper">Zones reference these soil profiles by name.</p>
          ${soilCards}
        </div>
      </div>
      <div class="actions">
        ${button('Save Guided Zones')}
      </div>
    </form>
  `;
}

function renderAdvancedZonesEditor(zoneData, query) {
  const advancedOpen = query.get('advanced') === '1' ? ' open' : '';
  return `<details${advancedOpen}>
    <summary>Advanced YAML Editor</summary>
    <p class="helper">This is the original raw YAML editor for people who want full control.</p>
    <form method="POST" action="/zones/save">
      <div class="form-row">
        <label for="raw-zones">zones.yaml</label>
        <textarea id="raw-zones" name="zones" rows="22">${escapeHtml(zoneData.rawYaml)}</textarea>
      </div>
      <div class="actions">
        ${button('Save Raw YAML', 'secondary')}
      </div>
    </form>
  </details>`;
}

function dashboardPage(query) {
  const todayStr = localDateStr();
  const status = getStatus(todayStr);
  const finance = getFinanceData();
  const envModel = buildGuidedSettingsModel(readEnvFile());
  const isShadow = readShadowMode();

  const ambientCache = getCachedWeather('ambient');
  let weatherHtml = badge('Unknown', 'warning');
  if (ambientCache) {
    try {
      const data = JSON.parse(ambientCache.data_json);
      const ageMin = minutesSinceTimestamp(ambientCache.fetched_at);
      if (Number.isFinite(ageMin) && ageMin < CONFIG.degradedMode.ambientStaleThresholdMinutes) {
        weatherHtml = `${badge('Live', 'success')} ${escapeHtml(`${data.temp}F, ${data.humidity}% RH, wind ${data.windSpeed} mph`)}`;
      } else if (Number.isFinite(ageMin)) {
        weatherHtml = `${badge(`Stale (${Math.round(ageMin)}m)`, 'error')}`;
      } else {
        weatherHtml = `${badge('Stale (timestamp unreadable)', 'error')}`;
      }
    } catch {
      weatherHtml = badge('Weather cache error', 'error');
    }
  }

  const forecastCache = getCachedWeather('openmeteo_forecast');
  let forecastHtml = '';
  if (forecastCache) {
    try {
      const forecast = JSON.parse(forecastCache.data_json);
      forecastHtml = `<div class="grid grid-2">
        ${forecast.slice(0, 4).map(day => `<div class="card">
          <h3>${escapeHtml(day.date?.slice(5) || '?')}</h3>
          <div class="stat-list">
            <div class="stat"><span>High</span><span>${escapeHtml(day.tmax?.toFixed(0) || '?')}F</span></div>
            <div class="stat"><span>Low</span><span>${escapeHtml(day.tmin?.toFixed(0) || '?')}F</span></div>
            <div class="stat"><span>Rain</span><span>${escapeHtml(day.precipitation?.toFixed(2) || '0.00')}"</span></div>
          </div>
        </div>`).join('')}
      </div>`;
    } catch {
      forecastHtml = '';
    }
  }

  const moistureHtml = status.moisture.length > 0
    ? status.moisture.map(zone => {
        const pct = zone.total_capacity > 0 ? Math.round((zone.balance_inches / zone.total_capacity) * 100) : 0;
        return `<div class="card">
          <h3>Zone ${zone.zone_number} (${escapeHtml(zone.zone_name)})</h3>
          ${moistureBar(pct)}
        </div>`;
      }).join('')
    : '<p class="helper">No moisture data yet. Run a cycle first.</p>';

  let lastDecision = 'No runs yet';
  let lastExplanation = '';
  if (status.lastRun) {
    lastDecision = `${escapeHtml(status.lastRun.decision)} - ${escapeHtml(status.lastRun.reason)}`;
    lastExplanation = explainDecision(status.lastRun);
  }

  const zoneData = loadZoneEditorData();
  const smokeZoneOptions = zoneData.zones.map(zone => {
    const name = zoneNameMap()[zone.zoneNumber] || `Zone ${zone.zoneNumber}`;
    return `<option value="${zone.zoneNumber}">Zone ${zone.zoneNumber} - ${escapeHtml(name)}</option>`;
  }).join('');

  const actionsHtml = envModel.rachioConfigured ? `<div class="actions">
      <form method="POST" action="/action/water" onsubmit="return confirm('${escapeHtml(isShadow ? 'Start a manual watering run now? Shadow mode is enabled, so nothing will actuate.' : 'Start a live manual watering run now? This will send a real command to Rachio.')}')">
        ${button(isShadow ? 'Run Manual Watering (Shadow)' : 'Water Now (Live)')}
      </form>
      <form method="POST" action="/action/shadow-toggle" onsubmit="return confirm('${escapeHtml(isShadow ? 'Switch to live mode? Future WATER decisions will actuate your Rachio controller.' : 'Switch back to shadow mode? Future decisions will log only and will not actuate Rachio.')}')">
        ${button(isShadow ? 'Go Live' : 'Enable Shadow', isShadow ? 'success' : 'warning')}
      </form>
    </div>`
    : `<p class="helper">Finish setup before sending commands to Rachio.</p>`;

  const smokeTestHtml = envModel.rachioConfigured && !isShadow ? `<div class="card">
      <h2>Commissioning Smoke Test</h2>
      <p class="helper">This runs one short live zone test using the same command path as the controller. It is optional and intended for the day you leave shadow mode.</p>
      <form method="POST" action="/action/smoke-test" onsubmit="return confirm('Start a live smoke test now? This will send a real command to Rachio.')">
        <div class="form-grid">
          <div class="form-row">
            <label for="smoke-zone">Zone</label>
            <select id="smoke-zone" name="zone">${smokeZoneOptions}</select>
          </div>
          <div class="form-row">
            <label for="smoke-minutes">Duration</label>
            <select id="smoke-minutes" name="minutes">
              <option value="1">1 minute</option>
              <option value="2">2 minutes</option>
              <option value="3">3 minutes</option>
            </select>
          </div>
        </div>
        <div class="actions">
          ${button('Run Smoke Test', 'warning')}
        </div>
      </form>
    </div>`
    : `<div class="card">
      <h2>Commissioning Smoke Test</h2>
      <p class="helper">Smoke testing becomes available after you leave shadow mode. It is intentionally optional so coders can keep using the CLI workflow instead.</p>
    </div>`;

  return layout('Dashboard', `
    ${noticeBanner(query)}
    ${configuredSetupCard()}
    ${!envModel.rachioConfigured ? `<div class="card notice notice-warning" role="status">
      <h2>Finish Setup</h2>
      <p class="helper">The browser UI can walk you through setup, or you can keep using <span class="inline-code">smart-water setup</span> from the terminal.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/setup">Open Guided Setup</a>
      </div>
    </div>` : ''}
    <div class="grid grid-2">
      <div class="card">
        <h2>System Status</h2>
        <div class="stat-list">
          <div class="stat"><span>Mode</span><span>${isShadow ? badge('Shadow', 'warning') : badge('Live', 'success')}</span></div>
          <div class="stat"><span>Weather</span><span>${weatherHtml}</span></div>
          <div class="stat"><span>Last decision</span><span>${lastDecision}</span></div>
        </div>
        ${lastExplanation ? `<p style="font-size:13px;color:var(--muted);margin-top:8px;line-height:1.5;border-top:1px solid var(--border);padding-top:8px;">${escapeHtml(lastExplanation)}</p>` : ''}
      </div>
      <div class="card">
        <h2>Setup Snapshot</h2>
        <div class="stat-list">
          <div class="stat"><span>Rachio key</span><span>${envModel.rachioConfigured ? badge('Saved', 'success') : badge('Missing', 'warning')}</span></div>
          <div class="stat"><span>Ambient Weather</span><span>${envModel.ambientApiConfigured && envModel.ambientAppConfigured && envModel.ambientMacConfigured ? badge('Configured', 'success') : badge('Optional', 'neutral')}</span></div>
          <div class="stat"><span>MQTT</span><span>${envModel.mqttBrokerUrl ? badge('Configured', 'success') : badge('Optional', 'neutral')}</span></div>
          <div class="stat"><span>Web login</span><span>${authEnabled() ? badge('Enabled', 'success') : badge('Disabled', 'neutral')}</span></div>
        </div>
      </div>
    </div>

    ${forecastHtml ? `<div class="card"><h2>Forecast</h2>${forecastHtml}</div>` : ''}

    <div class="card">
      <h2>Quick Actions</h2>
      <p class="helper">${isShadow ? 'Shadow mode records decisions without actuating Rachio.' : 'Live mode sends real watering commands to Rachio.'}</p>
      ${actionsHtml}
    </div>

    ${smokeTestHtml}

    <div class="card">
      <h2>Soil Moisture</h2>
      <div class="grid grid-2">${moistureHtml}</div>
    </div>

    <div class="card">
      <h2>Water Usage</h2>
      <div class="stat-list">
        <div class="stat"><span>Today</span><span>${status.todayUsage.gallons.toFixed(0)} gal / $${status.todayUsage.cost.toFixed(2)}</span></div>
        <div class="stat"><span>This month</span><span>${finance?.monthly_gallons?.toFixed(0) || 0} gal / $${finance?.monthly_cost?.toFixed(2) || '0.00'}</span></div>
        <div class="stat"><span>Billing cycle</span><span>${finance?.cumulative_gallons?.toFixed(0) || 0} gal</span></div>
      </div>
    </div>
  `, 'dashboard');
}

function logsPage(query) {
  const hours = parseInt(query.get('hours') || '24', 10);
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const runs = getRunsSince(since);

  const filterLinks = [24, 48, 168].map(value =>
    `<a class="btn ${hours === value ? 'btn-primary' : 'btn-secondary'}" href="/logs?hours=${value}">${value === 168 ? '7 days' : `${value}h`}</a>`
  ).join('');

  const rows = runs.length > 0
    ? runs.map(run => `<tr>
        <td>${escapeHtml(run.timestamp?.slice(0, 16).replace('T', ' ') || '?')}</td>
        <td>${escapeHtml(run.phase)}</td>
        <td>${run.decision === 'WATER' ? badge('Water', 'success') : badge('Skip', 'warning')}${run.success ? '' : ` ${badge('Failed', 'error')}`}${run.shadow ? ` ${badge('Shadow', 'neutral')}` : ''}</td>
        <td title="${escapeHtml(explainDecision(run))}">${escapeHtml(run.phase === 'DECIDE' ? shortExplanation(run) : (run.reason || ''))}</td>
      </tr>`).join('')
    : '<tr><td colspan="4">No runs in this time period.</td></tr>';

  return layout('Run History', `
    ${noticeBanner(query)}
    <div class="card">
      <h2>Run History</h2>
      <p class="helper">This is the persistent operational log. It is the best place to review shadow decisions over time.</p>
      <div class="actions">${filterLinks}</div>
      <div class="table-wrapper">
        <table>
          <caption>Recent run activity</caption>
          <thead>
            <tr><th>Time</th><th>Phase</th><th>Decision</th><th>Reason</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `, 'logs');
}

function zonesPage(query) {
  const zoneData = loadZoneEditorData();
  return layout('Zones', `
    ${noticeBanner(query)}
    ${configuredSetupCard()}
    ${zoneData.parseError ? `<div class="card notice notice-warning" role="alert">
      The existing zones.yaml could not be parsed. The guided editor is showing fallback values until you fix or replace the YAML below.
    </div>` : ''}
    ${renderGuidedZonesForm(zoneData)}
    <div class="card">
      <h2>Advanced Editing</h2>
      <p class="helper">Add or remove zones, customize comments, or edit YAML directly if you prefer.</p>
      ${renderAdvancedZonesEditor(zoneData, query)}
    </div>
  `, 'zones');
}

function settingsPage(query) {
  const envContent = readEnvFile();
  const model = buildGuidedSettingsModel(envContent);

  return layout('Settings', `
    ${noticeBanner(query)}
    ${configuredSetupCard()}
    <div class="card">
      <h2>Guided Settings</h2>
      <p class="helper">This covers the common settings most people need. Leave secret fields blank to keep the existing saved value.</p>
      ${renderGuidedSettingsForm(model)}
    </div>
    <div class="card">
      <h2>Advanced Editing</h2>
      <p class="helper">Use the raw env editor if you prefer direct control or want to edit less common settings such as SMTP or status page path.</p>
      ${renderAdvancedSettingsEditor(envContent, query)}
    </div>
  `, 'settings');
}

function setupPage(query) {
  const envContent = readEnvFile();
  const model = buildGuidedSettingsModel(envContent);

  return layout('Guided Setup', `
    ${noticeBanner(query)}
    <div class="card">
      <h2>Guided Setup</h2>
      <p class="helper">This page is optional. If you prefer the developer workflow, you can still use <span class="inline-code">smart-water setup</span>, edit <span class="inline-code">~/.smart-water/.env</span>, and manage <span class="inline-code">zones.yaml</span> directly.</p>
      ${renderGuidedSettingsForm(model, {
        action: '/setup/save',
        submitLabel: 'Save Guided Setup',
        showDisablePassword: model.webUiPasswordConfigured,
      })}
    </div>
    <div class="card">
      <h2>Next Steps</h2>
      <div class="stat-list">
        <div class="stat"><span>1.</span><span>Review zones in the Zones tab or keep using raw YAML.</span></div>
        <div class="stat"><span>2.</span><span>Run <span class="inline-code">smart-water doctor</span> to verify connectivity.</span></div>
        <div class="stat"><span>3.</span><span>Stay in shadow mode until you trust the decisions.</span></div>
      </div>
    </div>
  `, 'setup');
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(new URLSearchParams(body)));
  });
}

function redirect(res, url, extraHeaders = {}) {
  res.writeHead(302, {
    Location: url,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end();
}

function serve(res, html, statusCode = 200, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(html);
}

function serveJSON(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(res, urlPath) {
  const MIME = { '.json': 'application/json', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  const ext = urlPath.slice(urlPath.lastIndexOf('.'));
  const filePath = join(import.meta.dirname, 'public', urlPath.replace(/^\//, ''));
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function chartsPage() {
  return layout('Charts', chartsPageContent(), 'charts');
}

function requireAuth(req, res, url) {
  if (!authEnabled()) return true;
  if (url.pathname === '/login') return true;
  if (hasValidSession(req)) return true;

  if (url.pathname === '/api/status') {
    serveJSON(res, { error: 'authentication required' }, 401);
  } else {
    redirect(res, `/login?msg=login-required&next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  return false;
}

function readGuidedSettingsFromBody(body) {
  const lat = body.get('lat') || '39.73220';
  const lon = body.get('lon') || '-105.21940';
  const timezone = String(body.get('location_timezone') || 'America/Denver').trim();
  const debugLevel = String(body.get('debug_level') || '1').trim();
  const shadowMode = body.get('shadow_mode') !== 'false';
  const webPort = String(body.get('web_port') || '').trim();
  const webHost = String(body.get('web_host') || '').trim();
  const webhookUrl = String(body.get('webhook_url') || '').trim();
  const notificationEmail = String(body.get('notification_email') || '').trim();

  const latNumber = parseFloat(lat);
  const lonNumber = parseFloat(lon);
  if (!Number.isFinite(latNumber) || latNumber < -90 || latNumber > 90) {
    throw new Error('Latitude must be between -90 and 90');
  }
  if (!Number.isFinite(lonNumber) || lonNumber < -180 || lonNumber > 180) {
    throw new Error('Longitude must be between -180 and 180');
  }
  if (!timezone) {
    throw new Error('Timezone is required');
  }
  if (!['0', '1', '2'].includes(debugLevel)) {
    throw new Error('Debug level must be 0, 1, or 2');
  }
  if (webPort) {
    const portNumber = parseInt(webPort, 10);
    if (!Number.isFinite(portNumber) || portNumber < 1 || portNumber > 65535) {
      throw new Error('Web port must be between 1 and 65535');
    }
  }
  if (webHost && /\s/.test(webHost)) {
    throw new Error('Web host cannot contain spaces');
  }
  if (webhookUrl) {
    const url = new URL(webhookUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Webhook URL must start with http:// or https://');
    }
  }
  if (notificationEmail && !notificationEmail.includes('@')) {
    throw new Error('Notification email must look like an email address');
  }

  return {
    rachioApiKey: body.get('rachio_api_key') || '',
    ambientApiKey: body.get('ambient_api_key') || '',
    ambientAppKey: body.get('ambient_app_key') || '',
    ambientMacAddress: body.get('ambient_mac_address') || '',
    notificationEmail,
    webhookUrl,
    mqttBrokerUrl: body.get('mqtt_broker_url') || '',
    mqttTopicPrefix: body.get('mqtt_topic_prefix') || '',
    debugLevel,
    shadowMode,
    lat: String(latNumber),
    lon: String(lonNumber),
    locationTimezone: timezone,
    webHost,
    webPort,
    webUiPassword: body.get('web_ui_password') || '',
    disableWebUiPassword: body.get('disable_web_ui_password') === 'on',
  };
}

function readZonesFromBody(body) {
  const soilProfiles = normalizeSoilProfiles(body.getAll('soil_name').map((name, index) => ({
    name,
    organicMatterPct: body.getAll('organic_matter_pct')[index],
    soilPh: body.getAll('soil_ph')[index],
  })));

  const zones = normalizeZones(body.getAll('zone_number').map((zoneNumber, index) => ({
    zoneNumber,
    type: body.getAll('type')[index],
    sunExposure: body.getAll('sun_exposure')[index],
    areaSqFt: body.getAll('area_sqft')[index],
    priority: body.getAll('priority')[index],
    soil: body.getAll('soil')[index],
  })), soilProfiles.map(soil => soil.name));

  return { soilProfiles, zones };
}

function runCliInBackground(args, logLabel) {
  execFile(process.execPath, ['src/cli.js', ...args], { cwd: APP_ROOT }, (err, stdout, stderr) => {
    if (err) {
      log(0, `${logLabel} failed: ${err.message}`);
      if (stderr) log(0, stderr);
      return;
    }
    if (stdout?.trim()) log(1, `${logLabel}: ${stdout.trim()}`);
    if (stderr?.trim()) log(1, `${logLabel}: ${stderr.trim()}`);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;
  const method = req.method || 'GET';

  try {
    if (!requireAuth(req, res, url)) return;

    if (method === 'GET') {
      if (path === '/login') return serve(res, loginPage(url.searchParams), 200);
      if (path === '/' || path === '/dashboard') return serve(res, dashboardPage(url.searchParams));
      if (path === '/logs') return serve(res, logsPage(url.searchParams));
      if (path === '/zones') return serve(res, zonesPage(url.searchParams));
      if (path === '/settings') return serve(res, settingsPage(url.searchParams));
      if (path === '/setup') return serve(res, setupPage(url.searchParams));
      if (path === '/charts') return serve(res, chartsPage());
      if (path === '/api/status') return serveJSON(res, getStatusJSON(localDateStr()));
      if (path === '/api/charts') return serveJSON(res, getMoistureHistory(14));

      // PWA static files
      if (path === '/manifest.json' || path === '/sw.js' || path === '/icon-192.svg' || path === '/icon-512.svg') {
        return serveStatic(res, path);
      }
    }

    if (method === 'POST') {
      if (path === '/login') {
        if (!authEnabled()) return redirect(res, '/');
        const body = await parseBody(req);
        const password = String(body.get('password') || '');
        const next = safeNextPath(body.get('next'));
        if (!safeCompare(password, WEB_UI_PASSWORD)) {
          return redirect(res, `/login?msg=bad-auth&next=${encodeURIComponent(next)}`);
        }
        const token = createSession();
        return redirect(res, next, {
          'Set-Cookie': `${AUTH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        });
      }

      if (path === '/logout') {
        clearSession(req);
        return redirect(res, authEnabled() ? '/login?msg=logged-out' : '/', {
          'Set-Cookie': `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        });
      }

      if (path === '/action/water') {
        runCliInBackground(['water'], 'Manual watering via web UI');
        return redirect(res, '/?msg=manual-started');
      }

      if (path === '/action/shadow-toggle') {
        const nextMode = readShadowMode() ? 'false' : 'true';
        writeEnvValue('SHADOW_MODE', nextMode);
        log(1, `Shadow mode toggled via web UI: now ${nextMode === 'true' ? 'SHADOW' : 'LIVE'}`);
        return redirect(res, `/?msg=${readShadowMode() ? 'shadow-on' : 'live-on'}`);
      }

      if (path === '/action/smoke-test') {
        const body = await parseBody(req);
        const zone = parseInt(String(body.get('zone') || ''), 10);
        const minutes = parseInt(String(body.get('minutes') || ''), 10);
        if (!Number.isFinite(zone) || !Number.isFinite(minutes)) {
          return redirect(res, '/?msg=settings-error');
        }
        runCliInBackground(['smoke-test', '--zone', String(zone), '--minutes', String(minutes), '--yes'], 'Smoke test via web UI');
        return redirect(res, '/?msg=smoke-started');
      }

      if (path === '/setup/save' || path === '/settings/guided-save') {
        const body = await parseBody(req);
        try {
          const values = readGuidedSettingsFromBody(body);
          const nextContent = applyGuidedSettings(readEnvFile(), values);
          mkdirSync(dirname(ENV_PATH), { recursive: true });
          writeFileSync(ENV_PATH, nextContent, { mode: 0o600 });
          log(1, `Guided settings updated via web UI: ${path}`);
          return redirect(res, path === '/setup/save' ? '/setup?msg=setup-saved' : '/settings?msg=settings-saved');
        } catch (err) {
          log(0, `Guided settings save failed: ${err.message}`);
          return redirect(res, path === '/setup/save' ? '/setup?msg=setup-error' : '/settings?msg=settings-error');
        }
      }

      if (path === '/zones/guided-save') {
        const body = await parseBody(req);
        try {
          const yamlContent = buildZoneConfigYaml(readZonesFromBody(body));
          mkdirSync(dirname(ZONES_PATH), { recursive: true });
          writeFileSync(ZONES_PATH, yamlContent);
          log(1, 'Zones config updated via guided web UI');
          return redirect(res, '/zones?msg=zones-saved');
        } catch (err) {
          log(0, `Guided zones save failed: ${err.message}`);
          return redirect(res, '/zones?msg=zones-error');
        }
      }

      if (path === '/zones/save') {
        const body = await parseBody(req);
        const zonesContent = body.get('zones') || '';
        try {
          yaml.load(zonesContent);
          mkdirSync(dirname(ZONES_PATH), { recursive: true });
          writeFileSync(ZONES_PATH, zonesContent);
          log(1, 'Zones config updated via raw web UI');
          return redirect(res, '/zones?msg=zones-saved&advanced=1');
        } catch (err) {
          log(0, `Invalid YAML in zones save: ${err.message}`);
          return redirect(res, '/zones?msg=zones-error&advanced=1');
        }
      }

      if (path === '/settings/save') {
        const body = await parseBody(req);
        const envContent = body.get('env') || '';
        mkdirSync(dirname(ENV_PATH), { recursive: true });
        writeFileSync(ENV_PATH, envContent, { mode: 0o600 });
        log(1, 'Environment config updated via raw web UI');
        return redirect(res, '/settings?msg=settings-saved&advanced=1');
      }
    }

    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end('Not found');
  } catch (err) {
    log(0, `Web UI error: ${err.message}`);
    res.writeHead(500, { 'Cache-Control': 'no-store' });
    res.end('Internal server error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Web UI could not start because ${HOST}:${PORT} is already in use. Set WEB_PORT to another port or stop the existing server.`);
    process.exit(1);
  }

  log(0, `Web UI failed to start: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(1, `Web UI running at http://${HOST}:${PORT}`);
});
