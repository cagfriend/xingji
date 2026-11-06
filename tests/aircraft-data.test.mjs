import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enrichAircraftRegistration} from '../aircraft-data.mjs';

const now = Date.parse('2026-09-24T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const goodPhoto = {thumbnail_large:{src:'https://cdn.planespotters.net/photo-large.jpg'},thumbnail:{src:'https://cdn.planespotters.net/photo-small.jpg'},link:'https://www.planespotters.net/photo/123/example',photographer:'Test author'};
const page = (title='Aircraft Data B-HLM, 2001 Airbus A330-343, c/n 386', extra='') => `<html><head><title>${title}</title></head><body>${extra}</body></html>`;
const aircraftTables = (hex='') => `<table><tr><td>Manufacturer</td><td>Airbus</td></tr><tr><td>Model</td><td>A330-343</td></tr><tr><td>Year built</td><td>2001</td></tr><tr><td>Construction Number (C/N)</td><td>386</td></tr></table><table><tr><td>Registration Number</td><td>B-HLM</td></tr><tr><td>Mode S (ICAO24) Code</td><td>${hex}</td></tr></table><table><tr><td>Registration Type</td><td>Commercial</td></tr><tr><td>Address</td><td>Hong Kong, China</td></tr></table>`;
const photoResponse = (photos=[]) => Response.json({photos});

test('规范化注册号、兼容缓存，并保留 Mode-S 正式 API 的两次请求路径', async () => {
  const requests=[];
  const fetcher=async(url, options={})=>{
    requests.push({url:String(url),options});
    if(String(url).includes('api.planespotters.net'))return photoResponse([{...goodPhoto,aircraft:{hex:'78018D'}}]);
    return Response.json({status:200,reg:'B-HLM',model:'2001 Airbus A330-343',cn:'386',country:'China',mode_s_code:'78018D',link:'https://airport-data.com/aircraft/B-HLM'});
  };
  const first=await enrichAircraftRegistration({registration:'BHLM',cache:{},fetcher,now});
  assert.equal(first.aircraft.registration,'B-HLM');
  assert.equal(first.aircraft.model,'2001 Airbus A330-343');
  assert.equal(first.aircraft.year,2001);
  assert.equal(first.aircraft.constructorNumber,'386');
  assert.equal(first.aircraft.lookupStatus.metadata,'ok');
  assert.equal(first.aircraft.lookupStatus.photos,'ok');
  assert.equal(first.photos[0].thumbnail,'https://cdn.planespotters.net/photo-small.jpg');
  assert.equal(requests.length,2);
  assert.match(requests[0].url,/reg\/B-HLM$/);
  assert.match(requests[1].url,/ac_info\.json\?m=78018D$/);
  assert.equal(requests[0].options.redirect,'follow');
  assert.match(requests[0].options.headers['User-Agent'],/github\.com\/cagfriend\/xingji/i);
  assert.equal(requests[0].options.headers.Referer,'http://127.0.0.1:4317/');
  const alias=await enrichAircraftRegistration({registration:'B HLM',cache:first.cache,fetcher,now:now+1000});
  assert.equal(alias.aircraft.registration,'B-HLM');
  assert.equal(requests.length,2,'新鲜缓存不应重复请求');
});

test('不依赖 Mode-S 页面直接解析标题年份、构造号和多个构造表', async () => {
  const old = `<table><tr><td>Manufacturer</td><td>Wrong Maker</td></tr><tr><td>Construction Number (C/N)</td><td>OLD</td></tr><tr><td>Model</td><td>Wrong Model</td></tr></table>`;
  const correct = `<table><tr><td>Manufacturer</td><td>Airbus</td></tr><tr><td>Model</td><td>A330-343</td></tr><tr><td>Construction Number (C/N)</td><td>386</td></tr></table>`;
  const fetcher=async url=>String(url).includes('planespotters') ? photoResponse([]) : new Response(page('Aircraft Data B-HLM, 2001 Airbus A330-343, c/n 386', old+correct), {status:200});
  const result=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher,now});
  assert.equal(result.aircraft.model,'2001 Airbus A330-343');
  assert.equal(result.aircraft.year,2001);
  assert.equal(result.aircraft.constructorNumber,'386');
  assert.equal(result.aircraft.country,'');
  assert.equal(result.aircraft.modeSCode,'');
  assert.equal(result.aircraft.lookupStatus.metadata,'ok');
});

test('机场资料页失败时照片独立成功且始终返回', async () => {
  const fetcher=async url=>String(url).includes('planespotters') ? photoResponse([goodPhoto]) : new Response('denied',{status:403});
  const result=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher,now});
  assert.equal(result.aircraft.lookupStatus.metadata,'unavailable');
  assert.equal(result.aircraft.lookupStatus.photos,'ok');
  assert.equal(result.photos.length,1);
  assert.equal(result.aircraft.model,'');
});

test('照片查询失败不妨碍从 Airport-Data HTML 取得资料', async () => {
  const fetcher=async url=>String(url).includes('planespotters') ? new Response('down',{status:503}) : new Response(page('Aircraft Data B-HLM, 2001 Airbus A330-343, c/n 386',aircraftTables()),{status:200});
  const result=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher,now});
  assert.equal(result.aircraft.lookupStatus.metadata,'ok');
  assert.equal(result.aircraft.lookupStatus.photos,'unavailable');
  assert.equal(result.aircraft.model,'2001 Airbus A330-343');
  assert.deepEqual(result.photos,[]);
});

test('已知机型冲突时不采用错误机型，但保留照片', async () => {
  const fetcher=async url=>String(url).includes('planespotters') ? photoResponse([goodPhoto]) : new Response(page('Aircraft Data B-1462, 1980 Sikorsky S-61A, c/n 61462', aircraftTables()),{status:200});
  const result=await enrichAircraftRegistration({registration:'B-1462',cache:{},fetcher,now,expectedModels:['Boeing 737-800']});
  assert.equal(result.aircraft.lookupStatus.metadata,'conflict');
  assert.equal(result.aircraft.model,'');
  assert.equal(result.photos.length,1);
  assert.equal(result.aircraft.lookupStatus.photos,'ok');
});

test('同一机型族允许细分型号，737NG 与 MAX 仍区分，A320 与 A321 区分', async () => {
  const makeFetcher = model => async url => String(url).includes('planespotters') ? photoResponse([]) : new Response(page(`Aircraft Data B-HLM, 2018 Boeing ${model}, c/n 386`),{status:200});
  const compatible=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher:makeFetcher('737-8SL'),now,expectedModels:['737-800']});
  assert.equal(compatible.aircraft.lookupStatus.metadata,'ok');
  const max=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher:makeFetcher('737 MAX 8'),now,expectedModels:['737-800']});
  assert.equal(max.aircraft.lookupStatus.metadata,'conflict');
  const a321=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher:async url=>String(url).includes('planespotters') ? photoResponse([]) : new Response(page('Aircraft Data B-HLM, 2018 Airbus A321-200, c/n 386')) ,now,expectedModels:['A320']});
  assert.equal(a321.aircraft.lookupStatus.metadata,'conflict');
});

test('new compact-key cache wins over an older hyphenated alias entry',async()=>{
  const old={registration:'B-HLM',model:'',photos:[],lookupAttemptedAt:now};
  const current={registration:'B-HLM',model:'2001 Airbus A330-343',year:2001,resolverVersion:2,updatedAt:new Date(now).toISOString(),photos:[goodPhoto],photosUpdatedAt:now,photosAttemptedAt:now,lookupStatus:{metadata:'ok',photos:'ok'}};
  const result=await enrichAircraftRegistration({registration:'B HLM',cache:{'B-HLM':old,BHLM:current},now,fetcher:async()=>{throw new Error('fresh canonical cache must avoid network');}});
  assert.equal(result.aircraft.model,current.model);assert.equal(result.photos.length,1);
  assert.equal(result.aircraft.lookupStatus.metadata,'ok');
});
test('737 customer codes and manufacturer MAX designations preserve model boundaries',async()=>{
  for(const [actual,expected,status] of [['Boeing 737-85N','737-800','ok'],['Boeing 737-83Z','737 MAX 8','conflict'],['Boeing 737-8','737-800','conflict'],['Boeing 737-8','737 MAX 8','ok'],['Boeing 737-700','737-800','conflict'],['Embraer 190LR','E190','ok']]){
    const result=await enrichAircraftRegistration({registration:'B-HLM',now,expectedModels:[expected],fetcher:async url=>String(url).includes('planespotters')?photoResponse([]):new Response(page(`Aircraft Data B-HLM, 2010 ${actual}, c/n 386`))});
    assert.equal(result.aircraft.lookupStatus.metadata,status,`${actual} versus ${expected}`);
  }
});
test('旧缓存的错误/空元数据会更新，失败时仍不抹除既有照片和资料', async () => {
  const photo={image:'https://cdn.planespotters.net/old.jpg',link:'https://www.planespotters.net/photo/1/old',photographer:'Old'};
  const cache={BHLM:{registration:'B-HLM',model:'',updatedAt:'',photos:[photo],photosUpdatedAt:now-2*DAY}};
  const fetcher=async url=>String(url).includes('planespotters') ? new Response('down',{status:503}) : new Response('down',{status:503});
  const result=await enrichAircraftRegistration({registration:'BHLM',cache,fetcher,now});
  assert.deepEqual(result.photos,[photo]);
  assert.equal(result.aircraft.lookupAttemptedAt,now);
  assert.equal(result.aircraft.photosAttemptedAt,now);
  assert.equal(result.aircraft.model,'');
  const prior={...cache.BHLM,model:'2001 Airbus A330-343',year:2001,constructorNumber:'386',updatedAt:new Date(now-200*DAY).toISOString(),resolverVersion:1};
  const cached=await enrichAircraftRegistration({registration:'BHLM',cache:{BHLM:prior},fetcher,now});
  assert.equal(cached.aircraft.model,'2001 Airbus A330-343','刷新失败不擦除有效旧资料');
});

test('失败请求五分钟内节流，force 可绕过缓存与节流', async () => {
  let count=0;
  const fetcher=async url=>{count++;return String(url).includes('planespotters') ? new Response('down',{status:503}) : new Response('down',{status:503});};
  const first=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher,now});
  const second=await enrichAircraftRegistration({registration:'B-HLM',cache:first.cache,fetcher,now:now+60_000});
  assert.equal(count,2,'服务端故障后不重复请求其他注册号变体');
  assert.equal(second.aircraft.photosAttemptedAt,now);
  const forced=await enrichAircraftRegistration({registration:'B-HLM',cache:second.cache,fetcher,now:now+60_001,force:true});
  assert.ok(count>2);
  assert.equal(forced.aircraft.photosAttemptedAt,now+60_001);
});

test('注册号变体优先规范写法，首个命中即停止', async () => {
  const requests=[];
  const fetcher=async url=>{
    requests.push(String(url));
    if(String(url).includes('planespotters'))return photoResponse([]);
    if(String(url).endsWith('/G-EUYR'))return new Response(page('Aircraft Data G-EUYR, 2000 Boeing 737-800, c/n 386'));
    return new Response('not found',{status:404});
  };
  const result=await enrichAircraftRegistration({registration:'GEUYR',cache:{},fetcher,now});
  assert.equal(result.aircraft.registration,'G-EUYR');
  assert.equal(requests.filter(url=>url.includes('/aircraft/')).length,2,'先请求输入写法，随后使用首个有限连字符变体');
  assert.ok(requests[0].includes('planespotters') || requests[1].includes('planespotters'));
});

test('raw 照片列表被展示过滤时仍能从原始 payload 使用 hex 查询 API', async () => {
  const requests=[];
  const fetcher=async url=>{
    requests.push(String(url));
    if(String(url).includes('planespotters'))return photoResponse([{aircraft:{hex:'78018D'}}]);
    if(String(url).includes('ac_info.json'))return Response.json({status:200,reg:'B-HLM',model:'2001 Airbus A330-343',cn:'386'});
    throw new Error('页面不应被请求');
  };
  const result=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher,now});
  assert.equal(result.aircraft.model,'2001 Airbus A330-343');
  assert.equal(result.photos.length,0);
  assert.equal(requests.length,2);
});

test('Mode-S API 返回其他注册号时拒绝该记录并回退到注册号页面，缺年份返回 null', async () => {
  const requests=[];
  const fetcher=async url=>{
    requests.push(String(url));
    if(String(url).includes('planespotters'))return photoResponse([{...goodPhoto,aircraft:{hex:'78018D'}}]);
    if(String(url).includes('ac_info.json'))return Response.json({status:200,reg:'N123AB',model:'2001 Boeing 737-800',cn:'123'});
    if(String(url)==='https://airport-data.com/aircraft/B-HLM')return new Response(page('Aircraft Data B-HLM, Boeing 737-800, c/n 386'));
    throw new Error('unexpected request');
  };
  const result=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher,now});
  assert.equal(result.aircraft.registration,'B-HLM');
  assert.equal(result.aircraft.model,'Boeing 737-800');
  assert.equal(result.aircraft.year,null);
  assert.ok(requests.some(url=>url==='https://airport-data.com/aircraft/B-HLM'));
});

test('not-found 页面不会被误判为成功', async () => {
  const fetcher=async url=>String(url).includes('planespotters') ? photoResponse([]) : new Response(page('Add aircraft - Airport-Data','No aircraft currently found'));
  const result=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher,now});
  assert.equal(result.aircraft.lookupStatus.metadata,'not-found');
  assert.equal(result.aircraft.model,'');
});

test('preferCache skips both sources for partial successes; force still refreshes', async()=>{
  let calls=0;
  const cached={registration:'B-HLM',model:'Airbus A330',updatedAt:new Date(now-DAY*200).toISOString(),resolverVersion:2,photos:[{image:goodPhoto.thumbnail_large.src,thumbnail:goodPhoto.thumbnail.src,link:goodPhoto.link,photographer:'Test'}],photosUpdatedAt:now-DAY*200};
  const fetcher=async()=>{calls++;return photoResponse([]);};
  const hit=await enrichAircraftRegistration({registration:'B-HLM',cache:{BHLM:cached},fetcher,now,preferCache:true});
  assert.equal(calls,0);assert.equal(hit.photos.length,1);
  await enrichAircraftRegistration({registration:'B-HLM',cache:hit.cache,fetcher,now,preferCache:true,force:true});
  assert.ok(calls>0);
  const onlyPhotos={registration:'B-HLM',model:'',photos:cached.photos,photosUpdatedAt:now};
  const beforePhotos=calls;
  const photosHit=await enrichAircraftRegistration({registration:'B-HLM',cache:{BHLM:onlyPhotos},fetcher,now,preferCache:true});
  assert.equal(calls,beforePhotos);assert.equal(photosHit.photos.length,1);
  const before=calls;
  const onlyModel={registration:'B-HLM',model:'Airbus A330',photos:[],updatedAt:new Date(now).toISOString(),resolverVersion:2};
  await enrichAircraftRegistration({registration:'B-HLM',cache:{BHLM:onlyModel},fetcher,now,preferCache:true});
  assert.equal(calls,before);
});

test('preferCache does not freeze cached empty or failed lookups', async()=>{
  let calls=0;
  const result=await enrichAircraftRegistration({registration:'B-HLM',cache:{BHLM:{registration:'B-HLM',model:'',photos:[],photosUpdatedAt:now}},fetcher:async()=>{calls++;return photoResponse([]);},now,preferCache:true});
  assert.ok(calls>0);assert.ok(result.aircraft);
});
