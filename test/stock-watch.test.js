import test from 'node:test';
import assert from 'node:assert/strict';
import { linesOf, seedMissing, applyOrders, topUpMaster, planFollow } from '../src/stock-follow.js';
import { followStock, followAfterOrder, resetStockWatch } from '../src/stock-watch.js';

/**
 * One number per product on every channel, and an order anywhere moves it everywhere.
 *
 * Jubelio did this until it was unlinked on 5 Oct 2026; without it a Shopee sale lowered
 * Shopee and nothing else. These are the cases where getting it wrong costs real stock:
 * an order counted twice, a cancellation never put back, history counted on top of a
 * seed that already reflects it.
 */

const row = (qty, over = {}) => ({ qty, ...over });
const bucket = (...rows) => ({ qty: Math.min(...rows.map((r) => r.qty)), rows, conflict: new Set(rows.map((r) => r.qty)).size > 1 });
const tt = (qty) => bucket(row(qty, { productId: 'p', skuId: 's', warehouseId: 'w' }));
const sp = (qty) => bucket(row(qty, { itemId: 1, modelId: 2 }));
const catalog = (skus) => ({ skus, errors: {} });
const T0 = 1_791_000_000;
const order = (id, stage, lines, createdAt = T0 + 60, channel = 'shopee') => ({ id, channel, stage, createdAt, lines: lines.map(([sku, qty]) => ({ sku, qty })) });
const seeded = (qty) => ({ skus: { 'OMC-90-001': { qty } }, applied: {}, follow_started_at: T0 });

test('an order comes off the master once, however many times it is pushed', () => {
  // Shopee pushes the same order on every status change; each push re-reads it.
  const sale = order('A', 'to_ship', [['OMC-90-001', 2]]);
  let { ledger } = applyOrders(seeded(150), [sale]);
  ({ ledger } = applyOrders(ledger, [{ ...sale, stage: 'shipping' }, { ...sale, stage: 'completed' }]));
  assert.equal(ledger.skus['OMC-90-001'].qty, 148);
});

test('every spelling of a SKU is the same jar', () => {
  // TikTok drops the -001; a free capsule consumes the same stock as a sold one.
  assert.deepEqual(linesOf({ lines: [{ sku: 'OMC90', qty: 1 }, { sku: 'OMC-90-001', qty: 2 }, { sku: 'FREE-OMC-90-001', qty: 1 }] }), { 'OMC-90-001': 4 });
  assert.deepEqual(linesOf({ lines: [{ sku: 'TIDAK-ADA', qty: 3 }] }), {}, 'SKU di luar master tidak menyentuh apa pun');
});

test('a cancellation puts the lines back, once', () => {
  let { ledger } = applyOrders(seeded(150), [order('A', 'unpaid', [['OMC-90-001', 3]])]);
  assert.equal(ledger.skus['OMC-90-001'].qty, 147);
  ({ ledger } = applyOrders(ledger, [order('A', 'cancelled', [['OMC-90-001', 3]])]));
  ({ ledger } = applyOrders(ledger, [order('A', 'cancelled', [['OMC-90-001', 3]])]));
  assert.equal(ledger.skus['OMC-90-001'].qty, 150);
});

test('an order already cancelled when first seen takes nothing and returns nothing', () => {
  const { ledger, touched } = applyOrders(seeded(150), [order('A', 'cancelled', [['OMC-90-001', 3]])]);
  assert.equal(ledger.skus['OMC-90-001'].qty, 150);
  assert.equal(touched.size, 0);
});

test('orders from before the seed are already in the figures the seed was read from', () => {
  const { ledger } = applyOrders(seeded(150), [order('OLD', 'completed', [['OMC-90-001', 5]], T0 - 3600)]);
  assert.equal(ledger.skus['OMC-90-001'].qty, 150);
});

test('the seed takes the lowest live figure across all three channels', () => {
  // Seeding high puts stock on a channel that does not have it; low only under-sells.
  const { ledger, seeded: fresh } = seedMissing({ skus: {} }, catalog([
    { sku: 'OMC-90-001', tiktok: tt(193), shopee: sp(189), shopify: bucket(row(198, { variantId: 'v1' }), row(102, { variantId: 'v2' })) },
  ]), { now: T0 * 1000 });
  assert.deepEqual(fresh, ['OMC-90-001']);
  assert.equal(ledger.skus['OMC-90-001'].qty, 102);
  assert.equal(ledger.follow_started_at, T0);
});

test('a master somebody set by hand is never reseeded', () => {
  const { ledger } = seedMissing({ skus: { 'OMC-90-001': { qty: 400, source: 'manual:ika' } } }, catalog([{ sku: 'OMC-90-001', tiktok: tt(10) }]));
  assert.equal(ledger.skus['OMC-90-001'].qty, 400);
});

test('the top-up is the operator rule on the master: under a hundred, add a hundred', () => {
  const { ledger, raised } = topUpMaster({ skus: { A: { qty: 99 }, B: { qty: 100 }, C: { qty: 2 } } });
  assert.deepEqual(raised.map((r) => [r.sku, r.to]), [['A', 199], ['C', 102]]);
  assert.equal(ledger.skus.B.qty, 100);
});

test('every listing that disagrees is written to the master, Shopify variants each', () => {
  const plan = planFollow(catalog([
    { sku: 'OMC-90-001', tiktok: tt(193), shopee: sp(102), shopify: bucket(row(198, { variantId: 'v1' }), row(102, { variantId: 'v2' })) },
    { sku: 'OTHER', tiktok: tt(5) },
  ]), { skus: { 'OMC-90-001': { qty: 102 } } });
  assert.deepEqual(plan.changes.map((c) => [c.channel, c.from, c.to, c.ref.variantId ?? null]), [['tiktok', 193, 102, null], ['shopify', 198, 102, 'v1']]);
  assert.ok(plan.changes.every((c) => c.target), 'Shopify ditulis sebagai target, bukan selisih');
});

test('a channel that reported no figure is not corrected on the strength of nothing', () => {
  const plan = planFollow(catalog([{ sku: 'A', tiktok: bucket(row(null, { productId: 'p' })) }]), { skus: { A: { qty: 150 } } });
  assert.deepEqual(plan.changes, []);
});

/* --------------------------------------------------------------------- the runner */

const memoryStore = (initial = null) => {
  let doc = initial;
  return {
    update: async (key, fn, empty) => { doc = fn(doc ?? structuredClone(empty)); return doc; },
    get: () => doc,
  };
};

test('an order on one channel moves the others to the same figure', async () => {
  resetStockWatch();
  const store = memoryStore(seeded(150));
  const writes = [];
  // Shopee already took its own sale off (149); TikTok and Shopify have not heard.
  const read = async () => catalog([{ sku: 'OMC-90-001', tiktok: tt(150), shopee: sp(149), shopify: bucket(row(150, { variantId: 'v' })) }]);
  const out = await followStock({
    orders: [order('A', 'to_ship', [['OMC-90-001', 1]])], read, update: store.update, now: (T0 + 120) * 1000,
    apply: async (plan) => { writes.push(...plan.changes); return { succeeded: plan.changes.length, failed: 0, results: plan.changes.map((c) => ({ ...c, status: 'ok' })) }; },
  });
  assert.equal(store.get().skus['OMC-90-001'].qty, 149);
  assert.deepEqual(writes.map((w) => [w.channel, w.to]), [['tiktok', 149], ['shopify', 149]]);
  assert.equal(out.written, 2);
});

test('an incomplete catalogue moves nothing and writes nothing', async () => {
  resetStockWatch();
  const store = memoryStore(seeded(150));
  let applied = 0;
  const out = await followStock({
    orders: [order('A', 'to_ship', [['OMC-90-001', 1]])], update: store.update,
    read: async () => ({ skus: [], errors: { shopee: 'timeout' } }),
    apply: async () => { applied += 1; return { succeeded: 0, failed: 0, results: [] }; },
  });
  assert.match(out.reason, /tidak lengkap/);
  assert.equal(applied, 0);
  assert.equal(store.get().skus['OMC-90-001'].qty, 150, 'pesanan dihitung run berikutnya, bukan dibuang');
});

test('orders arriving during a run are all counted, none skipped for a cooldown', async () => {
  resetStockWatch();
  const store = memoryStore(seeded(150));
  const read = async () => { await new Promise((r) => setTimeout(r, 5)); return catalog([{ sku: 'OMC-90-001', tiktok: tt(150) }]); };
  const apply = async (plan) => ({ succeeded: plan.changes.length, failed: 0, results: [] });
  const opts = { read, apply, update: store.update, now: (T0 + 120) * 1000 };
  const first = followAfterOrder(order('A', 'to_ship', [['OMC-90-001', 1]]), opts);
  followAfterOrder(order('B', 'to_ship', [['OMC-90-001', 2]]), opts);
  followAfterOrder(order('C', 'to_ship', [['OMC-90-001', 3]]), opts);
  await first;
  assert.equal(store.get().skus['OMC-90-001'].qty, 144);
});

test('it never throws at the webhook that called it', async () => {
  resetStockWatch();
  const out = await followAfterOrder(order('A', 'to_ship', [['OMC-90-001', 1]]), { read: async () => { throw new Error('boom'); } });
  assert.equal(out.error, 'boom');
});
