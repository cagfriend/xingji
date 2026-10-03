// Only cache OpenStreetMap tiles that the visible map actually requests.
// Cache Storage is local to this browser profile; no tiles are prefetched.
const CACHE_NAME='xingji-osm-tiles-v1';
const TILE_ORIGIN='https://tile.openstreetmap.org';
const FALLBACK_TTL=7*24*60*60*1000;

self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));

function seconds(directives,name){
  const match=directives.match(new RegExp(`(?:^|,)\\s*${name}=(?:"(\\d+)"|(\\d+))`, 'i'));
  return match?Number(match[1]??match[2]):null;
}
function expiry(response,now){
  const policy=response.headers.get('cache-control')||'';
  if(/(?:^|,)\s*no-store(?:,|$)/i.test(policy))return null;
  const maxAge=seconds(policy,'max-age');
  const expires=Date.parse(response.headers.get('expires')||'');
  const ageMatch=(response.headers.get('age')||'').match(/^\s*(\d+)\s*$/);
  const age=ageMatch?Number(ageMatch[1]):0;
  let until=maxAge===null?(Number.isFinite(expires)?expires:now+FALLBACK_TTL):now+Math.max(0,maxAge-age)*1000;
  if(Number.isFinite(expires))until=Math.min(until,expires);
  if(/(?:^|,)\s*no-cache(?:,|$)/i.test(policy))until=now;
  const staleFor=seconds(policy,'stale-if-error')||0;
  return {until,staleUntil:until+staleFor*1000};
}
function validTile(response){
  return Boolean(response&&response.ok&&response.type!=='opaque'&&/^image\/png(?:\s*;|$)/i.test(response.headers.get('content-type')||''));
}
function cacheWindow(response){
  if(!validTile(response))return null;
  const policy=response.headers.get('cache-control')||'';
  if(/(?:^|,)\s*no-store(?:,|$)/i.test(policy))return null;
  const untilHeader=response.headers.get('x-xingji-cache-until')||'';
  if(!/^\d+$/.test(untilHeader))return null;
  const until=Number(untilHeader);
  const staleUntil=Number(response.headers.get('x-xingji-stale-until'));
  return Number.isFinite(until)?{until,staleUntil:Number.isFinite(staleUntil)?Math.max(until,staleUntil):until}:null;
}
function canUseStale(status){return [500,502,503,504].includes(status);}
async function loadTile(request,event){
  const cache=await caches.open(CACHE_NAME);
  let cached=await cache.match(request);
  const now=Date.now();
  let window=cached&&cacheWindow(cached);
  if(cached&&!window){await cache.delete(request);cached=null;}
  if(cached&&window.until>now)return cached;
  try{
    // Default browser HTTP caching performs conditional revalidation on expiry.
    const response=await fetch(request);
    if(validTile(response)){
      const lifetime=expiry(response,Date.now());
      if(lifetime){
        const headers=new Headers(response.headers);
        headers.set('x-xingji-cache-until',String(lifetime.until));
        headers.set('x-xingji-stale-until',String(lifetime.staleUntil));
        const copy=new Response(response.clone().body,{status:response.status,statusText:response.statusText,headers});
        event.waitUntil(cache.put(request,copy).catch(()=>{}));
      }
    }else if(cached&&window.staleUntil>Date.now()&&canUseStale(response.status)){
      return cached;
    }
    return response;
  }catch(error){
    if(cached&&window.staleUntil>Date.now())return cached;
    throw error;
  }
}
self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method==='GET'&&request.destination==='image'&&url.origin===TILE_ORIGIN&&/^\/\d{1,2}\/\d+\/\d+\.png$/.test(url.pathname)){
    event.respondWith(loadTile(request,event));
  }
});
