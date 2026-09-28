import test from 'node:test';
import assert from 'node:assert/strict';
import { soldBySku, wouldDropBelow } from '../src/stock-topup.js';
import { topUpAfterOrder, resetStockWatch } from '../src/stock-watch.js';
import { invalidate } from '../src/cache.js';

/**
 * Topping a listing up the moment an order takes it under.
 *
 * The half-hourly timer is the backstop, not the answer: a listing that sells its last
 * few inside that window shows "habis" to everybody who looks, which is the one thing
 * the top-up exists to prevent. What moves stock is an order, so the check hangs off the
 * push - and the projection is what keeps that from costing a catalogue read each time.
 */

const line = (sku, qty) => ({ sku, qty });
const tiktok = (qty) => ({ qty, rows: [{ qty, productId: 'p', skuId: 's', warehouseId: 'w' }], conflict: false });
const catalog = (skus) => ({ skus, errors: {} });

test('what left the shelf is counted in the catalogue’s own spelling', () => {
  // Shopee calls it OMC-90, Tokopedia calls it OMC90, the master reconciles both.
  const sold = soldBySku({ lines: [line('OMC-90', 2), line('OMC90', 3), line('OMP-45-001', 1)] });
  assert.equal(sold.get('OMC-90-001'), 5);
  assert.equal(sold.get('OMP-45-001'), 1);
});

test('a SKU the master has never heard of is still stock leaving', () => {
  const sold = soldBySku({ lines: [line('SOMETHING-NEW', 4)] });
  assert.equal(sold.get('SOMETHING-NEW'), 4);
});

test('an ordinary order is answered without asking any channel', () => {
  // The whole point: a subtraction is free, and on a normal order the answer is no.
  const at = wouldDropBelow(catalog([{ sku: 'OMC-90-001', tiktok: tiktok(223) }]), { lines: [line('OMC-90-001', 2)] });
  assert.deepEqual(at, []);
});

test('an order that takes a listing under the floor is flagged', () => {
  const at = wouldDropBelow(catalog([{ sku: 'OMC-90-001', tiktok: tiktok(101) }]), { lines: [line('OMC-90-001', 3)] });
  assert.deepEqual(at.map((a) => [a.sku, a.from, a.projected]), [['OMC-90-001', 101, 98]]);
});

test('it triggers slightly early, because the cached figure is a minute old', () => {
  // Landing exactly on the floor still counts: other orders may have landed inside the
  // minute the cache has been held. Being early costs one read; being late costs "habis".
  const at = wouldDropBelow(catalog([{ sku: 'X', tiktok: tiktok(104) }]), { lines: [line('X', 1)] });
  assert.equal(at.length, 1, 'proyeksi 103 masih dalam margin');
});

test('a SKU the order did not touch is nobody’s business', () => {
  const at = wouldDropBelow(
    catalog([{ sku: 'SOLD', tiktok: tiktok(101) }, { sku: 'QUIET', tiktok: tiktok(3) }]),
    { lines: [line('SOLD', 5)] },
  );
  assert.deepEqual(at.map((a) => a.sku), ['SOLD'], 'yang rendah tapi tak terjual diurus timer');
});

test('an order with no lines asks nothing at all', () => {
  assert.deepEqual(wouldDropBelow(catalog([{ sku: 'X', tiktok: tiktok(1) }]), { lines: [] }), []);
});

/* ------------------------------------------------------ the trigger itself */

test('a quiet order writes nothing and reads no channel', async (t) => {
  resetStockWatch();
  invalidate();
  let applied = 0;
  const read = async () => catalog([{ sku: 'A', tiktok: tiktok(500) }]);
  const out = await topUpAfterOrder({ lines: [line('A', 1)] }, { read, apply: async () => { applied += 1; } });
  assert.equal(out.atRisk, 0);
  assert.equal(applied, 0);
});

test('a burst of orders is one reason to look, not six', async () => {
  resetStockWatch();
  invalidate();
  const read = async () => catalog([{ sku: 'A', tiktok: tiktok(101) }]);
  let applied = 0;
  const apply = async () => { applied += 1; return { succeeded: 1, failed: 0, results: [] }; };
  const order = { lines: [line('A', 3)] };

  const outs = await Promise.all([
    topUpAfterOrder(order, { read, apply }),
    topUpAfterOrder(order, { read, apply }),
    topUpAfterOrder(order, { read, apply }),
  ]);
  assert.ok(outs.some((o) => /berjalan|dijalankan/.test(o.reason ?? '')), 'yang lain ditahan');
  assert.ok(applied <= 1, `menulis ${applied} kali untuk satu ledakan pesanan`);
});

test('an incomplete catalogue is never a reason to write', async () => {
  resetStockWatch();
  invalidate();
  const read = async () => ({ skus: [{ sku: 'A', tiktok: tiktok(1) }], errors: { shopee: 'tidak menjawab' } });
  let applied = 0;
  const out = await topUpAfterOrder({ lines: [line('A', 1)] }, { read, apply: async () => { applied += 1; } });
  // A channel that will not answer reads as "nothing is low", so it must stop the run
  // rather than let it decide from half a picture.
  assert.equal(out.checked, false);
  assert.equal(applied, 0);
});

test('it never throws at the webhook that called it', async () => {
  resetStockWatch();
  invalidate();
  // A failed stock write must not turn a handled push into a 500 the platform retries.
  const out = await topUpAfterOrder({ lines: [line('A', 5)] }, {
    read: async () => catalog([{ sku: 'A', tiktok: tiktok(101) }]),
    apply: async () => { throw new Error('shopee menolak'); },
  });
  assert.ok(out);
});
