import { mekari } from './client.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { invoiceCatalogue, duplicates, ours, forgetCatalogue } from './catalogue.js';

/**
 * Fifty, not a hundred.
 *
 * A page of a hundred invoices is one large query, and on an API having a bad day it took
 * longer than our thirty-second deadline - so the whole scan failed rather than slowing
 * down. Halving the page halves the work per request; with a budget of ninety requests a
 * minute the extra round trips cost nothing worth having.
 */

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
 * Groups of invoices sharing a custom_id, through the shared scan.
 *
 * @param {{since?: string|null, deadlineAt?: number|null}} options
 */
export async function findDuplicates({ since = null, deadlineAt = null } = {}) {
  const { invoices, cached, requests } = await invoiceCatalogue({ since, deadlineAt });
  const groups = duplicates(invoices);
  return {
    scanned: invoices.length,
    ours: ours(invoices).size,
    groups,
    extra: groups.reduce((n, g) => n + g.drop.length, 0),
    cached,
    requests,
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
  // Whatever happens below changes what Jurnal holds, so the cached reading of it stops
  // being true the moment the first delete lands.
  await forgetCatalogue();
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
