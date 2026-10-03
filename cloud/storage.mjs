import {duplicateKey, findDuplicates} from '../lib.mjs';
import {validateTrip} from '../lib.mjs';
import {normalizeAircraftType} from '../dist/aviation.js';

const JSON_KEYS = new Set(['config.json', 'places.json', 'aircraft-cache.json']);
const ENTRY_KEYS = new Set(['places.json', 'aircraft-cache.json']);
const MAX_IMPORT_TRIPS = 1000;

export class StorageConflictError extends Error {
  constructor(message, duplicates = []) {
    super(message);
    this.status = 409;
    this.details = {duplicates};
  }
}

export class StorageValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function normalizeTrip(input, {allowMissingId = false} = {}) {
  let fields;
  try {
    fields = validateTrip(input);
    fields.aircraftType = normalizeAircraftType(fields.aircraftType);
  } catch (error) { throw new StorageValidationError(error.message); }
  const id = input.id ?? (allowMissingId ? globalThis.crypto.randomUUID() : '');
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) throw new StorageValidationError('航班编号格式不正确');
  const now = new Date().toISOString();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;
    if (typeof createdAt !== 'string' || createdAt.length > 100 || typeof updatedAt !== 'string' || updatedAt.length > 100) {
    throw new StorageValidationError('行程时间戳格式不正确');
  }
  const trip = {...fields, id, createdAt, updatedAt};
  return {trip, key: duplicateKey(trip)};
}

function validateImportedPlaces(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageValidationError('机场位置缓存格式不正确');
  const output = {};
  for (const [key, point] of Object.entries(value)) {
    if (!/^flight\|[\p{L}\p{N}]{1,200}$/u.test(key) || !point || typeof point !== 'object' || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
      throw new StorageValidationError('机场位置缓存包含无效坐标');
    }
    output[key] = {lat: point.lat, lon: point.lon};
  }
  return output;
}

function trustedHttps(value, hosts) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hosts.has(url.hostname.toLowerCase()) ? url.href : '';
  } catch { return ''; }
}

const PHOTO_HOSTS = new Set(['t.plnspttrs.net', 'cdn.planespotters.net', 'www.planespotters.net', 'planespotters.net']);

function validateImportedAircraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageValidationError('飞机资料缓存格式不正确');
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Z0-9]{2,24}$/i.test(key) || !item || typeof item !== 'object' || Array.isArray(item)) throw new StorageValidationError('飞机资料缓存格式不正确');
    const registration = typeof item.registration === 'string' ? item.registration.slice(0, 24) : '';
    const photos = Array.isArray(item.photos) ? item.photos.slice(0, 3).map(photo => ({
      image: trustedHttps(photo?.image, PHOTO_HOSTS),
      link: trustedHttps(photo?.link, new Set(['www.planespotters.net'])),
      photographer: typeof photo?.photographer === 'string' ? photo.photographer.slice(0, 160) : '',
      modeSCode: typeof photo?.modeSCode === 'string' && /^[0-9A-F]{6}$/i.test(photo.modeSCode) ? photo.modeSCode.toUpperCase() : ''
    })).filter(photo => photo.image && photo.link) : [];
    output[key.toUpperCase()] = {
      registration,
      model: typeof item.model === 'string' ? item.model.slice(0, 160) : '',
      constructorNumber: typeof item.constructorNumber === 'string' ? item.constructorNumber.slice(0, 40) : '',
      country: typeof item.country === 'string' ? item.country.slice(0, 80) : '',
      modeSCode: typeof item.modeSCode === 'string' && /^[0-9A-F]{6}$/i.test(item.modeSCode) ? item.modeSCode.toUpperCase() : '',
      sourceUrl: trustedHttps(item.sourceUrl, new Set(['airport-data.com', 'www.airport-data.com'])),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt.slice(0, 100) : '',
      photos,
      photosUpdatedAt: Number.isFinite(item.photosUpdatedAt) ? item.photosUpdatedAt : 0,
      lookupAttemptedAt: Number.isFinite(item.lookupAttemptedAt) ? item.lookupAttemptedAt : 0
    };
  }
  return output;
}

function validateImportedConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StorageValidationError('应用配置格式不正确');
  const config = {};
  for (const key of ['endpoint', 'model']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 5000) throw new StorageValidationError('应用配置格式不正确');
      config[key] = value[key];
    }
  }
  if (value.temperature !== undefined && (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) throw new StorageValidationError('应用配置格式不正确');
  if (value.temperature !== undefined) config.temperature = value.temperature;
  return config;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function entriesFor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('机场或飞机缓存必须为对象');
  return Object.entries(value).map(([key, item]) => ({key, value: JSON.stringify(item)}));
}

/** Adapts Cloudflare D1 to the storage operations used by the app. */
export function createStorage(db) {
  if (!db?.prepare || !db?.batch) throw new TypeError('需要 Cloudflare D1 database binding');

  async function listTrips() {
    const result = await db.prepare('SELECT payload FROM trips ORDER BY created_at, id').all();
    return (result.results ?? []).map(row => JSON.parse(row.payload));
  }

  async function readJSON(name, fallback) {
    if (!JSON_KEYS.has(name)) throw new TypeError(`不支持的 JSON 存储项：${name}`);
    if (ENTRY_KEYS.has(name)) {
      const result = await db.prepare('SELECT item_key, value FROM app_json_entries WHERE name = ?').bind(name).all();
      if (!(result.results ?? []).length) return structuredClone(fallback);
      return Object.fromEntries(result.results.map(row => [row.item_key, JSON.parse(row.value)]));
    }
    const row = await db.prepare('SELECT value FROM app_json WHERE key = ?').bind(name).first();
    return row ? JSON.parse(row.value) : structuredClone(fallback);
  }

  async function writeJSON(name, value) {
    if (!JSON_KEYS.has(name)) throw new TypeError(`不支持的 JSON 存储项：${name}`);
    if (ENTRY_KEYS.has(name)) {
      value = name === 'places.json' ? validateImportedPlaces(value) : validateImportedAircraft(value);
      const items = entriesFor(value);
      await db.batch([
        db.prepare('DELETE FROM app_json_entries WHERE name = ?').bind(name),
        db.prepare("INSERT INTO app_json_entries (name, item_key, value) SELECT ?, json_extract(value, '$.key'), json_extract(value, '$.value') FROM json_each(?)")
          .bind(name, JSON.stringify(items))
      ]);
      return;
    }
    if (name === 'config.json') value = validateImportedConfig(value);
    await db.prepare('INSERT INTO app_json (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(name, JSON.stringify(value)).run();
  }

  async function writeEntry(name, key, value) {
    if (!ENTRY_KEYS.has(name) || typeof key !== 'string' || !key) throw new TypeError('不支持的独立存储项');
    if (name === 'places.json') value = validateImportedPlaces({[key]: value})[key];
    else value = validateImportedAircraft({[key]: value})[key.toUpperCase()];
    await db.prepare('INSERT INTO app_json_entries (name, item_key, value) VALUES (?, ?, ?) ON CONFLICT(name, item_key) DO UPDATE SET value = excluded.value')
      .bind(name, key, JSON.stringify(value)).run();
  }

  async function addTrips(items) {
    if (!Array.isArray(items) || !items.length) return [];
    if (items.length > MAX_IMPORT_TRIPS) throw new TypeError(`一次最多写入 ${MAX_IMPORT_TRIPS} 条航班`);
    const normalized = items.map(item => normalizeTrip(item, {allowMissingId: true}));
    const savedTrips = normalized.map(item => item.trip);
    const existing = await listTrips();
    const duplicates = findDuplicates(savedTrips, existing);
    if (duplicates.length) throw new StorageConflictError('存在重复航班', duplicates);
    const internalDuplicates = findDuplicates(savedTrips, []);
    if (internalDuplicates.length) throw new StorageConflictError('一次提交中有重复航班', internalDuplicates);
    const rows = savedTrips.map((trip, index) => ({...trip, duplicateKey: normalized[index].key}));
    try {
      await db.prepare("INSERT INTO trips (id, duplicate_key, created_at, updated_at, payload) SELECT json_extract(value, '$.id'), json_extract(value, '$.duplicateKey'), json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt'), json_remove(value, '$.duplicateKey') FROM json_each(?)")
        .bind(JSON.stringify(rows)).run();
    } catch (error) {
      const latest = await listTrips();
      const raced = findDuplicates(savedTrips, latest);
      if (raced.length) throw new StorageConflictError('存在重复航班', raced);
      if (savedTrips.some(trip => latest.some(item => item.id === trip.id))) throw new StorageConflictError('航班编号已存在');
      throw error;
    }
    return savedTrips;
  }

  async function updateTrip(id, trip) {
    const normalized = normalizeTrip({...trip, id});
    trip = normalized.trip;
    const key = normalized.key;
    const existing = await listTrips();
    const old = existing.find(item => item.id === id);
    if (!old) {
      const error = new Error('行程不存在');
      error.status = 404;
      throw error;
    }
    const duplicates = findDuplicates([trip], existing, id);
    if (duplicates.length) throw new StorageConflictError('修改后与已有行程重复', duplicates);
    const updated = {...trip, id, createdAt: old.createdAt, updatedAt: new Date().toISOString()};
    try {
      await db.prepare('UPDATE trips SET duplicate_key = ?, updated_at = ?, payload = ? WHERE id = ?')
        .bind(key, updated.updatedAt, JSON.stringify(updated), id).run();
    } catch (error) {
      const latest = await listTrips();
      const raced = findDuplicates([trip], latest, id);
      if (raced.length) throw new StorageConflictError('修改后与已有行程重复', raced);
      throw error;
    }
    return updated;
  }

  async function deleteTrip(id) {
    const result = await db.prepare('DELETE FROM trips WHERE id = ?').bind(id).run();
    return (result.meta?.changes ?? 0) > 0;
  }

  async function exportSnapshot() {
    // D1 batch executes its reads in a transaction, keeping a single consistent export view.
    const results = await db.batch([
      db.prepare('SELECT payload FROM trips ORDER BY created_at, id'),
      db.prepare('SELECT item_key, value FROM app_json_entries WHERE name = ?').bind('places.json'),
      db.prepare('SELECT item_key, value FROM app_json_entries WHERE name = ?').bind('aircraft-cache.json'),
      db.prepare('SELECT value FROM app_json WHERE key = ?').bind('config.json')
    ]);
    const asObject = result => Object.fromEntries((result.results ?? []).map(row => [row.item_key, JSON.parse(row.value)]));
    const configRow = results[3]?.results?.[0];
    const config = configRow ? validateImportedConfig(JSON.parse(configRow.value)) : {};
    return {
      version: 1,
      trips: (results[0]?.results ?? []).map(row => JSON.parse(row.payload)),
      places: asObject(results[1]),
      aircraftCache: asObject(results[2]),
      config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'apiKey'))
    };
  }

  async function importSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.trips) || snapshot.trips.length > MAX_IMPORT_TRIPS) {
      throw new StorageValidationError('迁移快照格式不正确');
    }
    const incoming = snapshot.trips;
    const incomingIds = new Set();
    const normalizedIncoming = incoming.map(trip => normalizeTrip(trip).trip);
    for (const trip of normalizedIncoming) {
      if (incomingIds.has(trip.id)) throw new StorageConflictError('迁移快照中存在重复行程编号');
      incomingIds.add(trip.id);
    }
    const existing = await listTrips();
    const byId = new Map(existing.map(item => [item.id, item]));
    const exactExisting = [];
    const toInsert = [];
    for (const trip of normalizedIncoming) {
      const sameId = byId.get(trip.id);
      if (sameId) {
        if (stableStringify(sameId) === stableStringify(trip)) { exactExisting.push(trip); continue; }
        throw new StorageConflictError('迁移快照与已有行程编号冲突');
      }
      toInsert.push(trip);
    }
    const duplicates = findDuplicates(toInsert, existing);
    if (duplicates.length) throw new StorageConflictError('迁移快照与已有航班重复', duplicates);
    const duplicatesWithin = findDuplicates(toInsert, []);
    if (duplicatesWithin.length) throw new StorageConflictError('迁移快照中有重复航班', duplicatesWithin);

    const statements = [];
    if (toInsert.length) {
      const rows = toInsert.map(trip => ({...trip, duplicateKey: duplicateKey(trip)}));
      statements.push(db.prepare("INSERT INTO trips (id, duplicate_key, created_at, updated_at, payload) SELECT json_extract(value, '$.id'), json_extract(value, '$.duplicateKey'), json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt'), json_remove(value, '$.duplicateKey') FROM json_each(?)")
        .bind(JSON.stringify(rows)));
    }
    const imports = [
      ['places.json', 'places'],
      ['aircraft-cache.json', 'aircraftCache']
    ];
    for (const [name, field] of imports) {
      if (!(field in snapshot)) continue;
      const safeValue = name === 'places.json' ? validateImportedPlaces(snapshot[field]) : validateImportedAircraft(snapshot[field]);
      const incomingEntries = entriesFor(safeValue);
      if (incomingEntries.length) statements.push(db.prepare("INSERT OR IGNORE INTO app_json_entries (name, item_key, value) SELECT ?, json_extract(value, '$.key'), json_extract(value, '$.value') FROM json_each(?)")
        .bind(name, JSON.stringify(incomingEntries)));
    }
    if (snapshot.config && typeof snapshot.config === 'object' && !Array.isArray(snapshot.config)) {
      const config = validateImportedConfig(snapshot.config);
      statements.push(db.prepare('INSERT INTO app_json (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').bind('config.json', JSON.stringify(config)));
    }
    try { if (statements.length) await db.batch(statements); }
    catch (error) {
      const latest = await listTrips();
      const raced = findDuplicates(toInsert, latest);
      if (raced.length) throw new StorageConflictError('迁移快照与已有航班重复', raced);
      if (toInsert.some(trip => latest.some(item => item.id === trip.id))) throw new StorageConflictError('迁移快照与已有行程编号冲突');
      throw error;
    }
    return {importedTrips: toInsert.length, alreadyPresent: exactExisting.length};
  }

  async function saveBackup(snapshot, now = new Date()) {
    const date = now.toISOString().slice(0, 10);
    const serialized = JSON.stringify(snapshot);
    await db.batch([
      db.prepare('INSERT INTO snapshots (snapshot_date, payload) VALUES (?, ?) ON CONFLICT(snapshot_date) DO UPDATE SET payload = excluded.payload').bind(date, serialized),
      db.prepare('DELETE FROM snapshots WHERE snapshot_date NOT IN (SELECT snapshot_date FROM snapshots ORDER BY snapshot_date DESC LIMIT 7)')
    ]);
    return date;
  }

  async function listBackups() {
    const result = await db.prepare('SELECT snapshot_date FROM snapshots ORDER BY snapshot_date DESC').all();
    return (result.results ?? []).map(row => row.snapshot_date);
  }

  async function readBackup(id) {
    const row = await db.prepare('SELECT payload FROM snapshots WHERE snapshot_date = ?').bind(id).first();
    return row ? JSON.parse(row.payload) : null;
  }

  return {readJSON, writeJSON, writeEntry, listTrips, addTrips, updateTrip, deleteTrip, exportSnapshot, importSnapshot, saveBackup, listBackups, readBackup};
}
