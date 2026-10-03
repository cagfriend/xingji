import test from 'node:test';
import assert from 'node:assert/strict';
import {SpatialIndex} from '../offline-map/spatial-index.js';
const entry=(id,west,south,east=west,north=south)=>({id,bounds:{west,south,east,north}});
test('geographic index finds both sides of the date line and arbitrary world copies',()=>{
 const index=new SpatialIndex();
 const east=entry('east',179,20),west=entry('west',-179,20),china=entry('china',105,30);
 [east,west,china].forEach(e=>index.add(e));
 for(const shift of [-1080,0,720]){
   const found=new Set([...index.query({west:175+shift,east:185+shift,south:19,north:21})].map(e=>e.id));
   assert.ok(found.has('east'));assert.ok(found.has('west'));assert.ok(!found.has('china'));
 }
 assert.equal(index.size,3);
 assert.equal([...index.query({west:-180,east:180,south:-90,north:90})].length,3);
});
test('small viewport filters a large worldwide index without scanning all entries',()=>{
 const index=new SpatialIndex();
 for(let lat=-80;lat<=80;lat++)for(let lon=-180;lon<180;lon++)index.add(entry(`${lat},${lon}`,lon,lat));
 const found=[...index.query({west:114,east:118,south:38,north:42})];
 assert.ok(found.some(e=>e.id==='40,116'));
 assert.ok(found.length<index.size/20);
 assert.equal(new Set(found.map(e=>e.id)).size,found.length,'no duplicates from adjacent cells');
});
test('invalid bounds are ignored and an empty index is safe',()=>{
 const index=new SpatialIndex();index.add(entry('invalid',NaN,0));index.add({});
 assert.equal(index.size,0);assert.deepEqual([...index.query({west:0,east:10,south:0,north:10})],[]);
});
