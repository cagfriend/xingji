export function normalizePlace(value){return String(value??'').normalize('NFKC').trim().toLowerCase().replace(/\b(?:terminal|t)\s*\d+\b/gi,'').replace(/航站楼\s*[a-z]?\d+/gi,'').replace(/[\s·•（）()\-_,，]/g,'').replace(/internationalairport$|airport$|国际机场$|机场$/,'');}
export function placeKey(type,name){return `${type}|${normalizePlace(name)}`;}
export function indexPlaces(catalog){
  const create=items=>{const index=new Map();for(const item of items){for(const alias of item.aliases){const key=normalizePlace(alias);if(!key)continue;if(!index.has(key))index.set(key,[]);if(!index.get(key).some(x=>x.id===item.id))index.get(key).push(item);}}return index;};
  return {flight:create(catalog.airports)};
}
export function resolvePlace(indexes,overrides,type,name){
  const normalized=normalizePlace(name);if(!normalized)return {status:'missing',name,type};
  const manual=overrides?.[placeKey(type,name)];if(manual&&Number.isFinite(manual.lat)&&Number.isFinite(manual.lon))return {status:'resolved',point:{id:`manual:${placeKey(type,name)}`,name,lat:manual.lat,lon:manual.lon,source:'manual'}};
  let candidates=indexes[type]?.get(normalized)??[];
  if(!candidates.length&&type==='flight'){
    const embedded=String(name).toUpperCase().match(/(?:^|\W)([A-Z]{3})(?:$|\W)/);if(embedded)candidates=indexes.flight.get(embedded[1].toLowerCase())??[];
  }
  if(candidates.length===1)return {status:'resolved',point:{...candidates[0],name}};
  return {status:candidates.length?'ambiguous':'unknown',name,type,candidates};
}
export function groupRoutes(trips,indexes,overrides){
  const nodes=new Map(),groups=new Map(),unresolved=new Map();
  for(const trip of trips){if(trip.type!=='flight')continue;const a=resolvePlace(indexes,overrides,'flight',trip.departure);const b=resolvePlace(indexes,overrides,'flight',trip.arrival);
    for(const item of [a,b])if(item.status!=='resolved'&&item.name){const k=placeKey(item.type,item.name);if(!unresolved.has(k))unresolved.set(k,item);}
    if(a.status!=='resolved'||b.status!=='resolved')continue;
    if(!nodes.has(a.point.id))nodes.set(a.point.id,a.point);
    if(!nodes.has(b.point.id))nodes.set(b.point.id,b.point);
    const key=`${trip.type}|${a.point.id}>${b.point.id}`;
    if(!groups.has(key))groups.set(key,{key,type:trip.type,from:a.point,to:b.point,trips:[]});
    groups.get(key).trips.push(trip);
  }
  return {nodes:[...nodes.values()],groups:[...groups.values()],unresolved:[...unresolved.values()]};
}
const mercator=lat=>Math.log(Math.tan(Math.PI/4+Math.max(-85,Math.min(85,lat))*Math.PI/360))*180/Math.PI;
export function wrappedLon(lon,center){return center+((((lon-center+180)%360)+360)%360)-180;}
export function fitView(nodes){
  if(!nodes.length)return {cx:105,cy:mercator(34),sx:105,sy:68};
  const lons=nodes.map(n=>((n.lon%360)+360)%360).sort((a,b)=>a-b);let gap=-1,start=0;
  for(let i=0;i<lons.length;i++){const next=i===lons.length-1?lons[0]+360:lons[i+1];if(next-lons[i]>gap){gap=next-lons[i];start=next%360;}}
  const arc=360-gap;const center=(start+arc/2)%360;const x=nodes.map(n=>wrappedLon(n.lon,center));const y=nodes.map(n=>mercator(n.lat));
  const minX=Math.min(...x),maxX=Math.max(...x),minY=Math.min(...y),maxY=Math.max(...y);
  const sx=Math.max(5,(maxX-minX)*1.5);const sy=Math.max(3,(maxY-minY)*1.65,sx*0.65);return {cx:(minX+maxX)/2,cy:(minY+maxY)/2,sx:Math.max(sx,sy/0.65),sy};
}
export function project(point,view){return {x:500+(wrappedLon(point.lon,view.cx)-view.cx)*1000/view.sx,y:325-(mercator(point.lat)-view.cy)*650/view.sy};}
export function unproject(x,y,view){const lon=view.cx+(x-500)*view.sx/1000;const m=view.cy+(325-y)*view.sy/650;const lat=(2*Math.atan(Math.exp(m*Math.PI/180))-Math.PI/2)*180/Math.PI;return {lat,lon:((((lon+180)%360)+360)%360)-180};}
export function arcPath(a,b){
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1;
  const bend=Math.max(24,Math.min(100,length*0.18));
  const cx=(a.x+b.x)/2-dy/length*bend,cy=(a.y+b.y)/2+dx/length*bend;
  if(length<10)return {d:`M ${a.x} ${a.y} C ${a.x+55} ${a.y-75} ${a.x-55} ${a.y-75} ${a.x} ${a.y}`,label:{x:a.x,y:a.y-55}};
  return {d:`M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`,label:{x:(a.x+b.x+2*cx)/4,y:(a.y+b.y+2*cy)/4}};
}
// Route geometry stays in WGS-84 coordinates. Leaflet projects both these points
// and the endpoint markers with the same map transform at every zoom level.
export function arcLatLngs(from,to,steps=48){
  const startLon=from.lon;
  const endLon=wrappedLon(to.lon,startLon);
  const ax=startLon,ay=mercator(from.lat),bx=endLon,by=mercator(to.lat);
  const dx=bx-ax,dy=by-ay,length=Math.hypot(dx,dy);
  if(length<1e-9)return [[from.lat,from.lon],[to.lat,to.lon]];
  const bend=Math.min(18,Math.max(.12,length*.13));
  const controlX=(ax+bx)/2-dy/length*bend;
  const controlY=(ay+by)/2+dx/length*bend;
  const points=[];
  for(let index=0;index<=steps;index++){
    const t=index/steps,u=1-t;
    const x=u*u*ax+2*u*t*controlX+t*t*bx;
    const y=u*u*ay+2*u*t*controlY+t*t*by;
    const lat=(2*Math.atan(Math.exp(y*Math.PI/180))-Math.PI/2)*180/Math.PI;
    points.push([lat,x]);
  }
  points[0]=[from.lat,from.lon];
  points[points.length-1]=[to.lat,Math.abs(endLon-to.lon)<1e-9?to.lon:endLon];
  return points;
}

// Location dots are always present; labels arrive together once there is room.
export function mapInfoLevel(zoom){
  return zoom<=5?'overview':'details';
}
