import { ordersByIds } from './db/orders.js';
import { isSupabaseConfigured } from './db/client.js';
import { fetchOrdersByIds } from './omni.js';

/**
 * The orders behind a selection, as fast as they can honestly be had.
 *
 * Printing is the one thing on this dashboard that reads many orders at once and writes
 * nothing, and it was paying the worst possible price for them: `fetchOrdersByIds` asks
 * each platform, and Shopify has no by-id batch read, so it scans sixty days of history
 * to find one order. Eleven seconds for a single invoice, and the same eleven for ten
 * labels - almost none of it spent on the document.
 *
 * Every one of those orders is already in our own database, keyed, and a keyed read costs
 * a quarter of a second for one row or a hundred. So the database answers first and the
 * platforms are asked only for what it does not have: an order older than the history we
 * hold, or one that arrived in the last few seconds.
 *
 * A write path must not use this. Arranging a shipment re-reads from the platform on
 * purpose, so a tampered form cannot ship somebody else's parcel; a document that only
 * ever gets printed has nothing to gain from that and everything to lose in latency.
 */
export async function ordersForPrinting(selection, {
  // Injectable for the same reason loadOrders does it: the fallback is the whole point
  // of this function and it is unreachable in a test that needs a database and four
  // marketplaces to run.
  readStored = ordersByIds,
  readLive = fetchOrdersByIds,
  hasDatabase = isSupabaseConfigured,
} = {}) {
  const wanted = selection
    .map(({ channel, id }) => ({ channel: String(channel ?? ''), id: String(id ?? '') }))
    .filter((row) => row.channel && row.id);
  if (wanted.length === 0) return { orders: [], errors: {}, fromDb: 0, fromPlatform: 0 };

  // A database that is down is a slow print, never a failed one.
  const stored = hasDatabase() ? await readStored(wanted).catch(() => []) : [];
  const found = new Map(stored.map((order) => [`${order.channel}:${order.id}`, order]));

  // A typed-in sale lives only in the table; no platform can be asked for it.
  const missing = wanted.filter((row) => !found.has(`${row.channel}:${row.id}`) && row.channel !== 'manual');
  if (missing.length === 0) {
    return { orders: [...found.values()], errors: {}, fromDb: found.size, fromPlatform: 0 };
  }

  const live = await readLive(missing).catch((error) => ({ orders: [], errors: { all: error.message } }));
  for (const order of live.orders) found.set(`${order.channel}:${order.id}`, order);

  return {
    orders: [...found.values()],
    errors: live.errors ?? {},
    fromDb: found.size - live.orders.length,
    fromPlatform: live.orders.length,
  };
}
