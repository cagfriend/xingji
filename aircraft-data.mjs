import {normalizeRegistration, registrationCompact, registrationRegex} from './lib.mjs';

const PLANESPOTTERS_API = 'https://api.planespotters.net/pub/photos/reg/';
const AIRPORT_DATA_API = 'https://airport-data.com/api/ac_info.json';
const AIRCRAFT_PAGE = 'https://airport-data.com/aircraft/';
const DAY = 24 * 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const RESOLVER_VERSION = 2;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PHOTO_UA = 'Xingji/1.5 (+https://github.com/cagfriend/xingji)';

function validHex(value) {
  const hex = String(value ?? '').toUpperCase().replace(/[^0-9A-F]/g, '');
  return /^[0-9A-F]{6}$/.test(hex) ? hex : '';
}

function decodeHtml(value = '') {
  const named = {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',ndash:'–',mdash:'—',rsquo:'’',lsquo:'‘',rdquo:'”',ldquo:'“',copy:'©'};
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);?/gi, (match, entity) => {
    if (entity[0] === '#') {
      const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      try { return Number.isFinite(n) ? String.fromCodePoint(n) : match; } catch { return match; }
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function textOf(html = '') {
  return decodeHtml(String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
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
  const thumbnail = photo?.thumbnail?.src;
  const link = photo?.link;
  const photographer = typeof photo?.photographer === 'string' ? photo.photographer.trim().slice(0, 160) : '';
  if (typeof image !== 'string' || !/^https:\/\//i.test(image) || typeof link !== 'string' || !/^https:\/\/www\.planespotters\.net\/photo\//i.test(link)) return null;
  const modeSCode = validHex(photo?.mode_s ?? photo?.mode_s_code ?? photo?.hex ?? photo?.icao24 ?? photo?.aircraft?.mode_s ?? photo?.aircraft?.mode_s_code ?? photo?.aircraft?.hex ?? photo?.aircraft?.icao24);
  return {image, ...(typeof thumbnail === 'string' && /^https:\/\//i.test(thumbnail) ? {thumbnail} : {}), link, photographer: photographer || '摄影者信息待补充', modeSCode};
}

function cleanAircraft(data, registration, modeSCode, now) {
  const model = typeof data?.model === 'string' ? data.model.trim().slice(0, 160) : '';
  const yearRaw = data?.year ?? model.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  const year = Number(yearRaw);
  return {
    registration: String(data?.reg || data?.registration || registration).slice(0, 24),
    model,
    constructorNumber: String(data?.cn ?? '').trim().slice(0, 40),
    country: String(data?.country ?? '').trim().slice(0, 80),
    modeSCode: validHex(data?.mode_s_code ?? data?.modeSCode ?? data?.icao24) || modeSCode,
    sourceUrl: typeof data?.link === 'string' && /^https:\/\/airport-data\.com\//i.test(data.link) ? data.link : '',
    year: Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null,
    updatedAt: new Date(now).toISOString(),
  };
}

function parseAirportDataHtml(html, registration, url, now) {
  const titleRaw = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '';
  const title = textOf(titleRaw);
  const bodyText = textOf(String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? html);
  const notFound = /^Add\s+aircraft\b/i.test(title) || /currently\s+no\s+aircraft/i.test(bodyText) || (/not\s+found/i.test(bodyText) && !/Aircraft Data/i.test(title));
  if (notFound) return {status:'not-found', data:null};

  const titleMatch = title.match(/Aircraft Data\s+([A-Z0-9-]+),\s*(?:(\d{4})\s+)?(.+?),\s*c\/n\s*([^,\s]+)/i);
  const tables = [...String(html).matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map(m => m[1]);
  const constructions = [];
  let details = {};
  let owner = {};
  for (const table of tables) {
    const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map(m => m[1]);
    const fields = {};
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map(m => textOf(m[1]));
      if (cells.length >= 2 && cells[0]) fields[cells[0].replace(/:$/, '')] = cells[1].replace(/Search all.*$/i, '').trim();
    }
    if (fields.Manufacturer || fields['Construction Number (C/N)'] || fields.Model) constructions.push(fields);
    if (fields['Registration Number'] || fields['Mode S (ICAO24) Code'] || fields['Current Status']) details = {...details, ...fields};
    if (fields['Registration Type'] || fields.Owner || fields.Address) owner = {...owner, ...fields};
  }
  const matchingConstruction = constructions.find(item => titleMatch?.[4] && item['Construction Number (C/N)'] === titleMatch[4]);
  const construction = matchingConstruction ?? constructions[0] ?? {};
  const model = `${titleMatch?.[2] ? `${titleMatch[2]} ` : ''}${(titleMatch?.[3] || construction.Model || '').trim()}`.trim();
  const cn = titleMatch?.[4] || construction['Construction Number (C/N)'] || '';
  const year = Number(titleMatch?.[2] || construction['Year built']);
  let country = '';
  const address = owner.Address || '';
  if (address) country = address.split(',').pop().replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
  const foundRegistration = titleMatch?.[1] || details['Registration Number'] || registration;
  if (!model) return {status:'unavailable', error:'Airport-Data page did not contain aircraft details'};
  return {status:'ok', data:{registration:foundRegistration, model, year:Number.isInteger(year) ? year : null, cn, country, mode_s_code:validHex(details['Mode S (ICAO24) Code']), link:url}};
}

function registrationVariants(registration) {
  const compact = registrationCompact(registration);
  const variants = [registration];
  if (compact && compact !== registration) variants.push(compact);
  if (/^[A-Z0-9]+$/.test(compact) && compact.length >= 4) {
    const candidates = [/^[A-Z]/.test(compact) ? `${compact[0]}-${compact.slice(1)}` : '', /^[A-Z]{2}/.test(compact) ? `${compact.slice(0, 2)}-${compact.slice(2)}` : '', /^\d[A-Z]/.test(compact) ? `${compact.slice(0, 2)}-${compact.slice(2)}` : ''];
    for (const candidate of candidates) if (candidate) variants.push(candidate);
  }
  return [...new Set(variants)].slice(0, 4);
}

function modelFamily(value) {
  const model = String(value ?? '').toUpperCase().replace(/[–—]/g, '-');
  let m;
  if (/737\s*(?:MAX|MAXIMUM)|737-?MAX/.test(model)) {
    const max = model.match(/737\s*MAX\s*(\d{1,2})|737-?MAX-?(\d{1,2})/);
    return `B737-MAX${max?.[1] || max?.[2] || ''}`;
  }
  m = model.match(/\b737-(7|8|9|10)\b/); if(m)return `B737-MAX${m[1]}`;
  m = model.match(/\b737-(600|700|800|900|[6789][A-Z0-9]{2})\b/);
  if (m) return `B737-${m[1][0] === '6' ? '600' : m[1][0] === '7' ? '700' : m[1][0] === '8' ? '800' : '900'}`;
  if (/737\s*(?:NG|NEXT GENERATION)/.test(model)) return 'B737-NG';
  if (/\b737\b/.test(model)) return 'B737';
  m = model.match(/\bA\s?3(18|19|20|21|30|40|50|80)(?:[- ]\d{1,3})?\b/); if (m) return `A3${m[1]}`;
  m = model.match(/\b(?:COLUMBIA\s*)?(400|350)\b/); if (m && /COLUMBIA|LANCAIR/.test(model)) return `COLUMBIA${m[1]}`;
  m = model.match(/\bS-?61(?:[A-Z])?\b/); if (m && /SIKORSKY|S-?61/.test(model)) return 'SIKORSKY-S61';
  for (const prefix of ['B747','B757','B767','B777','B787']) {
    const re = new RegExp(`\\b${prefix.slice(1)}(?:[- ]?\\d{3})?\\b`);
    if (re.test(model)) return prefix;
  }
  m = model.match(/\b(?:ERJ-?190(?:-?100)?|E-?190)\b/); if (m) return 'E190';
  m = model.match(/\b(?:EMBRAER\s+|ERJ[- ]?|E[- ]?)(170|175|190|195)(?:LR|AR|STD|E2)?\b/); if(m)return `E${m[1]}`;
  m = model.match(/\b(DC-?\d|MD-?\d{2,3}|E-?\d{3}|CRJ-?\d{3}|ATR-?\d{2,3})\b/); if (m) return m[1].replace(/[- ]/g,'');
  return '';
}

function conflictsWithExpected(model, expectedModels, aircraftType='') {
  const actualFamily = modelFamily(model);
  const known = expectedModels.map(modelFamily).filter(Boolean);
  if (/helicopter|rotorcraft/i.test(aircraftType) && known.some(family => family.startsWith('B') || family.startsWith('A'))) return true;
  if (!actualFamily) return false;
  if (!known.length) return false;
  return !known.some(expected => {
    if (expected === actualFamily) return true;
    if (actualFamily === 'B737') return expected.startsWith('B737');
    if (expected === 'B737') return actualFamily.startsWith('B737');
    if (actualFamily === 'B737-NG' && expected.startsWith('B737-') && !expected.includes('MAX')) return true;
    if (expected === 'B737-NG' && actualFamily.startsWith('B737-') && !actualFamily.includes('MAX')) return true;
    return false;
  });
}

function findByRegistration(cache, registration) {
  const pattern = registrationRegex(registration);
  const compact=registrationCompact(registration);
  const canonical=Object.hasOwn(cache,compact)?cache[compact]:null;
  if(pattern&&typeof canonical?.registration==='string'&&pattern.test(canonical.registration))return canonical;
  return pattern ? Object.values(cache).find(item => typeof item?.registration === 'string' && pattern.test(item.registration)) ?? null : null;
}

function headers(origin, accept, userAgent=BROWSER_UA) {
  return {Accept:accept, 'User-Agent':userAgent, ...(origin ? {Origin:origin, Referer:`${origin}/`} : {})};
}

async function fetchPhotos(fetcher, registration, origin) {
  try {
    const response = await fetcher(`${PLANESPOTTERS_API}${encodeURIComponent(registration)}`, {headers:headers(origin, 'application/json', PHOTO_UA), timeout:20_000, signal:AbortSignal.timeout(20_000), redirect:'follow'});
    if (!response.ok) return {status:'unavailable', error:`Planespotters HTTP ${response.status}`};
    const result = await response.json();
    const photos = Array.isArray(result?.photos) ? result.photos.map(cleanPhoto).filter(Boolean).slice(0, 3) : [];
    return Array.isArray(result?.photos) ? {status:photos.length ? 'ok':'empty', photos, modeSCode:modeSFromPhotos(result.photos)} : {status:'unavailable', error:'Planespotters returned an invalid response'};
  } catch (error) { return {status:'unavailable', error:String(error?.message || 'Photo lookup failed').slice(0,120)}; }
}

async function fetchAirportPage(fetcher, registration, origin, profileFallback, now) {
  let confirmedNotFound = false;
  for (const variant of registrationVariants(registration)) {
    const url = `${AIRCRAFT_PAGE}${encodeURIComponent(variant)}`;
    try {
      const response = await fetcher(url, {headers:headers(origin, 'text/html'), timeout:15_000, signal:AbortSignal.timeout(15_000), redirect:'follow'});
      let html = '';
      if (response.ok) html = (await response.text()).slice(0, 2_000_000);
      else {
        if (response.status === 404) { confirmedNotFound = true; continue; }
        if (response.status === 403 && profileFallback) html = String(await profileFallback(url)).slice(0,2_000_000);
        else return {status:'unavailable', error:`Airport-Data HTTP ${response.status}`};
      }
      const parsed = parseAirportDataHtml(html, registration, url, now);
      if (parsed.status === 'ok') {
        if (registrationCompact(parsed.data.registration) !== registrationCompact(registration)) return {status:'unavailable', error:'Airport-Data registration mismatch'};
        return {...parsed, variant};
      }
      if (parsed.status === 'not-found') { confirmedNotFound = true; continue; }
      return parsed;
    } catch (error) { return {status:'unavailable', error:String(error?.message || 'Airport-Data lookup failed').slice(0,120)}; }
  }
  return confirmedNotFound ? {status:'not-found'} : {status:'unavailable', error:'Airport-Data lookup failed'};
}

async function fetchAirportApi(fetcher, modeSCode, origin, registration) {
  if (!validHex(modeSCode)) return null;
  try {
    const response = await fetcher(`${AIRPORT_DATA_API}?m=${modeSCode}`, {headers:headers(origin, 'application/json'), timeout:15_000, signal:AbortSignal.timeout(15_000), redirect:'follow'});
    if (!response.ok) return null;
    const result = await response.json();
    if (result?.reg && registrationCompact(result.reg) !== registrationCompact(registration)) return null;
    return result?.status === 200 && (result.model || result.cn || result.country) ? result : null;
  } catch { return null; }
}

export async function resolveModeSFromAircraftPage(fetcher, registration, origin, profileFallback) {
  const result = await fetchAirportPage(fetcher, registration, origin, profileFallback, Date.now());
  return result.status === 'ok' ? validHex(result.data?.mode_s_code) : '';
}

export async function enrichAircraftRegistration({registration, cache = {}, fetcher = fetch, now = Date.now(), refreshPhotos = false, force = false, preferCache = false, origin = 'http://127.0.0.1:4317', profileFallback, expectedModels = []}) {
  const normalized = normalizeRegistration(registration);
  if (!normalized) return {cache, aircraft:null, photos:[]};
  const compact = registrationCompact(normalized);
  const existing = findByRegistration(cache, normalized);
  let entry = existing ? {...existing} : {registration:normalized, model:'', constructorNumber:'', country:'', modeSCode:'', sourceUrl:'', updatedAt:'', year:null, photos:[], photosUpdatedAt:0};
  entry.photos = Array.isArray(entry.photos) ? entry.photos : [];
  const photoAttempt = Number(entry.photosAttemptedAt) || 0;
  const lookupAttempt = Number(entry.lookupAttemptedAt) || 0;
  const photosDue = force || refreshPhotos || !entry.photosUpdatedAt || now - entry.photosUpdatedAt > DAY;
  const photosCanRetry = !photoAttempt || now - photoAttempt >= RETRY_DELAY;
  const hasFreshMetadata = Boolean(entry.model) && (entry.resolverVersion === RESOLVER_VERSION || entry.resolverVersion == null) && Number.isFinite(Date.parse(entry.updatedAt)) && now - Date.parse(entry.updatedAt) < 180 * DAY;
  const metadataDue = force || !hasFreshMetadata;
  const needsVersionRefresh = !entry.model && entry.resolverVersion !== RESOLVER_VERSION;
  const metadataCanRetry = !lookupAttempt || now - lookupAttempt >= RETRY_DELAY || needsVersionRefresh;
  const cachedSuccess = Boolean(entry.model || entry.photos.length);
  const cacheHit = preferCache && cachedSuccess && !force && !refreshPhotos;
  const doPhotos = !cacheHit && (force || refreshPhotos || (photosDue && photosCanRetry));
  const doMetadata = !cacheHit && (force || (metadataDue && metadataCanRetry));

  const photoResult = doPhotos ? await fetchPhotos(fetcher, normalized, origin) : null;
  if (photoResult) {
    entry.photosAttemptedAt = now;
    entry.photosStatus = photoResult.status;
    if (photoResult.status === 'ok' || photoResult.status === 'empty') {
      entry.photos = photoResult.photos;
      entry.photosUpdatedAt = now;
      entry.photosError = undefined;
    } else entry.photosError = photoResult.error;
  }

  if (doMetadata) {
    entry.lookupAttemptedAt = now;
    const photoHex = validHex(photoResult?.modeSCode) || modeSFromPhotos(photoResult?.photos ?? []);
    let airportPage = null;
    let modeSCode = photoHex || validHex(entry.modeSCode);
    let metaResult = null;
    let apiAttempted = false;
    if (modeSCode) {
      apiAttempted = true;
      const apiData = await fetchAirportApi(fetcher, modeSCode, origin, normalized);
      if (apiData) metaResult = {status:'ok', data:{registration:apiData.reg || normalized, model:apiData.model, year:apiData.year, cn:apiData.cn, country:apiData.country, mode_s_code:apiData.mode_s_code || modeSCode, link:apiData.link || `https://airport-data.com/aircraft/${normalized}`}};
    }
    if (!metaResult) {
      airportPage = await fetchAirportPage(fetcher, normalized, origin, profileFallback, now);
      if (airportPage?.status === 'ok') {
        metaResult = airportPage;
        modeSCode = modeSCode || validHex(airportPage.data.mode_s_code);
      } else if (airportPage?.status === 'not-found') metaResult = airportPage;
    }
    if ((!metaResult || metaResult.status !== 'ok') && !apiAttempted) {
      modeSCode = modeSCode || validHex(airportPage?.data?.mode_s_code);
      if (modeSCode) {
        const apiData = await fetchAirportApi(fetcher, modeSCode, origin, normalized);
        if (apiData) metaResult = {status:'ok', data:{registration:apiData.reg || normalized, model:apiData.model, year:apiData.year, cn:apiData.cn, country:apiData.country, mode_s_code:apiData.mode_s_code || modeSCode, link:apiData.link || `https://airport-data.com/aircraft/${normalized}`}};
      }
    }
    if (metaResult?.status === 'ok' && metaResult.data?.model) {
      const parsed = cleanAircraft(metaResult.data, normalized, modeSCode, now);
      if (conflictsWithExpected(parsed.model, expectedModels)) {
        const keepPrior = Boolean(entry.model) && !conflictsWithExpected(entry.model, expectedModels);
        entry = {...entry, ...(!keepPrior ? {registration:normalized, model:'', constructorNumber:'', country:'', modeSCode:'', sourceUrl:'', year:null, updatedAt:''} : {}), resolverVersion:RESOLVER_VERSION, lookupStatus:{...(entry.lookupStatus ?? {}), metadata:'conflict', photos:entry.photosStatus || (entry.photos.length ? 'ok':'empty')}, metadataError:'Airport-Data model conflicts with trip aircraft type'};
      } else {
        entry = {...entry, ...parsed, resolverVersion:RESOLVER_VERSION, metadataError:undefined, lookupStatus:{metadata:'ok', photos:entry.photosStatus || (entry.photos.length ? 'ok':'empty')}};
      }
    } else {
      const status = metaResult?.status === 'not-found' ? 'not-found' : 'unavailable';
      entry = {...entry, registration:normalized, ...(entry.model ? {} : {resolverVersion:RESOLVER_VERSION}), modeSCode:modeSCode || entry.modeSCode, lookupStatus:{metadata:status, photos:entry.photosStatus || (entry.photos.length ? 'ok':'empty')}, metadataError:metaResult?.error};
    }
  }
  if (entry.model && conflictsWithExpected(entry.model, expectedModels)) {
    entry = {...entry, model:'', constructorNumber:'', country:'', modeSCode:'', sourceUrl:'', year:null, updatedAt:'', resolverVersion:RESOLVER_VERSION, lookupStatus:{...entry.lookupStatus, metadata:'conflict'}, metadataError:'Cached aircraft model conflicts with trip aircraft type'};
  }
  entry.lookupStatus = {...(entry.lookupStatus ?? {}), metadata:entry.lookupStatus?.metadata || (entry.model ? 'ok' : 'unavailable'), photos:entry.photosStatus || (entry.photos.length ? 'ok' : 'empty')};
  const nextCache = {...cache, [compact]:entry};
  return {cache:nextCache, aircraft:entry, photos:entry.photos};
}
