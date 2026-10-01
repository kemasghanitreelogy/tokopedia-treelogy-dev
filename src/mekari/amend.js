import { mekari } from './client.js';
import { buildInvoice, verifyInvoice, customIdFor } from './invoice.js';
import { loadSyncLedger, saveSyncLedger } from './sync.js';
import { postingAccounts } from './accounts.js';
import { forgetCatalogue } from './catalogue.js';
import { refusalFor } from './discard.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';

/**
 * Correcting an invoice in place, rather than deleting it and writing another.
 *
 * Jurnal's PATCH on a sales invoice takes the whole thing - transaction_lines_attributes
 * included - so an edited sale keeps its Sales Invoice number, its place in the sequence
 * and whatever anybody has already written down about it. That matters: a WhatsApp
 * customer who adds a jar mid-conversation should not cause an invoice number to vanish
 * from the books and another to appear.
 *
 * The same thing is rebuilt from the same builder the create path uses, so an amended
 * invoice is byte-for-byte what a fresh one would have been. Nothing bespoke is sent.
 *
 * What it refuses is what the delete path refuses, for the same reason: an invoice with a
 * payment recorded against it has a counterpart in the bank, and rewriting its lines
 * would leave that payment attached to a sale that no longer says what it said.
 */

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';

/**
 * @param {object} order  the rebuilt order, already carrying the edit
 * @returns {Promise<{customId: string, invoiceId: number|null, transactionNo: string|null,
 *   total: number, amended: boolean}>}
 */
export async function amendManualInvoice(order, {
  accounts = null, call = mekari, loadLedger = loadSyncLedger, saveLedger = saveSyncLedger, forget = forgetCatalogue,
} = {}) {
  const customId = customIdFor(order);
  const ledger = await loadLedger().catch(() => ({ orders: {} }));
  const entry = ledger.orders?.[customId] ?? null;
  const invoiceId = entry?.voided ? null : (entry?.invoice_id ?? null);

  const chart = accounts ?? await postingAccounts();
  const built = buildInvoice({ order, accounts: chart });
  // The same check the create path makes, on the same builder: an invoice whose lines do
  // not add up to its own total is one nobody can explain afterwards.
  verifyInvoice(built, built.expectedTotal);

  // Nothing in Jurnal to correct. The caller decides whether that means "post it now" or
  // "leave it"; here it simply means there was no invoice to rewrite.
  if (!invoiceId) return { customId, invoiceId: null, transactionNo: null, total: built.expectedTotal, amended: false };

  if (isReadOnly()) throw new ReadOnlyError(`ubah faktur ${customId}`);

  const found = await call({ path: `${INVOICES_PATH}/${invoiceId}` });
  const invoice = found?.sales_invoice ?? found;
  const refusal = refusalFor(invoice);
  if (refusal) throw new Error(refusal);

  await call({ method: 'PATCH', path: `${INVOICES_PATH}/${invoiceId}`, body: { sales_invoice: built.sales_invoice } });

  ledger.orders[customId] = {
    ...entry,
    total: built.expectedTotal,
    amended_at: new Date().toISOString(),
  };
  await saveLedger(ledger);

  // The cached scan still holds the figures this invoice had a moment ago, and anything
  // that changes what Jurnal holds has to drop it - otherwise the next reconcile, recap
  // and dedupe all read the amount this edit just corrected away.
  await forget().catch(() => {});

  return {
    customId,
    invoiceId,
    transactionNo: invoice?.transaction_no ?? null,
    total: built.expectedTotal,
    amended: true,
  };
}
