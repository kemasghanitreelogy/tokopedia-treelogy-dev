import { readEnv } from '../env-file.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

/**
 * Supabase over PostgREST, spoken directly.
 *
 * Every other platform in this codebase has a hand-written client - TikTok, Shopee,
 * Shopify, Mekari - for the same reason this one is: the thing that matters is not the
 * convenience of the call site but what happens on a bad day. Deadlines, which errors are
 * worth retrying, and what the message says when it fails all have to be ours. PostgREST
 * is a plain REST surface, so the whole client is this file.
 *
 * The secret key bypasses row-level security, which is exactly why it may never reach a
 * browser. Nothing here runs client-side; the dashboard is server-rendered and the page
 * receives rows, never a key.
 */

/**
 * The test runner never reaches the real project, and this check comes first.
 *
 * .env holds working production credentials, `npm test` runs with it readable, and the
 * deploy script runs `npm test` on the box. A suite that exercised a write path would
 * therefore write to the live orders table - the same shape of mistake that once had
 * every deploy about to delete the TikTok token bundle. A test that genuinely wants the
 * database has to say so by name.
 */
const testing = () => Boolean(process.env.NODE_TEST_CONTEXT) && process.env.SUPABASE_TEST_LIVE !== '1';

export function loadSupabaseConfig() {
  if (testing()) return { url: '', secretKey: '' };
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';
  return {
    url: (get('SUPABASE_URL') || '').replace(/\/$/, ''),
    secretKey: get('SUPABASE_SECRET_KEY'),
  };
}

export const isSupabaseConfigured = (config = loadSupabaseConfig()) =>
  Boolean(config.url && config.secretKey);

export class SupabaseError extends Error {
  constructor(message, { status = 0, code = '', details = '' } = {}) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
    this.details = details;
    // A dropped connection or a 5xx is worth trying again; a 400 means the request itself
    // is wrong and repeating it only wastes the operator's time.
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
}

/** PostgREST's page ceiling. Asking for more in one request silently returns this many. */
export const PAGE_SIZE = 1000;

const RETRIES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildUrl(config, path, params) {
  const url = new URL(`${config.url}/rest/v1/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * One request, retried only when retrying can help.
 *
 * @returns {Promise<{body: any, contentRange: string|null}>}
 */
export async function request(path, {
  method = 'GET',
  params = null,
  body = null,
  prefer = null,
  range = null,
  timeout = TIMEOUTS.api,
  // Retries multiply the wait. A caller on a deadline - the health check is the one that
  // matters - needs to be able to say "ask once", or three attempts with backoff turn a
  // three-second budget into ten.
  retries = RETRIES,
  config = loadSupabaseConfig(),
} = {}) {
  if (!isSupabaseConfigured(config)) {
    throw new SupabaseError('SUPABASE_URL / SUPABASE_SECRET_KEY belum diisi');
  }

  const url = buildUrl(config, path, params);
  const headers = {
    apikey: config.secretKey,
    authorization: `Bearer ${config.secretKey}`,
    accept: 'application/json',
  };
  if (body !== null) headers['content-type'] = 'application/json';
  if (prefer) headers.prefer = prefer;
  if (range) headers.range = range;

  let last = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(url, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        timeout,
      });
    } catch (error) {
      last = new SupabaseError(`tidak bisa menghubungi Supabase: ${error.message}`, { status: 0 });
      if (attempt === retries) throw last;
      await sleep(attempt * 400);
      continue;
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { message: text.slice(0, 400) };
    }

    if (response.ok) return { body: payload, contentRange: response.headers.get('content-range') };

    last = new SupabaseError(
      // PostgREST puts the useful part in `message`; `hint` is where it says what to do.
      [payload?.message, payload?.hint].filter(Boolean).join(' - ') || `HTTP ${response.status}`,
      { status: response.status, code: payload?.code ?? '', details: payload?.details ?? '' },
    );
    if (!last.retryable || attempt === retries) throw last;
    await sleep(attempt * 400);
  }
  throw last;
}

/** Call a Postgres function. Returns whatever the function returns, already parsed. */
export async function rpc(name, args = {}, options = {}) {
  const { body } = await request(`rpc/${name}`, { method: 'POST', body: args, ...options });
  return body;
}

/**
 * Read a table or view, following PostgREST's 1000-row pages to the end.
 *
 * The page ceiling is not a suggestion: a query matching 4,000 rows returns 1,000 and no
 * error, so a caller that ignores it silently works on a quarter of the data. Paging is
 * therefore not optional and does not belong at the call site.
 */
/** Pages fetched at once after the first. Enough to hide the latency, few enough to be polite. */
const PAGE_CONCURRENCY = 4;

export async function selectAll(table, params = {}, options = {}) {
  // The first page is asked for with an exact count, which is what turns the rest from a
  // guessing game into arithmetic: over a link to another continent, three pages fetched
  // one after another is three round trips of latency for data that has no order
  // dependency at all. Knowing the total up front means every page after the first can go
  // out together.
  const first = await request(table, {
    ...options,
    params,
    range: `0-${PAGE_SIZE - 1}`,
    prefer: 'count=exact',
  });
  const rows = Array.isArray(first.body) ? first.body : [];
  if (rows.length < PAGE_SIZE) return rows;

  const total = Number(String(first.contentRange ?? '').split('/')[1]);
  if (!Number.isFinite(total)) {
    // PostgREST declined to count. Fall back to walking until a short page ends it.
    for (let from = rows.length; ; from += PAGE_SIZE) {
      const { body } = await request(table, { ...options, params, range: `${from}-${from + PAGE_SIZE - 1}` });
      const page = Array.isArray(body) ? body : [];
      rows.push(...page);
      if (page.length < PAGE_SIZE) return rows;
    }
  }

  const offsets = [];
  for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE) offsets.push(from);

  // Ordering is restored by offset, not by arrival: pages come back in whatever order the
  // network hands them over, and the caller asked for a sorted list.
  const pages = new Array(offsets.length);
  for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
    const group = offsets.slice(i, i + PAGE_CONCURRENCY);
    await Promise.all(group.map(async (from, j) => {
      const { body } = await request(table, { ...options, params, range: `${from}-${from + PAGE_SIZE - 1}` });
      pages[i + j] = Array.isArray(body) ? body : [];
    }));
  }
  for (const page of pages) rows.push(...(page ?? []));
  return rows;
}
