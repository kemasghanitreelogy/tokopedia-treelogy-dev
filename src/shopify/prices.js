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
const EMPTY = { version: 1, syncedAt: 0, prices: {}, conflicts: [] };

/** @returns {Promise<{syncedAt: number, prices: Record<string, {price: number, title: string}>}>} */
export async function loadShopifyPrices() {
  const doc = await readDoc(PRICES_DOC).catch(() => null);
  return { syncedAt: doc?.syncedAt ?? 0, prices: doc?.prices ?? {}, conflicts: doc?.conflicts ?? [] };
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
  const seen = new Map();
  let skipped = 0;
  for (const variant of variants) {
    const sku = String(variant.sku ?? '').trim();
    const price = Math.round(Number(variant.price) || 0);
    if (variant.status !== 'ACTIVE' || !sku || price <= 0) { skipped += 1; continue; }

    if (!seen.has(sku)) seen.set(sku, new Set());
    seen.get(sku).add(price);

    /*
     * The lowest live price, not the highest.
     *
     * Two products can carry the same SKU, and this shop has six that do - two of them
     * disagreeing, because a listing was duplicated and only one copy was ever marked
     * down. Taking the dearer was meant to be cautious about typing errors, and instead
     * it put the price nobody is charged into the form: Rp1.265.000 for a bundle the
     * storefront sells at Rp1.045.000, which is that listing's crossed-out price to the
     * rupiah. What a buyer pays is what a consignment slip is written up at.
     *
     * compareAtPrice is never read here, and never should be - it is the number with the
     * line through it.
     */
    if (!prices[sku] || price < prices[sku].price) {
      prices[sku] = { price, title: variant.title ?? '' };
    }
  }

  // Said out loud rather than resolved quietly: one SKU on two live listings at two
  // prices is a thing to fix in Shopify, not a thing for this file to pick a winner in.
  const conflicts = [...seen]
    .filter(([, set]) => set.size > 1)
    .map(([sku, set]) => ({ sku, prices: [...set].sort((a, b) => a - b), used: prices[sku].price }));

  await writeDoc(PRICES_DOC, { ...EMPTY, syncedAt: now, prices, conflicts });

  // The useful half of the report: SKUs we sell that Shopify gave no price for. Those
  // are the ones somebody will still have to type by hand.
  const unknown = PRODUCTS.map((p) => p.sku).filter((sku) => !prices[sku]);
  return { written: Object.keys(prices).length, skipped, unknown, conflicts, syncedAt: now };
}
