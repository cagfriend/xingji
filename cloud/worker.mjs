import {validateTrip, findDuplicates, extractionPrompt, parseModelResponse, localExtract, registrationCompact} from '../lib.mjs';
import {createAirportDirectory, canonicalizeAirportTrips, enrichAirportTrips} from '../airport-directory.mjs';
import {normalizeAircraftType} from '../dist/aviation.js';
import {enrichAircraftRegistration} from '../aircraft-data.mjs';
import catalog from '../dist/map-data/places.json' with {type:'json'};
import {createStorage} from './storage.mjs';
import {authorizeRequest, verifyMutationRequest} from './auth.mjs';
import {handlePasswordAuth, authorizePasswordRequest} from './password-auth.mjs';

const directory = createAirportDirectory(catalog);
const defaults = {endpoint:'https://api.deepseek.com', model:'deepseek-flash', temperature:0};
const MAX_BODY = 12 * 1024 * 1024;
const CSP = "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self' https://tile.openstreetmap.org; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
class RequestError extends Error {
  constructor(message, status=400, details={}) { super(message); this.status=status; this.details=details; }
}
function json(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'private, no-store', ...extra}});
}
function secure(response) {
  const result = new Response(response.body, response);
  result.headers.set('X-Content-Type-Options','nosniff');
  // OSM requires an identifying Referer. Cross-origin requests share only the
  // site origin, never a private path/query; HTTPS downgrades still send none.
  result.headers.set('Referrer-Policy','strict-origin-when-cross-origin');
  result.headers.set('Content-Security-Policy',CSP);
  result.headers.set('Cache-Control','private, no-store');
  result.headers.set('X-Frame-Options','DENY');
  return result;
}
async function body(request) {
  if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) throw new RequestError('请提交 JSON 数据',415);
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) throw new RequestError('在线版请求总量超过 12 MB，请减少图片或压缩后重试',413);
  if (!request.body) throw new RequestError('缺少请求内容');
  const reader=request.body.getReader(), chunks=[];
  let size=0;
  for (;;) {
    const {done,value}=await reader.read();
    if (done) break;
    size+=value.byteLength;
    if (size>MAX_BODY) { await reader.cancel(); throw new RequestError('在线版请求总量超过 12 MB，请减少图片或压缩后重试',413); }
    chunks.push(value);
  }
  const data=new Uint8Array(size); let offset=0;
  for (const chunk of chunks) { data.set(chunk,offset); offset+=chunk.byteLength; }
  try {
    const value=JSON.parse(new TextDecoder().decode(data));
    if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new RequestError('请求内容不是有效 JSON 对象'); }
}
function checkedTrip(input) {
  try { const trip=validateTrip(input); trip.aircraftType=normalizeAircraftType(trip.aircraftType); return trip; }
  catch(e) { throw new RequestError(e.message); }
}
export function publicConfig(input={}) {
  const config={...defaults};
  for (const key of ['endpoint','model']) {
    if (input[key]!==undefined) {
      if (typeof input[key]!=='string' || input[key].length>5000) throw new RequestError('配置字段不正确');
      config[key]=input[key].trim();
    }
  }
  if (config.endpoint) {
    let url; try { url=new URL(config.endpoint); } catch { throw new RequestError('API 地址不正确'); }
    if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || /^(localhost|\[)/i.test(url.hostname) || /\.(local|localhost|internal)$/i.test(url.hostname)) throw new RequestError('在线版 API 地址必须是公网 HTTPS 域名，不能使用 IP 或本地域名');
  }
  return config;
}
function configured(env,stored) {
  return publicConfig({...stored, ...(env.AI_ENDPOINT ? {endpoint:env.AI_ENDPOINT}:{}), ...(env.AI_MODEL ? {model:env.AI_MODEL}:{})});
}
function assertConfirmed(input) { if (input.confirmed!==true) throw new RequestError('必须先确认操作'); }

// Dependencies are injected only by tests, never by request data or deployed environment flags.
export function createWorker({fetcher=fetch, authorize=authorizeRequest}={}) {
  async function lookup(storage,registration,origin) {
    const cache=await storage.readJSON('aircraft-cache.json',{});
    const result=await enrichAircraftRegistration({registration,cache,fetcher,origin});
    if (result.aircraft) await storage.writeEntry('aircraft-cache.json',registrationCompact(registration),result.aircraft);
    return {aircraft:result.aircraft,photos:result.photos,registration:result.aircraft?.registration || registration};
  }
  function warm(storage,trips,origin,ctx) {
    // Bound external requests to fit the Free plan. Remaining registrations are picked up by the hourly task.
    const registrations=[...new Set(trips.map(t=>registrationCompact(t.registration)).filter(Boolean))].slice(0,5);
    if (registrations.length) ctx.waitUntil(Promise.allSettled(registrations.map(reg=>lookup(storage,reg,origin))));
  }
  async function handle(request,env,ctx) {
    const url=new URL(request.url), route=url.pathname;
    if (env.AUTH_MODE==='password') {
      const authResponse=await handlePasswordAuth(request,env);
      if (authResponse) return authResponse;
      if (['/login','/login.html','/login.css','/login.js'].includes(route) && ['GET','HEAD'].includes(request.method)) {
        if (!env.ASSETS) throw new RequestError('网页资源尚未配置',503);
        return env.ASSETS.fetch(request);
      }
      await authorizePasswordRequest(request,env);
    } else {
      if (env.AUTH_MODE && env.AUTH_MODE!=='access') throw new RequestError('登录方式配置不正确',503);
      await authorize(request,env);
    }
    if (!['GET','HEAD'].includes(request.method)) verifyMutationRequest(request);
    if (route.startsWith('/api/')) {
      if (!env.DB) throw new RequestError('云端数据存储尚未配置',503);
      const storage=createStorage(env.DB);
      if (route==='/api/trips' && request.method==='GET') return json({trips:canonicalizeAirportTrips(await storage.listTrips(),directory)});
      if (route==='/api/config' && request.method==='GET') return json({...configured(env,await storage.readJSON('config.json',{})),apiKey:'',hasApiKey:Boolean(env.AI_API_KEY),cloud:true,authMode:env.AUTH_MODE || 'access'});
      if (route==='/api/config' && request.method==='PUT') {
        const input=await body(request);
        if (input.apiKey) throw new RequestError('在线版 API Key 请在 Cloudflare Secrets 中设置');
        await storage.writeJSON('config.json',publicConfig(input));
        return json({ok:true});
      }
      if (route==='/api/places' && request.method==='GET') return json({places:await storage.readJSON('places.json',{})});
      if (route==='/api/places' && request.method==='PUT') {
        const input=await body(request); assertConfirmed(input);
        if (typeof input.key!=='string' || !/^flight\|.{1,200}$/.test(input.key)) throw new RequestError('请确认正确的机场');
        if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon) || Math.abs(input.lat)>90 || Math.abs(input.lon)>180) throw new RequestError('经纬度范围不正确');
        await storage.writeEntry('places.json',input.key,{lat:input.lat,lon:input.lon});
        return json({ok:true});
      }
      if (route==='/api/export' && request.method==='GET') {
        const snapshot=await storage.exportSnapshot();
        snapshot.config=publicConfig(snapshot.config);
        return json(snapshot,200,{'Content-Disposition':'attachment; filename="trip-manager-backup.json"'});
      }
      if (route==='/api/import' && request.method==='POST') {
        const input=await body(request); assertConfirmed(input);
        if (!input.snapshot || input.snapshot.version!==1) throw new RequestError('迁移文件版本不正确');
        if (input.snapshot.config) input.snapshot.config=publicConfig(input.snapshot.config);
        const result=await storage.importSnapshot(input.snapshot);
        warm(storage,input.snapshot.trips || [],url.origin,ctx);
        return json({ok:true,...result});
      }
      if (route==='/api/backups' && request.method==='GET') return json({backups:await storage.listBackups()});
      const backupMatch=route.match(/^\/api\/backups\/(\d{4}-\d{2}-\d{2})$/);
      if (backupMatch && request.method==='GET') {
        const snapshot=await storage.readBackup(backupMatch[1]);
        if (!snapshot) throw new RequestError('备份不存在',404);
        return json(snapshot,200,{'Content-Disposition':`attachment; filename="trip-manager-${backupMatch[1]}.json"`});
      }
      const aircraftMatch=route.match(/^\/api\/aircraft\/([^/]+)$/);
      if (aircraftMatch && request.method==='GET') {
        let registration; try { registration=decodeURIComponent(aircraftMatch[1]); } catch { throw new RequestError('注册号格式不正确'); }
        if (!/^[A-Za-z0-9\s-]{2,24}$/.test(registration) || !registrationCompact(registration)) throw new RequestError('注册号格式不正确');
        return json(await lookup(storage,registration,url.origin));
      }
      if (route==='/api/recognize' && request.method==='POST') {
        const input=await body(request);
        if (typeof input.text!=='string' || input.text.length>30000) throw new RequestError('文字过长或格式不正确');
        const images=input.images ?? [];
        if (!Array.isArray(images) || images.length>5 || images.some(x=>typeof x!=='string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(x) || x.length>12*1024*1024)) throw new RequestError('最多 5 张 PNG、JPEG、WebP 图片，每张不超过 8 MB');
        if (!input.text.trim() && !images.length) throw new RequestError('请先输入文字或添加图片');
        if (input.mode==='local') {
          if (images.length) throw new RequestError('规则识别不支持图片，请使用 AI API');
          return json({...localExtract(input.text),source:'local'});
        }
        const config=configured(env,await storage.readJSON('config.json',{}));
        if (!config.endpoint || !config.model || !env.AI_API_KEY) throw new RequestError('请先配置模型和服务器端 AI_API_KEY');
        const endpoint=config.endpoint.replace(/\/+$/,'');
        const apiURL=endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`;
        const content=[{type:'text',text:input.text || '请提取图片中的行程'},...images.map(image=>({type:'image_url',image_url:{url:image}}))];
        const referenceDate=typeof input.referenceDate==='string' && /^\d{4}-\d{2}-\d{2}$/.test(input.referenceDate) ? input.referenceDate : new Date().toISOString().slice(0,10);
        let response;
        try {
          response=await fetcher(apiURL,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.AI_API_KEY}`},body:JSON.stringify({model:config.model,temperature:0,messages:[{role:'system',content:`${extractionPrompt}\n用户本机参考日期是 ${referenceDate}。相对日期可据此解析，有歧义不要猜测。`},{role:'user',content}]}),signal:AbortSignal.timeout(90000)});
        } catch { throw new RequestError('无法连接 AI API 或请求超时',502); }
        if (!response.ok) throw new RequestError(`AI API 请求失败（HTTP ${response.status}），请检查密钥和模型`,502);
        let result;
        try { const value=await response.json(); result=enrichAirportTrips(parseModelResponse(value.choices?.[0]?.message?.content),directory); }
        catch { throw new RequestError('AI 返回结果无法解析，请重试或核对模型',502); }
        return json({...result,source:'ai',duplicates:findDuplicates(result.trips,await storage.listTrips())});
      }
      if (route==='/api/trips/check' && request.method==='POST') {
        const input=await body(request);
        if (!Array.isArray(input.trips) || input.trips.length>30) throw new RequestError('行程数组不正确');
        return json({duplicates:findDuplicates(input.trips.map(checkedTrip),await storage.listTrips(),input.exceptId ?? '')});
      }
      if (route==='/api/trips' && request.method==='POST') {
        const input=await body(request); assertConfirmed(input);
        if (!Array.isArray(input.trips) || !input.trips.length || input.trips.length>30) throw new RequestError('请确认 1 至 30 条行程');
        const trips=await storage.addTrips(input.trips.map(checkedTrip));
        warm(storage,trips,url.origin,ctx);
        return json({trips},201);
      }
      const tripMatch=route.match(/^\/api\/trips\/([\w-]+)$/);
      if (tripMatch && ['PUT','DELETE'].includes(request.method)) {
        const input=await body(request); assertConfirmed(input);
        if (request.method==='DELETE') { if (!await storage.deleteTrip(tripMatch[1])) throw new RequestError('行程不存在',404); }
        else {
          const trip=checkedTrip(input.trip);
          await storage.updateTrip(tripMatch[1],trip);
          warm(storage,[trip],url.origin,ctx);
        }
        return json({ok:true});
      }
      throw new RequestError('未找到接口',404);
    }
    if (!['GET','HEAD'].includes(request.method)) throw new RequestError('不支持此操作',405);
    if (!env.ASSETS) throw new RequestError('网页资源尚未配置',503);
    return env.ASSETS.fetch(request);
  }
  return {
    async fetch(request,env,ctx) {
      try { return secure(await handle(request,env,ctx)); }
      catch(e) {
        const route=new URL(request.url).pathname;
        if (e.status===401 && env.AUTH_MODE==='password' && request.method==='GET' && ['/', '/index.html', '/stats', '/stats.html'].includes(route)) {
          return secure(new Response(null,{status:303,headers:{Location:'/login'}}));
        }
        return secure(json({error:e.status ? e.message : '云端服务暂时无法处理请求，请稍后重试',...(e.details || {})},e.status || 500));
      }
    },
    async scheduled(controller,env,ctx) {
      if (!env.DB) return;
      const storage=createStorage(env.DB);
      const snapshot=await storage.exportSnapshot();
      // UTC daily snapshot; the storage layer keeps at most seven dates.
      if (new Date(controller.scheduledTime).getUTCHours()===0) await storage.saveBackup(snapshot,new Date(controller.scheduledTime));
      if (!env.APP_ORIGIN) return;
      const cache=snapshot.aircraftCache || {};
      const now=Date.now();
      const pending=snapshot.trips.filter(t=>{
        const entry=cache[registrationCompact(t.registration)];
        return t.registration && (!entry || (!entry.model && now-(entry.lookupAttemptedAt || 0)>3600000));
      });
      warm(storage,pending,env.APP_ORIGIN,ctx);
    }
  };
}
export default createWorker();
