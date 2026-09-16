import { mekari } from './client.js';
import { sourceOf } from './sources.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { invoiceCatalogue, forgetCatalogue } from './catalogue.js';

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
const METHODS_PATH = '/public/jurnal/api/v1/payment_methods';

/**
 * How the money arrived. Jurnal requires it and will not guess.
 *
 * The first attempt sent neither and all fourteen payments were refused with a 422 whose
 * body said exactly that - "Payment method must be sent" - while the error surfaced only
 * as "HTTP 422", which is the third time today a Jurnal rejection was readable and went
 * unread. Marketplace settlements land in the bank, so Bank Transfer; the account offers
 * Cash, Check, Bank Transfer and Credit Card.
 */
const DEFAULT_METHOD = 'Bank Transfer';
const methodName = () => process.env.MEKARI_PAYMENT_METHOD || DEFAULT_METHOD;

let methodCache = null;

/** The id Jurnal knows this method by; both name and id are required on a payment. */
async function paymentMethod({ deadlineAt = null } = {}) {
  if (methodCache) return methodCache;
  const wanted = methodName();
  const result = await mekari({ path: METHODS_PATH, deadlineAt });
  const rows = result?.payment_methods ?? [];
  const hit = rows.find((m) => String(m.name ?? '').toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    throw new Error(`metode pembayaran "${wanted}" tidak ada di Jurnal - yang tersedia: ${rows.map((m) => m.name).join(', ')}`);
  }
  methodCache = { id: hit.id, name: hit.name };
  return methodCache;
}

const depositAccount = () => process.env.MEKARI_DEPOSIT_ACCOUNT || null;

/**
 * The order an invoice belongs to, read back out of the custom_id we wrote.
 *
 * Returns the id as well as the channel, and that is the whole point. A typed-in sale is
 * keyed TRL-manual-CS-260916-01: the channel is "manual" and the source lives in the id's
 * own prefix, CS for consignment. Reading only the channel and asking sourceOf about
 * "manual" walked straight into orderPrefix's manual branch, which splits an id that was
 * never passed, gets nothing, and falls back to the website's treatment - autoPaid.
 *
 * So every open consignment, wholesale, La Brisa, WhatsApp and walk-in invoice was in the
 * settle set: the exact sources that are open because nobody has paid yet. It would have
 * recorded payments that never happened, which is a worse error than the unpaid balance
 * it was written to clear, and it was one manual sale away from firing.
 */
export function orderOfCustomId(customId) {
  const m = /^TRL-([a-z_]+)-(.+)$/.exec(String(customId ?? ''));
  return m ? { channel: m[1], id: m[2] } : null;
}

/** @deprecated kept for the tests that name it; prefer orderOfCustomId. */
export const channelOfCustomId = (customId) => orderOfCustomId(customId)?.channel ?? null;

/**
 * Every invoice with something still owing on it, through the shared scan.
 *
 * @returns {Promise<Array<{id, no, customId, date, remaining, total, channel, autoPaid}>>}
 */
export async function openInvoices({ since = null, deadlineAt = null } = {}) {
  const { invoices } = await invoiceCatalogue({ since, deadlineAt });
  return invoices
    .filter((invoice) => invoice.remaining > 0)
    .map((invoice) => {
      const order = orderOfCustomId(invoice.customId);
      return {
        ...invoice,
        channel: order?.channel ?? null,
        // The id goes to sourceOf as well as the channel, so a typed-in sale is read by
        // its own prefix - CS, WS, LB, DP, DW - rather than falling through to the
        // website's treatment and being marked paid. An invoice whose key will not parse
        // is never settled either: guessing here invents a payment.
        autoPaid: Boolean(order) && sourceOf(order).autoPaid,
      };
    });
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

  const method = await paymentMethod();
  // A payment changes an invoice's remaining balance, so the cached reading is stale.
  await forgetCatalogue();
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
            payment_method_id: method.id,
            payment_method_name: method.name,
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
  return { dryRun: false, deposit, method, open: open.length, settle, leave, paid, failures };
}
