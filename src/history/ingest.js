import { fetchTikTokOrders, fetchShopeeOrders, tiktokConfig } from '../omni.js';
import { fetchOrders as fetchShopifyOrders } from '../shopify/shop.js';
import { isShopifyConfigured } from '../shopify/config.js';
import { findProduct } from '../master.js';
import { loadManifest, saveManifest, saveMonth, monthBounds, monthsSince, monthOf } from './store.js';
import crypto from 'node:crypto';

/**
 * Pull every sale there has ever been, one channel-month at a time.
 *
 * Each platform is asked for a calendar month and the answer is normalised into one
 * shape before it is stored, so the forecast never has to know which channel a sale came
 * from. Only what the forecast needs is kept: when, what, how many, at what price. A
 * buyer is reduced to a hash - enough to count repeat customers, not enough to name one.
 *
 * Cancelled and returned orders are stored but marked, not dropped: the demand was real
 * even though the sale was not, and the forecast decides which to count.
 */

/** Sales that count as demand. Everything else is stored with its stage and left out. */
export const DEMAND_STAGES = new Set(['to_ship', 'shipping', 'delivered', 'completed']);

const buyerHash = (buyer) => (buyer ? crypto.createHash('sha1').update(String(buyer)).digest('hex').slice(0, 12) : '');

/** One order in the stored shape. Lines are resolved to master SKUs where the master knows them. */
export function normalizeOrder(order) {
  const lines = (order.finance?.lines ?? order.lines ?? []).map((line) => {
    const master = findProduct(line.sku);
    return {
      sku: master?.sku ?? line.sku ?? '',
      raw_sku: line.sku ?? '',
      qty: Number(line.qty) || 0,
      unit_price: Math.round(Number(line.unitPrice ?? 0)),
      known: Boolean(master),
    };
  }).filter((l) => l.qty > 0);

  return {
    id: String(order.id),
    at: Number(order.createdAt),
    stage: order.stage,
    status: order.status ?? '',
    buyer: buyerHash(order.buyer),
    total: Math.round(Number(order.total) || 0),
    lines,
  };
}

/** Where each channel's history starts, measured against the live accounts. */
export const HISTORY_STARTS = {
  shopify: '2025-02',
  tiktok: '2025-05',
  shopee: '2024-01', // probed backwards until three empty windows
};

async function pullMonth(channel, month) {
  const { since, until } = monthBounds(month);
  if (channel === 'shopify') {
    if (!isShopifyConfigured()) return [];
    return fetchShopifyOrders({ since, until, max: 5000 });
  }
  if (channel === 'shopee') {
    const { orders } = await fetchShopeeOrders({ since, until, max: 5000, tracking: false });
    return orders;
  }
  if (channel === 'tiktok') {
    const config = await tiktokConfig();
    const { orders } = await fetchTikTokOrders({ config, since, until, max: 5000 });
    return orders;
  }
  throw new Error(`kanal tidak dikenal: ${channel}`);
}

/**
 * Pull whatever is missing or still open, oldest first, saving after every month.
 *
 * @param {{channels?: string[], from?: object, onMonth?: Function}} options
 */
export async function pullHistory({ channels = ['shopify', 'tiktok', 'shopee'], onMonth = () => {}, now = Date.now() } = {}) {
  const manifest = await loadManifest();
  const current = monthOf(Math.floor(now / 1000));
  const summary = {};

  for (const channel of channels) {
    manifest.channels[channel] ??= { months: {} };
    const known = manifest.channels[channel].months;
    const months = monthsSince(HISTORY_STARTS[channel] ?? '2024-01', now);
    summary[channel] = { pulled: 0, skipped: 0, orders: 0, empty_leading: 0, error: null };
    let seenAny = false;

    try {
    for (const month of months) {
      const done = known[month];
      if (done?.complete && month < current) { summary[channel].skipped++; seenAny = seenAny || done.orders > 0; continue; }

      const raw = await pullMonth(channel, month);
      const orders = raw.map(normalizeOrder).sort((a, b) => a.at - b.at);
      const complete = month < current;
      // Months before the channel's first sale are recorded as complete-and-empty so the
      // next run does not ask for them again, but they are not history.
      if (orders.length === 0 && !seenAny && complete) {
        known[month] = { orders: 0, complete: true, pulled_at: new Date().toISOString(), empty_leading: true };
        summary[channel].empty_leading++;
        await saveManifest(manifest);
        continue;
      }
      seenAny = seenAny || orders.length > 0;
      await saveMonth(channel, month, { orders, complete });
      known[month] = { orders: orders.length, complete, pulled_at: new Date().toISOString() };
      await saveManifest(manifest);
      summary[channel].pulled++;
      summary[channel].orders += orders.length;
      onMonth({ channel, month, orders: orders.length, complete });
    }
    } catch (error) {
      // A channel that will not answer - an expired authorization, an outage - must not
      // take the other channels' history down with it. Whatever was already saved stays
      // saved, the failure is reported, and the next run resumes from where this stopped.
      summary[channel].error = error.message;
      onMonth({ channel, month: null, orders: 0, complete: false, error: error.message });
    }
  }
  return { manifest, summary };
}
