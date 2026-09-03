import crypto from 'node:crypto';

/**
 * Stateless CSRF state for the OAuth round trip.
 *
 * The callback runs on Vercel as a serverless function with no shared memory, so the
 * state cannot be held between the authorize request and the callback. Instead the
 * state carries its own proof: a random nonce plus an expiry, signed with APP_SECRET.
 * The callback can verify it without any storage, and the nonce doubles as the key the
 * local CLI polls for.
 */

const DEFAULT_TTL_SECONDS = 15 * 60;

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

export function createState(secret, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${nonce}.${expiresAt}`;
  const token = `${b64url(payload)}.${sign(secret, payload)}`;
  return { state: token, nonce, expiresAt };
}

export function verifyState(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { valid: false, reason: 'malformed state' };
  }

  const separator = token.lastIndexOf('.');
  const encodedPayload = token.slice(0, separator);
  const providedMac = token.slice(separator + 1);

  let payload;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return { valid: false, reason: 'malformed state' };
  }

  const expectedMac = sign(secret, payload);
  const provided = Buffer.from(providedMac);
  const expected = Buffer.from(expectedMac);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return { valid: false, reason: 'signature mismatch' };
  }

  const [nonce, expiresAtRaw] = payload.split('.');
  const expiresAt = Number(expiresAtRaw);
  if (!nonce || !Number.isFinite(expiresAt)) {
    return { valid: false, reason: 'malformed state' };
  }
  if (Math.floor(Date.now() / 1000) > expiresAt) {
    return { valid: false, reason: 'state expired' };
  }

  return { valid: true, nonce, expiresAt };
}
