import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  authorizeRequest,
  clearAccessJwksCacheForTests,
  RequestAuthorizationError,
  verifyMutationRequest,
} from '../cloud/auth.mjs';

const teamDomain = 'trip-owner.cloudflareaccess.com';
const issuer = `https://${teamDomain}`;
const audience = 'test-access-app-aud';
const ownerEmail = 'owner@example.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', alg: 'RS256', use: 'sig' };
const rotatedPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotatedJwk = { ...rotatedPair.publicKey.export({ format: 'jwk' }), kid: 'rotated-key', alg: 'RS256', use: 'sig' };
const env = { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: audience, OWNER_EMAIL: ownerEmail };

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeToken(claims = {}, header = {}, key = privateKey) {
  const tokenHeader = { alg: 'RS256', typ: 'JWT', kid: 'test-signing-key', ...header };
  const payload = {
    iss: issuer,
    aud: audience,
    email: ownerEmail,
    sub: 'access-subject-1',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  };
  const input = `${encode(tokenHeader)}.${encode(payload)}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

function requestWithToken(token) {
  const headers = new Headers();
  if (token !== undefined) headers.set('Cf-Access-Jwt-Assertion', token);
  return new Request('https://trips.example.workers.dev/', { headers });
}

const jwksFetcher = async (url, init) => {
  assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
  assert.equal(init.redirect, 'manual');
  return Response.json({ keys: [publicJwk] });
};

before(() => clearAccessJwksCacheForTests());

test('接受签名有效、团队受众和邮箱都匹配的 Access JWT', async () => {
  clearAccessJwksCacheForTests();
  const identity = await authorizeRequest(requestWithToken(makeToken()), env, { fetcher: jwksFetcher });
  assert.deepEqual(identity, { email: ownerEmail, subject: 'access-subject-1' });
});

test('拒绝被篡改的签名', async () => {
  clearAccessJwksCacheForTests();
  const token = makeToken();
  const parts = token.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  await assert.rejects(
    authorizeRequest(requestWithToken(parts.join('.')), env, { fetcher: jwksFetcher }),
    error => error instanceof RequestAuthorizationError && error.status === 401,
  );
});

test('拒绝错误签发者、错误应用受众、过期令牌和其他邮箱', async () => {
  const invalidCases = [
    [{ iss: 'https://attacker.cloudflareaccess.com' }, 401],
    [{ aud: 'another-app' }, 401],
    [{ exp: Math.floor(Date.now() / 1000) - 1 }, 401],
    [{ email: 'someone-else@example.com' }, 403],
  ];
  for (const [claims, status] of invalidCases) {
    clearAccessJwksCacheForTests();
    await assert.rejects(
      authorizeRequest(requestWithToken(makeToken(claims)), env, { fetcher: jwksFetcher }),
      error => error instanceof RequestAuthorizationError && error.status === status,
    );
  }
});

test('缺少部署配置时失败关闭，且不会接受缺少 JWT 的请求', async () => {
  await assert.rejects(
    authorizeRequest(requestWithToken(makeToken()), {}, { fetcher: jwksFetcher }),
    error => error instanceof RequestAuthorizationError && error.status === 503,
  );
  await assert.rejects(
    authorizeRequest(requestWithToken(undefined), env, { fetcher: jwksFetcher }),
    error => error instanceof RequestAuthorizationError && error.status === 401,
  );
});

test('JWKS 请求失败或返回无效数据时以服务不可用拒绝', async () => {
  for (const fetcher of [
    async () => { throw new Error('network failure'); },
    async () => new Response('offline', { status: 503 }),
    async () => Response.json({ keys: [] }),
  ]) {
    clearAccessJwksCacheForTests();
    await assert.rejects(
      authorizeRequest(requestWithToken(makeToken()), env, { fetcher }),
      error => error instanceof RequestAuthorizationError && error.status === 503,
    );
  }
});

test('未知 kid 在 60 秒冷却内不触发重复下载，冷却后刷新可接受轮换密钥并合并并发请求', async () => {
  clearAccessJwksCacheForTests();
  let count = 0;
  const fetcher = async () => {
    count += 1;
    if (count === 1) return Response.json({ keys: [publicJwk] });
    await new Promise(resolve => setTimeout(resolve, 15));
    return Response.json({ keys: [rotatedJwk] });
  };
  const now = Date.now();
  const rotatedToken = makeToken({}, { kid: 'rotated-key' }, rotatedPair.privateKey);
  await assert.rejects(
    authorizeRequest(requestWithToken(rotatedToken), env, { fetcher, now }),
    error => error instanceof RequestAuthorizationError && error.status === 401,
  );
  await assert.rejects(
    authorizeRequest(requestWithToken(rotatedToken), env, { fetcher, now: now + 30_000 }),
    error => error instanceof RequestAuthorizationError && error.status === 401,
  );
  assert.equal(count, 1, '冷却期内不应重复下载 JWKS');

  const parallel = await Promise.all([
    authorizeRequest(requestWithToken(rotatedToken), env, { fetcher, now: now + 60_001 }),
    authorizeRequest(requestWithToken(rotatedToken), env, { fetcher, now: now + 60_001 }),
  ]);
  assert.deepEqual(parallel.map(identity => identity.email), [ownerEmail, ownerEmail]);
  assert.equal(count, 2, '并发未知 kid 应共享一次轮换刷新');
});

test('变更请求只允许同源 Origin 并要求本地请求标记', () => {
  const get = new Request('https://trips.example.workers.dev/api/trips');
  assert.equal(verifyMutationRequest(get), true);
  const sameOrigin = new Request('https://trips.example.workers.dev/api/trips', {
    method: 'POST',
    headers: { Origin: 'https://trips.example.workers.dev', 'X-Trip-Local': '1' },
  });
  assert.equal(verifyMutationRequest(sameOrigin), true);
  for (const headers of [
    { Origin: 'https://attacker.example', 'X-Trip-Local': '1' },
    { Origin: 'https://trips.example.workers.dev' },
    {},
  ]) {
    const request = new Request('https://trips.example.workers.dev/api/trips', { method: 'PUT', headers });
    assert.throws(() => verifyMutationRequest(request), error => error.status === 403);
  }
});
