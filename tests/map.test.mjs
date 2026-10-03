import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {indexPlaces,normalizePlace,placeKey,resolvePlace,groupRoutes,fitView,project,unproject,arcPath,arcLatLngs,mapInfoLevel} from '../dist/map-geo.js';
const catalog=JSON.parse(await readFile(new URL('../dist/map-data/places.json',import.meta.url),'utf8'));
const indexes=indexPlaces(catalog);
test('离线目录精确定位现有机场，不以城市中心代替机场',()=>{
  const shenyang=resolvePlace(indexes,{},'flight','沈阳桃仙');const wuhan=resolvePlace(indexes,{},'flight','武汉天河');const dalian=resolvePlace(indexes,{},'flight','大连周水子');
  assert.equal(shenyang.status,'resolved');assert.equal(wuhan.status,'resolved');assert.equal(dalian.status,'resolved');
  assert.ok(Math.abs(shenyang.point.lat-41.64)<.05);assert.ok(Math.abs(wuhan.point.lon-114.21)<.05);
  const airport=resolvePlace(indexes,{},'flight','上海虹桥机场');
  assert.equal(airport.status,'resolved');
  assert.equal(resolvePlace(indexes,{},'flight','Beijing Capital (PEK)').status,'resolved');
});
test('相同实际节点合并，重复航线按方向聚合',()=>{
  const t=(code,departure,arrival)=>({id:code,type:'flight',code,date:'2026-10-12',departure,arrival});
  const graph=groupRoutes([t('A1','沈阳桃仙','武汉天河'),t('A2','沈阳桃仙国际机场','武汉天河机场'),t('B1','大连周水子','武汉天河'),t('C1','武汉天河','沈阳桃仙')],indexes,{});
  assert.equal(graph.nodes.length,3);assert.equal(graph.groups.length,3);assert.equal(graph.groups.find(g=>g.trips.length===2).trips.length,2);assert.equal(graph.unresolved.length,0);
});
test('未知与歧义不猜城市中心，可由本机坐标覆盖',()=>{
  assert.equal(resolvePlace(indexes,{},'flight','不存在的精确机场').status,'unknown');
  const key=placeKey('flight','不存在的精确机场');assert.equal(resolvePlace(indexes,{[key]:{lat:31.2,lon:121.4}},'flight','不存在的精确机场').point.lat,31.2);
  assert.equal(normalizePlace('沈阳桃仙国际机场 T3'),'沈阳桃仙');
  assert.equal(resolvePlace(indexes,{},'flight','首尔/仁川').point.iata,'ICN');
  assert.equal(resolvePlace(indexes,{},'flight','沈阳').point.iata,'SHE');
});
test('坐标投影可反算，弧线标签在中点附近',()=>{
  const nodes=[{lat:41.6398,lon:123.483668},{lat:30.774798,lon:114.213723}];const view=fitView(nodes);const a=project(nodes[0],view),b=project(nodes[1],view);const round=unproject(a.x,a.y,view);
  assert.ok(Math.abs(round.lat-nodes[0].lat)<1e-8);assert.ok(Math.abs(round.lon-nodes[0].lon)<1e-8);
  const arc=arcPath(a,b);assert.match(arc.d,/ Q /);assert.ok(arc.label.x>Math.min(a.x,b.x));assert.ok(arc.label.x<Math.max(a.x,b.x));
});
test('在线底图路线的端点与站点坐标完全相同，缩放由同一地图投影处理',()=>{
  const from={lat:41.6398,lon:123.483668},to={lat:30.774798,lon:114.213723};
  const points=arcLatLngs(from,to);
  assert.deepEqual(points[0],[from.lat,from.lon]);
  assert.deepEqual(points.at(-1),[to.lat,to.lon]);
  assert.equal(points.length,49);
  assert.ok(points.slice(1,-1).every(([lat,lon])=>Number.isFinite(lat)&&Number.isFinite(lon)));
  const reverse=arcLatLngs(to,from);
  assert.notDeepEqual(points[24],reverse[24]);
});
test('圆点始终显示，放大后同时展示航班号与机场名称',()=>{
  assert.equal(mapInfoLevel(3),'overview');
  assert.equal(mapInfoLevel(4),'overview');
  assert.equal(mapInfoLevel(5),'overview');
  assert.equal(mapInfoLevel(6),'details');
  assert.equal(mapInfoLevel(7),'details');
});
