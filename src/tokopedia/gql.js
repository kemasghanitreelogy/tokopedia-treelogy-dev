import { fetchWithTimeout, TIMEOUTS } from '../http.js';

/**
 * The storefront's own GraphQL gateway - the one the product page in a browser talks to.
 *
 * Tokopedia's seller-facing Open API (now TikTok Shop's) has no endpoint that reads
 * reviews; it only imports them. The public storefront does read them, through
 * gql.tokopedia.com, and the queries below are the ones the shop's review tab issues.
 * Everything here is what a browser would have sent anyway - the shop is ours, the data
 * is public, and the pace is a fraction of what one visitor scrolling the tab produces.
 */
export const GQL_BASE_URL = 'https://gql.tokopedia.com/graphql';
export const STOREFRONT_URL = 'https://www.tokopedia.com';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Minimum gap between two requests. A person paging through reviews clicks roughly once
 * a second; staying under that keeps the crawler indistinguishable from one reader, and
 * a full pass over a few hundred reviews is still under ten seconds.
 */
export const MIN_GAP_MS = 700;
const JITTER_MS = 300;
const RETRY_DELAYS_MS = [800, 2000, 5000, 12000];

export class TokopediaError extends Error {
  constructor(message, { operation, httpStatus, errors = [], retryable = false } = {}) {
    super(message);
    this.name = 'TokopediaError';
    this.operation = operation;
    this.httpStatus = httpStatus;
    this.errors = errors;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One pacer per process, shared by every caller, so parallel code paths cannot add up
 * to a burst. `lastAt` is when the previous request was sent, not when it answered.
 */
const pacer = { lastAt: 0, chain: Promise.resolve() };

async function paced(fn, minGapMs, sleepImpl) {
  const turn = pacer.chain.then(async () => {
    const wait = pacer.lastAt + minGapMs - Date.now();
    if (wait > 0) await sleepImpl(wait + Math.floor(Math.random() * JITTER_MS));
    pacer.lastAt = Date.now();
  });
  pacer.chain = turn.catch(() => {});
  await turn;
  return fn();
}

/** Forget the pacing history; tests use it so one test's gap does not slow the next. */
export function resetPacer() {
  pacer.lastAt = 0;
  pacer.chain = Promise.resolve();
}

const isTransient = (error) =>
  error.name === 'TypeError' || error.name === 'AbortError' || error.name === 'TimeoutError' || error.retryable;

/**
 * Send one GraphQL operation and return its `data`.
 *
 * The gateway answers a JSON array with one entry per operation; a schema mistake comes
 * back as `errors` with `data: null` and HTTP 200, so the status code alone says nothing.
 * Rate limiting (429) and gateway trouble (5xx) are retried with backoff; a GraphQL
 * error is a real answer and is thrown as is, because retrying a wrong query only makes
 * it wrong again more slowly.
 *
 * @param {{operationName: string, query: string, variables: object, fetchImpl?: typeof fetch,
 *          referer?: string, minGapMs?: number, sleepImpl?: (ms: number) => Promise<void>}} request
 */
export async function gql({
  operationName,
  query,
  variables,
  fetchImpl = fetchWithTimeout,
  referer = `${STOREFRONT_URL}/`,
  minGapMs = MIN_GAP_MS,
  sleepImpl = sleep,
}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await paced(
        () => sendOnce({ operationName, query, variables, fetchImpl, referer }),
        minGapMs,
        sleepImpl,
      );
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === RETRY_DELAYS_MS.length) throw error;
      await sleepImpl(RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * JITTER_MS));
    }
  }
  throw lastError;
}

async function sendOnce({ operationName, query, variables, fetchImpl, referer }) {
  let response;
  try {
    response = await fetchImpl(`${GQL_BASE_URL}/${operationName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Origin: STOREFRONT_URL,
        Referer: referer,
        'X-Source': 'tokopedia-lite',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
      body: JSON.stringify([{ operationName, variables, query }]),
      timeout: TIMEOUTS.api,
    });
  } catch (cause) {
    const error = new TokopediaError(`${operationName} tidak terjangkau: ${cause.message}`, {
      operation: operationName,
      retryable: true,
    });
    error.cause = cause;
    throw error;
  }

  if (response.status === 429 || response.status >= 500) {
    throw new TokopediaError(`${operationName}: HTTP ${response.status}`, {
      operation: operationName,
      httpStatus: response.status,
      retryable: true,
    });
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new TokopediaError(`${operationName}: jawaban bukan JSON (HTTP ${response.status})`, {
      operation: operationName,
      httpStatus: response.status,
      // A CDN interstitial or an HTML error page: worth one more try, not a crash.
      retryable: response.status !== 200,
    });
  }

  const entry = Array.isArray(payload) ? payload[0] : payload;
  if (!entry || (entry.data == null && !entry.errors)) {
    throw new TokopediaError(`${operationName}: jawaban kosong (HTTP ${response.status})`, {
      operation: operationName,
      httpStatus: response.status,
    });
  }
  if (entry.data == null) {
    const messages = entry.errors.map((e) => e.message).join('; ');
    throw new TokopediaError(`${operationName}: ${messages}`, {
      operation: operationName,
      httpStatus: response.status,
      errors: entry.errors,
    });
  }
  return entry.data;
}
