import { fetchTikTokOrders, fetchShopeeOrders, tiktokConfig } from './omni.js';
import { fetchOrders as fetchShopifyOrders } from './shopify/shop.js';
import { shopifyGraphql } from './shopify/client.js';
import { monthBounds, monthsSince } from './history/store.js';
import { DEMAND_STAGES, HISTORY_STARTS } from './history/ingest.js';
import { ReadOnlyError, isReadOnly } from './stock-sync.js';

/**
 * "Trusted by more than N customers" on the storefront: every distinct buyer who ever
 * bought, counted per channel from the platforms themselves, every night.
 *
 * Not from the stored history: that keeps `order.buyer` hashed, which on Tokopedia and
 * TikTok is the masked recipient name rather than the buyer account, so it both splits
 * one buyer in two and merges strangers who share a mask.
 *
 * One person who buys on two channels counts twice - the marketplaces hide email and
 * phone, so there is nothing to join them on. Inside a channel the count is exact.
 */

export const METAFIELD = { namespace: 'treelogy', key: 'unique_buyers' };

/** A run that lands this far below the published figure is a partial answer, not a fact. */
export const MAX_DROP = 0.01;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/** The key that names one buyer on one channel, or '' when the order carries none. */
export function buyerKey(order) {
  if (order.channel === 'shopify') {
    return norm(order.buyerEmail) || norm(order.buyerPhone).replace(/\D/g, '') || norm(order.buyer);
  }
  if (order.channel === 'shopee') return norm(order.buyer);
  // Tokopedia and TikTok Shop: the @scs2.tiktok.com relay is per buyer account.
  return norm(order.buyerEmail) || norm(order.buyer);
}

async function pullMonth(source, month) {
  const { since, until } = monthBounds(month);
  if (source === 'shopify') return fetchShopifyOrders({ since, until, max: 5000 });
  if (source === 'shopee') return (await fetchShopeeOrders({ since, until, max: 5000, tracking: false })).orders;
  return (await fetchTikTokOrders({ config: await tiktokConfig(), since, until, max: 5000 })).orders;
}

/**
 * Count distinct buyers of sold orders, per channel. A month that will not answer after
 * three tries is listed in `failed`; the caller must not publish a count with holes in it.
 */
export async function countUniqueBuyers({ pull = pullMonth, now = Date.now(), starts = HISTORY_STARTS } = {}) {
  const sets = {};
  const orders = {};
  const failed = [];
  await Promise.all(Object.entries(starts).map(async ([source, start]) => {
    for (const month of monthsSince(start, now)) {
      let batch = null;
      for (let attempt = 1; attempt <= 3 && batch === null; attempt++) {
        batch = await pull(source, month).catch(() => null);
      }
      if (batch === null) { failed.push(`${source} ${month}`); continue; }
      for (const order of batch) {
        if (!DEMAND_STAGES.has(order.stage)) continue;
        const key = buyerKey(order);
        if (!key) continue;
        (sets[order.channel] ??= new Set()).add(key);
        orders[order.channel] = (orders[order.channel] ?? 0) + 1;
      }
    }
  }));
  const channels = Object.fromEntries(Object.entries(sets)
    .map(([channel, set]) => [channel, { orders: orders[channel], buyers: set.size }]));
  const total = Object.values(channels).reduce((sum, c) => sum + c.buyers, 0);
  return { channels, total, failed: failed.sort() };
}

const READ = `query TreelogyUniqueBuyersRead {
  shop { id metafield(namespace: "${METAFIELD.namespace}", key: "${METAFIELD.key}") { value } }
}`;

const WRITE = `mutation TreelogyUniqueBuyers($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { namespace key value updatedAt }
    userErrors { field message code }
  }
}`;

/** The figure the storefront shows now, and the shop it belongs to. */
export async function readPublished({ graphql = shopifyGraphql } = {}) {
  const data = await graphql(READ);
  return { shopId: data.shop.id, value: Number(data.shop.metafield?.value) || 0 };
}

/**
 * Write the count to the shop metafield the theme reads. The only Shopify write this
 * codebase makes outside inventory: one integer, on the shop, in our own namespace.
 * Refuses a count with failed months, and one that falls more than MAX_DROP below what
 * is already published - a buyer, once counted, does not stop having bought.
 */
export async function publishUniqueBuyers(result, { graphql = shopifyGraphql } = {}) {
  if (result.failed.length) throw new Error(`${result.failed.length} bulan tidak terbaca: ${result.failed.slice(0, 4).join(', ')}`);
  if (!(result.total > 0)) throw new Error('hitungan kosong');
  const { shopId, value: before } = await readPublished({ graphql });
  if (before && result.total < before * (1 - MAX_DROP)) {
    throw new Error(`hitungan ${result.total} jauh di bawah yang tampil (${before}) - tidak ditulis`);
  }
  if (result.total === before) return { before, after: before, changed: false };
  if (isReadOnly()) throw new ReadOnlyError('jumlah pembeli unik di Shopify');
  const data = await graphql(WRITE, { metafields: [{
    ownerId: shopId, ...METAFIELD, type: 'number_integer', value: String(result.total),
  }] });
  const errors = data.metafieldsSet?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
  return { before, after: result.total, changed: true };
}
