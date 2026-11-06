import test from 'node:test';
import assert from 'node:assert/strict';
import {createPhotoCache} from '../photo-cache.mjs';

test('native photo cache preserves photo credit and exposes a local image URI',async()=>{
 const calls=[];const cachePhoto=createPhotoCache({native:true,localFiles:{call:async args=>{calls.push(args);return {localUri:'file:///private/aircraft-photos/hash.img'};}},convertFileSrc:uri=>`webview:${uri}`});
 const source={image:'https://t.plnspttrs.net/image.jpg',thumbnail:'https://t.plnspttrs.net/thumb.jpg',author:'Photographer',link:'https://www.planespotters.net/photo/1'};
 const result=await cachePhoto(source);
 assert.deepEqual(calls,[{action:'cachePhoto',url:source.image,force:false}]);
 assert.equal(result.image,'webview:file:///private/aircraft-photos/hash.img');
 assert.equal(result.remoteImage,source.image);assert.equal(result.localUri,'file:///private/aircraft-photos/hash.img');
 assert.equal(result.author,source.author);assert.equal(result.link,source.link);assert.equal(result.thumbnail,source.thumbnail);
});

test('missing native local file is repaired from remote and force is forwarded',async()=>{
 const calls=[];const cachePhoto=createPhotoCache({native:true,localFiles:{call:async args=>{calls.push(args);if(args.action==='photoExists')return {exists:false};return {localUri:'file:///private/new.img'};}},convertFileSrc:uri=>uri});
 const result=await cachePhoto({image:'https://t.plnspttrs.net/a.jpg',localUri:'file:///private/gone.img',author:'A'},{force:true});
 assert.equal(calls[0].action,'photoExists');assert.equal(calls[1].force,true);assert.equal(result.localUri,'file:///private/new.img');assert.equal(result.author,'A');
});

test('force refresh keeps a valid local image as fallback when download fails',async()=>{
 const calls=[];const cachePhoto=createPhotoCache({native:true,localFiles:{call:async args=>{calls.push(args);if(args.action==='photoExists')return {exists:true};throw new Error('offline');}},convertFileSrc:uri=>`webview:${uri}`});
 const result=await cachePhoto({image:'https://t.plnspttrs.net/new.jpg',localUri:'file:///private/old.img',author:'A'},{force:true});
 assert.equal(calls[1].force,true);assert.equal(result.image,'webview:file:///private/old.img');assert.equal(result.localUri,'file:///private/old.img');assert.equal(result.author,'A');
});

test('force refresh downloads the newest URL but preserves old attribution if it fails',async()=>{
 const calls=[];const cachePhoto=createPhotoCache({native:true,localFiles:{call:async args=>{calls.push(args);if(args.action==='photoExists')return {exists:true};throw Error('offline');}},convertFileSrc:uri=>uri});
 const previousPhoto={image:'local:old',localUri:'file:///private/old.img',remoteImage:'https://t.plnspttrs.net/old.jpg',photographer:'Old Author'};
 const result=await cachePhoto({image:'https://t.plnspttrs.net/new.jpg',photographer:'New Author'},{force:true,previousPhoto});
 assert.equal(calls[1].url,'https://t.plnspttrs.net/new.jpg');assert.equal(result.photographer,'Old Author');
});
test('thumbnail is cached when the primary photo download fails',async()=>{
 const calls=[];const cachePhoto=createPhotoCache({native:true,localFiles:{call:async args=>{calls.push(args);if(args.action==='cachePhoto'&&args.url.includes('large'))throw new Error('offline');return {localUri:'file:///private/thumb.img'};}},convertFileSrc:uri=>uri});
 const result=await cachePhoto({image:'https://t.plnspttrs.net/large.jpg',thumbnail:'https://t.plnspttrs.net/thumb.jpg',author:'A'});
 assert.deepEqual(calls.filter(c=>c.action==='cachePhoto').map(c=>c.url),['https://t.plnspttrs.net/large.jpg','https://t.plnspttrs.net/thumb.jpg']);assert.equal(result.cachedImage,'https://t.plnspttrs.net/thumb.jpg');assert.equal(result.author,'A');
});
