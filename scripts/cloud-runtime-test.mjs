// Exercises the production bundle in Cloudflare's local runtime, with ephemeral
// D1 storage and synthetic signed Access tokens. Never reads personal data.
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {generateKeyPairSync,sign} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wranglerRequire=createRequire(await realpath(path.join(root,'node_modules/wrangler/package.json')));
const {Miniflare,convertV4MiniflareOptions,Response:RuntimeResponse}=wranglerRequire('miniflare');
const origin='https://test.example.workers.dev';
const issuer='https://runtime-test.cloudflareaccess.com';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'runtime-key',alg:'RS256',use:'sig'};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function token(email='owner@example.com') {
  const unsigned=`${encode({alg:'RS256',kid:jwk.kid})}.${encode({iss:issuer,aud:['runtime-audience'],email,exp:Math.floor(Date.now()/1000)+3600})}`;
  return `${unsigned}.${sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url')}`;
}
const mf=new Miniflare(convertV4MiniflareOptions({
  modules:true,
  scriptPath:path.join(root,'cloud-build/worker.js'),
  compatibilityDate:'2026-09-01',
  host:'127.0.0.1',port:0,cf:false,
  bindings:{ACCESS_TEAM_DOMAIN:'runtime-test.cloudflareaccess.com',ACCESS_AUD:'runtime-audience',OWNER_EMAIL:'owner@example.com',AI_API_KEY:'runtime-fake-key'},
  d1Databases:['DB'],
  assets:{directory:path.join(root,'dist'),binding:'ASSETS',run_worker_first:true,routerConfig:{has_user_worker:true}},
  outboundService:async request=>{
    console.log('Runtime mock request:',request.url);
    if(request.url===`${issuer}/cdn-cgi/access/certs`)return RuntimeResponse.json({keys:[jwk]});
    return new RuntimeResponse('External calls disabled in runtime smoke test',{status:503});
  }
}));
const auth=token();
const request=(route,{method='GET',body,jwt=auth,originHeader=origin}={})=>mf.dispatchFetch(origin+route,{method,headers:{...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{}),'Content-Type':'application/json','X-Trip-Local':'1',Origin:originHeader},...(body?{body:JSON.stringify(body)}:{})});
try {
  const db=await mf.getD1Database('DB');
  const sql=(await readFile(path.join(root,'cloud/migrations/0001_initial.sql'),'utf8')).replace(/^--.*$/mg,'');
  for(const statement of sql.split(';').filter(s=>s.trim()))await db.prepare(statement).run();
  for(const route of ['/','/app.js','/api/trips','/api/export']){const response=await request(route,{jwt:null});assert.equal(response.status,401,`${route}: ${await response.text()}`);}
  const stranger=await request('/api/trips',{jwt:token('stranger@example.com')});assert.equal(stranger.status,403,await stranger.text());
  const home=await request('/');assert.equal(home.status,200,await home.clone().text());assert.match(await home.text(),/行迹/);
  assert.equal((await request('/data/config.json')).status,404);
  assert.equal((await request('/cloud-private/cloud-migration-snapshot.json')).status,404);
  const config=await (await request('/api/config')).json();assert.equal(config.cloud,true);assert.equal(config.apiKey,'');
  const flight={type:'flight',code:'CA1234',date:'2026-09-28',departure:'PEK',arrival:'SHE'};
  const payload={confirmed:true,trips:[flight]};
  assert.equal((await request('/api/trips',{method:'POST',body:payload,originHeader:'https://stranger.example'})).status,403);
  const saved=await request('/api/trips',{method:'POST',body:payload});assert.equal(saved.status,201,await saved.clone().text());
  const trip=(await saved.json()).trips[0];assert.ok(trip.id);
  assert.equal((await request('/api/trips',{method:'POST',body:payload})).status,409);
  const backup=await (await request('/api/export')).json();assert.equal(backup.trips.length,1);assert.ok(!JSON.stringify(backup).includes('runtime-fake-key'));
  assert.equal((await request('/api/import',{method:'POST',body:{confirmed:true,snapshot:backup}})).status,200);
  assert.equal((await request(`/api/trips/${trip.id}`,{method:'DELETE',body:{confirmed:true}})).status,200);
  assert.equal((await (await request('/api/trips')).json()).trips.length,0);
  console.log('Cloudflare runtime smoke test passed: signed Access authentication, private assets, D1 create/dedup/export/import/delete, CSRF and secret isolation.');
} finally { await mf.dispose(); }
