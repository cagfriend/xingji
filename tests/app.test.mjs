import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {validateTrip,normalizeCode,validDate,findDuplicates,parseModelResponse,localExtract,normalizeRegistration,registrationRegex} from '../lib.mjs';
const trip = overrides => ({type:'flight',code:'CA1831',date:'2026-10-12',departure:'北京首都',arrival:'上海虹桥',...overrides});
async function fixture(t, upstreamFetch, options={}) {
  const dir=await mkdtemp(path.join(tmpdir(),'local-trip-test-'));
  const server=await createApp({dataDir:dir,upstreamFetch,lookupAircraft:false,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  async function req(route, method='GET', body, headers={}) {const res=await fetch(url+route,{method,headers:{'Content-Type':'application/json','X-Trip-Local':'1',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};}
  return {dir,url,req};
}
test('规范化编号与真实日历日期',()=>{
  assert.equal(normalizeCode('ｃａ - １８３１'),'CA1831');
  assert.equal(validDate('2026-02-29'),false);assert.equal(validDate('2028-02-29'),true);assert.equal(validDate('2026-13-01'),false);
  assert.throws(()=>validateTrip(trip({date:'2026-02-30'})),/日期/);
  assert.throws(()=>validateTrip(trip({code:''})),/必须/);
  assert.throws(()=>validateTrip(trip({type:'train',code:'G102',arrivalDate:'2026-10-11'})),/仅支持航班/);
  assert.equal(validateTrip(trip({arrivalDate:'2026-10-11'})).arrivalDate,'2026-10-11');
  assert.throws(()=>validateTrip(trip({departureTime:'25:00'})),/时间/);
});
test('批次、已有数据、日期和编辑自身的去重规则',()=>{
  const saved={...trip(),id:'old'};
  assert.equal(findDuplicates([trip({code:'ca 1831'})],[saved]).length,1);
  assert.equal(findDuplicates([trip(),trip()],[]).length,1);
  assert.equal(findDuplicates([trip({date:'2026-10-13'})],[saved]).length,0);
  assert.equal(findDuplicates([trip()],[saved],'old').length,0);
  assert.throws(()=>validateTrip({type:'hotel',date:'2026-10-12'}),/仅支持航班/);
});
test('模型 JSON 严格解析，不对未知字段猜测',()=>{
  const ignored=parseModelResponse('```json\n{"trips":[{"type":"train","code":"g 102"}],"warnings":["日期缺失"]}\n```');assert.equal(ignored.trips.length,0);assert.match(ignored.warnings.at(-1),/非航班/);
  assert.equal(parseModelResponse('{"trips":[{"type":"flight","date":123}]}').trips[0].date,'');
  assert.throws(()=>parseModelResponse('这是非 JSON 返回'),/JSON/);
  assert.throws(()=>parseModelResponse('{"trips":[null]}'),/无效/);
});
test('本地规则仅识别航班，并明确标记能力范围',()=>{
  const r=localExtract('2026年10月12日，乘坐 CA1831，北京首都机场到上海虹桥机场，07:00 出发。');
  assert.equal(r.trips.length,1);assert.equal(r.trips[0].type,'flight');assert.equal(r.trips[0].code,'CA1831');assert.equal(r.trips[0].date,'2026-10-12');assert.equal(r.trips[0].departure,'北京首都机场');assert.equal(r.trips[0].arrival,'上海虹桥机场');assert.equal(r.trips[0].departureTime,'07:00');assert.match(r.warnings[0],/不是 AI/);
  assert.equal(localExtract('2026年10月12日，乘坐 G102，上海虹桥到北京南，07:00 出发。').trips.length,0);
});
test('未经确认不保存，缺失字段也不保存',async t=>{
  const {req}=await fixture(t);
  assert.equal((await req('/api/trips','POST',{trips:[trip()]})).status,400);
  assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[trip({code:''})]})).status,400);
  assert.equal((await req('/api/trips')).data.trips.length,0);
});
test('保存、跨日期、重复与整批回滚',async t=>{
  const {req}=await fixture(t);
  assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[trip()]})).status,201);
  assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[trip({code:'ca - 1831'})]})).status,409);
  assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[trip({date:'2026-10-13'}),trip()]})).status,409);
  assert.equal((await req('/api/trips')).data.trips.length,1);
  assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[trip({date:'2026-10-13'})]})).status,201);
});
test('本批次重复不落盘',async t=>{
  const {req}=await fixture(t);
  assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[trip(),trip()]})).status,409);
  assert.equal((await req('/api/trips')).data.trips.length,0);
});
test('并发提交重复只能有一次成功',async t=>{
  const {req}=await fixture(t);
  const results=await Promise.all([req('/api/trips','POST',{confirmed:true,trips:[trip()]}),req('/api/trips','POST',{confirmed:true,trips:[trip()]})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal((await req('/api/trips')).data.trips.length,1);
});
test('编辑自身成功、编辑冲突拒绝、删除需确认及最近版本备份',async t=>{
  const {req,dir}=await fixture(t);
  const added=await req('/api/trips','POST',{confirmed:true,trips:[trip(),trip({date:'2026-10-13'})]});const id=added.data.trips[0].id;
  assert.equal((await req(`/api/trips/${id}`,'PUT',{confirmed:true,trip:trip({seat:'12A'})})).status,200);
  assert.equal((await req(`/api/trips/${id}`,'PUT',{confirmed:true,trip:trip({date:'2026-10-13'})})).status,409);
  assert.equal((await req(`/api/trips/${id}`,'DELETE',{})).status,400);
  assert.equal((await req(`/api/trips/${id}`,'DELETE',{confirmed:true})).status,200);
  assert.equal(JSON.parse(await readFile(path.join(dir,'trips.json'),'utf8')).length,1);
  assert.equal(JSON.parse(await readFile(path.join(dir,'trips.json.bak'),'utf8')).length,2);
});
test('API 配置持久化、文字和图片转发、识别不直接保存',async t=>{
  let captured;
  const {req,dir}=await fixture(t,async(url,options)=>{captured={url,options};return Response.json({choices:[{message:{content:JSON.stringify({trips:[trip()],warnings:[]})}}]});});
  await req('/api/config','PUT',{endpoint:'https://example.invalid/v1',apiKey:'test-only-key',model:'vision-test'});
  const image='data:image/png;base64,aGVsbG8=';
  const result=await req('/api/recognize','POST',{text:'明天出发',images:[image],referenceDate:'2026-10-11'});
  assert.equal(result.status,200);assert.equal(captured.url,'https://example.invalid/v1/chat/completions');
  const body=JSON.parse(captured.options.body);assert.equal(body.messages[1].content[1].image_url.url,image);assert.match(body.messages[0].content,/2026-10-11/);
  assert.equal(captured.options.headers.Authorization,'Bearer test-only-key');assert.equal((await req('/api/trips')).data.trips.length,0);
  assert.equal(JSON.parse(await readFile(path.join(dir,'config.json'),'utf8')).model,'vision-test');
});
test('完整 API 路径不重复拼接；缺失字段仍可进入确认阶段',async t=>{
  let target;const {req}=await fixture(t,async url=>{target=url;return Response.json({choices:[{message:{content:'{"trips":[{"type":"flight","code":"CA1831"}],"warnings":["日期缺失"]}'}}]});});
  await req('/api/config','PUT',{endpoint:'https://example.invalid/v1/chat/completions/',apiKey:'',model:'test'});
  const r=await req('/api/recognize','POST',{text:'CA1831'});assert.equal(r.status,200);assert.equal(target,'https://example.invalid/v1/chat/completions');assert.equal(r.data.trips[0].date,'');
});
test('未配置 API、非 JSON 返回、上游错误不会保存',async t=>{
  const noAPI=await fixture(t);assert.equal((await noAPI.req('/api/recognize','POST',{text:'hi'})).status,400);
  for (const response of [Response.json({choices:[{message:{content:'invalid'}}]}),new Response('',{status:401})]) {
    const {req}=await fixture(t,async()=>response);
    await req('/api/config','PUT',{endpoint:'https://example.invalid/v1',apiKey:'',model:'test'});
    assert.equal((await req('/api/recognize','POST',{text:'hi'})).status,502);assert.equal((await req('/api/trips')).data.trips.length,0);
  }
});
test('本地规则拒绝图片、图片格式校验',async t=>{
  const {req}=await fixture(t);
  assert.equal((await req('/api/recognize','POST',{mode:'local',text:'test',images:['data:image/png;base64,aGVsbG8=']})).status,400);
  assert.equal((await req('/api/recognize','POST',{text:'test',images:['data:text/html;base64,aGVsbG8=']})).status,400);
  const r=await req('/api/recognize','POST',{mode:'local',text:'2026-10-12 G102 上海虹桥到北京南'});assert.equal(r.status,200);assert.equal(r.data.source,'local');
});
test('本地端点拒绝跨站请求且不会暴露数据文件',async t=>{
  const {req,url}=await fixture(t);
  assert.equal((await req('/api/config','PUT',{endpoint:'',apiKey:'',model:''},{Origin:'https://example.invalid'})).status,403);
  assert.equal((await fetch(url+'/api/trips',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await req('/data/config.json')).status,404);
  assert.equal((await fetch(url+'/')).status,200);assert.equal((await fetch(url+'/app.js')).status,200);
});
test('损坏数据不会被保存动作覆盖',async t=>{
  const {dir,req}=await fixture(t);await writeFile(path.join(dir,'trips.json'),'{"broken":true}');
  assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[trip()]})).status,500);
  assert.equal(await readFile(path.join(dir,'trips.json'),'utf8'),'{"broken":true}');
});
test('航班所有新增字段均可识别、保存与更新，去重仍使用预计日期',async t=>{
  const full=trip({departureTerminal:'T3',arrivalTerminal:'T2',departureTime:'23:50',arrivalDate:'2026-10-13',arrivalTime:'01:20',actualDepartureDate:'2026-10-13',actualDepartureTime:'00:10',actualArrivalDate:'2026-10-13',actualArrivalTime:'01:40',aircraftType:'Airbus A320',registration:'b-1234',ticketPrice:'680 CNY',seat:'12A'});
  let prompt;
  const {req}=await fixture(t,async(url,options)=>{prompt=JSON.parse(options.body).messages[0].content;return Response.json({choices:[{message:{content:JSON.stringify({trips:[full]})}}]});});
  await req('/api/config','PUT',{endpoint:'https://example.invalid/v1',apiKey:'',model:'test'});
  const recognized=await req('/api/recognize','POST',{text:'含预计和实际起降时间的机票'});
  assert.equal(recognized.data.trips[0].registration,'B-1234');assert.equal(recognized.data.trips[0].actualDepartureTime,'00:10');assert.match(prompt,/不能用预计时刻补实际时刻/);assert.match(prompt,/仁川国际机场/);
  const created=await req('/api/trips','POST',{confirmed:true,trips:recognized.data.trips});assert.equal(created.status,201);
  const saved=(await req('/api/trips')).data.trips[0];for(const [k,v] of Object.entries(full))assert.equal(saved[k],k==='registration'?'B-1234':k==='departure'?'北京首都国际机场（PEK）':k==='arrival'?'上海虹桥国际机场（SHA）':k==='aircraftType'?'空客 A320':v);
  assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[{...full,actualDepartureDate:'2026-10-14'}]})).status,409);
  assert.equal((await req(`/api/trips/${saved.id}`,'PUT',{confirmed:true,trip:{...full,aircraftType:'Boeing 737',ticketPrice:'USD 120'}})).status,200);
  assert.equal((await req('/api/trips')).data.trips[0].ticketPrice,'USD 120');
  assert.equal((await req('/api/trips')).data.trips[0].aircraftType,'波音 737');
});
test('火车数据在识别与保存阶段均被拒绝',async t=>{
  const input={type:'train',code:'G102',date:'2026-10-12',departure:'上海虹桥',arrival:'北京南',departureTime:'07:00',arrivalDate:'2026-10-12',arrivalTime:'12:30',seat:'12A',ticketPrice:'680 CNY',registration:'B-1234',traveler:'不应保存',bookingRef:'不应保存',notes:'不应保存'};
  const parsed=parseModelResponse(JSON.stringify({trips:[input]}));assert.equal(parsed.trips.length,0);assert.match(parsed.warnings.at(-1),/非航班/);
  const {req}=await fixture(t);assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[input]})).status,400);
  assert.equal((await req('/api/trips')).data.trips.length,0);
});
test('非交通项目不再被 AI 或本地规则转换成行程',async t=>{
  const r=parseModelResponse(JSON.stringify({trips:[{type:'hotel',title:'酒店'},trip(),{type:'other'}]}));assert.equal(r.trips.length,1);assert.equal(r.trips[0].type,'flight');assert.equal(r.warnings.length,2);
  assert.equal(localExtract('2026-10-12 入住酒店').trips.length,0);
  const {req}=await fixture(t);assert.equal((await req('/api/trips','POST',{confirmed:true,trips:[{type:'hotel',date:'2026-10-12'}]})).status,400);
});
test('实际时间和日期必须有效，未填写实际时间不使用预计值补齐',()=>{
  assert.throws(()=>validateTrip(trip({actualDepartureTime:'24:10'})),/时间/);assert.throws(()=>validateTrip(trip({actualArrivalDate:'2026-02-30'})),/日期/);
  const r=validateTrip(trip({departureTime:'08:00',arrivalTime:'10:00'}));assert.equal(r.actualDepartureTime,'');assert.equal(r.actualArrivalTime,'');
});
test('飞机注册号兼容连字符缺失与全角输入',()=>{
  assert.equal(normalizeRegistration('BHLM'),'B-HLM');
  assert.equal(normalizeRegistration('b－hlm'),'B-HLM');
  assert.equal(normalizeRegistration('HL7732'),'HL7732');
  assert.equal(normalizeRegistration('9v-ska'),'9V-SKA');
  assert.equal(registrationRegex('BHLM').test('B-HLM'),true);
  assert.equal(registrationRegex('B-HLM').test('BHLM'),true);
  assert.equal(registrationRegex('9VSKA').test('9V-SKA'),true);
  assert.equal(validateTrip(trip({registration:'b1234'})).registration,'B-1234');
});
test('飞机资料接口统一无连字符注册号并返回带作者署名的在线照片',async t=>{
  const calls=[];
  const {req,dir}=await fixture(t,undefined,{aircraftFetch:async url=>{calls.push(String(url));return Response.json({photos:[{thumbnail:{src:'https://cdn.planespotters.net/example.jpg'},link:'https://www.planespotters.net/photo/123/example',photographer:'测试摄影者'}]});}});
  await writeFile(path.join(dir,'aircraft-cache.json'),JSON.stringify({'B-HLM':{registration:'B-HLM',model:'2001 Airbus A330-343',constructorNumber:'386',country:'China',modeSCode:'78018D',sourceUrl:'https://airport-data.com/aircraft/B-HLM',updatedAt:new Date().toISOString(),photos:[],photosUpdatedAt:0}}));
  const result=await req('/api/aircraft/BHLM');
  assert.equal(result.status,200);assert.equal(result.data.aircraft.model,'2001 Airbus A330-343');
  assert.equal(result.data.photos[0].photographer,'测试摄影者');assert.match(calls[0],/reg\/B-HLM$/);
  const cache=JSON.parse(await readFile(path.join(dir,'aircraft-cache.json'),'utf8'));
  assert.equal(cache.BHLM.photos[0].photographer,'测试摄影者');
});
test('新增含注册号的航班会在后台预热并缓存资料',async t=>{
  let resolveRequest;const requested=new Promise(resolve=>{resolveRequest=resolve;});
  const {req,dir}=await fixture(t,undefined,{lookupAircraft:true,aircraftFetch:async url=>{resolveRequest(String(url));return Response.json({photos:[]});}});
  const created=await req('/api/trips','POST',{confirmed:true,trips:[trip({registration:'b1234'})]});
  assert.equal(created.status,201);assert.equal(created.data.trips[0].registration,'B-1234');
  assert.match(await requested,/planespotters\.net\/pub\/photos\/reg\/B-1234$/);
  let cache;
  for(let i=0;i<30&&!cache;i++){try{cache=JSON.parse(await readFile(path.join(dir,'aircraft-cache.json'),'utf8'));}catch{}if(!cache)await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(cache.B1234.registration,'B-1234');
});
test('地点校准只写本地 JSON，并校验坐标、确认和静态地图数据',async t=>{
  const {req,dir,url}=await fixture(t);
  assert.equal((await req('/api/places')).data.places['flight|武汉天河'],undefined);
  assert.equal((await req('/api/places','PUT',{key:'flight|武汉天河',lat:30.77,lon:114.21})).status,400);
  assert.equal((await req('/api/places','PUT',{confirmed:true,key:'flight|武汉天河',lat:91,lon:114.21})).status,400);
  assert.equal((await req('/api/places','PUT',{confirmed:true,key:'flight|武汉天河',lat:30.77,lon:114.21})).status,200);
  assert.deepEqual((await req('/api/places')).data.places['flight|武汉天河'],{lat:30.77,lon:114.21});
  assert.deepEqual(JSON.parse(await readFile(path.join(dir,'places.json'),'utf8'))['flight|武汉天河'],{lat:30.77,lon:114.21});
  assert.equal((await fetch(url+'/map-data/places.json')).status,200);
  const page=await fetch(url+'/');
  assert.match(page.headers.get('content-security-policy'),/img-src[^;]*https:/);
  assert.equal((await fetch(url+'/vendor/leaflet.js')).status,200);
  assert.equal((await fetch(url+'/vendor/leaflet.css')).status,200);
  const worker=await fetch(url+'/tile-cache-sw.js');
  assert.equal(worker.status,200);
  assert.match(worker.headers.get('content-security-policy'),/connect-src[^;]*https:\/\/tile\.openstreetmap\.org/);
  assert.equal((await fetch(url+'/map.js')).status,200);
});
