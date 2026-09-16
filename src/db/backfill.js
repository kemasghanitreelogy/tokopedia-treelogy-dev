import { collectOrders } from '../omni.js';
import { saveOrders, recordCoverage, DB_HISTORY_START, DB_HISTORY_START_EPOCH } from './orders.js';
import { activeSources, SOURCE_CHANNELS, sourceOfChannel } from '../orders-source.js';
import { wibDate } from '../range.js';

/**
 * Fill the database with everything that has already happened.
 *
 * Webhooks only ever carry what happens next, so on the day this is switched on the
 * database knows nothing and every reader falls through to the platforms. This walks the
 * period once and ends that.
 *
 * It goes in chunks rather than one enormous window for three reasons that all amount to
 * the same one: a chunk that fails costs a chunk. Each platform paginates inside the
 * chunk, each chunk is stored before the next begins, and re-running after a failure
 * re-does only what was lost - writes are keyed on (channel, id), so repeating one is
 * free.
 *
 * Coverage is the last thing written and only for sources that came back whole in every
 * chunk. Claiming a window that was read with a gap in it is worse than claiming nothing:
 * an unclaimed window is read live again, a wrongly claimed one is never revisited.
 */

const DAY = 24 * 3600;

/**
 * What collectOrders calls each source when it had to cut a read short.
 *
 * Shopify has no entry because src/omni.js never sets one for it - fetchShopifyOrders
 * returns a bare array with no truncation flag - so Shopify truncation is currently
 * undetectable. Saying that here is better than the previous arrangement, which borrowed
 * Shopee's flag and looked like it was checking something.
 */
const TRUNCATION_MARKERS = { tiktok: 'Tokopedia + TikTok Shop', shopee: 'Shopee' };

/** A week at a time: big enough to be few requests, small enough to lose little. */
export const CHUNK_DAYS = 7;

/** How many times a chunk is re-read before its failure is accepted as real. */
export const ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Two reads of the same window, combined into the best account of it either one gives.
 *
 * Keeping only the latest attempt threw away work that had already been paid for: a retry
 * happens because *one* platform failed, and the other two answered perfectly well. Read
 * Shopee on attempt one and TikTok on attempt three and the week is complete between them,
 * yet the chunk was stored from attempt three alone and Shopee's orders - fetched,
 * normalised and then dropped - were simply missing from a window we went on to claim as
 * covered.
 *
 * Orders are unioned on (channel, id), which is the same key the database writes on, so a
 * platform answering twice contributes one row. A source that answered in either attempt
 * is no longer an error; truncation is the other way round and stays if either read hit
 * it, because a claim over a window read short is the expensive mistake here.
 */
export function mergeReads(first, second) {
  const orders = new Map();
  for (const order of [...(first.orders ?? []), ...(second.orders ?? [])]) {
    orders.set(`${order.channel}:${order.id}`, order);
  }
  const errors = {};
  for (const [source, message] of Object.entries(first.errors ?? {})) {
    if (source in (second.errors ?? {})) errors[source] = second.errors[source] ?? message;
  }
  return {
    ...second,
    orders: [...orders.values()],
    errors,
    truncated: [...new Set([...(first.truncated ?? []), ...(second.truncated ?? [])])],
  };
}

/**
 * Read one chunk, giving a flaky link a second and third chance.
 *
 * The connection out of this box is not always well: a run over the same six weeks
 * produced "tiktok: fetch failed" in a different chunk each time, on a network where a
 * TLS connect was taking three seconds. Accepting the first refusal means one blink costs
 * a whole week its coverage, and the week is then read live by every visitor forever
 * after - which is the failure this backfill exists to end.
 *
 * Only a chunk with something wrong is re-read, so a healthy run pays nothing at all, and
 * every attempt's orders are kept rather than only the last one's.
 */
async function readChunk(window, attempts, collect, sources) {
  // Nought attempts used to mean the loop never ran and `null` came back, and the run then
  // died several chunks in on `live.orders.length` with nothing reported at all. One read
  // is the least that can be called a read.
  const rounds = Math.max(1, Math.floor(Number(attempts)) || 1);
  let merged = null;
  for (let attempt = 1; attempt <= rounds; attempt += 1) {
    const live = await readOnce(window, collect, sources);
    merged = merged === null ? live : mergeReads(merged, live);
    const failed = Object.keys(merged.errors ?? {}).length > 0;
    if (!failed || attempt === rounds) return merged;
    await sleep(attempt * 2000);
  }
  return merged;
}

/**
 * One read, where a thrown one is every source failing rather than the end of the run.
 *
 * collectOrders puts each platform behind allSettled and hands failures back as `errors`,
 * so in the ordinary way of things nothing escapes it - which is exactly what was true of
 * the write below until a database went down mid-backfill and the exception carried off
 * five weeks of stored chunks along with the report of them. Anything that does get out
 * here - a token refresh rejecting outside the settle, a range helper handed a bad date -
 * would do the same thing one step earlier.
 *
 * Named as a failure of every source, so the merge treats it as precisely what it is: an
 * attempt in which nobody answered. It is retried like any other, and if the retries do not
 * rescue it, it costs those sources their coverage claim rather than being claimed blind.
 */
async function readOnce(window, collect, sources) {
  try {
    const live = await collect({ range: window, maxPerPlatform: 5000, tracking: false });
    return { ...live, orders: live?.orders ?? [] };
  } catch (error) {
    return {
      orders: [],
      errors: Object.fromEntries((sources ?? []).map((source) => [source, error.message])),
      truncated: [],
    };
  }
}

/**
 * @param {{from?: string, until?: number, chunkDays?: number, attempts?: number, onProgress?: Function, dryRun?: boolean}} options
 * @param {Function} [options.collect]  the read, and `store` the write. They default to
 *   the real ones; naming them is what lets a run over a dozen chunks - a retry that
 *   half-succeeds, a database that refuses one - be exercised without three marketplaces
 *   and a live table, which is the only reason any of this was ever tested by hand.
 */
export async function backfill({
  from = DB_HISTORY_START,
  until = Math.floor(Date.now() / 1000),
  chunkDays = CHUNK_DAYS,
  attempts = ATTEMPTS,
  onProgress = () => {},
  dryRun = false,
  collect = collectOrders,
  store = saveOrders,
} = {}) {
  const since = from === DB_HISTORY_START
    ? DB_HISTORY_START_EPOCH
    : Math.floor(Date.parse(`${from}T00:00:00+07:00`) / 1000);
  if (!Number.isFinite(since)) throw new Error(`tanggal mulai tidak valid: ${from}`);
  if (until <= since) throw new Error('rentang kosong: tanggal akhir tidak setelah tanggal mulai');

  const sources = activeSources();
  // A source stays eligible for a coverage claim only while every chunk has been clean.
  const whole = new Set(sources);
  const chunks = [];
  const rejected = [];
  let stored = 0;
  let seen = 0;

  for (let start = since; start < until; start += chunkDays * DAY) {
    // The last chunk swallows the remainder instead of stopping one second short of it.
    //
    // Chunks are half-open in disguise: each ends at `start + span - 1` so the next can
    // begin at `start + span` with nothing in between. That is right everywhere except the
    // end, where the loop stops as soon as `start` reaches `until` - so a range whose
    // length divides exactly by the chunk span left the single instant `until` unread while
    // coverage was still claimed through it. Both bounds are inclusive here and in
    // ordersInRange, and a claimed window is never read live again, so an order created on
    // that second would have been lost for good on a one-second hole nobody could see.
    const edge = start + chunkDays * DAY - 1;
    const end = edge >= until - 1 ? until : edge;
    const window = { since: start, until: end, label: `${wibDate(start)} s/d ${wibDate(end)}` };

    // maxPerPlatform is set high deliberately: a cap that trims here does not show up as
    // an error, it shows up months later as a week that is quietly short of orders.
    const live = await readChunk(window, attempts, collect, sources);

    for (const source of sources) {
      // Named, not weighed. `Boolean(live.errors[source])` asked whether the *message* was
      // truthy, and an Error thrown with no message - `new Error()`, an abort, a platform
      // client that only sets a status - reads as no error at all. readChunk counts the same
      // failure by key and retries it three times; this line then handed the source its
      // coverage claim anyway. Two answers to one question in one file, and the permissive
      // one was the one that decided what the dashboard would stop reading live.
      const failed = source in (live.errors ?? {});
      // A ternary with two arms for three sources: shopify took the Shopee branch, so a
      // truncated Shopee read revoked shopify's claim and a truncated Shopify read
      // revoked nothing. Named explicitly now, and a source with no marker is simply not
      // detectable as truncated rather than borrowing somebody else's.
      const marker = TRUNCATION_MARKERS[source];
      const cut = Boolean(marker) && (live.truncated ?? []).includes(marker);
      if (failed || cut) whole.delete(source);
    }

    // A write that fails outright - the database unreachable, or ill - ends this chunk,
    // not the run. Without this the exception walked straight out of backfill() and a job
    // that had already stored five weeks reported nothing at all, and the operator had to
    // start again from the beginning to find out how far it had got. The chunk simply
    // keeps no claim, which is what an unwritten window should look like.
    let written;
    try {
      written = dryRun ? { written: 0, rejected: [] } : await store(live.orders, { source: 'backfill' });
    } catch (error) {
      written = { written: 0, rejected: [], error: error.message };
      for (const s of sources) whole.delete(s);
    }
    seen += live.orders.length;
    stored += written.written;
    rejected.push(...(written.rejected ?? []));
    // An order the database refused is a hole in the window, so the source that produced
    // it loses its claim rather than the operator finding out months later.
    for (const bad of written.rejected ?? []) {
      const source = sourceOfChannel(bad.channel);
      // An unrecognised channel used to fall through to 'tiktok', revoking a claim that
      // had nothing to do with it. Now it revokes every claim, because a rejected order
      // we cannot even place is a hole of unknown position.
      if (source) whole.delete(source);
      else for (const s of sources) whole.delete(s);
    }

    const chunk = {
      label: window.label,
      found: live.orders.length,
      written: written.written,
      rejected: written.rejected ?? [],
      errors: live.errors ?? {},
      truncated: live.truncated ?? [],
      // Named separately from the read errors above: this one is our own database
      // refusing the chunk, which is a different thing to fix.
      ...(written.error ? { writeError: written.error } : {}),
    };
    chunks.push(chunk);
    onProgress(chunk);
  }

  // What a clean run would claim, worked out the same way whether or not it is written.
  // A dry run that reported nothing claimable would say the run had failed when it had
  // only been asked not to write.
  const claimable = sources.filter((source) => whole.has(source));
  const claimed = [];
  const claimFailed = [];
  if (dryRun) {
    claimed.push(...claimable);
  } else {
    for (const source of claimable) {
      try {
        await recordCoverage(source, { from: since, through: until, note: 'backfill' });
        claimed.push(source);
      } catch (error) {
        // The same lesson as the per-chunk write above, one step later and much easier to
        // miss: this loop runs after every chunk is already stored, so one throw here threw
        // away the entire report - every chunk, every rejected order, both counts - over a
        // failure that costs a single source its claim. The claim not landing is the safe
        // half: an unclaimed window is read live again. The report nobody ever sees is not,
        // and the operator's only way to find out how far the run got was to start again.
        //
        // `claimed` is what the table now says, not what this run hoped it would say. The
        // whole point of the list is that the operator can read "the dashboard may answer
        // for these from the database", and a source whose write failed may not.
        claimFailed.push({ source, error: error.message });
      }
    }
  }

  return {
    since,
    until,
    chunks,
    seen,
    stored,
    rejected,
    // Named so the operator can see at a glance which channels the dashboard may now
    // answer for from the database, and which are still going to the platforms.
    claimed,
    // A source that came back whole in every chunk and then could not have its claim
    // written. Separate from `unclaimed` because the cure is different: this one is worth
    // re-running, a source that read short is worth looking at first.
    claimFailed,
    unclaimed: sources.filter((s) => !claimed.includes(s)),
    channels: claimed.flatMap((s) => SOURCE_CHANNELS[s] ?? []),
    dryRun,
  };
}
