import crypto from 'node:crypto';
import { readEnv } from '../env-file.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';

/**
 * Mekari API client.
 *
 * Authentication is HTTP Signatures, not a bearer token: every request signs its own
 * Date header and request line with the client secret. The signing string is exactly
 *
 *   date: <RFC1123 GMT>\n<METHOD> <path-with-query> HTTP/1.1
 *
 * and the result goes into an Authorization header naming which headers were signed.
 * Because the date is part of the signature, a clock more than a few minutes out makes
 * every call fail - the same class of problem the Shopee integration hit.
 */

export const HOST = 'api.mekari.com';

export function loadMekariConfig() {
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';
  return {
    clientId: get('MEKARI_APP_CLIENT_ID'),
    clientSecret: get('MEKARI_APP_CLIENT_SECRET'),
    host: get('MEKARI_HOST') || HOST,
  };
}

export const isMekariConfigured = (config = loadMekariConfig()) =>
  Boolean(config.clientId && config.clientSecret);

export class MekariError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'MekariError';
    this.status = status;
    this.body = body;
  }
}

/** RFC 1123 in GMT, which is what the signature is computed over. */
export const httpDate = (at = new Date()) => at.toUTCString();

export function signRequest({ method, path, date, clientId, clientSecret }) {
  const payload = `date: ${date}\n${method.toUpperCase()} ${path} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', clientSecret).update(payload, 'utf8').digest('base64');
  return {
    payload,
    header: `hmac username="${clientId}", algorithm="hmac-sha256", headers="date request-line", signature="${signature}"`,
  };
}

// Jurnal rate-limits harder than a first read of the docs suggests, and it answers with a
// bare 429 rather than a helpful body. Backoff runs into the tens of seconds because the
// alternative - giving up - means a sale that is not in the books.
const RETRY_DELAYS_MS = [1000, 3000, 8000, 20_000, 45_000, 90_000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A floor on how close together two calls may be.
 *
 * Posting a day of orders is a burst of a hundred-odd requests, and a burst is exactly
 * what a rate limiter exists to stop. Spacing them costs a few seconds over a whole run
 * and removes the retry storm entirely - much cheaper than backing off after the fact.
 */
export const MIN_INTERVAL_MS = Number(process.env.MEKARI_MIN_INTERVAL_MS) || 350;
/**
 * Writes are paced far harder than reads.
 *
 * Measured against the live account: creating products at ~3/second got 19 through before
 * a 429 that five retries could not outlast. Reads never tripped it. Backfilling a month
 * is a one-off that can afford to take an hour; tripping the limiter halfway through and
 * having to work out what landed cannot.
 */
export const MIN_WRITE_INTERVAL_MS = Number(process.env.MEKARI_MIN_WRITE_INTERVAL_MS) || 1100;
let nextSlot = 0;

/**
 * Jurnal's limiter is a count, not a speed.
 *
 * Measured against the live account with unpaced reads: exactly 40 requests went through,
 * then every request was 429 until the window rolled over - reads and writes counted
 * together, no Retry-After header. Pacing individual calls therefore does nothing; what
 * matters is how many this process has made in the last minute. This bucket keeps it
 * under the line, and a 429 that slips through anyway opens a cool-down so the rest of
 * the run fails fast as "deferred" instead of each call discovering the same closed door.
 */
export const REQUESTS_PER_MINUTE = Number(process.env.MEKARI_REQUESTS_PER_MINUTE) || 34;
const WINDOW_MS = 60_000;
const recent = [];
let cooldownUntil = 0;

export class RateLimitedError extends MekariError {
  constructor(message, waitMs) {
    super(message, { status: 429 });
    this.name = 'MekariError';
    this.waitMs = waitMs;
  }
}

/** How long until the bucket has room again; 0 when it has room now. */
export function budgetWaitMs(now = Date.now()) {
  while (recent.length && now - recent[0] > WINDOW_MS) recent.shift();
  if (now < cooldownUntil) return cooldownUntil - now;
  if (recent.length < REQUESTS_PER_MINUTE) return 0;
  return recent[0] + WINDOW_MS - now + 50;
}

export function noteRateLimited(now = Date.now()) {
  cooldownUntil = Math.max(cooldownUntil, now + WINDOW_MS);
}

export function resetBudget() {
  recent.length = 0;
  cooldownUntil = 0;
  nextSlot = 0;
}

async function takeSlot(interval = MIN_INTERVAL_MS, deadlineAt = null) {
  const wait = budgetWaitMs();
  if (wait > 0) {
    if (deadlineAt !== null && Date.now() + wait >= deadlineAt) {
      throw new RateLimitedError(`kuota ${REQUESTS_PER_MINUTE} request/menit Jurnal habis, tenggat tidak cukup untuk menunggu ${Math.ceil(wait / 1000)}s`, wait);
    }
    await sleep(wait);
  }
  const now = Date.now();
  recent.push(now);
  const spacing = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + interval;
  if (spacing > 0) await sleep(spacing);
}

/**
 * @param {{method?: string, path: string, body?: object, config?: object}} request
 * `path` must include the query string: it is part of what gets signed.
 */
/**
 * @param {number|null} deadlineAt  epoch ms after which no retry may be started. Inside a
 *   serverless function a 429 backoff of tens of seconds is not patience, it is the
 *   platform killing the run with the ledger half-written; the caller knows how much
 *   time it has left and this is how it says so.
 */
export async function mekari({ method = 'GET', path, body, config = loadMekariConfig(), deadlineAt = null }) {
  if (!isMekariConfigured(config)) throw new MekariError('MEKARI_APP_CLIENT_ID / SECRET belum diisi');
  const canWait = (ms) => deadlineAt === null || Date.now() + ms < deadlineAt;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await takeSlot(method === 'GET' ? MIN_INTERVAL_MS : MIN_WRITE_INTERVAL_MS, deadlineAt);
    // The date is re-signed on every attempt; replaying a stale one would fail auth.
    const date = httpDate();
    const { header } = signRequest({
      method, path, date, clientId: config.clientId, clientSecret: config.clientSecret,
    });

    let response;
    try {
      response = await fetch(`https://${config.host}${path}`, {
        method,
        headers: {
          Authorization: header,
          Date: date,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      if (attempt === RETRY_DELAYS_MS.length || !canWait(RETRY_DELAYS_MS[attempt])) {
        throw new MekariError(`tidak terjangkau: ${cause.message}`);
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 300) };
    }

    // 5xx and 429 are transient. A 4xx is an answer - retrying it would only duplicate work.
    if (response.status === 429) noteRateLimited();
    if ((response.status >= 500 || response.status === 429) && attempt < RETRY_DELAYS_MS.length) {
      // Honour the server's own number when it gives one; ours is only a guess.
      const advised = Number(response.headers.get('retry-after')) * 1000;
      const delay = Number.isFinite(advised) && advised > 0 ? advised : RETRY_DELAYS_MS[attempt];
      if (canWait(delay)) {
        await sleep(delay);
        continue;
      }
      throw new MekariError(`${method} ${path} -> HTTP ${response.status}, tenggat habis sebelum bisa dicoba lagi`, { status: response.status, body: payload });
    }

    if (!response.ok) {
      const detail = payload?.message ?? payload?.errors ?? payload?.raw ?? '';
      throw new MekariError(
        `${method} ${path} -> HTTP ${response.status}${detail ? `: ${JSON.stringify(detail).slice(0, 200)}` : ''}`,
        { status: response.status, body: payload },
      );
    }
    return payload;
  }

  throw new MekariError('gagal setelah beberapa percobaan');
}
