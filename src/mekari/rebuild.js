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
      const customId = normaliseCustomId(inv.custom_id);
      const m = /^TRL-([a-z_]+)-(.+)$/.exec(customId);
      if (!m) continue;
      found[customId] = {
        invoice_id: inv.id,
        channel: m[1],
        order_id: m[2],
        total: Math.round(Number(inv.original_amount)),
        at: inv.created_at ?? new Date().toISOString(),
        rebuilt: true,
      };
    }
    pages = Number(r.total_pages) || 1;
    if (reachedStart || page >= pages || rows.length === 0) break;
    page += 1;
  }

  const current = await loadSyncLedger();
  const before = Object.keys(current.orders ?? {}).length;
  const added = Object.keys(found).filter((k) => !current.orders?.[k]);
  if (!dryRun) {
    current.orders = { ...found, ...(current.orders ?? {}) };
    await saveSyncLedger(current);
  }
  return { dryRun, since, inJurnal: Object.keys(found).length, before, added: added.length, pagesRead: page, pages };
}
