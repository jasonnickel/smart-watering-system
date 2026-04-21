// HTTP request handler and route dispatch for the web UI.
// Thin dispatcher - handlers live in api-handlers.js and action-handlers.js.

import { resolve } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { URL } from 'node:url';

import { readEnvValueFromContent } from '../env.js';
import { log } from '../log.js';
import { SECURITY_HEADERS, serveJSON, redirect } from './http.js';
import {
  initAuth,
  authEnabled, hasValidSession,
  verifyCsrf, getCsrfToken,
} from './auth.js';
import {
  loginPage, dashboardPage, logsPage, zonesPage,
  settingsPage, setupPage, chartsPage, briefingPage, satellitePage,
} from './pages.js';

import {
  handleStatus, handleCharts, handleAIStatus,
  handleLocationSearch,
  handleReferenceETHistory, handleNDVIHistory,
  handleETValidationHistory, handleWeatherHistory,
  handleSoil, handleReferenceET, handleNDVI,
  handleSatelliteAnalysis, handleNDVIImage,
  handleAIChat, handleAINarrative, handleAIBriefing,
  handleBackfillReferenceET, handleBackfillWeather,
} from './api-handlers.js';

import {
  handleLogin, handleLogout, handleWater, handleShadowToggle,
  handleSmokeTest, handleSettingsGuidedSave, handleSettingsNextSteps, handleSettingsRawSave,
  handleZonesGuidedSave, handleZonesRawSave,
} from './action-handlers.js';

// -- Constants ---------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;

const MIME = {
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
};

const PUBLIC_PATHS = new Set([
  '/login',
  '/manifest.json',
  '/sw.js',
  '/icon-192.svg',
  '/icon-512.svg',
  '/styles.css',
  '/theme.js',
  '/ai.js',
  '/satellite.js',
  '/chart.umd.min.js',
]);

// -- HTTP helpers ------------------------------------------------------------

function parseBody(req) {
  return new Promise((done, reject) => {
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
    req.on('end', () => done(new URLSearchParams(body)));
    req.on('error', reject);
  });
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

function serveStatic(res, urlPath, publicDir, resolvedPublic) {
  const ext = urlPath.slice(urlPath.lastIndexOf('.'));
  const filePath = resolve(publicDir, urlPath.replace(/^\//, ''));

  // Path containment: reject traversal attempts
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

// -- Route tables ------------------------------------------------------------

function buildGetRoutes(context) {
  return {
    '/login': (ctx) => serve(ctx.res, loginPage(ctx.url.searchParams)),
    '/': (ctx) => serve(ctx.res, dashboardPage(ctx.url.searchParams, context.zonesPath, ctx.csrf)),
    '/dashboard': (ctx) => serve(ctx.res, dashboardPage(ctx.url.searchParams, context.zonesPath, ctx.csrf)),
    '/logs': (ctx) => serve(ctx.res, logsPage(ctx.url.searchParams, ctx.csrf)),
    '/zones': (ctx) => serve(ctx.res, zonesPage(ctx.url.searchParams, context.zonesPath, ctx.csrf)),
    '/settings': (ctx) => serve(ctx.res, settingsPage(ctx.url.searchParams, ctx.csrf)),
    '/setup': (ctx) => serve(ctx.res, setupPage(ctx.url.searchParams, ctx.csrf)),
    '/charts': (ctx) => serve(ctx.res, chartsPage(ctx.csrf)),
    '/briefing': (ctx) => serve(ctx.res, briefingPage(ctx.csrf)),
    '/satellite': (ctx) => serve(ctx.res, satellitePage(ctx.csrf)),

    // API - status and charts
    '/api/status': (ctx) => handleStatus(ctx.req, ctx.res),
    '/api/charts': (ctx) => handleCharts(ctx.req, ctx.res, ctx.url),
    '/api/ai/status': (ctx) => handleAIStatus(ctx.req, ctx.res),
    '/api/location-search': (ctx) => handleLocationSearch(ctx.req, ctx.res, ctx.url),

    // API - history
    '/api/history/reference-et': (ctx) => handleReferenceETHistory(ctx.req, ctx.res, ctx.url),
    '/api/history/ndvi': (ctx) => handleNDVIHistory(ctx.req, ctx.res, ctx.url),
    '/api/history/et-validation': (ctx) => handleETValidationHistory(ctx.req, ctx.res, ctx.url),
    '/api/history/weather': (ctx) => handleWeatherHistory(ctx.req, ctx.res, ctx.url),

    // API - data sources
    '/api/soil': (ctx) => handleSoil(ctx.req, ctx.res, ctx.url),
    '/api/reference-et': (ctx) => handleReferenceET(ctx.req, ctx.res),
    '/api/ndvi': (ctx) => handleNDVI(ctx.req, ctx.res, ctx.url),
    '/api/satellite/analysis': (ctx) => handleSatelliteAnalysis(ctx.req, ctx.res, ctx.url),
    '/api/ndvi/image': (ctx) => handleNDVIImage(ctx.req, ctx.res, ctx.url),
  };
}

function buildPostRoutes(context) {
  const ctx = { ...context, syncWebUiAuth };
  return {
    '/login': (rctx) => handleLogin(rctx.req, rctx.res, rctx.body),
    '/api/ai/chat': (rctx) => handleAIChat(rctx.req, rctx.res, rctx.body),
    '/api/ai/narrative': (rctx) => handleAINarrative(rctx.req, rctx.res, rctx.body),
    '/api/ai/briefing': (rctx) => handleAIBriefing(rctx.req, rctx.res),
    '/api/backfill/reference-et': (rctx) => handleBackfillReferenceET(rctx.req, rctx.res, rctx.body),
    '/api/backfill/weather': (rctx) => handleBackfillWeather(rctx.req, rctx.res, rctx.body),
    '/logout': (rctx) => handleLogout(rctx.req, rctx.res),
    '/action/water': (rctx) => handleWater(rctx.req, rctx.res, rctx.body, ctx),
    '/action/shadow-toggle': (rctx) => handleShadowToggle(rctx.req, rctx.res),
    '/action/smoke-test': (rctx) => handleSmokeTest(rctx.req, rctx.res, rctx.body, ctx),
    '/setup/save': (rctx) => handleSettingsGuidedSave(rctx.req, rctx.res, rctx.body, ctx),
    '/settings/guided-save': (rctx) => handleSettingsGuidedSave(rctx.req, rctx.res, rctx.body, ctx),
    '/settings/next-steps': (rctx) => handleSettingsNextSteps(rctx.req, rctx.res, rctx.body),
    '/settings/save': (rctx) => handleSettingsRawSave(rctx.req, rctx.res, rctx.body, ctx),
    '/zones/guided-save': (rctx) => handleZonesGuidedSave(rctx.req, rctx.res, rctx.body, ctx),
    '/zones/save': (rctx) => handleZonesRawSave(rctx.req, rctx.res, rctx.body, ctx),
  };
}

// -- Main request handler ----------------------------------------------------

export function createRequestHandler({ host, port, appRoot, envPath, zonesPath, publicDir }) {
  // Resolve the public directory once at startup instead of per-request
  const resolvedPublic = realpathSync(publicDir);

  const context = { appRoot, envPath, zonesPath, publicDir };
  const GET_ROUTES = buildGetRoutes(context);
  const POST_ROUTES = buildPostRoutes(context);

  return async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    try {
      if (!requireAuth(req, res, url)) return;

      if (method === 'GET') {
        const csrf = getCsrfToken(req);

        // Check route table
        const handler = GET_ROUTES[path];
        if (handler) return await handler({ req, res, url, csrf });

        // Static assets (PWA, CSS, theme toggle)
        if (PUBLIC_PATHS.has(path) && path !== '/login') {
          return serveStatic(res, path, publicDir, resolvedPublic);
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

        // Login does not require CSRF (no prior session to attach token to)
        if (path === '/login') {
          const handler = POST_ROUTES['/login'];
          return await handler({ req, res, body });
        }

        // All other POST routes require CSRF validation
        if (!verifyCsrf(req, body)) {
          log(0, `CSRF validation failed for ${path}`);
          res.writeHead(403, SECURITY_HEADERS);
          res.end('Forbidden - invalid CSRF token');
          return;
        }

        const handler = POST_ROUTES[path];
        if (handler) return await handler({ req, res, body });
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
