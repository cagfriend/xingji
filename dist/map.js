import {placeKey,indexPlaces,groupRoutes,arcLatLngs,mapInfoLevel} from './map-geo.js';

const $=selector=>document.querySelector(selector);
let L=globalThis.L;
async function loadLeaflet(){
  if(L)return L;
  try{await import('/vendor/leaflet.js');L=globalThis.L;}catch{/* initMap renders a friendly failure state below. */}
  return L;
}
const state={indexes:null,overrides:{},trips:[],graph:null,ready:false,place:null,map:null,routes:null,markers:null,hasFitted:false};
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;};
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function compareFlightsByDeparture(a,b){
  const dateOrder=String(b.date??'').localeCompare(String(a.date??''));
  if(dateOrder)return dateOrder;
  const aTime=String(a.departureTime??'').trim(),bTime=String(b.departureTime??'').trim();
  if(!aTime)return bTime?1:0;
  if(!bTime)return -1;
  return bTime.localeCompare(aTime);
}
async function prepareTileCache(){
  if(!('serviceWorker' in navigator))return;
  try{
    const registration=navigator.serviceWorker.register('/tile-cache-sw.js',{updateViaCache:'none'});
    if(navigator.serviceWorker.controller){registration.catch(()=>{});return;}
    await registration;
    if(navigator.serviceWorker.controller)return;
    await Promise.race([
      new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true})),
      new Promise(resolve=>setTimeout(resolve,1200))
    ]);
  }catch{/* The ordinary browser HTTP cache remains available. */}
}
const tileCacheReady=prepareTileCache();

function syncInfoDensity(){
  if(!state.map)return;
  const canvas=$('#map-canvas');
  canvas.classList.remove('map-density-overview','map-density-details');
  canvas.classList.add(`map-density-${mapInfoLevel(state.map.getZoom())}`);
}

function openDetail(trip){
  $('#map-detail-title').textContent=`航班 ${trip.code}`;
  const values=[['日期',trip.date],['起飞机场',trip.departure],['起飞航站楼',trip.departureTerminal],['预计起飞',[trip.date,trip.departureTime].filter(Boolean).join(' ')],['实际起飞',[trip.actualDepartureDate,trip.actualDepartureTime].filter(Boolean).join(' ')],['降落机场',trip.arrival],['降落航站楼',trip.arrivalTerminal],['预计降落',[trip.arrivalDate,trip.arrivalTime].filter(Boolean).join(' ')],['实际降落',[trip.actualArrivalDate,trip.actualArrivalTime].filter(Boolean).join(' ')],['机型',trip.aircraftType],['注册号',trip.registration],['票价',trip.ticketPrice],['座位',trip.seat]];
  const body=$('#map-detail-body');body.replaceChildren();const table=element('dl','map-detail-grid');for(const [label,value] of values)table.append(element('dt','',label),element('dd','',value||'—'));body.append(table);$('#map-detail-dialog').showModal();
}
function openGroup(group){
  if(group.trips.length===1){openDetail(group.trips[0]);return;}
  $('#map-group-title').textContent=`${group.from.name} → ${group.to.name}`;
  const list=$('#map-group-list');list.replaceChildren();for(const trip of group.trips){const button=element('button','map-group-item');button.type='button';button.append(element('strong','',`${trip.code} · ${trip.date}`),element('span','','查看航班详情'));button.onclick=()=>{$('#map-group-dialog').close();openDetail(trip);};list.append(button);}$('#map-group-dialog').showModal();
}
function airportFlightItem(trip){
  const button=element('button','map-group-item');button.type='button';
  button.append(element('strong','',`${trip.code||'航班号待补充'} · ${trip.date||'日期待补充'}`),element('span','',`${trip.departureTime||'—'} → ${trip.arrivalTime||'—'}`));
  button.onclick=()=>{$('#map-airport-dialog').close();openDetail(trip);};
  return button;
}
function openAirport(point){
  const departures=[];const arrivals=[];
  for(const group of state.graph.groups){
    if(group.from.id===point.id)departures.push(...group.trips);
    if(group.to.id===point.id)arrivals.push(...group.trips);
  }
  departures.sort(compareFlightsByDeparture);arrivals.sort(compareFlightsByDeparture);
  $('#map-airport-title').textContent=point.name||point.iata||'机场航班';
  const sections=[['map-airport-departures',departures,'暂无从此机场出发的航班'],['map-airport-arrivals',arrivals,'暂无到达此机场的航班']];
  for(const [id,trips,empty] of sections){const root=$('#'+id);root.replaceChildren();if(trips.length)trips.forEach(trip=>root.append(airportFlightItem(trip)));else root.append(element('p','map-airport-empty',empty));}
  $('#map-airport-dialog').showModal();
}
function fitRoutes(){
  const nodes=state.graph?.nodes??[];
  if(!nodes.length){state.map.setView([34,105],4);syncInfoDensity();return;}
  state.map.fitBounds(L.latLngBounds(nodes.map(point=>[point.lat,point.lon])),{padding:[56,56],maxZoom:10,animate:false});
  syncInfoDensity();
}
function renderRoutes(){
  state.routes.clearLayers();state.markers.clearLayers();
  for(const group of state.graph.groups){
    const points=arcLatLngs(group.from,group.to);
    L.polyline(points,{color:'#315bdf',weight:3.5,opacity:.9,interactive:false}).addTo(state.routes);
    L.polyline(points,{color:'#315bdf',weight:20,opacity:0,className:'map-route-hit',bubblingMouseEvents:false}).on('click',()=>openGroup(group)).addTo(state.routes);
    const middle=points[Math.floor(points.length/2)];
    const codes=group.trips.map(trip=>trip.code).filter(Boolean);
    const label=group.trips.length>1?`${codes[0]} 等 · ${group.trips.length}`:codes[0]||'行程';
    const icon=L.divIcon({className:'route-chip-icon',html:`<span class="route-chip-inner flight">${escapeHTML(label)}</span>`,iconSize:[0,0],iconAnchor:[0,0]});
    L.marker(middle,{icon,title:`${group.from.name} → ${group.to.name}，点击查看${group.trips.length}条行程`,keyboard:true,zIndexOffset:500}).on('click',()=>openGroup(group)).addTo(state.markers);
  }
  for(const point of state.graph.nodes){
    const icon=L.divIcon({className:'map-node-icon',html:`<span class="map-node-dot"></span><span class="map-node-label">${escapeHTML(point.name||point.iata||'地点')}</span>`,iconSize:[14,14],iconAnchor:[7,7]});
    L.marker([point.lat,point.lon],{icon,title:`${point.name||point.iata||'地点'}，点击查看出发和到达航班`,keyboard:true,zIndexOffset:700}).on('click',()=>openAirport(point)).addTo(state.markers);
  }
}
function renderUnresolved(){const root=$('#map-unresolved');root.replaceChildren();if(!state.graph.unresolved.length){root.textContent=state.graph.groups.length?'节点采用机场坐标':' ';return;}root.append(element('span','','待定位：'));for(const place of state.graph.unresolved){const button=element('button','unresolved-place',`${place.name}${place.status==='ambiguous'?'（重名）':''} · 校准`);button.onclick=()=>openPlace(place);root.append(button);}}
function render({fit=false}={}){if(!state.ready)return;state.graph=groupRoutes(state.trips,state.indexes,state.overrides);renderRoutes();renderUnresolved();$('#map-count').textContent=`${state.graph.groups.length} 条航线`;$('#map-empty').hidden=!!state.graph.groups.length;$('#map-empty').textContent=state.trips.length?'没有可绘制的航线，请校准未定位机场。':'保存航班后，航线会出现在地图上。';if(fit||!state.hasFitted){fitRoutes();state.hasFitted=true;}}
function openPlace(place){state.place=place;$('#map-place-title').textContent=`校准 ${place.name}`;$('#place-lat').value='';$('#place-lon').value='';$('#map-place-status').textContent=place.status==='ambiguous'?'该名称对应多个机场，请先核实机场的准确经纬度。':'';$('#map-place-dialog').showModal();}

export async function initMap(){
  if(!await loadLeaflet()){$('#map-empty').textContent='地图组件未能加载，请检查项目文件。';return;}
  state.map=L.map('map-canvas',{zoomControl:false,preferCanvas:false,worldCopyJump:true,minZoom:2,maxZoom:19});
  L.control.zoom({position:'topright',zoomInTitle:'放大地图',zoomOutTitle:'缩小地图'}).addTo(state.map);
  const catalogReady=Promise.all([fetch('/map-data/places.json').then(r=>r.json()),fetch('/api/places').then(r=>r.json())]);
  await tileCacheReady;
  const tile=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,crossOrigin:true,referrerPolicy:'strict-origin-when-cross-origin',attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'});
  const failedTiles=new Set();
  const tileKey=coords=>`${coords.z}/${coords.x}/${coords.y}`;
  const syncTileStatus=()=>{$('#map-tile-status').hidden=failedTiles.size===0;};
  tile.on('tileerror',event=>{
    failedTiles.add(tileKey(event.coords));
    // Some providers return a warning image with an error status: do not repeat
    // that image across the map. Keep the route overlay and failure notice.
    event.tile.style.visibility='hidden';
    syncTileStatus();
  });
  tile.on('tileload',event=>{failedTiles.delete(tileKey(event.coords));syncTileStatus();});
  tile.on('tileunload',event=>{failedTiles.delete(tileKey(event.coords));syncTileStatus();});
  tile.addTo(state.map);
  state.routes=L.layerGroup().addTo(state.map);state.markers=L.layerGroup().addTo(state.map);
  state.map.setView([34,105],4);
  syncInfoDensity();
  state.map.on('zoomend',syncInfoDensity);
  try{const [catalog,stored]=await catalogReady;state.indexes=indexPlaces(catalog);state.overrides=stored.places;state.ready=true;render({fit:true});}
  catch{$('#map-empty').textContent='地点坐标数据暂时无法读取，请检查项目文件。';return;}
  $('#map-fit').onclick=fitRoutes;
  $('#close-map-group').onclick=()=>$('#map-group-dialog').close();$('#close-map-detail').onclick=()=>$('#map-detail-dialog').close();$('#close-map-airport').onclick=()=>$('#map-airport-dialog').close();$('#close-map-place').onclick=()=>$('#map-place-dialog').close();
  $('#map-place-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;$('#map-place-status').textContent='';try{const lat=Number($('#place-lat').value),lon=Number($('#place-lon').value);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)throw new Error('请输入有效的经纬度');const key=placeKey(state.place.type,state.place.name);const res=await fetch('/api/places',{method:'PUT',headers:{'Content-Type':'application/json','X-Trip-Local':'1'},body:JSON.stringify({key,lat,lon,confirmed:true})});const result=await res.json();if(!res.ok)throw new Error(result.error);state.overrides[key]={lat,lon};$('#map-place-dialog').close();render({fit:true});}catch(error){$('#map-place-status').textContent=error.message;}finally{button.disabled=false;}};
}
export function refreshMap(trips){state.trips=trips;render({fit:true});}
