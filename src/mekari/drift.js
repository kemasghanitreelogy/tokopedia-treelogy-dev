import { createHash } from 'node:crypto';
import { financeTotal } from '../omni.js';

/**
 * Whether a Shopify order still says what its invoice says.
 *
 * Paid is not final on Shopify. An order can be edited in the admin, a line cancelled,
 * a discount changed - #13131, #13166, #10683 and #10340 were all invoiced and then
 * edited, and their invoices kept describing the cart at checkout. The rule since
 * 13 Nov 2026: any change to what the invoice is made of rewrites the invoice.
 *
 * "What the invoice is made of" is the finance block the builder reads - each line's
 * SKU, quantity, price and discount, and the shipping charge - fingerprinted when the
 * invoice is written and compared on every push and every sweep. A fingerprint rather
 * than the total, so a swap at the same price (180 capsules for 270 at a matching
 * discount) is still a change.
 *
 * Invoices written before fingerprints existed have none. If their total agrees with
 * the order they adopt the current fingerprint and are watched from then on; if it does
 * not, they are left alone, because most such gaps are the old discount bug on August
 * invoices, which is being audited separately rather than rewritten by a push.
 */

export function invoiceSignature(order) {
  const finance = order?.finance ?? {};
  const lines = (finance.lines ?? [])
    .map((l) => [String(l.sku ?? ''), Number(l.qty) || 0, Number(l.unitPrice) || 0, Number(l.unitDiscount) || 0])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const body = JSON.stringify({ lines, shipping: Number(finance.shipping) || 0 });
  return createHash('sha1').update(body).digest('hex').slice(0, 16);
}

/**
 * 'changed' - rewrite the invoice; 'adopt' - an older invoice that agrees, start
 * watching it; null - nothing to do.
 */
export function invoiceDrift(order, entry) {
  if (order?.channel !== 'shopify' || !order?.finance) return null;
  if (!entry?.invoice_id || entry.voided || entry.needs_review || entry.mismatch) return null;
  const now = invoiceSignature(order);
  if (entry.sig) return entry.sig === now ? null : 'changed';
  // No total recorded (an invoice re-learned from Jurnal rather than written by us) is
  // taken as agreeing: the audit of 13 Nov found only October and November entries like
  // that, all built by the current builder. Under Rp2 is rupiah rounding, not a change.
  if (entry.total === null || entry.total === undefined) return 'adopt';
  return Math.abs(Number(entry.total) - financeTotal(order.finance)) < 2 ? 'adopt' : null;
}
