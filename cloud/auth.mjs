const JWKS_CACHE_TTL_MS = 15 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 60 * 1000;
const JWKS_CACHE_MAX_ISSUERS = 4;
const MAX_TOKEN_CHARS = 16_384;
const JWKS_TIMEOUT_MS = 5_000;
const jwksCache = new Map();
const jwksRefreshAttempts = new Map();
const jwksInFlight = new Map();

function timeoutOption(milliseconds) {
  try {
    if (typeof AbortSignal?.timeout === 'function') return { signal: AbortSignal.timeout(milliseconds) };
  } catch {
    // Older Workerd versions may not implement AbortSignal.timeout yet.
  }
  return {};
}

export class RequestAuthorizationError extends Error {
  constructor(status) {
    super(status === 503
      ? '登录保护尚未配置或验证服务不可用'
      : status === 403 ? '当前账号无权访问' : '请登录后访问');
    this.name = 'RequestAuthorizationError';
    this.status = status;
  }
}

function authorizationError(status) {
  return new RequestAuthorizationError(status);
}

function getAccessSettings(env) {
  const domain = typeof env?.ACCESS_TEAM_DOMAIN === 'string' ? env.ACCESS_TEAM_DOMAIN.trim() : '';
  const audience = typeof env?.ACCESS_AUD === 'string' ? env.ACCESS_AUD.trim() : '';
  const ownerEmail = typeof env?.OWNER_EMAIL === 'string' ? env.OWNER_EMAIL.trim().toLowerCase() : '';

  // Accept only Cloudflare's fixed team-domain shape; never fetch keys from a
  // request-controlled or arbitrary environment URL.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/i.test(domain)
      || !audience || !ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    throw authorizationError(503);
  }

  return {
    issuer: `https://${domain.toLowerCase()}`,
    audience,
    ownerEmail,
  };
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(value)));
}

function parseToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS) throw authorizationError(401);
  const parts = token.split('.');
  if (parts.length !== 3) throw authorizationError(401);
  try {
    const header = decodeJsonPart(parts[0]);
    const payload = decodeJsonPart(parts[1]);
    const signature = decodeBase64Url(parts[2]);
    if (!header || typeof header !== 'object' || Array.isArray(header)
        || !payload || typeof payload !== 'object' || Array.isArray(payload)
        || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      throw new Error('invalid JWT header or payload');
    }
    return { header, payload, signature, signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`) };
  } catch {
    throw authorizationError(401);
  }
}

function cachePut(issuer, keys, now) {
  jwksCache.delete(issuer);
  jwksCache.set(issuer, { keys, fetchedAt: now, expiresAt: now + JWKS_CACHE_TTL_MS });
  while (jwksCache.size > JWKS_CACHE_MAX_ISSUERS) jwksCache.delete(jwksCache.keys().next().value);
}

async function fetchAndCacheJwks(issuer, fetcher, now) {
  let response;
  try {
    response = await fetcher(`${issuer}/cdn-cgi/access/certs`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // Cloudflare Workers support "manual" but reject the Fetch-standard
      // "error" mode. A 3xx response is rejected below instead of followed.
      redirect: 'manual',
      ...timeoutOption(JWKS_TIMEOUT_MS),
    });
  } catch {
    throw authorizationError(503);
  }
  if (!response?.ok) throw authorizationError(503);

  let body;
  try {
    const text = await response.text();
    if (text.length > 256_000) throw new Error('oversized JWKS');
    body = JSON.parse(text);
  } catch {
    throw authorizationError(503);
  }
  const keys = Array.isArray(body?.keys)
    ? body.keys.filter(key => key && key.kty === 'RSA' && typeof key.kid === 'string'
        && key.kid.length > 0 && typeof key.n === 'string' && typeof key.e === 'string'
        && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'))
    : [];
  if (keys.length === 0 || keys.length > 32) throw authorizationError(503);
  cachePut(issuer, keys, now);
  return keys;
}

async function loadJwks(issuer, fetcher, now, forceRefresh = false) {
  const cached = jwksCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > now) return cached.keys;
  if (forceRefresh && cached && now - cached.fetchedAt < JWKS_REFRESH_COOLDOWN_MS) return cached.keys;

  const active = jwksInFlight.get(issuer);
  if (active) return active;

  const lastAttempt = jwksRefreshAttempts.get(issuer);
  if (forceRefresh && lastAttempt !== undefined && now - lastAttempt < JWKS_REFRESH_COOLDOWN_MS) {
    if (cached) return cached.keys;
    // A cold fetch immediately before this miss already supplied the current key set.
    // Do not make a second request just because the token presented an unknown kid.
    return [];
  }

  jwksRefreshAttempts.set(issuer, now);
  const refresh = fetchAndCacheJwks(issuer, fetcher, now);
  jwksInFlight.set(issuer, refresh);
  try {
    return await refresh;
  } finally {
    if (jwksInFlight.get(issuer) === refresh) jwksInFlight.delete(issuer);
  }
}

async function verifyWithKey(tokenParts, keyData) {
  try {
    const key = await crypto.subtle.importKey('jwk', keyData, {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      tokenParts.signature,
      tokenParts.signingInput,
    );
  } catch {
    return false;
  }
}

function validateClaims(payload, { issuer, audience }, nowSeconds) {
  if (payload.iss !== issuer) throw authorizationError(401);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) throw authorizationError(401);
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || nowSeconds >= payload.exp) {
    throw authorizationError(401);
  }
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || nowSeconds < payload.nbf)) {
    throw authorizationError(401);
  }
  if (typeof payload.email !== 'string' || !payload.email.trim()) throw authorizationError(401);
}

/** Validate the Cloudflare Access JWT and restrict access to the one configured owner. */
export async function authorizeRequest(request, env, options = {}) {
  let settings;
  try {
    settings = getAccessSettings(env);
  } catch (error) {
    if (error instanceof RequestAuthorizationError) throw error;
    throw authorizationError(503);
  }

  const token = request?.headers?.get?.('cf-access-jwt-assertion');
  if (!token) throw authorizationError(401);
  const parts = parseToken(token);
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  validateClaims(parts.payload, settings, nowSeconds);

  const fetcher = typeof options.fetcher === 'function' ? options.fetcher : fetch;
  let keys = await loadJwks(settings.issuer, fetcher, nowMs);
  let keyData = keys.find(key => key.kid === parts.header.kid);
  if (!keyData) {
    keys = await loadJwks(settings.issuer, fetcher, nowMs, true);
    keyData = keys.find(key => key.kid === parts.header.kid);
  }
  if (!keyData) throw authorizationError(401);
  if (!await verifyWithKey(parts, keyData)) throw authorizationError(401);

  const email = parts.payload.email.trim().toLowerCase();
  if (email !== settings.ownerEmail) throw authorizationError(403);
  return Object.freeze({ email, subject: typeof parts.payload.sub === 'string' ? parts.payload.sub : null });
}

/** Require same-origin form/API mutation requests; safe methods need no CSRF token. */
export function verifyMutationRequest(request) {
  const method = String(request?.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return true;

  let requestOrigin;
  let suppliedOrigin;
  try {
    requestOrigin = new URL(request.url).origin;
    suppliedOrigin = request.headers.get('origin');
  } catch {
    throw authorizationError(403);
  }
  if (!suppliedOrigin || suppliedOrigin !== requestOrigin || request.headers.get('x-trip-local') !== '1') {
    throw authorizationError(403);
  }
  return true;
}

export function clearAccessJwksCacheForTests() {
  jwksCache.clear();
  jwksRefreshAttempts.clear();
  jwksInFlight.clear();
}
