// Page renderers for each web UI route.

import { existsSync, readFileSync } from 'node:fs';

import CONFIG from '../config.js';
import { readEnvFile, readShadowMode } from '../env.js';
import {
  buildGuidedSettingsModel,
  buildZoneConfigYaml,
  parseZoneConfig,
} from '../web-forms.js';
import { explainDecision, shortExplanation } from '../explain.js';
import { chartsPageContent } from '../charts.js';
import { localDateStr, minutesSinceTimestamp } from '../time.js';
import {
  getStatus, getRunsSince, getFinanceData, getCachedWeather,
} from '../db/state.js';
import { collectAdvisorInsights, aiNarrationEnabled } from '../ai/advisor.js';
import { authEnabled, safeNextPath } from './auth.js';
import {
  layout, noticeBanner, escapeHtml, badge, button,
  moistureBar, selectedAttr, csrfField,
} from './html.js';

// -- Shared helpers ----------------------------------------------------------

export function configuredSetupCard() {
  // Only show the workflow card when setup is still in progress
  const envContent = readEnvFile();
  const model = buildGuidedSettingsModel(envContent);
  if (model.rachioConfigured) return '';

  return `<div class="card">
    <h2>Choose Your Workflow</h2>
    <div class="setup-cta">
      <p class="helper">Prefer terminal and files? Keep using <span class="inline-code">smart-water setup</span>, <span class="inline-code">smart-water doctor</span>, and the raw editors below. Prefer a guided browser flow? Use the Guided Setup tab.</p>
      <a class="btn btn-secondary" href="/setup">Open Guided Setup</a>
    </div>
  </div>`;
}

function renderGuidedSettingsForm(model, csrf, options = {}) {
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
      ${csrfField(csrf)}
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

function renderAdvancedSettingsEditor(rawEnv, query, csrf) {
  const advancedOpen = query.get('advanced') === '1' ? ' open' : '';
  return `<details${advancedOpen}>
    <summary>Advanced Raw Editor</summary>
    <p class="helper">This is the original plain-text env editor for people who prefer files and direct control.</p>
    <form method="POST" action="/settings/save">
      ${csrfField(csrf)}
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

export function loadZoneEditorData(zonesPath) {
  const fallback = {
    zoneProfiles: CONFIG.watering.zoneProfiles,
    soilProfiles: CONFIG.watering.soilProfiles,
  };

  let rawYaml = '';
  if (existsSync(zonesPath)) {
    rawYaml = readFileSync(zonesPath, 'utf-8');
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

function renderGuidedZonesForm(zoneData, csrf) {
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
      ${csrfField(csrf)}
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

function renderAdvancedZonesEditor(zoneData, query, csrf) {
  const advancedOpen = query.get('advanced') === '1' ? ' open' : '';
  return `<details${advancedOpen}>
    <summary>Advanced YAML Editor</summary>
    <p class="helper">This is the original raw YAML editor for people who want full control.</p>
    <form method="POST" action="/zones/save">
      ${csrfField(csrf)}
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

function parseHistoryHours(query) {
  const raw = query.get('hours') || '24';
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 24;
  }
  return Math.min(parsed, 24 * 30);
}

function insightTone(severity) {
  switch (severity) {
    case 'critical': return 'error';
    case 'warning': return 'warning';
    case 'success': return 'success';
    default: return 'neutral';
  }
}

function insightLabel(severity) {
  switch (severity) {
    case 'critical': return 'Critical';
    case 'warning': return 'Warning';
    case 'success': return 'Stable';
    default: return 'Info';
  }
}

function renderAdvisorSection() {
  const insights = collectAdvisorInsights();
  const content = insights.length > 0
    ? `<div class="advisor-list">
        ${insights.map(insight => `<div class="advisor-item">
          <div class="advisor-head">
            ${badge(insightLabel(insight.severity), insightTone(insight.severity))}
            <span class="advisor-title">${escapeHtml(insight.title)}</span>
          </div>
          <p class="helper">${escapeHtml(insight.summary)}</p>
        </div>`).join('')}
      </div>`
    : '<p class="helper">No weather-confidence, rain-gauge, or flow-calibration issues have crossed the advisory thresholds recently.</p>';

  return `<div class="card">
    <h2>Advisor Insights</h2>
    <p class="helper">Advisory-only suggestions inspired by the future-work plan. These notes never change the deterministic watering engine on their own.</p>
    ${content}
  </div>`;
}

// -- Page renderers ----------------------------------------------------------

export function loginPage(query) {
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

export function dashboardPage(query, zonesPath, csrf) {
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

  const zoneData = loadZoneEditorData(zonesPath);
  const smokeZoneOptions = zoneData.zones.map(zone => {
    const name = zoneNameMap()[zone.zoneNumber] || `Zone ${zone.zoneNumber}`;
    return `<option value="${zone.zoneNumber}">Zone ${zone.zoneNumber} - ${escapeHtml(name)}</option>`;
  }).join('');

  const actionsHtml = envModel.rachioConfigured ? `<div class="actions">
      <form method="POST" action="/action/water" onsubmit="return confirm('${escapeHtml(isShadow ? 'Start a manual watering run now? Shadow mode is enabled, so nothing will actuate.' : 'Start a live manual watering run now? This will send a real command to Rachio.')}')">
        ${csrfField(csrf)}
        ${button(isShadow ? 'Run Manual Watering (Shadow)' : 'Water Now (Live)')}
      </form>
      <form method="POST" action="/action/shadow-toggle" onsubmit="return confirm('${escapeHtml(isShadow ? 'Switch to live mode? Future WATER decisions will actuate your Rachio controller.' : 'Switch back to shadow mode? Future decisions will log only and will not actuate Rachio.')}')">
        ${csrfField(csrf)}
        ${button(isShadow ? 'Go Live' : 'Enable Shadow', isShadow ? 'success' : 'warning')}
      </form>
    </div>`
    : `<p class="helper">Finish setup before sending commands to Rachio.</p>`;

  const smokeTestHtml = envModel.rachioConfigured && !isShadow ? `<div class="card">
      <h2>Commissioning Smoke Test</h2>
      <p class="helper">This runs one short live zone test using the same command path as the controller. It is optional and intended for the day you leave shadow mode.</p>
      <form method="POST" action="/action/smoke-test" onsubmit="return confirm('Start a live smoke test now? This will send a real command to Rachio.')">
        ${csrfField(csrf)}
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

  // Setup is complete when Rachio key is configured
  const setupComplete = envModel.rachioConfigured;
  const hasMoistureData = status.moisture.length > 0;

  return layout('Dashboard', `
    ${noticeBanner(query)}

    ${!setupComplete ? `<div class="card notice notice-warning" role="status">
      <h2>Finish Setup</h2>
      <p class="helper">The browser UI can walk you through setup, or you can keep using <span class="inline-code">smart-water setup</span> from the terminal.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/setup">Open Guided Setup</a>
      </div>
    </div>` : ''}

    ${aiNarrationEnabled() ? `<div class="card">
      <h2>Ask Your Yard</h2>
      <p class="helper">Ask questions about your irrigation system in plain English. Answers are grounded in your live data.</p>
      <form id="chat-form" class="chat-form">
        ${csrfField(csrf)}
        <div class="chat-input-row">
          <input id="chat-input" type="text" placeholder="Why didn't you water yesterday?" maxlength="500" autocomplete="off">
          ${button('Ask', 'primary')}
        </div>
      </form>
      <div id="chat-output" class="chat-output"></div>
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
      ${!setupComplete ? `<div class="card">
        <h2>Setup Snapshot</h2>
        <div class="stat-list">
          <div class="stat"><span>Rachio key</span><span>${envModel.rachioConfigured ? badge('Saved', 'success') : badge('Missing', 'warning')}</span></div>
          <div class="stat"><span>Ambient Weather</span><span>${envModel.ambientApiConfigured && envModel.ambientAppConfigured && envModel.ambientMacConfigured ? badge('Configured', 'success') : badge('Optional', 'neutral')}</span></div>
          <div class="stat"><span>MQTT</span><span>${envModel.mqttBrokerUrl ? badge('Configured', 'success') : badge('Optional', 'neutral')}</span></div>
          <div class="stat"><span>Web login</span><span>${authEnabled() ? badge('Enabled', 'success') : badge('Disabled', 'neutral')}</span></div>
        </div>
      </div>` : `<div class="card">
        <h2>Water Usage</h2>
        <div class="stat-list">
          <div class="stat"><span>Today</span><span>${status.todayUsage.gallons.toFixed(0)} gal / $${status.todayUsage.cost.toFixed(2)}</span></div>
          <div class="stat"><span>This month</span><span>${finance?.monthly_gallons?.toFixed(0) || 0} gal / $${finance?.monthly_cost?.toFixed(2) || '0.00'}</span></div>
          <div class="stat"><span>Billing cycle</span><span>${finance?.cumulative_gallons?.toFixed(0) || 0} gal</span></div>
        </div>
      </div>`}
    </div>

    ${hasMoistureData ? `<div class="card">
      <h2>Soil Moisture</h2>
      <div class="grid grid-2">${moistureHtml}</div>
    </div>` : ''}

    ${forecastHtml ? `<div class="card"><h2>Forecast</h2>${forecastHtml}</div>` : ''}
    ${renderAdvisorSection()}

    ${setupComplete ? `<div class="card">
      <h2>Quick Actions</h2>
      <p class="helper">${isShadow ? 'Shadow mode records decisions without actuating Rachio.' : 'Live mode sends real watering commands to Rachio.'}</p>
      ${actionsHtml}
    </div>` : ''}

    ${smokeTestHtml}
  `, 'dashboard', { authEnabled: authEnabled(), csrf });
}

export function logsPage(query, csrf) {
  const hours = parseHistoryHours(query);
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const runs = getRunsSince(since);

  const filterLinks = [24, 48, 168].map(value =>
    `<a class="btn ${hours === value ? 'btn-primary' : 'btn-secondary'}" href="/logs?hours=${value}">${value === 168 ? '7 days' : `${value}h`}</a>`
  ).join('');

  const aiEnabled = aiNarrationEnabled();
  const rows = runs.length > 0
    ? runs.map(run => {
        const reasonText = escapeHtml(run.phase === 'DECIDE' ? shortExplanation(run) : (run.reason || ''));
        const narrativeBtn = aiEnabled && run.phase === 'DECIDE' && run.id
          ? ` <button class="btn-inline" data-narrative-run="${run.id}">Explain</button>`
          : '';
        const narrativeContainer = aiEnabled && run.phase === 'DECIDE' && run.id
          ? `<tr class="narrative-row"><td colspan="5"><div id="narrative-${run.id}" class="narrative-container" style="display:none"></div></td></tr>`
          : '';
        return `<tr>
        <td>${escapeHtml(run.timestamp?.slice(0, 16).replace('T', ' ') || '?')}</td>
        <td>${escapeHtml(run.phase)}</td>
        <td>${run.decision === 'WATER' ? badge('Water', 'success') : badge('Skip', 'warning')}${run.success ? '' : ` ${badge('Failed', 'error')}`}${run.shadow ? ` ${badge('Shadow', 'neutral')}` : ''}</td>
        <td title="${escapeHtml(explainDecision(run))}">${reasonText}${narrativeBtn}</td>
      </tr>${narrativeContainer}`;
      }).join('')
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
  `, 'logs', { authEnabled: authEnabled(), csrf });
}

export function zonesPage(query, zonesPath, csrf) {
  const zoneData = loadZoneEditorData(zonesPath);
  return layout('Zones', `
    ${noticeBanner(query)}
    ${configuredSetupCard()}
    ${zoneData.parseError ? `<div class="card notice notice-warning" role="alert">
      The existing zones.yaml could not be parsed. The guided editor is showing fallback values until you fix or replace the YAML below.
    </div>` : ''}
    ${renderGuidedZonesForm(zoneData, csrf)}
    <div class="card">
      <h2>Advanced Editing</h2>
      <p class="helper">Add or remove zones, customize comments, or edit YAML directly if you prefer.</p>
      ${renderAdvancedZonesEditor(zoneData, query, csrf)}
    </div>
  `, 'zones', { authEnabled: authEnabled(), csrf });
}

export function settingsPage(query, csrf) {
  const envContent = readEnvFile();
  const model = buildGuidedSettingsModel(envContent);

  return layout('Settings', `
    ${noticeBanner(query)}
    ${configuredSetupCard()}
    <div class="card">
      <h2>Guided Settings</h2>
      <p class="helper">This covers the common settings most people need. Leave secret fields blank to keep the existing saved value.</p>
      ${renderGuidedSettingsForm(model, csrf)}
    </div>
    <div class="card">
      <h2>Advanced Editing</h2>
      <p class="helper">Use the raw env editor if you prefer direct control or want to edit less common settings such as SMTP or status page path.</p>
      ${renderAdvancedSettingsEditor(envContent, query, csrf)}
    </div>
  `, 'settings', { authEnabled: authEnabled(), csrf });
}

export function setupPage(query, csrf) {
  const envContent = readEnvFile();
  const model = buildGuidedSettingsModel(envContent);

  return layout('Guided Setup', `
    ${noticeBanner(query)}
    <div class="card">
      <h2>Guided Setup</h2>
      <p class="helper">This page is optional. If you prefer the developer workflow, you can still use <span class="inline-code">smart-water setup</span>, edit <span class="inline-code">~/.smart-water/.env</span>, and manage <span class="inline-code">zones.yaml</span> directly.</p>
      ${renderGuidedSettingsForm(model, csrf, {
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
  `, 'setup', { authEnabled: authEnabled(), csrf });
}

export function chartsPage(csrf) {
  return layout('Charts', chartsPageContent(), 'charts', { authEnabled: authEnabled(), csrf });
}

export function briefingPage(csrf) {
  const aiEnabled = aiNarrationEnabled();
  return layout('Briefing', `
    <div class="card">
      <h2>Weekly Intelligence Briefing</h2>
      <p class="helper">Multi-period trend analysis with week-over-week, month-over-month, seasonal, and year-over-year comparison. The full briefing is emailed every Sunday at 7am. Generate one on-demand below.</p>
      ${aiEnabled ? `<div class="actions" style="margin-bottom:16px">
        <button id="generate-briefing" class="btn btn-primary" type="button">Generate Briefing Now</button>
      </div>` : '<p class="helper" style="color:var(--warning)">Set AI_API_KEY in your env file to enable AI-powered briefing narratives.</p>'}
      <div id="briefing-output"></div>
    </div>
    ${csrfField(csrf)}
  `, 'briefing', { authEnabled: authEnabled(), csrf });
}
