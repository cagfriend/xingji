import {Capacitor, CapacitorHttp, registerPlugin} from '@capacitor/core';
import {App} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
import {createLocalService} from './local-service.mjs';
import {installMobileShell} from './shell.mjs';

const LocalFiles = registerPlugin('LocalFiles');
const native = Capacitor.isNativePlatform();

async function localRead(name) {
  if (!native) {
    const raw = localStorage.getItem(`xingji:${name}`);
    return raw == null ? null : JSON.parse(raw);
  }
  const result = await LocalFiles.call({action:'read', name});
  if (result?.value == null || result.value === '') return null;
  return typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
}
async function localWrite(name, value) {
  if (!native) { localStorage.setItem(`xingji:${name}`, JSON.stringify(value)); return; }
  await LocalFiles.call({action:'write', name, value});
}

async function nativeRequest({url, method='GET', headers={}, data}) {
  const parsed = new URL(url, location.href);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('仅支持安全的 HTTP(S) 网络请求');
  if (!native) {
    const response = await fetch(url, {method, headers, ...(data === undefined ? {} : {body:typeof data === 'string' ? data : JSON.stringify(data)})});
    return {status:response.status, data:await response.text()};
  }
  const result = await CapacitorHttp.request({url:parsed.href, method, headers, connectTimeout:15000, readTimeout:90000, ...(data === undefined ? {} : {data})});
  return {status:result.status, data:result.data};
}

const placesResponse = await fetch('/map-data/places.json');
if (!placesResponse.ok) throw new Error('机场目录暂时无法读取');
const places = await placesResponse.json();
const service = createLocalService({
  storage:{read:localRead, write:localWrite},
  request:nativeRequest,
  places
});

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init={}) => {
  const rawUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(rawUrl, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return originalFetch(input, init);
  const method = String(init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let body;
  if (init.body != null) {
    if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    else if (init.body instanceof FormData) body = init.body;
    else body = init.body;
  } else if (input instanceof Request && method !== 'GET' && method !== 'HEAD') {
    const text = await input.clone().text();
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  }
  try {
    const payload = await service.handle(url.pathname, {method, body});
    return new Response(JSON.stringify(payload ?? {}), {status:200, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  } catch (error) {
    return new Response(JSON.stringify({error:error.message || '本机数据暂时无法处理', ...(error.details ?? {})}), {status:error.status ?? 500, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
  }
};

function installBackupTools() {
  const exportButton = document.querySelector('#export-button');
  if (exportButton) {
    exportButton.textContent = '导出完整备份';
    exportButton.addEventListener('click', async event => {
      event.preventDefault(); event.stopImmediatePropagation();
      exportButton.disabled = true;
      try {
        const backup = await service.exportBackup();
        const name = `行迹备份-${new Date().toISOString().slice(0,10)}.json`;
        if (native) await LocalFiles.call({action:'export', name, value:backup});
        else {
          const link = document.createElement('a'); link.href=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'})); link.download=name; link.click(); URL.revokeObjectURL(link.href);
        }
        showMessage('完整本机备份已导出（不包含 API Key）。');
      } catch (error) { showMessage(`备份导出失败：${error.message}`); }
      finally { exportButton.disabled=false; }
    }, true);
  }

  const heading = document.querySelector('#mobile-data-tools') ?? document.querySelector('.list-heading');
  if(exportButton && heading)heading.append(exportButton);
  if (!heading || document.querySelector('#import-backup-button')) return;
  const button = document.createElement('button'); button.id='import-backup-button'; button.type='button'; button.className='button secondary'; button.textContent='导入备份';
  const input=document.createElement('input'); input.type='file'; input.accept='application/json,.json'; input.hidden=true; input.id='mobile-backup-input';
  button.addEventListener('click', async () => {
    try {
      if (native) {
        const selected = await LocalFiles.call({action:'import'});
        if (selected?.value == null) return;
        const backup = typeof selected.value === 'string' ? JSON.parse(selected.value) : selected.value;
        if (!confirm('导入备份会将其中的行程、地点与飞机资料合并到本机；重复航班会略过。API Key 不会导入。继续吗？')) return;
        const result=await service.importBackup(backup);
        showMessage(`备份已导入：新增 ${result.imported} 条，略过 ${result.skipped} 条。`);
        setTimeout(()=>location.reload(),500);
      } else input.click();
    } catch (error) { showMessage(`备份导入失败：${error.message}`); }
  });
  input.addEventListener('change', async () => {
    const file=input.files?.[0]; if(!file)return;
    try {
      if(file.size>12*1024*1024) throw new Error('备份文件不能超过 12 MB');
      const backup=JSON.parse(await file.text());
      if(!confirm('导入备份会将其中的数据合并到本机；重复航班会略过。API Key 不会导入。继续吗？'))return;
      const result=await service.importBackup(backup);
      showMessage(`备份已导入：新增 ${result.imported} 条，略过 ${result.skipped} 条。`);
      setTimeout(()=>location.reload(),500);
    } catch(error) { showMessage(`备份导入失败：${error.message}`); }
    finally { input.value=''; }
  });
  heading.append(button,input);
}

function showMessage(message) {
  let status=document.querySelector('#mobile-backup-status');
  if(!status){status=document.createElement('p');status.id='mobile-backup-status';status.className='status';(document.querySelector('#mobile-data-tools') ?? document.querySelector('.list-heading'))?.after(status);}
  status.textContent=message;
}

function installImageCompression() {
  const originalCreateImageBitmap=globalThis.createImageBitmap?.bind(globalThis);
  if (!originalCreateImageBitmap) return;
  const input=document.querySelector('#images');
  let dispatchingCompressedFiles=false;
  input?.addEventListener('change', async event => {
    // The app's own handler is retained; this hook only compresses oversized files before that handler reads them.
    if(dispatchingCompressedFiles)return;
    const files=[...(input.files ?? [])];
    if(!files.some(file=>file.size>2*1024*1024))return;
    event.preventDefault();event.stopImmediatePropagation();
    const converted=[];
    try {
      for(const file of files){
        if(file.size<=2*1024*1024){converted.push(file);continue;}
        const bitmap=await originalCreateImageBitmap(file,{resizeWidth:1600,resizeQuality:'high'});
        const scale=Math.min(1,1600/bitmap.width,1600/bitmap.height);
        const width=Math.max(1,Math.round(bitmap.width*scale));
        const height=Math.max(1,Math.round(bitmap.height*scale));
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        canvas.getContext('2d',{alpha:false}).drawImage(bitmap,0,0,width,height);bitmap.close?.();
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.78));
        if(!blob)throw new Error('图片压缩失败');
        converted.push(new File([blob],file.name.replace(/\.[^.]+$/,'')+'.jpg',{type:'image/jpeg',lastModified:file.lastModified}));
      }
      const transfer=new DataTransfer();converted.forEach(file=>transfer.items.add(file));
      input.files=transfer.files;
      dispatchingCompressedFiles=true;
      input.dispatchEvent(new Event('change',{bubbles:true}));
      dispatchingCompressedFiles=false;
    } catch(error) { showMessage(`图片压缩失败：${error.message}`); }
  }, {capture:true});
}

function installExternalLinks() {
  document.addEventListener('click', async event => {
    const link=event.target.closest('a[href]'); if(!link)return;
    let url; try { url=new URL(link.href,location.href); } catch { return; }
    if(!['http:','https:'].includes(url.protocol)||url.origin===location.origin)return;
    if(!native)return;
    event.preventDefault();
    try { await Browser.open({url:url.href}); } catch { showMessage('无法打开外部链接，请检查系统浏览器。'); }
  });
}

function installAndroidBack() {
  if(!native)return;
  App.addListener('backButton', () => {
    const dialogs=[...document.querySelectorAll('dialog[open]')];
    if(dialogs.length){const dialog=dialogs[dialogs.length-1];if(dialog.dispatchEvent(new Event('cancel',{cancelable:true})))dialog.close();return;}
    if(shell.getTab()!=='map'){shell.selectTab('map');return;}
    App.exitApp();
  });
}

const shell = installMobileShell();
installBackupTools();
installImageCompression();
installExternalLinks();
installAndroidBack();

await import('./app.js');
