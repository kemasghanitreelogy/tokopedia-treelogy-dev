import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Shopify is changed in Shopify, never from the dashboard.
 *
 * Found the hard way on 7 Oct 2026: a price request naming only Shopify was filtered to
 * no channel at all and fell through to an old "no channel means both marketplaces"
 * default, rewriting OMP-45-001's live price on Tokopedia/TikTok and Shopee for about a
 * minute. Every write that names only Shopify must be refused before anything is read.
 */

// No channel tokens exist in the test store, so even a guard that failed could not write.
const { handleWrite } = await import('../api/dashboard.js');
const owner = { id: 'owner', email: 'o@x', name: 'O', role: 'owner', status: 'active' };
const form = (pairs) => { const f = new URLSearchParams(); for (const [k, v] of pairs) f.append(k, v); return f; };

for (const [label, pairs] of [
  ['harga', [['action', 'price'], ['sku', 'OMP-45-001'], ['price', '370000'], ['channel', 'shopify']]],
  ['nonaktifkan', [['action', 'listing_active'], ['sku', 'OMP-45-001'], ['channel', 'shopify'], ['active', '0']]],
  ['publikasikan', [['action', 'product_publish'], ['sku', 'OMP-45-001'], ['channel', 'shopify']]],
  ['massal harga', [['action', 'bulk_price'], ['sku', 'OMP-45-001'], ['price', '370000'], ['channel', 'shopify']]],
  ['massal nonaktif', [['action', 'bulk_active'], ['sku', 'OMP-45-001'], ['channel', 'shopify'], ['active', '0']]],
  ['massal publikasi', [['action', 'bulk_publish'], ['sku', 'OMP-45-001'], ['channel', 'shopify']]],
  ['ubah listing', [['action', 'listing_edit'], ['sku', 'OMP-45-001'], ['channel', 'shopify'], ['title', 'x baru']]],
]) {
  test(`${label} yang hanya menyebut Shopify ditolak, tidak jatuh ke kanal lain`, async () => {
    await assert.rejects(() => handleWrite(form(pairs), '127.0.0.1', owner, 'csrf'), /Shopify dikelola langsung di Shopify/);
  });
}

test('a price request naming no channel at all is refused, not sent to both marketplaces', async () => {
  await assert.rejects(() => handleWrite(form([['action', 'price'], ['sku', 'OMP-45-001'], ['price', '370000']]), '127.0.0.1', owner, 'csrf'), /pilih minimal satu kanal/);
});
