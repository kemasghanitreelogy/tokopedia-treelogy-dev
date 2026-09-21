import { collectOrders } from './omni.js';
import { isShopifyConfigured } from './shopify/config.js';
import { isSupabaseConfigured } from './db/client.js';
import { ordersInRange, readCoverage, recordCoverage, saveOrders, coversRange } from './db/orders.js';
import { resolveRange } from './range.js';
import { withinDays, ZONE_SPREAD_SECONDS } from './clock.js';
import { cached, invalidate } from './cache.js';
import { loadShopeeRecipients, applyShopeeRecipients } from './shopee/recipient.js';

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


/**
 * Which source a channel belongs to. One table, so nothing has to guess again.
 *
 * Written out as a chain of ternaries in two places before this, and both got it slightly
 * wrong: an unrecognised channel fell through to 'tiktok', quietly revoking the wrong
 * source's coverage claim.
 */
export function sourceOfChannel(channel) {
  for (const [source, channels] of Object.entries(SOURCE_CHANNELS)) {
    if (channels.includes(channel)) return source;
  }
  return null;
}

/** The sources this deployment is actually expected to have data for. */
export function activeSources() {
  return isShopifyConfigured() ? ['tiktok', 'shopee', 'shopify'] : ['tiktok', 'shopee'];
}

/** Which sources a live result came back clean for - complete, untruncated, no error. */
function healthySources({ errors, truncated }) {
  const cut = new Set(truncated ?? []);
  return activeSources().filter((source) => {
    // An error is an error even when it has nothing to say. This asked whether the
    // *message* was truthy, so a platform client that threw `new Error()`, or an abort that
    // carried only a name, read as a source that answered perfectly - and the window was
    // then claimed as covered and never read live again. The backfill had the same line and
    // the same hole.
    if (source in (errors ?? {})) return false;
    if (source === 'tiktok') return !cut.has('Tokopedia + TikTok Shop');
    if (source === 'shopee') return !cut.has('Shopee');
    return true;
  });
}


/**
 * The coverage table, held briefly.
 *
 * Reading it is a separate round trip to the orders themselves, and measured from the
 * Jakarta box that is about 300ms - roughly a third of the time a whole page of orders
 * took, spent asking a three-row table a question whose answer changes once every fifteen
 * minutes. Thirty seconds of staleness costs nothing either way: a coverage row that has
 * just widened only means the dashboard keeps reading the platforms a moment longer, and
 * one that has just gone stale means it serves a tail the webhooks were maintaining until
 * half a minute ago.
 */
const COVERAGE_TTL_MS = 30_000;
const coverageNow = () => cached('db:coverage', COVERAGE_TTL_MS, readCoverage);

/** After a write widens the window, the next reader should see it rather than wait it out. */
export const forgetCoverage = () => invalidate('db:coverage');

/**
 * Orders for a window, in the same shape collectOrders returns.
 *
 * `from` says which way the answer came, so a caller that cares - the status page, a
 * test - can tell, and every caller that does not can ignore it.
 */
export async function loadOrders({
  range,
  maxPerPlatform = 800,
  tracking = true,
  // Injectable so the filtering can be tested without a database or four marketplaces.
  // It went untested and one of the three call sites silently lost its filter: a parallel
  // edit had changed that line, the patch adding the filter did not match it, and a
  // 1 September window came back with 84 orders where the day holds 59.
  readStored = ordersInRange,
  readLive = collectOrders,
  readRecipients = loadShopeeRecipients,
  ...rest
} = {}) {
  const asked = range ?? resolveRange(rest);
  // Shopee's masked buyers, named from what was captured while their parcels were
  // printable. One read of a small document, applied on every path out of here.
  const named = async (orders) => applyShopeeRecipients(orders, await readRecipients().catch(() => null));

  // Fetched an hour wide on both ends, then filtered by each platform's own calendar day.
  //
  // The invoice date follows the platform - a Shopify order at 23:30 Jakarta is already
  // the next day to Shopify, and is invoiced as such - while this screen filtered by one
  // Jakarta window for everybody. Four Shopify sales in a single month landed in August on
  // one side and September on the other, and no amount of comparing the two could ever
  // reconcile them.
  //
  // The widening is not optional: a day named by two clocks an hour apart spans 25 hours,
  // so a fetch aligned to one of them cannot contain the other's.
  const window = {
    ...asked,
    since: asked.since - ZONE_SPREAD_SECONDS,
    until: asked.until + ZONE_SPREAD_SECONDS,
  };
  const inRange = (orders) => orders.filter((order) => withinDays(order, asked));

  // No platform holds a typed-in sale, so a live read still asks the table for those.
  // Best effort: a table that cannot be read costs the manual rows, never the page.
  const manualRows = async () => {
    if (!isSupabaseConfigured() && readStored === ordersInRange) return [];
    try {
      const rows = await readStored({ since: window.since, until: window.until, channels: ['manual'] });
      return rows.filter((order) => order.channel === 'manual');
    } catch (error) {
      console.warn(`db: transaksi manual tidak terbaca - ${error.message}`);
      return [];
    }
  };

  if (!isSupabaseConfigured()) {
    const live = await readLive({ range: window, maxPerPlatform, tracking });
    return { ...live, orders: await named(inRange([...live.orders, ...await manualRows()])), range: asked, from: 'live' };
  }

  const sources = activeSources();
  let coverage = null;
  try {
    coverage = await coverageNow();
  } catch (error) {
    // A database we cannot reach must not take the dashboard down with it; the platforms
    // are still there and the page is still correct, only slower.
    console.warn(`db: cakupan tidak terbaca, membaca langsung dari platform - ${error.message}`);
  }

  if (coverage && coversRange(coverage, window, sources)) {
    try {
      // Only the channels this deployment still reads live, because those are the only ones
      // coverage was just checked for. With Shopify unconfigured, activeSources drops it and
      // a live read returns nothing for it - while the table still holds every Shopify row
      // from when it was configured, so the same window answered from the database came back
      // with revenue the live path did not have. Two answers to one question, differing by
      // which path happened to serve it.
      // Typed-in sales are written straight to the table when they are saved, so they
      // need no coverage claim: the table is their only source.
      const channels = [...sources.flatMap((source) => SOURCE_CHANNELS[source] ?? []), 'manual'];
      const orders = await named(inRange(await readStored({ since: window.since, until: window.until, channels })));
      return {
        orders,
        errors: {},
        truncated: [],
        maxPerPlatform,
        range: asked,
        shopeeShop: null,
        generatedAt: Date.now(),
        from: 'db',
      };
    } catch (error) {
      console.warn(`db: pembacaan gagal, jatuh ke platform - ${error.message}`);
    }
  }

  const live = await readLive({ range: window, maxPerPlatform, tracking });
  // Stored as read - the wider set is genuinely what we fetched, and throwing away the
  // hour at each edge would leave a hole the next reader has to pay for again.
  await rememberOrders(live, window);
  return { ...live, orders: await named(inRange([...live.orders, ...await manualRows()])), range: asked, from: 'live' };
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
  let written;
  try {
    written = await saveOrders(live.orders, { source: 'live-read' });
  } catch (error) {
    // Nothing is claimed when the write did not happen, which is the whole of the handling
    // this needs: an unclaimed window is read live again.
    console.warn(`db: pesanan tidak tersimpan - ${error.message}`);
    return { written: 0, claimed: [], claimFailed: [], rejected: [], error: error.message };
  }

  const rejects = written.rejected ?? [];
  // An order the database refused is a hole in this window, and a claimed window is never
  // read live again - so the claim would freeze that hole in place for good. The backfill
  // already refuses the claim in this case; this file used to discard the rejections
  // entirely, which is the same author disagreeing with himself on the same day in two
  // files.
  const holes = new Set(rejects.map((r) => sourceOfChannel(r.channel)));
  // A rejected order whose channel cannot be placed is a hole of unknown position, so it
  // costs every claim rather than none. sourceOfChannel answers null there and null matches
  // no source, so the one rejection nobody could explain was also the only one that cost
  // nothing at all - and the backfill, three files away, has always read it the other way.
  const unplaceable = holes.has(null);

  const claimed = [];
  const claimFailed = [];
  for (const source of healthySources(live)) {
    if (unplaceable || holes.has(source)) {
      console.warn(`db: ${source} tidak diklaim - ${rejects.length} pesanan ditolak database`);
      continue;
    }
    try {
      await recordCoverage(source, { from: window.since, through: window.until, note: 'live-read' });
      claimed.push(source);
    } catch (error) {
      // One source's claim failing is not the next source's business, and it is certainly
      // not grounds for reporting the orders as unsaved - they are saved. The loop used to
      // be inside the same try as the write, so the first refusal skipped every source
      // after it and logged "pesanan tidak tersimpan" over a write that had gone through.
      claimFailed.push({ source, error: error.message });
      console.warn(`db: cakupan ${source} tidak tercatat - ${error.message}`);
    }
  }
  forgetCoverage();
  return { written: written.written, claimed, claimFailed, rejected: rejects };
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
