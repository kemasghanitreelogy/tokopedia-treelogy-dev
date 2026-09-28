import { readCatalog } from './inventory.js';
import { applySync } from './stock-sync.js';
import { planTopup, wouldDropBelow, describeTopup } from './stock-topup.js';
import { cached, invalidate } from './cache.js';

/**
 * Topping a listing up the moment an order takes it under, rather than within the hour.
 *
 * The timer every thirty minutes is the backstop and stays. It is not realtime, and a
 * listing that sells its last few during that half hour shows "habis" to everybody who
 * looks - which is the one thing the top-up exists to prevent.
 *
 * What actually moves stock is an order, and orders arrive as webhooks. So the check
 * hangs off the push, and the trick is doing it without making every order cost a
 * catalogue read:
 *
 *   The cached catalogue - sixty seconds old at worst, and usually warm because the
 *   dashboard shares it - says what each listing held. The order says what just left. A
 *   subtraction is free and on a normal order the answer is "still well above a hundred",
 *   which is the end of it.
 *
 *   Only when that projection lands near the floor is a real read worth two seconds and
 *   a handful of marketplace calls. The top-up then decides from the fresh figures; the
 *   projection is only ever a reason to look, never a reason to write.
 *
 * It never blocks the push. The order is already stored and the platform wants its 200
 * quickly; a stock write that took three seconds would be three seconds of a marketplace
 * waiting to be told we heard it.
 */

/** One run at a time. A burst of orders is one reason to look, not six. */
let running = null;
/** And not more often than this, however many orders land. */
const COOLDOWN_MS = 30_000;
let lastRun = 0;

/** Test seam: the module is a singleton and a test needs it to forget. */
export function resetStockWatch() {
  running = null;
  lastRun = 0;
}

const CATALOG_TTL_MS = 60_000;
const catalogue = () => cached('catalog', CATALOG_TTL_MS, readCatalog);

/**
 * Look at what this order took, and top up if it took a listing under.
 *
 * `read` and `apply` are injectable for one reason: a test that reached the marketplaces
 * would be a test that spends quota and fails when a platform is slow. The defaults are
 * the real thing and nothing but a test passes anything else.
 *
 * Returns what it did, for tests and for a caller that wants to log it. Never throws:
 * this hangs off a webhook, and a stock write that fails must not turn a handled push
 * into a 500 the platform retries.
 *
 * @param {{lines?: Array}} order
 */
export async function topUpAfterOrder(order, { now = Date.now(), apply = applySync, read = catalogue } = {}) {
  try {
    const cat = await read();
    if (Object.keys(cat?.errors ?? {}).length > 0) return { checked: false, reason: 'katalog tidak lengkap' };

    const atRisk = wouldDropBelow(cat, order);
    if (atRisk.length === 0) return { checked: true, atRisk: 0, written: 0 };

    if (running) return { checked: true, atRisk: atRisk.length, reason: 'sudah ada yang berjalan' };
    if (now - lastRun < COOLDOWN_MS) return { checked: true, atRisk: atRisk.length, reason: 'baru saja dijalankan' };

    lastRun = now;
    running = (async () => {
      // The projection was a reason to look. What gets written is decided from figures
      // read just now, because between the cache and this moment the channel may have
      // been topped up already, or sold more.
      invalidate('catalog');
      const fresh = await read();
      if (Object.keys(fresh?.errors ?? {}).length > 0) {
        console.warn('stok: katalog tidak lengkap saat isi ulang realtime - tidak menulis apa pun');
        return { checked: true, atRisk: atRisk.length, written: 0, reason: 'katalog tidak lengkap' };
      }

      const plan = planTopup(fresh);
      if (plan.changes.length === 0) return { checked: true, atRisk: atRisk.length, written: 0 };

      const result = await apply(plan, { dryRun: false });
      // The catalogue in hand now describes the moment before the write.
      invalidate('catalog');
      console.log(`stok/realtime: ${describeTopup(plan)} - ${result.succeeded} berhasil, ${result.failed} gagal`);
      return { checked: true, atRisk: atRisk.length, written: result.succeeded, failed: result.failed };
    })().finally(() => { running = null; });

    return running;
  } catch (error) {
    console.warn(`stok: isi ulang realtime gagal - ${error.message}`);
    return { checked: false, error: error.message };
  }
}
