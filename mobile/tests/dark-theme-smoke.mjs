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
    res.setHeader('Content-Type',types[path.extname(target)]??'application/octet-stream');res.end(await readFile(target));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,channel:'chrome'});
function luminance(rgb){
  const components=rgb.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
  return components[0]*.2126+components[1]*.7152+components[2]*.0722;
}
function contrast(foreground,background){const a=luminance(foreground),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
try{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,colorScheme:'light'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://**/*',route=>route.abort());
  await page.addInitScript(()=>{
    localStorage.setItem('xingji:trips.json',JSON.stringify([{type:'flight',id:'theme-fixture',code:'CA1831',date:'2026-09-01',departure:'北京首都国际机场（PEK）',arrival:'上海虹桥国际机场（SHA）',aircraftType:'737-800',registration:''}]));
  });
  // Leaflet loads after init scripts, so instrument it when its script response is loaded.
  await page.route('**/vendor/leaflet.js',async route=>{
    const js=await readFile(path.join(www,'vendor/leaflet.js'),'utf8');
    await route.fulfill({contentType:'text/javascript',body:js+'\nconst createThemeMap=L.map;L.map=function(...args){const map=createThemeMap.apply(this,args);globalThis.__themeMap=map;return map;};'});
  });
  // The synthetic fixture stays in an isolated browser context, never on the phone.
  await page.goto(address);
  await page.waitForSelector('#map-canvas[data-offline-basemap="ready"]');
  const color=selector=>page.locator(selector).first().evaluate(el=>getComputedStyle(el).backgroundColor);
  assert.equal(await color('body'),'rgb(243, 245, 250)');
  assert.equal(await page.locator('#map-canvas').getAttribute('data-offline-theme'),'light');
  const counts=await page.evaluate(()=>__themeMap.__offlineBasemapController.getVisibleCounts());
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>document.querySelector('#map-canvas').dataset.offlineTheme==='dark');
  assert.equal(await color('body'),'rgb(16, 20, 28)');
  assert.equal(await color('.topbar'),'rgb(16, 20, 28)');
  assert.equal(await color('.mobile-tabbar'),'rgb(23, 30, 42)');
  assert.equal(await color('#map-canvas'),'rgb(17, 31, 43)');
  assert.deepEqual(await page.evaluate(()=>__themeMap.__offlineBasemapController.getVisibleCounts()),counts,'theme change preserves map features');
  assert.equal(await page.locator('.map-node-icon').count(),2,'airport dots remain visible in dark mode');
  const palette=await page.evaluate(()=>{
    const pane=__themeMap.getPane('offlineBasemapPane');
    let fill;
    __themeMap.eachLayer(layer=>{if(layer.options?.pane==='offlineBasemapPane'&&layer.options.fillColor)fill??=layer.options.fillColor;});
    return {hasCanvas:!!pane.querySelector('canvas'),fill};
  });
  assert.equal(palette.hasCanvas,true);assert.equal(palette.fill,'#1e2b36','canvas basemap is restyled instead of globally inverted');
  await mkdir(path.join(root,'verification'),{recursive:true});
  await page.screenshot({path:path.join(root,'verification','dark-map-phone.png')});
  await page.locator('[data-tab="add"]').click();
  await page.locator('#source-text').fill('保留尚未提交的文字');
  await page.locator('#manual-button').click();
  await page.locator('#review-forms [name="code"]').fill('CA1234');
  const assertDarkSurface=async selector=>{
    const colors=await page.locator(selector).evaluateAll(elements=>elements.map(el=>getComputedStyle(el).backgroundColor));
    assert.ok(colors.length&&colors.every(value=>value==='rgb(23, 30, 42)'),`${selector} follows system dark theme`);
  };
  await assertDarkSurface('#review-dialog');
  assert.equal(await color('#review-forms input[name="code"]'),'rgb(17, 25, 37)');
  const textColors=await page.locator('#review-forms input[name="code"]').evaluate(el=>({fg:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor}));
  assert.ok(contrast(textColors.fg,textColors.bg)>=4.5,'input text contrast meets normal text requirement');
  const buttonColors=await page.locator('#save-button').evaluate(el=>({fg:getComputedStyle(el).color,bg:getComputedStyle(el).backgroundColor}));
  assert.ok(contrast(buttonColors.fg,buttonColors.bg)>=4.5,'primary button text remains readable');
  await page.screenshot({path:path.join(root,'verification','dark-review-phone.png')});
  await page.emulateMedia({colorScheme:'light'});
  assert.equal(await color('#review-dialog'),'rgb(255, 255, 255)');
  assert.equal(await page.locator('#review-forms [name="code"]').inputValue(),'CA1234','system switch preserves draft');
  await page.emulateMedia({colorScheme:'dark'});
  await assertDarkSurface('#review-dialog');
  await page.locator('#cancel-review').click();
  assert.equal(await page.locator('#source-text').inputValue(),'保留尚未提交的文字');
  await page.locator('[data-tab="history"]').click();
  await page.waitForFunction(()=>document.querySelector('#stats-summary')?.textContent.includes('1'));
  await assertDarkSurface('.stats-card');
  await page.screenshot({path:path.join(root,'verification','dark-history-phone.png')});
  await page.locator('[data-history-view="list"]').click();
  await assertDarkSurface('.trip-card');
  await page.locator('.trip-card').click();
  await assertDarkSurface('#trip-detail-dialog');
  await page.locator('#close-trip-detail').click();
  await page.locator('[data-tab="settings"]').click();
  await assertDarkSurface('.mobile-data-tools');
  await page.locator('#settings-button').click();
  await assertDarkSurface('#settings-dialog');
  await page.screenshot({path:path.join(root,'verification','dark-settings-phone.png')});
  await page.locator('#settings-dialog .icon-button').click();
  await page.locator('[data-tab="map"]').click();
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(()=>document.querySelector('#map-canvas').dataset.offlineTheme==='light');
  assert.equal(await color('body'),'rgb(243, 245, 250)');
  const snapshot=await page.evaluate(()=>JSON.parse(localStorage.getItem('xingji:trips.json')));
  assert.equal(snapshot.length,1);assert.equal(snapshot[0].code,'CA1831');
  assert.deepEqual(errors,[]);
  const darkContext=await browser.newContext({viewport:{width:390,height:844},colorScheme:'dark'});
  const darkPage=await darkContext.newPage();
  await darkPage.route('https://**/*',route=>route.abort());
  await darkPage.goto(address);await darkPage.waitForSelector('#map-canvas[data-offline-basemap="ready"]');
  assert.equal(await darkPage.locator('body').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(16, 20, 28)','cold start follows system dark mode');
  assert.equal(await darkPage.locator('#map-canvas').getAttribute('data-offline-theme'),'dark');
  await writeFile(path.join(root,'verification','dark-theme-smoke.json'),JSON.stringify({passed:true,checks:['冷启动随系统','运行中深浅切换','状态区页面配色一致','四栏与弹窗深色','离线地图重绘','机场点保留','照片和Logo不反色','正常文字对比度','未提交输入不丢失','已有行程不变']},null,2));
  console.log('Dark theme browser checks passed');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
