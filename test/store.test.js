import test from 'node:test';
import assert from 'node:assert/strict';
import { readDoc, writeDoc, updateDoc, listDocs, deleteDoc, backendName, resetStore, closeStore } from '../src/store/index.js';

// A Redis client keeps the event loop alive; without this the runner never exits.
test.after(async () => { await closeStore(); });

test('under the test runner the store is a throwaway sqlite file, never Blob', () => {
  // ...unless a Redis is pointed at on purpose, to test that backend for real.
  assert.equal(backendName(), process.env.STATE_BACKEND_TEST === 'redis' ? 'redis' : 'sqlite');
});

test('a document round-trips, and absence is null rather than an error', async () => {
  await deleteDoc('uji/a.json');
  assert.equal(await readDoc('uji/a.json'), null);
  await writeDoc('uji/a.json', { n: 1, list: [1, 2] });
  assert.deepEqual(await readDoc('uji/a.json'), { n: 1, list: [1, 2] });
  await writeDoc('uji/a.json', { n: 2 });
  assert.deepEqual(await readDoc('uji/a.json'), { n: 2 }, 'menimpa, bukan menggabung');
});

test('updateDoc applies every writer, even when they race', async () => {
  // The exact failure the Blob backend had: two writers load, each adds one order, the
  // later save drops the earlier one. A transaction makes that impossible.
  await deleteDoc('uji/ledger.json');
  const writers = Array.from({ length: 25 }, (_, i) =>
    updateDoc('uji/ledger.json', (cur) => ({ ...cur, orders: { ...cur.orders, [`o${i}`]: true } }), { orders: {} }));
  await Promise.all(writers);
  const final = await readDoc('uji/ledger.json');
  assert.equal(Object.keys(final.orders).length, 25);
});

test('updateDoc starts from the initial value when nothing is stored, and never mutates it', async () => {
  await deleteDoc('uji/fresh.json');
  const initial = { count: 0 };
  const next = await updateDoc('uji/fresh.json', (cur) => ({ count: cur.count + 1 }), initial);
  assert.deepEqual(next, { count: 1 });
  assert.deepEqual(initial, { count: 0 });
});

test('a failing updater leaves the document untouched', async () => {
  await writeDoc('uji/keep.json', { v: 'lama' });
  await assert.rejects(() => updateDoc('uji/keep.json', () => { throw new Error('batal'); }));
  assert.deepEqual(await readDoc('uji/keep.json'), { v: 'lama' });
});

test('listing by prefix returns keys and sizes, in order', async () => {
  await writeDoc('uji/hist/2025-01.json', { a: 1 });
  await writeDoc('uji/hist/2025-02.json', { a: 22 });
  const rows = await listDocs('uji/hist/');
  assert.deepEqual(rows.map((r) => r.key), ['uji/hist/2025-01.json', 'uji/hist/2025-02.json']);
  assert.ok(rows[1].size > rows[0].size);
});

test('the database can be closed and reopened at the same path without losing anything', async () => {
  await writeDoc('uji/persist.json', { ok: true });
  resetStore();
  assert.deepEqual(await readDoc('uji/persist.json'), { ok: true });
});

test('the test runner is never routed to a production store, whatever the env says', async () => {
  // The deploy script runs `npm test` with /etc/treelogy/env loaded, which sets
  // STATE_BACKEND=redis. Before this, the suite connected to the production Redis - and
  // one of its tests deletes the TikTok token bundle. Every deploy would have wiped it.
  const before = process.env.STATE_BACKEND;
  const beforeTest = process.env.STATE_BACKEND_TEST;
  try {
    process.env.STATE_BACKEND = 'redis';
    delete process.env.STATE_BACKEND_TEST;
    assert.equal(backendName(), 'sqlite', 'STATE_BACKEND tidak boleh mengalahkan NODE_TEST_CONTEXT');
    process.env.STATE_BACKEND = 'blob';
    assert.equal(backendName(), 'sqlite');
    // Testing a real Redis on purpose still works, through a variable production never sets.
    process.env.STATE_BACKEND_TEST = 'redis';
    assert.equal(backendName(), 'redis');
  } finally {
    if (before === undefined) delete process.env.STATE_BACKEND; else process.env.STATE_BACKEND = before;
    if (beforeTest === undefined) delete process.env.STATE_BACKEND_TEST; else process.env.STATE_BACKEND_TEST = beforeTest;
  }
});

test('the shared request budget hands out a window, then makes callers wait', async () => {
  const { reserveSlot } = await import('../src/store/index.js');
  if (backendName() !== 'redis') {
    // SQLite has no cross-process view; it must say "go ahead" rather than pretend.
    assert.equal(await reserveSlot('uji-rate', 3, 1000), 0);
    return;
  }
  const key = `uji-rate-${Date.now()}`;
  assert.equal(await reserveSlot(key, 3, 5000), 0);
  assert.equal(await reserveSlot(key, 3, 5000), 0);
  assert.equal(await reserveSlot(key, 3, 5000), 0);
  const wait = await reserveSlot(key, 3, 5000);
  assert.ok(wait > 0 && wait <= 5100, `harus menunggu, dapat ${wait}`);
});
