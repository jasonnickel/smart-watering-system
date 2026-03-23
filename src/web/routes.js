// HTTP request handler and route dispatch for the web UI.

import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { execFile } from 'node:child_process';
import yaml from 'js-yaml';

import {
  readEnvFile, readEnvValueFromContent, readShadowMode, writeEnvValue,
} from '../env.js';
import {
  applyGuidedSettings,
  buildZoneConfigYaml,
  normalizeSoilProfiles,
  normalizeZones,
} from '../web-forms.js';
import { getMoistureHistory } from '../charts.js';
import { localDateStr } from '../time.js';
import { getStatusJSON, getRunsSince } from '../db/state.js';
import { log } from '../log.js';
import { aiNarrationEnabled } from '../ai/advisor.js';
import { askYard } from '../ai/chat.js';
import { generateNarrative } from '../ai/narratives.js';
import { buildBriefingContext, generateBriefingNarrative } from '../ai/briefing.js';
import {
  initAuth,
  authEnabled, hasValidSession, createSession, clearSession,
  verifyPassword, safeNextPath, verifyCsrf, getCsrfToken,
  checkLoginRate, recordLoginFailure, clearLoginFailures,
  AUTH_COOKIE_NAME, SESSION_TTL_MS,
} from './auth.js';
import {
  loginPage, dashboardPage, logsPage, zonesPage,
  settingsPage, setupPage, chartsPage, briefingPage,
} from './pages.js';

// -- Constants ---------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

// -- HTTP helpers ------------------------------------------------------------

const PUBLIC_PATHS = new Set([
  '/login',
  '/manifest.json',
  '/sw.js',
  '/icon-192.svg',
  '/icon-512.svg',
  '/styles.css',
  '/theme.js',
  '/ai.js',
]);

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

function redirect(res, url, extraHeaders = {}) {
  res.writeHead(302, {
    Location: url,
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end();
}

function serve(res, html, statusCode = 200, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(html);
}

function serveJSON(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(res, urlPath, publicDir) {
  const MIME = {
    '.json': 'application/json',
    '.js': 'text/javascript',
    '.svg': 'image/svg+xml',
    '.css': 'text/css',
  };
  const ext = urlPath.slice(urlPath.lastIndexOf('.'));
  const filePath = resolve(publicDir, urlPath.replace(/^\//, ''));

  // Path containment: reject traversal attempts
  const resolvedPublic = realpathSync(publicDir);
  if (!filePath.startsWith(resolvedPublic)) {
    res.writeHead(400, SECURITY_HEADERS);
    res.end('Bad request');
    return;
  }

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function syncWebUiAuth(envContent) {
  const password = readEnvValueFromContent(envContent, 'WEB_UI_PASSWORD') || '';
  if (password) {
    process.env.WEB_UI_PASSWORD = password;
  } else {
    delete process.env.WEB_UI_PASSWORD;
  }
  initAuth(password);
}

function requireAuth(req, res, url) {
  if (!authEnabled()) return true;
  if (PUBLIC_PATHS.has(url.pathname)) return true;
  if (hasValidSession(req)) return true;

  if (url.pathname.startsWith('/api/')) {
    serveJSON(res, { error: 'authentication required' }, 401);
  } else {
    redirect(res, `/login?msg=login-required&next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  return false;
}

function getClientIP(req) {
  return req.socket?.remoteAddress || 'unknown';
}

// -- Form body readers -------------------------------------------------------

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

  // Validate timezone against IANA list
  try {
    const valid = Intl.supportedValuesOf('timeZone');
    if (!valid.includes(timezone)) {
      throw new Error(`Unknown timezone: ${timezone}`);
    }
  } catch (err) {
    if (err.message.startsWith('Unknown timezone')) throw err;
    // Intl.supportedValuesOf not available on older Node - fall back to basic check
    if (!/^[A-Za-z_/+-]+$/.test(timezone)) {
      throw new Error('Timezone contains invalid characters');
    }
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

// -- CLI runner --------------------------------------------------------------

function runCliInBackground(args, logLabel, appRoot) {
  execFile(process.execPath, ['src/cli.js', ...args], { cwd: appRoot }, (err, stdout, stderr) => {
    if (err) {
      log(0, `${logLabel} failed: ${err.message}`);
      if (stderr) log(0, stderr);
      return;
    }
    if (stdout?.trim()) log(1, `${logLabel}: ${stdout.trim()}`);
    if (stderr?.trim()) log(1, `${logLabel}: ${stderr.trim()}`);
  });
}

// -- Main request handler ----------------------------------------------------

export function createRequestHandler({ host, port, appRoot, envPath, zonesPath, publicDir }) {
  return async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    try {
      if (!requireAuth(req, res, url)) return;

      if (method === 'GET') {
        const csrf = getCsrfToken(req);
        if (path === '/login') return serve(res, loginPage(url.searchParams));
        if (path === '/' || path === '/dashboard') return serve(res, dashboardPage(url.searchParams, zonesPath, csrf));
        if (path === '/logs') return serve(res, logsPage(url.searchParams, csrf));
        if (path === '/zones') return serve(res, zonesPage(url.searchParams, zonesPath, csrf));
        if (path === '/settings') return serve(res, settingsPage(url.searchParams, csrf));
        if (path === '/setup') return serve(res, setupPage(url.searchParams, csrf));
        if (path === '/charts') return serve(res, chartsPage(csrf));
        if (path === '/briefing') return serve(res, briefingPage(csrf));
        if (path === '/api/status') return serveJSON(res, getStatusJSON(localDateStr()));
        if (path === '/api/charts') return serveJSON(res, getMoistureHistory(14));
        if (path === '/api/ai/status') return serveJSON(res, { enabled: aiNarrationEnabled() });

        // Static assets (PWA, CSS, theme toggle)
        if (path === '/manifest.json' || path === '/sw.js' || path === '/icon-192.svg' || path === '/icon-512.svg' || path === '/styles.css' || path === '/theme.js' || path === '/ai.js') {
          return serveStatic(res, path, publicDir);
        }
      }

      if (method === 'POST') {
        let body;
        try {
          body = await parseBody(req);
        } catch {
          res.writeHead(413, SECURITY_HEADERS);
          res.end('Request body too large');
          return;
        }

        if (path === '/login') {
          if (!authEnabled()) return redirect(res, '/');
          const ip = getClientIP(req);
          if (!checkLoginRate(ip)) {
            log(0, `Login rate limit exceeded for ${ip}`);
            return redirect(res, '/login?msg=bad-auth');
          }
          const password = String(body.get('password') || '');
          const next = safeNextPath(body.get('next'));
          if (!verifyPassword(password)) {
            recordLoginFailure(ip);
            return redirect(res, `/login?msg=bad-auth&next=${encodeURIComponent(next)}`);
          }
          // Clear any prior session before issuing a new one (prevent session fixation)
          clearSession(req);
          clearLoginFailures(ip);
          const { token } = createSession();
          return redirect(res, next, {
            'Set-Cookie': `${AUTH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
          });
        }

        // All POST routes below /login require CSRF validation
        if (!verifyCsrf(req, body)) {
          log(0, `CSRF validation failed for ${path}`);
          res.writeHead(403, SECURITY_HEADERS);
          res.end('Forbidden - invalid CSRF token');
          return;
        }

        // AI API endpoints (JSON request/response, CSRF-protected)
        if (path === '/api/ai/chat') {
          if (!aiNarrationEnabled()) {
            return serveJSON(res, { error: 'AI not configured' }, 503);
          }
          const question = body.get('question') || '';
          if (!question.trim() || question.length > 500) {
            return serveJSON(res, { error: 'Question required (max 500 chars)' }, 400);
          }
          try {
            const result = await askYard(question.trim());
            return serveJSON(res, { answer: result?.content || 'No response', reasoning: result?.reasoning || null });
          } catch (err) {
            log(0, `AI chat error: ${err.message}`);
            return serveJSON(res, { error: 'AI request failed' }, 502);
          }
        }

        if (path === '/api/ai/narrative') {
          if (!aiNarrationEnabled()) {
            return serveJSON(res, { error: 'AI not configured' }, 503);
          }
          const runId = parseInt(body.get('run_id') || '', 10);
          if (!Number.isFinite(runId) || runId <= 0) {
            return serveJSON(res, { error: 'Valid run_id required' }, 400);
          }
          try {
            const weekAgo = new Date(Date.now() - 30 * 86400000).toISOString();
            const runs = getRunsSince(weekAgo);
            const run = runs.find(r => r.id === runId);
            if (!run) {
              return serveJSON(res, { error: 'Run not found' }, 404);
            }
            const result = await generateNarrative(run);
            return serveJSON(res, { narrative: result?.narrative || null, reasoning: result?.reasoning || null });
          } catch (err) {
            log(0, `AI narrative error: ${err.message}`);
            return serveJSON(res, { error: 'AI request failed' }, 502);
          }
        }

        if (path === '/api/ai/briefing') {
          if (!aiNarrationEnabled()) {
            return serveJSON(res, { error: 'AI not configured' }, 503);
          }
          try {
            const context = buildBriefingContext();
            const narrative = await generateBriefingNarrative(context);
            return serveJSON(res, {
              narrative: narrative?.content || null,
              reasoning: narrative?.reasoning || null,
              context,
            });
          } catch (err) {
            log(0, `AI briefing error: ${err.message}`);
            return serveJSON(res, { error: 'AI request failed' }, 502);
          }
        }

        if (path === '/logout') {
          clearSession(req);
          return redirect(res, authEnabled() ? '/login?msg=logged-out' : '/', {
            'Set-Cookie': `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          });
        }

        if (path === '/action/water') {
          runCliInBackground(['water'], 'Manual watering via web UI', appRoot);
          return redirect(res, '/?msg=manual-started');
        }

        if (path === '/action/shadow-toggle') {
          const nextMode = readShadowMode() ? 'false' : 'true';
          writeEnvValue('SHADOW_MODE', nextMode);
          log(1, `Shadow mode toggled via web UI: now ${nextMode === 'true' ? 'SHADOW' : 'LIVE'}`);
          return redirect(res, `/?msg=${readShadowMode() ? 'shadow-on' : 'live-on'}`);
        }

        if (path === '/action/smoke-test') {
          const zone = parseInt(String(body.get('zone') || ''), 10);
          const minutes = parseInt(String(body.get('minutes') || ''), 10);
          if (!Number.isFinite(zone) || zone < 1 || zone > 16) {
            return redirect(res, '/?msg=settings-error');
          }
          if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10) {
            return redirect(res, '/?msg=settings-error');
          }
          runCliInBackground(['smoke-test', '--zone', String(zone), '--minutes', String(minutes), '--yes'], 'Smoke test via web UI', appRoot);
          return redirect(res, '/?msg=smoke-started');
        }

        if (path === '/setup/save' || path === '/settings/guided-save') {
          try {
            const values = readGuidedSettingsFromBody(body);
            const nextContent = applyGuidedSettings(readEnvFile(), values);
            mkdirSync(dirname(envPath), { recursive: true });
            writeFileSync(envPath, nextContent, { mode: 0o600 });
            syncWebUiAuth(nextContent);
            log(1, `Guided settings updated via web UI: ${path}`);
            return redirect(res, path === '/setup/save' ? '/setup?msg=setup-saved' : '/settings?msg=settings-saved');
          } catch (err) {
            log(0, `Guided settings save failed: ${err.message}`);
            return redirect(res, path === '/setup/save' ? '/setup?msg=setup-error' : '/settings?msg=settings-error');
          }
        }

        if (path === '/zones/guided-save') {
          try {
            const yamlContent = buildZoneConfigYaml(readZonesFromBody(body));
            mkdirSync(dirname(zonesPath), { recursive: true });
            writeFileSync(zonesPath, yamlContent);
            log(1, 'Zones config updated via guided web UI');
            return redirect(res, '/zones?msg=zones-saved');
          } catch (err) {
            log(0, `Guided zones save failed: ${err.message}`);
            return redirect(res, '/zones?msg=zones-error');
          }
        }

        if (path === '/zones/save') {
          const zonesContent = body.get('zones') || '';
          try {
            yaml.load(zonesContent, { schema: yaml.JSON_SCHEMA });
            mkdirSync(dirname(zonesPath), { recursive: true });
            writeFileSync(zonesPath, zonesContent);
            log(1, 'Zones config updated via raw web UI');
            return redirect(res, '/zones?msg=zones-saved&advanced=1');
          } catch (err) {
            log(0, `Invalid YAML in zones save: ${err.message}`);
            return redirect(res, '/zones?msg=zones-error&advanced=1');
          }
        }

        if (path === '/settings/save') {
          const envContent = body.get('env') || '';
          mkdirSync(dirname(envPath), { recursive: true });
          writeFileSync(envPath, envContent, { mode: 0o600 });
          syncWebUiAuth(envContent);
          log(1, 'Environment config updated via raw web UI');
          return redirect(res, '/settings?msg=settings-saved&advanced=1');
        }
      }

      res.writeHead(404, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end('Not found');
    } catch (err) {
      log(0, `Web UI error: ${err.message}`);
      res.writeHead(500, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end('Internal server error');
    }
  };
}
