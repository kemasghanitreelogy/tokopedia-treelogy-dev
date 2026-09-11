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
