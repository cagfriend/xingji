import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../dist/tile-cache-sw.js',import.meta.url),'utf8');
const TILE='https://tile.openstreetmap.org/5/28/14.png';
const png=(headers={})=>new Response('png',{status:200,headers:{'content-type':'image/png',...headers}});
const cachedPng=(until,staleUntil=until,headers={})=>new Response('cached png',{status:200,headers:{'content-type':'image/png','x-xingji-cache-until':String(until),'x-xingji-stale-until':String(staleUntil),...headers}});

function harness({fetcher,now=1_000_000,entries=new Map(),cacheNames=[]}={}){
  const listeners={};let downloads=0;let deletes=0;let puts=0;let clock=now;const deletedCaches=[];
  class ClockDate extends Date{static now(){return clock;}}
  const cache={
    match:async request=>entries.get(request.url),
    put:async(request,response)=>{puts++;entries.set(request.url,response);},
    delete:async request=>{deletes++;return entries.delete(request.url);}
  };
  const context={
    self:{addEventListener:(name,handler)=>listeners[name]=handler,skipWaiting:async()=>{},clients:{claim:async()=>{}}},
    caches:{open:async()=>cache,keys:async()=>cacheNames,delete:async name=>{deletedCaches.push(name);return true;}},
    fetch:async request=>{downloads++;return fetcher?fetcher(request,downloads):png({'cache-control':'public, max-age=3600'});},
    Response,Headers,URL,Date:ClockDate
  };
  vm.runInNewContext(source,context);
  async function request(url=TILE,{destination='image',method='GET'}={}){
    let answer;const work=[];
    listeners.fetch({request:{url,destination,method},respondWith:promise=>answer=promise,waitUntil:promise=>work.push(promise)});
    if(!answer)return null;
    const response=await answer;await Promise.all(work);return response;
  }
  return {request,entries,deletedCaches,get downloads(){return downloads;},get deletes(){return deletes;},get puts(){return puts;},setNow(value){clock=value;},async activate(){let pending;listeners.activate({waitUntil:promise=>pending=promise});await pending;}};
}

test('只拦截页面实际请求的 OSM PNG 瓦片，不预取或处理其他资源',async()=>{
  const worker=harness();
  assert.equal(await worker.request('https://example.com/5/28/14.png'),null);
  assert.equal(await worker.request(TILE,{destination:'script'}),null);
  assert.equal(await worker.request(TILE,{method:'POST'}),null);
  assert.equal(await worker.request('https://tile.openstreetmap.org/5/28/14.jpg'),null);
  assert.equal(worker.downloads,0);
  assert.match(source,/const CACHE_NAME='xingji-osm-tiles-v1'/,'保留现有缓存名，不触发瓦片缓存迁移或清空');
  assert.match(source,/FALLBACK_TTL=7\*24\*60\*60\*1000/,'保留最多七天的本地兜底期限');
  assert.doesNotMatch(source,/cache.?bust|no-cache=[0-9]|Referer/i,'不绕过缓存，也不伪造来源头');
  const activation=harness({cacheNames:['xingji-osm-tiles-v1','xingji-osm-tiles-v0']});
  await activation.activate();assert.deepEqual(activation.deletedCaches,[],'Service Worker 更新保留已有版本中的合法瓦片');
});

test('只缓存成功的 PNG；403、429、HTML 和其他错误响应不会被缓存',async()=>{
  for(const [name,response] of [
    ['403',new Response('blocked',{status:403,headers:{'content-type':'text/plain'}})],
    ['429',new Response('rate limited',{status:429,headers:{'content-type':'text/plain'}})],
    ['HTML',new Response('<html>blocked</html>',{status:200,headers:{'content-type':'text/html'}})],
    ['500',new Response('server error',{status:500,headers:{'content-type':'image/png'}})]
  ]){
    const worker=harness({fetcher:async()=>response.clone()});
    const result=await worker.request();
    assert.equal(result.status,response.status,name);
    assert.equal(worker.entries.size,0,`${name} 不应写入 Cache Storage`);
    assert.equal(worker.puts,0);
  }
  const good=harness();await good.request();
  assert.equal(good.entries.size,1,'成功的 image/png 瓦片仍缓存');
  assert.equal(good.puts,1);
});

test('缓存命中验证状态、PNG 类型和 no-store；损坏旧缓存会被清除后重新获取',async()=>{
  const invalid=new Map([[TILE,new Response('forbidden',{status:403,headers:{'content-type':'image/png','x-xingji-cache-until':'9999999'}})]]);
  const worker=harness({entries:invalid});
  const result=await worker.request();
  assert.equal(result.status,200);
  assert.equal(await result.text(),'png');
  assert.equal(worker.deletes,1);
  assert.equal(worker.downloads,1);

  const htmlCache=new Map([[TILE,new Response('<html>',{status:200,headers:{'content-type':'text/html','x-xingji-cache-until':'9999999'}})]]);
  const htmlWorker=harness({entries:htmlCache,fetcher:async()=>new Response('blocked',{status:403})});
  assert.equal((await htmlWorker.request()).status,403);
  assert.equal(htmlWorker.deletes,1);
  assert.equal(htmlWorker.entries.size,0);

  const noStoreCache=new Map([[TILE,cachedPng(9999999,9999999,{'cache-control':'no-store'})]]);
  const noStoreWorker=harness({entries:noStoreCache});
  assert.equal((await noStoreWorker.request()).status,200);
  assert.equal(noStoreWorker.deletes,1);
  assert.equal(noStoreWorker.downloads,1);
});

test('尊重 max-age、Age、Expires、no-cache、no-store 与默认七天上限',async()=>{
  const start=1_000_000;
  const maxAge=harness({now:start,fetcher:async()=>png({'cache-control':'public, max-age="60"','age':'5'})});
  await maxAge.request();
  assert.equal(Number(maxAge.entries.get(TILE).headers.get('x-xingji-cache-until')),start+55_000);
  maxAge.setNow(start+54_999);await maxAge.request();assert.equal(maxAge.downloads,1,'有效期内命中缓存');
  maxAge.setNow(start+55_001);await maxAge.request();assert.equal(maxAge.downloads,2,'过期后正常重新验证');

  const noCache=harness({now:start,fetcher:async()=>png({'cache-control':'no-cache, max-age=600'})});
  await noCache.request();assert.equal(Number(noCache.entries.get(TILE).headers.get('x-xingji-cache-until')),start);
  await noCache.request();assert.equal(noCache.downloads,2,'no-cache 每次请求重新验证');

  const noStore=harness({fetcher:async()=>png({'cache-control':'no-store, max-age=3600'})});
  await noStore.request();await noStore.request();assert.equal(noStore.entries.size,0);assert.equal(noStore.downloads,2);

  const fallback=harness({now:start,fetcher:async()=>png()});
  await fallback.request();assert.equal(Number(fallback.entries.get(TILE).headers.get('x-xingji-cache-until')),start+7*24*60*60*1000);
  assert.match(source,/expires\)\)until=Math\.min\(until,expires\)/,'Expires 不能比 max-age 或七天兜底更晚');
});

test('过期瓦片遇到失败时保留原缓存；stale-if-error 仅在声明窗口内回退到有效 PNG',async()=>{
  const start=5_000_000;
  const worker=harness({now:start,fetcher:async(_request,count)=>count===1?png({'cache-control':'max-age=0, stale-if-error=10'}):new Response('<html>unavailable</html>',{status:503,headers:{'content-type':'text/html'}})});
  await worker.request();const saved=worker.entries.get(TILE);
  const fallback=await worker.request();
  assert.equal(fallback.status,200);assert.match(fallback.headers.get('content-type'),/image\/png/i);
  assert.equal(worker.entries.get(TILE),saved,'上游失败不覆盖旧的有效 PNG');
  worker.setNow(start+10_001);
  const expired=await worker.request();
  assert.equal(expired.status,503,'stale-if-error 窗口外返回上游失败，不无限使用旧缓存');
  assert.equal(worker.entries.get(TILE),saved,'即使超过回退窗口，失败也不主动擦除旧数据');
});

test('仅在网络错误或允许的 5xx 且处于明确 stale-if-error 期限时读取缓存',async()=>{
  const start=9_000_000;
  for(const failure of [new TypeError('offline'),new Response('busy',{status:502})]){
    const entries=new Map([[TILE,cachedPng(start+1,start+1000)]]);
    const worker=harness({now:start+2,entries,fetcher:async()=>{if(failure instanceof Error)throw failure;return failure.clone();}});
    const result=await worker.request();assert.equal(result.status,200);assert.match(result.headers.get('content-type'),/image\/png/i);
  }
  for(const status of [403,429,404]){
    const entries=new Map([[TILE,cachedPng(start+1,start+1000)]]);
    const worker=harness({now:start+2,entries,fetcher:async()=>new Response('error',{status})});
    const result=await worker.request();assert.equal(result.status,status,`${status} 不属于 stale-if-error 可用状态`);
    assert.equal(worker.entries.get(TILE),entries.get(TILE),'失败响应不替换旧缓存');
  }
});
