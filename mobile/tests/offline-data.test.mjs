import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
const file=new URL('../offline-map/data/basemap.json',import.meta.url);
test('bundled public-domain map has globally consistent detail and valid geometry',async()=>{
 const data=JSON.parse(await readFile(file,'utf8'));
 assert.ok((await stat(file)).size<100_000_000,'global offline vector pack is under 100 MB');
 assert.ok(data.countries.features.length>170,'countries are global, not just East Asia');
 for(const [key,min] of Object.entries({admin:2000,roads:25000,lakes:500,urban:10000}))assert.ok(data[key].features.length>min,`${key} includes worldwide detail`);
 const depths={Point:0,MultiPoint:1,LineString:1,MultiLineString:2,Polygon:2,MultiPolygon:3};
 let count=0;
 const positions=(value,depth)=>{
   assert.ok(Array.isArray(value));
   if(depth===0){assert.equal(typeof value[0],'number');assert.equal(typeof value[1],'number');assert.ok(Number.isFinite(value[0])&&Math.abs(value[0])<=180);assert.ok(Number.isFinite(value[1])&&Math.abs(value[1])<=90);count++;return;}
   assert.ok(value.length>0);value.forEach(child=>positions(child,depth-1));
 };
 for(const key of ['countries','admin','roads','lakes','urban'])for(const feature of data[key].features){
   assert.equal(feature.type,'Feature');assert.equal(typeof feature.properties.name,'string');
   assert.ok(feature.geometry.type in depths);positions(feature.geometry.coordinates,depths[feature.geometry.type]);
   if(feature.geometry.type==='Polygon'||feature.geometry.type==='MultiPolygon'){
     const polygons=feature.geometry.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry.coordinates;
     for(const polygon of polygons)for(const ring of polygon){assert.ok(ring.length>=4);assert.deepEqual(ring[0],ring.at(-1));}
   }
 }
 assert.ok(count>10000);
 assert.ok(data.roads.features.some(f=>JSON.stringify(f.geometry.coordinates).includes('139.')),'roads extend to eastern Japan');
 const manifest=JSON.parse(await readFile(new URL('../offline-map/data/manifest.json',import.meta.url),'utf8'));
 assert.match(manifest.license,/public domain/i);
 assert.equal(manifest.featureCounts.countries,data.countries.features.length);
 for(const key of ['admin','roads','lakes','urban'])assert.equal(manifest.sources[key].coverage,'global');
 for(const city of data.cities){assert.ok(city.name);assert.ok(Number.isFinite(city.lat)&&Number.isFinite(city.lon));}
});
