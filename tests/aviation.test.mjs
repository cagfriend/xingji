import {test} from 'node:test';
import assert from 'node:assert/strict';
import {airlineForFlight,normalizeAircraftType} from '../dist/aviation.js';

test('航班号可解析为航司标识',()=>{
  assert.equal(airlineForFlight('CA1831').name,'中国国际航空');
  assert.equal(airlineForFlight('CX888').logo,'/airlines/CX.svg');
  assert.equal(airlineForFlight('MU6450').logo,'/airlines/MU.png');
  assert.equal(airlineForFlight('HU7603').logo,'/airlines/HU.png');
  assert.equal(airlineForFlight('9C8865').name,'春秋航空');
  assert.equal(airlineForFlight('UO618').name,'香港快运航空');
  assert.equal(airlineForFlight('BR198').name,'长荣航空');
  assert.equal(airlineForFlight('JL021').logo,'/airlines/JL.png');
  assert.equal(airlineForFlight('KE850').name,'大韩航空');
  assert.equal(airlineForFlight('XX100').name,'XX 航空');
});
test('机型统计合并细分型号但保留系列边界',()=>{
  assert.equal(normalizeAircraftType('737-8sl'),'波音 737-800');
  assert.equal(normalizeAircraftType('737max8'),'波音 737 MAX 8');
  assert.equal(normalizeAircraftType('波音737-8SL'),'波音 737-800');
  assert.equal(normalizeAircraftType('波音737-89P(WL)'),'波音 737-800');
  assert.equal(normalizeAircraftType('波音737 MAX 8'),'波音 737 MAX 8');
  assert.equal(normalizeAircraftType('空客320-214(SL)'),'空客 A320');
  assert.equal(normalizeAircraftType('空客321-251(NX)'),'空客 A321');
  assert.equal(normalizeAircraftType('空客330-243'),'空客 A330-200');
  assert.equal(normalizeAircraftType('空客330-343(X)'),'空客 A330-300');
  assert.equal(normalizeAircraftType('波音777-28E(ER)'),'波音 777-200ER');
});
