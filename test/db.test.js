import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coversRange, STALE_AFTER_MS, DB_HISTORY_START, DB_HISTORY_START_EPOCH, ordersOutstanding,
} from '../src/db/orders.js';
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

/* ------------------------------------------- paging a table that is being written into */

/**
 * Point the client at a host that does not exist for the length of one test.
 *
 * The environment wins over .env in loadSupabaseConfig, so the real project is out of reach
 * from here even before fetch is replaced - and it is put back afterwards whatever happens,
 * because a leaked SUPABASE_TEST_LIVE would let every later test in this file reach out.
 */
async function withFakeProject(run) {
  const before = {
    SUPABASE_TEST_LIVE: process.env.SUPABASE_TEST_LIVE,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  };
  process.env.SUPABASE_TEST_LIVE = '1';
  process.env.SUPABASE_URL = FAKE.url;
  process.env.SUPABASE_SECRET_KEY = FAKE.secretKey;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

const rangeStart = (init) => Number(String(init.headers.range).split('-')[0]);

test('a counted read carries the count on its last page as well, at no extra round trip', async () => {
  const { selectAll } = await import('../src/db/client.js');
  const seen = [];
  const restore = stubFetch((url, init) => {
    const from = rangeStart(init);
    seen.push({ from, counted: String(init.headers.prefer ?? '').includes('count=exact') });
    return answer(rowsFrom(from, from >= 2000 ? 500 : 1000), { contentRange: `${from}-${from + 999}/2500` });
  });
  try {
    const rows = await selectAll('orders', { select: 'n' }, { config: FAKE });
    assert.equal(rows.length, 2500);
    assert.deepEqual(rows.at(-1), { n: 2499 });
    // The count on the last page is what the check below compares against, and it rides a
    // request that was going out anyway.
    assert.deepEqual(seen, [{ from: 0, counted: true }, { from: 1000, counted: false }, { from: 2000, counted: true }]);
  } finally {
    restore();
  }
});

test('a window written into while it is being paged is refused, not silently short', async () => {
  const { selectAll, SupabaseError } = await import('../src/db/client.js');
  let reads = 0;
  // One webhook lands while page two is in flight. Ordered created_at.desc, that pushes
  // every older row one place down, so the oldest row in the window slides past offset 2499
  // - the last one the arithmetic ever asks for - and was dropped with no error at all.
  const restore = stubFetch((url, init) => {
    reads += 1;
    const from = rangeStart(init);
    const total = from === 2000 ? 2501 : 2500;
    return answer(rowsFrom(from, from >= 2000 ? 500 : 1000), { contentRange: `${from}-${from + 999}/${total}` });
  });
  try {
    await assert.rejects(
      () => selectAll('orders', { select: 'n' }, { config: FAKE }),
      (error) => {
        assert.ok(error instanceof SupabaseError);
        assert.match(error.message, /tidak utuh/);
        assert.equal(error.retryable, false, 'pembacaan ulang sudah dilakukan tiga kali di dalam');
        return true;
      },
    );
    assert.equal(reads, 9, 'tiga kali baca ulang, tiga halaman tiap kali');
  } finally {
    restore();
  }
});

test('a page whose offset no longer exists is a table that shrank, not a broken request', async () => {
  const { selectAll } = await import('../src/db/client.js');
  // PostgREST answers 416 when a range starts past the end of the result, which after a
  // delete is what the last offset becomes. Treated as a request error it ended the read
  // outright; it is the same tearing the count catches, arriving as a status.
  let attempts = 0;
  const restore = stubFetch((url, init) => {
    const from = rangeStart(init);
    if (from === 1000) {
      attempts += 1;
      if (attempts === 1) return answer({ message: 'Requested Range Not Satisfiable', code: 'PGRST103' }, { status: 416 });
      return answer(rowsFrom(from, 200), { contentRange: `1000-1199/1200` });
    }
    return answer(rowsFrom(from, 1000), { contentRange: `0-999/${attempts === 0 ? 1500 : 1200}` });
  });
  try {
    const rows = await selectAll('orders', { select: 'n' }, { config: FAKE });
    assert.equal(rows.length, 1200, 'dibaca ulang dari awal, bukan dilempar ke pemanggil');
  } finally {
    restore();
  }
});

test('the coverage table is read in a fixed order, so paging it cannot drop a source', async () => {
  const { readCoverage } = await import('../src/db/orders.js');
  let asked = '';
  const restore = stubFetch((url) => {
    asked = decodeURIComponent(url);
    return answer([], { contentRange: '0-0/0' });
  });
  try {
    await withFakeProject(() => readCoverage());
    // Postgres orders nothing it is not asked to, and selectAll pages by offset. A source
    // missing from the coverage map reads as "never ingested", which is the one answer that
    // sends every dashboard back to the platforms with nothing to explain why.
    assert.match(asked, /order=source\.asc/);
  } finally {
    restore();
  }
});

/* ------------------------------------------------- the chunk boundary, and what it claims */

const noStore = async () => ({ written: 0, rejected: [] });
const WEEK = 7 * 24 * 3600;

test('the last chunk reaches the end of the range instead of stopping a second short', async () => {
  const { backfill } = await import('../src/db/backfill.js');
  const windows = [];
  const collect = async ({ range }) => { windows.push(range); return read([]); };

  // A range that divides exactly by the chunk span: the loop stopped as soon as `start`
  // reached `until`, leaving the single instant `until` unread while coverage was claimed
  // through it - and a claimed window is never read live again.
  const until = DB_HISTORY_START_EPOCH + 2 * WEEK;
  await backfill({ until, attempts: 1, collect, store: noStore, dryRun: true });

  assert.equal(windows.length, 2);
  assert.equal(windows[0].since, DB_HISTORY_START_EPOCH);
  assert.equal(windows[1].since, windows[0].until + 1, 'tanpa celah di antara dua potongan');
  assert.equal(windows.at(-1).until, until, 'detik terakhir ikut dibaca, bukan hanya diklaim');
});

test('a coverage claim that cannot be written costs the claim, not the report', async () => {
  const { backfill } = await import('../src/db/backfill.js');
  // recordCoverage goes through the real client, which under the test runner refuses for
  // want of credentials - which is exactly the failure being exercised: one throw after
  // every chunk is already stored used to carry off the whole report with it, and the
  // operator's only way to learn how far the run had got was to start it again.
  const collect = async () => read([anOrder('shopee', 'S1')]);
  const store = async (orders) => ({ written: orders.length, rejected: [] });
  const result = await backfill({ until: DB_HISTORY_START_EPOCH + WEEK, attempts: 1, collect, store });

  assert.equal(result.stored, 1, 'yang sudah tersimpan tetap dilaporkan');
  assert.equal(result.chunks.length, 1);
  assert.deepEqual(result.claimed, [], 'dan tidak ada sumber yang mengaku tercatat');
  assert.deepEqual([...result.claimFailed.map((c) => c.source)].sort(), [...result.unclaimed].sort());
  assert.match(result.claimFailed[0].error, /belum diisi/);
});

test('a failure that arrives with no message still costs the source its claim', async () => {
  const { backfill } = await import('../src/db/backfill.js');
  // `new Error()` carries an empty message, and the claim test weighed the message rather
  // than looking for the source - so the one failure that said nothing was also the only
  // one that was forgiven, and the week was claimed with Shopee missing from it.
  const collect = async () => read([], { errors: { shopee: '' } });
  const result = await backfill({ until: DB_HISTORY_START_EPOCH + WEEK, attempts: 1, collect, store: noStore, dryRun: true });
  assert.ok(!result.claimed.includes('shopee'), 'shopee gagal, walau tanpa kata-kata');
  assert.ok(result.unclaimed.includes('shopee'));
  assert.ok(result.claimed.includes('tiktok'), 'dan yang lain tidak ikut kena');
});

test('a read that throws costs its sources, not the rest of the run', async () => {
  const { backfill } = await import('../src/db/backfill.js');
  let calls = 0;
  const collect = async () => {
    calls += 1;
    if (calls === 1) throw new Error('fetch failed');
    return read([anOrder('shopee', 'S2')]);
  };
  const result = await backfill({ until: DB_HISTORY_START_EPOCH + 2 * WEEK, attempts: 1, collect, store: noStore, dryRun: true });

  assert.equal(result.chunks.length, 2, 'minggu kedua tetap dibaca');
  assert.match(result.chunks[0].errors.shopee, /fetch failed/);
  assert.match(result.chunks[0].errors.tiktok, /fetch failed/, 'satu lemparan adalah kegagalan semua sumber');
  assert.equal(result.seen, 1);
  assert.deepEqual(result.claimed, [], 'dan tidak ada yang diklaim di atas potongan yang tak terbaca');
});

test('retrying a chunk cannot launder a platform that is simply down', async () => {
  const { mergeReads } = await import('../src/db/backfill.js');
  // The retries exist for a flaky link, so the question worth pinning is whether three goes
  // can turn a permanent failure into a clean read. They cannot: an error survives the merge
  // only by being in both sides, so what comes out is the set of sources that failed every
  // single time - and a source that answered once keeps its orders and loses its error.
  const first = read([], { errors: { tiktok: 'fetch failed', shopee: 'fetch failed' } });
  const second = read([anOrder('shopee', 'S1')], { errors: { tiktok: 'fetch failed' } });
  const third = read([anOrder('shopee', 'S2')], { errors: { tiktok: '401 unauthorized' } });

  const merged = mergeReads(mergeReads(first, second), third);
  assert.deepEqual(Object.keys(merged.errors), ['tiktok']);
  assert.equal(merged.errors.tiktok, '401 unauthorized', 'dilaporkan dengan kegagalan terakhirnya');
  assert.deepEqual(merged.orders.map((o) => o.id), ['S1', 'S2']);
});

/* ----------------------------------------------- what a live read is allowed to claim */

test('a rejected order nobody can place costs every claim, not none of them', async () => {
  const { rememberOrders } = await import('../src/orders-source.js');
  const claims = [];
  const restore = stubFetch(async (url, init) => {
    if (url.includes('/rpc/ingest_orders')) {
      const body = JSON.parse(init.body);
      // A channel the database has never heard of, refused one order at a time.
      if (body.p_orders.some((o) => o.channel === 'martabak')) {
        if (body.p_orders.length === 1) return answer({ message: 'channel tidak dikenal', code: '23514' }, { status: 400 });
        return answer({ message: 'batch gagal', code: '23514' }, { status: 400 });
      }
      return answer(body.p_orders.length);
    }
    if (init.method === 'POST') { claims.push(JSON.parse(init.body)[0].source); return answer(null); }
    return answer([], { contentRange: '0-0/0' });
  });

  try {
    const live = { orders: [anOrder('shopee', 'S1'), anOrder('martabak', 'X1')], errors: {}, truncated: [] };
    const result = await withFakeProject(() => rememberOrders(live, { since: 1, until: 2 }));
    // sourceOfChannel answers null for a channel it cannot place, and null matched no
    // source - so the one rejection nobody could explain was the only one that cost
    // nothing, and the window was claimed with a hole of unknown position frozen into it.
    assert.deepEqual(result.claimed, [], 'lubang yang tak diketahui letaknya membatalkan semua klaim');
    assert.deepEqual(claims, []);
    assert.equal(result.written, 1, 'pesanan yang baik tetap tersimpan dan terhitung');
    assert.equal(result.rejected.length, 1);
  } finally {
    restore();
  }
});

test('a rejected order that can be placed costs only its own source', async () => {
  const { rememberOrders } = await import('../src/orders-source.js');
  const claims = [];
  const restore = stubFetch(async (url, init) => {
    if (url.includes('/rpc/ingest_orders')) {
      const body = JSON.parse(init.body);
      if (body.p_orders.some((o) => o.id === 'S-buruk')) {
        return answer({ message: 'invalid input syntax for type bigint', code: '22P02' }, { status: 400 });
      }
      return answer(body.p_orders.length);
    }
    if (init.method === 'POST') { claims.push(JSON.parse(init.body)[0].source); return answer(null); }
    return answer([], { contentRange: '0-0/0' });
  });

  try {
    const live = { orders: [anOrder('tokopedia', 'T1'), anOrder('shopee', 'S-buruk')], errors: {}, truncated: [] };
    const result = await withFakeProject(() => rememberOrders(live, { since: 1, until: 2 }));
    assert.ok(result.claimed.includes('tiktok'), 'sumber yang utuh tetap boleh diklaim');
    assert.ok(!result.claimed.includes('shopee'));
    assert.ok(!claims.includes('shopee'), 'shopee punya lubang, jadi jendelanya dibaca langsung lagi');
  } finally {
    restore();
  }
});

test('a worklist is asked for by stage, not by day, and keeps typed-in sales', async () => {
  // Proses, Picklist and Label ask "what is still owed", and the day an order arrived has
  // nothing to do with the answer. The floor is only there so a row we stopped hearing
  // about cannot haunt the bench forever.
  const seen = [];
  const restore = stubFetch(async (url) => {
    seen.push(String(url));
    return answer([{ payload: { channel: 'shopify', id: '#1', stage: 'to_ship' } }]);
  });
  try {
    const rows = await ordersOutstanding({ since: 1_779_000_000, config: FAKE });
    assert.deepEqual(rows.map((o) => o.id), ['#1']);
  } finally {
    restore();
  }
  const url = new URL(seen[0]);
  assert.equal(url.searchParams.get('or'), '(stage.in.("unpaid","to_ship","shipping"),channel.in.("manual"))',
    'a typed-in sale is work the moment it exists, whatever its stage says');
  assert.equal(url.searchParams.get('created_at'), 'gte.2026-05-17T06:40:00.000Z');
  assert.equal(url.searchParams.get('order'), 'created_at.desc,channel.asc,id.asc');
  assert.equal(url.searchParams.get('select'), 'payload');
});
