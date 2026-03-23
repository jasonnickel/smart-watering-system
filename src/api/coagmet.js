// CoAgMet (Colorado Agricultural Meteorological Network) API client
// Fetches reference ET from the nearest Colorado weather station for
// cross-validating the system's Hargreaves ET calculations.
// No API key required. Docs: https://coagmet.colostate.edu/data/doc.html

import { log } from '../log.js';

const BASE_URL = 'https://coagmet.colostate.edu/data';
const TIMEOUT_MS = 15000;

// Default station is configurable via env; falls back to nearest-to-Golden
const DEFAULT_STATION = process.env.COAGMET_STATION || 'den01';

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Fetch all CoAgMet station metadata and find the nearest active station.
 *
 * @param {number} lat - Target latitude
 * @param {number} lon - Target longitude
 * @returns {Promise<object>} Nearest station { id, name, lat, lon, distanceMiles }
 */
export async function findNearestStation(lat, lon) {
  const timeoutSignal = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;

  const response = await fetch(`${BASE_URL}/metadata.json`, { signal: timeoutSignal });
  if (!response.ok) {
    throw new Error(`CoAgMet metadata returned ${response.status}`);
  }

  const stations = await response.json();
  let nearest = null;
  let minDist = Infinity;

  for (const station of stations) {
    if (!station.active) continue;
    const dist = haversineDistance(lat, lon, station.latitude, station.longitude);
    if (dist < minDist) {
      minDist = dist;
      nearest = {
        id: station.station_id || station.id,
        name: station.station_name || station.name,
        lat: station.latitude,
        lon: station.longitude,
        distanceMiles: Math.round(dist * 10) / 10,
      };
    }
  }

  return nearest;
}

/**
 * Fetch daily reference ET and weather data from a CoAgMet station.
 *
 * @param {object} options
 * @param {string} [options.station] - Station ID (default: COAGMET_STATION env or 'den01')
 * @param {string} [options.from] - Start date YYYY-MM-DD
 * @param {string} [options.to] - End date YYYY-MM-DD
 * @returns {Promise<Array>} Array of daily records
 */
export async function getDailyET(options = {}) {
  const station = options.station || DEFAULT_STATION;
  const timeoutSignal = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;

  let url = `${BASE_URL}/daily/${station}.json`;
  const params = new URLSearchParams();
  params.set('fields', 'etrASCE,etoASCE,tMax,tMin,tAvg,rhMax,rhMin,solarRad,windSpeed,precip');
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  url += `?${params}`;

  try {
    const response = await fetch(url, { signal: timeoutSignal });
    if (!response.ok) {
      throw new Error(`CoAgMet daily returned ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) return [];

    const records = data.map(day => ({
      date: day.date,
      referenceETr: parseSafe(day.etrASCE),
      referenceETo: parseSafe(day.etoASCE),
      tempMax: parseSafe(day.tMax),
      tempMin: parseSafe(day.tMin),
      tempAvg: parseSafe(day.tAvg),
      humidityMax: parseSafe(day.rhMax),
      humidityMin: parseSafe(day.rhMin),
      solarRadiation: parseSafe(day.solarRad),
      windSpeed: parseSafe(day.windSpeed),
      precipitation: parseSafe(day.precip),
    })).filter(r => r.referenceETo !== null);

    log(2, `CoAgMet: ${records.length} daily records from ${station}`);
    return records;
  } catch (err) {
    log(0, `CoAgMet daily fetch failed: ${err.message}`);
    throw err;
  }
}

/**
 * Get yesterday's reference ET for cross-validation.
 *
 * @param {string} [station] - Station ID
 * @returns {Promise<object|null>} { referenceETo, referenceETr, station, date }
 */
export async function getYesterdayReferenceET(station) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const records = await getDailyET({ station, from: yesterday, to: yesterday });

  if (records.length === 0) return null;

  const record = records[0];
  return {
    date: record.date,
    referenceETo: record.referenceETo,
    referenceETr: record.referenceETr,
    station: station || DEFAULT_STATION,
  };
}

/**
 * Compare the system's calculated ET against CoAgMet reference ET.
 *
 * @param {number} calculatedET - System's Hargreaves ET in inches
 * @param {number} referenceETo - CoAgMet grass reference ET in inches
 * @returns {{ deviationPct: number, assessment: string }}
 */
export function compareET(calculatedET, referenceETo) {
  if (!Number.isFinite(calculatedET) || !Number.isFinite(referenceETo) || referenceETo === 0) {
    return { deviationPct: 0, assessment: 'insufficient data' };
  }

  const deviationPct = ((calculatedET - referenceETo) / referenceETo) * 100;

  let assessment;
  if (Math.abs(deviationPct) <= 15) {
    assessment = 'within normal range';
  } else if (deviationPct > 15) {
    assessment = 'system ET is higher than reference - may be overwatering';
  } else {
    assessment = 'system ET is lower than reference - may be underwatering';
  }

  return { deviationPct: Math.round(deviationPct), assessment };
}

function parseSafe(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n === -999) return null;
  return n;
}
