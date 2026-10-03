import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readOptionalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取 ${path.basename(file)}：文件不是有效 JSON 或不可访问。`);
  }
}

export async function makeLocalSnapshot(dataDir = path.join(projectRoot, 'data')) {
  const [trips, places, aircraftCache, savedConfig] = await Promise.all([
    readOptionalJson(path.join(dataDir, 'trips.json'), []),
    readOptionalJson(path.join(dataDir, 'places.json'), {}),
    readOptionalJson(path.join(dataDir, 'aircraft-cache.json'), {}),
    readOptionalJson(path.join(dataDir, 'config.json'), {})
  ]);
  if (!Array.isArray(trips)) throw new Error('trips.json 格式不正确；未生成迁移快照。');
  const config = {};
  for (const key of ['endpoint', 'model', 'temperature']) {
    if (savedConfig && Object.hasOwn(savedConfig, key)) config[key] = savedConfig[key];
  }
  return {
    version: 1,
    trips: trips.filter(trip => trip?.type === 'flight'),
    places: places && typeof places === 'object' && !Array.isArray(places) ? places : {},
    aircraftCache: aircraftCache && typeof aircraftCache === 'object' && !Array.isArray(aircraftCache) ? aircraftCache : {},
    config
  };
}

async function main() {
  const outputPath = path.resolve(process.argv[2] ?? path.join(projectRoot, 'cloud-private', 'cloud-migration-snapshot.json'));
  const dataDir = path.resolve(process.argv[3] ?? path.join(projectRoot, 'data'));
  const relative = path.relative(dataDir, outputPath);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('快照输出位置不能放在应用 data 文件夹内。');
  }
  const snapshot = await makeLocalSnapshot(dataDir);
  await mkdir(path.dirname(outputPath), {recursive: true, mode: 0o700});
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
  console.log(`已生成 Cloudflare 迁移快照：${outputPath}`);
  console.log(`包含 ${snapshot.trips.length} 条航班；API Key 未导出。请妥善保管该快照文件。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
