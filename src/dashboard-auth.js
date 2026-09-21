import crypto from 'node:crypto';
import { findUser, verifyLogin, ownerUser, OWNER_ID } from './users.js';

/**
 * Cookie-backed sessions for the dashboard, one per person.
 *
 * A session is a signed statement: "user X, nonce, expires at". It is signed with the
 * random DASHBOARD_TOKEN mixed with that user's own credential hash, so nothing is stored
 * server-side, a forged cookie needs the signing key, and a password change - or the
 * owner rotating DASHBOARD_TOKEN - invalidates every outstanding session for free.
 *
 * The owner is the account in the environment. Everyone else is in src/users.js.
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
 * The per-user signing secret.
 *
 * Keyed by the random DASHBOARD_TOKEN, never by a password: with a short password an
 * HMAC keyed by it is not an attack, it is arithmetic. The credential hash is mixed in so
 * that changing it still invalidates every session already out there.
 */
function sessionSecret(user) {
  const { email, password, signingKey } = credentials();
  const credential = user.id === OWNER_ID ? `${email}:${password}` : `${user.passwordHash ?? ''}`;
  return crypto.createHmac('sha256', signingKey).update(`${user.id}:${credential}`).digest('hex');
}

/** Both fields are always compared, so a wrong email costs the same time as a wrong password. */
export function credentialsMatch(email, password) {
  const expected = credentials();
  if (!isConfigured()) return false;
  const emailOk = constantTimeEqual(String(email ?? '').trim().toLowerCase(), expected.email.trim().toLowerCase());
  const passwordOk = constantTimeEqual(password, expected.password);
  return emailOk && passwordOk;
}

/**
 * Whoever these credentials belong to: the owner from the environment, or an active
 * invited user from the store. Null means nobody, and the caller counts a failure.
 */
export async function login(email, password) {
  if (credentialsMatch(email, password)) return ownerUser();
  if (!isConfigured()) return null;
  return verifyLogin(email, password);
}

/** The bookmark key: the long random token still opens the dashboard as the owner. */
/**
 * A signature that lets one review photo be fetched without a session.
 *
 * Klaviyo fetches review images from wherever the import file points, with no cookie
 * and no key, so the file needs a URL that is public for that one photo and useless
 * for any other. The signature is the signing key over the attachment id and size;
 * without the key it cannot be forged, and it says nothing about anything but that file.
 */
export function mediaSignature(id, size) {
  const { signingKey } = credentials();
  if (!signingKey) return '';
  return crypto.createHmac('sha256', signingKey).update(`media:${id}:${size}`).digest('base64url').slice(0, 24);
}

export function mediaSignatureMatches(id, size, provided) {
  const expected = mediaSignature(id, size);
  return Boolean(expected) && constantTimeEqual(String(provided ?? ''), expected);
}

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

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
const unb64 = (text) => Buffer.from(text, 'base64url').toString('utf8');
const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');

/** @param {{id: string}} [user] defaults to the owner, which is what the bookmark key logs in as. */
export function issueSession(user = ownerUser()) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload = `${user.id}|${nonce}|${expiresAt}`;
  return `${b64(payload)}.${sign(sessionSecret(user), payload)}`;
}

/**
 * The person behind a cookie, or null.
 *
 * The user is looked up first because the signature depends on their credential hash;
 * the lookup is by id from the unverified payload, which is harmless - an attacker who
 * names a user still has to produce that user's signature. Disabled or deleted users
 * fail here even with a cookie that was valid an hour ago.
 */
export async function authenticate(token) {
  if (!isConfigured() || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  let payload;
  try {
    payload = unb64(token.slice(0, dot));
  } catch {
    return null;
  }
  const [id, nonce, expiresRaw] = payload.split('|');
  const expiresAt = Number(expiresRaw);
  if (!id || !nonce || !Number.isFinite(expiresAt)) return null;
  if (Math.floor(Date.now() / 1000) > expiresAt) return null;

  const user = await findUser(id).catch(() => null);
  if (!user || user.status !== 'active') return null;

  const expected = Buffer.from(sign(sessionSecret(user), payload));
  const provided = Buffer.from(token.slice(dot + 1));
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
  return user;
}

export const sessionValid = async (token) => Boolean(await authenticate(token));

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
 * a page we rendered. The token is derived from the session, which is itself random and
 * unforgeable, so it needs no storage and no per-user secret.
 */
export function csrfToken(session) {
  return crypto.createHmac('sha256', credentials().signingKey).update(`csrf:${session ?? ''}`).digest('base64url');
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

import { readDoc, writeDoc } from './store/index.js';

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

const EMPTY = { count: 0, lockedUntil: 0 };

export async function attemptState(ip) {
  try {
    const state = await readDoc(attemptPath(ip));
    if (!state) return { ...EMPTY };
    // A lapsed window starts the count over rather than holding a grudge forever.
    if (state.lockedUntil && state.lockedUntil < Math.floor(Date.now() / 1000)) return { ...EMPTY };
    return state;
  } catch {
    // Never let the throttle store lock out a legitimate login by failing closed.
    return { ...EMPTY };
  }
}

export const isLockedOut = (state) => state.lockedUntil > Math.floor(Date.now() / 1000);

export async function recordFailure(ip) {
  const state = await attemptState(ip);
  const count = state.count + 1;
  const next = {
    count,
    lockedUntil: count >= MAX_ATTEMPTS ? Math.floor(Date.now() / 1000) + LOCKOUT_SECONDS : 0,
  };
  try {
    await writeDoc(attemptPath(ip), next);
  } catch { /* throttling is best-effort; a failed write must not block the response */ }
  return next;
}

export async function clearFailures(ip) {
  try {
    await writeDoc(attemptPath(ip), { ...EMPTY });
  } catch { /* best effort */ }
}
