import { mekari } from './client.js';
import { loadSyncLedger, saveSyncLedger } from './sync.js';

/**
 * Rebuild the invoice ledger from Jurnal itself.
 *
 * The ledger was designed to be derivable: every invoice carries a `custom_id` of the
 * form TRL-<channel>-<order id>, so the books are the source of truth and the ledger is
 * only a cache of them. That is what makes losing the ledger - as happened when the Blob
 * store was suspended - an inconvenience rather than a disaster: walk the invoices, and
 * every order that was ever posted is known again, with its invoice id and amount.
 */
export async function rebuildLedgerFromJurnal({ dryRun = true } = {}) {
  const found = {};
  let page = 1;
  let pages = 1;
  for (;;) {
    const r = await mekari({ path: `/public/jurnal/api/v1/sales_invoices?page=${page}&page_size=100` });
    for (const inv of r.sales_invoices ?? []) {
      const customId = String(inv.custom_id ?? '');
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
    if (page >= pages) break;
    page += 1;
  }

  const current = await loadSyncLedger();
  const before = Object.keys(current.orders ?? {}).length;
  const added = Object.keys(found).filter((k) => !current.orders?.[k]);
  if (!dryRun) {
    current.orders = { ...found, ...(current.orders ?? {}) };
    await saveSyncLedger(current);
  }
  return { dryRun, inJurnal: Object.keys(found).length, before, added: added.length, pages };
}
