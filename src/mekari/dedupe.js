import { mekari } from './client.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { jurnalDateToIso } from './rebuild.js';

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
      path: `${INVOICES_PATH}?page=${page}&page_size=100&sort_key=transaction_date&sort_order=desc`,
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
      const list = byCustomId.get(customId) ?? [];
      list.push({ id: invoice.id, no: invoice.transaction_no, date: day, amount: Math.round(Number(invoice.original_amount) || 0) });
      byCustomId.set(customId, list);
    }

    const pages = Number(result?.total_pages) || 1;
    if (reachedStart || page >= pages || rows.length === 0) break;
  }

  const groups = [...byCustomId.entries()]
    .filter(([, list]) => list.length > 1)
    // Oldest first, so the keeper is at the head and the rest are what goes.
    .map(([customId, list]) => ({ customId, keep: [...list].sort((a, b) => a.id - b.id)[0], drop: [...list].sort((a, b) => a.id - b.id).slice(1) }));

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
  const found = await findDuplicates({ since });
  if (dryRun) return { ...found, dryRun: true, removed: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('hapus faktur kembar');

  let removed = 0;
  const failures = [];
  for (const group of found.groups) {
    for (const copy of group.drop) {
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
