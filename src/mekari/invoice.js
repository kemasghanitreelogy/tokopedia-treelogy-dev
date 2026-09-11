import { CHANNELS } from '../omni.js';
import { findProduct } from '../master.js';

/**
 * Turning an order into a Jurnal sales invoice.
 *
 * Pure on purpose: every number that reaches the books is decided here, so it can be
 * checked without touching an API. The policy it implements was decided deliberately and
 * is recorded in Keputusan-Integrasi-Mekari-Jurnal.docx:
 *
 *   revenue   the gross selling price, so a platform-funded voucher does not shrink
 *             turnover - the platform reimburses it. Verified against Shopee settlement:
 *             our goods total matches `order_selling_price` exactly.
 *   discount  only what the seller funds
 *   fees      commission and service charges stay out of the invoice; they are costs,
 *             not a reduction of revenue.
 *   timing    an invoice is raised once the order is paid.
 */

/** One customer per channel: marketplace buyers are anonymous, the channel is not. */
export const CUSTOMER_NAMES = {
  tokopedia: 'Tokopedia',
  tiktok_shop: 'TikTok Shop',
  shopee: 'Shopee',
  shopify: 'Shopify',
};

/** Stable across retries and re-runs, and the handle Jurnal lets us fetch by. */
export const customIdFor = (order) => `TRL-${order.channel}-${order.id}`;

const rupiah = (n) => Math.round(Number(n) || 0);

/** Jurnal takes dates as YYYY-MM-DD; the books follow the seller's own day, so WIB. */
export function jurnalDate(epochSeconds) {
  return new Date((epochSeconds + 7 * 3600) * 1000).toISOString().slice(0, 10);
}

/**
 * A line's product name as Jurnal will hold it.
 *
 * The master catalogue is the authority - it knows that GFT-POUCH-001 and Travel-Pouch
 * are one product - so two channels naming the same thing differently still land on one
 * Jurnal product instead of two.
 */
export function productNameFor(line) {
  const product = findProduct(line.sku);
  if (product) return product.variant ? `${product.name} - ${product.variant}` : product.name;
  return line.name || line.sku || 'Produk tanpa nama';
}

export class InvoiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvoiceError';
  }
}

/**
 * @param {{order: object, depositTo?: string|null}} input
 * @returns {{sales_invoice: object}} the exact payload POSTed to Jurnal
 */
export function buildInvoice({ order, depositTo = null }) {
  const finance = order.finance;
  if (!finance || !Array.isArray(finance.lines)) {
    throw new InvoiceError(`${order.id}: rincian keuangan tidak tersedia`);
  }
  if (finance.lines.length === 0) throw new InvoiceError(`${order.id}: tidak ada baris produk`);

  const lines = finance.lines.map((line) => {
    const rate = rupiah(line.unitPrice);
    const discount = rupiah(line.unitDiscount);
    if (rate < 0 || discount < 0) throw new InvoiceError(`${order.id}: harga negatif pada ${line.sku}`);
    if (discount > rate) throw new InvoiceError(`${order.id}: diskon melebihi harga pada ${line.sku}`);
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      throw new InvoiceError(`${order.id}: kuantitas tidak valid pada ${line.sku}`);
    }
    return {
      quantity: line.qty,
      rate,
      discount,
      product_name: productNameFor(line),
    };
  });

  const goods = lines.reduce((n, l) => n + (l.rate - l.discount) * l.quantity, 0);
  const shipping = rupiah(finance.shipping);
  if (shipping < 0) throw new InvoiceError(`${order.id}: ongkir negatif`);

  const date = jurnalDate(order.createdAt);
  const channel = CHANNELS[order.channel]?.label ?? order.channel;

  const invoice = {
    transaction_date: date,
    due_date: date,
    person_name: CUSTOMER_NAMES[order.channel] ?? channel,
    custom_id: customIdFor(order),
    reference_no: String(order.id),
    transaction_lines_attributes: lines,
    shipping_price: shipping,
    // The buyer's name is masked by the marketplaces, so it belongs in the memo rather
    // than as a contact that could never be reached.
    memo: [channel, order.id, order.buyer && `pembeli ${order.buyer}`].filter(Boolean).join(' · '),
  };

  if (order.carrier) invoice.ship_via = order.carrier;
  if (order.tracking) invoice.tracking_no = order.tracking;

  // Marking the invoice paid on deposit keeps receivables clean: a marketplace order is
  // settled before it ever ships, so leaving it open would overstate what is owed.
  if (depositTo) {
    invoice.deposit_to_name = depositTo;
    invoice.deposit = goods + shipping;
  }

  return { sales_invoice: invoice, expectedTotal: goods + shipping };
}

/**
 * Recompute the payload's own total and compare it with what was intended.
 *
 * Cheap, and the one check that catches a mapping mistake before it reaches the books -
 * a wrong number in accounting is worse than no number at all.
 */
export function verifyInvoice(payload, expectedTotal) {
  const lines = payload.sales_invoice.transaction_lines_attributes;
  const goods = lines.reduce((n, l) => n + (l.rate - l.discount) * l.quantity, 0);
  const total = goods + (payload.sales_invoice.shipping_price ?? 0);
  if (total !== expectedTotal) {
    throw new InvoiceError(`total faktur ${total} tidak sama dengan ${expectedTotal}`);
  }
  if (payload.sales_invoice.deposit !== undefined && payload.sales_invoice.deposit !== total) {
    throw new InvoiceError(`deposit ${payload.sales_invoice.deposit} tidak sama dengan total ${total}`);
  }
  return total;
}
