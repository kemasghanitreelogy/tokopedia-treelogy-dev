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
