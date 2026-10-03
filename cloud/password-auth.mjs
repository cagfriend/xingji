import {RequestAuthorizationError, verifyMutationRequest} from './auth.mjs';
import {isValidPasswordVerifier, verifyPassword} from './password-verifier.mjs';

const SESSION_COOKIE = '__Host-trip-session';
const SESSION_SECONDS = 24 * 60 * 60;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_BODY = 2048;
const RATE_LIMIT_SQL = `
  INSERT INTO login_rate_limits (bucket_key, window_start, attempts)
  VALUES (?, ?, 1)
  ON CONFLICT(bucket_key) DO UPDATE SET
    window_start = excluded.window_start,
    attempts = CASE
      WHEN login_rate_limits.window_start = excluded.window_start THEN login_rate_limits.attempts + 1
      ELSE 1
    END
  RETURNING attempts
`;

class PasswordAuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function failure(status, message) {
  return new PasswordAuthError(status, message);
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      ...headers,
    },
  });
}

function errorResponse(error) {
  if (error instanceof RequestAuthorizationError) return jsonResponse({error: error.message}, error.status);
  if (error instanceof PasswordAuthError) return jsonResponse({error: error.message}, error.status);
  return jsonResponse({error: '登录服务暂时不可用'}, 503);
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64Url(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function getConfig(env) {
  if (env?.AUTH_MODE !== 'password') throw failure(503, '密码登录尚未配置');
  const passwordVerifier = typeof env.LOGIN_PASSWORD_HASH === 'string' ? env.LOGIN_PASSWORD_HASH : '';
  const sessionSecretText = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET.trim() : '';
  const sessionSecret = decodeBase64Url(sessionSecretText);
  const ownerEmail = typeof env.OWNER_EMAIL === 'string' ? env.OWNER_EMAIL.trim().toLowerCase() : '';
  if (!isValidPasswordVerifier(passwordVerifier) || !sessionSecret || sessionSecret.length < 32
      || sessionSecretText.length < 43 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw failure(503, '密码登录尚未配置');
  }
  if (!env.DB?.prepare) throw failure(503, '云端登录服务尚未配置');
  return {passwordVerifier, sessionSecret, ownerEmail, db: env.DB};
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', secret, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

function toHex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function passwordVersion(passwordVerifier) {
  return toHex(await digest(new TextEncoder().encode(passwordVerifier)));
}

async function sessionHash(config, token) {
  return toHex(await hmac(config.sessionSecret, `session:${token}`));
}

function readCookie(request) {
  const cookie = request.headers.get('cookie') || '';
  const matching = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (matching.length !== 1) return '';
  const token = matching[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : '';
}

async function readJson(request) {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) throw failure(415, '请提交 JSON 数据');
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_LOGIN_BODY) throw failure(413, '登录请求内容过大');
  if (!request.body) throw failure(400, '登录请求内容不完整');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_LOGIN_BODY) {
      await reader.cancel();
      throw failure(413, '登录请求内容过大');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const input = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid body');
    return input;
  } catch {
    throw failure(400, '登录请求内容无效');
  }
}

async function bumpRateLimit(db, bucketKey, windowStart) {
  const row = await db.prepare(RATE_LIMIT_SQL).bind(bucketKey, windowStart).first();
  if (!row || !Number.isInteger(row.attempts)) throw new Error('rate limit write failed');
  return row.attempts;
}

async function rateLimitLogin(request, config, nowMs) {
  const windowStart = Math.floor(nowMs / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const ipKey = `ip:${toHex(await hmac(config.sessionSecret, `ip:${ip}`))}`;
  const [ipAttempts, globalAttempts] = await Promise.all([
    bumpRateLimit(config.db, ipKey, windowStart),
    bumpRateLimit(config.db, 'global', windowStart),
  ]);
  if (ipAttempts === 1) {
    await config.db.prepare('DELETE FROM login_rate_limits WHERE window_start < ?').bind(windowStart - 24 * 60 * 60 * 1000).run();
  }
  const retryAfter = Math.max(1, Math.ceil((windowStart + RATE_WINDOW_MS - nowMs) / 1000));
  if (ipAttempts > 10 || globalAttempts > 100) throw failure(429, `登录尝试次数过多，请在 ${retryAfter} 秒后重试`);
}

function secureCookie(token, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

async function login(request, env, options) {
  try {
    verifyMutationRequest(request);
    const config = getConfig(env);
    const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
    await rateLimitLogin(request, config, nowMs);
    const input = await readJson(request);
    if (typeof input.password !== 'string' || !await verifyPassword(input.password, config.passwordVerifier)) {
      throw failure(401, '登录失败，请检查密码');
    }

    const rawToken = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const hashedToken = await sessionHash(config, rawToken);
    const expiresAt = Math.floor(nowMs / 1000) + SESSION_SECONDS;
    const version = await passwordVersion(config.passwordVerifier);
    await config.db.prepare('INSERT INTO auth_sessions (session_hash, password_version, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(hashedToken, version, expiresAt, Math.floor(nowMs / 1000)).run();
    await config.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(Math.floor(nowMs / 1000)).run();
    return jsonResponse({ok: true}, 200, { 'Set-Cookie': secureCookie(rawToken) });
  } catch (error) {
    return errorResponse(error);
  }
}

async function logout(request, env, options) {
  try {
    verifyMutationRequest(request);
    const config = getConfig(env);
    const token = readCookie(request);
    if (token) await config.db.prepare('DELETE FROM auth_sessions WHERE session_hash = ?').bind(await sessionHash(config, token)).run();
    return jsonResponse({ok: true}, 200, {'Set-Cookie': secureCookie('', 0)});
  } catch (error) {
    return errorResponse(error);
  }
}

/** Handle password login/logout routes; return null for routes owned by the application Worker. */
export async function handlePasswordAuth(request, env, options = {}) {
  if (env?.AUTH_MODE !== 'password') return null;
  const pathname = new URL(request.url).pathname;
  if (pathname === '/auth/login') {
    if (request.method !== 'POST') return jsonResponse({error: '仅支持 POST 登录'}, 405, {Allow: 'POST'});
    return login(request, env, options);
  }
  if (pathname === '/auth/logout') {
    if (request.method !== 'POST') return jsonResponse({error: '仅支持 POST 退出登录'}, 405, {Allow: 'POST'});
    return logout(request, env, options);
  }
  return null;
}

/** Authenticate a browser session and return the single owner's identity. */
export async function authorizePasswordRequest(request, env, options = {}) {
  let config;
  try { config = getConfig(env); }
  catch (error) {
    if (error instanceof PasswordAuthError) throw new RequestAuthorizationError(503);
    throw new RequestAuthorizationError(503);
  }

  const token = readCookie(request);
  if (!token) throw new RequestAuthorizationError(401);
  try {
    const hash = await sessionHash(config, token);
    const row = await config.db.prepare('SELECT password_version, expires_at FROM auth_sessions WHERE session_hash = ?').bind(hash).first();
    const nowSeconds = Math.floor((Number.isFinite(options.now) ? options.now : Date.now()) / 1000);
    const version = await passwordVersion(config.passwordVerifier);
    if (!row || row.expires_at <= nowSeconds || row.password_version !== version) {
      if (row) await config.db.prepare('DELETE FROM auth_sessions WHERE session_hash = ?').bind(hash).run();
      throw new RequestAuthorizationError(401);
    }
    return Object.freeze({email: config.ownerEmail, subject: null});
  } catch (error) {
    if (error instanceof RequestAuthorizationError) throw error;
    throw new RequestAuthorizationError(503);
  }
}
