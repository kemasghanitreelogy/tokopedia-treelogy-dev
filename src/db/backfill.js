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
 * Read one chunk, giving a flaky link a second and third chance.
 *
 * The connection out of this box is not always well: a run over the same six weeks
 * produced "tiktok: fetch failed" in a different chunk each time, on a network where a
 * TLS connect was taking three seconds. Accepting the first refusal means one blink costs
 * a whole week its coverage, and the week is then read live by every visitor forever
 * after - which is the failure this backfill exists to end.
 *
 * Only a chunk with something wrong is re-read, so a healthy run pays nothing at all, and
 * the result kept is the first one that came back whole.
 */
async function readChunk(window, attempts) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await collectOrders({ range: window, maxPerPlatform: 5000, tracking: false });
    const failed = Object.keys(last.errors ?? {}).length > 0;
    if (!failed || attempt === attempts) return last;
    await sleep(attempt * 2000);
  }
  return last;
}

/**
 * @param {{from?: string, until?: number, chunkDays?: number, attempts?: number, onProgress?: Function, dryRun?: boolean}} options
 */
export async function backfill({
  from = DB_HISTORY_START,
  until = Math.floor(Date.now() / 1000),
  chunkDays = CHUNK_DAYS,
  attempts = ATTEMPTS,
  onProgress = () => {},
  dryRun = false,
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
    const end = Math.min(start + chunkDays * DAY - 1, until);
    const window = { since: start, until: end, label: `${wibDate(start)} s/d ${wibDate(end)}` };

    // maxPerPlatform is set high deliberately: a cap that trims here does not show up as
    // an error, it shows up months later as a week that is quietly short of orders.
    const live = await readChunk(window, attempts);

    for (const source of sources) {
      const failed = Boolean(live.errors?.[source]);
      // A ternary with two arms for three sources: shopify took the Shopee branch, so a
      // truncated Shopee read revoked shopify's claim and a truncated Shopify read
      // revoked nothing. Named explicitly now, and a source with no marker is simply not
      // detectable as truncated rather than borrowing somebody else's.
      const marker = TRUNCATION_MARKERS[source];
      const cut = Boolean(marker) && (live.truncated ?? []).includes(marker);
      if (failed || cut) whole.delete(source);
    }

    const written = dryRun ? { written: 0, rejected: [] } : await saveOrders(live.orders, { source: 'backfill' });
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
    };
    chunks.push(chunk);
    onProgress(chunk);
  }

  // What a clean run would claim, worked out the same way whether or not it is written.
  // A dry run that reported nothing claimable would say the run had failed when it had
  // only been asked not to write.
  const claimed = sources.filter((source) => whole.has(source));
  if (!dryRun) {
    for (const source of claimed) {
      await recordCoverage(source, { from: since, through: until, note: 'backfill' });
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
    unclaimed: sources.filter((s) => !claimed.includes(s)),
    channels: claimed.flatMap((s) => SOURCE_CHANNELS[s] ?? []),
    dryRun,
  };
}
