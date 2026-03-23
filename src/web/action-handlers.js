// Action and mutation route handlers for the Taproot web UI.
// Each handler is an async function receiving (req, res, body, context).

import { dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import yaml from 'js-yaml';

import {
  readEnvFile, readShadowMode, writeEnvValue,
} from '../env.js';
import {
  applyGuidedSettings,
  buildZoneConfigYaml,
  normalizeSoilProfiles,
  normalizeZones,
} from './forms.js';
import { log } from '../log.js';
import {
  authEnabled, createSession, clearSession,
  verifyPassword, safeNextPath,
  checkLoginRate, recordLoginFailure, clearLoginFailures,
  AUTH_COOKIE_NAME, SESSION_TTL_MS,
} from './auth.js';
import { redirect } from './http.js';

// -- Helpers -----------------------------------------------------------------

function getClientIP(req) {
  return req.socket?.remoteAddress || 'unknown';
}

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

// -- Handlers ----------------------------------------------------------------

export function handleLogin(req, res, body) {
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

export function handleLogout(req, res) {
  clearSession(req);
  return redirect(res, authEnabled() ? '/login?msg=logged-out' : '/', {
    'Set-Cookie': `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
  });
}

export function handleWater(_req, res, _body, context) {
  runCliInBackground(['water'], 'Manual watering via web UI', context.appRoot);
  return redirect(res, '/?msg=manual-started');
}

export function handleShadowToggle(_req, res) {
  const nextMode = readShadowMode() ? 'false' : 'true';
  writeEnvValue('SHADOW_MODE', nextMode);
  log(1, `Shadow mode toggled via web UI: now ${nextMode === 'true' ? 'SHADOW' : 'LIVE'}`);
  return redirect(res, `/?msg=${readShadowMode() ? 'shadow-on' : 'live-on'}`);
}

export function handleSmokeTest(_req, res, body, context) {
  const zone = parseInt(String(body.get('zone') || ''), 10);
  const minutes = parseInt(String(body.get('minutes') || ''), 10);
  if (!Number.isFinite(zone) || zone < 1 || zone > 16) {
    return redirect(res, '/?msg=settings-error');
  }
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 10) {
    return redirect(res, '/?msg=settings-error');
  }
  runCliInBackground(['smoke-test', '--zone', String(zone), '--minutes', String(minutes), '--yes'], 'Smoke test via web UI', context.appRoot);
  return redirect(res, '/?msg=smoke-started');
}

export async function handleSettingsGuidedSave(_req, res, body, context) {
  try {
    const values = readGuidedSettingsFromBody(body);
    const nextContent = applyGuidedSettings(readEnvFile(), values);
    await mkdir(dirname(context.envPath), { recursive: true });
    await writeFile(context.envPath, nextContent, { mode: 0o600 });
    context.syncWebUiAuth(nextContent);
    log(1, 'Guided settings updated via web UI');
    return redirect(res, '/settings?msg=settings-saved');
  } catch (err) {
    log(0, `Guided settings save failed: ${err.message}`);
    return redirect(res, '/settings?msg=settings-error');
  }
}

export async function handleSettingsRawSave(_req, res, body, context) {
  const envContent = body.get('env') || '';
  await mkdir(dirname(context.envPath), { recursive: true });
  await writeFile(context.envPath, envContent, { mode: 0o600 });
  context.syncWebUiAuth(envContent);
  log(1, 'Environment config updated via raw web UI');
  return redirect(res, '/settings?msg=settings-saved&advanced=1');
}

export async function handleZonesGuidedSave(_req, res, body, context) {
  try {
    const yamlContent = buildZoneConfigYaml(readZonesFromBody(body));
    await mkdir(dirname(context.zonesPath), { recursive: true });
    await writeFile(context.zonesPath, yamlContent);
    log(1, 'Zones config updated via guided web UI');
    return redirect(res, '/zones?msg=zones-saved');
  } catch (err) {
    log(0, `Guided zones save failed: ${err.message}`);
    return redirect(res, '/zones?msg=zones-error');
  }
}

export async function handleZonesRawSave(_req, res, body, context) {
  const zonesContent = body.get('zones') || '';
  try {
    yaml.load(zonesContent, { schema: yaml.JSON_SCHEMA });
    await mkdir(dirname(context.zonesPath), { recursive: true });
    await writeFile(context.zonesPath, zonesContent);
    log(1, 'Zones config updated via raw web UI');
    return redirect(res, '/zones?msg=zones-saved&advanced=1');
  } catch (err) {
    log(0, `Invalid YAML in zones save: ${err.message}`);
    return redirect(res, '/zones?msg=zones-error&advanced=1');
  }
}
