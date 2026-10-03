import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

test('地图携带真实来源，局部成功不掩盖剩余错误瓦片',async()=>{
  const source=(await readFile(new URL('../dist/map.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/,'').replace(/export /g,'');
  const nodes=new Map(),handlers={};let options,registration;
  const node=selector=>{
    if(!nodes.has(selector))nodes.set(selector,{hidden:true,style:{},classList:{remove(){},add(){}},replaceChildren(){},append(){}});
    return nodes.get(selector);
  };
  const map={setView(){},getZoom(){return 4;},on(){}};
  const context={
    document:{querySelector:node},
    navigator:{serviceWorker:{controller:{},register:async(url,opts)=>{registration={url,opts};return {};}}},
    L:{map:()=>map,control:{zoom:()=>({addTo(){}})},tileLayer:(url,opts)=>{options={url,...opts};return {on:(name,callback)=>{handlers[name]=callback;},addTo(){}};},layerGroup:()=>({addTo(){return this;},clearLayers(){}})},
    fetch:async()=>({json:async()=>({places:{}})}),
    indexPlaces:()=>({}),groupRoutes:()=>({nodes:[],groups:[],unresolved:[]}),mapInfoLevel:()=> 'overview',
  };
  await vm.runInNewContext(source+'\ninitMap();',context);
  assert.equal(options.url,'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(options.referrerPolicy,'strict-origin-when-cross-origin');
  assert.equal(options.crossOrigin,true);
  assert.equal(registration.opts.updateViaCache,'none');
  const failed={coords:{z:5,x:27,y:13},tile:{style:{}}};
  handlers.tileerror(failed);
  assert.equal(failed.tile.style.visibility,'hidden');
  assert.equal(node('#map-tile-status').hidden,false);
  handlers.tileload({coords:{z:5,x:28,y:13}});
  assert.equal(node('#map-tile-status').hidden,false);
  handlers.tileunload(failed);
  assert.equal(node('#map-tile-status').hidden,true);
});

test('内置 Leaflet 支持按瓦片设置来源策略',async()=>{
  const leaflet=await readFile(new URL('../dist/vendor/leaflet.js',import.meta.url),'utf8');
  assert.match(leaflet,/\.referrerPolicy=this\.options\.referrerPolicy/);
});
