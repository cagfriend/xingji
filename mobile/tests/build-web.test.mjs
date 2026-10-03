import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const run=promisify(execFile);
const mobileRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const www=path.join(mobileRoot,'www');

test('Android web build emits only the local allowlisted frontend',async()=>{
  await run(process.execPath,[path.join(mobileRoot,'build-web.mjs')],{cwd:mobileRoot});
  const index=await readFile(path.join(www,'index.html'),'utf8');
  const stats=await readFile(path.join(www,'stats.html'),'utf8');
  const map=await readFile(path.join(www,'map.js'),'utf8');
  const app=await readFile(path.join(www,'app.js'),'utf8');
  const review=await readFile(path.join(www,'review-form.js'),'utf8');
  assert.match(app,/requireEssentialDrafts\(state.drafts/);
  assert.doesNotMatch(app,/填写航班号和日期后即可确认保存/);
  assert.doesNotMatch(review,/仅航班号和日期必填/);
  assert.match(index,/src="\/bridge\.js"/);
  assert.match(stats,/src="\/bridge\.js"/);
  assert.match(index,/id="cloud-signout"[^>]*hidden/);
  assert.match(index,/id="cloud-data-tools"[^>]*hidden/);
  assert.match(index,/id="cloud-key-notice"[^>]*hidden/);
  assert.match(index,/完整备份不会包含密钥/);
  assert.doesNotMatch(index,/已看过的地图区域|内置全球概览和东亚城市底图|联网补充街道细节/);
  assert.match(map,/root.closest\('\.map-foot'\).hidden=true/);
  assert.doesNotMatch(map,/navigator\.serviceWorker\.register/);
  assert.match(map,/const tileCacheReady=Promise\.resolve\(\)/);

  const paths=[];
  async function collect(dir,base=''){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const relative=path.posix.join(base,entry.name);
      if(entry.isDirectory())await collect(path.join(dir,entry.name),relative);else paths.push(relative);
    }
  }
  await collect(www);
  assert.ok(paths.includes('bridge.js'));
  assert.ok(paths.includes('map-data/places.json'));
  assert.ok(paths.includes('runtime/lib.mjs'));
  assert.ok(paths.includes('runtime/airport-directory.mjs'));
  assert.ok(paths.includes('runtime/aircraft-data.mjs'));
  assert.ok(paths.includes('offline-map/data/basemap.json'));
  assert.match(map,/await installOfflineBasemap\(L,state.map\)/);
  assert.ok(!paths.some(file=>/login|tile-cache-sw|\.bak$|\.tmp$/.test(file)||(/(^|\/)data\//.test(file)&&!file.startsWith('offline-map/data/'))));
  assert.ok(!paths.some(file=>/cloud\//.test(file)));
});

test('mobile bridge covers local API virtualization, SAF backup, compression, and Android back',async()=>{
  const source=await readFile(path.join(mobileRoot,'bridge.mjs'),'utf8');
  assert.match(source,/createLocalService\(/);
  assert.match(source,/service\.handle\(url\.pathname, \{method, body\}\)/);
  assert.match(source,/action:'export'/);
  assert.match(source,/action:'write', name, value\}/);
  assert.match(source,/action:'export', name, value:backup/);
  assert.match(source,/action:'import'/);
  assert.match(source,/service\.exportBackup\(\)/);
  assert.match(source,/service\.importBackup\(backup\)/);
  assert.match(source,/originalCreateImageBitmap\(file,/);
  assert.match(source,/App\.addListener\('backButton'/);
  assert.match(source,/Browser\.open\(\{url:url\.href\}\)/);
  assert.match(source,/CapacitorHttp\.request\(/);
  assert.match(source,/connectTimeout:15000, readTimeout:90000/);
});
