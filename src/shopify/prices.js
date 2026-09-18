import { readDoc, writeDoc } from '../store/index.js';
import { fetchProducts } from './shop.js';
import { isShopifyConfigured } from './config.js';
import { PRODUCTS } from '../master.js';

/**
 * What each SKU sells for, copied out of Shopify and kept in our own store.
 *
 * The manual transaction form needs a price the moment somebody picks a product, and a
 * form that waits on Shopify to render is a form that hangs when Shopify is slow - or
 * that cannot be opened at all when the token has expired. So the shop's own prices are
 * read on a schedule and written down here, and the form reads this.
 *
 * Shopify is the source because it is the only channel whose listing price is the seller's
 * own decision rather than a marketplace's: what the storefront charges is what a
 * consignment slip or a WhatsApp sale should be written up at.
 */

export const PRICES_DOC = 'catalog/shopify-prices.json';
const EMPTY = { version: 1, syncedAt: 0, prices: {} };

/** @returns {Promise<{syncedAt: number, prices: Record<string, {price: number, title: string}>}>} */
export async function loadShopifyPrices() {
  const doc = await readDoc(PRICES_DOC).catch(() => null);
  return { syncedAt: doc?.syncedAt ?? 0, prices: doc?.prices ?? {} };
}

/** Just the numbers, for a caller that only wants to fill a field. */
export async function priceBySku() {
  const { prices } = await loadShopifyPrices();
  return Object.fromEntries(Object.entries(prices).map(([sku, row]) => [sku, row.price]));
}

/**
 * Read every live variant's price from Shopify and write the lot down.
 *
 * Draft and archived products are skipped: a price nobody can buy at is not a price to
 * write a sale at. A variant with no SKU is skipped too - there is nothing to key it by.
 *
 * `read` is injectable so the shape this depends on is pinned by a test rather than by
 * memory. It was written against the nested GraphQL shape once, while fetchProducts
 * hands back a flat list of variants, and the result was a sync that reported success
 * and wrote nothing at all.
 *
 * @returns {Promise<{written: number, skipped: number, unknown: string[], syncedAt: number}>}
 */
export async function syncShopifyPrices({ now = Math.floor(Date.now() / 1000), read = fetchProducts } = {}) {
  if (!isShopifyConfigured()) throw new Error('Shopify belum dikonfigurasi');

  const variants = await read();
  const prices = {};
  let skipped = 0;
  for (const variant of variants) {
    const sku = String(variant.sku ?? '').trim();
    const price = Math.round(Number(variant.price) || 0);
    if (variant.status !== 'ACTIVE' || !sku || price <= 0) { skipped += 1; continue; }
    // Two variants can share a SKU across products; the dearer one is the safer default,
    // because a price typed too low is money gone and a price typed too high is a question.
    if (!prices[sku] || price > prices[sku].price) {
      prices[sku] = { price, title: variant.title ?? '' };
    }
  }

  await writeDoc(PRICES_DOC, { ...EMPTY, syncedAt: now, prices });

  // The useful half of the report: SKUs we sell that Shopify gave no price for. Those
  // are the ones somebody will still have to type by hand.
  const unknown = PRODUCTS.map((p) => p.sku).filter((sku) => !prices[sku]);
  return { written: Object.keys(prices).length, skipped, unknown, syncedAt: now };
}
