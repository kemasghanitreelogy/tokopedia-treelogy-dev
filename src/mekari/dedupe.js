import { mekari } from './client.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { jurnalDateToIso } from './rebuild.js';

/**
 * Fifty, not a hundred.
 *
 * A page of a hundred invoices is one large query, and on an API having a bad day it took
 * longer than our thirty-second deadline - so the whole scan failed rather than slowing
 * down. Halving the page halves the work per request; with a budget of ninety requests a
 * minute the extra round trips cost nothing worth having.
 */
const PAGE_SIZE = 50;

/**
 * Find and remove invoices that exist more than once.
 *
 * They should be impossible. Every invoice this system writes carries a custom_id of the
 * form TRL-<channel>-<order id>, and the single-invoice endpoint rejects a repeat with
 * 409. batch_create does not - it will happily write the same custom_id twice - and a
 * create that times out at our end after Jurnal has already processed it, then gets
 * retried, is exactly how that happens. 472 invoices became 891 that way.
 *
 * The keeper is the oldest: it is the one whose id anything else may already be pointing
 * at, and keeping the newest would invalidate a ledger that was right.
 */

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';

/**
 * @param {{since?: string|null, deadlineAt?: number|null}} options
 * @returns {Promise<{scanned: number, ours: number, groups: Array, extra: number}>}
 */
export async function findDuplicates({ since = null, deadlineAt = null } = {}) {
  const byCustomId = new Map();
  let scanned = 0;

  for (let page = 1; ; page += 1) {
    const result = await mekari({
      path: `${INVOICES_PATH}?page=${page}&page_size=${PAGE_SIZE}&sort_key=transaction_date&sort_order=desc`,
      deadlineAt,
    });
    const rows = result?.sales_invoices ?? [];
    let reachedStart = false;

    for (const invoice of rows) {
      scanned += 1;
      const day = jurnalDateToIso(invoice.transaction_date);
      if (since && day && day < since) { reachedStart = true; continue; }
      const customId = String(invoice.custom_id ?? '');
      if (!/^TRL-/.test(customId)) continue;
      // Keyed by invoice id, not pushed onto a list.
      //
      // Paging through a list while deleting from it shifts rows between pages, so the
      // same invoice can be read twice - and a list would then show it as a duplicate of
      // itself, keep one copy and delete "the other", which is the same row. That is not
      // hypothetical: it removed around five hundred invoices before it was caught.
      const seen = byCustomId.get(customId) ?? new Map();
      seen.set(invoice.id, { id: invoice.id, no: invoice.transaction_no, date: day, amount: Math.round(Number(invoice.original_amount) || 0) });
      byCustomId.set(customId, seen);
    }

    const pages = Number(result?.total_pages) || 1;
    if (reachedStart || page >= pages || rows.length === 0) break;
  }

  const groups = [...byCustomId.entries()]
    .filter(([, seen]) => seen.size > 1)
    .map(([customId, seen]) => {
      // Oldest first: the keeper is the one anything else may already point at.
      const sorted = [...seen.values()].sort((a, b) => a.id - b.id);
      return { customId, keep: sorted[0], drop: sorted.slice(1) };
    })
    // A group whose "copies" are the keeper itself is not a group. Belt and braces on top
    // of the Map above, because the cost of getting this wrong is a deleted invoice.
    .filter((g) => g.drop.length > 0 && g.drop.every((d) => d.id !== g.keep.id));

  return {
    scanned,
    ours: byCustomId.size,
    groups,
    extra: groups.reduce((n, g) => n + g.drop.length, 0),
  };
}

/**
 * @param {{since?: string|null, dryRun?: boolean, onProgress?: Function}} options
 */
export async function removeDuplicates({ since = null, dryRun = true, onProgress = () => {} } = {}) {
  // The whole scan completes before a single delete is sent. Interleaving them is what
  // made rows shift under the pagination in the first place; a plan built from one
  // consistent read cannot describe an invoice as its own duplicate.
  const found = await findDuplicates({ since });
  if (dryRun) return { ...found, dryRun: true, removed: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('hapus faktur kembar');

  let removed = 0;
  const failures = [];
  for (const group of found.groups) {
    for (const copy of group.drop) {
      if (copy.id === group.keep.id) continue; // cannot happen; the cost if it did is the invoice
      try {
        await mekari({ method: 'DELETE', path: `${INVOICES_PATH}/${copy.id}` });
        removed += 1;
        onProgress({ removed, of: found.extra, customId: group.customId, id: copy.id });
      } catch (error) {
        failures.push({ customId: group.customId, id: copy.id, error: error.message });
      }
    }
  }
  return { ...found, dryRun: false, removed, failures };
}
