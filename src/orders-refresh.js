import { fetchOrdersByIds } from './omni.js';
import { saveOrders } from './db/orders.js';
import { isSupabaseConfigured } from './db/client.js';
import { invalidate } from './cache.js';

/**
 * Bringing our copy of an order back in line with the platform, after we changed it.
 *
 * Every screen here is drawn from our own table rather than from the marketplaces, which
 * is what makes the dashboard fast and what makes it survive a platform being down. The
 * price of that is a rule with no exceptions: anything that changes an order on a
 * platform has to tell the table, or the screen keeps describing the moment before.
 *
 * It was not a rule, and it cost exactly what you would expect. Two Shopee parcels were
 * arranged at 10:28 and Shopee had them PROCESSED one second later; our row still said
 * READY_TO_SHIP from a read at 10:05, nothing updated it, and they sat in "perlu diatur"
 * while the operator pressed the button ten times in ninety seconds. The webhook is the
 * usual messenger, and Shopee's pushes are not dependable here.
 *
 * So this lives next to the writes rather than next to the callers: `runAction` and
 * `massArrange` finish by calling it, and a future write path that forgets is a write
 * path that never gets to forget, because the function that performs the write is the
 * one that reconciles.
 */

/** Re-read these orders from their platforms and store what comes back. */
export async function refreshOrders(selection, { read = fetchOrdersByIds, save = saveOrders, hasDatabase = isSupabaseConfigured } = {}) {
  const wanted = (selection ?? [])
    .map(({ channel, id }) => ({ channel: String(channel ?? ''), id: String(id ?? '') }))
    .filter((row) => row.channel && row.id);
  if (wanted.length === 0) return { refreshed: 0 };

  // The cache goes either way. It is keyed by range and the rows behind it have just
  // changed, so serving the old answer is wrong whether or not the re-read worked.
  try {
    // A typed-in sale has no platform to ask; it only ever lived in our table.
    const askable = wanted.filter((row) => row.channel !== 'manual');
    if (askable.length === 0 || !hasDatabase()) return { refreshed: 0 };

    const { orders } = await read(askable);
    if (orders.length > 0) await save(orders, { source: 'refresh' });
    return { refreshed: orders.length, missing: askable.length - orders.length };
  } catch (error) {
    // The platform write already happened and must not be reported as failed because the
    // read after it did not. The sweep picks these up within the quarter hour.
    console.warn(`orders: gagal menyegarkan ${wanted.length} pesanan - ${error.message}`);
    return { refreshed: 0, error: error.message };
  } finally {
    invalidate('orders');
  }
}
