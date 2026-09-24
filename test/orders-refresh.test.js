import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshOrders } from '../src/orders-refresh.js';
import { cached, cacheSize, invalidate } from '../src/cache.js';

/**
 * Every screen is drawn from our own table, so anything that changes an order on a
 * platform has to tell the table. Two Shopee parcels arranged at 10:28 and PROCESSED one
 * second later sat in "perlu diatur" for an hour because nothing did.
 */

const yes = () => true;

test('what moved is re-read and stored, and the cached lists are dropped', async () => {
  invalidate();
  await cached('orders:today', 60_000, async () => 'lama');
  await cached('orders:outstanding', 60_000, async () => 'lama');
  await cached('jurnal', 60_000, async () => 'buku');

  const saved = [];
  const out = await refreshOrders([{ channel: 'shopee', id: 'A' }, { channel: 'tokopedia', id: 'B' }], {
    read: async (selection) => ({ orders: selection.map((o) => ({ ...o, status: 'PROCESSED' })) }),
    save: async (orders) => { saved.push(...orders.map((o) => o.id)); },
    hasDatabase: yes,
  });

  assert.equal(out.refreshed, 2);
  assert.deepEqual(saved, ['A', 'B']);
  assert.equal(await cached('jurnal', 60_000, async () => 'baru'), 'buku', 'hanya daftar pesanan yang dibuang');
  assert.equal(cacheSize(), 1);
});

test('a typed-in sale is never asked about, because no platform has it', async () => {
  let asked = null;
  const out = await refreshOrders([{ channel: 'manual', id: 'DP-1' }], {
    read: async (selection) => { asked = selection; return { orders: [] }; },
    save: async () => {}, hasDatabase: yes,
  });
  assert.equal(asked, null);
  assert.equal(out.refreshed, 0);
});

test('a platform that will not answer does not turn a completed shipment into a failure', async () => {
  invalidate();
  await cached('orders:today', 60_000, async () => 'lama');
  const out = await refreshOrders([{ channel: 'shopee', id: 'A' }], {
    read: async () => { throw new Error('platform sedang mati'); },
    save: async () => {}, hasDatabase: yes,
  });
  assert.equal(out.refreshed, 0);
  assert.match(out.error, /sedang mati/);
  // The parcel really did ship, so the stale list must still go.
  assert.equal(cacheSize(), 0, 'cache tetap dibuang walau pembacaan gagal');
});

test('nothing selected is nothing done', async () => {
  let called = false;
  const out = await refreshOrders([], { read: async () => { called = true; return { orders: [] }; }, save: async () => {}, hasDatabase: yes });
  assert.equal(out.refreshed, 0);
  assert.equal(called, false);
  // Rubbish in the selection is dropped rather than sent to a platform as an empty id.
  assert.equal((await refreshOrders([{ channel: '', id: '' }], { read: async () => { called = true; return { orders: [] }; }, save: async () => {}, hasDatabase: yes })).refreshed, 0);
  assert.equal(called, false);
});

test('without a database there is nothing to bring into line', async () => {
  let called = false;
  await refreshOrders([{ channel: 'shopee', id: 'A' }], {
    read: async () => { called = true; return { orders: [] }; },
    save: async () => {}, hasDatabase: () => false,
  });
  assert.equal(called, false);
});
