import {normalizeRegistration, registrationCompact, registrationRegex} from './lib.mjs';

const PLANESPOTTERS_API = 'https://api.planespotters.net/pub/photos/reg/';
const AIRPORT_DATA_API = 'https://airport-data.com/api/ac_info.json';
const DAY = 24 * 60 * 60 * 1000;

function validHex(value) {
  const hex = String(value ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return /^[0-9A-F]{6}$/.test(hex) ? hex : '';
}

function modeSFromPhotos(photos) {
  for (const photo of photos) {
    for (const candidate of [photo?.modeSCode, photo?.mode_s, photo?.mode_s_code, photo?.hex, photo?.icao24, photo?.aircraft?.mode_s, photo?.aircraft?.mode_s_code, photo?.aircraft?.hex, photo?.aircraft?.icao24]) {
      const hex = validHex(candidate);
      if (hex) return hex;
    }
  }
  return '';
}

function cleanPhoto(photo) {
  const image = photo?.thumbnail_large?.src ?? photo?.thumbnail?.src;
  const link = photo?.link;
  const photographer = typeof photo?.photographer === 'string' ? photo.photographer.trim().slice(0, 160) : '';
  if (typeof image !== 'string' || !/^https:\/\//i.test(image) || typeof link !== 'string' || !/^https:\/\/www\.planespotters\.net\/photo\//i.test(link)) return null;
  const modeSCode = validHex(photo?.mode_s ?? photo?.mode_s_code ?? photo?.hex ?? photo?.icao24 ?? photo?.aircraft?.mode_s ?? photo?.aircraft?.mode_s_code ?? photo?.aircraft?.hex ?? photo?.aircraft?.icao24);
  return {image, link, photographer: photographer || '摄影者信息待补充', modeSCode};
}

function cleanAircraft(data, registration, modeSCode, now) {
  return {
    registration: String(data?.reg || registration).slice(0, 24),
    model: typeof data?.model === 'string' ? data.model.trim().slice(0, 160) : '',
    constructorNumber: typeof data?.cn === 'string' ? data.cn.trim().slice(0, 40) : '',
    country: typeof data?.country === 'string' ? data.country.trim().slice(0, 80) : '',
    modeSCode: validHex(data?.mode_s_code) || modeSCode,
    sourceUrl: typeof data?.link === 'string' && /^https:\/\/airport-data\.com\//i.test(data.link) ? data.link : '',
    updatedAt: new Date(now).toISOString(),
  };
}

function findByRegistration(cache, registration) {
  const pattern = registrationRegex(registration);
  return pattern ? Object.values(cache).find(item => typeof item?.registration === 'string' && pattern.test(item.registration)) ?? null : null;
}

async function jsonFetch(fetcher, url, origin) {
  const headers={Accept:'application/json', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'};
  if(origin){headers.Origin=origin;headers.Referer=`${origin}/`;}
  const response = await fetcher(url, {headers, signal:AbortSignal.timeout(7000), redirect:'manual'});
  if (!response.ok) return null;
  return response.json();
}

async function getPhotos(fetcher, registration, origin) {
  try {
    const result = await jsonFetch(fetcher, `${PLANESPOTTERS_API}${encodeURIComponent(registration)}`, origin);
    return {photos:Array.isArray(result?.photos) ? result.photos.map(cleanPhoto).filter(Boolean).slice(0, 3) : [], queried:Array.isArray(result?.photos)};
  } catch { return {photos:[], queried:false}; }
}

async function getAirportData(fetcher, modeSCode, origin) {
  if (!validHex(modeSCode)) return null;
  try {
    const result = await jsonFetch(fetcher, `${AIRPORT_DATA_API}?m=${modeSCode}`, origin);
    return result?.status === 200 ? result : null;
  } catch { return null; }
}

export async function resolveModeSFromAircraftPage(fetcher, registration, origin, profileFallback) {
  try {
    const url = `https://airport-data.com/aircraft/${encodeURIComponent(registration)}`;
    const response = await fetcher(url, {headers:{Accept:'text/html', 'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', ...(origin?{Origin:origin,Referer:`${origin}/`}:{})}, signal:AbortSignal.timeout(7000), redirect:'manual'});
    let html = '';
    if (response.ok) html = (await response.text()).slice(0, 2_000_000);
    else if (response.status === 403 && profileFallback) html = String(await profileFallback(url)).slice(0, 2_000_000);
    else return '';
    const match = html.match(/Mode\s*S\s*\(ICAO24\)\s*Code<\/td>\s*<td[^>]*>\s*([0-9A-F]{6})\s*<\/td>/i);
    return validHex(match?.[1]);
  } catch { return ''; }
}

export async function enrichAircraftRegistration({registration, cache = {}, fetcher = fetch, now = Date.now(), refreshPhotos = false, force = false, origin = 'http://127.0.0.1:4317', profileFallback}) {
  const normalized = normalizeRegistration(registration);
  if (!normalized) return {cache, aircraft:null, photos:[]};
  const compact = registrationCompact(normalized);
  const existing = findByRegistration(cache, normalized);
  let entry = existing ?? {registration:normalized, model:'', constructorNumber:'', country:'', modeSCode:'', sourceUrl:'', updatedAt:'', photos:[], photosUpdatedAt:0};
  const updatedTime = Date.parse(entry.updatedAt) || 0;
  const retryReady = !entry.lookupAttemptedAt || now - entry.lookupAttemptedAt > 60 * 60 * 1000;
  if (force || ((!updatedTime || now - updatedTime > 180 * DAY) && retryReady)) {
    const photoResult = await getPhotos(fetcher, normalized, origin);
    const freshPhotos = photoResult.photos;
    if (photoResult.queried) entry = {...entry, photos:freshPhotos, photosUpdatedAt:now};
    const modeSCode = modeSFromPhotos(freshPhotos) || entry.modeSCode || await resolveModeSFromAircraftPage(fetcher, normalized, origin, profileFallback);
    const airportData = await getAirportData(fetcher, modeSCode, origin);
    if (airportData) entry = {...entry, ...cleanAircraft(airportData, normalized, modeSCode, now)};
    else entry = {...entry, registration:normalized, modeSCode};
    entry = {...entry, lookupAttemptedAt:now};
  } else if (refreshPhotos || !entry.photosUpdatedAt || now - entry.photosUpdatedAt > DAY) {
    const photoResult = await getPhotos(fetcher, normalized, origin);
    const freshPhotos = photoResult.photos;
    if (photoResult.queried) {
      entry = {...entry, photos:freshPhotos, photosUpdatedAt:now};
      const modeSCode = modeSFromPhotos(freshPhotos) || entry.modeSCode || await resolveModeSFromAircraftPage(fetcher, normalized, origin, profileFallback);
      if (!entry.model && modeSCode) {
        const airportData = await getAirportData(fetcher, modeSCode, origin);
        if (airportData) entry = {...entry, ...cleanAircraft(airportData, normalized, modeSCode, now)};
        else entry = {...entry, modeSCode};
      }
    }
  }
  // Compact keys ensure B-HLM, BHLM and B HLM resolve to the same local cache entry.
  const nextCache = {...cache, [compact]:entry};
  return {cache:nextCache, aircraft:entry, photos:entry.photos ?? []};
}
