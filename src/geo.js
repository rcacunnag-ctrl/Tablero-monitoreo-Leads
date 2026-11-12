import { countyFromCity, countyFromZip, cleanCountyName } from './counties.js';
import { config } from './config.js';

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';

/** Geocodificador gratuito del US Census (sin API key). Devuelve null si no hay coincidencia. */
export async function censusGeocode(address, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const params = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    vintage: 'Current_Current',
    layers: 'Counties',
    format: 'json',
  });
  const res = await fetchImpl(`${CENSUS_URL}?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Census geocoder HTTP ${res.status}`);
  return parseCensusResponse(await res.json());
}

export function parseCensusResponse(json) {
  const match = json?.result?.addressMatches?.[0];
  if (!match) return null;
  const county = match.geographies?.Counties?.[0];
  return {
    matchedAddress: match.matchedAddress,
    county: cleanCountyName(county?.NAME),
    state: match.addressComponents?.state || null,
    zip: match.addressComponents?.zip || null,
    lat: match.coordinates?.y ?? null,
    lon: match.coordinates?.x ?? null,
  };
}

const TIGERWEB_ZCTA = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query';
const CENSUS_COORDS = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
const zipCache = new Map();

/**
 * Condado de un código postal (solo el ZIP, sin calle): ubica el centro del ZIP (Census TIGERweb) y consulta el condado de ese punto
 * (Census Geocoder). Sirve para ZIP fuera de las tablas locales (p. ej. 33705 -> Pinellas). Devuelve null si no lo resuelve.
 */
export async function censusZipCounty(zip, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const z = String(zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  if (zipCache.has(z)) return zipCache.get(z);
  const getJson = async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Census HTTP ${res.status}`);
    return res.json();
  };
  const zcta = await getJson(`${TIGERWEB_ZCTA}?${new URLSearchParams({ where: `ZCTA5='${z}'`, outFields: 'ZCTA5,INTPTLAT,INTPTLON', returnGeometry: 'false', f: 'json' })}`);
  const a = zcta?.features?.[0]?.attributes;
  if (!a) { zipCache.set(z, null); return null; }
  const geo = await getJson(`${CENSUS_COORDS}?${new URLSearchParams({ x: String(Number(a.INTPTLON)), y: String(Number(a.INTPTLAT)), benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'Counties', format: 'json' })}`);
  const county = cleanCountyName(geo?.result?.geographies?.Counties?.[0]?.NAME);
  zipCache.set(z, county);
  return county;
}

/**
 * Determina el condado sin servicios externos: ZIP -> condado, luego ciudad -> condado.
 * Opcional (USE_CENSUS_GEOCODER=true): consulta el Census Geocoder (gratuito, sin API key)
 * solo cuando las tablas no resuelven o el resultado es ambiguo.
 * @returns {Promise<{county, method, matchedAddress, lat, lon, zip, ambiguous}>}
 */
export async function resolveCounty(listing, { useCensus = config.useCensusGeocoder, ...opts } = {}) {
  const out = { county: null, method: 'none', matchedAddress: null, lat: null, lon: null, zip: null, ambiguous: false };

  const byZip = countyFromZip(listing.zip);
  const byCity = countyFromCity(listing.city);
  let local = null;
  if (byZip.county) local = { ...out, county: byZip.county, ambiguous: byZip.ambiguous, method: 'zip_table' };
  else if (byCity.county) local = { ...out, county: byCity.county, ambiguous: byCity.ambiguous, method: 'city_table' };
  // ZIP y ciudad apuntan a condados distintos: hay que revisar
  if (local && byZip.county && byCity.county && byZip.county !== byCity.county) local.ambiguous = true;

  if (useCensus && listing.street_address && (listing.city || listing.zip) && (!local || local.ambiguous)) {
    const oneLine = [listing.street_address, listing.city, listing.state || 'FL', listing.zip].filter(Boolean).join(', ');
    try {
      const geo = await censusGeocode(oneLine, opts);
      if (geo?.county) return { ...out, ...geo, method: 'census_geocoder' };
    } catch (err) {
      out.error = err.message;
    }
  }
  // Último recurso: si ni la dirección ni las tablas lo resolvieron, el ZIP solo basta para saber el condado
  if (useCensus && !local?.county && /^\d{5}/.test(String(listing.zip || '').trim())) {
    try {
      const county = await censusZipCounty(listing.zip, opts);
      if (county) return { ...out, county, zip: String(listing.zip).trim().slice(0, 5), method: 'zip_census' };
    } catch (err) {
      out.error = out.error || err.message;
    }
  }
  return local || out;
}
