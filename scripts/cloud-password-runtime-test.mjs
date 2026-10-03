// Exercises password login and protected routes in Workerd using an ephemeral D1.
// All credentials and flight records are synthetic and discarded on exit.
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {readdir, readFile, realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPasswordVerifier} from '../cloud/password-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerRequire = createRequire(await realpath(path.join(root, 'node_modules/wrangler/package.json')));
const {Miniflare, convertV4MiniflareOptions, Response: RuntimeResponse} = wranglerRequire('miniflare');
const origin = 'https://password-runtime.example.workers.dev';
const password = 'Test5678';
const passwordHash = await createPasswordVerifier(password);
const sessionSecret = randomBytes(32).toString('base64url');
const sessionCookieName = '__Host-trip-session';
const assertNoAuthRedirect = async response => {
  assert.ok([302, 303].includes(response.status), `expected redirect to /login, got ${response.status}: ${await response.clone().text()}`);
  assert.equal(new URL(response.headers.get('location'), origin).pathname, '/login');
};

const mf = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  scriptPath: path.join(root, 'cloud-build/worker.js'),
  compatibilityDate: '2026-09-01',
  host: '127.0.0.1',
  port: 0,
  cf: false,
  bindings: {
    AUTH_MODE: 'password',
    LOGIN_PASSWORD_HASH: passwordHash,
    SESSION_SECRET: sessionSecret,
    OWNER_EMAIL: 'password-runtime@example.test',
    AI_API_KEY: 'synthetic-runtime-secret'
  },
  d1Databases: ['DB'],
  assets: {directory: path.join(root, 'dist'), binding: 'ASSETS', run_worker_first: true, routerConfig: {has_user_worker: true}},
  outboundService: async () => new RuntimeResponse('External calls disabled in password runtime test', {status: 503})
}));

const request = (route, {method = 'GET', body, cookie = '', originHeader = origin, localHeader = true, headers = {}} = {}) => mf.dispatchFetch(origin + route, {
  method,
  redirect: 'manual',
  headers: {
    ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
    ...(cookie ? {Cookie: cookie} : {}),
    ...(originHeader ? {Origin: originHeader} : {}),
    ...(localHeader ? {'X-Trip-Local': '1'} : {}),
    ...headers
  },
  ...(body !== undefined ? {body: JSON.stringify(body)} : {})
});

function extractCookie(response) {
  const setCookie = response.headers.get('set-cookie') || '';
  const pair = setCookie.split(';', 1)[0];
  assert.match(pair, new RegExp(`^${sessionCookieName}=[^;]+$`), 'login must issue the host-only session cookie');
  assert.match(setCookie, /(?:^|;\s*)Path=\//i);
  assert.match(setCookie, /(?:^|;\s*)HttpOnly/i);
  assert.match(setCookie, /(?:^|;\s*)Secure/i);
  assert.match(setCookie, /(?:^|;\s*)SameSite=(?:Strict|Lax)/i);
  return pair;
}

async function applyMigrations(db) {
  const directory = path.join(root, 'cloud/migrations');
  const files = (await readdir(directory)).filter(name => /^\d+.*\.sql$/i.test(name)).sort();
  assert.ok(files.length > 0, 'D1 migrations are missing');
  for (const file of files) {
    const sql = (await readFile(path.join(directory, file), 'utf8')).replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
}

try {
  const db = await mf.getD1Database('DB');
  await applyMigrations(db);

  const loginPage = await request('/login');
  assert.equal(loginPage.status, 200, await loginPage.clone().text());
  assert.match(await loginPage.text(), /登录|行迹/);
  for (const route of ['/login.css', '/login.js']) {
    const asset = await request(route);
    assert.equal(asset.status, 200, `${route}: ${await asset.clone().text()}`);
  }

  for (const route of ['/', '/stats.html']) await assertNoAuthRedirect(await request(route));
  for (const route of ['/api/trips', '/api/config', '/api/export', '/api/backups']) {
    const response = await request(route);
    assert.equal(response.status, 401, `${route} must require a session`);
  }
  for (const route of ['/data/config.json', '/data/trips.json', '/cloud-private/cloud-migration-snapshot.json']) {
    const response = await request(route);
    assert.ok([401, 404].includes(response.status), `${route} unexpectedly exposed local files`);
  }

  const wrongPassword = await request('/auth/login', {method: 'POST', body: {password: `${password}-wrong`}});
  assert.equal(wrongPassword.status, 401, 'incorrect password must be rejected');
  assert.equal(wrongPassword.headers.get('set-cookie'), null, 'failed login must not issue a session');
  assert.equal((await request('/auth/login', {method: 'POST', body: {password}, originHeader: 'https://attacker.example'})).status, 403);
  assert.equal((await request('/auth/login', {method: 'POST', body: {password}, localHeader: false})).status, 403);

  const login = await request('/auth/login', {method: 'POST', body: {password}});
  assert.equal(login.status, 200, await login.clone().text());
  const cookie = extractCookie(login);
  const config = await request('/api/config', {cookie});
  assert.equal(config.status, 200, await config.clone().text());
  const configValue = await config.json();
  assert.equal(configValue.authMode, 'password');
  assert.equal(configValue.apiKey, '');
  assert.equal(configValue.hasApiKey, true);

  const home = await request('/', {cookie});
  assert.equal(home.status, 200, await home.clone().text());
  assert.match(await home.text(), /行迹/);
  let stats = await request('/stats.html', {cookie});
  if ([301, 302, 303, 307, 308].includes(stats.status)) {
    const destination = new URL(stats.headers.get('location'), origin);
    assert.equal(destination.origin, origin, 'stats redirect must stay on the app origin');
    stats = await request(destination.pathname, {cookie});
  }
  assert.equal(stats.status, 200, `stats target ${stats.url}: ${await stats.clone().text()}`);

  const flight = {type: 'flight', code: 'CA721', date: '2026-10-12', departure: '北京首都国际机场（PEK）', arrival: '东京羽田国际机场（HND）'};
  const createBody = {confirmed: true, trips: [flight]};
  assert.equal((await request('/api/trips', {method: 'POST', body: createBody, cookie, originHeader: 'https://attacker.example'})).status, 403);
  assert.equal((await request('/api/trips', {method: 'POST', body: createBody, cookie, localHeader: false})).status, 403);
  const created = await request('/api/trips', {method: 'POST', body: createBody, cookie});
  assert.equal(created.status, 201, await created.clone().text());
  const trip = (await created.json()).trips[0];
  assert.ok(trip.id && trip.createdAt && trip.updatedAt);
  assert.equal((await request('/api/trips', {cookie})).status, 200);
  const duplicate = await request('/api/trips', {method: 'POST', body: createBody, cookie});
  assert.equal(duplicate.status, 409, await duplicate.clone().text());

  const updated = {...flight, date: '2026-10-13', arrival: '大阪关西国际机场（KIX）'};
  const update = await request(`/api/trips/${trip.id}`, {method: 'PUT', body: {confirmed: true, trip: updated}, cookie});
  assert.equal(update.status, 200, await update.clone().text());
  const backup = await request('/api/export', {cookie});
  assert.equal(backup.status, 200, await backup.clone().text());
  const snapshot = await backup.json();
  assert.equal(snapshot.trips.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('synthetic-runtime-secret'), false);
  const importFlight = {...flight, id: 'runtime-imported-flight', date: '2026-11-02', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'};
  const imported = await request('/api/import', {method: 'POST', body: {confirmed: true, snapshot: {...snapshot, trips: [importFlight]}}, cookie});
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal((await (await request('/api/trips', {cookie})).json()).trips.length, 2);
  const remove = await request(`/api/trips/${trip.id}`, {method: 'DELETE', body: {confirmed: true}, cookie});
  assert.equal(remove.status, 200, await remove.clone().text());

  const tamperedCookie = `${sessionCookieName}=${cookie.slice(sessionCookieName.length + 1, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await request('/api/trips', {cookie: tamperedCookie})).status, 401, 'tampered session must be rejected');
  const logout = await request('/auth/logout', {method: 'POST', body: {}, cookie});
  assert.equal(logout.status, 200, await logout.clone().text());
  assert.equal((await request('/api/trips', {cookie})).status, 401, 'logout must revoke the session server-side');
  assert.equal((await request('/api/trips', {cookie: tamperedCookie})).status, 401);
  assert.equal((await request('/', {cookie})).status, 303);

  console.log('Password runtime test passed: public login UI, password/CSRF checks, private app and APIs, D1 CRUD/dedup/import/export, session tampering and logout revocation.');
} finally {
  await mf.dispose();
}
