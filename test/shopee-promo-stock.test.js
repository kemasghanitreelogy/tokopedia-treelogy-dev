import test from 'node:test';
import assert from 'node:assert/strict';
import { shopeeStock, mergeCatalog } from '../src/inventory.js';
import { planFollow } from '../src/stock-follow.js';
import { shopeeStockRefusal } from '../src/stock-sync.js';

// Shopee's answer for OMC-180-001 on 8 Nov 2026, while a Seller Streaming (live) promotion
// held every unit.
const LIVE_HELD = {
  summary_info: { total_reserved_stock: 120, total_available_stock: 0 },
  seller_stock: [{ location_id: 'IDZ', stock: 120, if_saleable: true }],
  shopee_stock: [{ location_id: '', stock: 0 }],
};

test('a listing held by a promotion reads as its seller stock, not 0', () => {
  assert.deepEqual(shopeeStock(LIVE_HELD), { qty: 120, available: 0, reserved: 120 });
});

test('without seller_stock the figure is available plus reserved', () => {
  assert.deepEqual(
    shopeeStock({ summary_info: { total_available_stock: 7, total_reserved_stock: 3 } }),
    { qty: 10, available: 7, reserved: 3 },
  );
  assert.deepEqual(shopeeStock(undefined), { qty: 0, available: 0, reserved: 0 });
});

test('the follower leaves a promo-held listing alone when it already matches the master', () => {
  const catalog = mergeCatalog({
    shopee: [{ sku: 'OMC-180-001', status: 'NORMAL', itemId: 48200274325, modelId: 277825846980, ...shopeeStock(LIVE_HELD) }],
  });
  const ledger = { skus: { 'OMC-180-001': { qty: 120 } } };
  assert.deepEqual(planFollow(catalog, ledger).changes, []);
});

test('a write below what the promotion holds carries the reason Shopee does not give', () => {
  const catalog = mergeCatalog({
    shopee: [{ sku: 'OMC-180-001', status: 'NORMAL', itemId: 48200274325, modelId: 277825846980, ...shopeeStock(LIVE_HELD) }],
  });
  const [row] = planFollow(catalog, { skus: { 'OMC-180-001': { qty: 119 } } }).changes;
  assert.equal(row.reserved, 120);
  const refusal = shopeeStockRefusal(row, new Error('update stock failed'));
  assert.match(refusal.message, /120 unit dikunci promo/);
  assert.match(refusal.message, /update stock failed/);

  const plain = new Error('other');
  assert.equal(shopeeStockRefusal({ ...row, reserved: 0 }, plain), plain);
});
