import test from 'node:test';
import assert from 'node:assert/strict';
import {createNetworkRequest} from '../network.mjs';

test('web transport forwards signal and redirect and enforces the request deadline',async()=>{
  let fetchArgs;
  const controller=new AbortController();
  const request=createNetworkRequest({fetchImpl:async(...args)=>{
    fetchArgs=args;
    return {status:200,text:async()=>'ok'};
  },baseUrl:'https://app.example/'});
  assert.deepEqual(await request({url:'https://api.example/data',signal:controller.signal,redirect:'manual',timeout:1000}),{status:200,data:'ok'});
  assert.equal(fetchArgs[1].signal,controller.signal);
  assert.equal(fetchArgs[1].redirect,'manual');

  const slow=createNetworkRequest({fetchImpl:()=>new Promise(resolve=>setTimeout(()=>resolve({status:200,text:async()=>''}),60))});
  await assert.rejects(slow({url:'https://api.example/slow',timeout:10}),error=>error.name==='TimeoutError');
});

test('native transport receives bounded timeouts and redirect policy',async()=>{
  let options;
  const request=createNetworkRequest({native:true,capacitorHttp:{async request(value){options=value;return {status:200,data:{ok:true}};}}});
  assert.deepEqual(await request({url:'https://api.example/data',headers:{Referer:'https://source.example/'},redirect:'manual',timeout:7000}),{status:200,data:{ok:true}});
  assert.equal(options.connectTimeout,7000);
  assert.equal(options.readTimeout,7000);
  assert.equal(options.disableRedirects,true);
  assert.equal(options.headers.Referer,'https://source.example/');
});

test('native vision requests keep the 90-second default and aircraft requests use their explicit deadline',async()=>{
  const optionsSeen=[];
  const request=createNetworkRequest({native:true,capacitorHttp:{async request(options){optionsSeen.push(options);return {status:200,data:{ok:true}};}}});
  await request({url:'https://api.example/vision',method:'POST'});
  assert.equal(optionsSeen[0].connectTimeout,15000);
  assert.equal(optionsSeen[0].readTimeout,90000);

  const controller=new AbortController();
  await request({url:'https://api.example/aircraft',timeout:20000,signal:controller.signal});
  assert.equal(optionsSeen[1].connectTimeout,15000);
  assert.equal(optionsSeen[1].readTimeout,20000);
});

test('native request cancellation rejects promptly and late failures are handled after deadline cleanup',async()=>{
  const listeners=new Set();
  const signal={aborted:false,reason:undefined,addEventListener(type,listener){if(type==='abort')listeners.add(listener);},removeEventListener(type,listener){if(type==='abort')listeners.delete(listener);},abort(){this.aborted=true;this.reason=Object.assign(new Error('cancelled'),{name:'AbortError'});for(const listener of [...listeners])listener();}};
  const slow=createNetworkRequest({native:true,capacitorHttp:{request(){return new Promise((_,reject)=>setTimeout(()=>reject(new Error('late native failure')),35));}}});
  const unhandled=[];
  const onUnhandled=reason=>unhandled.push(reason);
  process.on('unhandledRejection',onUnhandled);
  try {
    const pending=slow({url:'https://api.example/cancel',signal,timeout:20000});
    signal.abort();
    await assert.rejects(pending,error=>error.name==='AbortError');
    assert.equal(listeners.size,0,'abort listener is removed when cancellation wins');

    const deadlineSignal={...signal,aborted:false,reason:undefined};
    const deadlinePending=slow({url:'https://api.example/deadline',signal:deadlineSignal,timeout:10});
    await assert.rejects(deadlinePending,error=>error.name==='TimeoutError');
    assert.equal(listeners.size,0,'abort listener is removed when the deadline wins');
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.deepEqual(unhandled,[],'late native rejection remains handled');
  } finally { process.off('unhandledRejection',onUnhandled); }
});
