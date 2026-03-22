#!/usr/bin/env node

// Smart Water System - Local Web UI
// Lightweight HTTP server for browser-based management.
// No framework - plain Node.js http module with server-rendered HTML.
//
// Usage: node src/web.js
// Default port: 3000 (override with WEB_PORT env var)

import './env.js';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { URL } from 'node:url';
import yaml from 'js-yaml';

import CONFIG from './config.js';
import { log } from './log.js';
import { localDateStr, localMonth } from './time.js';
import {
  initDB, getStatus, getStatusJSON, getRunsSince, getFinanceData,
  getCachedWeather, getRecentDiscrepancies, getSystemState, setSystemState,
  getSoilMoisture,
} from './db/state.js';

const PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || join(homedir(), '.smart-water', 'smart-water.db');
const ENV_PATH = join(homedir(), '.smart-water', '.env');
const ZONES_PATH = existsSync(join(process.cwd(), 'zones.yaml'))
  ? join(process.cwd(), 'zones.yaml')
  : join(homedir(), '.smart-water', 'zones.yaml');

initDB(DB_PATH);

// --- HTML template helpers ---

function layout(title, content, activeTab) {
  const tabs = [
    { id: 'dashboard', label: 'Dashboard', path: '/' },
    { id: 'logs', label: 'Run History', path: '/logs' },
    { id: 'zones', label: 'Zones', path: '/zones' },
    { id: 'settings', label: 'Settings', path: '/settings' },
  ];

  const navHtml = tabs.map(t =>
    `<a href="${t.path}" style="padding:8px 16px;text-decoration:none;color:${activeTab === t.id ? '#1565c0' : '#666'};font-weight:${activeTab === t.id ? 'bold' : 'normal'};border-bottom:${activeTab === t.id ? '2px solid #1565c0' : '2px solid transparent'};">${t.label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} - Smart Water</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .header { background: #fff; padding: 12px 16px; border-bottom: 1px solid #e0e0e0; }
    .header h1 { font-size: 18px; color: #1565c0; }
    .nav { background: #fff; display: flex; border-bottom: 1px solid #e0e0e0; overflow-x: auto; }
    .container { max-width: 700px; margin: 16px auto; padding: 0 16px; }
    .card { background: #fff; border-radius: 8px; padding: 16px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { font-size: 14px; text-transform: uppercase; color: #666; margin-bottom: 10px; letter-spacing: 0.5px; }
    .btn { display: inline-block; padding: 10px 20px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; text-decoration: none; color: #fff; }
    .btn-blue { background: #1565c0; }
    .btn-green { background: #2e7d32; }
    .btn-orange { background: #e65100; }
    .btn-red { background: #c62828; }
    .btn:hover { opacity: 0.9; }
    .stat { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; border-bottom: 1px solid #f5f5f5; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; font-weight: bold; }
    .badge-green { background: #e8f5e9; color: #2e7d32; }
    .badge-yellow { background: #fff8e1; color: #e65100; }
    .badge-red { background: #ffebee; color: #c62828; }
    input, select, textarea { font-size: 14px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; width: 100%; margin: 4px 0 12px 0; }
    label { font-size: 13px; font-weight: bold; color: #555; }
    .form-row { margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px; text-align: left; border-bottom: 1px solid #eee; }
    th { font-weight: bold; color: #666; font-size: 12px; text-transform: uppercase; }
  </style>
</head>
<body>
  <div class="header"><h1>Smart Water System</h1></div>
  <div class="nav">${navHtml}</div>
  <div class="container">${content}</div>
</body>
</html>`;
}

function moistureBar(pct) {
  const color = pct < 40 ? '#e53935' : pct < 60 ? '#f5a623' : '#4caf50';
  return `<div style="display:flex;align-items:center;gap:8px;">
    <div style="background:#e0e0e0;border-radius:4px;height:12px;flex:1;">
      <div style="background:${color};border-radius:4px;height:12px;width:${Math.min(pct, 100)}%;"></div>
    </div>
    <span style="font-size:13px;min-width:35px;text-align:right;">${pct}%</span>
  </div>`;
}

// --- Page renderers ---

function dashboardPage() {
  const todayStr = localDateStr();
  const status = getStatus(todayStr);
  const finance = getFinanceData();
  const isShadow = CONFIG.system.shadowMode || process.env.SHADOW_MODE === 'true';

  // Weather source
  const ambientCache = getCachedWeather('ambient');
  let weatherHtml = '<span class="badge badge-yellow">Unknown</span>';
  if (ambientCache) {
    try {
      const data = JSON.parse(ambientCache.data_json);
      const ageMin = (Date.now() - new Date(ambientCache.fetched_at).getTime()) / 60000;
      if (ageMin < CONFIG.degradedMode.ambientStaleThresholdMinutes) {
        weatherHtml = `<span class="badge badge-green">Live</span> ${data.temp}F, ${data.humidity}% RH, wind ${data.windSpeed} mph`;
      } else {
        weatherHtml = `<span class="badge badge-red">Stale (${Math.round(ageMin)}m)</span>`;
      }
    } catch { weatherHtml = '<span class="badge badge-yellow">Error reading cache</span>'; }
  }

  // Forecast
  let forecastHtml = '';
  const forecastCache = getCachedWeather('openmeteo_forecast');
  if (forecastCache) {
    try {
      const forecast = JSON.parse(forecastCache.data_json);
      forecastHtml = forecast.slice(0, 4).map(d =>
        `<div style="text-align:center;flex:1;min-width:80px;padding:8px;background:#f9f9f9;border-radius:6px;">
          <div style="font-size:11px;color:#999;">${d.date?.slice(5) || '?'}</div>
          <div style="font-size:16px;font-weight:bold;">${d.tmax?.toFixed(0) || '?'}F</div>
          ${d.precipitation > 0 ? `<div style="color:#1565c0;font-size:11px;">${d.precipitation.toFixed(2)}" rain</div>` : ''}
        </div>`
      ).join('');
      forecastHtml = `<div style="display:flex;gap:6px;flex-wrap:wrap;">${forecastHtml}</div>`;
    } catch { /* skip */ }
  }

  // Moisture
  const moistureHtml = status.moisture.map(z => {
    const pct = z.total_capacity > 0 ? Math.round((z.balance_inches / z.total_capacity) * 100) : 0;
    return `<div style="margin:8px 0;">
      <div style="font-size:13px;margin-bottom:2px;">Zone ${z.zone_number} (${z.zone_name})</div>
      ${moistureBar(pct)}
    </div>`;
  }).join('');

  // Mode badge
  const modeBadge = isShadow
    ? '<span class="badge badge-yellow">SHADOW MODE</span>'
    : '<span class="badge badge-green">LIVE</span>';

  // Last decision
  let lastDecision = 'No runs yet';
  if (status.lastRun) {
    const icon = status.lastRun.decision === 'WATER' ? '&#128167;' : '&#9940;';
    lastDecision = `${icon} ${status.lastRun.decision} - ${status.lastRun.reason} <span style="color:#999;font-size:12px;">(${status.lastRun.timestamp})</span>`;
  }

  return layout('Dashboard', `
    <div class="card">
      <h2>System Status</h2>
      <div class="stat"><span>Mode</span><span>${modeBadge}</span></div>
      <div class="stat"><span>Weather</span><span>${weatherHtml}</span></div>
      <div class="stat"><span>Last Decision</span><span style="font-size:13px;">${lastDecision}</span></div>
    </div>

    ${forecastHtml ? `<div class="card"><h2>Forecast</h2>${forecastHtml}</div>` : ''}

    <div class="card">
      <h2>Soil Moisture</h2>
      ${moistureHtml || '<p style="color:#999;">No moisture data yet. Run a cycle first.</p>'}
    </div>

    <div class="card">
      <h2>Water Usage</h2>
      <div class="stat"><span>Today</span><span>${status.todayUsage.gallons.toFixed(0)} gal / $${status.todayUsage.cost.toFixed(2)}</span></div>
      <div class="stat"><span>This Month</span><span>${finance?.monthly_gallons?.toFixed(0) || 0} gal / $${finance?.monthly_cost?.toFixed(2) || '0.00'}</span></div>
      <div class="stat"><span>Billing Cycle</span><span>${finance?.cumulative_gallons?.toFixed(0) || 0} gal</span></div>
    </div>

    <div class="card">
      <h2>Quick Actions</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <form method="POST" action="/action/water" style="display:inline;"><button class="btn btn-blue" type="submit">Water Now</button></form>
        <form method="POST" action="/action/shadow-toggle" style="display:inline;">
          <button class="btn ${isShadow ? 'btn-green' : 'btn-orange'}" type="submit">${isShadow ? 'Go Live' : 'Enable Shadow'}</button>
        </form>
      </div>
    </div>
  `, 'dashboard');
}

function logsPage(query) {
  const hours = parseInt(query.get('hours') || '24', 10);
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const runs = getRunsSince(since);

  const filterLinks = [24, 48, 168].map(h =>
    `<a href="/logs?hours=${h}" style="padding:4px 12px;border-radius:12px;text-decoration:none;font-size:13px;${hours === h ? 'background:#1565c0;color:#fff;' : 'background:#e0e0e0;color:#333;'}">${h === 168 ? '7 days' : `${h}h`}</a>`
  ).join(' ');

  const rowsHtml = runs.length > 0
    ? runs.map(r => {
        const badge = r.decision === 'WATER'
          ? '<span class="badge badge-green">WATER</span>'
          : '<span class="badge badge-yellow">SKIP</span>';
        const success = r.success ? '' : ' <span class="badge badge-red">FAILED</span>';
        const shadow = r.shadow ? ' <span class="badge badge-yellow">shadow</span>' : '';
        return `<tr>
          <td>${r.timestamp?.slice(0, 16).replace('T', ' ') || '?'}</td>
          <td>${r.phase}</td>
          <td>${badge}${success}${shadow}</td>
          <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.reason}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="4" style="text-align:center;color:#999;padding:20px;">No runs in this time period</td></tr>';

  return layout('Run History', `
    <div class="card">
      <h2>Run History</h2>
      <div style="margin-bottom:12px;">${filterLinks}</div>
      <table>
        <thead><tr><th>Time</th><th>Phase</th><th>Decision</th><th>Reason</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `, 'logs');
}

function zonesPage() {
  let zonesYaml = '';
  try {
    zonesYaml = readFileSync(ZONES_PATH, 'utf-8');
  } catch { zonesYaml = '# zones.yaml not found'; }

  return layout('Zones', `
    <div class="card">
      <h2>Zone Configuration</h2>
      <p style="font-size:13px;color:#666;margin-bottom:12px;">
        Edit your zone profiles below. Changes are saved to zones.yaml and take effect on the next run.
      </p>
      <form method="POST" action="/zones/save">
        <textarea name="zones" rows="30" style="font-family:monospace;font-size:13px;line-height:1.5;">${escapeHtml(zonesYaml)}</textarea>
        <button class="btn btn-blue" type="submit" style="margin-top:8px;">Save Zones</button>
      </form>
    </div>
  `, 'zones');
}

function settingsPage() {
  let envContent = '';
  try {
    envContent = readFileSync(ENV_PATH, 'utf-8');
  } catch { envContent = '# .env not found'; }

  const isShadow = CONFIG.system.shadowMode || process.env.SHADOW_MODE === 'true';

  return layout('Settings', `
    <div class="card">
      <h2>Operating Mode</h2>
      <div class="stat">
        <span>Current Mode</span>
        <span>${isShadow ? '<span class="badge badge-yellow">SHADOW</span> Decisions logged, Rachio not actuated' : '<span class="badge badge-green">LIVE</span> Rachio is being controlled'}</span>
      </div>
      <form method="POST" action="/action/shadow-toggle" style="margin-top:12px;">
        <button class="btn ${isShadow ? 'btn-green' : 'btn-orange'}" type="submit">${isShadow ? 'Switch to Live Mode' : 'Switch to Shadow Mode'}</button>
      </form>
    </div>

    <div class="card">
      <h2>Environment Configuration</h2>
      <p style="font-size:13px;color:#666;margin-bottom:12px;">
        API keys and system settings. Changes take effect on the next run.
        Do not share this page - it contains your API keys.
      </p>
      <form method="POST" action="/settings/save">
        <textarea name="env" rows="25" style="font-family:monospace;font-size:13px;line-height:1.5;">${escapeHtml(envContent)}</textarea>
        <button class="btn btn-blue" type="submit" style="margin-top:8px;">Save Settings</button>
      </form>
    </div>
  `, 'settings');
}

// --- Request handling ---

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      resolve(params);
    });
  });
}

function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

function serve(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // GET routes
    if (method === 'GET') {
      if (path === '/' || path === '/dashboard') return serve(res, dashboardPage());
      if (path === '/logs') return serve(res, logsPage(url.searchParams));
      if (path === '/zones') return serve(res, zonesPage());
      if (path === '/settings') return serve(res, settingsPage());
      if (path === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getStatusJSON(localDateStr())));
      }
    }

    // POST routes
    if (method === 'POST') {
      if (path === '/action/water') {
        const { exec } = await import('node:child_process');
        exec('node src/cli.js water', { cwd: process.cwd() }, (err, stdout, stderr) => {
          log(1, `Manual water triggered via web UI: ${stdout || stderr}`);
        });
        return redirect(res, '/?msg=watering');
      }

      if (path === '/action/shadow-toggle') {
        try {
          let envContent = readFileSync(ENV_PATH, 'utf-8');
          const isShadow = /^SHADOW_MODE=true$/m.test(envContent);
          if (isShadow) {
            envContent = envContent.replace(/^SHADOW_MODE=true$/m, 'SHADOW_MODE=false');
          } else {
            envContent = envContent.replace(/^SHADOW_MODE=false$/m, 'SHADOW_MODE=true');
          }
          writeFileSync(ENV_PATH, envContent);
          log(1, `Shadow mode toggled via web UI: now ${isShadow ? 'LIVE' : 'SHADOW'}`);
        } catch (err) {
          log(0, `Failed to toggle shadow mode: ${err.message}`);
        }
        return redirect(res, '/');
      }

      if (path === '/zones/save') {
        const body = await parseBody(req);
        const zonesContent = body.get('zones');
        // Validate YAML before saving
        try {
          yaml.load(zonesContent);
          writeFileSync(ZONES_PATH, zonesContent);
          log(1, 'Zones config updated via web UI');
        } catch (err) {
          log(0, `Invalid YAML in zones save: ${err.message}`);
        }
        return redirect(res, '/zones');
      }

      if (path === '/settings/save') {
        const body = await parseBody(req);
        const envContent = body.get('env');
        writeFileSync(ENV_PATH, envContent, { mode: 0o600 });
        log(1, 'Environment config updated via web UI');
        return redirect(res, '/settings');
      }
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    log(0, `Web UI error: ${err.message}`);
    res.writeHead(500);
    res.end('Internal server error');
  }
});

server.listen(PORT, () => {
  log(1, `Web UI running at http://localhost:${PORT}`);
});
