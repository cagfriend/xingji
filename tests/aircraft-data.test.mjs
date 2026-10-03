import {test} from 'node:test';
import assert from 'node:assert/strict';
import {enrichAircraftRegistration} from '../aircraft-data.mjs';

test('按带连字符或无连字符注册号匹配并缓存飞机资料与照片元数据',async()=>{
  const requests=[];
  const fetcher=async url=>{
    requests.push(String(url));
    if(String(url).includes('api.planespotters.net'))return Response.json({photos:[{thumbnail:{src:'https://cdn.planespotters.net/photo-small.jpg'},link:'https://www.planespotters.net/photo/123/example',photographer:'测试摄影者',aircraft:{hex:'78018D'}}]});
    return Response.json({status:200,reg:'B-HLM',model:'2001 Airbus A330-343',cn:'386',country:'China',mode_s_code:'78018D',link:'https://airport-data.com/aircraft/B-HLM'});
  };
  const now=Date.parse('2026-09-24T00:00:00Z');
  const first=await enrichAircraftRegistration({registration:'BHLM',cache:{},fetcher,now});
  assert.equal(first.aircraft.registration,'B-HLM');
  assert.equal(first.aircraft.model,'2001 Airbus A330-343');
  assert.equal(first.aircraft.constructorNumber,'386');
  assert.equal(first.photos[0].photographer,'测试摄影者');
  assert.equal(first.photos[0].link,'https://www.planespotters.net/photo/123/example');
  assert.equal(requests.length,2);
  assert.match(requests[0],/reg\/B-HLM$/);
  assert.match(requests[1],/ac_info\.json\?m=78018D$/);
  const alias=await enrichAircraftRegistration({registration:'B HLM',cache:first.cache,fetcher,now:now+1000});
  assert.equal(alias.aircraft.registration,'B-HLM');
  assert.equal(alias.photos[0].photographer,'测试摄影者');
  assert.equal(requests.length,2,'新鲜缓存不应重复请求外部资料');
});

test('飞机资料源暂时不可用时仍保存注册号并返回空照片',async()=>{
  const result=await enrichAircraftRegistration({registration:'BHLM',cache:{},now:Date.now(),fetcher:async()=>new Response('unavailable',{status:503})});
  assert.equal(result.aircraft.registration,'B-HLM');
  assert.deepEqual(result.photos,[]);
  assert.ok(result.cache.BHLM);
});

test('资料源故障不擦除旧照片，也不把失败查询缓存为长期成功',async()=>{
  const now=Date.parse('2026-09-24T00:00:00Z');
  const photo={image:'https://t.plnspttrs.net/photo.jpg',link:'https://www.planespotters.net/photo/1/test',photographer:'Author'};
  const result=await enrichAircraftRegistration({registration:'BHLM',cache:{BHLM:{registration:'B-HLM',model:'',updatedAt:'',photos:[photo],photosUpdatedAt:now-2*86400000}},now,fetcher:async()=>new Response('unavailable',{status:503})});
  assert.deepEqual(result.photos,[photo]);
  assert.equal(result.aircraft.updatedAt,'');
  assert.equal(result.aircraft.lookupAttemptedAt,now);
});

test('Planespotters 未提供 Mode-S 时从 Airport-Data 机身资料页解析后调用正式接口',async()=>{
  const requests=[];
  const fetcher=async url=>{
    requests.push(String(url));
    if(String(url).includes('api.planespotters.net'))return Response.json({photos:[]});
    if(String(url)==='https://airport-data.com/aircraft/B-HLM')return new Response('<td>Mode S (ICAO24) Code</td>\n<td>78018D</td>');
    return Response.json({status:200,reg:'B-HLM',model:'2001 Airbus A330-343',cn:'386',country:'China',mode_s_code:'78018D'});
  };
  const result=await enrichAircraftRegistration({registration:'B-HLM',cache:{},fetcher});
  assert.equal(result.aircraft.modeSCode,'78018D');
  assert.equal(result.aircraft.model,'2001 Airbus A330-343');
  assert.equal(requests.length,3);
  assert.equal(requests[1],'https://airport-data.com/aircraft/B-HLM');
  assert.match(requests[2],/ac_info\.json\?m=78018D$/);
});
