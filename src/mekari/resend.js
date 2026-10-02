import { mekari } from './client.js';
import { productNameFor } from './invoice.js';
import { accountMap } from './accounts.js';
import { WASTE_ACCOUNT, INVENTORY_ACCOUNT } from './resend-accounts.js';
import { SOURCES } from './sources.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { forgetCatalogue } from './catalogue.js';

/**
 * Booking what a wrong parcel cost, which is the only thing a resend owes the books.
 *
 * The customer paid once, for the thing they ordered, and the invoice for that order
 * already records it. Sending the right goods afterwards earns nothing, so a resend must
 * never raise a second invoice - that would count one sale twice. And the original
 * invoice is not wrong either: the order said capsules, the invoice said capsules, and the
 * mistake happened in the warehouse where no document was looking.
 *
 * What is genuinely missing from the books is the goods that walked out of the door and,
 * by house rule, are not coming back. There is no sales document that says that. A
 * journal entry is:
 *
 *     Debit   Waste Goods Expense    the cost of the mistake
 *     Credit  Inventory              the goods that left
 *
 * One request, and it carries a custom_id so a double submit cannot write it twice -
 * the same guard the invoices use.
 *
 * Valued at the selling price, by the operator's decision. The books hold no cost price
 * for any SKU - products are created with track_inventory off, so none was ever needed -
 * and the choice was made knowingly: this overstates the expense by the margin, and the
 * alternative was not booking it at all.
 */

const JOURNAL_PATH = '/public/jurnal/api/v1/journal_entries';

export { WASTE_ACCOUNT, INVENTORY_ACCOUNT } from './resend-accounts.js';

/** One entry per resend, keyed by its code, so a repeat is refused rather than doubled. */
export const resendCustomId = (code) => `TRL-waste-${String(code).toUpperCase()}`;

export class ResendError extends Error {}

/**
 * The journal entry for one resend, built and checked without a network.
 *
 * @param {object} order the RS order, carrying `finance.wrongGoods.lines`
 * @param {Record<string, string>} accounts account number -> name, from accountMap()
 */
export function buildWasteEntry(order, accounts) {
  const lines = order?.finance?.wrongGoods?.lines ?? [];
  if (lines.length === 0) throw new ResendError(`${order?.id}: tidak ada barang salah kirim untuk dibukukan`);

  const value = lines.reduce((sum, line) => sum + Math.round(Number(line.unitPrice) || 0) * (Number(line.qty) || 0), 0);
  if (value <= 0) throw new ResendError(`${order.id}: nilai barang salah kirim nol - tidak ada yang dibukukan`);

  const waste = accounts?.[WASTE_ACCOUNT];
  const inventory = accounts?.[INVENTORY_ACCOUNT];
  // Named rather than numbered on the wire, so a missing one has to be caught here: Jurnal
  // answers a name it does not know with a validation error that names no account at all.
  if (!waste) throw new ResendError(`akun ${WASTE_ACCOUNT} (beban barang rusak) tidak ada di Jurnal`);
  if (!inventory) throw new ResendError(`akun ${INVENTORY_ACCOUNT} (persediaan) tidak ada di Jurnal`);

  const what = lines
    .map((line) => `${productNameFor(line)} ×${Number(line.qty) || 0}`)
    .join(', ');

  return {
    value,
    payload: {
      journal_entry: {
        transaction_date: order.finance.wrongGoods.date,
        transaction_no: order.id,
        custom_id: resendCustomId(order.id),
        // The whole story in one line, because this is what an accountant sees in the
        // ledger with no order list beside it.
        memo: [
          `Salah kirim pada ${order.resendFor?.channel ?? '?'} ${order.resendFor?.id ?? '?'}`,
          what,
          `diganti lewat ${order.id}`,
        ].join(' · '),
        transaction_account_lines_attributes: [
          { account_name: waste, debit: value },
          { account_name: inventory, credit: value },
        ],
        tags: [SOURCES.RS.tag],
      },
    },
  };
}

/**
 * @returns {Promise<{status: 'created'|'exists'|'skipped', value: number, customId: string, id?: number}>}
 */
export async function postWasteEntry(order, { accounts = null, dryRun = true, call = mekari, forget = forgetCatalogue } = {}) {
  const chart = accounts ?? await accountMap();
  const { payload, value } = buildWasteEntry(order, chart);
  const customId = resendCustomId(order.id);

  if (dryRun) return { status: 'skipped', value, customId };
  if (isReadOnly()) throw new ReadOnlyError(`jurnal salah kirim ${order.id}`);

  try {
    const made = await call({ method: 'POST', path: JOURNAL_PATH, body: payload });
    // The scan behind reconcile, recap and dedupe is a picture of what Jurnal held a
    // moment ago, and this changed it.
    await forget().catch(() => {});
    return { status: 'created', value, customId, id: made?.journal_entry?.id ?? made?.id ?? null };
  } catch (error) {
    // Jurnal refuses a repeated custom_id, which is exactly what a double submit looks
    // like. That is the guard working, not a failure to report.
    if (/custom.?id/i.test(JSON.stringify(error?.body ?? error?.message ?? ''))) {
      return { status: 'exists', value, customId };
    }
    throw error;
  }
}
