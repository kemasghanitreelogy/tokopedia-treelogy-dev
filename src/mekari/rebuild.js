import { normaliseCustomId } from './invoice.js';
import { mekari } from './client.js';
import { loadSyncLedger, saveSyncLedger } from './sync.js';

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
 * Rebuild the invoice ledger from Jurnal itself.
 *
 * The ledger was designed to be derivable: every invoice carries a `custom_id` of the
 * form TRL-<channel>-<order id>, so the books are the source of truth and the ledger is
 * only a cache of them. That is what makes losing the ledger - as happened when the Blob
 * store was suspended - an inconvenience rather than a disaster: walk the invoices, and
 * every order that was ever posted is known again, with its invoice id and amount.
 */
/**
 * Jurnal writes dates as DD/MM/YYYY, which Date.parse reads as month-first or not at all.
 * Getting this wrong would silently stop the walk on the first page for most of the year.
 */
export function jurnalDateToIso(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * One Jurnal invoice as a ledger entry, or null when it is not one of ours.
 *
 * @returns {{customId: string, entry: object}|null}
 */
export function rebuiltEntry(inv) {
  const customId = normaliseCustomId(inv?.custom_id);
  const m = /^TRL-([a-z_]+)-(.+)$/.exec(customId);
  if (!m) return null;
  // An amount Jurnal did not send as a number must not become one. Math.round(NaN) is NaN,
  // NaN serialises to null, and the entry then reads as an invoice worth nothing at all -
  // which is exactly the shape a zero-value sale has, so nobody would ever look at it.
  // Null says "unknown" out loud, and the count in the summary says how many.
  //
  // Empty and absent go the same way rather than through Number(), which reads both as
  // zero. A field Jurnal left out is the one case where "nothing" and "nought" are most
  // easily confused and least alike.
  const raw = inv.original_amount;
  const amount = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
  return {
    customId,
    entry: {
      invoice_id: inv.id,
      channel: m[1],
      order_id: m[2],
      total: Number.isFinite(amount) ? Math.round(amount) : null,
      at: inv.created_at ?? new Date().toISOString(),
      rebuilt: true,
    },
  };
}

/**
 * The ledger as the books would have it, with what only we know left intact.
 *
 * Jurnal wins on the facts it owns - which invoice, for how much - because this tool
 * exists precisely for the day the stored entry is wrong, and the spread this used to be
 * written as let every stored entry overwrite what the books said. A rebuild that cannot
 * correct anything is a rebuild that only ever fills in gaps.
 *
 * What Jurnal does not own is what happened afterwards in our own workflow: `voided`,
 * `needs_review`, `mismatch`. Those survive, so recovering the ledger does not also
 * re-open a cancellation somebody has already dealt with.
 */
export function mergeRebuilt(stored, found) {
  const orders = { ...(stored ?? {}) };
  for (const [customId, entry] of Object.entries(found ?? {})) {
    orders[customId] = orders[customId] ? { ...orders[customId], ...entry } : entry;
  }
  return orders;
}

/**
 * @param {{dryRun?: boolean, since?: string|null}} options
 *   `since` is a WIB calendar date; pages are walked newest-first and the walk stops as
 *   soon as one ends before it. On books with a year of history that is the difference
 *   between five requests and fifty, and requests are the scarce thing here.
 */
export async function rebuildLedgerFromJurnal({ dryRun = true, since = null } = {}) {
  const found = {};
  let page = 1;
  let pages = 1;
  for (;;) {
    const r = await mekari({
      path: `/public/jurnal/api/v1/sales_invoices?page=${page}&page_size=${PAGE_SIZE}&sort_key=transaction_date&sort_order=desc`,
    });
    const rows = r.sales_invoices ?? [];
    let reachedStart = false;
    for (const inv of rows) {
      const iso = jurnalDateToIso(inv.transaction_date);
      if (since && iso && iso < since) { reachedStart = true; continue; }
      const ours = rebuiltEntry(inv);
      if (!ours) continue;
      found[ours.customId] = ours.entry;
    }
    pages = Number(r.total_pages) || 1;
    if (reachedStart || page >= pages || rows.length === 0) break;
    page += 1;
  }

  const current = await loadSyncLedger();
  const before = Object.keys(current.orders ?? {}).length;
  const added = Object.keys(found).filter((k) => !current.orders?.[k]);
  const unreadable = Object.values(found).filter((entry) => entry.total === null).length;
  // Entries the books and the ledger disagree about, which is the whole reason to run this.
  const corrected = Object.entries(found)
    .filter(([k, entry]) => current.orders?.[k] && (current.orders[k].invoice_id !== entry.invoice_id || current.orders[k].total !== entry.total))
    .map(([k]) => k);
  if (!dryRun) {
    current.orders = mergeRebuilt(current.orders, found);
    await saveSyncLedger(current);
  }
  return {
    dryRun, since, inJurnal: Object.keys(found).length, before, added: added.length,
    corrected: corrected.length, unreadable, pagesRead: page, pages,
  };
}
