import { mekari } from './client.js';
import { loadSyncLedger, saveSyncLedger } from './sync.js';
import { buildInvoice, verifyInvoice, customIdFor, InvoiceError } from './invoice.js';
import { ordersInRange } from '../db/orders.js';
import { isAutoPaid, receivableFor } from './sources.js';
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

  const [ledger, orders] = await Promise.all([loadSyncLedger(), ordersInRange({ since, until })]);

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
      const payload = buildInvoice({ order: item.order, depositTo: depositAccount() });
      verifyInvoice(payload, payload.expectedTotal);
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

const depositAccount = () => process.env.MEKARI_DEPOSIT_ACCOUNT || null;

/**
 * Delete, then write again.
 *
 * Deliberately sequenced delete-all-then-create-all rather than pairwise. A pairwise loop
 * that dies in the middle leaves the books half restated with no way to tell which half;
 * this way the ledger is emptied of exactly what was deleted as it goes, so a run that
 * stops can be run again and picks up from where it stood.
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
  let deleted = 0;
  const failures = [];
  for (const f of aligned.failures) failures.push({ customId: f.name, stage: 'piutang', error: f.error });

  for (const item of plan.rebuildable.concat(plan.unbuildable)) {
    try {
      await mekari({ method: 'DELETE', path: `${INVOICES_PATH}/${item.invoiceId}` });
      deleted += 1;
    } catch (error) {
      // A 404 means somebody already removed it, which is the state we wanted.
      if (!/not found|404/i.test(error.message)) {
        failures.push({ customId: item.customId, stage: 'hapus', error: error.message });
        continue;
      }
    }
    delete ledger.orders[item.customId];
    // Saved as we go: a run that stops halfway must not claim invoices still exist.
    await saveSyncLedger(ledger);
    onProgress({ stage: 'hapus', customId: item.customId, deleted });
  }

  let created = 0;
  for (let i = 0; i < plan.rebuildable.length; i += BATCH) {
    const slice = plan.rebuildable.slice(i, i + BATCH);
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
    await saveSyncLedger(ledger);
    onProgress({ stage: 'buat', created, of: plan.rebuildable.length });
  }

  return { ...plan, dryRun: false, aligned, deleted, created, failures };
}

export { wibDate };
