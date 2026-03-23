// USDA Soil Data Access (SDA) API client
// Queries SSURGO soil survey data by lat/lon to auto-populate zone profiles.
// No API key required. Data covers all of CONUS.
// Docs: https://sdmdataaccess.nrcs.usda.gov/

import { log } from '../log.js';
import { saveSoilSurvey, getCachedSoilSurvey } from '../db/state.js';

const SDA_ENDPOINT = 'https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest';
const TIMEOUT_MS = 30000;

function buildSoilQuery(lat, lon) {
  // WKT uses lon,lat order (not lat,lon)
  return `SELECT
    co.compname,
    co.comppct_r,
    co.taxclname AS taxonomy,
    hz.hzdept_r AS depth_top_cm,
    hz.hzdepb_r AS depth_bot_cm,
    hz.awc_r AS awc_cm_per_cm,
    hz.ksat_r AS ksat_um_per_sec,
    hz.sandtotal_r AS sand_pct,
    hz.silttotal_r AS silt_pct,
    hz.claytotal_r AS clay_pct,
    hz.om_r AS organic_matter_pct,
    hz.ph1to1h2o_r AS ph,
    tg.texture AS texture_class
  FROM mapunit mu
    INNER JOIN component co ON co.mukey = mu.mukey
    INNER JOIN chorizon hz ON hz.cokey = co.cokey
    LEFT JOIN chtexturegrp tg ON tg.chkey = hz.chkey AND tg.rvindicator = 'Yes'
  WHERE
    mu.mukey IN (
      SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${lon} ${lat})')
    )
    AND co.majcompflag = 'Yes'
  ORDER BY co.comppct_r DESC, hz.hzdept_r ASC`;
}

function buildProfileQuery(lat, lon) {
  // Depth-weighted AWC sum for the full profile
  return `SELECT
    co.compname,
    co.comppct_r,
    SUM((hz.hzdepb_r - hz.hzdept_r) * hz.awc_r) AS total_awc_cm,
    SUM(hz.hzdepb_r - hz.hzdept_r) AS profile_depth_cm,
    AVG(hz.ph1to1h2o_r) AS avg_ph,
    AVG(hz.om_r) AS avg_organic_matter_pct,
    AVG(hz.ksat_r) AS avg_ksat_um_per_sec
  FROM mapunit mu
    INNER JOIN component co ON co.mukey = mu.mukey
    INNER JOIN chorizon hz ON hz.cokey = co.cokey
  WHERE
    mu.mukey IN (
      SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${lon} ${lat})')
    )
    AND co.majcompflag = 'Yes'
    AND hz.awc_r IS NOT NULL
  GROUP BY co.compname, co.comppct_r`;
}

async function querySDA(sql) {
  const timeoutSignal = AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined;

  const response = await fetch(SDA_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query: sql, format: 'json+columnname' }),
    signal: timeoutSignal,
  });

  if (!response.ok) {
    throw new Error(`USDA SDA returned ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  if (!data?.Table || data.Table.length < 2) {
    return [];
  }

  const headers = data.Table[0];
  return data.Table.slice(1).map(row => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      const value = row[i];
      obj[headers[i]] = value === null || value === '' ? null : value;
    }
    return obj;
  });
}

/**
 * Get detailed soil horizons for a lat/lon point.
 * Returns per-horizon data with AWC, texture, pH, organic matter, etc.
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<Array>} Array of horizon objects
 */
export async function getSoilHorizons(lat, lon) {
  try {
    const rows = await querySDA(buildSoilQuery(lat, lon));
    log(1, `USDA soil query returned ${rows.length} horizons for ${lat}, ${lon}`);
    return rows;
  } catch (err) {
    log(0, `USDA soil query failed: ${err.message}`);
    throw err;
  }
}

/**
 * Get a summary soil profile for a lat/lon point.
 * Returns depth-weighted AWC and average properties for the dominant soil component.
 *
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @returns {Promise<object|null>} Soil profile summary
 */
export async function getSoilProfile(lat, lon) {
  // Check DB cache first - soil data rarely changes
  try {
    const cached = getCachedSoilSurvey(lat, lon);
    if (cached) {
      log(2, `USDA soil profile: using cached data for ${lat}, ${lon}`);
      return {
        soilName: cached.soil_name,
        dominantPct: cached.dominant_pct,
        totalAwcInches: cached.total_awc_inches,
        awcPerInch: cached.awc_per_inch,
        profileDepthInches: cached.profile_depth_inches,
        avgPH: cached.avg_ph,
        avgOrganicMatterPct: cached.avg_organic_matter_pct,
        avgInfiltrationRate: cached.avg_infiltration_rate,
        cached: true,
      };
    }
  } catch {
    // DB not initialized - proceed with live query
  }

  try {
    const [profileRows, horizonRows] = await Promise.all([
      querySDA(buildProfileQuery(lat, lon)),
      querySDA(buildSoilQuery(lat, lon)),
    ]);
    if (profileRows.length === 0) return null;

    const dominant = profileRows[0];
    const totalAwcCm = parseFloat(dominant.total_awc_cm) || 0;
    const profileDepthCm = parseFloat(dominant.profile_depth_cm) || 0;

    const profile = {
      soilName: dominant.compname,
      dominantPct: parseFloat(dominant.comppct_r) || 0,
      totalAwcInches: totalAwcCm / 2.54,
      awcPerInch: profileDepthCm > 0 ? totalAwcCm / profileDepthCm : 0,
      profileDepthInches: profileDepthCm / 2.54,
      avgPH: parseFloat(dominant.avg_ph) || null,
      avgOrganicMatterPct: parseFloat(dominant.avg_organic_matter_pct) || null,
      avgInfiltrationRate: parseFloat(dominant.avg_ksat_um_per_sec) || null,
    };

    // Cache in database
    try {
      saveSoilSurvey(lat, lon, profile, horizonRows);
    } catch {
      // DB not available - fine, we still return the data
    }

    log(1, `USDA soil profile: ${profile.soilName} (${profile.dominantPct}% dominant), AWC ${profile.totalAwcInches.toFixed(2)}" over ${profile.profileDepthInches.toFixed(0)}" depth, pH ${profile.avgPH?.toFixed(1) || '?'}`);
    return profile;
  } catch (err) {
    log(0, `USDA soil profile query failed: ${err.message}`);
    throw err;
  }
}
