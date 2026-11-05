import test from 'node:test';
import assert from 'node:assert/strict';
import { syncReceived, loadReceived, applyReceived, receivedDoc } from '../src/received.js';
import { summarize } from '../src/omni.js';
import { readDoc, deleteDoc } from '../src/store/index.js';

const NOV = Date.UTC(2026, 10, 3) / 1000;
const order = (channel, id, stage, extra = {}) => ({ channel, id, stage, createdAt: NOV, total: 100, ...extra });
const none = async () => new Map();
const quick = { pauseMs: 0 };
const clean = () => deleteDoc(receivedDoc('2026-11')).catch(() => {});

test('Shopee is an estimate until the order completes, and a final figure is not asked again', async (t) => {
  t.after(clean);
  await clean();
  const orders = [order('shopee', 'A', 'shipping'), order('shopee', 'B', 'completed')];
  const asked = [];
  const readShopee = async (ids) => { asked.push(ids); return new Map(ids.map((id) => [id, 481825])); };
  const run = () => syncReceived({ now: NOV + 60, readOrders: async () => orders, readShopee, readUnsettled: none });
  await run();
  await run();
  assert.deepEqual(asked, [['A', 'B'], ['A']]);
  const got = applyReceived(orders.map((o) => ({ ...o })), await loadReceived(orders));
  assert.deepEqual(got.map((o) => o.received), [{ amount: 481825, estimate: true }, { amount: 481825, estimate: false }]);
});

test('TikTok reads the unsettled list first, and only asks per order for what left it', async (t) => {
  t.after(clean);
  await clean();
  const orders = [
    order('tokopedia', 'U', 'shipping'), order('tiktok_shop', 'S', 'completed'),
    order('tokopedia', 'W', 'delivered'), order('tokopedia', 'X', 'cancelled'),
  ];
  const asked = [];
  const r = await syncReceived({
    ...quick, now: NOV + 60,
    readOrders: async () => orders,
    readUnsettled: async () => new Map([['U', 378675]]),
    readSettled: async (id) => { asked.push(id); return id === 'S' ? 363742 : null; },
  });
  assert.deepEqual(asked.sort(), ['S', 'W']);
  assert.deepEqual([r.final, r.estimate, r.waiting], [1, 1, 1]);
  const { orders: stored } = await readDoc(receivedDoc('2026-11'));
  assert.deepEqual(stored.U, { a: 378675, e: 1 });
  assert.deepEqual(stored.S, { a: 363742 });
  assert.equal(stored.W.a, undefined);
});

test('an order with no answer waits before it is asked again, and keeps its estimate', async (t) => {
  t.after(clean);
  await clean();
  const orders = [order('tokopedia', 'E', 'delivered')];
  const asked = [];
  const pass = (now, unsettled) => syncReceived({
    ...quick, now, readOrders: async () => orders, readUnsettled: async () => unsettled,
    readSettled: async (id) => { asked.push(id); return null; },
  });
  await pass(NOV + 60, new Map([['E', 500]]));
  await pass(NOV + 120, new Map());
  await pass(NOV + 180, new Map());
  assert.equal(asked.length, 1);
  const { orders: stored } = await readDoc(receivedDoc('2026-11'));
  assert.equal(stored.E.a, 500);
  assert.equal(stored.E.e, 1);
});

test('one platform failing does not cost the other its run', async (t) => {
  t.after(clean);
  await clean();
  const orders = [order('shopee', 'A', 'completed'), order('tokopedia', 'U', 'shipping')];
  const r = await syncReceived({
    ...quick, now: NOV + 60, readOrders: async () => orders,
    readShopee: async () => { throw new Error('shopee down'); },
    readUnsettled: async () => new Map([['U', 1]]),
  });
  assert.equal(r.errors.shopee, 'shopee down');
  assert.equal(r.estimate, 1);
});

test('a TikTok refusal stops the lookups and keeps what was already read', async (t) => {
  t.after(clean);
  await clean();
  const orders = [order('tokopedia', 'A', 'delivered'), order('tokopedia', 'B', 'delivered'), order('tokopedia', 'C', 'delivered')];
  const asked = [];
  const r = await syncReceived({
    ...quick, now: NOV + 60, readOrders: async () => orders, readUnsettled: none,
    readSettled: async (id) => { asked.push(id); if (id === 'B') throw new Error('Too many requests'); return 7; },
  });
  assert.deepEqual(asked, ['A', 'B']);
  assert.equal(r.errors.tiktok, 'Too many requests');
  const { orders: stored } = await readDoc(receivedDoc('2026-11'));
  assert.deepEqual(stored.A, { a: 7 });
});

test('a dry run stores nothing', async (t) => {
  t.after(clean);
  await clean();
  await syncReceived({
    ...quick, now: NOV + 60, dryRun: true, readOrders: async () => [order('tokopedia', 'U', 'shipping')],
    readUnsettled: async () => new Map([['U', 1]]),
  });
  assert.equal(await readDoc(receivedDoc('2026-11')).catch(() => null), null);
});

test('marketplaces sum what they pay out, Shopify keeps its sale value, the gross figure stays', () => {
  const line = { sku: 'x', qty: 1, unitPrice: 565000, unitDiscount: 0 };
  const shopee = { ...order('shopee', 'A', 'completed', { total: 488750 }), finance: { lines: [line], shipping: 0 }, received: { amount: 481825, estimate: false } };
  const unread = { ...order('tokopedia', 'B', 'to_ship', { total: 400000 }), finance: { lines: [line], shipping: 0 } };
  const shopify = order('shopify', '#1', 'completed', { total: 500000 });
  const cancelled = { ...order('shopee', 'C', 'cancelled'), received: { amount: 999, estimate: false } };
  const { all, byChannel } = summarize([shopee, unread, shopify, cancelled]);
  assert.equal(byChannel.shopee.received, 481825);
  assert.equal(byChannel.tokopedia.received, 0);
  assert.equal(byChannel.shopify.received, 500000);
  assert.equal(all.received, 981825);
  assert.equal(all.revenue, 565000 * 2 + 500000);
});
