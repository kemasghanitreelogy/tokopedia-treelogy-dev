import test from 'node:test';
import assert from 'node:assert/strict';
import { cached, invalidate, cacheSize } from '../src/cache.js';

test('a value is computed once and reused within its TTL', async () => {
  invalidate();
  let calls = 0;
  const factory = () => { calls += 1; return Promise.resolve('x'); };
  assert.equal(await cached('k', 1000, factory), 'x');
  assert.equal(await cached('k', 1000, factory), 'x');
  assert.equal(calls, 1);
});

test('concurrent callers share one in-flight request', async () => {
  invalidate();
  let calls = 0;
  const factory = () => { calls += 1; return new Promise((r) => setTimeout(() => r('v'), 20)); };
  const results = await Promise.all([cached('k', 1000, factory), cached('k', 1000, factory), cached('k', 1000, factory)]);
  assert.deepEqual(results, ['v', 'v', 'v']);
  assert.equal(calls, 1);
});

test('an expired entry is recomputed', async () => {
  invalidate();
  let calls = 0;
  const factory = () => { calls += 1; return Promise.resolve(calls); };
  assert.equal(await cached('k', 1, factory), 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await cached('k', 1, factory), 2);
});

test('a rejection is never cached and poisons nothing', async () => {
  invalidate();
  let calls = 0;
  const factory = () => { calls += 1; return Promise.reject(new Error('boom')); };
  await assert.rejects(() => cached('k', 1000, factory));
  await assert.rejects(() => cached('k', 1000, factory));
  assert.equal(calls, 2, 'a failed lookup must be retried, not served from cache');
});

test('invalidate clears by prefix, leaving unrelated keys intact', async () => {
  invalidate();
  await cached('catalog', 1000, () => 'a');
  await cached('catalog:x', 1000, () => 'b');
  await cached('orders:1', 1000, () => 'c');
  invalidate('catalog');
  assert.equal(cacheSize(), 1);
});

test('invalidate with no prefix clears everything', async () => {
  await cached('a', 1000, () => 1);
  await cached('b', 1000, () => 2);
  invalidate();
  assert.equal(cacheSize(), 0);
});

test('a stale entry is served at once and refreshed behind the caller', async () => {
  invalidate();
  let calls = 0;
  let release;
  const factory = () => { calls += 1; return calls === 1 ? Promise.resolve('old') : new Promise((r) => { release = r; }); };
  assert.equal(await cached('k', 1, factory, { staleMs: 10_000 }), 'old');
  await new Promise((r) => setTimeout(r, 5));
  // Past fresh: the old value comes back immediately, and one refresh has started.
  const started = Date.now();
  assert.equal(await cached('k', 1, factory, { staleMs: 10_000 }), 'old');
  assert.ok(Date.now() - started < 50, 'the stale read must not wait on the refresh');
  assert.equal(await cached('k', 1, factory, { staleMs: 10_000 }), 'old', 'a second stale read shares the one refresh');
  assert.equal(calls, 2);
  release('new');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await cached('k', 1000, factory, { staleMs: 10_000 }), 'new');
});

test('a refresh that fails keeps the stale value and backs off', async () => {
  invalidate();
  let calls = 0;
  const factory = () => { calls += 1; return calls === 1 ? Promise.resolve('old') : Promise.reject(new Error('db down')); };
  assert.equal(await cached('k', 1, factory, { staleMs: 10_000 }), 'old');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await cached('k', 1, factory, { staleMs: 10_000 }), 'old');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await cached('k', 1, factory, { staleMs: 10_000 }), 'old', 'still served after the refresh failed');
  assert.equal(calls, 2, 'the failed refresh is not retried on the very next read');
});

test('past its stale window an entry is fetched in the open again', async () => {
  invalidate();
  let calls = 0;
  const factory = () => { calls += 1; return Promise.resolve(calls); };
  assert.equal(await cached('k', 1, factory, { staleMs: 2 }), 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await cached('k', 1, factory, { staleMs: 2 }), 2);
});

test('clearing "orders" clears every list a push has just made wrong', async () => {
  // The keys the dashboard actually uses: one entry per range, plus the worklists.
  invalidate();
  const keys = ['orders:today', 'orders:7d', 'orders:2026-09-01:2026-09-22', 'orders:outstanding'];
  await Promise.all(keys.map((key) => cached(key, 60_000, async () => key)));
  await cached('jurnal', 60_000, async () => 'ledger');
  await cached('reviews', 60_000, async () => 'reviews');
  assert.equal(cacheSize(), keys.length + 2);

  invalidate('orders');
  // A push changes an order, so every cached list of orders is now a description of the
  // past - including the worklists, which is where a newly paid order has to appear.
  assert.equal(cacheSize(), 2, 'hanya jurnal dan reviews yang tersisa');
  assert.equal(await cached('jurnal', 60_000, async () => 'baru'), 'ledger', 'yang lain tidak ikut dibuang');
});
