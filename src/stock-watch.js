import { readCatalog } from './inventory.js';
import { applySync } from './stock-sync.js';
import { LEDGER_PATHNAME, emptyLedger } from './ledger.js';
import { seedMissing, applyOrders, topUpMaster, planFollow } from './stock-follow.js';
import { updateDoc } from './store/index.js';
import { invalidate } from './cache.js';

/**
 * The stock follower, run: the moment an order arrives, and every half hour behind it.
 *
 * See stock-follow.js for the rules. This is the part that touches the world - the
 * ledger in the state store, a fresh read of every channel, and the writes.
 *
 * One run at a time per process. An order that lands while a run is going is not dropped
 * and not waited on: it joins the queue, and the run that is going goes round once more
 * for whatever queued. A cooldown here would be wrong - the old top-up could skip a
 * burst because the half-hourly timer would catch up; a follower that skips an order
 * leaves the other channels one sale high until somebody notices.
 */

let running = null;
let queued = [];

/** Test seam: the module is a singleton and a test needs it to forget. */
export function resetStockWatch() {
  running = null;
  queued = [];
}

/**
 * Move the master by these orders, top it up, and write every channel that disagrees.
 *
 * @param {{orders?: Array, only?: 'touched'|'all', read?, apply?, update?, now?: number}} options
 *   `only: 'touched'` writes just the SKUs these orders (or the top-up) moved - an order's
 *   run. `'all'` rewrites every listing that drifted - the half-hourly run.
 */
export async function followStock({ orders = [], only = 'touched', read = readCatalog, apply = applySync, update = updateDoc, now = Date.now() } = {}) {
  const catalog = await read();
  // A channel that would not answer reads as "no listings", which seeds nothing and
  // writes nothing there - but it would still seed the rest from an incomplete view.
  if (Object.keys(catalog?.errors ?? {}).length > 0) {
    return { written: 0, failed: 0, reason: `katalog tidak lengkap: ${Object.keys(catalog.errors).join(', ')}` };
  }

  let moved = { touched: new Set(), applied: [], raised: [], seeded: [] };
  const ledger = await update(LEDGER_PATHNAME, (current) => {
    const seeded = seedMissing(current ?? emptyLedger(), catalog, { now });
    const counted = applyOrders(seeded.ledger, orders, { now });
    const topped = topUpMaster(counted.ledger, { now });
    moved = {
      touched: new Set([...counted.touched, ...topped.raised.map((r) => r.sku)]),
      applied: counted.applied, raised: topped.raised, seeded: seeded.seeded,
    };
    return { ...topped.ledger, version: 1, updated_at: new Date(now).toISOString() };
  }, emptyLedger());
  invalidate('ledger');

  const plan = planFollow(catalog, ledger, { only: only === 'all' ? null : moved.touched });
  if (plan.changes.length === 0) return { written: 0, failed: 0, ...summary(moved) };

  const result = await apply(plan, { dryRun: false });
  invalidate('catalog');
  return { written: result.succeeded, failed: result.failed, results: result.results, ...summary(moved) };
}

const summary = (moved) => ({
  applied: moved.applied.length,
  raised: moved.raised,
  seeded: moved.seeded,
});

/**
 * An order arrived. Never throws and is never awaited by the webhook: the order is
 * already stored, and the platform wants its 200 now.
 */
export function followAfterOrder(order, options = {}) {
  if (order) queued.push(order);
  if (running) return running;
  running = (async () => {
    let last = null;
    try {
      while (queued.length > 0) {
        const batch = queued;
        queued = [];
        last = await followStock({ orders: batch, ...options });
        if (last.written || last.failed || last.reason) {
          console.log(`stok/ikut: ${batch.map((o) => o.id).join(', ')} - ${last.reason ?? `${last.written} ditulis, ${last.failed} gagal`}`);
        }
      }
    } catch (error) {
      console.warn(`stok: sinkron realtime gagal - ${error.message}`);
      last = { error: error.message };
    } finally {
      running = null;
    }
    return last;
  })();
  return running;
}
