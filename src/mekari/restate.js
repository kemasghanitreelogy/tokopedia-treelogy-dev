import { mekari } from './client.js';
import { loadSyncLedger, saveSyncLedger, forgetSyncLedgerEntries } from './sync.js';
import { buildInvoice, verifyInvoice, customIdFor, InvoiceError } from './invoice.js';
import { ordersInRange } from '../db/orders.js';
import { isAutoPaid, receivableFor } from './sources.js';
import { postingAccounts } from './accounts.js';
import { alignReceivables } from './receivables.js';
import { customerFor } from './invoice.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { wibDayStart, wibDate } from '../range.js';

/**
 * Re-book invoices that were written under rules that have since changed.
 *
 * Jurnal has no way to move an invoice between receivable accounts, or to re-post one
 * whose shipping went to the wrong account: the journal entry is made when the invoice is
 * created and the payload carries no account anywhere. Restating therefore means deleting
 * and writing again. That is destructive - the old Sales Invoice numbers are gone for
 * good - so nothing here happens without --yes, and the plan is printed first.
 *
 * The orders come from Postgres, not from the marketplaces: the database already holds
 * every sale since 1 August, so rebuilding six weeks of books costs no marketplace quota
 * at all and takes about a second to assemble.
 *
 * Writing back uses batch_create. One request carries fifty invoices instead of one, which
 * is the difference between spending three hundred of the month's API calls and spending
 * seven - and the monthly package is the binding constraint on this whole integration.
 */


/**
 * Does this error mean the invoice is not there?
 *
 * Jurnal answers 422 "Data not found" where most APIs answer 404, which this codebase has
 * been caught by before. Both are accepted, and the body is checked too, because a 422 is
 * otherwise a validation failure and swallowing those would hide real problems.
 */
function isMissing(error) {
  if (error?.status === 404) return true;
  return error?.status === 422 && /data not found/i.test(JSON.stringify(error?.body ?? error?.message ?? ''));
}

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';

/** Fifty per request. Large enough to matter, small enough that one rejection is cheap to redo. */
export const BATCH = 50;

/**
 * What would be deleted and rewritten, read entirely from local state.
 *
 * @param {{from: string}} options `from` is a WIB calendar date, YYYY-MM-DD
 */
export async function planRestatement({ from }) {
  const since = wibDayStart(from);
  if (since === null) throw new Error(`tanggal tidak valid: ${from}`);
  const until = Math.floor(Date.now() / 1000);

  // The chart of accounts decides where a marketplace settlement is deposited, so a
  // restatement that could not read it would rewrite every paid invoice as an open one.
  const [ledger, orders, accounts] = await Promise.all([
    loadSyncLedger(), ordersInRange({ since, until }), postingAccounts(),
  ]);

  const byCustomId = new Map(orders.map((order) => [customIdFor(order), order]));
  const entries = Object.entries(ledger.orders ?? {});

  const doomed = [];
  for (const [customId, row] of entries) {
    // Only what this system posted, and only inside the window. An invoice somebody
    // entered in Jurnal by hand is not ours to delete.
    if (!row?.invoice_id || row.voided) continue;
    const order = byCustomId.get(customId);
    if (!order) continue;
    doomed.push({ customId, invoiceId: row.invoice_id, order, total: row.total ?? 0 });
  }

  const rebuildable = [];
  const unbuildable = [];
  for (const item of doomed) {
    try {
      const payload = buildInvoice({ order: item.order, accounts });
      verifyInvoice(payload, payload.expectedTotal, item.order);
      rebuildable.push({ ...item, payload });
    } catch (error) {
      unbuildable.push({ ...item, error: error instanceof InvoiceError ? error.message : String(error.message) });
    }
  }

  // Which customer belongs in which receivable. Most of the cost of a restatement lives
  // here rather than in the invoices: the account is a property of the customer, so 462
  // invoices are 450 customers to move first.
  const receivables = new Map();
  for (const item of rebuildable) receivables.set(customerFor(item.order), receivableFor(item.order));

  return {
    from,
    since,
    until,
    receivables,
    ordersInWindow: orders.length,
    ledgerEntries: entries.length,
    doomed: doomed.length,
    rebuildable,
    unbuildable,
    // What the operator actually pays for: five to read the customers, one patch each,
    // one delete each, then one request per fifty written back.
    apiCalls: 5 + receivables.size + doomed.length + Math.ceil(rebuildable.length / BATCH),
    autoPaid: rebuildable.filter((r) => isAutoPaid(r.order)).length,
  };
}

/**
 * Take the old invoices out of Jurnal, and out of the ledger as we go.
 *
 * Its own function because everything that can go wrong in a restatement goes wrong here,
 * and the three ways it can are all silent unless they are handled apart:
 *
 *   a refused DELETE  the invoice is still in Jurnal. It must NOT be written again -
 *                     batch_create does not reject a repeated custom_id, so a rewrite
 *                     makes a second copy of the sale rather than replacing one. Only
 *                     what actually went is returned as rewritable.
 *   an unreachable store  the forget used to sit outside any try. A store down for a few
 *                     seconds threw straight out of the loop: invoices already deleted
 *                     from Jurnal, the ledger still naming them, and no rewrite, because
 *                     the throw skipped it - the exact "silently missing sales" state
 *                     forgetSyncLedgerEntries was written to prevent. Now the deleting
 *                     stops there, and what has already gone is still handed back to be
 *                     written, which is what puts the ledger right: a fresh invoice id
 *                     overwrites the stale entry.
 *   an invoice already gone  the state we were trying to reach, so not a failure at all.
 *
 * @param {{items: Array, ledger: object, del?: Function, forget?: Function, onProgress?: Function}} input
 */
export async function clearFromJurnal({
  items,
  ledger,
  del = (invoiceId) => mekari({ method: 'DELETE', path: `${INVOICES_PATH}/${invoiceId}` }),
  forget = forgetSyncLedgerEntries,
  onProgress = () => {},
}) {
  const rewritable = [];
  const failures = [];
  let deleted = 0;
  let alreadyGone = 0;
  let processed = 0;
  let storeFailure = null;

  for (const item of items) {
    processed += 1;
    try {
      await del(item.invoiceId);
      deleted += 1;
    } catch (error) {
      // Jurnal says "already gone" with 422 "Data not found", not 404 - a quirk this
      // codebase has met before, and one worth matching on the status rather than on the
      // words, because a message that happens to contain "not found" is luck, not a rule.
      if (!isMissing(error)) {
        failures.push({ customId: item.customId, stage: 'hapus', error: error.message });
        continue;
      }
      alreadyGone += 1;
    }
    // Past this line the invoice is not in Jurnal, so this order has to be written again
    // whatever happens to the ledger next. Recorded before the store is touched, for
    // exactly that reason.
    rewritable.push(item);
    delete ledger.orders[item.customId];
    try {
      // Through the one call that can actually remove: saveSyncLedger takes the union of
      // what is stored and what the caller holds, so a deletion written through it comes
      // straight back.
      await forget([item.customId]);
    } catch (error) {
      // Every later forget would fail the same way and each one widens the gap between
      // what Jurnal holds and what the ledger claims, so this is where the deleting ends.
      storeFailure = error.message;
      failures.push({ customId: item.customId, stage: 'lupakan', error: error.message });
      break;
    }
    onProgress({ stage: 'hapus', customId: item.customId, deleted, alreadyGone, processed, of: items.length });
  }

  return { rewritable, deleted, alreadyGone, failures, storeFailure };
}

/**
 * Delete, then write again.
 *
 * Deliberately sequenced delete-all-then-create-all rather than pairwise. A pairwise loop
 * that dies in the middle leaves the books half restated with no way to tell which half;
 * this way the ledger is emptied of exactly what was deleted as it goes, so a run that
 * stops can be run again and picks up from where it stood.
 *
 * Only what was actually deleted is written back. The two sets look identical and are not:
 * a refused DELETE leaves the invoice in Jurnal, and batch_create will happily add a
 * second one beside it.
 */
export async function restate({ from, dryRun = true, onProgress = () => {} }) {
  const plan = await planRestatement({ from });
  if (dryRun) return { ...plan, dryRun: true, deleted: 0, created: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('restate faktur Jurnal');

  // Customers first, and before a single invoice is touched.
  //
  // The order matters and is not arbitrary: an invoice posts its receivable at the moment
  // it is created, from whatever account the customer carries then. Rewrite the invoices
  // before moving the customers and all 462 land in 1100 again - the whole exercise
  // spent, and nothing changed.
  const aligned = await alignReceivables(plan.receivables, {
    dryRun: false,
    onProgress: (p) => onProgress({ stage: 'piutang', ...p }),
  });

  const ledger = await loadSyncLedger();
  const failures = [];
  for (const f of aligned.failures) failures.push({ customId: f.name, stage: 'piutang', error: f.error });

  // Only what can be written again is deleted in the first place.
  //
  // This used to delete plan.unbuildable too, while nothing ever rewrote it - so an order
  // whose invoice cannot be built (an unmapped SKU, a negative price) was deleted from
  // Jurnal and never replaced. A real sale erased, and the sweep could not restore it
  // because it fails to build for the same reason every time.
  //
  // An invoice that cannot be rebuilt stays exactly where it is. It is reported instead,
  // which is the only honest thing to do about a sale nobody can express yet.
  const all = plan.rebuildable;
  const cleared = await clearFromJurnal({ items: all, ledger, onProgress });
  const { rewritable, deleted, alreadyGone } = cleared;
  let storeFailure = cleared.storeFailure;
  for (const f of cleared.failures) failures.push(f);

  let created = 0;
  for (let i = 0; i < rewritable.length; i += BATCH) {
    const slice = rewritable.slice(i, i + BATCH);
    let response;
    try {
      response = await mekari({
        method: 'POST',
        path: `${INVOICES_PATH}/batch_create`,
        body: { sales_invoices: slice.map((item) => ({ sales_invoice: item.payload.sales_invoice })) },
      });
    } catch (error) {
      for (const item of slice) failures.push({ customId: item.customId, stage: 'buat', error: error.message });
      continue;
    }

    const rows = response?.sales_invoices ?? [];
    slice.forEach((item, index) => {
      const result = rows[index]?.sales_invoice;
      const id = result?.content?.id;
      if (!id) {
        failures.push({ customId: item.customId, stage: 'buat', error: `status ${result?.status ?? '?'}` });
        return;
      }
      ledger.orders[item.customId] = {
        invoice_id: id,
        channel: item.order.channel,
        order_id: item.order.id,
        total: item.payload.expectedTotal,
        at: new Date().toISOString(),
      };
      created += 1;
    });
    try {
      await saveSyncLedger(ledger);
    } catch (error) {
      // Fifty invoices that exist in Jurnal and are not in the ledger. The sweep recovers
      // from that on its own - it posts through the single-invoice endpoint, which refuses
      // a repeated custom_id with 409 and hands back the id - so this is reported and the
      // run carries on rather than throwing away the record of the batches that did land.
      storeFailure = error.message;
      for (const item of slice) failures.push({ customId: item.customId, stage: 'catat', error: error.message });
    }
    onProgress({ stage: 'buat', created, of: rewritable.length });
  }

  return {
    ...plan, dryRun: false, aligned, deleted, alreadyGone, created, failures,
    // Still in Jurnal because the delete was refused, so deliberately not rewritten.
    notDeleted: all.length - rewritable.length,
    storeFailure,
  };
}

export { wibDate };
