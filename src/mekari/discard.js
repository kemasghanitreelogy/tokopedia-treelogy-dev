import { mekari } from './client.js';
import { customIdFor } from './invoice.js';
import { loadSyncLedger, saveSyncLedger } from './sync.js';
import { orderById, deleteOrder } from '../db/orders.js';
import { isManualSource } from './prefix.js';
import { invalidate } from '../cache.js';

/**
 * Throwing away a sale that was typed in by mistake.
 *
 * A typed-in transaction is the only kind of order that exists because somebody said so.
 * A marketplace order deleted here would simply come back on the next sweep, and should:
 * it describes something that happened whether or not we like it. A consignment slip
 * entered twice, or against the wrong shop, describes nothing at all - and until now the
 * only way to take it back was to open Jurnal and delete the invoice by hand, which left
 * our own table still listing it.
 *
 * So it is two removals that have to agree, and the order they happen in is the whole
 * design: the invoice goes first. If Jurnal refuses - because somebody has recorded a
 * payment against it - nothing else happens and the operator is told why. Dropping our
 * row first and then failing would leave a sale in the books that no screen here can see,
 * which is the one outcome worse than not being able to delete it.
 */

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';

/**
 * Whether Jurnal will let this invoice go, and why not when it will not.
 *
 * The same two authorities the cancellation path uses: money actually received against
 * it, and Jurnal's own `deletable`. A missing answer is not permission - an invoice that
 * declined to say whether it had been paid is not one to delete on the assumption that it
 * had not been.
 */
export function refusalFor(invoice) {
  const stated = invoice?.payment_received_amount;
  const received = stated === undefined || stated === null || stated === '' ? null : Math.round(Number(stated));
  if ((received ?? 0) > 0) {
    return `faktur ${invoice.transaction_no ?? ''} sudah menerima pembayaran Rp${(received ?? 0).toLocaleString('id-ID')} - buat retur atau nota kredit di Jurnal, jangan dihapus`;
  }
  if (invoice?.deletable === false) {
    return `Jurnal menolak menghapus faktur ${invoice.transaction_no ?? ''} - ada sesuatu yang menahannya di sana`;
  }
  const answered = invoice?.has_payments === false
    || Number.isFinite(received)
    || typeof invoice?.deletable === 'boolean';
  if (!answered) {
    return `faktur ${invoice?.transaction_no ?? ''} tidak menyebut status pembayaran - tidak dihapus tanpa bukti bahwa belum ada pembayaran`;
  }
  return null;
}

/**
 * @param {string} id  the transaction code, as it is shown - "CS-260929-00002GP"
 * @returns {Promise<{id: string, total: number, invoiceId: number|null, transactionNo: string|null,
 *   removedFromList: boolean, wasInvoiced: boolean}>}
 */
export async function discardManual(id, {
  read = orderById, drop = deleteOrder, call = mekari,
  loadLedger = loadSyncLedger, saveLedger = saveSyncLedger,
} = {}) {
  const code = String(id ?? '').trim();
  if (!code) throw new Error('tidak ada transaksi yang disebut');

  const order = await read('manual', code);
  // The prefix is what makes a code a typed-in sale, and it is checked rather than
  // trusted: a form that said manual and named a marketplace order must not be able to
  // delete that order's invoice.
  if (!order) throw new Error(`transaksi ${code} tidak ada di daftar`);
  if (order.channel !== 'manual' || !isManualSource(String(order.source ?? '').toUpperCase())) {
    throw new Error(`${code} bukan transaksi yang diketik manual`);
  }

  const customId = customIdFor(order);
  const ledger = await loadLedger().catch(() => ({ orders: {} }));
  const entry = ledger.orders?.[customId] ?? null;
  const invoiceId = entry?.voided ? null : (entry?.invoice_id ?? null);

  let transactionNo = null;
  if (invoiceId) {
    const found = await call({ path: `${INVOICES_PATH}/${invoiceId}` });
    const invoice = found?.sales_invoice ?? found;
    const refusal = refusalFor(invoice);
    if (refusal) throw new Error(refusal);
    transactionNo = invoice?.transaction_no ?? null;

    await call({ method: 'DELETE', path: `${INVOICES_PATH}/${invoiceId}` });

    // Written the moment it is true. A crash between the delete and this line would leave
    // the ledger claiming an invoice that no longer exists, and the next reconcile would
    // report it missing - noise about something that was removed on purpose.
    ledger.orders[customId] = { ...entry, voided: true, voided_at: new Date().toISOString(), discarded_by_operator: true };
    await saveLedger(ledger);
  }

  const removed = await drop('manual', code);

  invalidate('orders');
  invalidate('jurnal');

  return {
    id: code,
    total: Number(order.total) || 0,
    invoiceId,
    transactionNo,
    wasInvoiced: Boolean(invoiceId),
    removedFromList: removed > 0,
  };
}
