import test from 'node:test';
import assert from 'node:assert/strict';
import { planTopup, describeTopup, FLOOR, ADD, MAX_WRITES } from '../src/stock-topup.js';

/**
 * Putting stock back on a listing that has drifted under the floor.
 *
 * Safe to do without a person only because the figure on a Treelogy listing is a display
 * number rather than a count of jars - confirmed by the operator before this was built,
 * because on the other reading it would be selling goods that do not exist.
 */

const tiktok = (qty, over = {}) => ({ qty, rows: [{ qty, productId: 'p1', skuId: 's1', warehouseId: 'w1', ...over }], conflict: false });
const shopee = (qty, over = {}) => ({ qty, rows: [{ qty, itemId: 10, modelId: 20, ...over }], conflict: false });
const catalog = (skus) => ({ skus, errors: {} });

test('a listing under the floor gets exactly the operator rule: plus a hundred', () => {
  const plan = planTopup(catalog([{ sku: 'OMC-90-001', title: 'Kapsul', tiktok: tiktok(99) }]));
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(
    { from: plan.changes[0].from, to: plan.changes[0].to, delta: plan.changes[0].delta },
    { from: 99, to: 199, delta: 100 },
  );
  // 40 becomes 140, not 100: the rule is "add", not "raise to".
  const low = planTopup(catalog([{ sku: 'X', tiktok: tiktok(40) }]));
  assert.equal(low.changes[0].to, 140);
});

test('a listing at or above the floor is left alone', () => {
  const plan = planTopup(catalog([
    { sku: 'AT', tiktok: tiktok(FLOOR) },
    { sku: 'OVER', tiktok: tiktok(223) },
  ]));
  assert.deepEqual(plan.changes, []);
});

test('each channel is topped up from its own number', () => {
  // There is no master ledger behind this - it has never been seeded - so a channel's
  // own figure is the only thing there is to add to.
  const plan = planTopup(catalog([{ sku: 'BOTH', tiktok: tiktok(10), shopee: shopee(80) }]));
  assert.deepEqual(plan.changes.map((c) => [c.channel, c.to]), [['tiktok', 110], ['shopee', 180]]);
});

test('Shopify is never written, because writing it is not built', () => {
  // Its stock lives in inventory levels tied to a location, so a plan including it would
  // silently fail a third of itself.
  const plan = planTopup(catalog([{ sku: 'S', shopify: { qty: 5, rows: [{ qty: 5 }], conflict: false } }]));
  assert.deepEqual(plan.changes, []);
});

test('a channel that disagrees with itself is skipped and said out loud', () => {
  // Several live listings reporting different quantities: picking one to write to is a
  // guess, and a guess landing on the wrong listing is worse than one saying "habis".
  const plan = planTopup(catalog([{ sku: 'C', tiktok: { qty: 5, conflict: true, rows: [{ qty: 5 }, { qty: 90 }] } }]));
  assert.deepEqual(plan.changes, []);
  assert.equal(plan.skipped[0].sku, 'C');
  assert.match(plan.skipped[0].reason, /tidak sepakat/);
});

test('a quantity the channel never reported is not a low quantity', () => {
  /*
   * The most dangerous reading in this file. Number(null) is 0, so a channel answering
   * without a quantity looked like a listing that had sold out - and would have been
   * written up to a hundred on the strength of nothing at all. "Unknown" is not "low".
   */
  for (const qty of [null, undefined, '', 'habis']) {
    const plan = planTopup(catalog([{ sku: 'U', tiktok: { qty, rows: [{ qty }], conflict: false } }]));
    assert.deepEqual(plan.changes, [], `qty=${JSON.stringify(qty)} tidak boleh ditulis`);
    assert.match(plan.skipped[0].reason, /tidak terbaca/);
  }
  // A real zero is a real sell-out, and that one is topped up.
  assert.equal(planTopup(catalog([{ sku: 'Z', tiktok: { qty: 0, rows: [{ qty: 0 }], conflict: false } }])).changes[0].to, 100);
});

test('a SKU not listed on a channel never has a listing created for it', () => {
  const plan = planTopup(catalog([{ sku: 'ONLY-TIKTOK', tiktok: tiktok(5) }]));
  assert.deepEqual(plan.changes.map((c) => c.channel), ['tiktok']);
});

test('one SKU on several live listings gets a write each', () => {
  const plan = planTopup(catalog([{
    sku: 'MULTI',
    tiktok: { qty: 5, conflict: false, rows: [{ qty: 5, skuId: 'a' }, { qty: 7, skuId: 'b' }] },
  }]));
  assert.deepEqual(plan.changes.map((c) => [c.ref.skuId, c.to]), [['a', 105], ['b', 107]]);
});

test('the emptiest listing is written first, and a cap says it bit', () => {
  const many = Array.from({ length: MAX_WRITES + 5 }, (_, i) => ({ sku: `S${i}`, tiktok: tiktok(90 - i) }));
  const plan = planTopup(catalog(many));
  assert.equal(plan.changes.length, MAX_WRITES);
  assert.equal(plan.overflow, 5, 'dikatakan, bukan diam-diam dipotong');
  // Closest to stopping goes first.
  assert.equal(plan.changes[0].from, 90 - (MAX_WRITES + 4));
});

test('the row is shaped exactly as the existing writer expects', () => {
  const plan = planTopup(catalog([{ sku: 'T', tiktok: tiktok(5), shopee: shopee(5) }]));
  const [tt, sp] = plan.changes;
  assert.deepEqual(Object.keys(tt.ref).sort(), ['productId', 'skuId', 'warehouseId']);
  assert.deepEqual(Object.keys(sp.ref).sort(), ['itemId', 'modelId']);
  for (const row of plan.changes) {
    for (const field of ['sku', 'channel', 'from', 'to', 'delta', 'ref']) {
      assert.ok(field in row, `${field} hilang dari baris ${row.channel}`);
    }
  }
});

test('the threshold and the amount are both adjustable', () => {
  const plan = planTopup(catalog([{ sku: 'X', tiktok: tiktok(180) }]), { floor: 200, add: 50 });
  assert.equal(plan.changes[0].to, 230);
});

test('an empty catalogue is a quiet no-op, not a crash', () => {
  assert.deepEqual(planTopup({ skus: [] }).changes, []);
  assert.deepEqual(planTopup(undefined).changes, []);
  assert.equal(describeTopup({ changes: [] }), 'tidak ada listing di bawah ambang');
});

test('the summary names the listings rather than only counting them', () => {
  const plan = planTopup(catalog([{ sku: 'OMC-90-001', tiktok: tiktok(12) }]));
  assert.match(describeTopup(plan), /OMC-90-001 tiktok 12→112/);
  assert.match(describeTopup(plan), new RegExp(`ditambah ${ADD}`));
});

test('the audit description survives a plan that is not planSync’s', async () => {
  /*
   * writeAudit calls describePlan for anything carrying `changes`, and describePlan used
   * to name all five of planSync's buckets unconditionally. The top-up plan has none of
   * them, so it threw on the first live run - nine writes to real listings went through
   * with no audit record behind them. The failure is caught and logged rather than
   * raised, which is right, and is also why it could have gone unnoticed.
   */
  const { describePlan } = await import('../src/stock-sync.js');
  const plan = planTopup(catalog([{ sku: 'A', tiktok: tiktok(5) }]));

  assert.doesNotThrow(() => describePlan(plan));
  assert.match(describePlan(plan), /1 perubahan siap/);
  assert.doesNotMatch(describePlan(plan), /ditinjau/, 'tidak menyebut keranjang yang tidak ada');

  // And planSync's own plan still reads exactly as it did.
  const full = { changes: [1], review: [], blocked: [], unchanged: [1, 2], unmanaged: [] };
  assert.equal(describePlan(full), '1 perubahan siap, 0 perlu ditinjau, 0 diblokir, 2 sudah sesuai, 0 di luar ledger');
});
