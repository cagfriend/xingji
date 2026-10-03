import http from 'node:http';
import {readFile, writeFile, rename, mkdir, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validateTrip, findDuplicates, extractionPrompt, parseModelResponse, localExtract, registrationCompact} from './lib.mjs';
import {createAirportDirectory,canonicalizeAirportTrips,enrichAirportTrips} from './airport-directory.mjs';
import {normalizeAircraftType} from './dist/aviation.js';
import {enrichAircraftRegistration} from './aircraft-data.mjs';
import {windowsAircraftProfile} from './aircraft-windows.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaults = {endpoint: '', apiKey: '', model: '', temperature: 0};
class RequestError extends Error { constructor(message, status = 400, details = {}) { super(message); this.status = status; this.details = details; } }
function checkedTrip(input) { try { const trip=validateTrip(input); if(trip.type==='flight')trip.aircraftType=normalizeAircraftType(trip.aircraftType); return trip; } catch(e) { throw new RequestError(e.message); } }
export async function createApp({dataDir = path.join(root, 'data'), upstreamFetch = fetch, aircraftFetch = fetch, lookupAircraft = true} = {}) {
  await mkdir(dataDir, {recursive: true});
  let airportDirectory=null;
  try { airportDirectory=createAirportDirectory(JSON.parse(await readFile(path.join(root,'dist','map-data','places.json'),'utf8'))); } catch {/* Recognition still works if the bundled directory is unavailable. */}
  async function readJSON(name, fallback) {
    try {
      const value = JSON.parse(await readFile(path.join(dataDir, name), 'utf8'));
      if (name === 'trips.json' && (!Array.isArray(value) || value.some(t => !t || typeof t !== 'object' || typeof t.id !== 'string'))) throw new Error('invalid storage');
      if (name === 'config.json' && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('invalid config');
      return value;
    }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw new RequestError(`${name} 文件损坏或无法读取。请检查 data 文件夹，原文件未被覆盖。`, 500); }
  }
  async function writeJSON(name, value) {
    const target = path.join(dataDir, name);
    try { await copyFile(target, `${target}.bak`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const temp = `${target}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await rename(temp, target);
  }
  async function lookupAndCacheAircraft(registration, {refreshPhotos = false, origin = 'http://127.0.0.1:4317'} = {}) {
    const cache = await readJSON('aircraft-cache.json', {});
    const result = await enrichAircraftRegistration({registration, cache, fetcher:aircraftFetch, refreshPhotos, origin, profileFallback:aircraftFetch === fetch ? windowsAircraftProfile : undefined});
    if (!result.aircraft) return result;
    await serial(async () => {
      const latest = await readJSON('aircraft-cache.json', {});
      await writeJSON('aircraft-cache.json', {...latest, [registrationCompact(registration)]:result.aircraft});
    });
    return result;
  }
  const storedTrips=await readJSON('trips.json',[]);
  const formalizedTrips=storedTrips.filter(trip=>trip?.type==='flight').map(trip=>({...trip,aircraftType:normalizeAircraftType(trip.aircraftType)}));
  if(formalizedTrips.length!==storedTrips.length || formalizedTrips.some((trip,index)=>trip.aircraftType!==storedTrips[index].aircraftType))await writeJSON('trips.json',formalizedTrips);
  let queue = Promise.resolve();
  function serial(task) { const next = queue.then(task, task); queue = next.catch(() => {}); return next; }
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 35 * 1024 * 1024) throw new RequestError('输入超过 35 MB，请减少或压缩图片', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RequestError('请求内容不是有效 JSON'); }
  }
  function send(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
  return http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new RequestError('仅允许本机访问', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new RequestError('不允许跨站访问本地数据', 403);
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (route.startsWith('/api/') && req.method !== 'GET' && req.headers['x-trip-local'] !== '1') throw new RequestError('无效的本地请求', 403);
      if (route === '/api/trips' && req.method === 'GET') {
        const trips=(await readJSON('trips.json', [])).filter(trip=>trip.type==='flight');
        return send(res, 200, {trips: canonicalizeAirportTrips(trips,airportDirectory)});
      }
      const aircraftMatch = route.match(/^\/api\/aircraft\/([^/]+)$/);
      if (aircraftMatch && req.method === 'GET') {
        let registration;
        try { registration = decodeURIComponent(aircraftMatch[1]); } catch { throw new RequestError('注册号格式不正确'); }
        if (registration.length > 24 || !registrationCompact(registration)) throw new RequestError('注册号格式不正确');
        const result = await lookupAndCacheAircraft(registration, {origin:`http://${host}`});
        return send(res, 200, {aircraft:result.aircraft, photos:result.photos, registration:result.aircraft?.registration ?? registration});
      }
      if (route === '/api/places' && req.method === 'GET') return send(res, 200, {places: await readJSON('places.json', {})});
      if (route === '/api/places' && req.method === 'PUT') {
        const input = await body(req);
        if (input.confirmed !== true || typeof input.key !== 'string' || !/^flight\|.{1,200}$/.test(input.key)) throw new RequestError('请确认正确的机场');
        if (typeof input.lat !== 'number' || typeof input.lon !== 'number' || !Number.isFinite(input.lat) || !Number.isFinite(input.lon) || Math.abs(input.lat) > 90 || Math.abs(input.lon) > 180) throw new RequestError('经纬度范围不正确');
        return await serial(async () => {const places=await readJSON('places.json',{});places[input.key]={lat:input.lat,lon:input.lon};await writeJSON('places.json',places);send(res,200,{ok:true});});
      }
      if (route === '/api/config' && req.method === 'GET') return send(res, 200, {...defaults, ...await readJSON('config.json', {})});
      if (route === '/api/config' && req.method === 'PUT') {
        const input = await body(req);
        const config = {};
        for (const key of ['endpoint','apiKey','model']) { if (typeof input[key] !== 'string' || input[key].length > 5000) throw new RequestError('配置字段不正确'); config[key] = input[key].trim(); }
        if (config.endpoint) {
          let u; try { u = new URL(config.endpoint); } catch { throw new RequestError('API 地址不正确'); }
          if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new RequestError('请输入无查询参数的 HTTP(S) API 地址');
        }
        await serial(() => writeJSON('config.json', {...config, temperature:0}));
        return send(res, 200, {ok:true});
      }
      if (route === '/api/recognize' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.text !== 'string' || input.text.length > 30000) throw new RequestError('文字过长或格式不正确');
        const images = input.images ?? [];
        if (!Array.isArray(images) || images.length > 5 || images.some(x => typeof x !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(x) || x.length > 12 * 1024 * 1024)) throw new RequestError('最多 5 张 PNG、JPEG、WebP 图片，每张不超过 8 MB');
        if (!input.text.trim() && !images.length) throw new RequestError('请先输入文字或添加图片');
        if (input.mode === 'local') {
          if (images.length) throw new RequestError('本地规则无法识别图片，请配置支持视觉的 AI API');
          return send(res, 200, {...localExtract(input.text), source:'local'});
        }
        const config = {...defaults, ...await readJSON('config.json', {})};
        if (!config.endpoint || !config.model) throw new RequestError('请先在 API 设置中填写接口地址和模型名称');
        const endpoint = config.endpoint.replace(/\/+$/, '');
        const apiURL = endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;
        const content = [{type:'text',text:input.text || '请提取图片中的行程'}];
        for (const image of images) content.push({type:'image_url',image_url:{url:image}});
        let response;
        try {
          const referenceDate = typeof input.referenceDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.referenceDate) ? input.referenceDate : new Intl.DateTimeFormat('en-CA').format(new Date());
          const dateContext = `\n用户本机参考日期是 ${referenceDate}。明确的“今天、明天、下周”等相对日期可据此解析；有歧义的日期仍需警告，不要猜测。`;
          response = await upstreamFetch(apiURL, {method:'POST', redirect:'error', headers:{'Content-Type':'application/json', ...(config.apiKey ? {Authorization:`Bearer ${config.apiKey}`} : {})}, body: JSON.stringify({model:config.model, temperature:0, messages:[{role:'system',content:extractionPrompt + dateContext},{role:'user',content}]}), signal:AbortSignal.timeout(90000)});
        } catch { throw new RequestError('无法连接 API 或请求超时，请检查地址、网络与模型', 502); }
        if (!response.ok) throw new RequestError(`API 请求失败（HTTP ${response.status}）。请检查密钥、模型以及图片识别支持。`, 502);
        let result;
        try { const value = await response.json(); result = enrichAirportTrips(parseModelResponse(value.choices?.[0]?.message?.content),airportDirectory); }
        catch (e) { throw new RequestError(e.message || '无法读取 API 返回结果', 502); }
        const current = await readJSON('trips.json', []);
        return send(res, 200, {...result, source:'ai', duplicates:findDuplicates(result.trips, current)});
      }
      if (route === '/api/trips/check' && req.method === 'POST') {
        const input = await body(req);
        if (!Array.isArray(input.trips) || input.trips.length > 30) throw new RequestError('行程数组不正确');
        return send(res, 200, {duplicates: findDuplicates(input.trips.map(checkedTrip), await readJSON('trips.json', []), input.exceptId ?? '')});
      }
      if (route === '/api/trips' && req.method === 'POST') {
        const input = await body(req);
        if (input.confirmed !== true) throw new RequestError('必须先确认行程后再保存');
        if (!Array.isArray(input.trips) || !input.trips.length || input.trips.length > 30) throw new RequestError('请确认 1 至 30 条行程');
        const items = input.trips.map(checkedTrip);
        return await serial(async () => {
          const existing = await readJSON('trips.json', []);
          const duplicates = findDuplicates(items, existing);
          if (duplicates.length) throw new RequestError('有重复航班，请移除重复项或修改航班号与日期', 409, {duplicates});
          const now = new Date().toISOString();
          const saved = items.map(t => ({...t, id:randomUUID(), createdAt:now, updatedAt:now}));
          await writeJSON('trips.json', [...existing, ...saved]);
          send(res, 201, {trips:saved});
          if (lookupAircraft) {
            const registrations = [...new Set(saved.map(t => t.registration).filter(Boolean).map(registrationCompact))];
            for (const compact of registrations) {
              const registration = saved.find(t => registrationCompact(t.registration) === compact)?.registration;
              if (registration) void lookupAndCacheAircraft(registration, {origin:`http://${host}`}).catch(() => {});
            }
          }
        });
      }
      const match = route.match(/^\/api\/trips\/([\w-]+)$/);
      if (match && ['PUT','DELETE'].includes(req.method)) {
        const input = await body(req);
        if (input.confirmed !== true) throw new RequestError('请先确认操作');
        return await serial(async () => {
          const existing = await readJSON('trips.json', []);
          const index = existing.findIndex(x => x.id === match[1]);
          if (index < 0) throw new RequestError('行程不存在', 404);
          if (req.method === 'DELETE') existing.splice(index, 1);
          else {
            const updated = checkedTrip(input.trip);
            const duplicates = findDuplicates([updated], existing, match[1]);
            if (duplicates.length) throw new RequestError('修改后与已有行程重复', 409, {duplicates});
            existing[index] = {...updated, id:match[1], createdAt:existing[index].createdAt, updatedAt:new Date().toISOString()};
          }
          await writeJSON('trips.json', existing);
          send(res, 200, {ok:true});
        });
      }
      const assets = {'/':'index.html','/index.html':'index.html','/stats.html':'stats.html','/app.js':'app.js','/stats.js':'stats.js','/aviation.js':'aviation.js','/map.js':'map.js','/map-geo.js':'map-geo.js','/tile-cache-sw.js':'tile-cache-sw.js','/map-data/places.json':'map-data/places.json','/vendor/leaflet.js':'vendor/leaflet.js','/vendor/leaflet.css':'vendor/leaflet.css','/style.css':'style.css','/aircraft.css':'aircraft.css','/favicon.svg':'favicon.svg'};
      const airlineAsset=route.match(/^\/airlines\/([A-Z0-9]{2})\.(svg|png)$/);
      const file = assets[route] ?? (airlineAsset?`airlines/${airlineAsset[1]}.${airlineAsset[2]}`:null);
      if (req.method === 'GET' && file) {
        const data = await readFile(path.join(root, 'dist', file));
        res.writeHead(200, {'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.json') ? 'application/json; charset=utf-8' : file.endsWith('.png') ? 'image/png' : 'image/svg+xml', 'Cache-Control':file.includes('/vendor/')?'public, max-age=31536000, immutable':'no-store', 'X-Content-Type-Options':'nosniff', 'Content-Security-Policy':"default-src 'self'; img-src 'self' data: blob: https:; style-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' https://tile.openstreetmap.org; base-uri 'none'; frame-ancestors 'none'"});
        return res.end(data);
      }
      throw new RequestError('未找到内容', 404);
    } catch (e) { if (!res.headersSent) send(res, e.status ?? 500, {error:e.status ? e.message : '本地读写失败，请检查项目文件夹权限', ...(e.details ?? {})}); else res.end(); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.TRIP_PORT || 4317);
  const server = await createApp();
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请关闭旧窗口或设置 TRIP_PORT。` : e.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`行迹已启动：http://127.0.0.1:${port}`));
}
