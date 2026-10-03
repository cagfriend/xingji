const PBKDF2_PREFIX = 'pbkdf2-sha256';
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DIGEST_BYTES = 32;

const encoder = new TextEncoder();

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function encodeBase64Url(value) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(left, right) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}

function parsePasswordVerifier(verifier) {
  if (typeof verifier !== 'string') return null;
  if (/^[a-f0-9]{64}$/i.test(verifier)) return {kind: 'legacy', digest: hexToBytes(verifier)};

  const parts = verifier.split('$');
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX || parts[1] !== String(PBKDF2_ITERATIONS)) return null;
  const salt = decodeBase64Url(parts[2]);
  const digest = decodeBase64Url(parts[3]);
  if (!salt || salt.length !== SALT_BYTES || !digest || digest.length !== DIGEST_BYTES) return null;
  return {kind: 'pbkdf2', salt, digest};
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function validPasswordLength(password) {
  const length = [...password].length;
  return length >= 8 && length <= 128;
}

/** Check that a configured password verifier uses one of the supported formats. */
export function isValidPasswordVerifier(verifier) {
  return parsePasswordVerifier(verifier) !== null;
}

/** Create a PBKDF2-SHA256 verifier with a fresh cryptographically random salt. */
export async function createPasswordVerifier(password) {
  if (typeof password !== 'string' || !validPasswordLength(password)) {
    throw new TypeError('Password must contain between 8 and 128 characters');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS}, key, DIGEST_BYTES * 8);
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(new Uint8Array(bits))}`;
}

/** Verify either a versioned PBKDF2 verifier or the legacy 43-character password hash. */
export async function verifyPassword(password, verifier) {
  const parsed = parsePasswordVerifier(verifier);
  if (!parsed || typeof password !== 'string') return false;

  if (parsed.kind === 'legacy') {
    if (password.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(password)) return false;
    const decoded = decodeBase64Url(password);
    if (!decoded || decoded.length !== 32) return false;
    const supplied = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(password)));
    return constantTimeEqual(supplied, parsed.digest);
  }

  if (!validPasswordLength(password)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: parsed.salt, iterations: PBKDF2_ITERATIONS}, key, DIGEST_BYTES * 8);
  return constantTimeEqual(new Uint8Array(bits), parsed.digest);
}
