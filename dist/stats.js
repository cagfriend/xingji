import {airlineForFlight,normalizeAircraftType} from './aviation.js';

const $=selector=>document.querySelector(selector);
const node=(tag,className,text)=>{const item=document.createElement(tag);if(className)item.className=className;if(text!=null)item.textContent=text;return item;};
function rank(items,key,label,meta){
  const groups=new Map();
  for(const item of items){const id=key(item);if(!id)continue;const entry=groups.get(id)??{count:0,label:label(item),meta:meta(item)};entry.count++;groups.set(id,entry);}
  return [...groups.values()].sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'zh-CN'));
}
function carrierMark(airline){
  const mark=node('span','carrier-logo ranking-carrier');mark.style.setProperty('--carrier-color',airline.color);mark.title=airline.name;
  if(airline.logo){const image=node('img');image.src=airline.logo;image.alt=airline.name;image.onerror=()=>{image.remove();mark.textContent=airline.code;};mark.append(image);}else mark.textContent=airline.code;
  return mark;
}
function renderRanking(root,entries,{carrier=false,limit=10}={}){
  root.replaceChildren();
  const shown=limit==null?entries:entries.slice(0,limit);
  shown.forEach((entry,index)=>{
    const item=node('li','ranking-item');item.append(node('span','ranking-order',String(index+1).padStart(2,'0')));
    const copy=node('div','ranking-copy');const title=node('strong','',entry.label);if(carrier)title.prepend(carrierMark(entry.airline));copy.append(title,node('span','',entry.meta));item.append(copy,node('span','ranking-count',`${entry.count} 次`));root.append(item);
  });
}
async function load(){
  const response=await fetch('/api/trips',{headers:{'X-Trip-Local':'1'}});
  if(response.redirected||!response.headers.get('content-type')?.includes('application/json')){const error=new Error('登录页面已过期或尚未完成登录，请刷新页面并重新登录。');error.authExpired=true;throw error;}
  let payload={};try{payload=await response.json();}catch{}
  if(response.status===401){const error=new Error('登录状态已失效，请重新登录后再试。');error.authExpired=true;throw error;}
  if(response.status===403)throw new Error('当前登录账号无权访问此项目，请确认使用已授权的账号。');
  if(!response.ok)throw new Error(payload.error||'无法读取行程');return payload.trips??[];
}
const cloud=location.hostname.endsWith('.workers.dev');
try{
  $('.brand small').textContent=cloud?'PERSONAL FLIGHT JOURNAL':'LOCAL TRAVEL JOURNAL';
  document.title=cloud?'历史统计 · 行迹云端':'历史统计 · 行迹';
  $('footer span:last-child').textContent=cloud?'统计仅使用你的云端行程':'统计仅使用本机 JSON 行程';
  const trips=(await load()).filter(trip=>trip.type==='flight');
  $('#stats-summary').replaceChildren(node('strong','',`${trips.length}`),node('span','','次历史飞行'));
  if(!trips.length){$('#stats-grid').hidden=true;$('#stats-empty').hidden=false;}
  const routes=rank(trips,trip=>`${trip.departure}|${trip.arrival}`,trip=>`${trip.departure||'待补充'} → ${trip.arrival||'待补充'}`,()=> '航班');
  const airlines=rank(trips,trip=>airlineForFlight(trip.code).code,trip=>airlineForFlight(trip.code).name,trip=>airlineForFlight(trip.code).code);
  for(const entry of airlines)entry.airline=airlineForFlight(entry.meta);
  const aircraft=rank(trips.filter(trip=>trip.aircraftType),trip=>normalizeAircraftType(trip.aircraftType),trip=>normalizeAircraftType(trip.aircraftType),()=> '基础型号');
  renderRanking($('#route-ranking'),routes);renderRanking($('#airline-ranking'),airlines,{carrier:true,limit:null});renderRanking($('#aircraft-ranking'),aircraft,{limit:null});
}catch(error){if(cloud&&error.authExpired){location.replace('/login');}else{$('#stats-grid').hidden=true;$('#stats-empty').hidden=false;$('#stats-empty').querySelector('h3').textContent='统计暂时无法读取';$('#stats-empty').querySelector('p').textContent=error.message;}}
