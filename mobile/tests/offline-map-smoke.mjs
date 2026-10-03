import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/tjp/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const www=path.join(root,'www');
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const target=path.resolve(www,'.'+(pathname==='/'?'/index.html':pathname));
    if(!target.startsWith(www+path.sep))throw new Error('outside');
    res.setHeader('Content-Type',types[path.extname(target)]??'application/octet-stream');
    res.end(await readFile(target));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:'chrome'});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage();const errors=[];let externalRequests=0;
 page.on('pageerror',error=>errors.push(error.message));
 // No provider is contacted: even the first launch has no remote assets.
 await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==address){externalRequests++;await route.abort();return;}
   if(url.pathname==='/vendor/leaflet.js'){
     const source=await readFile(path.join(www,'vendor/leaflet.js'),'utf8');
     await route.fulfill({contentType:'text/javascript',body:source+'\nconst captureMap=globalThis.L.map;globalThis.L.map=(...args)=>{globalThis.__testMap=captureMap(...args);return globalThis.__testMap;};'});
     return;
   }
   await route.continue();
 });
 const startup=Date.now();
 await page.goto(address);
 await page.waitForSelector('#map-canvas[data-offline-basemap="ready"]');
 const startupMs=Date.now()-startup;
 assert.equal(await page.locator('#map-offline-toggle').getAttribute('aria-pressed'),'true');
 assert.equal(externalRequests,0,'fresh offline map performs no external requests');
 assert.equal(await page.locator('#map-tile-status').isVisible(),false);
 assert.equal(await page.locator('.map-foot').isVisible(),false,'requested bottom description removed');
 const dataset=JSON.parse(await readFile(path.join(www,'offline-map/data/basemap.json'),'utf8'));
 const provincialCapitals=['北京','天津','上海','重庆','石家庄','太原','呼和浩特','沈阳','长春','哈尔滨','南京','杭州','合肥','福州','南昌','济南','郑州','武汉','长沙','广州','南宁','海口','成都','贵阳','昆明','拉萨','西安','兰州','西宁','银川','乌鲁木齐','台北','香港','澳门'];
 for(const name of provincialCapitals)assert.ok(dataset.cities.some(c=>c.name===name||c.name===name+'市'),`bundled provincial city ${name}`);
 const views=[['world',20,10,2],['east-asia',35,115,4],['beijing',39.9042,116.4074,9],['tokyo',35.6762,139.6503,9],['seoul',37.5665,126.978,9],['taipei',25.033,121.5654,9],['ulaanbaatar',47.918,106.917,9],['paris',48.8566,2.3522,9],['new-york',40.7128,-74.006,9],['sydney',-33.8688,151.2093,9],['cape-town',-33.9249,18.4241,9],['rio',-22.9068,-43.1729,9],['mumbai',19.076,72.8777,9],['dateline',30,179,3]];
 await mkdir(path.join(root,'verification'),{recursive:true});
 const checked=[];
 for(const [name,lat,lon,zoom] of views){
   await page.evaluate(({lat,lon,zoom})=>{globalThis.__testMap.setView([lat,lon],zoom,{animate:false});},{lat,lon,zoom});
   await page.waitForTimeout(150);
   assert.equal(await page.locator('#map-canvas').getAttribute('data-offline-basemap'),'ready');
   assert.ok(await page.locator('.leaflet-pane').count()>3);
   const counts=await page.evaluate(()=>globalThis.__testMap.__offlineBasemapController.getVisibleCounts());
   assert.ok(counts.countries>0,`${name} has visible country geometry`);
   if(zoom===9){assert.ok(counts.cities>0,`${name} has city labels`);assert.ok(counts.roads>0,`${name} has road data`);assert.ok(counts.urban>0,`${name} has urban data`);}
   await page.screenshot({path:path.join(root,'verification',`offline-${name}.png`)});
   checked.push({name,counts});
 }
 await page.locator('#map-offline-toggle').click();
 await page.waitForFunction(()=>!document.querySelector('#map-tile-status').hidden);
 assert.ok(externalRequests>0,'online mode can request detailed tiles');
 assert.equal(await page.locator('#map-canvas').getAttribute('data-offline-basemap'),'ready','failed detailed tiles preserve offline layer');
 await page.locator('#map-offline-toggle').click();
 assert.equal(await page.locator('#map-tile-status').isVisible(),false);
 await page.locator('[data-tab="history"]').click();
 await page.locator('[data-tab="map"]').click();
 assert.equal(await page.locator('#map-canvas').getAttribute('data-offline-basemap'),'ready');
 await page.reload();
 await page.waitForSelector('#map-canvas[data-offline-basemap="ready"]');
 assert.equal(await page.locator('#map-offline-toggle').getAttribute('aria-pressed'),'true','mode persists');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'small screen fits');
 assert.deepEqual(errors,[]);
 const report={passed:true,startupMs,views:checked,provincialCities:provincialCapitals.length,cities:dataset.cities.length,checks:['first launch zero external requests','bottom description removed','packaged province-capital coverage','worldwide city roads and urban areas','online failure preserves basemap','offline/online mode persistence','tab switching','no page errors']};
 await writeFile(path.join(root,'verification','offline-map-smoke.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
