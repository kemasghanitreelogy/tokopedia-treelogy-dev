import { mekari } from './client.js';
import { readDoc, writeDoc } from '../store/index.js';
import { jurnalDateToIso } from './rebuild.js';
import { normaliseCustomId } from './invoice.js';

/**
 * One reading of Jurnal's invoice list, shared by everything that needs it.
 *
 * Four modules each walked the whole list on their own - reconcile, dedupe, settle and
 * rebuild - fifty rows at a time. Running them in sequence, which is exactly what the
 * recovery does, read the same thirteen hundred invoices three or four times over: around
 * a hundred requests to learn one set of facts, out of a budget of ninety a minute that
 * the sweep and the webhooks are also spending.
 *
 * So the scan happens once and is cached. Every consumer asks this module, and asking
 * again inside the cache window costs nothing at all.
 *
 * The cache is deliberately short. It exists to make a five-step recovery cost one scan,
 * not to spare the next hour's work - an invoice list that is minutes stale is exactly the
 * kind of thing that leads to deleting the wrong row, and one of those has been enough.
 */

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';
export const CATALOGUE_PATHNAME = 'mekari/catalogue.json';

/** Long enough to cover one recovery run end to end, short enough to still be true. */
export const TTL_MS = 5 * 60 * 1000;

/**
 * A hundred rows a request when the API is well, fifty when it is not.
 *
 * A page of a hundred is one large query and on a bad day it took longer than our
 * thirty-second deadline, so the whole scan failed rather than slowing down. Halving it
 * fixed that and doubled the request count for good. Asking for the larger page first and
 * stepping down only when it actually fails gets both: half the requests on a normal day,
 * and a scan that still completes on a bad one.
 */
export const PAGE_SIZES = [100, 50, 25];

/** Which size worked last, so a refusal is not re-learned on every scan. */
let lastGoodSize = 0;

/**
 * Sorted on created_at, and the whole list is walked.
 *
 * transaction_date is a date with no time on it, so the 235 invoices sharing 31 August all
 * compare equal and their order between two requests is unspecified. Paging through that
 * silently loses rows: a scan reported 2,024 invoices when Jurnal held 2,072, and the
 * recap built on it declared 27 sales uninvoiced that were invoiced all along. created_at
 * carries a timestamp, so it is effectively unique and the order holds still.
 *
 * The cost is that we can no longer stop early on reaching an older transaction_date -
 * creation order and transaction order are different things, especially after a
 * restatement rewrote August invoices today. So the list is walked to the end and filtered
 * here. At fifty a page that is about forty requests for two thousand invoices, once,
 * shared by every consumer.
 */
const SORT = 'sort_key=created_at&sort_order=desc';

/** @returns {{invoices: Array, at: string, since: string|null, requests: number}} */
async function scan(since, { deadlineAt = null, onProgress = () => {} } = {}) {
  const invoices = [];
  let requests = 0;
  let walked = 0;
  let sizeIndex = lastGoodSize;
  let expected = null;

  for (let page = 1; ; page += 1) {
    let result;
    for (;;) {
      try {
        result = await mekari({
          path: `${INVOICES_PATH}?page=${page}&page_size=${PAGE_SIZES[sizeIndex]}&${SORT}`,
          deadlineAt,
        });
        requests += 1;
        break;
      } catch (error) {
        // Step down and retry the same page rather than abandoning the scan. A smaller
        // page is a smaller query; the page number means something different at each
        // size, which is why the walk restarts from the top when the size changes.
        if (sizeIndex + 1 >= PAGE_SIZES.length) throw error;
        sizeIndex += 1;
        // Remembered for the rest of the process, because the next scan a minute later was
        // asking for a hundred again and paying the same restart from nothing. A page size
        // this API has already refused is not worth offering it twice.
        lastGoodSize = sizeIndex;
        requests += 1;
        page = 1;
        invoices.length = 0;
        console.warn(`mekari: halaman terlalu berat, turun ke ${PAGE_SIZES[sizeIndex]} baris - mulai ulang`);
      }
    }

    const rows = result?.sales_invoices ?? [];
    if (expected === null) expected = Number(result?.total_count);
    if (rows.length === 0) break;

    let seenAll = 0;
    for (const invoice of rows) {
      seenAll += 1;
      const date = jurnalDateToIso(invoice.transaction_date);
      if (since && date && date < since) continue;
      invoices.push({
        id: invoice.id,
        no: invoice.transaction_no,
        // Normalised, so an invoice written before the hash was dropped matches the key
        // we would generate for the same order today. Without this every historical
        // Shopify invoice reads as missing and gets written again.
        customId: normaliseCustomId(invoice.custom_id),
        rawCustomId: String(invoice.custom_id ?? ''),
        date,
        total: Math.round(Number(invoice.original_amount) || 0),
        remaining: Math.round(Number(invoice.remaining) || 0),
      });
    }
    walked += seenAll;
    onProgress({ page, invoices: invoices.length, requests });
    if (page >= (Number(result?.total_pages) || 1)) break;
  }

  // A scan that quietly came back short is worse than one that failed: everything built on
  // it looks like a finding. Jurnal's own count is the check, and it is free - it rides on
  // the first page.
  const complete = !Number.isFinite(expected) || walked >= expected;
  if (!complete) {
    console.warn(`mekari: pindai dapat ${walked} dari ${expected} faktur - hasil tidak lengkap`);
  }

  return { invoices, at: new Date().toISOString(), since: since ?? null, requests, walked, expected, complete };
}

/**
 * Jurnal's invoices from a date, from cache when it is fresh enough.
 *
 * @param {{since?: string|null, force?: boolean, deadlineAt?: number|null}} options
 * @returns {Promise<{invoices: Array, at: string, requests: number, cached: boolean}>}
 */
export async function invoiceCatalogue({ since = null, force = false, deadlineAt = null, onProgress } = {}) {
  // `since` is a calendar date, and the rows are filtered by comparing it against each
  // invoice's own 'YYYY-MM-DD'. An epoch number makes every one of those comparisons NaN,
  // which is false, so a cached scan of two thousand invoices comes back as none - and a
  // caller reports "nothing to fix" over a list it silently discarded. Refusing here costs
  // nothing and turns that into a stack trace with a name on it.
  if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(since))) {
    throw new TypeError(`invoiceCatalogue: since harus tanggal YYYY-MM-DD, dapat ${JSON.stringify(since)}`);
  }
  if (!force) {
    const held = await readDoc(CATALOGUE_PATHNAME).catch(() => null);
    const at = Date.parse(held?.at ?? '');
    // A cache covering a *later* start date cannot answer for an earlier one, so it is
    // only reused when its window begins at or before the one being asked for.
    const coversWindow = !since || (held?.since && held.since <= since);
    if (held?.invoices && Number.isFinite(at) && Date.now() - at < TTL_MS && coversWindow) {
      const invoices = since ? held.invoices.filter((i) => !i.date || i.date >= since) : held.invoices;
      return { invoices, at: held.at, requests: 0, cached: true };
    }
  }

  const fresh = await scan(since, { deadlineAt, onProgress });
  // An incomplete scan is never cached. Serving it again would spread one bad read across
  // every consumer for the next five minutes.
  if (fresh.complete) await writeDoc(CATALOGUE_PATHNAME, { version: 1, ...fresh }).catch(() => {});
  return { ...fresh, cached: false };
}

/**
 * Forget the cached scan.
 *
 * Called by anything that changes what Jurnal holds - a delete, a create, a payment -
 * because a cache that outlives the thing it describes is how a deduplicator ends up
 * deleting a row that is already gone.
 */
export const forgetCatalogue = () => writeDoc(CATALOGUE_PATHNAME, { version: 1, invoices: null, at: null }).catch(() => {});

/** Only the invoices this system wrote, keyed by custom_id, lowest id winning. */
export function ours(invoices) {
  const byCustomId = new Map();
  for (const invoice of invoices) {
    if (!/^TRL-/.test(invoice.customId)) continue;
    const held = byCustomId.get(invoice.customId);
    if (!held || invoice.id < held.id) byCustomId.set(invoice.customId, invoice);
  }
  return byCustomId;
}

/** Every custom_id Jurnal holds more than one invoice for, oldest kept. */
export function duplicates(invoices) {
  const seen = new Map();
  for (const invoice of invoices) {
    if (!/^TRL-/.test(invoice.customId)) continue;
    const list = seen.get(invoice.customId) ?? new Map();
    // Keyed by id: the same invoice read twice must never look like its own duplicate.
    list.set(invoice.id, invoice);
    seen.set(invoice.customId, list);
  }
  return [...seen.entries()]
    .filter(([, list]) => list.size > 1)
    .map(([customId, list]) => {
      const sorted = [...list.values()].sort((a, b) => a.id - b.id);
      return { customId, keep: sorted[0], drop: sorted.slice(1) };
    })
    .filter((g) => g.drop.length > 0 && g.drop.every((d) => d.id !== g.keep.id));
}
