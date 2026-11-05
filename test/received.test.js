import test from 'node:test';
import assert from 'node:assert/strict';
import { syncReceived, loadReceived, applyReceived, receivedDoc, readTikTokStatements } from '../src/received.js';
import { summarize } from '../src/omni.js';
import { readDoc, deleteDoc } from '../src/store/index.js';

const NOV = Date.UTC(2026, 10, 3) / 1000;
const order = (channel, id, stage, extra = {}) => ({ channel, id, stage, createdAt: NOV, total: 100, ...extra });
const none = async () => new Map();
const noStatements = async () => ({ found: new Map() });
const clean = () => deleteDoc(receivedDoc('2026-11')).catch(() => {});

test('Shopee is an estimate until the order completes, and a final figure is not asked again', async (t) => {
  t.after(clean);
  await clean();
  const orders = [order('shopee', 'A', 'shipping'), order('shopee', 'B', 'completed')];
  const asked = [];
  const readShopee = async (ids) => { asked.push(ids); return new Map(ids.map((id) => [id, 481825])); };
  const run = () => syncReceived({ now: NOV + 60, readOrders: async () => orders, readShopee, readUnsettled: none, readSettled: noStatements });
  await run();
  await run();
  assert.deepEqual(asked, [['A', 'B'], ['A']]);
  const got = applyReceived(orders.map((o) => ({ ...o })), await loadReceived(orders));
  assert.deepEqual(got.map((o) => o.received), [{ amount: 481825, estimate: true }, { amount: 481825, estimate: false }]);
});

test('a settled figure beats an estimate, and an order in neither stays unread', async (t) => {
  t.after(clean);
  await clean();
  const orders = [order('tokopedia', 'U', 'shipping'), order('tiktok_shop', 'S', 'completed'), order('tokopedia', 'W', 'delivered')];
  const r = await syncReceived({
    now: NOV + 60,
    readOrders: async () => orders,
    readUnsettled: async () => new Map([['U', 378675], ['S', 1]]),
    readSettled: async () => ({ found: new Map([['S', 363742]]) }),
  });
  assert.deepEqual([r.final, r.estimate], [1, 1]);
  const { orders: stored } = await readDoc(receivedDoc('2026-11'));
  assert.deepEqual(stored.U, { a: 378675, e: 1 });
  assert.deepEqual(stored.S, { a: 363742 });
  assert.equal(stored.W, undefined);
});

test('statements skip adjustment-only days, page through, and add up an order', async () => {
  const asked = [];
  const ask = async (_, path, query) => {
    asked.push(path);
    if (path.endsWith('/statements')) {
      return query.page_token
        ? { statements: [{ id: 'b', revenue_amount: '10' }] }
        : { statements: [{ id: 'a', revenue_amount: '10' }, { id: 'adj', revenue_amount: '0' }], next_page_token: 'p2' };
    }
    if (path.includes('/a/')) {
      return query.page_token
        ? { transactions: [{ type: 'ORDER', order_id: 'X', settlement_amount: '5' }] }
        : { transactions: [{ type: 'ORDER', order_id: 'X', settlement_amount: '100' }, { type: 'SHIPPING_FEE', order_id: 'X', settlement_amount: '9' }], next_page_token: 'r2' };
    }
    return { transactions: [{ type: 'ORDER', order_id: 'Y', settlement_amount: '7' }] };
  };
  const { found, error } = await readTikTokStatements({ since: 1, now: 2, ask, config: {} });
  assert.equal(error, undefined);
  assert.deepEqual([...found], [['X', 105], ['Y', 7]]);
  assert.equal(asked.some((path) => path.includes('/adj/')), false);
});

test('a limit hit midway keeps the statements already read, and the run still stores them', async (t) => {
  t.after(clean);
  await clean();
  const ask = async (_, path) => {
    if (path.endsWith('/statements')) return { statements: [{ id: 'a', revenue_amount: '1' }, { id: 'b', revenue_amount: '1' }] };
    if (path.includes('/b/')) throw new Error('Too many requests');
    return { transactions: [{ type: 'ORDER', order_id: 'A', settlement_amount: '7' }] };
  };
  const r = await syncReceived({
    now: NOV + 60, readOrders: async () => [order('tokopedia', 'A', 'delivered')], readUnsettled: none,
    readSettled: (args) => readTikTokStatements({ ...args, ask, config: {} }),
  });
  assert.equal(r.errors.tiktok, 'Too many requests');
  assert.deepEqual((await readDoc(receivedDoc('2026-11'))).orders.A, { a: 7 });
});

test('one platform failing does not cost the other its run', async (t) => {
  t.after(clean);
  await clean();
  const orders = [order('shopee', 'A', 'completed'), order('tokopedia', 'U', 'shipping')];
  const r = await syncReceived({
    now: NOV + 60, readOrders: async () => orders,
    readShopee: async () => { throw new Error('shopee down'); },
    readUnsettled: async () => new Map([['U', 1]]), readSettled: noStatements,
  });
  assert.equal(r.errors.shopee, 'shopee down');
  assert.equal(r.estimate, 1);
});

test('a dry run stores nothing', async (t) => {
  t.after(clean);
  await clean();
  await syncReceived({
    now: NOV + 60, dryRun: true, readOrders: async () => [order('tokopedia', 'U', 'shipping')],
    readUnsettled: async () => new Map([['U', 1]]), readSettled: noStatements,
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
