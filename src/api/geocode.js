// Address lookup for settings UX.
// Uses a single user-triggered geocoding request, then resolves timezone from Open-Meteo.

import { fetchWithRetry } from './http.js';

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'Taproot/1.0 (self-hosted smart irrigation controller)';

async function lookupTimezone(lat, lon) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'temperature_2m_max',
    forecast_days: '1',
    timezone: 'auto',
  });

  const data = await fetchWithRetry(`https://api.open-meteo.com/v1/forecast?${params}`, {}, 'OpenMeteo-Timezone');
  return data?.timezone || 'America/Denver';
}

export async function geocodeAddress(query) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 3) {
    throw new Error('Enter at least 3 characters to look up an address');
  }

  const params = new URLSearchParams({
    q: trimmed,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '1',
  });

  const matches = await fetchWithRetry(`${NOMINATIM_BASE_URL}/search?${params}`, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  }, 'Nominatim-Geocode');

  const match = Array.isArray(matches) ? matches[0] : null;
  if (!match?.lat || !match?.lon) {
    throw new Error('No location match found. Try a fuller address or ZIP code.');
  }

  const latitude = Number(match.lat);
  const longitude = Number(match.lon);
  const timezone = await lookupTimezone(latitude, longitude);

  return {
    query: trimmed,
    displayName: match.display_name || trimmed,
    latitude,
    longitude,
    timezone,
  };
}
