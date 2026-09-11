import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCatalog, WRITABLE_STATUS } from '../src/inventory.js';

const row = (sku, qty, extra = {}) => ({ sku, qty, price: 1000, title: 'T', status: 'ACTIVATE', ...extra });
const shopeeRow = (sku, qty, extra = {}) => row(sku, qty, { status: 'NORMAL', ...extra });
const shopifyRow = (sku, qty, extra = {}) => row(sku, qty, { status: 'ACTIVE', ...extra });

test('only live listings count; dead ones are ignored, not merged', () => {
  // The shop has old DELETED / SELLER_DEACTIVATED products reusing a live seller_sku.
  // Letting one win reported the wrong stock for a product that was selling fine.
  const { skus } = mergeCatalog({
    tiktok: [row('A', 50), row('A', 0, { status: 'DELETED' }), row('A', 7, { status: 'SELLER_DEACTIVATED' })],
  });
  assert.equal(skus.length, 1);
  assert.equal(skus[0].tiktok.qty, 50);
  assert.equal(skus[0].tiktok.ignored.length, 2);
});

test('a SKU with only dead listings is absent from that channel, not zero', () => {
  // Reporting 0 would read as "out of stock" instead of "not listed".
  const { skus } = mergeCatalog({ tiktok: [row('A', 9, { status: 'DELETED' })] });
  assert.equal(skus[0].tiktok, null);
  assert.equal(skus[0].tiktok_ignored.length, 1);
});

test('two live listings disagreeing take the lower value and raise a conflict', () => {
  // Taking the higher one would let the shop sell stock it does not have.
  const { skus } = mergeCatalog({ tiktok: [row('A', 40), row('A', 25)] });
  assert.equal(skus[0].tiktok.qty, 25);
  assert.equal(skus[0].tiktok.conflict, true);
});

test('a channel-specific SKU folds onto its master product', () => {
  // Shopify lists the pouch as GFT-POUCH-001, the marketplaces as Travel-Pouch.
  const { skus } = mergeCatalog({
    tiktok: [row('Travel-Pouch', 275)],
    shopify: [shopifyRow('GFT-POUCH-001', 103)],
  });
  assert.equal(skus.length, 1, 'the same product must not split into two rows');
  assert.equal(skus[0].sku, 'Travel-Pouch');
  assert.equal(skus[0].tiktok.qty, 275);
  assert.equal(skus[0].shopify.qty, 103);
});

test('each channel keeps its own quantity and price', () => {
  const { skus } = mergeCatalog({
    tiktok: [row('OMP-45-001', 106, { price: 395000 })],
    shopee: [shopeeRow('OMP-45-001', 106, { price: 395000 })],
    shopify: [shopifyRow('OMP-45-001', 106, { price: 370000 })],
  });
  const entry = skus[0];
  assert.equal(entry.tiktok.price, 395000);
  assert.equal(entry.shopify.price, 370000, 'Shopify prices are deliberately lower');
});

test('a channel that errored contributes nothing but is reported', () => {
  const { skus, errors } = mergeCatalog({
    tiktok: [row('A', 5)],
    errors: { shopee: 'rate limit' },
  });
  assert.equal(skus[0].shopee, null);
  assert.deepEqual(errors, { shopee: 'rate limit' });
});

test('results are sorted so the page order is stable between reads', () => {
  const { skus } = mergeCatalog({ tiktok: [row('Z', 1), row('A', 1), row('M', 1)] });
  assert.deepEqual(skus.map((s) => s.sku), ['A', 'M', 'Z']);
});

test('every channel declares which statuses may be written to', () => {
  for (const channel of ['tiktok', 'shopee', 'shopify']) {
    assert.ok(WRITABLE_STATUS[channel]?.size > 0, `${channel} has no writable status`);
  }
  assert.ok(!WRITABLE_STATUS.tiktok.has('DELETED'));
  assert.ok(!WRITABLE_STATUS.shopee.has('UNLIST'));
});

test('merging nothing yields an empty catalogue, not a crash', () => {
  const { skus, errors } = mergeCatalog();
  assert.deepEqual(skus, []);
  assert.deepEqual(errors, {});
});
