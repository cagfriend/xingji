export function normalizeAirport(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase()
    .replace(/[()（）\[\]【】/·•,，._-]/g, '')
    .replace(/\b(?:international|intl|airport|aerodrome)\b/g, '')
    .replace(/(?:国际机场|机场|国际|航站)/g, '')
    .replace(/\s/g, '');
}
function add(index, key, airport) {
  if (!key) return;
  const values=index.get(key) ?? [];
  if (!values.some(value=>value.id===airport.id)) values.push(airport);
  index.set(key,values);
}
function unique(values) { return values?.length===1 ? values[0] : null; }
function airportCodes(value) {
  return [...new Set(String(value ?? '').toUpperCase().match(/\b[A-Z]{3,4}\b/g) ?? [])];
}
const preferredChineseNames=Object.freeze({
  DLC:'大连周水子国际机场', ICN:'首尔仁川国际机场', PEK:'北京首都国际机场',
  HKG:'香港国际机场', SHE:'沈阳桃仙国际机场', WUH:'武汉天河国际机场',
  PVG:'上海浦东国际机场', SHA:'上海虹桥国际机场', TAO:'青岛胶东国际机场',
  XIY:'西安咸阳国际机场', CSX:'长沙黄花国际机场', HGH:'杭州萧山国际机场',
  CAN:'广州白云国际机场', SZX:'深圳宝安国际机场', CTU:'成都双流国际机场',
  TFU:'成都天府国际机场', KMG:'昆明长水国际机场', NKG:'南京禄口国际机场',
  PKX:'北京大兴国际机场', HET:'呼和浩特白塔国际机场', TNA:'济南遥墙国际机场',
  SHS:'荆州沙市机场', TYN:'太原武宿国际机场', YNT:'烟台蓬莱国际机场'
});
function withoutAirportCode(value) {
  return String(value??'').trim().replace(/\s*[（(]\s*[A-Za-z]{3,4}\s*[）)]\s*$/,'').trim();
}
function structuredAirportName(value,airport) {
  const preferred=preferredChineseNames[airport.iata];
  if(preferred)return preferred;
  if(airport.structuredName)return airport.structuredName;
  const supplied=withoutAirportCode(value);
  if(/[\u3400-\u9fff]/.test(supplied))return supplied;
  const city=String(airport.city??'').trim(),name=String(airport.name??'').trim();
  if(/[\u3400-\u9fff]/.test(city)&&/[\u3400-\u9fff]/.test(name))return name.includes(city)?name:`${city}${name}`;
  return '机场中文名称待补充';
}
export function createAirportDirectory(catalog) {
  const exact=new Map(), code=new Map(), terms=[];
  for (const airport of catalog.airports ?? []) {
    const ident=String(airport.id ?? '').replace(/^air:/,'').toUpperCase();
    const values=[airport.iata,ident,airport.name,airport.city,...(airport.aliases ?? [])];
    for (const value of values) {
      const key=normalizeAirport(value);
      add(exact,key,airport);
      if (key.length>=2) terms.push([key,airport]);
    }
    for (const item of [airport.iata,ident]) {
      const key=String(item ?? '').toUpperCase();
      if (key) add(code,key,airport);
    }
  }
  function find(value) {
    const raw=String(value ?? '').trim();
    if (!raw) return {status:'missing'};
    for (const token of airportCodes(raw)) {
      const candidate=unique(code.get(token));
      if (candidate) return {status:'resolved',airport:candidate,match:'code'};
    }
    const key=normalizeAirport(raw);
    const direct=unique(exact.get(key));
    if (direct) return {status:'resolved',airport:direct,match:'exact'};
    const partial=[];
    for (const [term,airport] of terms) {
      if (key.length>=2 && term.length>key.length && term.startsWith(key) && !partial.some(item=>item.id===airport.id)) partial.push(airport);
    }
    if (partial.length===1) return {status:'resolved',airport:partial[0],match:'partial'};
    return {status:partial.length?'ambiguous':'unknown'};
  }
  function display(value,airport) {
    return `${structuredAirportName(value,airport)}（${airport.iata}）`;
  }
  return {find,display};
}
export function canonicalizeAirportTrips(trips,directory) {
  if(!directory)return trips;
  return trips.map(trip=>{
    if(trip?.type!=='flight')return trip;
    const next={...trip};
    for(const field of ['departure','arrival']){
      if(!next[field])continue;
      const resolved=directory.find(next[field]);
      if(resolved.status==='resolved')next[field]=directory.display(next[field],resolved.airport);
    }
    return next;
  });
}
export function enrichAirportTrips(result,directory) {
  if (!directory) return result;
  const warnings=[...(result.warnings ?? [])];
  const trips=(result.trips ?? []).map((trip,index)=>{
    if (trip.type!=='flight') return trip;
    const next={...trip};
    for (const field of ['departure','arrival']) {
      if (!next[field]) continue;
      const resolved=directory.find(next[field]);
      if (resolved.status==='resolved') {
        const formatted=directory.display(next[field],resolved.airport);
        if (formatted!==next[field]) {
          next[field]=formatted;
          warnings.push(`航班 ${trip.code || index+1}：${field==='departure'?'起飞':'到达'}机场已依据 OurAirports 校验为 ${formatted}。`);
        }
      } else {
        warnings.push(`航班 ${trip.code || index+1}：无法依据 OurAirports 唯一确定${field==='departure'?'起飞':'到达'}机场“${next[field]}”，请在确认前核对具体机场或 IATA 代码。`);
      }
    }
    return next;
  });
  return {trips,warnings:[...new Set(warnings)].slice(0,30)};
}
