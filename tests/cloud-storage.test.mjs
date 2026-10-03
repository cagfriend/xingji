import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStorage, StorageConflictError} from '../cloud/storage.mjs';
import {makeLocalSnapshot} from '../scripts/cloud-import.mjs';
import {createTestD1} from './helpers/d1.mjs';

async function fixture() {
  const {database, binding} = await createTestD1();
  return {database, storage: createStorage(binding)};
}

function flight(id, code, date, extras = {}) {
  return {id, type: 'flight', code, date, departure: '北京首都国际机场（PEK）', arrival: '上海浦东国际机场（PVG）', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extras};
}

test('D1 schema enforces flight/date uniqueness and storage supports add, update, and delete', async () => {
  const {database, storage} = await fixture();
  try {
    const original = flight('flight-1', 'CA123', '2026-10-01');
    const [saved] = await storage.addTrips([original]);
    assert.deepEqual(await storage.listTrips(), [saved]);
    await assert.rejects(storage.addTrips([flight('flight-2', 'ca-123', '2026-10-01')]), error => {
      assert.ok(error instanceof StorageConflictError);
      assert.equal(error.status, 409);
      assert.equal(error.details.duplicates[0].existingId, 'flight-1');
      return true;
    });
    const updated = await storage.updateTrip('flight-1', flight('ignored', 'CA123', '2026-10-02', {arrival: '大阪关西国际机场（KIX）'}));
    assert.equal(updated.id, 'flight-1');
    assert.equal(updated.createdAt, saved.createdAt);
    assert.notEqual(updated.updatedAt, saved.updatedAt);
    assert.equal(await storage.deleteTrip('flight-1'), true);
    assert.equal(await storage.deleteTrip('flight-1'), false);
    assert.deepEqual(await storage.listTrips(), []);
  } finally { database.close(); }
});

test('new flights receive server metadata and imported config/cache reject unsafe values', async () => {
  const {database, storage} = await fixture();
  try {
    const [saved] = await storage.addTrips([{...flight(undefined, 'MU700', '2026-10-05'), unexpected: 'discard'}]);
    assert.match(saved.id, /^[\w-]{1,100}$/);
    assert.ok(saved.createdAt && saved.updatedAt);
    assert.equal('unexpected' in saved, false);
    await assert.rejects(storage.addTrips([flight('bad-date', 'MU700', '2026-02-30')]), error => error.status === 400);
    await storage.importSnapshot({version: 1, trips: [], config: {apiKey: 'must-not-enter-db', otherSecret: 'strip', model: 'model'}});
    assert.deepEqual(await storage.readJSON('config.json', {}), {model: 'model'});
    await storage.importSnapshot({version: 1, trips: [], aircraftCache: {
      BHLM: {registration: 'B-HLM', sourceUrl: 'javascript:alert(1)', photos: [{image: 'javascript:alert(1)', link: 'https://www.planespotters.net/photo/1/test', photographer: '作者'}]}
    }});
    const cache = await storage.readJSON('aircraft-cache.json', {});
    assert.equal(cache.BHLM.sourceUrl, '');
    assert.deepEqual(cache.BHLM.photos, []);
    await assert.rejects(storage.importSnapshot({version: 1, trips: [], places: {'flight|PEK': {lat: 400, lon: 0}}}), error => error.status === 400);
  } finally { database.close(); }
});

test('entry writes are per-key atomic and export/import is safe, conflict checked, and idempotent', async () => {
  const {database, storage} = await fixture();
  try {
    await Promise.all([
      storage.writeEntry('aircraft-cache.json', 'BHLM', {registration: 'B-HLM'}),
      storage.writeEntry('aircraft-cache.json', 'B1234', {registration: 'B-1234'}),
      storage.writeEntry('places.json', 'flight|PEK', {lat: 40, lon: 116})
    ]);
    await storage.writeJSON('config.json', {endpoint: 'https://example.test/v1', model: 'demo', apiKey: 'never-export'});
    const input = flight('flight-keep-id', 'CA890', '2026-10-03', {createdAt: 'old-created', updatedAt: 'old-updated'});
    const [source] = await storage.addTrips([input]);
    const snapshot = await storage.exportSnapshot();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.config.apiKey, undefined);
    assert.deepEqual((await storage.readJSON('aircraft-cache.json', {})).BHLM.registration, 'B-HLM');
    assert.deepEqual((await storage.readJSON('aircraft-cache.json', {})).B1234.registration, 'B-1234');

    const {database: targetDb, storage: target} = await fixture();
    try {
      await target.writeEntry('places.json', 'flight|PVG', {lat: 31, lon: 121});
      await target.importSnapshot(snapshot);
      const merged = await target.exportSnapshot();
      assert.deepEqual(merged.trips, [source]);
      assert.equal(merged.places['flight|PVG'].lat, 31);
      assert.equal(merged.places['flight|PEK'].lat, 40);
      assert.deepEqual(merged.aircraftCache, snapshot.aircraftCache);
      assert.deepEqual(await target.importSnapshot(snapshot), {importedTrips: 0, alreadyPresent: 1});
      const changedSameId = {...source, arrival: 'other'};
      await assert.rejects(target.importSnapshot({...snapshot, trips: [changedSameId]}), error => error.status === 409);
      const keyConflict = flight('flight-new-id', source.code, source.date);
      await assert.rejects(target.importSnapshot({...snapshot, trips: [source, keyConflict]}), error => error.status === 409);
      assert.deepEqual((await target.listTrips()).map(item => item.id), [source.id]);
    } finally { targetDb.close(); }
  } finally { database.close(); }
});

test('daily backups retain at most seven UTC dates and can be restored by date', async () => {
  const {database, storage} = await fixture();
  try {
    for (let day = 1; day <= 9; day++) {
      await storage.saveBackup({version: 1, trips: [{id: String(day)}]}, new Date(`2026-09-${String(day).padStart(2, '0')}T23:59:00.000Z`));
    }
    assert.deepEqual(await storage.listBackups(), [
      '2026-09-09', '2026-09-08', '2026-09-07', '2026-09-06', '2026-09-05', '2026-09-04', '2026-09-03'
    ]);
    assert.equal(await storage.readBackup('2026-09-02'), null);
    assert.deepEqual(await storage.readBackup('2026-09-09'), {version: 1, trips: [{id: '9'}]});
  } finally { database.close(); }
});

test('local snapshot export excludes API credentials and does not alter the source config', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'flight-cloud-snapshot-'));
  try {
    await writeFile(path.join(dataDir, 'trips.json'), JSON.stringify([flight('keep', 'CA123', '2026-10-01'), {id: 'train', type: 'train'}]));
    await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({endpoint: 'https://example.test', model: 'demo', apiKey: 'fixture-secret', temperature: 0}));
    const snapshot = await makeLocalSnapshot(dataDir);
    assert.equal(snapshot.trips.length, 1);
    assert.deepEqual(snapshot.config, {endpoint: 'https://example.test', model: 'demo', temperature: 0});
    assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false);
    assert.equal((await readFile(path.join(dataDir, 'config.json'), 'utf8')).includes('fixture-secret'), true);
  } finally { await rm(dataDir, {recursive: true, force: true}); }
});
