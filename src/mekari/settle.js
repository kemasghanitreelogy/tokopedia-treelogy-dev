import { mekari } from './client.js';
import { sourceOf } from './sources.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { jurnalDateToIso } from './rebuild.js';

/**
 * Settle the invoices that were raised before there was an account to settle them into.
 *
 * A marketplace order is paid before it ever ships, so its invoice is raised and settled
 * in the same breath - deposit_to_name on the create does both. That only works if the
 * account is configured, and MEKARI_DEPOSIT_ACCOUNT was not set until part-way through
 * this integration. Every invoice written before then is sitting open: eleven of them,
 * all Shopee, Tokopedia and TikTok Shop, none from the sources that are meant to stay
 * open, overstating receivables by their whole value.
 *
 * Only the sources that really are settled by the platform are touched. A consignment
 * shop or a walk-in is open because nobody has paid yet, and marking those paid would be
 * inventing a payment.
 */

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';
const PAYMENTS_PATH = '/public/jurnal/api/v1/receive_payments';
const PAGE_SIZE = 50;

const depositAccount = () => process.env.MEKARI_DEPOSIT_ACCOUNT || null;

/** The channel an invoice belongs to, read back out of the custom_id we wrote. */
export function channelOfCustomId(customId) {
  const m = /^TRL-([a-z_]+)-/.exec(String(customId ?? ''));
  return m ? m[1] : null;
}

/**
 * Every invoice with something still owing on it.
 *
 * @returns {Promise<Array<{id, no, customId, date, remaining, total, channel, autoPaid}>>}
 */
export async function openInvoices({ since = null, deadlineAt = null } = {}) {
  const open = [];
  for (let page = 1; ; page += 1) {
    const result = await mekari({
      path: `${INVOICES_PATH}?page=${page}&page_size=${PAGE_SIZE}&sort_key=transaction_date&sort_order=desc`,
      deadlineAt,
    });
    const rows = result?.sales_invoices ?? [];
    if (rows.length === 0) break;

    for (const invoice of rows) {
      const date = jurnalDateToIso(invoice.transaction_date);
      if (since && date && date < since) continue;
      const remaining = Math.round(Number(invoice.remaining) || 0);
      if (remaining <= 0) continue;
      const customId = String(invoice.custom_id ?? '');
      const channel = channelOfCustomId(customId);
      open.push({
        id: invoice.id,
        no: invoice.transaction_no,
        customId,
        date,
        remaining,
        total: Math.round(Number(invoice.original_amount) || 0),
        channel,
        // A typed-in transaction has no channel in its custom_id and is not ours to settle.
        autoPaid: Boolean(channel) && sourceOf({ channel }).autoPaid,
      });
    }
    if (page >= (Number(result?.total_pages) || 1)) break;
  }
  return open;
}

/**
 * @param {{since?: string|null, dryRun?: boolean, onProgress?: Function}} options
 */
export async function settleOpenInvoices({ since = null, dryRun = true, onProgress = () => {} } = {}) {
  const deposit = depositAccount();
  if (!deposit) throw new Error('MEKARI_DEPOSIT_ACCOUNT belum disetel - tidak ada akun tujuan pembayaran');

  const open = await openInvoices({ since });
  const settle = open.filter((i) => i.autoPaid);
  const leave = open.filter((i) => !i.autoPaid);

  if (dryRun) return { dryRun: true, deposit, open: open.length, settle, leave, paid: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('catat pembayaran faktur');

  let paid = 0;
  const failures = [];
  for (const invoice of settle) {
    try {
      await mekari({
        method: 'POST',
        path: PAYMENTS_PATH,
        // Not retried on a timeout: a payment written twice is a payment that did not
        // happen, and there is no custom_id uniqueness to catch it here.
        body: {
          receive_payment: {
            transaction_date: invoice.date,
            deposit_to_name: deposit,
            // Keyed so a re-run cannot pay the same invoice twice, the way the invoice
            // create is keyed. This is the only protection against a double payment.
            custom_id: `TRLPAY-${invoice.customId}`,
            records_attributes: [{ transaction_no: String(invoice.no), amount: invoice.remaining }],
            memo: 'Pelunasan otomatis - sudah diterima platform',
          },
        },
      });
      paid += 1;
      onProgress({ paid, of: settle.length, no: invoice.no });
    } catch (error) {
      // A repeated custom_id means the payment is already there, which is the state we
      // wanted rather than a failure.
      if (error?.status === 409) { paid += 1; continue; }
      failures.push({ no: invoice.no, customId: invoice.customId, error: error.message });
    }
  }
  return { dryRun: false, deposit, open: open.length, settle, leave, paid, failures };
}
