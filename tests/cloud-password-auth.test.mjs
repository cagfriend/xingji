import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {
  authorizePasswordRequest,
  handlePasswordAuth,
} from '../cloud/password-auth.mjs';
import {createPasswordVerifier, isValidPasswordVerifier, verifyPassword} from '../cloud/password-verifier.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://trip-test.example.workers.dev';
const ownerEmail = 'you@example.com';
const password = randomBytes(32).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const passwordHash = sha256(password);
const sessionSecret = randomBytes(32).toString('base64url');

async function makeContext(overrides = {}) {
  const nativeDb = new DatabaseSync(':memory:');
  nativeDb.exec(await readFile(path.join(root, 'cloud/migrations/0002_password_auth.sql'), 'utf8'));
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...params) { values = params; return this; },
        async first() { return nativeDb.prepare(sql).get(...values) ?? null; },
        async all() { return {results: nativeDb.prepare(sql).all(...values)}; },
        async run() {
          const result = nativeDb.prepare(sql).run(...values);
          return {meta: {changes: Number(result.changes)}};
        },
      };
    },
    async batch(statements) {
      nativeDb.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.run());
        nativeDb.exec('COMMIT');
        return results;
      } catch (error) {
        nativeDb.exec('ROLLBACK');
        throw error;
      }
    },
    native: nativeDb,
  };
  const env = {
    AUTH_MODE: 'password',
    LOGIN_PASSWORD_HASH: passwordHash,
    SESSION_SECRET: sessionSecret,
    OWNER_EMAIL: ownerEmail,
    DB: db,
    ...overrides,
  };
  return {db, env};
}

function request(pathname, {method = 'POST', body, headers = {}, ip = '203.0.113.10'} = {}) {
  const requestHeaders = new Headers({
    'Origin': base,
    'X-Trip-Local': '1',
    'Content-Type': 'application/json',
    'CF-Connecting-IP': ip,
  });
  for (const [key, value] of Object.entries(headers)) {
    if (value === null) requestHeaders.delete(key);
    else requestHeaders.set(key, value);
  }
  return new Request(`${base}${pathname}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)}),
  });
}

async function login(env, {passwordValue = password, options = {}, ...requestOptions} = {}) {
  const req = request('/auth/login', {...requestOptions, body: {password: passwordValue}});
  return handlePasswordAuth(req, env, options);
}

function cookiePair(response) {
  const cookie = response.headers.get('set-cookie') || '';
  const pair = cookie.split(';', 1)[0];
  return {cookie, value: pair.slice('__Host-trip-session='.length), header: pair};
}

test('随机 32 字节密码登录后只保存 session 摘要，cookie 带安全属性且可授权', async () => {
  const {db, env} = await makeContext();
  const response = await login(env);
  assert.equal(response.status, 200, await response.clone().text());
  const responseText = await response.clone().text();
  assert.deepEqual(await response.json(), {ok: true});
  const {cookie, value, header} = cookiePair(response);
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Max-Age=86400/);
  assert.match(cookie, /; Secure/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.equal(cookie.includes('Domain='), false);
  const rows = db.native.prepare('SELECT session_hash FROM auth_sessions').all();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].session_hash, value);
  assert.equal(rows[0].session_hash.includes(password), false);
  const identity = await authorizePasswordRequest(request('/api/trips', {method: 'GET', headers: {Cookie: header}}), env);
  assert.deepEqual(identity, {email: ownerEmail, subject: null});
  assert.equal(responseText.includes(password), false);
  assert.equal(responseText.includes(sessionSecret), false);
});

test('PBKDF2 verifier 支持普通 8 到 128 字符密码且不 trim', async () => {
  const sample = 'T3st!Pass';
  const verifier = await createPasswordVerifier(sample);
  assert.match(verifier, /^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
  assert.equal(isValidPasswordVerifier(verifier), true);
  assert.equal(await verifyPassword(sample, verifier), true);
  assert.equal(await verifyPassword(`${sample} `, verifier), false);
  assert.equal(await verifyPassword('short', verifier), false);
  assert.equal(await verifyPassword('x'.repeat(129), verifier), false);
  const maxLengthVerifier = await createPasswordVerifier('x'.repeat(128));
  assert.equal(isValidPasswordVerifier(maxLengthVerifier), true);
  assert.equal(await verifyPassword('x'.repeat(128), maxLengthVerifier), true);
  await assert.rejects(createPasswordVerifier('short'), TypeError);
  await assert.rejects(createPasswordVerifier('x'.repeat(129)), TypeError);
  assert.equal(await verifyPassword(password, verifier), false);
});

test('8 字符 PBKDF2 密码可登录，verifier 轮换会撤销旧会话', async () => {
  const sample = 'A8x!k2Qz';
  const verifier = await createPasswordVerifier(sample);
  const replacementVerifier = await createPasswordVerifier('B9y@l3Rw');
  const {env} = await makeContext({LOGIN_PASSWORD_HASH: verifier});
  const response = await login(env, {passwordValue: sample});
  assert.equal(response.status, 200, await response.clone().text());
  const {header} = cookiePair(response);
  const authenticated = request('/api/trips', {method: 'GET', headers: {Cookie: header}});
  assert.equal((await authorizePasswordRequest(authenticated, env)).email, ownerEmail);
  await assert.rejects(
    authorizePasswordRequest(authenticated, {...env, LOGIN_PASSWORD_HASH: replacementVerifier}),
    error => error.status === 401,
  );
  const wrong = await login(env, {passwordValue: 'wrongPass'});
  assert.equal(wrong.status, 401);
});

test('畸形或未支持版本的 verifier 会 fail closed', async () => {
  for (const verifier of [
    'pbkdf2-sha256$99999$' + 'A'.repeat(22) + '$' + 'A'.repeat(43),
    'pbkdf2-sha256$100000$bad$' + 'A'.repeat(43),
    'pbkdf2-sha256$100000$' + 'A'.repeat(22) + '$' + 'A'.repeat(42),
    `${passwordHash} `,
  ]) {
    assert.equal(isValidPasswordVerifier(verifier), false);
    const {env} = await makeContext({LOGIN_PASSWORD_HASH: verifier});
    assert.equal((await login(env, {passwordValue: password})).status, 503);
    await assert.rejects(
      authorizePasswordRequest(request('/api/trips', {method: 'GET'}), env),
      error => error.status === 503,
    );
  }
});

test('缺少密码 hash、session secret、owner 或 D1 时登录和访问均 fail closed', async () => {
  for (const override of [
    {LOGIN_PASSWORD_HASH: ''},
    {SESSION_SECRET: 'too-short'},
    {OWNER_EMAIL: ''},
    {DB: undefined},
  ]) {
    const {env} = await makeContext(override);
    const response = await login(env);
    assert.equal(response.status, 503);
    await assert.rejects(
      authorizePasswordRequest(request('/api/trips', {method: 'GET'}), env),
      error => error.status === 503,
    );
  }
});

test('密碼錯误返回相同失败结果且不泄漏密码或 IP', async () => {
  const {env} = await makeContext();
  const attemptedPassword = randomBytes(32).toString('base64url');
  const response = await login(env, {passwordValue: attemptedPassword, ip: '198.51.100.77'});
  assert.equal(response.status, 401);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(attemptedPassword));
  assert.equal(text.includes('198.51.100.77'), false);
});

test('过期 session、密码轮换、session secret 轮换和登出都会撤销旧 cookie', async () => {
  const {db, env} = await makeContext();
  const now = Date.parse('2026-09-28T00:00:00Z');
  const loggedIn = await login(env, {options: {now}});
  const {header} = cookiePair(loggedIn);
  const authenticated = request('/api/trips', {method: 'GET', headers: {Cookie: header}});
  assert.equal((await authorizePasswordRequest(authenticated, env, {now})).email, ownerEmail);
  await assert.rejects(
    authorizePasswordRequest(authenticated, env, {now: now + 24 * 60 * 60 * 1000}),
    error => error.status === 401,
  );

  const secondLogin = await login(env, {options: {now: now + 1000}});
  const secondHeader = cookiePair(secondLogin).header;
  await assert.rejects(
    authorizePasswordRequest(request('/api/trips', {method: 'GET', headers: {Cookie: secondHeader}}), {...env, LOGIN_PASSWORD_HASH: sha256(randomBytes(32).toString('base64url'))}, {now: now + 2000}),
    error => error.status === 401,
  );

  const thirdLogin = await login(env, {options: {now: now + 3000}});
  const thirdHeader = cookiePair(thirdLogin).header;
  await assert.rejects(
    authorizePasswordRequest(request('/api/trips', {method: 'GET', headers: {Cookie: thirdHeader}}), {...env, SESSION_SECRET: randomBytes(32).toString('base64url')}, {now: now + 4000}),
    error => error.status === 401,
  );

  const fourthLogin = await login(env, {options: {now: now + 5000}});
  const fourthHeader = cookiePair(fourthLogin).header;
  const logoutResponse = await handlePasswordAuth(request('/auth/logout', {headers: {Cookie: fourthHeader}}), env, {now: now + 6000});
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);
  await assert.rejects(
    authorizePasswordRequest(request('/api/trips', {method: 'GET', headers: {Cookie: fourthHeader}}), env, {now: now + 7000}),
    error => error.status === 401,
  );
  assert.equal(db.native.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 1, '旧 session secret 对应的记录会在自然过期时清理，但无法再授权');
});

test('login/logout 拒绝跨源或缺失本地请求标记的请求', async () => {
  const {env} = await makeContext();
  for (const pathname of ['/auth/login', '/auth/logout']) {
    for (const headers of [
      {'Origin': 'https://attacker.example', 'X-Trip-Local': '1'},
      {'Origin': base, 'X-Trip-Local': null},
    ]) {
      const response = await handlePasswordAuth(request(pathname, {body: pathname.endsWith('login') ? {password} : {}, headers}), env);
      assert.equal(response.status, 403);
    }
  }
});

test('login JSON body 按串流限制在 2048 bytes 内', async () => {
  const {env} = await makeContext();
  const response = await handlePasswordAuth(request('/auth/login', {body: `{"password":"${'x'.repeat(2100)}"}`}), env);
  assert.equal(response.status, 413);
});

test('原子固定窗口同时限制单 IP 10 次和全局 100 次，且数据库不存明文 IP', async () => {
  const {db, env} = await makeContext();
  const perIp = await Promise.all(Array.from({length: 11}, () => login(env, {passwordValue: randomBytes(32).toString('base64url')})));
  assert.equal(perIp.filter(response => response.status === 401).length, 10);
  assert.equal(perIp.filter(response => response.status === 429).length, 1);
  const savedBucket = db.native.prepare('SELECT bucket_key FROM login_rate_limits WHERE bucket_key != ?').get('global');
  assert.match(savedBucket.bucket_key, /^ip:[a-f0-9]{64}$/);
  assert.equal(savedBucket.bucket_key.includes('203.0.113.10'), false);

  const {env: globalEnv} = await makeContext();
  const distributed = await Promise.all(Array.from({length: 101}, (_, index) => login(globalEnv, {
    passwordValue: randomBytes(32).toString('base64url'),
    ip: `198.51.100.${index + 1}`,
  })));
  assert.equal(distributed.filter(response => response.status === 401).length, 100);
  assert.equal(distributed.filter(response => response.status === 429).length, 1);
});

test('非密码模式不接管 Worker 自己的路由', async () => {
  const {env} = await makeContext({AUTH_MODE: 'access'});
  assert.equal(await handlePasswordAuth(request('/auth/login', {body: {password}}), env), null);
  assert.equal(await handlePasswordAuth(request('/api/trips'), env), null);
});
