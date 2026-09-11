import crypto from 'node:crypto';
import { createState, verifyState } from './state.js';

/**
 * Cookie-backed sessions for the dashboard.
 *
 * The session itself is stateless: a random nonce plus an expiry, HMAC-signed with the
 * dashboard password. Nothing is stored server-side, and rotating DASHBOARD_TOKEN
 * invalidates every outstanding session for free - which is what you want from a
 * password change.
 */

export const COOKIE_NAME = 'omni_session';
export const SESSION_TTL_SECONDS = 12 * 3600;

export const credentials = () => ({
  email: process.env.DASHBOARD_EMAIL ?? '',
  password: process.env.DASHBOARD_PASSWORD ?? '',
  // A long random value kept only for signing. It is never typed by anyone.
  signingKey: process.env.DASHBOARD_TOKEN ?? '',
});

export const isConfigured = () => {
  const { email, password, signingKey } = credentials();
  return Boolean(email && password && signingKey);
};

const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();

const constantTimeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

/**
 * Sessions are signed with the random DASHBOARD_TOKEN, never with the password.
 *
 * Signing with the password would mean anyone could mint a valid cookie by computing an
 * HMAC keyed with a guess - with a short password that is not an attack, it is
 * arithmetic. Mixing the credential hash in keeps the key strong while still making a
 * password change invalidate every session that is already out there.
 */
function sessionSecret() {
  const { email, password, signingKey } = credentials();
  return crypto.createHmac('sha256', signingKey).update(`${email}:${password}`).digest('hex');
}

/** Both fields are always compared, so a wrong email costs the same time as a wrong password. */
export function credentialsMatch(email, password) {
  const expected = credentials();
  if (!isConfigured()) return false;
  const emailOk = constantTimeEqual(String(email ?? '').trim().toLowerCase(), expected.email.trim().toLowerCase());
  const passwordOk = constantTimeEqual(password, expected.password);
  return emailOk && passwordOk;
}

/** The bookmark key: the long random token still opens the dashboard on its own. */
export function tokenMatches(provided) {
  const { signingKey } = credentials();
  if (!signingKey) return false;
  return constantTimeEqual(provided, signingKey);
}

export function parseCookies(header) {
  const jar = {};
  if (!header) return jar;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      jar[name] = part.slice(eq + 1).trim();
    }
  }
  return jar;
}

export function issueSession() {
  const { state } = createState(sessionSecret(), SESSION_TTL_SECONDS);
  return state;
}

export function sessionValid(token) {
  if (!isConfigured() || !token) return false;
  return verifyState(sessionSecret(), token).valid;
}

const attributes = (maxAge) =>
  [
    `Path=/`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');

export const sessionCookie = (token) =>
  `${COOKIE_NAME}=${encodeURIComponent(token)}; ${attributes(SESSION_TTL_SECONDS)}`;

export const clearedCookie = () => `${COOKIE_NAME}=; ${attributes(0)}`;

/**
 * Rebuild the target URL from validated parameters only.
 *
 * Reflecting a caller-supplied `next` would turn the login form into an open redirect,
 * so the range params are re-serialised here rather than echoed.
 */
export function safeRedirect(basePath, params) {
  // A preset and an explicit from/to are mutually exclusive: resolveRange gives the
  // custom range priority, so emitting both would turn `preset=7d` (a rolling 7-day
  // window) into the 8 calendar days it happens to span right now.
  const query = new URLSearchParams();
  if (params.preset) {
    query.set('preset', params.preset);
  } else if (params.from && params.to) {
    query.set('from', params.from);
    query.set('to', params.to);
  }
  const qs = query.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * CSRF token bound to the session.
 *
 * SameSite=Lax already blocks a cross-site POST from carrying the cookie, but the write
 * actions here change real stock and prices, so the form also has to prove it came from
 * a page we rendered. The token is derived from the session, so it needs no storage.
 */
export function csrfToken(session) {
  return crypto.createHmac('sha256', sessionSecret()).update(`csrf:${session ?? ''}`).digest('base64url');
}

export function csrfValid(session, provided) {
  if (!session || !provided) return false;
  const expected = csrfToken(session);
  const a = Buffer.from(String(provided));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Vercel does not parse urlencoded bodies for us, so read the stream directly. */
export async function readFormBody(req, limitBytes = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/* ------------------------------------------------------ brute-force protection */

import { put, get } from '@vercel/blob';

/**
 * Failed-login throttling, backed by Blob.
 *
 * A short password is only safe if guessing is expensive, and a serverless function has
 * no memory between requests to count attempts in. Counters are keyed by a hash of the
 * caller's IP - the raw address is never stored - and only failures write, so a normal
 * login pays a single read.
 */
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_SECONDS = 15 * 60;

const attemptPath = (ip) =>
  `auth/attempts/${crypto.createHash('sha256').update(String(ip ?? 'unknown')).digest('hex').slice(0, 32)}.json`;

export const callerIp = (req) =>
  (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
  req.socket?.remoteAddress ||
  'unknown';

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN ?? '';
}

export async function attemptState(ip) {
  const token = blobToken();
  if (!token) return { count: 0, lockedUntil: 0 };
  try {
    const result = await get(attemptPath(ip), { access: 'private', useCache: false, token });
    if (!result) return { count: 0, lockedUntil: 0 };
    const state = JSON.parse(await new Response(result.stream).text());
    // A lapsed window starts the count over rather than holding a grudge forever.
    if (state.lockedUntil && state.lockedUntil < Math.floor(Date.now() / 1000)) {
      return { count: 0, lockedUntil: 0 };
    }
    return state;
  } catch {
    // Never let the throttle store lock out a legitimate login by failing closed.
    return { count: 0, lockedUntil: 0 };
  }
}

export const isLockedOut = (state) => state.lockedUntil > Math.floor(Date.now() / 1000);

export async function recordFailure(ip) {
  const token = blobToken();
  if (!token) return { count: 0, lockedUntil: 0 };
  const state = await attemptState(ip);
  const count = state.count + 1;
  const next = {
    count,
    lockedUntil: count >= MAX_ATTEMPTS ? Math.floor(Date.now() / 1000) + LOCKOUT_SECONDS : 0,
  };
  try {
    await put(attemptPath(ip), JSON.stringify(next), {
      access: 'private', allowOverwrite: true, contentType: 'application/json',
      token, cacheControlMaxAge: 0,
    });
  } catch { /* throttling is best-effort; a failed write must not block the response */ }
  return next;
}

export async function clearFailures(ip) {
  const token = blobToken();
  if (!token) return;
  try {
    await put(attemptPath(ip), JSON.stringify({ count: 0, lockedUntil: 0 }), {
      access: 'private', allowOverwrite: true, contentType: 'application/json',
      token, cacheControlMaxAge: 0,
    });
  } catch { /* best effort */ }
}
