import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalService} from '../local-service.mjs';

function fixture({request=async()=>({status:200,data:{}}),places,aircraftEnricher,cachePhoto}={}){
  const values=new Map();let id=0;let time=Date.parse('2026-10-01T12:00:00Z');
  const storage={async read(key){return values.has(key)?structuredClone(values.get(key)):null;},async write(key,value){values.set(key,structuredClone(value));}};
  const service=createLocalService({storage,request,places,aircraftEnricher,cachePhoto,uuid:()=>`id-${++id}`,now:()=>time});
  return {service,values,advance(ms){time+=ms;}};
}
const flight=(extra={})=>({type:'flight',code:'CA1831',date:'2026-10-12',departure:'PEK',arrival:'SHA',departureTime:'07:00',...extra});

test('code and date alone can be confirmed, deduplicated, exported and enriched later',async()=>{
  let requests=0;
  const {service}=fixture({request:async()=>{requests++;throw new Error('not expected');}});
  const minimal={type:'flight',code:'ca - 1831',date:'2026-10-12'};
  const saved=await service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[minimal]}});
  const trip=saved.trips[0];assert.equal(trip.code,'CA1831');
  for(const field of ['departure','arrival','departureTime','aircraftType','registration','seat','ticketPrice'])assert.equal(trip[field],'');
  assert.equal(requests,0,'quick addition does not require an API or invent flight details');
  await assert.rejects(service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[minimal]}}),e=>e.status===409);
  await assert.rejects(service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[{type:'flight',date:minimal.date}]}}),/航班号/);
  await assert.rejects(service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[{type:'flight',code:minimal.code}]}}),/日期/);
  const next=await service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[{...minimal,date:'2026-10-13'}]}});
  assert.equal(next.trips.length,1);
  assert.equal((await service.handle('/api/trips')).trips.length,2,'same flight on a different day is allowed');
  await service.handle(`/api/trips/${trip.id}`,{method:'PUT',body:{confirmed:true,trip:{...minimal,departure:'PEK',arrival:'SHA',seat:'12A'}}});
  assert.equal((await service.handle('/api/trips')).trips.find(t=>t.id===trip.id).seat,'12A');
  assert.equal((await service.exportBackup()).trips.length,2);
});

test('trip creation requires confirmation, validates and de-duplicates code plus date',async()=>{
  const {service,values}=fixture();
  await assert.rejects(service.handle('/api/trips',{method:'POST',body:{trips:[flight()]}}),/确认/);
  assert.equal(values.has('trips.json'),false);
  const saved=await service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight()]}});
  assert.equal(saved.trips[0].id,'id-1');assert.equal(saved.trips[0].code,'CA1831');
  await assert.rejects(service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight({code:'ca - 1831'})]}}),error=>error.status===409);
  await assert.rejects(service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight({date:'2026-02-30'})]}}),/日期/);
  assert.equal((await service.handle('/api/trips')).trips.length,1);
});

test('concurrent writes serialize; edits retain identity and deletes require confirmation',async()=>{
  const {service}=fixture();
  const results=await Promise.allSettled([
    service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight()]}}),
    service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight()]}}),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const id=results.find(result=>result.status==='fulfilled').value.trips[0].id;
  await assert.rejects(service.handle(`/api/trips/${id}`,{method:'DELETE',body:{}}),/确认/);
  await service.handle(`/api/trips/${id}`,{method:'PUT',body:{confirmed:true,trip:flight({seat:'12A'})}});
  assert.equal((await service.handle('/api/trips')).trips[0].seat,'12A');
  await service.handle(`/api/trips/${id}`,{method:'DELETE',body:{confirmed:true}});
  assert.equal((await service.handle('/api/trips')).trips.length,0);
});

test('recognition returns drafts and duplicate warnings without saving them',async()=>{
  const request=async({url,data})=>({status:200,data:{choices:[{message:{content:JSON.stringify({trips:[flight()],warnings:[]})}}]}});
  const {service,values}=fixture({request});
  await service.handle('/api/config',{method:'PUT',body:{endpoint:'https://example.test/v1',apiKey:'private',model:'vision'}});
  const result=await service.handle('/api/recognize',{method:'POST',body:{text:'票面',images:[]}});
  assert.equal(result.source,'ai');assert.equal(result.trips[0].code,'CA1831');
  assert.deepEqual(result.duplicates,[]);assert.equal((await service.handle('/api/trips')).trips.length,0);
  assert.equal(values.has('config.json'),true);
  assert.equal(request.length,1);
});

test('local recognition refuses images and config validation rejects unsafe addresses',async()=>{
  const {service}=fixture();
  await assert.rejects(service.handle('/api/recognize',{method:'POST',body:{mode:'local',text:'test',images:['data:image/png;base64,aGVsbG8=']}}),/无法识别图片/);
  await assert.rejects(service.handle('/api/config',{method:'PUT',body:{endpoint:'javascript:alert(1)',apiKey:'',model:'x'}}),/HTTP\(S\)/);
  const result=await service.handle('/api/recognize',{method:'POST',body:{mode:'local',text:'2026-10-12 CA1831 PEK到SHA'}});
  assert.equal(result.source,'local');assert.equal(result.trips.length,1);
});

test('local recognition canonicalizes airport names and reports existing duplicates',async()=>{
  const catalog={airports:[
    {id:'air:ZBAA',iata:'PEK',name:'Beijing Capital International Airport',city:'Beijing',structuredName:'北京首都国际机场'},
    {id:'air:ZSSS',iata:'SHA',name:'Shanghai Hongqiao International Airport',city:'Shanghai',structuredName:'上海虹桥国际机场'},
  ]};
  const {service}=fixture({places:catalog});
  await service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight()]}});
  const result=await service.handle('/api/recognize',{method:'POST',body:{mode:'local',text:'2026-10-12 CA1831 PEK到SHA'}});
  assert.equal(result.trips[0].departure,'北京首都国际机场（PEK）');
  assert.equal(result.trips[0].arrival,'上海虹桥国际机场（SHA）');
  assert.equal(result.duplicates.length,1);
});

test('places require confirmation and valid coordinates',async()=>{
  const {service}=fixture();
  await assert.rejects(service.handle('/api/places',{method:'PUT',body:{key:'flight|北京',lat:39,lon:116}}),/确认/);
  await assert.rejects(service.handle('/api/places',{method:'PUT',body:{confirmed:true,key:'flight|北京',lat:91,lon:116}}),/范围/);
  await service.handle('/api/places',{method:'PUT',body:{confirmed:true,key:'flight|北京',lat:39,lon:116}});
  assert.deepEqual((await service.handle('/api/places')).places['flight|北京'],{lat:39,lon:116});
});

test('backup excludes API keys; import validates and merges duplicate flights',async()=>{
  const {service}=fixture();
  await service.handle('/api/config',{method:'PUT',body:{endpoint:'https://example.test/v1',apiKey:'secret-never-export',model:'vision'}});
  await service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight()]}});
  const snapshot=await service.exportBackup();
  assert.equal(snapshot.version,1);assert.equal('apiKey' in snapshot.config,false);assert.equal(JSON.stringify(snapshot).includes('secret-never-export'),false);
  const fresh=fixture().service;
  const imported=await fresh.importBackup(snapshot);
  assert.deepEqual(imported,{imported:1,skipped:0});
  const repeated=await fresh.importBackup(snapshot);
  assert.deepEqual(repeated,{imported:0,skipped:1});
  assert.equal((await fresh.handle('/api/trips')).trips.length,1);
  assert.equal((await fresh.handle('/api/config')).apiKey,'');
  await assert.rejects(fresh.importBackup({...snapshot,version:42}),/版本/);
});

test('desktop version 2 imports, keeps absent configuration, and repairs colliding safe IDs',async()=>{
  const {service}=fixture();
  await service.handle('/api/config',{method:'PUT',body:{endpoint:'https://local.example/v1',apiKey:'local-secret',model:'local-model'}});
  await service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight({code:'MU2001'})]}});
  const result=await service.importBackup({version:2,exportedAt:'2026-10-01T00:00:00Z',trips:[
    {...flight({code:'CA1831'}),id:'shared-id',createdAt:'2026-09-01T00:00:00Z'},
    {...flight({code:'CZ3001'}),id:'shared-id',createdAt:'2026-09-01T00:00:00Z'},
  ]});
  assert.deepEqual(result,{imported:2,skipped:0});
  const trips=(await service.handle('/api/trips')).trips;
  assert.equal(trips.find(trip=>trip.code==='CA1831').id,'shared-id');
  assert.notEqual(trips.find(trip=>trip.code==='CZ3001').id,'shared-id');
  const config=await service.handle('/api/config');assert.equal(config.endpoint,'https://local.example/v1');assert.equal(config.apiKey,'local-secret');
  await assert.rejects(service.importBackup({version:2,trips:[{...flight({code:'SC1001'}),id:'__proto__'}]}),/不安全/);
  await assert.rejects(service.importBackup({version:1,trips:[],aircraftCache:JSON.parse('{"constructor":{"polluted":true}}')}),/不安全/);
});

test('failed backup import rolls back earlier writes',async()=>{
  const values=new Map([['trips.json',[{...flight({code:'MU2001'}),id:'existing'}]],['config.json',{endpoint:'https://old.example',apiKey:'keep',model:'old'}],['places.json',{}],['aircraft-cache.json',{}]]);
  let fail=true;
  const storage={async read(key){return structuredClone(values.get(key)??null);},async write(key,value){if(key==='aircraft-cache.json'&&fail){fail=false;throw new Error('write failed');}values.set(key,structuredClone(value));}};
  const service=createLocalService({storage,request:async()=>({status:200,data:{}}),uuid:()=>`new-id`});
  await assert.rejects(service.importBackup({version:1,trips:[flight({code:'CA1831'})],places:{'flight|PEK':{lat:40,lon:116}},aircraftCache:{}}),/write failed/);
  assert.deepEqual(values.get('trips.json').map(trip=>trip.id),['existing']);
  assert.deepEqual(values.get('places.json'),{});
});

test('string request bodies are parsed as JSON for AI responses',async()=>{
  const {service}=fixture({request:async()=>({status:200,data:JSON.stringify({choices:[{message:{content:JSON.stringify({trips:[flight()],warnings:[]})}}]})})});
  await service.handle('/api/config',{method:'PUT',body:{endpoint:'https://example.test/v1',apiKey:'',model:'vision'}});
  const result=await service.handle('/api/recognize',{method:'POST',body:{text:'ticket'}});
  assert.equal(result.trips[0].code,'CA1831');
});

test('aircraft lookups normalize registrations and persist the cache',async()=>{
  const calls=[];
  const {service,values}=fixture({request:async({url})=>{
    calls.push(url);
    if(url.includes('planespotters.net'))return {status:200,data:{photos:[{thumbnail:{src:'https://cdn.example/photo.jpg'},link:'https://www.planespotters.net/photo/1/test',photographer:'Photographer'}]}};
    return {status:404,data:{}};
  }});
  const result=await service.handle('/api/aircraft/BHLM');
  assert.equal(result.registration,'B-HLM');assert.equal(result.photos[0].photographer,'Photographer');
  assert.match(calls[0],/reg\/B-HLM$/);assert.equal(values.get('aircraft-cache.json').BHLM.registration,'B-HLM');
});

test('historical aircraft lookup prefers cache and migrates remote photos locally',async()=>{
  let options;let cached=0;const photo={image:'https://cdn.example/photo.jpg',link:'https://www.planespotters.net/photo/1/test'};
  const {service,values}=fixture({aircraftEnricher:async value=>{options=value;return {aircraft:{registration:'B-HLM',model:'A320',photos:[photo]},photos:[photo]};},cachePhoto:async(p,{force})=>{cached++;return {...p,image:'file:///local/photo.jpg',remoteImage:p.image,localUri:'/local/photo.jpg',force};}});
  values.set('trips.json',[{...flight({registration:'B-HLM',date:'2026-09-01'}),id:'old'}]);
  const result=await service.handle('/api/aircraft/B-HLM');
  assert.equal(options.preferCache,true);assert.equal(result.photos[0].remoteImage,photo.image);assert.equal(cached,1);
  assert.equal(values.get('aircraft-cache.json').BHLM.photos[0].localUri,'/local/photo.jpg');
});

test('cached local photos are rechecked and hydrated to a fresh display URL on every lookup',async()=>{
  const photo={image:'https://cdn.example/photo.jpg',link:'https://www.planespotters.net/photo/1/test'};let hydrated=0;
  const {service,values}=fixture({aircraftEnricher:async()=>({aircraft:{registration:'B-HLM',model:'A320',photos:[photo]},photos:[photo]}),cachePhoto:async(p)=>{hydrated++;return {...p,image:`blob:display-${hydrated}`,remoteImage:p.remoteImage??p.image,localUri:'/local/photo.jpg'};}});
  values.set('trips.json',[{...flight({registration:'B-HLM',date:'2026-09-01'}),id:'old'}]);
  const first=await service.handle('/api/aircraft/B-HLM');const second=await service.handle('/api/aircraft/B-HLM');
  assert.equal(hydrated,2);assert.equal(first.photos[0].image,'blob:display-1');assert.equal(second.photos[0].image,'blob:display-2');
  assert.equal(second.photos[0].remoteImage,photo.image);
});

test('future-only aircraft lookup keeps ordinary refresh behavior and failed photo cache does not drop photos',async()=>{
  let options;const photo={image:'https://cdn.example/photo.jpg',link:'https://www.planespotters.net/photo/1/test'};
  const {service,values}=fixture({aircraftEnricher:async value=>{options=value;return {aircraft:{registration:'B-HLM',model:'A320',photos:[photo]},photos:[photo]};},cachePhoto:async()=>{throw new Error('disk full');}});
  values.set('trips.json',[{...flight({registration:'B-HLM',date:'2026-10-12'}),id:'future'}]);
  const result=await service.handle('/api/aircraft/B-HLM');
  assert.equal(options.preferCache,false);assert.equal(result.photos.length,1);assert.equal(result.photos[0].image,photo.image);
});

test('aircraft refresh query passes stored same-registration models and preserves source headers and request controls',async()=>{
  const calls=[];
  let enrichment;
  const {service,values}=fixture({request:async(options)=>{calls.push(options);return {status:200,data:{photos:[]}};},aircraftEnricher:async options=>{
    enrichment={expectedModels:options.expectedModels,force:options.force};
    const signal=new AbortController().signal;
    await options.fetcher('https://api.planespotters.net/pub/photos/reg/B-HLM',{headers:{'User-Agent':'PlanespottersClient/1.0','Referer':'https://www.planespotters.net/'},signal,redirect:'manual',timeout:1250});
    return {aircraft:{registration:'B-HLM',model:'',lookupStatus:{metadata:'conflict',photos:'ok'},photos:[{image:'https://cdn.example/p.jpg',link:'https://www.planespotters.net/photo/1/test'}]},photos:[{image:'https://cdn.example/p.jpg',link:'https://www.planespotters.net/photo/1/test'}]};
  }});
  values.set('trips.json',[
    {...flight({registration:'B-HLM',aircraftType:'Boeing 737-800'}),id:'one'},
    {...flight({registration:'B HLM',aircraftType:'Boeing 737'}),id:'two'},
    {...flight({registration:'B-HLM',aircraftType:''}),id:'three'},
    {...flight({registration:'B-OTHER',aircraftType:'Airbus A320'}),id:'four'},
  ]);
  const result=await service.handle('/api/aircraft/BHLM?refresh=1');
  assert.equal(result.photos.length,1,'a metadata conflict does not hide a returned photo');
  assert.equal(result.aircraft.lookupStatus.metadata,'conflict');
  assert.equal(values.get('aircraft-cache.json').BHLM.registration,'B-HLM');
  assert.deepEqual(calls[0].headers,{'User-Agent':'PlanespottersClient/1.0','Referer':'https://www.planespotters.net/'});
  assert.equal(calls[0].signal.aborted,false);
  assert.equal(calls[0].redirect,'manual');assert.equal(calls[0].timeout,1250);
  // The enricher receives the model evidence and explicit refresh intent.
  assert.deepEqual(enrichment.expectedModels,['Boeing 737-800','Boeing 737']);
  assert.equal(enrichment.force,true);
});

test('confirmed create warms aircraft cache asynchronously without blocking trip writes',async()=>{
  let photoRequest=false;
  const {service,values}=fixture({request:async({url})=>{
    if(url.includes('planespotters.net')){photoRequest=true;return {status:200,data:{photos:[]}};}
    return {status:404,data:{}};
  }});
  const result=await service.handle('/api/trips',{method:'POST',body:{confirmed:true,trips:[flight({registration:'B-HLM'})]}});
  assert.equal(result.trips.length,1);
  for(let count=0;count<20&&!values.has('aircraft-cache.json');count++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(photoRequest,true);assert.equal(values.get('aircraft-cache.json').BHLM.registration,'B-HLM');
});

test('request failures are surfaced and unknown routes return 404',async()=>{
  const {service}=fixture({request:async()=>({status:503,data:{}})});
  await service.handle('/api/config',{method:'PUT',body:{endpoint:'https://example.test/v1',apiKey:'',model:'x'}});
  await assert.rejects(service.handle('/api/recognize',{method:'POST',body:{text:'test'}}),error=>error.status===502);
  await assert.rejects(service.handle('/api/nope'),error=>error.status===404);
});
