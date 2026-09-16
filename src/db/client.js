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
    let unparseable = false;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { message: text.slice(0, 400) };
      unparseable = true;
    }

    // A 200 carrying something that is not JSON is a proxy, a WAF or a maintenance page,
    // not an answer. Treated as success it became `[]` further up - and an empty array is
    // indistinguishable from a day with no sales, so the dashboard would render a blank
    // day and say nothing was wrong.
    if (response.ok && unparseable) {
      last = new SupabaseError(`jawaban bukan JSON dari ${path}: ${String(payload.message).slice(0, 120)}`, { status: response.status });
      last.retryable = true;
      if (attempt === retries) throw last;
      await sleep(attempt * 400);
      continue;
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

/** Pages fetched at once after the first. Enough to hide the latency, few enough to be polite. */
const PAGE_CONCURRENCY = 4;

/**
 * How far the uncounted fallback below will walk before it decides something is wrong.
 *
 * Half a million rows is far more than any window this system reads - the whole orders
 * table is in the tens of thousands - so reaching it means the walk is not walking.
 */
const MAX_FALLBACK_ROWS = 500 * PAGE_SIZE;

/** How many times a torn read is started over before the caller is told it could not be had. */
const REREADS = 3;

/** What readPages returns instead of rows when the table moved underneath the offsets. */
const TORN = Symbol('torn');

const countOf = (contentRange) => Number(String(contentRange ?? '').split('/')[1]);

/**
 * Read a table or view, following PostgREST's 1000-row pages to the end.
 *
 * The page ceiling is not a suggestion: a query matching 4,000 rows returns 1,000 and no
 * error, so a caller that ignores it silently works on a quarter of the data. Paging is
 * therefore not optional and does not belong at the call site.
 *
 * Orders arrive by webhook while this is paging, and a list of offsets does not survive that.
 *
 * The offsets are arithmetic done once, from the count the first page reported. With
 * `created_at.desc` a row inserted while page three is in flight pushes every older row one
 * place further down, so the oldest rows in the window slide past the last offset we ever
 * ask for and are simply never requested - no error, no short page, just a window quietly
 * missing its earliest sales. A delete shifts rows the other way and skips one in the
 * middle. Either way the caller gets an array that looks exactly like a complete answer.
 *
 * Keyset pagination on (created_at, id) is immune to both and is the right answer for a
 * cursor that belongs to one query. This helper is not that: it pages whatever params the
 * call site passes, and the orders window is sorted by three columns with `channel` in the
 * middle, so the "after this row" predicate would have to be composed per call site and
 * every caller taught to carry its key. What is cheap here is noticing. The last page is
 * asked for with an exact count as well - the request happens either way, so the count
 * costs no round trip - and a total that no longer matches the first page's means the
 * offsets were computed against a table that has since moved. Then the whole read starts
 * again rather than handing back a window with a hole in it.
 *
 * What that leaves: an insert and a delete landing between the same two requests keep the
 * count identical and would still slip through. That is a far narrower race than the one
 * this closes, and closing it needs the keyset.
 */
export async function selectAll(table, params = {}, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const rows = await readPages(table, params, options);
    if (rows !== TORN) return rows;
    if (attempt === REREADS) {
      // Three torn reads in a row is not a busy minute, it is a table being written faster
      // than it can be read. Saying so lets loadOrders fall back to the platforms; a
      // silently short array gives it nothing to fall back from.
      const error = new SupabaseError(
        `${table}: berubah di tengah ${REREADS} kali pembacaan berturut-turut - hasilnya tidak utuh`,
        { status: 0 },
      );
      error.retryable = false;
      throw error;
    }
  }
}

async function readPages(table, params, options) {
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
  // One request cannot tear: whatever the table did afterwards, this is a whole answer.
  if (rows.length < PAGE_SIZE) return rows;

  const total = countOf(first.contentRange);
  if (!Number.isFinite(total)) {
    // PostgREST declined to count. Fall back to walking until a short page ends it - but
    // only ever forwards, and never forever.
    //
    // The loop used to have neither guard, and both are the same failure: something in
    // front of the database that does not honour Range - a cache, a WAF, a proxy serving
    // a canned page - answers every request with page one. The walk then appends the same
    // thousand rows on every pass, advancing nothing, until the process runs out of memory
    // with no error to explain it. Refusing loudly costs the caller one read; the other
    // way costs the box.
    //
    // A walk cannot be checked against a count it was never given, so this path keeps the
    // tearing the counted path above now rejects. It is the path nothing takes: PostgREST
    // counts when it is asked to, and a deployment where it does not is already broken in
    // a way worth noticing on its own.
    let marker = JSON.stringify(rows[0] ?? null);
    for (let from = rows.length; from < MAX_FALLBACK_ROWS; from += PAGE_SIZE) {
      const { body } = await request(table, { ...options, params, range: `${from}-${from + PAGE_SIZE - 1}` });
      const page = Array.isArray(body) ? body : [];
      const next = JSON.stringify(page[0] ?? null);
      if (page.length > 0 && next === marker) {
        const error = new SupabaseError(`${table}: halaman dari baris ${from} mengulang isi halaman sebelumnya - Range tidak dihormati`, { status: 0 });
        // Asking again gets the same broken answer from the same thing in the way.
        error.retryable = false;
        throw error;
      }
      marker = next;
      rows.push(...page);
      if (page.length < PAGE_SIZE) return rows;
    }
    const error = new SupabaseError(`${table}: lebih dari ${MAX_FALLBACK_ROWS} baris tanpa hitungan pasti - pembacaan dihentikan`, { status: 0 });
    error.retryable = false;
    throw error;
  }

  const offsets = [];
  for (let from = PAGE_SIZE; from < total; from += PAGE_SIZE) offsets.push(from);
  // A window of exactly one full page is still a single request, and single requests are
  // whole. Checking it against a second count would only invent a failure.
  if (offsets.length === 0) return rows;

  const last = offsets[offsets.length - 1];
  let after = total;
  // Ordering is restored by offset, not by arrival: pages come back in whatever order the
  // network hands them over, and the caller asked for a sorted list.
  const pages = new Array(offsets.length);
  for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
    const group = offsets.slice(i, i + PAGE_CONCURRENCY);
    let shrank = false;
    await Promise.all(group.map(async (from, j) => {
      try {
        const { body, contentRange } = await request(table, {
          ...options,
          params,
          range: `${from}-${from + PAGE_SIZE - 1}`,
          ...(from === last ? { prefer: 'count=exact' } : {}),
        });
        pages[i + j] = Array.isArray(body) ? body : [];
        if (from === last) after = countOf(contentRange);
      } catch (error) {
        // PostgREST answers 416 when a range starts past the end of the result. That is not
        // a malformed request, it is rows having been deleted since the count was taken -
        // the same tearing the total check catches, arriving as an error instead of as a
        // number. Anything else is a real failure and belongs to the caller.
        if (error?.status !== 416 && error?.code !== 'PGRST103') throw error;
        shrank = true;
      }
    }));
    if (shrank) return TORN;
  }
  if (!Number.isFinite(after) || after !== total) return TORN;

  for (const page of pages) rows.push(...(page ?? []));
  return rows;
}
