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

/* ---------------------------------------- the compare-and-set Blob does not have natively */

/**
 * A stand-in for Vercel Blob: a put is last-write-wins and there is no conditional write.
 *
 * `intruder`, when set, is the other process landing in the same instant ours does - the
 * interleaving that used to leave two sweeps both believing they had taken the sync lock.
 * It fires once, so a retry gets a quiet store to write into, exactly as a real race does.
 */
function fakeBlob(initial = null) {
  const store = { value: initial, intruder: null, writes: 0 };
  store.io = {
    async read() { return store.value === null ? null : JSON.parse(JSON.stringify(store.value)); },
    async write(_key, value) {
      store.writes += 1;
      store.value = JSON.parse(JSON.stringify(value));
      if (store.intruder) { store.value = store.intruder; store.intruder = null; }
    },
  };
  return store;
}

test('a Blob write somebody else overtook is noticed, so the lock still has one winner', async () => {
  const { verifiedUpdate } = await import('../src/store/index.js');
  const now = Date.now();
  // The updater acquireLock uses: take it when it is free or stale, decline when it is held.
  const take = (owner) => (current) => (
    current?.owner && now - Number(current.at) < 300_000 ? current : { owner, at: now }
  );

  const blob = fakeBlob();
  blob.intruder = { owner: 'sweep-B', at: now };
  const outcome = await verifiedUpdate(blob.io, 'mekari/sync.lock', take('sweep-A'), { owner: null, at: 0 });

  // Before the read-back, both runs returned their own owner and both posted to Jurnal.
  assert.deepEqual(outcome, { owner: 'sweep-B', at: now }, 'A membaca ulang dan menemukan pemilik yang menang');
  assert.deepEqual(blob.value, { owner: 'sweep-B', at: now });
  assert.equal(blob.writes, 1, 'yang kalah tidak menulis lagi di atas pemenang');
});

test('a keyed document overtaken mid-write is re-applied rather than lost', async () => {
  const { verifiedUpdate } = await import('../src/store/index.js');
  const blob = fakeBlob({ orders: {} });
  blob.intruder = { orders: { 'TRL-2': true } };
  const next = await verifiedUpdate(
    blob.io,
    'mekari/ledger.json',
    (current) => ({ orders: { ...current.orders, 'TRL-1': true } }),
    { orders: {} },
  );
  // The failure this replaces: the ledger entry for TRL-1 was written, overwritten, and
  // never mentioned again, so the next sweep posted that invoice to Jurnal a second time.
  assert.deepEqual(Object.keys(next.orders).sort(), ['TRL-1', 'TRL-2']);
  assert.deepEqual(blob.value, next);
});

test('a Blob write that never lands is a throw, not a quiet success', async () => {
  const { verifiedUpdate } = await import('../src/store/index.js');
  const blob = fakeBlob();
  const io = {
    read: blob.io.read,
    // Somebody else wins every single time. Returning happily here is what the old
    // read-then-write did on every one of them.
    async write() { blob.value = { owner: 'selalu-orang-lain', at: 1 }; },
  };
  await assert.rejects(
    () => verifiedUpdate(io, 'mekari/sync.lock', () => ({ owner: 'kita', at: 2 }), null, 3),
    /dibatalkan setelah 3 percobaan/,
  );
  assert.deepEqual(blob.value, { owner: 'selalu-orang-lain', at: 1 });
});
