import {initMap,refreshMap} from './map.js';
import {airlineForFlight} from './aviation.js';
const $ = selector => document.querySelector(selector);
const labels = {flight:'航班'};
const state = {trips:[], images:[], drafts:[], editingId:null, deleteId:null, recognizing:false, saving:false, detailRequest:0, cloud:false, authMode:'access'};
const commonNames = ['type','code','date','departure','arrival','departureTime','arrivalDate','arrivalTime'];
const flightNames = ['departureTerminal','arrivalTerminal','actualDepartureDate','actualDepartureTime','actualArrivalDate','actualArrivalTime','aircraftType','registration','ticketPrice','seat'];
const blank = () => Object.fromEntries([...commonNames,...flightNames].map(k=>[k,k==='type'?'flight':'']));
function structuredTrip(t) { return Object.fromEntries([...commonNames,...flightNames].map(k=>[k,t[k]??''])); }
function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; }
async function api(url, options = {}) {
  const response = await fetch(url, {...options, headers:{'Content-Type':'application/json','X-Trip-Local':'1',...options.headers}, ...(options.body ? {body:JSON.stringify(options.body)} : {})});
  if(response.redirected||!response.headers.get('content-type')?.includes('application/json')){
    if(state.cloud||location.hostname.endsWith('.workers.dev'))location.replace('/login');
    throw new Error('登录页面已过期或尚未完成登录，请刷新页面并重新登录。');
  }
  let result={};
  try { result=await response.json(); } catch {}
  if(response.status===401){if(state.cloud||location.hostname.endsWith('.workers.dev'))location.replace('/login');throw new Error('登录状态已失效，请重新登录后再试。');}
  if(response.status===403)throw new Error('当前登录账号无权访问此项目，请确认使用已授权的账号。');
  if (!response.ok) { const error = new Error(result.error || '请求失败'); error.details = result; throw error; }
  return result;
}
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => {$('#toast').hidden = true;}, 3500); }
function localDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
$('#today-label').textContent = new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(new Date());
function key(t) { return t.type==='flight' && t.date && t.code ? `flight|${t.code.normalize('NFKC').toUpperCase().replace(/[\s-]/g,'')}|${t.date}` : null; }
function compareFlightsByDeparture(a,b) {
  const dateOrder=String(b.date??'').localeCompare(String(a.date??''));
  if(dateOrder)return dateOrder;
  const aTime=String(a.departureTime??'').trim(),bTime=String(b.departureTime??'').trim();
  if(!aTime)return bTime?1:0;
  if(!bTime)return -1;
  return bTime.localeCompare(aTime);
}
function airlineMark(code){
  const airline=airlineForFlight(code);const mark=node('span','carrier-logo');mark.title=airline.name;mark.setAttribute('aria-label',airline.name);mark.style.setProperty('--carrier-color',airline.color);
  if(airline.logo){const image=node('img');image.src=airline.logo;image.alt=airline.name;image.onerror=()=>{image.remove();mark.textContent=airline.code;};mark.append(image);}else mark.textContent=airline.code;
  return mark;
}
async function loadTrips() { state.trips = (await api('/api/trips')).trips.filter(t=>labels[t.type]); renderTrips(); }
function detailTable(values) {
  const table=node('dl','map-detail-grid');
  for(const [label,value] of values)table.append(node('dt','',label),node('dd','',value||'—'));
  return table;
}
function openTripDetails(trip) {
  const dialog=$('#trip-detail-dialog');const body=$('#trip-detail-body');const request=++state.detailRequest;
  $('#trip-detail-title').textContent=`航班 ${trip.code}`;body.replaceChildren();
  body.append(detailTable([['日期',trip.date],['起飞机场',trip.departure],['起飞航站楼',trip.departureTerminal],['预计起飞',[trip.date,trip.departureTime].filter(Boolean).join(' ')],['实际起飞',[trip.actualDepartureDate,trip.actualDepartureTime].filter(Boolean).join(' ')],['降落机场',trip.arrival],['降落航站楼',trip.arrivalTerminal],['预计降落',[trip.arrivalDate,trip.arrivalTime].filter(Boolean).join(' ')],['实际降落',[trip.actualArrivalDate,trip.actualArrivalTime].filter(Boolean).join(' ')],['记录机型',trip.aircraftType],['飞机注册号',trip.registration],['票价',trip.ticketPrice],['座位',trip.seat]]));
  const section=node('section','aircraft-info');section.append(node('h3','','飞机资料与照片'));
  const status=node('p','muted aircraft-status',trip.registration?'正在查询飞机资料与 Planespotters 照片…':'该航班没有填写飞机注册号，暂时无法匹配飞机资料。');section.append(status);body.append(section);
  if(!dialog.open)dialog.showModal();
  if(!trip.registration)return;
  api(`/api/aircraft/${encodeURIComponent(trip.registration)}`).then(result=>{
    if(request!==state.detailRequest||!dialog.open)return;
    status.remove();
    const aircraft=result.aircraft;
    const year=Number(aircraft?.model?.match(/\b(?:19|20)\d{2}\b/)?.[0]);const estimatedAge=year?`约 ${new Date().getFullYear()-year} 年（按生产年份估算）`:'';
    const values=[['匹配注册号',aircraft?.registration||result.registration],['机型',aircraft?.model||trip.aircraftType],['生产年份',year?String(year):''],['估算机龄',estimatedAge],['制造序列号',aircraft?.constructorNumber],['登记国家/地区',aircraft?.country],['Mode-S',aircraft?.modeSCode]];
    if(aircraft?.model||aircraft?.constructorNumber||aircraft?.country||aircraft?.modeSCode)section.append(detailTable(values));
    const photos=Array.isArray(result.photos)?result.photos:[];
    if(photos.length){const gallery=node('div','aircraft-photo-gallery');for(const photo of photos){const figure=node('figure','aircraft-photo');const link=node('a');link.href=photo.link;link.target='_blank';link.rel='noopener noreferrer';link.title='在 Planespotters.net 查看原照片';const image=node('img');image.src=photo.image;image.alt=`${result.registration} 飞机照片`;image.loading='lazy';image.referrerPolicy='no-referrer';link.append(image);figure.append(link,node('figcaption','',`© ${photo.photographer} · Planespotters.net`));gallery.append(figure);}section.append(gallery);}
    else {const empty=node('p','muted','暂时没有可显示的照片；');const link=node('a','aircraft-photo-search','在 Planespotters.net 搜索此注册号');link.href=`https://www.planespotters.net/photos/reg/${encodeURIComponent(result.registration||trip.registration)}`;link.target='_blank';link.rel='noopener noreferrer';empty.append(link);section.append(empty);}
    if(aircraft?.sourceUrl){const source=node('a','aircraft-source','飞机资料来源：Airport-Data.com');source.href=aircraft.sourceUrl;source.target='_blank';source.rel='noopener noreferrer';section.append(source);}
    const queried=node('p','aircraft-updated',aircraft?.updatedAt?`资料缓存更新：${new Date(aircraft.updatedAt).toLocaleDateString('zh-CN')}`:'飞机资料尚未匹配到 Airport-Data 记录。');section.append(queried);
  }).catch(error=>{if(request===state.detailRequest&&dialog.open)status.textContent=`飞机资料暂时无法加载：${error.message}`;});
}
$('#close-trip-detail').onclick=()=>{$('#trip-detail-dialog').close();state.detailRequest++;};
function renderTrips() {
  $('#trip-count').textContent = state.trips.length;
  const q = $('#search').value.trim().toLowerCase();
  const registrationQuery=q.toUpperCase().replace(/[^A-Z0-9]/g,'');
  const list = state.trips.filter(t => [t.code,t.departure,t.arrival,t.departureTerminal,t.arrivalTerminal,t.aircraftType,t.registration,t.date].join(' ').toLowerCase().includes(q) || (registrationQuery.length>=3&&String(t.registration||'').toUpperCase().replace(/[^A-Z0-9]/g,'').includes(registrationQuery))).sort(compareFlightsByDeparture);
  const target = $('#trip-list'); target.replaceChildren();
  refreshMap(list);
  if (!list.length) {
    const empty = node('div','empty-state'); empty.append(node('span','empty-symbol','↗'),node('h3','',state.trips.length ? '没有匹配的行程' : '下一程，从这里开始'),node('p','',state.trips.length ? '试试其他关键词或行程类型。' : '在左侧输入行程或添加票据截图。\n识别后核对确认，行程就会出现在这里。')); target.append(empty); return;
  }
  list.forEach(t => {
    const card = node('article','trip-card trip-card-clickable');card.tabIndex=0;card.setAttribute('aria-label',`查看航班 ${t.code} 的详情`);card.setAttribute('aria-haspopup','dialog');card.addEventListener('click',event=>{if(!event.target.closest('button,a'))openTripDetails(t);});card.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&!event.target.closest('button,a')){event.preventDefault();openTripDetails(t);}}); const top = node('div','trip-top');
    const identity = node('div','trip-identity'); if(t.type==='flight')identity.append(airlineMark(t.code)); identity.append(node('span','kind-badge',labels[t.type]),node('span','trip-code',t.code));
    top.append(identity,node('span','trip-date',`${t.date}${t.date < localDate() ? ' · 已过去' : ''}`)); card.append(top);
    const route = node('div','trip-route'); const start = node('div'); start.append(node('div','location',t.departure || '起飞机场未填写'));
    start.append(node('div','terminal',`航站楼 ${t.departureTerminal||'待补充'}`));
    start.append(node('div','time',`预计 ${t.departureTime||'时间待定'}`));
    start.append(node('div','time actual',`实际 ${[t.actualDepartureDate,t.actualDepartureTime].filter(Boolean).join(' ')||'待补充'}`));
    const end = node('div','route-end'); end.append(node('div','location',t.arrival || '降落机场未填写'));
    end.append(node('div','terminal',`航站楼 ${t.arrivalTerminal||'待补充'}`));
    end.append(node('div','time',`预计 ${t.arrivalDate && t.arrivalDate !== t.date ? t.arrivalDate + ' ' : ''}${t.arrivalTime || '时间待定'}`));
    end.append(node('div','time actual',`实际 ${[t.actualArrivalDate,t.actualArrivalTime].filter(Boolean).join(' ')||'待补充'}`));
    route.append(start,node('div','route-arrow','→'),end); card.append(route);
    const footer = node('div','trip-footer'); const details = [`机型：${t.aircraftType||'待补充'}`,`注册号：${t.registration||'待补充'}`,`票价：${t.ticketPrice||'待补充'}`,`座位：${t.seat||'待补充'}`].join(' · '); footer.append(node('div','trip-details',details));
    const actions = node('div','trip-actions'); const edit = node('button','','修改'); edit.onclick = () => openReview([t],[],t.id); const remove = node('button','','移除'); remove.onclick = () => {state.deleteId = t.id; $('#delete-status').textContent=''; $('#delete-dialog').showModal();}; actions.append(edit,remove); footer.append(actions); card.append(footer); target.append(card);
  });
}
$('#search').addEventListener('input',renderTrips);
function downloadJson(value,name){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('#export-button').onclick = async() => {
  if(!state.cloud){downloadJson({version:2,exportedAt:new Date().toISOString(),trips:state.trips.map(t=>({...structuredTrip(t),id:t.id,createdAt:t.createdAt,updatedAt:t.updatedAt}))},`行迹-${localDate()}.json`);return;}
  const button=$('#export-button');button.disabled=true;
  try{const snapshot=await api('/api/export',{headers:{'Accept':'application/json'}});downloadJson(snapshot,`行迹云端备份-${localDate()}.json`);}
  catch(error){toast(error.message);}finally{button.disabled=false;}
};

function readImage(file) { return new Promise((resolve,reject) => {const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file);}); }
let addingImages = false;
async function addImages(files) {
  if (addingImages || state.recognizing) return;
  addingImages = true;
  try {
    const incoming = [...files];
    if (state.images.length + incoming.length > 5) throw new Error('最多添加 5 张图片');
    if (incoming.some(f => !['image/png','image/jpeg','image/webp'].includes(f.type))) throw new Error('请使用 PNG、JPEG 或 WebP 图片');
    if (incoming.some(f => f.size > 8*1024*1024)) throw new Error('每张图片最大 8 MB，请先压缩');
    if (incoming.reduce((s,f)=>s+f.size,0)+state.images.reduce((s,f)=>s+f.size,0)>24*1024*1024) throw new Error('图片总大小不能超过 24 MB');
    const converted = await Promise.all(incoming.map(async f=>({name:f.name,size:f.size,data:await readImage(f)})));
    state.images.push(...converted); renderImages(); $('#capture-status').textContent='';
  } catch(e) {$('#capture-status').textContent=e.message;} finally {addingImages=false; $('#images').value='';}
}
function renderImages() { const container=$('#image-previews'); container.replaceChildren(); state.images.forEach((image,index)=>{const item=node('div','image-preview'); const img=node('img'); img.src=image.data; img.alt=image.name; const remove=node('button','','×'); remove.setAttribute('aria-label',`移除图片 ${image.name}`); remove.onclick=()=>{if(state.recognizing)return;state.images.splice(index,1);renderImages();}; item.append(img,remove);container.append(item);}); }
$('#images').onchange = event => addImages(event.target.files);
const zone=$('#drop-zone'); zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('dragging');}); zone.addEventListener('dragleave',()=>zone.classList.remove('dragging')); zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('dragging');addImages(e.dataTransfer.files);});
$('#recognize-mode').onchange = updatePrivacyNote;
$('#recognize-button').onclick = async () => {
  if (state.recognizing || addingImages) return;
  state.recognizing=true; const button=$('#recognize-button'); button.disabled=true; button.textContent='正在识别，请稍候…'; $('#capture-status').textContent=''; $('#images').disabled=true; $('#manual-button').disabled=true;
  try {
    const requestBody={text:$('#source-text').value,images:state.images.map(x=>x.data),mode:$('#recognize-mode').value,referenceDate:localDate()};
    if(state.cloud&&new TextEncoder().encode(JSON.stringify(requestBody)).byteLength>12*1024*1024)throw new Error('在线版单次上传总量过大，请减少图片或压缩后重试（请求总量上限 12 MB）。');
    const result=await api('/api/recognize',{method:'POST',body:requestBody});
    if (!result.trips.length) throw new Error('没有找到航班行程。请补充航班信息，或使用手动填写。');
    openReview(result.trips,result.warnings);
  } catch(e) {$('#capture-status').textContent=e.message;} finally {state.recognizing=false;button.disabled=false;button.replaceChildren(document.createTextNode('识别并核对 '),node('span','','→'));$('#images').disabled=false;$('#manual-button').disabled=false;}
};
$('#manual-button').onclick = () => openReview([blank()],['这是手动填写模式，请补充出行信息后确认保存。']);

function fieldDefinitions() {
  return [['code','航班号 *','text'],['departure','起飞机场','text'],['departureTerminal','起飞航站楼','text'],['arrival','降落机场','text'],['arrivalTerminal','降落航站楼','text'],['date','预计起飞日期 *','date'],['departureTime','预计起飞时间','time'],['arrivalDate','预计降落日期','date'],['arrivalTime','预计降落时间','time'],['actualDepartureDate','实际起飞日期','date'],['actualDepartureTime','实际起飞时间','time'],['actualArrivalDate','实际降落日期','date'],['actualArrivalTime','实际降落时间','time'],['aircraftType','机型','text'],['registration','飞机注册号','text'],['ticketPrice','票价（金额及币种）','text'],['seat','座位号','text']];
}
function openReview(trips,warnings=[],editingId=null) {
  state.drafts=trips.map(t=>({...blank(),...t}));state.editingId=editingId;
  $('#review-title').textContent=editingId ? '修改行程' : '核对识别结果'; $('#review-warnings').textContent=warnings.join('\n'); $('#review-status').textContent='';$('#add-draft').hidden=!!editingId;
  renderDrafts(); if (!$('#review-dialog').open) $('#review-dialog').showModal();
}
function renderDrafts() {
  const root=$('#review-forms');root.replaceChildren();
  state.drafts.forEach((draft,index)=>{
    const form=node('section','draft-form'); const heading=node('div','draft-heading');heading.append(node('strong','',`行程 ${String(index+1).padStart(2,'0')}`));
    if (!state.editingId) {const remove=node('button','button plain','移除此项');remove.onclick=()=>{state.drafts.splice(index,1);renderDrafts();};heading.append(remove);}form.append(heading);
    const grid=node('div','draft-grid');
    fieldDefinitions().forEach(([name,label,type])=>{
      const wrap=node('label',type==='textarea'?'wide':'',label); let input;
      input=node(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;else input.rows=3;
      input.name=name;input.value=draft[name];input.setAttribute('aria-label',`${label}，行程 ${index+1}`);input.maxLength=5000;
      if(name==='ticketPrice')input.placeholder='例如 680 CNY 或 USD 120';
      if(name==='registration')input.placeholder='例如 B-1234';
      input.addEventListener('input',()=>{draft[name]=input.value;checkDrafts();});wrap.append(input);grid.append(wrap);
    });
    form.append(grid,node('div','draft-error'));root.append(form);
  }); checkDrafts();
}
function checkDrafts() {
  const seen=new Map(state.trips.filter(t=>t.id!==state.editingId).map(t=>[key(t),'已保存']).filter(([k])=>k));let duplicate=false;
  state.drafts.forEach((draft,index)=>{const k=key(draft);const error=$('#review-forms').children[index].querySelector('.draft-error');error.textContent='';if(k&&seen.has(k)){error.textContent=`重复提醒：${draft.code} · ${draft.date} 与${seen.get(k)}行程重复，请修改或移除此项。`;duplicate=true;}else if(k)seen.set(k,'本批次另一条');});
  $('#save-button').disabled=state.saving || duplicate || !state.drafts.length;return duplicate;
}
$('#add-draft').onclick=()=>{state.drafts.push(blank());renderDrafts();};
function closeReview() {if(state.saving)return;$('#review-dialog').close();state.drafts=[];state.editingId=null;}
$('#close-review').onclick=closeReview;$('#cancel-review').onclick=closeReview;
$('#review-dialog').addEventListener('cancel',e=>{if(state.saving)e.preventDefault();});
$('#save-button').onclick=async()=>{
  if (state.saving || !state.drafts.length || checkDrafts()) return;
  state.saving=true;checkDrafts();$('#save-button').textContent='正在保存…';$('#review-status').textContent='';
  try {
    if(state.editingId) await api(`/api/trips/${state.editingId}`,{method:'PUT',body:{confirmed:true,trip:structuredTrip(state.drafts[0])}});
    else await api('/api/trips',{method:'POST',body:{confirmed:true,trips:state.drafts.map(structuredTrip)}});
    const editing=!!state.editingId;$('#review-dialog').close();state.drafts=[];state.editingId=null;
    if(!editing){$('#source-text').value='';state.images=[];renderImages();}
    toast(editing ? '行程已更新' : '行程已保存到本机');
    try {await loadTrips();} catch(e){$('#capture-status').textContent=`保存成功，但列表刷新失败：${e.message}。请刷新页面，不要重复提交。`;}
  }catch(e){$('#review-status').textContent=e.message;if(e.details?.duplicates){try{await loadTrips();}catch{}}}
  finally{state.saving=false;$('#save-button').textContent='确认并保存';checkDrafts();}
};

function setCloudMode(config){
  state.cloud=!!config.cloud;
  state.authMode=config.authMode||'access';
  $('.local-tag').textContent=state.cloud?'Cloudflare 云端':'本机存储';
  $('.brand small').textContent=state.cloud?'PERSONAL FLIGHT JOURNAL':'LOCAL TRAVEL JOURNAL';
  document.title=state.cloud?'行迹 · 云端行程管理':'行迹 · 本地行程管理';
  $('#cloud-data-tools').hidden=!state.cloud;
  $('#api-key-field').hidden=state.cloud;
  $('#local-key-notice').hidden=state.cloud;
  $('#cloud-key-notice').hidden=!state.cloud;
  $('#cloud-import-backup-note').hidden=!state.cloud;
  $('#export-button').textContent=state.cloud?'下载完整云端备份':'导出 JSON';
  $('footer span:last-child').textContent=state.cloud?'Cloudflare 云端存储 · 登录后仅本人可访问':'本地 JSON 存储 · 无数据库';
  $('#api-key').disabled=state.cloud;
  updatePrivacyNote();
  $('#cloud-signout').hidden=!state.cloud;
  $('#cloud-signout').href=state.authMode==='password'?'/login?logout=1':'/cdn-cgi/access/logout';
  $('#delete-dialog-copy').textContent=state.cloud?'行程会从云端列表移除；每日自动备份仍可在设置中下载。':'行程会从当前列表移除。上一次存储文件会保留为本地备份。';
  $('#map-place-copy').textContent=state.cloud?'请输入该机场的 WGS-84 经纬度。校准结果会保存在云端行程中，不会发送至在线地图服务。':'请输入该机场的 WGS-84 经纬度。校准只保存在本机，不会发送至在线地图服务。';
  $('#map-tile-status').textContent=state.cloud?'底图未能加载，请检查网络连接；已保存的航班仍在云端。':'底图未能加载，请检查网络连接；航班数据仍在本机。';
  if(state.cloud)loadBackupHistory();
}
function updatePrivacyNote(){
  const mode=$('#recognize-mode').value;
  $('#privacy-note').textContent=mode==='local'?(state.cloud?'规则识别由你的云端服务处理文字，不调用外部 AI，不支持图片。':'本地规则不发送数据，仅识别简单文字，不支持图片。'):state.cloud?'AI 识别会把本次文字和图片发送至服务器配置的 API；识别结果不会直接保存。单次请求最多 12 MB（含图片编码），超出时请减少图片或压缩。':'AI 识别会将本次文字和图片发送至你配置的 API；识别结果不会直接保存。';
}
$('#settings-button').onclick=async()=>{try{const c=await api('/api/config');setCloudMode(c);$('#api-endpoint').value=c.endpoint||'';$('#api-key').value=state.cloud?'':(c.apiKey||'');$('#api-model').value=c.model||'';$('#settings-status').textContent='';$('#settings-dialog').showModal();}catch(e){toast(e.message);}};
$('#close-settings').onclick=()=>$('#settings-dialog').close();
$('#settings-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{const body={endpoint:$('#api-endpoint').value,model:$('#api-model').value};if(!state.cloud)body.apiKey=$('#api-key').value;await api('/api/config',{method:'PUT',body});$('#settings-dialog').close();toast('API 设置已保存');}catch(error){$('#settings-status').textContent=error.message;}finally{button.disabled=false;}};
function sanitizedSnapshot(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!Array.isArray(value.trips)||!value.places||typeof value.places!=='object'||Array.isArray(value.places)||!value.aircraftCache||typeof value.aircraftCache!=='object'||Array.isArray(value.aircraftCache)||!value.config||typeof value.config!=='object'||Array.isArray(value.config))throw new Error('备份文件格式不正确；请选择行迹云端备份（version 1）。');
  const config={};for(const key of ['endpoint','model','temperature'])if(Object.hasOwn(value.config,key))config[key]=value.config[key];
  return {version:1,trips:value.trips,places:value.places,aircraftCache:value.aircraftCache,config};
}
async function loadBackupHistory(){
  const select=$('#cloud-backup-select');const status=$('#cloud-backup-status');select.replaceChildren(new Option('正在读取备份…',''));$('#cloud-backup-download').disabled=true;status.textContent='';
  try{
    const result=await api('/api/backups');const backups=Array.isArray(result.backups)?result.backups:[];select.replaceChildren();
    for(const backup of backups){const id=typeof backup==='string'?backup:backup?.id;if(typeof id!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(id))continue;select.add(new Option(id,id));}
    if(!select.options.length)select.add(new Option('暂无历史备份',''));
    $('#cloud-backup-download').disabled=!select.value;
  }catch(error){select.replaceChildren(new Option('无法读取备份列表',''));status.textContent=error.message;}
}
$('#cloud-backup-select').onchange=()=>{$('#cloud-backup-download').disabled=!$('#cloud-backup-select').value;};
$('#cloud-backup-download').onclick=async()=>{
  const id=$('#cloud-backup-select').value;if(!/^\d{4}-\d{2}-\d{2}$/.test(id))return;
  const button=$('#cloud-backup-download');button.disabled=true;$('#cloud-backup-status').textContent='';
  try{const snapshot=await api(`/api/backups/${encodeURIComponent(id)}`,{headers:{'Accept':'application/json'}});downloadJson(snapshot,`行迹云端备份-${id}.json`);}
  catch(error){$('#cloud-backup-status').textContent=error.message;}
  finally{button.disabled=!$('#cloud-backup-select').value;}
};
$('#cloud-import-file').onchange=()=>{$('#cloud-import-status').textContent='';};
$('#cloud-import-button').onclick=async()=>{
  const input=$('#cloud-import-file');const file=input.files?.[0];const status=$('#cloud-import-status');
  if(!file){status.textContent='请先选择备份 JSON 文件。';return;}
  if(file.size>12*1024*1024){status.textContent='备份文件不能超过 12 MB。';return;}
  const button=$('#cloud-import-button');button.disabled=true;status.textContent='';
  try{
    let snapshot;try{snapshot=sanitizedSnapshot(JSON.parse(await file.text()));}catch(error){throw error instanceof SyntaxError?new Error('无法读取此 JSON 文件，请确认文件完整。'):error;}
    if(new TextEncoder().encode(JSON.stringify({confirmed:true,snapshot})).byteLength>12*1024*1024)throw new Error('迁移请求不能超过 12 MB。');
    if(!window.confirm(`将备份中的 ${snapshot.trips.length} 条航班和相关资料导入云端。云端现有数据将按服务器规则处理，是否继续？`))return;
    await api('/api/import',{method:'POST',body:{confirmed:true,snapshot}});
    await loadTrips();input.value='';status.textContent='';$('#settings-dialog').close();toast('云端数据导入完成');
  }catch(error){status.textContent=error.message;}
  finally{button.disabled=false;}
};
$('#cancel-delete').onclick=()=>$('#delete-dialog').close();
$('#confirm-delete').onclick=async()=>{const button=$('#confirm-delete');button.disabled=true;try{await api(`/api/trips/${state.deleteId}`,{method:'DELETE',body:{confirmed:true}});$('#delete-dialog').close();toast('行程已移除');try{await loadTrips();}catch(e){$('#capture-status').textContent=`移除成功，但列表刷新失败：${e.message}`;}}catch(e){$('#delete-status').textContent=e.message;}finally{button.disabled=false;}};

// Agent tools can stage information only; saving always stays in the user's review dialog.
if(document.modelContext?.registerTool){
  const lifetime=new AbortController();
  const tools=[{name:'read_local_itineraries',title:'读取本地行程',description:'读取当前本机已保存的行程，不修改内容。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:async input=>{if(!input||typeof input!=='object'||Object.keys(input).length)throw new Error('输入必须是空对象');await loadTrips();return {trips:state.trips};}},
    {name:'stage_itinerary_review',title:'准备待确认航班',description:'在可编辑的确认窗口准备航班，不保存。用户必须在界面中确认保存。',inputSchema:{type:'object',properties:{trips:{type:'array',minItems:1,maxItems:30,items:{type:'object',properties:{...Object.fromEntries([...commonNames,...flightNames].map(k=>[k,{type:'string'}])),type:{type:'string',enum:['flight']}},required:['type'],additionalProperties:false}}},required:['trips'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},execute:async input=>{if(state.saving||$('#review-dialog').open)throw new Error('请先完成当前确认');if(!input||Object.keys(input).some(k=>k!=='trips')||!Array.isArray(input.trips)||!input.trips.length||input.trips.length>30)throw new Error('行程输入无效');if(input.trips.some(t=>!t||typeof t!=='object'||Array.isArray(t)||t.type!=='flight'||Object.entries(t).some(([k,v])=>![...commonNames,...flightNames].includes(k)||typeof v!=='string'||v.length>5000)))throw new Error('字段无效');openReview(input.trips,['这些内容尚未保存，请核对并确认。']);return {staged:input.trips.length,saved:false};}}];
  for(const tool of tools){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifetime.signal})).catch(()=>{});}catch{}}
  window.addEventListener('pagehide',()=>lifetime.abort(),{once:true});
}
async function initialize(){
  try{const config=await api('/api/config');setCloudMode(config);}catch(error){setCloudMode({cloud:location.hostname.endsWith('.workers.dev')});if(error.message.includes('登录')){$('#capture-status').textContent=error.message;return;}}
  await loadTrips();
}
initialize().catch(e=>{$('#capture-status').textContent=e.message;const empty=node('div','empty-state');empty.append(node('h3','','行程数据暂时无法读取'),node('p','',e.message));$('#trip-list').replaceChildren(empty);});
initMap();
