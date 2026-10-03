import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const mobileRoot=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(mobileRoot,'..');
const dist=path.join(projectRoot,'dist');
const www=path.join(mobileRoot,'www');
await rm(www,{recursive:true,force:true});
await mkdir(www,{recursive:true});

const files=[
  'index.html','stats.html','app.js','stats.js','aviation.js','map.js','map-geo.js',
  'style.css','aircraft.css','favicon.svg','vendor/leaflet.js','vendor/leaflet.css',
  'map-data/places.json'
];
for(const file of files){
  const target=path.join(www,file);
  await mkdir(path.dirname(target),{recursive:true});
  await cp(path.join(dist,file),target);
}
// Public-domain basemap, bundled in the APK (not a cache of public OSM tiles).
await cp(path.join(mobileRoot,'offline-map'),path.join(www,'offline-map'),{recursive:true});
await cp(path.join(mobileRoot,'review-form.js'),path.join(www,'review-form.js'));
for(const file of await readdir(path.join(dist,'airlines'))){
  if(/^[A-Z0-9]{2}\.(?:png|svg)$/.test(file)){
    await mkdir(path.join(www,'airlines'),{recursive:true});
    await cp(path.join(dist,'airlines',file),path.join(www,'airlines',file));
  }
}

// Retain the portable local service sources beside the bundled web entry for auditability.
await mkdir(path.join(www,'runtime'),{recursive:true});
for(const file of ['lib.mjs','airport-directory.mjs','aircraft-data.mjs']){
  await cp(path.join(projectRoot,file),path.join(www,'runtime',file));
}

let index=await readFile(path.join(www,'index.html'),'utf8');
index=index.replace(/<div id="local-key-notice"[^>]*>[\s\S]*?<\/div>/,'<p id="local-key-notice" class="notice">API Key 仅保存在本机；完整备份不会包含密钥。</p>');
index=index.replace('<span>已看过的地图区域缓存在本机浏览器 · 新区域仍需联网 · 弧线仅作航线示意</span>','');
index=index.replace('<div class="map-foot">','<div class="map-foot" hidden>');
index=index.replace('底图未能加载，请检查网络连接；航班数据仍在本机。','联网细节暂不可用，继续显示内置离线底图。');
index=index.replace('<div class="map-legend">','<div class="map-legend"><button id="map-offline-toggle" type="button" aria-pressed="false">仅离线底图</button>');
index=index.replace('；地图资料：','；离线底图：<a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noopener noreferrer">Natural Earth</a>（概览级）；联网地图：');
index=index.replace('</head>','<link rel="stylesheet" href="/offline-map/layer.css">\n</head>');
index=index.replace('<script type="module" src="/app.js"></script>','<script type="module" src="/bridge.js"></script>');
await writeFile(path.join(www,'index.html'),index);

let stats=index.replace('<body>','<body data-initial-tab="history">');
await writeFile(path.join(www,'stats.html'),stats);

let map=await readFile(path.join(www,'map.js'),'utf8');
map="import {installOfflineBasemap} from './offline-map/layer.js';\n"+map;
map=map.replace(/async function prepareTileCache\(\)\{[\s\S]*?\n\}\nconst tileCacheReady=prepareTileCache\(\);/,"async function prepareTileCache(){return;}\nconst tileCacheReady=Promise.resolve();");
map=map.replace('  const tile=L.tileLayer(', '  state.map.setView([34,105],4);\n  await installOfflineBasemap(L,state.map);\n  const tile=L.tileLayer(');
// The map footer is only needed for unresolved-airport calibration, not general copy.
map=map.replace("root.textContent=state.graph.groups.length?'节点采用机场坐标':' ';return;", "root.textContent='';root.closest('.map-foot').hidden=true;return;");
map=map.replace("root.append(element('span','','待定位：'));", "root.closest('.map-foot').hidden=false;root.append(element('span','','待定位：'));");
map=map.replace('  tile.addTo(state.map);', `  const modeButton=$('#map-offline-toggle');
  let offlineOnly=localStorage.getItem('xingji:offline-map-only')!=='false';
  const applyTileMode=()=>{
    modeButton.setAttribute('aria-pressed',String(offlineOnly));
    modeButton.textContent=offlineOnly?'启用联网细节':'仅离线底图';
    if(offlineOnly){if(state.map.hasLayer(tile))state.map.removeLayer(tile);failedTiles.clear();syncTileStatus();}
    else if(!state.map.hasLayer(tile))tile.addTo(state.map);
  };
  modeButton.onclick=()=>{offlineOnly=!offlineOnly;localStorage.setItem('xingji:offline-map-only',String(offlineOnly));applyTileMode();};
  applyTileMode();`);
// A hidden tab has no dimensions. Defer fitting until the map is actually visible.
map=map.replace('if(fit||!state.hasFitted){fitRoutes();state.hasFitted=true;}', 'if(fit||!state.hasFitted){if(document.querySelector("#map-canvas").offsetWidth){fitRoutes();state.hasFitted=true;}else state.hasFitted=false;}');
map += '\nwindow.addEventListener("xingji:map-visible",()=>{if(!state.map)return;state.map.invalidateSize({pan:false});if(state.ready&&!state.hasFitted){fitRoutes();state.hasFitted=true;}});\n';
await writeFile(path.join(www,'map.js'),map);

let app=await readFile(path.join(www,'app.js'),'utf8');
app="import {simplifyReviewForm,requireEssentialDrafts} from './review-form.js';\n"+app;
const reviewAnchor="    form.append(grid,node('div','draft-error'));root.append(form);";
if(!app.includes(reviewAnchor))throw new Error('Review form source changed; minimal form adaptation must be updated');
app=app.replace(reviewAnchor,"    simplifyReviewForm(grid,draft);\n"+reviewAnchor);
app=app.replace("['date','预计起飞日期 *','date']","['date','航班日期 *','date']");
app=app.replace("openReview([blank()],['这是手动填写模式，请补充出行信息后确认保存。']);","openReview([blank()]);");
const saveAnchor='  if (state.saving || !state.drafts.length || checkDrafts()) return;';
if(!app.includes(saveAnchor))throw new Error('Save handler source changed; required-field reminder must be updated');
app=app.replace(saveAnchor,saveAnchor+"\n  if(!requireEssentialDrafts(state.drafts,$('#review-forms')))return;");
app=app.replace("$('#export-button').textContent=state.cloud?'下载完整云端备份':'导出 JSON';", "$('#export-button').textContent='导出完整备份';");
await writeFile(path.join(www,'app.js'),app);

await build({
  absWorkingDir:mobileRoot,
  entryPoints:[path.join(mobileRoot,'bridge.mjs')],
  outfile:path.join(www,'bridge.js'),
  bundle:true,
  format:'esm',
  platform:'browser',
  target:['es2022'],
  external:['./app.js','./stats.js'],
  sourcemap:false,
  legalComments:'none'
});

const css=await readFile(path.join(mobileRoot,'mobile.css'),'utf8');
await writeFile(path.join(www,'style.css'),`${await readFile(path.join(www,'style.css'),'utf8')}\n${css}\n`);

// Fail closed if this web bundle ever gains a cloud sign-in page or a service worker.
const outputNames=[];
async function collect(dir,base=''){
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const rel=path.posix.join(base,entry.name);
    if(entry.isDirectory())await collect(path.join(dir,entry.name),rel);else outputNames.push(rel);
  }
}
await collect(www);
if(outputNames.some(file=>/^(?:login(?:\.html|\.js|\.css)?|tile-cache-sw\.js)$/.test(file)))throw new Error('Android web bundle unexpectedly contains a cloud login or service worker asset');
console.log(`Android web bundle built: ${outputNames.length} allowlisted files in mobile/www`);
