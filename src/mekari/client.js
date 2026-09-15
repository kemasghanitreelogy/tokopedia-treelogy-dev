import crypto from 'node:crypto';
import { readEnv } from '../env-file.js';
import { reserveSlot } from '../store/index.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

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

/**
 * Jurnal's package quota for the month is gone: "Monthly limit exceeded. Please wait
 * until next month or upgrade your package." Retrying this burns nothing useful and
 * backing off does not help; every caller must stop cleanly and somebody must be told.
 */
/**
 * A write whose outcome we genuinely do not know.
 *
 * A POST that creates records is not idempotent, and a timeout is not a failure - it is
 * an absence of news. Retrying one is how 472 invoices became 891: every batch_create
 * timed out at our end after Jurnal had already processed it, the client retried as it
 * would for a read, and Jurnal made a second copy. batch_create does not enforce
 * custom_id uniqueness, which is the only thing that would have caught it.
 *
 * So a create is never retried now. It raises this instead, and the caller has to find
 * out what actually happened before doing anything else - which is the only honest
 * response to not knowing.
 */
export class UncertainWriteError extends Error {
  constructor(message, { method, path } = {}) {
    super(message);
    this.name = 'UncertainWriteError';
    this.uncertain = true;
    this.method = method;
    this.path = path;
  }
}

export class QuotaExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaExhaustedError';
    this.status = 429;
    this.monthly = true;
  }
}

export const isMonthlyQuota = (payload) => /monthly limit exceeded/i.test(JSON.stringify(payload ?? ''));

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
 * Writes are paced harder than reads, but no longer three times harder than the limit.
 *
 * Measured against the live account when this was written: creating products at ~3/second
 * got 19 through before a 429 that five retries could not outlast. That measurement stands
 * - bursting still trips it - but the conclusion drawn from it was too cautious. The
 * account's documented ceiling is 100 requests a minute, and 1100ms between writes caps a
 * run at 54, so half the available rate was being left unused. A restatement that should
 * take seven minutes took thirty-six.
 *
 * 650ms still refuses a burst while leaving the bucket below as what actually governs -
 * the interval allows 92 a minute, the bucket 90, so the bucket is the one that binds.
 */
export const MIN_WRITE_INTERVAL_MS = Number(process.env.MEKARI_MIN_WRITE_INTERVAL_MS) || 650;
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
 *
 * The 40 was the measurement; the account's documented ceiling is 100 a minute. Both are
 * kept here because they are different kinds of fact and the gap between them matters: 34
 * was a guess derived from one observation, and it made every long job three times slower
 * than it needed to be.
 *
 * 90 rather than 100 on purpose. Three processes on this box spend the same budget and
 * coordinate through Redis, whose clock and ours differ by a little; a request that is not
 * counted here - a retry inside fetch, a redirect - spends quota all the same. The ten
 * left over are what stops a rounding error becoming a 429 in the middle of a restatement.
 */
export const REQUESTS_PER_MINUTE = Number(process.env.MEKARI_REQUESTS_PER_MINUTE) || 90;
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
  // The shared budget first: on the VPS this process is one of three that spend the same
  // account quota, and only Redis can see all of them. A backend without a shared view
  // returns 0 and the in-process bucket below remains the only guard.
  for (let round = 0; round < 40; round++) {
    const shared = await reserveSlot('mekari', REQUESTS_PER_MINUTE, WINDOW_MS).catch(() => 0);
    if (shared === 0) break;
    if (deadlineAt !== null && Date.now() + shared >= deadlineAt) {
      throw new RateLimitedError(`kuota ${REQUESTS_PER_MINUTE} request/menit Jurnal habis (dipakai bersama), tenggat tidak cukup untuk menunggu ${Math.ceil(shared / 1000)}s`, shared);
    }
    await sleep(shared);
  }

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
/**
 * @param {FormData} [form]  multipart body, for the one endpoint that takes a file
 *   (product image upload). Sent as-is: fetch sets the boundary, and forcing a JSON
 *   content type over it is what turns a valid upload into a 400.
 */
export async function mekari({ method = 'GET', path, body, form, config = loadMekariConfig(), deadlineAt = null, retryCreate = false }) {
  // A POST creates something. Retrying one after a timeout or a 5xx risks a second copy,
  // because the first may well have succeeded - the response is what went missing, not
  // the work. Callers that know the endpoint de-duplicates (Jurnal's single sales invoice
  // create answers 409 on a repeated custom_id) may opt back in; batch_create does not,
  // and must not.
  const creates = method === 'POST' && !retryCreate;
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
      const headers = { Authorization: header, Date: date, Accept: 'application/json' };
      if (!form) headers['Content-Type'] = 'application/json';
      response = await fetchWithTimeout(`https://${config.host}${path}`, {
        method,
        headers,
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
    } catch (cause) {
      if (creates) {
        throw new UncertainWriteError(
          `${method} ${path} tidak dapat jawaban (${cause.message}) - mungkin sudah tersimpan, tidak diulang`,
          { method, path },
        );
      }
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
    if (response.status === 429 && isMonthlyQuota(payload)) {
      throw new QuotaExhaustedError(`kuota API bulanan Mekari habis: ${payload?.message ?? payload?.raw ?? ''}`.trim());
    }
    if (response.status === 429) noteRateLimited();
    if (creates && response.status >= 500) {
      throw new UncertainWriteError(
        `${method} ${path} -> HTTP ${response.status} - mungkin sudah tersimpan, tidak diulang`,
        { method, path },
      );
    }
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
