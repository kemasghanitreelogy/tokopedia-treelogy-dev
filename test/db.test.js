import test from 'node:test';
import assert from 'node:assert/strict';
import { coversRange, STALE_AFTER_MS, DB_HISTORY_START, DB_HISTORY_START_EPOCH } from '../src/db/orders.js';
import { isSupabaseConfigured, loadSupabaseConfig, SupabaseError, PAGE_SIZE } from '../src/db/client.js';
import { SOURCE_CHANNELS, activeSources } from '../src/orders-source.js';
import { wibDate } from '../src/range.js';

const HOUR = 3600;
const window = (fromHoursAgo, toHoursAgo = 0) => {
  const now = 1_760_000_000;
  return { since: now - fromHoursAgo * HOUR, until: now - toHoursAgo * HOUR };
};

test('the suite cannot reach the real project by accident', () => {
  // .env holds working credentials and the deploy script runs this suite on the box.
  assert.equal(isSupabaseConfigured(), false);
  assert.deepEqual(loadSupabaseConfig(), { url: '', secretKey: '' });
});

test('a window is answerable only when every source covers all of it', () => {
  const w = window(24);
  const full = { from: w.since - HOUR, through: w.until + HOUR };
  assert.equal(coversRange({ tiktok: full, shopee: full }, w, ['tiktok', 'shopee']), true);

  // One source starting an hour late is a page that silently loses a channel.
  const late = { from: w.since + HOUR, through: w.until + HOUR };
  assert.equal(coversRange({ tiktok: full, shopee: late }, w, ['tiktok', 'shopee']), false);

  // A source with no record at all has never been read.
  assert.equal(coversRange({ tiktok: full }, w, ['tiktok', 'shopee']), false);
});

test('a window ending now is answerable while the ingest is alive', () => {
  const now = Date.now();
  const w = window(24);
  // A sweep records how far it got when it ran, which is always before "now" - so
  // insisting `through` reach `until` means the database is never read by anyone, ever.
  // What keeps the tail right is the webhooks, and a fresh coverage row is the proof they
  // are running.
  const trailing = { from: w.since - HOUR, through: w.until - HOUR, at: new Date(now - 60_000).toISOString() };
  assert.equal(coversRange({ tiktok: trailing }, w, ['tiktok'], now), true);

  // Stop the sweep and the row goes stale, and the dashboard goes back to the platforms
  // on its own rather than serving a tail nobody is maintaining.
  const stale = { ...trailing, at: new Date(now - STALE_AFTER_MS - 60_000).toISOString() };
  assert.equal(coversRange({ tiktok: stale }, w, ['tiktok'], now), false);

  // A row with no timestamp at all proves nothing.
  assert.equal(coversRange({ tiktok: { from: w.since - HOUR, through: w.until - HOUR } }, w, ['tiktok'], now), false);

  // Freshness only forgives the recent end. A window starting before what was ever
  // ingested is missing history no webhook is going to supply.
  const short = { from: w.since + HOUR, through: w.until - HOUR, at: new Date(now).toISOString() };
  assert.equal(coversRange({ tiktok: short }, w, ['tiktok'], now), false);
});

test('no coverage and no sources both mean "ask the platforms"', () => {
  const w = window(24);
  assert.equal(coversRange(null, w, ['tiktok']), false);
  assert.equal(coversRange({}, w, ['tiktok']), false);
  // An empty source list must not read as "everything is covered".
  assert.equal(coversRange({ tiktok: { from: 0, through: 9e9 } }, w, []), false);
});

test('Tokopedia and TikTok Shop share one coverage record', () => {
  // They come from one API, so a quiet Tokopedia week would otherwise never be marked
  // read and the dashboard would consider itself blind there forever.
  assert.deepEqual(SOURCE_CHANNELS.tiktok, ['tokopedia', 'tiktok_shop']);
  assert.deepEqual(SOURCE_CHANNELS.shopee, ['shopee']);
  const sources = activeSources();
  assert.ok(sources.includes('tiktok') && sources.includes('shopee'));
  // Every named source resolves to channels; a typo here would silently cover nothing.
  for (const source of sources) assert.ok(SOURCE_CHANNELS[source]?.length > 0, source);
});

test('the operational record starts on the date the business asked for', () => {
  assert.equal(DB_HISTORY_START, '2026-08-01');
  // Midnight in Jakarta, not in UTC: a seller's first of August starts at 17:00 UTC on
  // the 31st, and getting this wrong quietly drops seven hours of sales.
  assert.equal(wibDate(DB_HISTORY_START_EPOCH), '2026-08-01');
  assert.equal(new Date(DB_HISTORY_START_EPOCH * 1000).toISOString(), '2026-07-31T17:00:00.000Z');
});

test('only a failure worth repeating is marked retryable', () => {
  assert.equal(new SupabaseError('putus', { status: 0 }).retryable, true);
  assert.equal(new SupabaseError('sibuk', { status: 429 }).retryable, true);
  assert.equal(new SupabaseError('rusak', { status: 503 }).retryable, true);
  // A malformed request repeated is a malformed request twice.
  assert.equal(new SupabaseError('salah', { status: 400 }).retryable, false);
  assert.equal(new SupabaseError('ditolak', { status: 401 }).retryable, false);
});

test('the page ceiling is the one PostgREST actually enforces', () => {
  // Asking for more than this returns exactly this many and no error, so a reader that
  // does not page works on part of the data and says nothing.
  assert.equal(PAGE_SIZE, 1000);
});

/* ------------------------------------------------ reading past the thousand-row ceiling */

/**
 * A stand-in for the network, for the two tests below.
 *
 * Nothing here reaches a real project: the config is passed in by hand with a host that
 * does not exist, and fetch itself is replaced for the duration - so a request that
 * somehow escaped the stub would fail to connect rather than find Supabase.
 */
const FAKE = { url: 'http://127.0.0.1:1', secretKey: 'bukan-kunci' };

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(String(url), init ?? {});
  return () => { globalThis.fetch = real; };
}

const answer = (body, { status = 200, contentRange = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => (String(name).toLowerCase() === 'content-range' ? contentRange : null) },
  text: async () => JSON.stringify(body),
});

const rowsFrom = (from, count) => Array.from({ length: count }, (_, i) => ({ n: from + i }));

test('an uncounted read walks its pages to the end and stops', async () => {
  const { selectAll } = await import('../src/db/client.js');
  const seen = [];
  const restore = stubFetch((url, init) => {
    const [from] = String(init.headers.range).split('-').map(Number);
    seen.push(from);
    // No content-range at all, which is what sends selectAll down the fallback walk.
    return answer(rowsFrom(from, from >= 2000 ? 10 : 1000));
  });
  try {
    const rows = await selectAll('orders', { select: 'n' }, { config: FAKE });
    assert.equal(rows.length, 2010);
    assert.deepEqual(seen, [0, 1000, 2000]);
    assert.deepEqual(rows.at(-1), { n: 2009 }, 'halaman terakhir yang pendek mengakhiri jalannya');
  } finally {
    restore();
  }
});

test('a server that ignores Range is refused, not followed forever', async () => {
  const { selectAll, SupabaseError } = await import('../src/db/client.js');
  let requests = 0;
  // A cache, a WAF or a maintenance page in front of PostgREST answers every request with
  // page one. The walk had no cap and no check that it was advancing, so it appended the
  // same thousand rows on every pass until the box ran out of memory - no error, no log,
  // just a process that died.
  const restore = stubFetch(() => {
    requests += 1;
    return answer(rowsFrom(0, 1000));
  });
  try {
    await assert.rejects(
      () => selectAll('orders', { select: 'n' }, { config: FAKE }),
      (error) => {
        assert.ok(error instanceof SupabaseError);
        assert.match(error.message, /Range tidak dihormati/);
        assert.equal(error.retryable, false, 'bertanya lagi hanya mendapat jawaban rusak yang sama');
        return true;
      },
    );
    assert.equal(requests, 2, 'ketahuan pada halaman kedua, bukan setelah setengah juta baris');
  } finally {
    restore();
  }
});

/* -------------------------------------------------- one bad order, ninety-nine good ones */

test('a batch of exactly one bad order is rejected, not thrown, and what was written stands', async () => {
  // The last slice of 101 orders is a slice of one. Throwing there discarded the hundred
  // already written from the count the caller gets back - and in a backfill, ended the
  // whole run on its final batch.
  const { saveOrders } = await import('../src/db/orders.js');

  const before = {
    live: process.env.SUPABASE_TEST_LIVE,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SECRET_KEY,
  };
  // The environment wins over .env in loadSupabaseConfig, so the real project is not
  // reachable from here even before fetch is replaced.
  process.env.SUPABASE_TEST_LIVE = '1';
  process.env.SUPABASE_URL = FAKE.url;
  process.env.SUPABASE_SECRET_KEY = FAKE.secretKey;

  const sent = [];
  const restore = stubFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.p_orders.length);
    if (body.p_orders.length === 1 && body.p_orders[0].id === 'buruk') {
      // What Postgres actually said when a Shopify total arrived as "1073252.09".
      return answer({ message: 'invalid input syntax for type bigint', code: '22P02' }, { status: 400 });
    }
    return answer(body.p_orders.length);
  });

  try {
    const orders = [
      ...Array.from({ length: 100 }, (_, i) => ({ channel: 'shopee', id: `baik-${i}`, finance: { lines: [] } })),
      { channel: 'shopify', id: 'buruk', finance: { lines: [] } },
    ];
    const result = await saveOrders(orders, { source: 'uji' });
    assert.equal(result.written, 100, 'seratus yang baik tetap terhitung');
    assert.equal(result.rejected.length, 1);
    assert.deepEqual({ channel: result.rejected[0].channel, id: result.rejected[0].id }, { channel: 'shopify', id: 'buruk' });
    assert.match(result.rejected[0].error, /bigint/, 'dan namanya disebut, bukan hilang di dalam exception');
    assert.deepEqual(sent, [100, 1], 'batch satu order tidak perlu dipecah lagi');
  } finally {
    restore();
    process.env.SUPABASE_TEST_LIVE = before.live ?? '';
    process.env.SUPABASE_URL = before.url ?? '';
    process.env.SUPABASE_SECRET_KEY = before.key ?? '';
    if (before.live === undefined) delete process.env.SUPABASE_TEST_LIVE;
    if (before.url === undefined) delete process.env.SUPABASE_URL;
    if (before.key === undefined) delete process.env.SUPABASE_SECRET_KEY;
  }
});

/* --------------------------------------------------------------- backfill, chunk by chunk */

const read = (orders, { errors = {}, truncated = [] } = {}) => ({ orders, errors, truncated });
const anOrder = (channel, id) => ({ channel, id, finance: { lines: [] } });

test('a retry keeps what the attempt before it managed to read', async () => {
  const { mergeReads } = await import('../src/db/backfill.js');

  // The retry happens because one platform failed; the other two answered perfectly well.
  // Keeping only the last attempt threw their orders away - fetched, normalised, dropped -
  // and the window was then claimed as covered without them.
  const first = read([anOrder('shopee', 'S1'), anOrder('shopee', 'S2')], { errors: { tiktok: 'fetch failed' } });
  const second = read([anOrder('tokopedia', 'T1'), anOrder('shopee', 'S2')], { errors: { shopee: 'fetch failed' } });

  const merged = mergeReads(first, second);
  assert.deepEqual(merged.orders.map((o) => o.id).sort(), ['S1', 'S2', 'T1']);
  assert.equal(merged.orders.filter((o) => o.id === 'S2').length, 1, 'satu pesanan yang terbaca dua kali tetap satu baris');
  assert.deepEqual(merged.errors, {}, 'sumber yang menjawab di salah satu percobaan bukan kegagalan lagi');

  // A source that failed every time is still a failure, and a read cut short stays cut
  // short: claiming a window that was read short is the expensive mistake here.
  const alwaysBad = mergeReads(read([], { errors: { tiktok: 'a' } }), read([], { errors: { tiktok: 'b' } }));
  assert.deepEqual(alwaysBad.errors, { tiktok: 'b' });
  const cut = mergeReads(read([], { truncated: ['Shopee'] }), read([]));
  assert.deepEqual(cut.truncated, ['Shopee']);
});

test('a database that refuses one chunk costs that chunk, not the whole run', async () => {
  const { backfill } = await import('../src/db/backfill.js');
  const { SupabaseError } = await import('../src/db/client.js');

  const windows = [];
  const collect = async ({ range }) => {
    windows.push(range.label);
    return read([anOrder('shopee', `S${windows.length}`)]);
  };
  // The first week is refused outright - the database unreachable, or ill. That exception
  // used to walk straight out of backfill(), so a job that had already stored five weeks
  // reported nothing at all and had to be started again from the beginning.
  let writes = 0;
  const store = async (orders) => {
    writes += 1;
    if (writes === 1) throw new SupabaseError('tidak bisa menghubungi Supabase: fetch failed', { status: 0 });
    return { written: orders.length, rejected: [] };
  };

  const until = DB_HISTORY_START_EPOCH + 10 * 24 * 3600;
  const result = await backfill({ until, attempts: 1, collect, store });

  assert.equal(windows.length, 2, 'minggu kedua tetap dibaca');
  assert.equal(result.chunks.length, 2);
  assert.match(result.chunks[0].writeError, /fetch failed/);
  assert.equal(result.chunks[0].written, 0);
  assert.equal(result.chunks[1].written, 1, 'dan tersimpan');
  assert.equal(result.stored, 1);
  // Nothing is claimed: an unclaimed window is read live again, a wrongly claimed one is
  // never revisited.
  assert.deepEqual(result.claimed, []);
  assert.ok(result.unclaimed.includes('shopee') && result.unclaimed.includes('tiktok'));
});
