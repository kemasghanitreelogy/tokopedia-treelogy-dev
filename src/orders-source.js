import { collectOrders } from './omni.js';
import { isShopifyConfigured } from './shopify/config.js';
import { isSupabaseConfigured } from './db/client.js';
import { ordersInRange, readCoverage, recordCoverage, saveOrders, coversRange } from './db/orders.js';
import { resolveRange } from './range.js';

/**
 * Where a reader gets its orders: the database when it can answer, the platforms when it
 * cannot.
 *
 * Every page used to fan out to three marketplaces and wait for the slowest, which made
 * the dashboard exactly as fast and exactly as available as the worst platform that
 * minute, and spent API quota re-reading sales that had not changed since the last
 * refresh. Orders arrive by webhook now and are written once; a reader after that is one
 * indexed query.
 *
 * The fallback is not a safety blanket, it is the mechanism. A window the database has
 * not been told about is read live and stored on the way past, so the first person to
 * look at an uncovered range pays for it once and nobody pays again. That is also why the
 * decision is made from a coverage table rather than from "did we get any rows": zero
 * rows is what both an unread window and a quiet week look like, and guessing between
 * them is how a dashboard becomes confidently wrong.
 */

/**
 * One pull answers for these channels.
 *
 * Tokopedia and TikTok Shop share an API and therefore share a coverage record; treating
 * them as two sources would leave a quiet Tokopedia week permanently marked unread.
 */
export const SOURCE_CHANNELS = {
  tiktok: ['tokopedia', 'tiktok_shop'],
  shopee: ['shopee'],
  shopify: ['shopify'],
};

/** The sources this deployment is actually expected to have data for. */
export function activeSources() {
  return isShopifyConfigured() ? ['tiktok', 'shopee', 'shopify'] : ['tiktok', 'shopee'];
}

/** Which sources a live result came back clean for - complete, untruncated, no error. */
function healthySources({ errors, truncated }) {
  const cut = new Set(truncated ?? []);
  return activeSources().filter((source) => {
    if (errors?.[source]) return false;
    if (source === 'tiktok') return !cut.has('Tokopedia + TikTok Shop');
    if (source === 'shopee') return !cut.has('Shopee');
    return true;
  });
}

/**
 * Orders for a window, in the same shape collectOrders returns.
 *
 * `from` says which way the answer came, so a caller that cares - the status page, a
 * test - can tell, and every caller that does not can ignore it.
 */
export async function loadOrders({ range, maxPerPlatform = 800, tracking = true, ...rest } = {}) {
  const window = range ?? resolveRange(rest);

  if (!isSupabaseConfigured()) return { ...(await collectOrders({ range: window, maxPerPlatform, tracking })), from: 'live' };

  const sources = activeSources();
  let coverage = null;
  try {
    coverage = await readCoverage();
  } catch (error) {
    // A database we cannot reach must not take the dashboard down with it; the platforms
    // are still there and the page is still correct, only slower.
    console.warn(`db: cakupan tidak terbaca, membaca langsung dari platform - ${error.message}`);
  }

  if (coverage && coversRange(coverage, window, sources)) {
    try {
      const orders = await ordersInRange({ since: window.since, until: window.until });
      return {
        orders,
        errors: {},
        truncated: [],
        maxPerPlatform,
        range: window,
        shopeeShop: null,
        generatedAt: Date.now(),
        from: 'db',
      };
    } catch (error) {
      console.warn(`db: pembacaan gagal, jatuh ke platform - ${error.message}`);
    }
  }

  const live = await collectOrders({ range: window, maxPerPlatform, tracking });
  await rememberOrders(live, window);
  return { ...live, from: 'live' };
}

/**
 * Keep what a live read cost us, and widen the covered window by it.
 *
 * Exported because the 15-minute sweep reads live by necessity - it exists to catch what
 * the webhooks missed, so it cannot trust the database it is checking - and its reading
 * is exactly as good as the dashboard's. Handing it here is what keeps coverage rolling
 * forward on its own instead of only when someone runs a backfill.
 *
 * Storing is best-effort on purpose: this runs while somebody is waiting for a page, and
 * a database that refuses a write is a reason to be slower next time, never a reason to
 * fail the request that already has its answer in hand.
 *
 * Coverage is claimed only for sources that came back whole. A truncated Shopee read has
 * real orders in it and they are worth storing, but claiming the window would freeze that
 * partial answer in place for every later reader.
 */
export async function rememberOrders(live, window) {
  try {
    await saveOrders(live.orders, { source: 'live-read' });
    for (const source of healthySources(live)) {
      await recordCoverage(source, { from: window.since, through: window.until, note: 'live-read' });
    }
  } catch (error) {
    console.warn(`db: pesanan tidak tersimpan - ${error.message}`);
  }
}

/**
 * One order, straight off a push.
 *
 * Deliberately does not touch coverage: a single order says nothing about whether the
 * window around it has been read. The sweep is what widens coverage; this only keeps the
 * rows inside an already-covered window current, which is the part that has to happen in
 * seconds rather than in fifteen minutes.
 */
export async function rememberOrder(order, { source = 'webhook' } = {}) {
  if (!order || !isSupabaseConfigured()) return { written: 0 };
  try {
    return await saveOrders([order], { source });
  } catch (error) {
    // The push has already been re-read and the books still get written; a database that
    // refuses this write must not turn a handled push into a 500 the platform retries.
    console.warn(`db: pesanan ${order.channel}/${order.id} tidak tersimpan - ${error.message}`);
    return { written: 0, error: error.message };
  }
}
