import { collectOrders } from '../omni.js';
import { ordersInRange } from './orders.js';
import { saleValue } from '../mekari/invoice.js';
import { CHANNELS } from '../omni.js';

/**
 * Check the database against the platforms it was built from.
 *
 * Everything downstream reads the database - the dashboard, the forecast, the books - so
 * every one of them agrees with every other by construction. That is not evidence of
 * anything. If an order never reached Postgres, the dashboard and Jurnal are both short
 * by the same amount and reconcile perfectly against each other while both being wrong.
 *
 * The only independent check is the marketplaces themselves. This reads a window live from
 * every channel and compares it with what is stored: how many orders each side has, what
 * they are worth, and precisely which ids one has that the other does not.
 *
 * Deliberately not cheap and not run on a schedule. It spends real marketplace quota, and
 * it exists to answer "is the stored data actually right" on the days somebody needs to
 * know, rather than to reassure continuously.
 */

/** @param {{range: object, maxPerPlatform?: number}} options */
export async function verifyAgainstPlatforms({ range, maxPerPlatform = 5000 } = {}) {
  const [stored, live] = await Promise.all([
    ordersInRange({ since: range.since, until: range.until }),
    collectOrders({ range, maxPerPlatform, tracking: false }),
  ]);

  const key = (o) => `${o.channel}:${o.id}`;
  const storedBy = new Map(stored.map((o) => [key(o), o]));
  const liveBy = new Map(live.orders.map((o) => [key(o), o]));

  const channels = {};
  const bucket = (channel) => {
    if (!channels[channel]) {
      channels[channel] = {
        channel,
        label: CHANNELS[channel]?.label ?? channel,
        stored: 0, storedValue: 0,
        live: 0, liveValue: 0,
        missingFromDb: [], missingFromPlatform: [], valueMismatch: [],
      };
    }
    return channels[channel];
  };

  const worth = (order) => saleValue(order) ?? Math.round(Number(order.total) || 0);

  for (const order of stored) {
    const row = bucket(order.channel);
    row.stored += 1;
    row.storedValue += worth(order);
    // An order the platform no longer reports is not automatically wrong - a live read can
    // be truncated, and a cancelled order sometimes vanishes from a listing - so it is
    // named rather than counted as an error.
    if (!liveBy.has(key(order))) row.missingFromPlatform.push(order.id);
  }

  for (const order of live.orders) {
    const row = bucket(order.channel);
    row.live += 1;
    row.liveValue += worth(order);
    const held = storedBy.get(key(order));
    // This is the one that matters: the platform has a sale and we do not. Nothing
    // downstream can ever show it, and nothing else would have told us.
    if (!held) { row.missingFromDb.push(order.id); continue; }
    const a = worth(held);
    const b = worth(order);
    if (a !== b) row.valueMismatch.push({ id: order.id, stored: a, live: b });
  }

  const rows = Object.values(channels).sort((x, y) => y.liveValue - x.liveValue);
  return {
    range,
    rows,
    truncated: live.truncated ?? [],
    errors: live.errors ?? {},
    missingFromDb: rows.reduce((n, r) => n + r.missingFromDb.length, 0),
    mismatched: rows.reduce((n, r) => n + r.valueMismatch.length, 0),
  };
}
