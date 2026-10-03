import {validateTrip, findDuplicates, extractionPrompt, parseModelResponse, localExtract, registrationCompact} from '../lib.mjs';
import {createAirportDirectory, canonicalizeAirportTrips, enrichAirportTrips} from '../airport-directory.mjs';
import {normalizeAircraftType} from '../dist/aviation.js';
import {enrichAircraftRegistration} from '../aircraft-data.mjs';

const defaults = {endpoint:'', apiKey:'', model:'', temperature:0};
const tripKey = 'trips.json';
const configKey = 'config.json';
const placesKey = 'places.json';
const aircraftKey = 'aircraft-cache.json';

class ServiceError extends Error {
  constructor(message, status=400, details={}) { super(message); this.status=status; this.details=details; }
}

function checkedTrip(input) {
  try {
    const trip=validateTrip(input);
    trip.aircraftType=normalizeAircraftType(trip.aircraftType);
    return trip;
  } catch (error) { throw new ServiceError(error.message); }
}

function responseValue(result) {
  if (result && typeof result==='object' && 'status' in result && 'data' in result) {
    const status=Number(result.status) || 200;
    return {ok:status>=200 && status<300,status,json:async()=>typeof result.data==='string'?JSON.parse(result.data):result.data,text:async()=>typeof result.data==='string'?result.data:JSON.stringify(result.data)};
  }
  return result;
}

export function createLocalService({storage, request, places, uuid=()=>crypto.randomUUID(), now=()=>Date.now()}={}) {
  if (!storage || typeof storage.read!=='function' || typeof storage.write!=='function') throw new TypeError('storage 必须提供异步 read/write');
  if (typeof request!=='function') throw new TypeError('request 必须是函数');
  const directory=places ? createAirportDirectory(places) : null;
  let queue=Promise.resolve();
  const serial=task=>{const next=queue.then(task,task);queue=next.catch(()=>{});return next;};
  const clock=()=>{const value=typeof now==='function'?now():now;return value instanceof Date?value.getTime():Number(value);};
  const read=async(key,fallback)=>{const value=await storage.read(key);return value==null?fallback:value;};
  const write=(key,value)=>storage.write(key,value);
  const requestJSON=async(url,{method='GET',headers={},data}={})=>responseValue(await request({url,method,headers,data}));

  async function lookupAircraft(registration) {
    const cache=await read(aircraftKey,{});
    const result=await enrichAircraftRegistration({registration,cache,fetcher:async(url,options={})=>{
      const headers={...options.headers,'User-Agent':'XingjiLocal/1.0 (cn.tangjp.xingji; contact: you@example.com)'};
      delete headers.Origin;delete headers.Referer;
      const response=await requestJSON(url,{method:options.method??'GET',headers,data:options.body});
      if (typeof response==='string') return new Response(response,{status:200});
      return response;
    },now:clock(),origin:''});
    if (result.aircraft) await serial(async()=>{
      const latest=await read(aircraftKey,{});
      await write(aircraftKey,{...latest,[registrationCompact(registration)]:result.aircraft});
    });
    return {aircraft:result.aircraft,photos:result.photos,registration:result.aircraft?.registration??registration};
  }
  function warmAircraft(trips) {
    const registrations=[...new Set(trips.map(trip=>registrationCompact(trip.registration)).filter(Boolean))];
    for(const registration of registrations) void Promise.resolve().then(()=>lookupAircraft(registration)).catch(()=>{});
  }

  async function handle(path,{method='GET',body}={}) {
    const route=String(path).split('?')[0];
    method=String(method).toUpperCase();
    if (route==='/api/trips' && method==='GET') {
      const trips=(await read(tripKey,[])).filter(trip=>trip?.type==='flight');
      return {trips:canonicalizeAirportTrips(trips,directory)};
    }
    if (route==='/api/config' && method==='GET') return {...defaults,...await read(configKey,{})};
    if (route==='/api/config' && method==='PUT') {
      const input=body??{};const config={};
      for(const key of ['endpoint','apiKey','model']) {
        if(typeof input[key]!=='string'||input[key].length>5000)throw new ServiceError('配置字段不正确');
        config[key]=input[key].trim();
      }
      if(config.endpoint){let url;try{url=new URL(config.endpoint);}catch{throw new ServiceError('API 地址不正确');}
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new ServiceError('请输入无查询参数的 HTTP(S) API 地址');}
      await serial(()=>write(configKey,{...config,temperature:0}));return {ok:true};
    }
    if(route==='/api/places'&&method==='GET')return {places:await read(placesKey,{})};
    if(route==='/api/places'&&method==='PUT'){
      const input=body??{};
      if(input.confirmed!==true||typeof input.key!=='string'||!/^flight\|.{1,200}$/.test(input.key))throw new ServiceError('请确认正确的机场');
      if(typeof input.lat!=='number'||typeof input.lon!=='number'||!Number.isFinite(input.lat)||!Number.isFinite(input.lon)||Math.abs(input.lat)>90||Math.abs(input.lon)>180)throw new ServiceError('经纬度范围不正确');
      return serial(async()=>{const value=await read(placesKey,{});value[input.key]={lat:input.lat,lon:input.lon};await write(placesKey,value);return {ok:true};});
    }
    if(route==='/api/recognize'&&method==='POST'){
      const input=body??{};
      if(typeof input.text!=='string'||input.text.length>30000)throw new ServiceError('文字过长或格式不正确');
      const images=input.images??[];
      if(!Array.isArray(images)||images.length>5||images.some(x=>typeof x!=='string'||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(x)||x.length>12*1024*1024))throw new ServiceError('最多 5 张 PNG、JPEG、WebP 图片，每张不超过 8 MB');
      if(!input.text.trim()&&!images.length)throw new ServiceError('请先输入文字或添加图片');
      if(input.mode==='local'){
        if(images.length)throw new ServiceError('本地规则无法识别图片，请配置支持视觉的 AI API');
        const result=enrichAirportTrips(localExtract(input.text),directory);
        return {...result,source:'local',duplicates:findDuplicates(result.trips,await read(tripKey,[]))};
      }
      const config={...defaults,...await read(configKey,{})};
      if(!config.endpoint||!config.model)throw new ServiceError('请先在 API 设置中填写接口地址和模型名称');
      const endpoint=config.endpoint.replace(/\/+$/,'');const url=endpoint.endsWith('/chat/completions')?endpoint:`${endpoint}/chat/completions`;
      const content=[{type:'text',text:input.text||'请提取图片中的行程'},...images.map(image=>({type:'image_url',image_url:{url:image}}))];
      const referenceDate=typeof input.referenceDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(input.referenceDate)?input.referenceDate:new Date(clock()).toISOString().slice(0,10);
      let response;
      try{response=await requestJSON(url,{method:'POST',headers:{'Content-Type':'application/json',...(config.apiKey?{Authorization:`Bearer ${config.apiKey}`}:{})},data:{model:config.model,temperature:0,messages:[{role:'system',content:`${extractionPrompt}\n用户本机参考日期是 ${referenceDate}。明确的相对日期可据此解析，有歧义不要猜测。`},{role:'user',content}]}});}catch{throw new ServiceError('无法连接 API 或请求超时，请检查地址、网络与模型',502);}
      if(!response.ok)throw new ServiceError(`API 请求失败（HTTP ${response.status}）。请检查密钥、模型以及图片识别支持。`,502);
      try{const value=await response.json();const result=enrichAirportTrips(parseModelResponse(value.choices?.[0]?.message?.content),directory);return {...result,source:'ai',duplicates:findDuplicates(result.trips,await read(tripKey,[]))};}
      catch(error){throw new ServiceError(error.message||'无法读取 API 返回结果',502);}
    }
    if(route==='/api/trips/check'&&method==='POST'){
      const input=body??{};if(!Array.isArray(input.trips)||input.trips.length>30)throw new ServiceError('行程数组不正确');
      return {duplicates:findDuplicates(input.trips.map(checkedTrip),await read(tripKey,[]),input.exceptId??'')};
    }
    if(route==='/api/trips'&&method==='POST'){
      const input=body??{};if(input.confirmed!==true)throw new ServiceError('必须先确认行程后再保存');
      if(!Array.isArray(input.trips)||!input.trips.length||input.trips.length>30)throw new ServiceError('请确认 1 至 30 条行程');
      const items=input.trips.map(checkedTrip);
      const result=await serial(async()=>{const existing=await read(tripKey,[]);const duplicates=findDuplicates(items,existing);if(duplicates.length)throw new ServiceError('有重复航班，请移除重复项或修改航班号与日期',409,{duplicates});
        const timestamp=new Date(clock()).toISOString();const saved=items.map(trip=>({...trip,id:uuid(),createdAt:timestamp,updatedAt:timestamp}));await write(tripKey,[...existing,...saved]);return {trips:saved};});
      warmAircraft(result.trips);return result;
    }
    const match=route.match(/^\/api\/trips\/([\w-]+)$/);
    if(match&&['PUT','DELETE'].includes(method)){
      const input=body??{};if(input.confirmed!==true)throw new ServiceError('请先确认操作');
      const result=await serial(async()=>{const existing=await read(tripKey,[]);const index=existing.findIndex(item=>item.id===match[1]);if(index<0)throw new ServiceError('行程不存在',404);
        if(method==='DELETE')existing.splice(index,1);
        else{const updated=checkedTrip(input.trip);const duplicates=findDuplicates([updated],existing,match[1]);if(duplicates.length)throw new ServiceError('修改后与已有行程重复',409,{duplicates});existing[index]={...updated,id:match[1],createdAt:existing[index].createdAt,updatedAt:new Date(clock()).toISOString()};}
        await write(tripKey,existing);return {ok:true,trip:method==='PUT'?existing[index]:null};});
      if(method==='PUT')warmAircraft([result.trip]);return {ok:true};
    }
    const aircraftMatch=route.match(/^\/api\/aircraft\/([^/]+)$/);
    if(aircraftMatch&&method==='GET'){
      let registration;try{registration=decodeURIComponent(aircraftMatch[1]);}catch{throw new ServiceError('注册号格式不正确');}
      if(registration.length>24||!registrationCompact(registration))throw new ServiceError('注册号格式不正确');
      return lookupAircraft(registration);
    }
    throw new ServiceError('未找到接口',404);
  }

  async function exportBackup(){return serial(async()=>{
    const config=await read(configKey,{});
    return {version:1,trips:(await read(tripKey,[])).filter(trip=>trip?.type==='flight'),places:await read(placesKey,{}),aircraftCache:await read(aircraftKey,{}),config:{endpoint:config.endpoint??'',model:config.model??''}};
  });}
  async function importBackup(snapshot){
    if(!snapshot||![1,2].includes(snapshot.version)||!Array.isArray(snapshot.trips)||snapshot.trips.length>10000)throw new ServiceError('迁移文件版本或行程数据不正确');
    const cleanTrips=snapshot.trips.map(item=>{
      const trip=checkedTrip(item);if(item.id!=null&&(typeof item.id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(item.id)||['__proto__','constructor','prototype'].includes(item.id)))throw new ServiceError('迁移文件行程编号不安全');
      const id=item.id||uuid();const createdAt=typeof item.createdAt==='string'?item.createdAt:new Date(clock()).toISOString();
      return {...trip,id,createdAt,updatedAt:typeof item.updatedAt==='string'?item.updatedAt:createdAt};
    });
    const config=snapshot.config;if(config!==undefined&&(!config||typeof config!=='object'||Array.isArray(config)))throw new ServiceError('迁移文件配置不正确');
    const safeConfig=config?{...defaults,endpoint:typeof config.endpoint==='string'?config.endpoint:'',model:typeof config.model==='string'?config.model:'',apiKey:''}:null;
    if(safeConfig?.endpoint){let url;try{url=new URL(safeConfig.endpoint);}catch{throw new ServiceError('API 地址不正确');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new ServiceError('请输入无查询参数的 HTTP(S) API 地址');}
    const validPlaces=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([key,coords])=>/^flight\|.{1,200}$/.test(key)&&coords&&Number.isFinite(coords.lat)&&Number.isFinite(coords.lon)&&Math.abs(coords.lat)<=90&&Math.abs(coords.lon)<=180);
    if(snapshot.places!==undefined&&!validPlaces(snapshot.places))throw new ServiceError('迁移文件地点数据不正确');
    const forbidden=new Set(['__proto__','constructor','prototype']);
    const checkSafeObject=(value,depth=0)=>{if(depth>30)throw new ServiceError('迁移文件对象嵌套过深');if(!value||typeof value!=='object')return;if(Array.isArray(value)){for(const item of value)checkSafeObject(item,depth+1);return;}for(const [key,item] of Object.entries(value)){if(forbidden.has(key))throw new ServiceError('迁移文件包含不安全的对象键');checkSafeObject(item,depth+1);}};
    if(snapshot.aircraftCache!==undefined&&(!snapshot.aircraftCache||typeof snapshot.aircraftCache!=='object'||Array.isArray(snapshot.aircraftCache)))throw new ServiceError('迁移文件飞机资料不正确');
    if(snapshot.aircraftCache!==undefined)checkSafeObject(snapshot.aircraftCache);
    return serial(async()=>{
      const existing=await read(tripKey,[]);const merged=[...existing];let imported=0;const usedIds=new Set(merged.map(trip=>trip.id));
      for(const trip of cleanTrips){if(findDuplicates([trip],merged).length)continue;let value=trip;if(usedIds.has(value.id)){value={...value,id:uuid()};while(usedIds.has(value.id))value={...value,id:uuid()};}usedIds.add(value.id);merged.push(value);imported++;}
      const oldPlaces=await read(placesKey,{}),oldAircraft=await read(aircraftKey,{});
      const oldConfig=await read(configKey,{});
      const writes=[[tripKey,merged],[placesKey,{...oldPlaces,...(snapshot.places??{})}],[aircraftKey,{...oldAircraft,...(snapshot.aircraftCache??{})}]];
      if(safeConfig)writes.push([configKey,{...oldConfig,endpoint:safeConfig.endpoint,model:safeConfig.model,apiKey:oldConfig.apiKey??'',temperature:0}]);
      let attempted=0;try{for(const [key,value] of writes){attempted++;await write(key,value);}}catch(error){for(let index=attempted-1;index>=0;index--){try{const key=writes[index][0];const oldValue=key===tripKey?existing:key===placesKey?oldPlaces:key===aircraftKey?oldAircraft:oldConfig;await write(key,oldValue);}catch{}}throw error;}
      return {imported,skipped:cleanTrips.length-imported};
    });
  }
  return {handle,exportBackup,importBackup};
}
