import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAirportDirectory,canonicalizeAirportTrips,enrichAirportTrips} from '../airport-directory.mjs';

const catalog=JSON.parse(await readFile(new URL('../dist/map-data/places.json',import.meta.url),'utf8'));
test('OurAirports 目录以机场代码和票面别名校验具体机场，不把城市猜成机场',()=>{
  const directory=createAirportDirectory(catalog);
  assert.equal(directory.find('仁川国际机场 (ICN)').airport.iata,'ICN');
  assert.equal(directory.find('首尔/仁川').airport.iata,'ICN');
  assert.equal(directory.find('沈阳').airport.iata,'SHE');
  assert.equal(directory.find('北京').status,'ambiguous');
  const result=enrichAirportTrips({trips:[{type:'flight',code:'TW613',departure:'首尔/仁川',arrival:'沈阳'}],warnings:[]},directory);
  assert.equal(result.trips[0].departure,'首尔仁川国际机场（ICN）');
  assert.equal(result.trips[0].arrival,'沈阳桃仙国际机场（SHE）');
  assert.match(result.warnings.join('\n'),/OurAirports/);
});
test('既有航班也以城市加机场名和三字代码统一展示',()=>{
  const directory=createAirportDirectory(catalog);
  const trips=canonicalizeAirportTrips([{type:'flight',departure:'大连周水子机场 (DLC)',arrival:'仁川/首尔 (ICN)'},{type:'train',departure:'北京南',arrival:'上海虹桥'}],directory);
  assert.equal(trips[0].departure,'大连周水子国际机场（DLC）');
  assert.equal(trips[0].arrival,'首尔仁川国际机场（ICN）');
  assert.equal(trips[1].departure,'北京南');
});
test('没有本地中文别名时保留 AI 给出的中文名，绝不显示英文回退',()=>{
  const directory=createAirportDirectory(catalog);
  const trips=canonicalizeAirportTrips([{type:'flight',departure:'纽约约翰·肯尼迪国际机场（JFK）',arrival:'John F. Kennedy International Airport (JFK)'}],directory);
  assert.equal(trips[0].departure,'纽约约翰·肯尼迪国际机场（JFK）');
  assert.equal(trips[0].arrival,'机场中文名称待补充（JFK）');
});
