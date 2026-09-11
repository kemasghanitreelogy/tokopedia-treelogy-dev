import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPicklist, ordersForSku, PICKABLE_STAGES } from '../src/picklist.js';

const order = (channel, stage, lines, id = 'o1') => ({ id, channel, stage, buyer: 'b', createdAt: 1, lines });

test('only orders waiting to ship are pickable', () => {
  const pl = buildPicklist([
    order('shopee', 'to_ship', [{ sku: 'A', name: 'A', qty: 2 }]),
    order('shopee', 'unpaid', [{ sku: 'A', name: 'A', qty: 9 }]),
    order('shopee', 'shipping', [{ sku: 'A', name: 'A', qty: 9 }]),
    order('shopee', 'cancelled', [{ sku: 'A', name: 'A', qty: 9 }]),
  ]);
  assert.equal(pl.unitCount, 2);
  assert.equal(pl.orderCount, 1);
});

test('quantities aggregate across channels and orders', () => {
  const pl = buildPicklist([
    order('shopee', 'to_ship', [{ sku: 'A', name: 'A', qty: 2 }], 'o1'),
    order('tokopedia', 'to_ship', [{ sku: 'A', name: 'A', qty: 3 }], 'o2'),
    order('tiktok_shop', 'to_ship', [{ sku: 'B', name: 'B', qty: 1 }], 'o3'),
  ]);
  const a = pl.items.find((i) => i.sku === 'A');
  assert.equal(a.qty, 5);
  assert.equal(a.orders, 2);
  assert.equal(a.byChannel.shopee, 2);
  assert.equal(a.byChannel.tokopedia, 3);
  assert.equal(pl.skuCount, 2);
});

test('the list is ordered by quantity so the biggest pick comes first', () => {
  const pl = buildPicklist([
    order('shopee', 'to_ship', [{ sku: 'small', name: '', qty: 1 }, { sku: 'big', name: '', qty: 9 }]),
  ]);
  assert.equal(pl.items[0].sku, 'big');
});

test('an empty queue produces an empty list, not a crash', () => {
  const pl = buildPicklist([]);
  assert.deepEqual(pl.items, []);
  assert.equal(pl.unitCount, 0);
});

test('orders behind a SKU can be listed for a shortage', () => {
  const rows = ordersForSku([
    order('shopee', 'to_ship', [{ sku: 'A', name: '', qty: 2 }], 'o1'),
    order('shopee', 'to_ship', [{ sku: 'B', name: '', qty: 1 }], 'o2'),
  ], 'A');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'o1');
  assert.equal(rows[0].qty, 2);
});

test('shipped orders are deliberately excluded from the pickable set', () => {
  assert.equal(PICKABLE_STAGES.has('shipping'), false);
  assert.equal(PICKABLE_STAGES.has('to_ship'), true);
});
