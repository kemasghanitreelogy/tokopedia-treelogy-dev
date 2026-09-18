import test from 'node:test';
import assert from 'node:assert/strict';
import { PRICES_DOC, loadShopifyPrices, priceBySku } from '../src/shopify/prices.js';
import { writeDoc, deleteDoc, closeStore } from '../src/store/index.js';

test.after(async () => { await closeStore(); });

test('with nothing synced yet the form simply has no prices to offer', async () => {
  await deleteDoc(PRICES_DOC);
  assert.deepEqual(await loadShopifyPrices(), { syncedAt: 0, prices: {} });
  assert.deepEqual(await priceBySku(), {});
});

test('prices are read from our own store, never from Shopify, and keyed by SKU', async () => {
  await writeDoc(PRICES_DOC, {
    version: 1,
    syncedAt: 1789200000,
    prices: { 'OMC-270-001': { price: 1145000, title: 'Organic Moringa Capsules' } },
  });
  const { syncedAt, prices } = await loadShopifyPrices();
  assert.equal(syncedAt, 1789200000);
  assert.equal(prices['OMC-270-001'].price, 1145000);
  assert.deepEqual(await priceBySku(), { 'OMC-270-001': 1145000 });
  await deleteDoc(PRICES_DOC);
});

test('the sync reads the shape fetchProducts actually returns, not the one the query has', async () => {
  // fetchProducts flattens products into one row per variant. Written against the nested
  // GraphQL shape, this reported success and stored nothing - so the shape is pinned here.
  const { syncShopifyPrices } = await import('../src/shopify/prices.js');
  const before = process.env.SHOPIFY_ADMIN_API;
  process.env.SHOPIFY_ADMIN_API = 'shpat_test';
  try {
    const result = await syncShopifyPrices({
      now: 1789200000,
      read: async () => [
        { sku: 'OMP-45-001', price: 370000, status: 'ACTIVE', title: 'Organic Moringa Powder' },
        { sku: 'OMP-90-001', price: 625000, status: 'ACTIVE', title: 'Organic Moringa Powder' },
        { sku: 'OMP-45-001', price: 399000, status: 'ACTIVE', title: 'Bundle' },
        { sku: 'ARCHIVED-1', price: 100000, status: 'ARCHIVED', title: 'Gone' },
        { sku: '', price: 50000, status: 'ACTIVE', title: 'No SKU' },
        { sku: 'FREE-1', price: 0, status: 'ACTIVE', title: 'Gift' },
      ],
    });
    assert.equal(result.written, 2);
    assert.equal(result.skipped, 3);

    const { prices, syncedAt } = await loadShopifyPrices();
    assert.equal(syncedAt, 1789200000);
    assert.equal(prices['OMP-90-001'].price, 625000);
    // A SKU listed twice keeps the dearer price: too low is money gone, too high is a question.
    assert.equal(prices['OMP-45-001'].price, 399000);
    assert.equal(prices['ARCHIVED-1'], undefined);
    assert.ok(result.unknown.includes('OMC-270-001'), 'SKU master tanpa harga dilaporkan');
  } finally {
    if (before === undefined) delete process.env.SHOPIFY_ADMIN_API;
    else process.env.SHOPIFY_ADMIN_API = before;
    await deleteDoc(PRICES_DOC);
  }
});
