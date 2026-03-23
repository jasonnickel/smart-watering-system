// Page renderers for each web UI route.

import { existsSync, readFileSync } from 'node:fs';

import CONFIG from '../config.js';
import { readEnvFile, readShadowMode } from '../env.js';
import {
  buildGuidedSettingsModel,
  buildZoneConfigYaml,
  parseZoneConfig,
} from './forms.js';
import { explainDecision, shortExplanation } from '../explain.js';
import { chartsPageContent } from '../charts.js';
import { localDateStr, minutesSinceTimestamp } from '../time.js';
import {
  getStatus, getRunsSince, getFinanceData, getCachedWeather,
  getSystemState,
} from '../db/state.js';
import { collectAdvisorInsights, aiNarrationEnabled } from '../ai/advisor.js';
import { ndviEnabled } from '../api/ndvi.js';
import { authEnabled, safeNextPath } from './auth.js';
import {
  layout, noticeBanner, escapeHtml, badge, button,
  moistureBar, selectedAttr, csrfField,
} from './html.js';

// -- Shared helpers ----------------------------------------------------------

function secretField(id, name, label, isSaved, placeholder = '') {
  if (isSaved) {
    return `<div class="form-row">
        <label for="${id}">${escapeHtml(label)}</label>
        <div class="secret-field" id="${id}-wrapper">
          <div class="secret-locked">
            <span class="secret-dots">••••••••••••</span>
            <button type="button" class="btn btn-secondary btn-sm" data-action="secret-edit">Edit</button>
          </div>
          <div class="secret-input">
            <input id="${id}" name="${name}" type="password" autocomplete="off" placeholder="Enter new value">
            <button type="button" class="btn btn-secondary btn-sm" data-action="secret-cancel">Cancel</button>
          </div>
        </div>
      </div>`;
  }
  return `<div class="form-row">
      <label for="${id}">${escapeHtml(label)}</label>
      <input id="${id}" name="${name}" type="password" autocomplete="off" placeholder="${escapeHtml(placeholder || label)}">
    </div>`;
}

function renderGuidedSettingsForm(model, csrf, options = {}) {
  const {
    action = '/settings/guided-save',
    submitLabel = 'Save Settings',
    intro = '',
    showDisablePassword = true,
  } = options;

  const ambientHint = model.ambientApiConfigured || model.ambientAppConfigured || model.ambientMacConfigured
    ? 'Ambient Weather credentials are saved.'
    : 'Optional - leave blank to rely on Open-Meteo fallback data.';

  return `
    ${intro}
    <form method="POST" action="${action}">
      ${csrfField(csrf)}
      <fieldset>
        <legend>Rachio Controller</legend>
        <div class="form-grid">
          ${secretField('rachio-api-key', 'rachio_api_key', 'Rachio API key', model.rachioConfigured, 'Paste Rachio API key')}
        </div>
      </fieldset>

      <fieldset>
        <legend>Location</legend>
        <p class="helper">Used for forecasts, timezone-aware scheduling, soil lookup, and satellite views.</p>
        <div class="form-grid">
          <div class="form-row form-row-wide">
            <label for="location-address">Address or place</label>
            <input id="location-address" name="location_address" type="text" value="${escapeHtml(model.locationAddress)}" placeholder="123 Main St, Golden, CO 80401">
            <p class="helper">Enter a street address, neighborhood, or ZIP code, then fill the fields below automatically.</p>
            <div class="location-lookup-actions">
              <button id="location-lookup" class="btn btn-secondary" type="button">Look Up Address</button>
              <span id="location-lookup-status" class="small"></span>
            </div>
          </div>
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
        <legend>Operating Mode</legend>
        <div class="form-grid">
          <div class="form-row">
            <label for="shadow-mode">Mode</label>
            <select id="shadow-mode" name="shadow_mode">
              <option value="true"${selectedAttr(model.shadowMode ? 'true' : 'false', 'true')}>Shadow mode (safe default)</option>
              <option value="false"${selectedAttr(model.shadowMode ? 'true' : 'false', 'false')}>Live mode</option>
            </select>
          </div>
        </div>
      </fieldset>

      <details class="settings-extra">
        <summary>Additional Settings</summary>

        <fieldset>
          <legend>Weather Station</legend>
          <p class="helper">${ambientHint}</p>
          <div class="form-grid">
            ${secretField('ambient-api-key', 'ambient_api_key', 'Ambient Weather API key', model.ambientApiConfigured, 'Optional')}
            ${secretField('ambient-app-key', 'ambient_app_key', 'Ambient Weather application key', model.ambientAppConfigured, 'Optional')}
            ${secretField('ambient-mac-address', 'ambient_mac_address', 'Ambient station MAC address', model.ambientMacConfigured, 'Optional')}
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
              <input id="webhook-url" name="webhook_url" type="url" value="${escapeHtml(model.webhookUrl)}" placeholder="https://your-n8n.example/webhook/taproot">
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
              <input id="mqtt-topic-prefix" name="mqtt_topic_prefix" type="text" value="${escapeHtml(model.mqttTopicPrefix)}" placeholder="taproot">
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Web UI</legend>
          <div class="form-grid">
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
            ${secretField('web-ui-password', 'web_ui_password', 'Web UI password', model.webUiPasswordConfigured, 'Optional')}
          </div>
          ${showDisablePassword && model.webUiPasswordConfigured ? `<label class="checkbox-row">
            <input name="disable_web_ui_password" type="checkbox">
            <span>Remove the web UI password</span>
          </label>` : ''}
        </fieldset>
      </details>

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
    <p class="helper">Direct plain-text env editor.</p>
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

function zoneNameMap(moistureData) {
  const names = {};
  if (moistureData) {
    for (const zone of moistureData) {
      names[zone.zone_number] = zone.zone_name;
    }
  } else {
    const status = getStatus(localDateStr());
    for (const zone of status.moisture) {
      names[zone.zone_number] = zone.zone_name;
    }
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
            <option value="lawn"${selectedAttr(zone.type, 'lawn')}>Sprinkler</option>
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
          <p class="helper">Edit zone parameters here. Use the raw YAML editor below to add or remove zones.</p>
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
    <p class="helper">Raw YAML editor for direct zone configuration.</p>
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

function renderAdvisorSection(insights) {
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
    : '<p class="helper">No weather, calibration, soil, or vegetation background signals have crossed the advisory thresholds recently.</p>';

  return `<div class="advisor-content">
    <p class="helper">Advisory-only suggestions. These notes never change the deterministic watering engine on their own.</p>
    ${content}
  </div>`;
}

// -- Dashboard sub-renderers -------------------------------------------------

function renderWeatherBadge(ambientCache) {
  if (!ambientCache) {
    return badge('Unknown', 'warning');
  }
  try {
    const data = JSON.parse(ambientCache.data_json);
    const ageMin = minutesSinceTimestamp(ambientCache.fetched_at);
    if (Number.isFinite(ageMin) && ageMin < CONFIG.degradedMode.ambientStaleThresholdMinutes) {
      return `${badge('Live', 'success')} ${escapeHtml(`${data.temp}F, ${data.humidity}% RH, wind ${data.windSpeed} mph`)}`;
    } else if (Number.isFinite(ageMin)) {
      return `${badge(`Stale (${Math.round(ageMin)}m)`, 'error')}`;
    }
    return `${badge('Stale (timestamp unreadable)', 'error')}`;
  } catch {
    return badge('Weather cache error', 'error');
  }
}

function forecastDayLabel(dateStr) {
  if (!dateStr) return '?';
  try {
    const d = new Date(dateStr + 'T12:00:00');
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return dateStr.slice(5);
  }
}

function forecastCondition(day) {
  const rain = day.precipitation ?? 0;
  const humidity = day.humidity ?? 50;
  const solar = day.solarRadiation ?? 10;
  if (rain >= 0.25) return { label: 'Rainy', icon: '\u{1F327}\uFE0F', tone: 'rain' };
  if (rain >= 0.05) return { label: 'Showers', icon: '\u{1F326}\uFE0F', tone: 'rain' };
  if (humidity >= 75 && solar < 12) return { label: 'Overcast', icon: '\u2601\uFE0F', tone: 'cloudy' };
  if (solar >= 20) return { label: 'Sunny', icon: '\u2600\uFE0F', tone: 'sunny' };
  return { label: 'Partly Cloudy', icon: '\u26C5', tone: 'cloudy' };
}

function renderForecastCards(forecastCache) {
  if (!forecastCache) return '';
  try {
    const forecast = JSON.parse(forecastCache.data_json);
    return `<div class="forecast-grid">
      ${forecast.slice(0, 4).map((day, i) => {
        const cond = forecastCondition(day);
        const high = day.tmax?.toFixed(0) || '?';
        const low = day.tmin?.toFixed(0) || '?';
        const rain = day.precipitation ?? 0;
        const humidity = day.humidity?.toFixed(0) || '?';
        const label = forecastDayLabel(day.date);
        return `<div class="forecast-card forecast-${cond.tone}${i === 0 ? ' forecast-today' : ''}">
          <div class="forecast-header">
            <span class="forecast-day">${escapeHtml(label)}</span>
            <span class="forecast-icon">${cond.icon}</span>
          </div>
          <div class="forecast-temps">
            <span class="forecast-high">${escapeHtml(high)}<small>F</small></span>
            <span class="forecast-sep">/</span>
            <span class="forecast-low">${escapeHtml(low)}<small>F</small></span>
          </div>
          <div class="forecast-condition">${escapeHtml(cond.label)}</div>
          <div class="forecast-details">
            <span>${rain > 0 ? `${escapeHtml(rain.toFixed(2))}" rain` : 'No rain'}</span>
            <span>${escapeHtml(humidity)}% RH</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  } catch {
    return '';
  }
}

function renderMoistureSection(moisture) {
  if (moisture.length === 0) {
    return '<p class="helper">No moisture data yet. Run a cycle first.</p>';
  }
  return moisture.map(zone => {
    const pct = zone.total_capacity > 0 ? Math.round((zone.balance_inches / zone.total_capacity) * 100) : 0;
    return `<div class="card">
      <h3>Zone ${zone.zone_number} (${escapeHtml(zone.zone_name)})</h3>
      ${moistureBar(pct)}
    </div>`;
  }).join('');
}

function renderQuickActions(envModel, isShadow, csrf) {
  if (!envModel.rachioConfigured) {
    return `<p class="helper">Finish setup before sending commands to Rachio.</p>`;
  }
  return `<div class="actions">
      <form method="POST" action="/action/water" data-confirm="${escapeHtml(isShadow ? 'Start a manual watering run now? Shadow mode is enabled, so nothing will actuate.' : 'Start a live manual watering run now? This will send a real command to Rachio.')}">
        ${csrfField(csrf)}
        ${button(isShadow ? 'Run Manual Watering (Shadow)' : 'Water Now (Live)')}
      </form>
      <form method="POST" action="/action/shadow-toggle" data-confirm="${escapeHtml(isShadow ? 'Switch to live mode? Future WATER decisions will actuate your Rachio controller.' : 'Switch back to shadow mode? Future decisions will log only and will not actuate Rachio.')}">
        ${csrfField(csrf)}
        ${button(isShadow ? 'Go Live' : 'Enable Shadow', isShadow ? 'success' : 'warning')}
      </form>
    </div>`;
}

const NEXT_STEP_STATE_KEY = 'settings_next_steps';
const NEXT_STEP_ITEMS = [
  {
    id: 'review_zones',
    html: 'Review zones in the Zones tab or keep using the raw YAML editor.',
  },
  {
    id: 'run_doctor',
    html: 'Run <span class="inline-code">taproot doctor</span> to verify connectivity.',
  },
  {
    id: 'shadow_reviewed',
    html: 'Use shadow mode until you trust the decisions enough to go live.',
  },
];

function loadNextStepProgress() {
  const stored = getSystemState(NEXT_STEP_STATE_KEY);
  if (!stored) return {};

  try {
    const parsed = JSON.parse(stored);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function renderSmokeTest(zones, smokeZoneOptions, csrf) {
  return `<details class="card-details">
      <summary>Commissioning Smoke Test</summary>
      <div class="card">
        <p class="helper">Run one short live zone test using the same command path as the controller.</p>
        <form method="POST" action="/action/smoke-test" data-confirm="Start a live smoke test now? This will send a real command to Rachio.">
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
      </div>
    </details>`;
}

function renderNextSteps(csrf, progress = {}) {
  return `<form method="POST" action="/settings/next-steps">
    ${csrfField(csrf)}
    <div class="next-steps-list">
      ${NEXT_STEP_ITEMS.map((item, index) => `<label class="next-step-row">
        <input type="checkbox" name="${item.id}"${progress[item.id] ? ' checked' : ''}>
        <span class="next-step-number">${index + 1}.</span>
        <span class="next-step-text">${item.html}</span>
      </label>`).join('')}
    </div>
    <div class="actions">
      ${button('Save Checklist', 'secondary')}
    </div>
  </form>`;
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
      <p class="helper">Enter your web UI password to continue.</p>
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

  const weatherHtml = renderWeatherBadge(getCachedWeather('ambient'));
  const forecastHtml = renderForecastCards(getCachedWeather('openmeteo_forecast'));
  const moistureHtml = renderMoistureSection(status.moisture);

  let lastDecision = 'No runs yet';
  let lastExplanation = '';
  if (status.lastRun) {
    lastDecision = `${escapeHtml(status.lastRun.decision)} - ${escapeHtml(status.lastRun.reason)}`;
    lastExplanation = explainDecision(status.lastRun);
  }

  const names = zoneNameMap(status.moisture);
  const zoneData = loadZoneEditorData(zonesPath);
  const smokeZoneOptions = zoneData.zones.map(zone => {
    const name = names[zone.zoneNumber] || `Zone ${zone.zoneNumber}`;
    return `<option value="${zone.zoneNumber}">Zone ${zone.zoneNumber} - ${escapeHtml(name)}</option>`;
  }).join('');

  const actionsHtml = renderQuickActions(envModel, isShadow, csrf);

  // Setup is complete when Rachio key is configured
  const setupComplete = envModel.rachioConfigured;
  const hasMoistureData = status.moisture.length > 0;

  const insights = collectAdvisorInsights();
  const hasActiveInsights = insights.some(i => i.severity === 'critical' || i.severity === 'warning');

  return layout('Dashboard', `
    ${noticeBanner(query)}

    ${!setupComplete ? `<div class="card notice notice-warning" role="status">
      <h2>Finish Setup</h2>
      <p class="helper">Add your Rachio API key in Settings to get started.</p>
      <div class="actions">
        <a class="btn btn-primary" href="/settings">Open Settings</a>
      </div>
    </div>` : ''}

    <div class="grid grid-2">
      <div class="card">
        <h2>System Status</h2>
        <div class="stat-list stat-list-left">
          <div class="stat"><span class="stat-label">Mode</span><span class="stat-value">${isShadow ? badge('Shadow', 'warning') : badge('Live', 'success')}</span></div>
          <div class="stat"><span class="stat-label">Weather</span><span class="stat-value">${weatherHtml}</span></div>
          <div class="stat"><span class="stat-label">Last decision</span><span class="stat-value">${lastDecision}</span></div>
        </div>
        ${lastExplanation ? `<p class="card-footnote">${escapeHtml(lastExplanation)}</p>` : ''}
      </div>
      ${setupComplete ? `<div class="card">
        <h2>Water Usage</h2>
        <div class="stat-list">
          <div class="stat"><span>Today</span><span>${status.todayUsage.gallons.toFixed(0)} gal / $${status.todayUsage.cost.toFixed(2)}</span></div>
          <div class="stat"><span>This month</span><span>${finance?.monthly_gallons?.toFixed(0) || 0} gal / $${finance?.monthly_cost?.toFixed(2) || '0.00'}</span></div>
          <div class="stat"><span>Billing cycle</span><span>${finance?.cumulative_gallons?.toFixed(0) || 0} gal</span></div>
        </div>
      </div>` : ''}
    </div>

    ${hasMoistureData ? `<div class="card">
      <h2>Soil Moisture</h2>
      <p class="helper">These percentages are modeled estimates, not sensor readings. Each zone compares its estimated water balance against configured soil-water capacity using logged watering, rainfall, and evapotranspiration.</p>
      <div class="grid grid-2">${moistureHtml}</div>
    </div>` : ''}

    ${setupComplete ? `<div class="card">
      <h2>Quick Actions</h2>
      <p class="helper">${isShadow ? 'Shadow mode records decisions without actuating Rachio.' : 'Live mode sends real watering commands to Rachio.'}</p>
      ${actionsHtml}
    </div>` : ''}

    ${forecastHtml ? `<div class="card"><h2>Forecast</h2>${forecastHtml}</div>` : ''}

    <details class="card-details"${hasActiveInsights ? ' open' : ''}>
      <summary>Advisor Insights${hasActiveInsights ? ` - ${badge('Attention', 'warning')}` : ''}</summary>
      ${renderAdvisorSection(insights)}
    </details>

    ${aiNarrationEnabled() ? `<div class="card">
      <h2>Ask Your Yard</h2>
      <p class="helper">Ask questions about your irrigation system in plain English.</p>
      <form id="chat-form" class="chat-form">
        ${csrfField(csrf)}
        <div class="chat-input-row">
          <input id="chat-input" type="text" placeholder="Why didn't you water yesterday?" maxlength="500" autocomplete="off">
          ${button('Ask', 'primary')}
        </div>
      </form>
      <div id="chat-output" class="chat-output"></div>
    </div>` : ''}

    ${envModel.rachioConfigured && !isShadow ? renderSmokeTest(zoneData.zones, smokeZoneOptions, csrf) : ''}

    <div class="card">
      <h2>More</h2>
      <p class="helper">Vegetation trend is already folded into Advisor Insights automatically. The satellite page is an optional deep-dive tool.</p>
      <div class="actions">
        <a class="btn btn-secondary" href="/briefing">Weekly Briefing</a>
        <a class="btn btn-secondary" href="/satellite">Advanced Satellite Diagnostics</a>
      </div>
    </div>
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
          ? ` <button class="btn-inline" data-narrative-run="${escapeHtml(run.id)}">Explain</button>`
          : '';
        const narrativeContainer = aiEnabled && run.phase === 'DECIDE' && run.id
          ? `<tr class="narrative-row"><td colspan="5"><div id="narrative-${escapeHtml(run.id)}" class="narrative-container" style="display:none"></div></td></tr>`
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
    ${zoneData.parseError ? `<div class="card notice notice-warning" role="alert">
      The existing zones.yaml could not be parsed. The guided editor is showing fallback values until you fix or replace the YAML below.
    </div>` : ''}
    ${renderGuidedZonesForm(zoneData, csrf)}
    ${renderAdvancedZonesEditor(zoneData, query, csrf)}
  `, 'zones', { authEnabled: authEnabled(), csrf });
}

export function settingsPage(query, csrf) {
  const envContent = readEnvFile();
  const model = buildGuidedSettingsModel(envContent);
  const setupNeeded = !model.rachioConfigured;
  const nextStepProgress = loadNextStepProgress();

  return layout('Settings', `
    ${noticeBanner(query)}
    ${setupNeeded ? `<div class="card notice notice-warning" role="status">
      <h2>Finish Setup</h2>
      <p class="helper">Add your Rachio API key below to get started.</p>
    </div>` : ''}
    <div class="card">
      <h2>Settings</h2>
      <p class="helper">Leave secret fields blank to keep the existing saved value.</p>
      ${renderGuidedSettingsForm(model, csrf)}
    </div>
    <div class="card">
      <h2>Next Steps</h2>
      <p class="helper">Use this commissioning checklist to track what you have already addressed. Progress stays saved on this controller.</p>
      ${renderNextSteps(csrf, nextStepProgress)}
    </div>
    <div class="card">
      <h2>Advanced Editing</h2>
      <p class="helper">Raw env editor for SMTP, status page path, and other advanced settings.</p>
      ${renderAdvancedSettingsEditor(envContent, query, csrf)}
    </div>
  `, 'settings', { authEnabled: authEnabled(), csrf });
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

export function satellitePage(csrf) {
  const enabled = ndviEnabled();
  return layout('Satellite', `
    <div class="card" id="satellite-app">
      <h2>Satellite Vegetation Health</h2>
      <p class="helper">The useful view is a hybrid: a sharp orthophoto for yard context with a monthly Sentinel vegetation-health layer laid on top. The base image stays crisp; the monthly overlay shows where vegetation is getting healthier or weaker over time.</p>

      <div class="sat-controls">
        <div class="form-row">
          <label for="sat-months">Timeline Length</label>
          <select id="sat-months">
            <option value="6">Last 6 months</option>
            <option value="12" selected>Last 12 months</option>
          </select>
        </div>
        <div class="form-row">
          <label for="sat-opacity">Overlay Opacity</label>
          <input id="sat-opacity" type="range" min="20" max="80" step="5" value="55">
          <div class="small" id="sat-opacity-label">55% overlay strength</div>
        </div>
        <button id="sat-load" class="btn btn-primary" type="button"${enabled ? '' : ' disabled'}>Load Monthly View</button>
      </div>

      ${enabled ? `
      <div class="sat-controls">
        <p class="helper" style="margin:0">Each card uses the same high-resolution house image for alignment and overlays one calendar month of vegetation health. This is for trend spotting, not exact blade-level diagnosis.</p>
      </div>
      <p id="sat-status" class="small"></p>
      <div id="sat-analysis"></div>
      <div id="sat-chart"></div>
      <div id="sat-gallery" class="sat-gallery"></div>

      <div class="card" style="margin-top:16px">
        <h3>How To Read It</h3>
        <div class="sat-legend">
          <div class="sat-legend-item"><span class="sat-swatch" style="background:linear-gradient(135deg,#8e8a7d,#d5cfba)"></span> Base image - best available sharp orthophoto for your area</div>
          <div class="sat-legend-item"><span class="sat-swatch" style="background:#1a991a"></span> Strong green overlay - healthier, denser vegetation signal</div>
          <div class="sat-legend-item"><span class="sat-swatch" style="background:#ccb333"></span> Yellow overlay - thinner or stressed vegetation</div>
          <div class="sat-legend-item"><span class="sat-swatch" style="background:#996633"></span> Brown overlay - bare or dormant ground cover</div>
          <div class="sat-legend-item"><span class="sat-swatch" style="background:rgba(0,0,0,0)"></span> No overlay - no strong vegetation signal or no usable monthly observation</div>
        </div>
      </div>
      ` : `
      <p id="sat-status" class="small"></p>
      <div id="sat-chart"></div>
      <div id="sat-gallery" class="sat-gallery"></div>

      <div class="notice notice-warning card" style="margin-top:16px">
        <p>The monthly vegetation overlay requires a free Copernicus Data Space account.</p>
        <p class="helper">Add <span class="inline-code">COPERNICUS_EMAIL</span> and <span class="inline-code">COPERNICUS_PASSWORD</span> to your env file to turn on the monthly health view.</p>
      </div>
      `}
    </div>
  `, 'satellite', { authEnabled: authEnabled(), csrf });
}
