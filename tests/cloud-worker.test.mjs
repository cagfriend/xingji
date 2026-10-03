import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker,{createWorker} from '../cloud/worker.mjs';
import {createStorage} from '../cloud/storage.mjs';
import {createTestD1} from './helpers/d1.mjs';

const origin='https://trips.example.workers.dev';
const flight={type:'flight',code:'CA1234',date:'2026-09-20',departure:'PEK',arrival:'SHE',aircraftType:'737-8SL'};
async function fixture(t,{fetcher=async()=>new Response('',{status:503})}={}) {
  const {database,binding}=await createTestD1();t.after(()=>database.close());
  const tasks=[];
  const ctx={waitUntil(promise){tasks.push(promise);}};
  const env={DB:binding,AI_API_KEY:'test-only-secret',ASSETS:{fetch:async()=>new Response('<html>test asset</html>',{headers:{'Content-Type':'text/html'}})}};
  const app=createWorker({fetcher,authorize:async()=>({email:'owner@example.com'})});
  const request=async(path,method='GET',payload,headers={})=>app.fetch(new Request(origin+path,{method,headers:{Origin:origin,'X-Trip-Local':'1','Content-Type':'application/json',...headers},...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env,ctx);
  return {env,ctx,app,request,storage:createStorage(binding),tasks};
}
test('cloud rejects unauthenticated APIs and assets, including incomplete setup',async()=>{
  let assetsCalled=false;
  for(const path of ['/','/app.js','/api/trips','/api/export','/api/config','/data/config.json']){
    const r=await worker.fetch(new Request(origin+path),{ASSETS:{fetch(){assetsCalled=true;}}},{waitUntil(){}});
    assert.equal(r.status,503);
    assert.match(r.headers.get('cache-control'),/no-store/);
    assert.equal(r.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
  }
  const r=await worker.fetch(new Request(origin+'/api/trips'),{ACCESS_TEAM_DOMAIN:'test.cloudflareaccess.com',ACCESS_AUD:'aud',OWNER_EMAIL:'owner@example.com'},{waitUntil(){}});
  assert.equal(r.status,401);assert.equal(assetsCalled,false);
});
test('cloud confirmation, persistence, date-based dedup, edit and delete',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/trips','POST',{trips:[flight]})).status,400);
  const saved=await f.request('/api/trips','POST',{confirmed:true,trips:[flight]});
  assert.equal(saved.status,201,await saved.clone().text());
  const trip=(await saved.json()).trips[0];
  assert.ok(trip.id);assert.equal(trip.aircraftType,'波音 737-800');
  const race=await Promise.all([f.request('/api/trips','POST',{confirmed:true,trips:[{...flight,code:'MU1234'}]}),f.request('/api/trips','POST',{confirmed:true,trips:[{...flight,code:'mu 1234'}]})]);
  assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);
  assert.equal((await f.request('/api/trips','POST',{confirmed:true,trips:[{...flight,code:'CA4321'},flight]})).status,409);
  assert.equal((await f.storage.listTrips()).length,2);
  assert.equal((await f.request(`/api/trips/${trip.id}`,'PUT',{confirmed:true,trip:{...flight,seat:'12A'}})).status,200);
  assert.equal((await f.storage.listTrips()).find(t=>t.id===trip.id).seat,'12A');
  assert.equal((await f.request(`/api/trips/${trip.id}`,'DELETE',{})).status,400);
  assert.equal((await f.request(`/api/trips/${trip.id}`,'DELETE',{confirmed:true})).status,200);
  assert.equal((await f.request(`/api/trips/${trip.id}`,'DELETE',{confirmed:true})).status,404);
});
test('cloud secrets never returned, saved via UI, or exported',async t=>{
  const f=await fixture(t);
  const c=await (await f.request('/api/config')).json();
  assert.equal(c.cloud,true);assert.equal(c.apiKey,'');assert.equal(c.hasApiKey,true);
  assert.equal((await f.request('/api/config','PUT',{endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'do-not-store'})).status,400);
  for(const endpoint of ['http://example.com','https://172.16.1.1','https://127.0.0.1','https://example.local','https://user:pass@example.com'])assert.equal((await f.request('/api/config','PUT',{endpoint,model:'x'})).status,400);
  assert.equal((await f.request('/api/config','PUT',{endpoint:'https://api.deepseek.com',model:'deepseek-flash'})).status,200);
  const backup=await f.request('/api/export');
  const text=await backup.text();assert.ok(!text.includes('test-only-secret'));assert.ok(!text.includes('apiKey'));
  assert.equal(JSON.parse(text).version,1);
});
test('cloud CSRF and body type/size checks precede mutation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/trips','POST',{confirmed:true,trips:[flight]},{Origin:'https://attacker.example'})).status,403);
  assert.equal((await f.request('/api/trips','POST',{confirmed:true,trips:[flight]},{'X-Trip-Local':''})).status,403);
  assert.equal((await f.request('/api/trips','POST',{}, {'Content-Type':'text/plain'})).status,415);
  assert.equal((await f.request('/api/trips','POST',{}, {'Content-Length':String(13*1024*1024)})).status,413);
  assert.equal((await f.storage.listTrips()).length,0);
});
test('cloud AI text/images extraction uses server secret and never auto-saves',async t=>{
  let upstream;
  const f=await fixture(t,{fetcher:async(url,init)=>{upstream={url,init};return Response.json({choices:[{message:{content:JSON.stringify({trips:[flight],warnings:[]})}}]});}});
  const response=await f.request('/api/recognize','POST',{text:'测试机票',images:['data:image/png;base64,aGVsbG8='],mode:'ai',referenceDate:'2026-09-28'});
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(upstream.init.headers.Authorization,'Bearer test-only-secret');
  assert.equal(upstream.init.redirect,'manual');
  const input=JSON.parse(upstream.init.body);assert.equal(input.messages[1].content[1].type,'image_url');
  const result=await response.json();assert.match(result.trips[0].departure,/北京.*PEK/);
  assert.equal((await f.storage.listTrips()).length,0);
});
test('cloud cache prewarms saved aircraft and handles registration aliases',async t=>{
  let calls=0;
  const f=await fixture(t,{fetcher:async url=>{
    calls++;
    if(String(url).includes('planespotters'))return Response.json({photos:[{thumbnail:{src:'https://t.plnspttrs.net/photo.jpg'},link:'https://www.planespotters.net/photo/1/example',photographer:'Test Author',aircraft:{hex:'78018D'}}]});
    return Response.json({status:200,reg:'B-HLM',model:'2001 Airbus A330-343',cn:'386',country:'China',mode_s_code:'78018D',link:'https://airport-data.com/aircraft/B-HLM'});
  }});
  assert.equal((await f.request('/api/trips','POST',{confirmed:true,trips:[{...flight,registration:'BHLM'}]})).status,201);
  await Promise.all(f.tasks);
  assert.equal((await f.storage.readJSON('aircraft-cache.json',{})).BHLM.model,'2001 Airbus A330-343');
  const details=await (await f.request('/api/aircraft/B-HLM')).json();assert.equal(details.photos[0].photographer,'Test Author');assert.equal(calls,2);
});
test('cloud import is idempotent, validated, atomic and secret-free',async t=>{
  const f=await fixture(t);
  const snapshot={version:1,trips:[{...flight,id:'local-one',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z'}],places:{},aircraftCache:{},config:{endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'must-not-copy'}};
  const first=await f.request('/api/import','POST',{confirmed:true,snapshot});assert.equal(first.status,200,await first.clone().text());
  const second=await f.request('/api/import','POST',{confirmed:true,snapshot});assert.equal(second.status,200,await second.clone().text());
  assert.equal((await f.storage.listTrips()).length,1);
  const conflicting=structuredClone(snapshot);conflicting.trips[0].seat='15A';conflicting.places['flight|PEK']={lat:1,lon:2};
  assert.equal((await f.request('/api/import','POST',{confirmed:true,snapshot:conflicting})).status,409);
  assert.deepEqual(await f.storage.readJSON('places.json',{}),{});
  const malformed=structuredClone(snapshot);malformed.trips[0].date='2026-99-99';assert.equal((await f.request('/api/import','POST',{confirmed:true,snapshot:malformed})).status,400);
  assert.ok(!(await (await f.request('/api/export')).text()).includes('must-not-copy'));
});
test('cloud daily snapshots retain seven dates and can be downloaded by owner',async t=>{
  const f=await fixture(t);
  await f.request('/api/trips','POST',{confirmed:true,trips:[flight]});
  for(let day=1;day<=9;day++)await f.app.scheduled({scheduledTime:Date.UTC(2026,8,day)},f.env,f.ctx);
  const backups=(await (await f.request('/api/backups')).json()).backups;
  assert.equal(backups.length,7);assert.equal(backups[0],'2026-09-09');
  const snapshot=await (await f.request(`/api/backups/${backups[0]}`)).json();assert.equal(snapshot.trips.length,1);assert.ok(!JSON.stringify(snapshot).includes('test-only-secret'));
  assert.equal((await f.request('/api/backups/2026-09-01')).status,404);
});
