// Sentinel-2 NDVI satellite client via Copernicus Data Space Sentinel Hub
// Provides vegetation health index and actual satellite imagery for a location.
// Requires a free Copernicus Data Space account: dataspace.copernicus.eu
//
// Config via env:
//   COPERNICUS_EMAIL    - account email
//   COPERNICUS_PASSWORD - account password
//
// 10m spatial resolution, ~5-day revisit, free tier: 10,000 PU/month

import { log } from '../log.js';
import { saveNDVIReading } from '../db/state.js';

const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const STATS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/statistics';
const PROCESS_URL = 'https://sh.dataspace.copernicus.eu/api/v1/process';
const TIMEOUT_MS = 30000;

// NDVI evalscript for statistics
const NDVI_STATS_SCRIPT = `//VERSION=3
function setup() {
  return { input: ["B04", "B08", "SCL"], output: { id: "ndvi", bands: 1 } };
}
function evaluatePixel(s) {
  if (s.SCL === 3 || s.SCL === 8 || s.SCL === 9 || s.SCL === 10) return [NaN];
  var ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
  return [ndvi];
}`;

// NDVI evalscript for visual image - blends true color with NDVI color overlay
// Vegetation pops green, bare soil/pavement shows naturally, clouds are white
const NDVI_IMAGE_SCRIPT = `//VERSION=3
function setup() {
  return { input: ["B02", "B03", "B04", "B08", "SCL"], output: { bands: 3, sampleType: "AUTO" } };
}
function evaluatePixel(s) {
  if (s.SCL === 3 || s.SCL === 8 || s.SCL === 9 || s.SCL === 10) return [0.9, 0.9, 0.9];
  var ndvi = (s.B08 - s.B04) / (s.B08 + s.B04);
  var r = s.B04 * 3.0;
  var g = s.B03 * 3.0;
  var b = s.B02 * 3.0;
  if (ndvi > 0.3) {
    var boost = Math.min(1.0, (ndvi - 0.3) * 2.0);
    g = g + boost * 0.4;
    r = r * (1.0 - boost * 0.3);
  } else if (ndvi < 0.1) {
    r = r + 0.1;
  }
  return [Math.min(1, r), Math.min(1, g), Math.min(1, b)];
}`;

// True color satellite image (natural appearance)
const TRUE_COLOR_SCRIPT = `//VERSION=3
function setup() {
  return { input: ["B02", "B03", "B04", "SCL"], output: { bands: 3, sampleType: "AUTO" } };
}
function evaluatePixel(s) {
  if (s.SCL === 3 || s.SCL === 8 || s.SCL === 9 || s.SCL === 10) return [0.9, 0.9, 0.9];
  return [Math.min(1, s.B04 * 3.5), Math.min(1, s.B03 * 3.5), Math.min(1, s.B02 * 3.5)];
}`;

const SCRIPTS = {
  ndvi: NDVI_IMAGE_SCRIPT,
  truecolor: TRUE_COLOR_SCRIPT,
};

let cachedToken = null;
let tokenExpiresAt = 0;

export function ndviEnabled() {
  return Boolean(process.env.COPERNICUS_EMAIL && process.env.COPERNICUS_PASSWORD);
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const timeoutSignal = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: 'cdse-public',
      username: process.env.COPERNICUS_EMAIL,
      password: process.env.COPERNICUS_PASSWORD,
      grant_type: 'password',
    }),
    signal: timeoutSignal,
  });

  if (!response.ok) {
    throw new Error(`Copernicus auth failed: ${response.status}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Expire 1 minute early for safety
  tokenExpiresAt = Date.now() + ((data.expires_in - 60) * 1000);
  return cachedToken;
}

function boundingBox(lat, lon, sizeMeters = 100) {
  // Approximate degrees for the given meter offset
  const latOffset = (sizeMeters / 2) / 111320;
  const lonOffset = (sizeMeters / 2) / (111320 * Math.cos(lat * Math.PI / 180));
  return [
    lon - lonOffset,
    lat - latOffset,
    lon + lonOffset,
    lat + latOffset,
  ];
}

/**
 * Get NDVI statistics for a location over a time range.
 * Returns an array of period values (mean NDVI per aggregation interval).
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} options
 * @param {string} [options.from] - Start date ISO (default: 90 days ago)
 * @param {string} [options.to] - End date ISO (default: today)
 * @param {string} [options.interval] - Aggregation interval (default: 'P16D' = 16 days)
 * @param {number} [options.maxCloudPct] - Max cloud coverage percent (default: 20)
 * @returns {Promise<Array<{from: string, to: string, mean: number, samples: number}>>}
 */
export async function getNDVIStats(lat, lon, options = {}) {
  if (!ndviEnabled()) {
    throw new Error('NDVI not configured: set COPERNICUS_EMAIL and COPERNICUS_PASSWORD');
  }

  const token = await getToken();
  const bbox = boundingBox(lat, lon);
  const from = options.from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
  const to = options.to || new Date().toISOString().slice(0, 10) + 'T23:59:59Z';
  const interval = options.interval || 'P16D';
  const maxCloud = options.maxCloudPct ?? 20;
  const timeoutSignal = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;

  const response = await fetch(STATS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        bounds: { bbox, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
        data: [{ type: 'sentinel-2-l2a', dataFilter: { maxCloudCoverage: maxCloud } }],
      },
      aggregation: {
        timeRange: { from, to },
        aggregationInterval: { of: interval },
        evalscript: NDVI_STATS_SCRIPT,
        resx: 10,
        resy: 10,
      },
    }),
    signal: timeoutSignal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sentinel Hub stats returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = await response.json();
  const results = (payload.data || []).map(entry => {
    const stats = entry.outputs?.ndvi?.bands?.B0?.stats;
    return {
      from: entry.interval?.from,
      to: entry.interval?.to,
      mean: stats?.mean ?? null,
      min: stats?.min ?? null,
      max: stats?.max ?? null,
      samples: stats?.sampleCount ?? 0,
    };
  }).filter(r => r.mean !== null && r.samples > 0);

  // Persist to database for historical tracking
  for (const r of results) {
    try { saveNDVIReading(lat, lon, r); } catch { /* DB may not be initialized */ }
  }

  log(1, `NDVI: ${results.length} periods for ${lat}, ${lon}`);
  return results;
}

/**
 * Get an NDVI satellite image (PNG) for a location at a specific date.
 * Returns a Buffer of PNG image data suitable for serving to the browser.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} options
 * @param {string} [options.date] - Target date YYYY-MM-DD (searches +/- 10 days for clear imagery)
 * @param {number} [options.sizeMeters] - Image extent in meters (default: 200)
 * @param {number} [options.widthPx] - Image width in pixels (default: 512)
 * @returns {Promise<Buffer>} PNG image data
 */
export async function getNDVIImage(lat, lon, options = {}) {
  if (!ndviEnabled()) {
    throw new Error('NDVI not configured: set COPERNICUS_EMAIL and COPERNICUS_PASSWORD');
  }

  const token = await getToken();
  const sizeMeters = options.sizeMeters || 500;
  const bbox = boundingBox(lat, lon, sizeMeters);
  const widthPx = options.widthPx || 512;
  const heightPx = widthPx;
  const date = options.date || new Date().toISOString().slice(0, 10);
  const from = new Date(new Date(date).getTime() - 10 * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z';
  const to = date + 'T23:59:59Z';
  const timeoutSignal = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;

  const response = await fetch(PROCESS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'image/png',
    },
    body: JSON.stringify({
      input: {
        bounds: { bbox, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/4326' } },
        data: [{
          type: 'sentinel-2-l2a',
          dataFilter: {
            timeRange: { from, to },
            maxCloudCoverage: 20,
            mosaickingOrder: 'leastCC',
          },
        }],
      },
      output: {
        width: widthPx,
        height: heightPx,
        responses: [{ identifier: 'default', format: { type: 'image/png' } }],
      },
      evalscript: SCRIPTS[options.mode] || NDVI_IMAGE_SCRIPT,
    }),
    signal: timeoutSignal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Sentinel Hub image returned ${response.status}: ${body.slice(0, 200)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  log(1, `NDVI image: ${buffer.length} bytes for ${lat}, ${lon} near ${date}`);
  return buffer;
}

/**
 * Get a timeline of NDVI images over a date range.
 * Returns an array of { date, imageBuffer } objects.
 *
 * @param {number} lat
 * @param {number} lon
 * @param {object} options
 * @param {number} [options.months] - How many months back (default: 3)
 * @param {number} [options.intervalDays] - Days between images (default: 16)
 * @returns {Promise<Array<{date: string, image: Buffer}>>}
 */
export async function getNDVITimeline(lat, lon, options = {}) {
  const months = options.months || 3;
  const intervalDays = options.intervalDays || 16;
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - months * 30 * 86400000);

  const dates = [];
  for (let ms = startDate.getTime(); ms <= endDate.getTime(); ms += intervalDays * 86400000) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }

  const timeline = [];
  for (const date of dates) {
    try {
      const image = await getNDVIImage(lat, lon, { date });
      timeline.push({ date, image });
    } catch (err) {
      log(1, `NDVI timeline: skipping ${date} - ${err.message}`);
    }
  }

  log(1, `NDVI timeline: ${timeline.length}/${dates.length} images for ${lat}, ${lon}`);
  return timeline;
}
