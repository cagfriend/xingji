// Explicit owner-authorized smoke check. Secrets remain in memory, never logs.
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {makeLocalSnapshot} from './cloud-import.mjs';

const privateDir=new URL('../cloud-private/',import.meta.url);
const credentials=JSON.parse(await readFile(new URL('login-credentials.json',privateDir),'utf8'));
const origin=credentials.url;
if(new URL(origin).protocol!=='https:' || new URL(origin).origin!==origin)throw new Error('Invalid app origin');
let cookie='';
async function request(route,{method='GET',payload,authenticated=true,headers={}}={}){
  return fetch(origin+route,{method,redirect:'manual',signal:AbortSignal.timeout(25000),headers:{...(authenticated&&cookie?{Cookie:cookie}:{}),...(payload?{'Content-Type':'application/json','X-Trip-Local':'1',Origin:origin}:{}),...headers},...(payload?{body:JSON.stringify(payload)}:{})});
}
async function status(route,expected,options){
  const response=await request(route,options);
  assert.equal(response.status,expected,`${route} returned unexpected status`);
  return response;
}
try{
  const home=await status('/',303,{authenticated:false});assert.equal(home.headers.get('location'),'/login');
  for(const route of ['/login','/login.js','/login.css'])await status(route,200,{authenticated:false});
  for(const route of ['/api/trips','/api/config','/api/export','/app.js','/cloud-private/login-credentials.json','/data/config.json'])await status(route,401,{authenticated:false});
  await status('/auth/login',401,{method:'POST',payload:{password:randomBytes(32).toString('base64url')},authenticated:false});
  const login=await status('/auth/login',200,{method:'POST',payload:{password:credentials.password},authenticated:false});
  const setCookie=login.headers.get('set-cookie') || '';
  for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(setCookie.includes(flag),'Missing secure cookie flag');
  cookie=setCookie.split(';')[0];
  const page=await status('/',200);
  assert.equal(page.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
  const mapScript=await status('/map.js',200);
  assert.ok((await mapScript.text()).includes("referrerPolicy:'strict-origin-when-cross-origin'"));
  const tileWorker=await status('/tile-cache-sw.js',200);
  assert.equal(tileWorker.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
  const appScript=await status('/app.js',200);
  assert.equal(await appScript.text(),await readFile(new URL('../dist/app.js',import.meta.url),'utf8'),'Deployed app differs from verified local app');
  if(process.argv.includes('--password-rotation')){
    const files=(await readdir(privateDir)).filter(name=>/^login-credentials-before-\d+\.json$/.test(name)).sort();
    if(!files.length)throw new Error('Missing prior credentials for rotation check');
    const previous=JSON.parse(await readFile(new URL(files.at(-1),privateDir),'utf8'));
    assert.notEqual(previous.password,credentials.password,'Password was not changed');
    await status('/auth/login',401,{method:'POST',payload:{password:previous.password},authenticated:false});
    console.log('Password rotation verified: new password accepted; previous password rejected.');
  }
  const config=await (await status('/api/config',200)).json();
  assert.equal(config.authMode,'password');assert.equal(config.apiKey,'');assert.equal(config.hasApiKey,true);
  const before=(await (await status('/api/trips',200)).json()).trips;
  const backup=await (await status('/api/export',200)).json();
  assert.equal(backup.trips.length,before.length);
  assert.ok(!Object.hasOwn(backup.config || {},'apiKey'));
  await status('/api/import',403,{method:'POST',payload:{},headers:{Origin:'https://invalid.example'}});
  console.log(`Live password login / private routes / secret isolation / CSRF passed. Existing cloud flights: ${before.length}.`);
  if(process.argv.includes('--crud')){
    let testId;
    const testTrip={type:'flight',code:'ZZ9901',date:'2099-12-31',departure:'PEK',arrival:'SHE',departureTime:'07:00',arrivalTime:'08:40'};
    try{
      const created=await (await status('/api/trips',201,{method:'POST',payload:{confirmed:true,trips:[testTrip]}})).json();
      testId=created.trips[0].id;
      await status('/api/trips',409,{method:'POST',payload:{confirmed:true,trips:[testTrip]}});
      await status(`/api/trips/${testId}`,200,{method:'PUT',payload:{confirmed:true,trip:{...testTrip,seat:'12A'}}});
    }finally{
      if(testId)await status(`/api/trips/${testId}`,200,{method:'DELETE',payload:{confirmed:true}});
    }
    assert.equal((await (await status('/api/trips',200)).json()).trips.length,before.length);
    console.log('Live create / duplicate rejection / edit / delete passed; synthetic test record removed.');
  }
  if(process.argv.includes('--import')){
    const source=new URL('../data/trips.json',import.meta.url);
    const beforeHash=createHash('sha256').update(await readFile(source)).digest('hex');
    const snapshot=await makeLocalSnapshot();
    // Keep a recoverable cloud backup before merging; never overwrite prior backups.
    await writeFile(new URL(`before-import-${Date.now()}.json`,privateDir),JSON.stringify(backup,null,2)+'\n',{flag:'wx',mode:0o600});
    const result=await (await status('/api/import',200,{method:'POST',payload:{confirmed:true,snapshot}})).json();
    const exported=await (await status('/api/export',200)).json();
    const cloudIds=new Set(exported.trips.map(trip=>trip.id));
    for(const trip of snapshot.trips)assert.ok(cloudIds.has(trip.id),'A local flight is missing after import');
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),beforeHash,'Local data changed unexpectedly');
    console.log(`Migration verified: ${snapshot.trips.length} local flights present; cloud total ${exported.trips.length}; added ${result.importedTrips}, already present ${result.alreadyPresent}. Local data unchanged.`);
  }
  if(process.argv.includes('--ai')){
    const count=(await (await status('/api/trips',200)).json()).trips.length;
    const response=await request('/api/recognize',{method:'POST',payload:{text:'2030年1月2日乘坐 CA1234，PEK 至 SHE，07:00 起飞，08:40 到达。',images:[],mode:'ai',referenceDate:'2026-09-28'}});
    if(response.status!==200){const result=await response.json();throw new Error(`Live AI check failed: ${String(result.error).slice(0,180)}`);}
    const result=await response.json();
    assert.ok(result.trips.some(trip=>trip.code==='CA1234'),'AI test flight not recognized');
    assert.equal((await (await status('/api/trips',200)).json()).trips.length,count);
    console.log('Live AI text recognition passed, no flight saved without confirmation.');
  }
  await status('/auth/logout',200,{method:'POST',payload:{}});
  await status('/api/trips',401);
  console.log('Live logout revokes old cookie: passed.');
}finally{
  if(cookie)await request('/auth/logout',{method:'POST',payload:{}}).catch(()=>{});
}
