#!/usr/bin/env node
/**
 * Rebuild the compact, redistributable offline map data from Natural Earth raw GeoJSON.
 * Usage: node mobile/scripts/build-offline-map.mjs
 * Set HTTPS_PROXY / HTTP_PROXY when your network requires a proxy (curl is used for portability).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'offline-map', 'data');
const execFileAsync = promisify(execFile);
const SOURCE_COMMIT = 'ca96624a56bd078437bca8184e78163e5039ad19';
const SOURCE_CACHE = path.join(ROOT, 'toolchain', 'offline-map-source-cache', SOURCE_COMMIT);
const BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${SOURCE_COMMIT}/geojson`;
const SOURCES = {
  countries: ['ne_10m_admin_0_countries.geojson', '10m', 'global'],
  admin: ['ne_10m_admin_1_states_provinces.geojson', '10m', 'global'],
  roads: ['ne_10m_roads.geojson', '10m', 'global'],
  lakes: ['ne_10m_lakes.geojson', '10m', 'global'],
  urban: ['ne_10m_urban_areas.geojson', '10m', 'global'],
  places: ['ne_10m_populated_places.geojson', '10m', 'global'],
};
const EAST_ASIA = [73, 17, 146, 56]; // Used only to choose city-label zoom levels.
const SIZE_LIMIT_BYTES = 100_000_000;
const TOLERANCE = { roads: 0.003, countries: 0.01, admin: 0.01, lakes: 0.01, urban: 0.01 };

async function download(url, layer) {
  const filename = path.join(SOURCE_CACHE, path.basename(new URL(url).pathname));
  let raw;
  try { raw = await readFile(filename); console.log(`Using cached ${layer}…`); }
  catch {
    const args = ['--fail', '--location', '--silent', '--show-error', '--max-time', '300', url];
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxy) args.unshift('--proxy', proxy);
    console.log(`Downloading ${layer}…`);
    const { stdout } = await execFileAsync('curl', args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    raw = Buffer.from(stdout);
    await mkdir(SOURCE_CACHE, { recursive: true });
    await writeFile(filename, raw);
  }
  const result = { json: JSON.parse(raw.toString('utf8')), sha256: createHash('sha256').update(raw).digest('hex') };
  console.log(`Downloaded ${layer} (${(raw.byteLength / 1024 / 1024).toFixed(1)} MiB)`);
  return result;
}

const first = (p, keys) => {
  for (const key of keys) if (p?.[key] != null && String(p[key]).trim()) return String(p[key]).trim();
  return '';
};
function collection(features = []) { return { type: 'FeatureCollection', features }; }
function roundCoordinates(value) {
  if (Array.isArray(value)) {
    if (typeof value[0] === 'number') return value.map((n, i) => i < 2 && Number.isFinite(n) ? Number(n.toFixed(5)) : n);
    return value.map(roundCoordinates);
  }
  return value;
}
function simplifyGeometry(g, tolerance) {
  if (!g) return null;
  const line = pts => simplifyLine(pts, false, tolerance);
  const ring = pts => {
    if (!Array.isArray(pts) || pts.length < 4) return [];
    const simplified = simplifyLine(pts, true, tolerance);
    return roundCoordinates(simplified.length >= 4 ? simplified : pts);
  };
  const polygon = rings => {
    if (!Array.isArray(rings) || !rings.length) return [];
    const exterior = ring(rings[0]);
    if (exterior.length < 4) return [];
    return [exterior, ...rings.slice(1).map(ring).filter(v => v.length >= 4)];
  };
  let geometry;
  switch (g.type) {
    case 'Point': case 'MultiPoint': geometry = g; break;
    case 'LineString': { const c = line(g.coordinates); geometry = c.length >= 2 ? { type: g.type, coordinates: c } : null; break; }
    case 'MultiLineString': { const c = g.coordinates.map(line).filter(v => v.length >= 2); geometry = c.length ? { type: g.type, coordinates: c } : null; break; }
    case 'Polygon': { const c = polygon(g.coordinates); geometry = c.length ? { type: g.type, coordinates: c } : null; break; }
    case 'MultiPolygon': { const c = g.coordinates.map(polygon).filter(poly => poly.length); geometry = c.length ? { type: g.type, coordinates: c } : null; break; }
    default: geometry = null;
  }
  if (geometry) geometry = { ...geometry, coordinates: roundCoordinates(geometry.coordinates) };
  return geometry;
}
function distanceSq(p, q) { return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; }
function pointSegmentDistanceSq(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (!dx && !dy) return distanceSq(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return distanceSq(p, [a[0] + t * dx, a[1] + t * dy]);
}
function simplifyLine(points, closed = false, tolerance = 0.01) {
  if (!Array.isArray(points) || points.length < 3) return points;
  let line = points;
  if (closed && distanceSq(points[0], points.at(-1)) < 1e-12) line = points.slice(0, -1);
  if (line.length < 4) return closed ? [...line, line[0]] : line;
  const keep = new Uint8Array(line.length); keep[0] = 1; keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]], threshold = tolerance ** 2;
  while (stack.length) {
    const [start, end] = stack.pop(); let farthest = threshold, index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = pointSegmentDistanceSq(line[i], line[start], line[end]);
      if (d > farthest) { farthest = d; index = i; }
    }
    if (index !== -1) { keep[index] = 1; stack.push([start, index], [index, end]); }
  }
  const out = line.filter((_, i) => keep[i]);
  if (closed) { out.push(out[0]); }
  return out;
}
function normalizeFeature(feature, kind) {
  const source = feature.properties || {};
  let geometry = simplifyGeometry(feature.geometry, TOLERANCE[kind] ?? 0.01);
  if (!geometry) return null;
  const properties = { name: first(source, ['NAME_ZH', 'name_zh', 'name_zht', 'NAME_ZHT', 'name_zh_tw', 'name_zh_cn']) };
  if (kind === 'countries') {
    const labelLon = Number(source.LABEL_X ?? source.label_x), labelLat = Number(source.LABEL_Y ?? source.label_y);
    properties.labelLon = Number.isFinite(labelLon) ? Number(labelLon.toFixed(5)) : null;
    properties.labelLat = Number.isFinite(labelLat) ? Number(labelLat.toFixed(5)) : null;
  }
  if (kind === 'admin') properties.country = first(source, ['admin', 'ADMIN', 'geonunit']);
  if (kind === 'roads') properties.class = first(source, ['featurecla', 'FEATURECLA', 'type']);
  if (kind === 'urban') properties.areaSqKm = source.area_sqkm ?? null;
  if (kind === 'lakes') properties.lakeId = source.ne_id ?? null;
  return { type: 'Feature', id: feature.id ?? source.ne_id ?? source.NE_ID ?? undefined, properties, geometry };
}

const fetched = Object.fromEntries(await Promise.all(Object.entries(SOURCES).map(async ([key, [file]]) => [key, await download(`${BASE}/${file}`, key)])));
const downloads = Object.fromEntries(Object.entries(fetched).map(([key, value]) => [key, value.json]));
const sourceHashes = Object.fromEntries(Object.entries(fetched).map(([key, value]) => [key, value.sha256]));
const rawPlaces = downloads.places.features;
const cities = new Map();
function addCity(name, lat, lon, minZoom, source) {
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
  const key = `${name}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
  if (!cities.has(key)) cities.set(key, { name, lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), minZoom, _source: source });
}
for (const f of rawPlaces) {
  const p = f.properties || {};
  const nameZh = first(p, ['NAME_ZH', 'name_zh', 'NAME_ZHT', 'name_zht']);
  if (!nameZh) continue;
  const lat = Number(p.LATITUDE), lon = Number(p.LONGITUDE);
  const rank = Number(p.SCALERANK ?? 99);
  const capital = Number(p.ADM0CAP) === 1 || /Admin-0 capital/i.test(p.FEATURECLA || '');
  const eastAsia = lon >= EAST_ASIA[0] && lon <= EAST_ASIA[2] && lat >= EAST_ASIA[1] && lat <= EAST_ASIA[3];
  if (rank <= 10) addCity(nameZh, lat, lon, capital ? 3 : eastAsia ? 5 : 4, 'Natural Earth 10m populated places');
}
// Natural Earth 10m populated-places can omit/substitute Chinese city names; these are explicit
// representative city coordinates, entered from the published Chinese administrative capitals list.
const MANUAL_CITIES = [
  ['北京',39.9042,116.4074],['天津',39.0842,117.2010],['石家庄',38.0428,114.5149],['太原',37.8706,112.5489],
  ['呼和浩特',40.8426,111.7492],['沈阳',41.8057,123.4315],['长春',43.8171,125.3235],['哈尔滨',45.8038,126.5349],
  ['上海',31.2304,121.4737],['南京',32.0603,118.7969],['杭州',30.2741,120.1551],['合肥',31.8206,117.2272],
  ['福州',26.0745,119.2965],['南昌',28.6820,115.8579],['济南',36.6512,117.1201],['郑州',34.7466,113.6254],
  ['武汉',30.5928,114.3055],['长沙',28.2282,112.9388],['广州',23.1291,113.2644],['南宁',22.8170,108.3665],
  ['海口',20.0440,110.1999],['重庆',29.5630,106.5516],['成都',30.5728,104.0668],['贵阳',26.6470,106.6302],
  ['昆明',25.0389,102.7183],['拉萨',29.6520,91.1721],['西安',34.3416,108.9398],['兰州',36.0611,103.8343],
  ['西宁',36.6171,101.7782],['银川',38.4872,106.2309],['乌鲁木齐',43.8256,87.6168],
  ['香港',22.3193,114.1694],['澳门',22.1987,113.5439],['台北',25.0330,121.5654],
];
for (const [name, lat, lon] of MANUAL_CITIES) {
  for (const [key, city] of cities) if (city.name === name) cities.delete(key);
  addCity(name, lat, lon, 4, 'Manual representative administrative-capital coordinates; approximate city-center points');
}
const output = {
  countries: collection(downloads.countries.features.map(f => normalizeFeature(f, 'countries')).filter(Boolean)),
  admin: collection(downloads.admin.features.map(f => normalizeFeature(f, 'admin')).filter(Boolean)),
  roads: collection(downloads.roads.features.map(f => normalizeFeature(f, 'roads')).filter(Boolean)),
  lakes: collection(downloads.lakes.features.map(f => normalizeFeature(f, 'lakes')).filter(Boolean)),
  urban: collection(downloads.urban.features.map(f => normalizeFeature(f, 'urban')).filter(Boolean)),
  cities: [...cities.values()].map(({ _source, ...city }) => city).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans')),
};
const counts = Object.fromEntries(Object.entries(output).map(([key, value]) => [key, key === 'cities' ? value.length : value.features.length]));
const basemapText = JSON.stringify(output);
const basemapBytes = Buffer.byteLength(basemapText);
const gzipBytes = gzipSync(basemapText, { level: 9 }).byteLength;
console.log(`Candidate basemap: ${basemapBytes.toLocaleString()} JSON bytes; ${gzipBytes.toLocaleString()} gzip bytes`);
console.log(`Feature counts: ${JSON.stringify(counts)}`);
if (basemapBytes >= SIZE_LIMIT_BYTES) throw new Error(`Candidate JSON is ${basemapBytes} bytes (limit ${SIZE_LIMIT_BYTES}); existing basemap and manifest were not changed.`);
const manifest = {
  title: 'Trip Manager redistributable offline basemap',
  generatedAt: new Date().toISOString(),
  sourceCommit: SOURCE_COMMIT,
  sourceSha256: sourceHashes,
  license: 'Public domain; Natural Earth data is in the public domain. No attribution is legally required; source attribution is retained here for provenance.',
  sources: Object.fromEntries(Object.entries(SOURCES).map(([key, [file, scale, coverage]]) => [key, { url: `${BASE}/${file}`, authorRepository: 'https://github.com/nvkelso/natural-earth-vector', scale, coverage }])),
  manualCityCoordinates: { count: MANUAL_CITIES.length, nature: 'Hand-entered representative city-center coordinates for mainland China provincial capitals, provincial-level municipalities and Hong Kong, Macao and Taiwan. Approximate display points, not authoritative survey coordinates.', source: 'Administrative-capital names from the corresponding Chinese regional governments and common map gazetteers; coordinates are manually selected city-center coordinates, not Natural Earth measurements.' },
  processing: { coverage: 'global', coordinateDecimalPlaces: 5, simplificationToleranceDegrees: TOLERANCE, note: 'Global geometry simplified for small offline overview maps. Does not represent cadastral, navigation or surveying accuracy.' },
  featureCounts: counts,
  dataBytes: { json: basemapBytes, gzip: gzipBytes },
  dataFile: 'basemap.json',
};
await mkdir(DATA, { recursive: true });
await writeFile(path.join(DATA, 'basemap.json'), basemapText);
await writeFile(path.join(DATA, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${path.join(DATA, 'basemap.json')}; ${JSON.stringify(counts)}`);
