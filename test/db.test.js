import test from 'node:test';
import assert from 'node:assert/strict';
import { coversRange, DB_HISTORY_START, DB_HISTORY_START_EPOCH } from '../src/db/orders.js';
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

  // One source ending early is the same problem at the other end.
  const early = { from: w.since - HOUR, through: w.until - HOUR };
  assert.equal(coversRange({ tiktok: full, shopee: early }, w, ['tiktok', 'shopee']), false);

  // A source with no record at all has never been read.
  assert.equal(coversRange({ tiktok: full }, w, ['tiktok', 'shopee']), false);
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
