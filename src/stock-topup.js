import { WRITABLE_CHANNELS } from './stock-sync.js';
import { numberOrNull } from './numbers.js';

/**
 * Keeping a listing from showing "habis", one SKU at a time.
 *
 * The number on a Treelogy listing is a display figure, not a count of jars on a shelf -
 * confirmed by the operator before this was written, because the difference decides
 * whether topping it up is routine or is selling goods that do not exist. On that
 * footing, a listing that drifts under a hundred is simply a listing about to stop
 * selling, and adding a hundred back is the whole of the job.
 *
 * It is deliberately separate from planSync, which answers a different question: that one
 * makes every channel agree with a master ledger an operator has vouched for, and refuses
 * to raise a figure it cannot vouch for. This one has no ledger and no opinion about
 * agreement; each channel's own listing is topped up from its own current number. The
 * ledger has never been seeded, so making this depend on it would be making it depend on
 * nothing.
 *
 * What it will not touch, even here:
 *
 *   Shopify, because writing its stock needs inventorySetQuantities against a location
 *   id and that is not built - a plan including it would silently fail a third of itself.
 *
 *   A SKU whose channel reports a conflict, meaning several live listings disagree about
 *   the quantity. Picking one to write to is a guess, and a guess that lands on the wrong
 *   listing is worse than a listing that says "habis".
 *
 *   A SKU already at or above the floor, obviously; and one whose quantity the channel
 *   did not report at all, since "unknown" is not "low".
 */

/** Below this, a listing is close enough to stopping that it needs more. */
export const FLOOR = 100;
/** How much goes back on. The operator's rule: add this to whatever is there now. */
export const ADD = 100;
/**
 * Nothing sane needs more than this in one run.
 *
 * Twenty-nine SKUs across two channels is fifty-eight writes at the absolute maximum, and
 * a run wanting more than this has misread the catalogue rather than found a crisis.
 */
export const MAX_WRITES = 40;

/**
 * @param {{skus: Array}} catalog  from readCatalog()
 * @param {{floor?: number, add?: number, max?: number}} options
 * @returns {{changes: Array, skipped: Array, plannedAt: number, floor: number, add: number}}
 *   `changes` is shaped exactly as applySync expects, so the same writer and the same
 *   audit record serve both planners.
 */
export function planTopup(catalog, { floor = FLOOR, add = ADD, max = MAX_WRITES } = {}) {
  const changes = [];
  const skipped = [];

  for (const entry of catalog?.skus ?? []) {
    for (const channel of WRITABLE_CHANNELS) {
      const bucket = entry[channel];
      if (!bucket) continue; // not listed live here - never create a listing

      if (bucket.conflict) {
        skipped.push({ sku: entry.sku, channel, reason: 'beberapa listing hidup tidak sepakat jumlahnya' });
        continue;
      }

      for (const current of bucket.rows ?? []) {
        /*
         * Not Number(), which turns null and '' into 0.
         *
         * Zero is the most dangerous reading there is here: a channel that answered
         * without a quantity would look like a listing that had sold out, and be written
         * back up to a hundred on the strength of nothing. "Unknown" is not "low".
         */
        const from = numberOrNull(current.qty);
        if (from === null) {
          skipped.push({ sku: entry.sku, channel, reason: 'jumlah tidak terbaca dari kanal' });
          continue;
        }
        if (from >= floor) continue;

        changes.push({
          sku: entry.sku,
          title: entry.title,
          channel,
          from,
          to: from + add,
          delta: add,
          ref: channel === 'tiktok'
            ? { productId: current.productId, skuId: current.skuId, warehouseId: current.warehouseId }
            : { itemId: current.itemId, modelId: current.modelId },
          reason: `di bawah ${floor}`,
        });
      }
    }
  }

  // Oldest problem first: the emptiest listing is the one closest to stopping.
  changes.sort((a, b) => a.from - b.from);

  return {
    changes: changes.slice(0, max),
    // Said rather than silently dropped: a cap that bites is a fact about the run.
    overflow: Math.max(0, changes.length - max),
    skipped,
    floor,
    add,
    plannedAt: Date.now(),
  };
}

/** One line for a log or a message; the same sentence the audit record carries. */
export function describeTopup(plan) {
  if (plan.changes.length === 0) return 'tidak ada listing di bawah ambang';
  const per = plan.changes
    .map((c) => `${c.sku} ${c.channel} ${c.from}→${c.to}`)
    .slice(0, 8)
    .join(', ');
  return `${plan.changes.length} listing ditambah ${plan.add}: ${per}${plan.changes.length > 8 ? ', ...' : ''}`;
}
