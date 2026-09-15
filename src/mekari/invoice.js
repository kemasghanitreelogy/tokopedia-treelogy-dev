import { CHANNELS } from '../omni.js';
import { findProduct } from '../master.js';
import { orderCode, orderPrefix, PREFIXES } from './prefix.js';
import { termDaysFor, isAutoPaid, sourceOf } from './sources.js';

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

/**
 * The fallback customer, used only when an order names no buyer at all.
 *
 * Every invoice is raised against the person who actually bought - that is what makes it
 * match the order - but a marketplace occasionally sends nothing usable, and an invoice
 * still has to name somebody.
 */
export const CUSTOMER_NAMES = {
  tokopedia: 'Tokopedia',
  tiktok_shop: 'TikTok Shop',
  shopee: 'Shopee',
  shopify: 'Shopify',
};

/**
 * Stable across retries and re-runs, and the handle Jurnal lets us fetch by.
 *
 * Deliberately NOT the prefixed order code. A Shopify prefix depends on detecting which
 * gateway took the payment, and a detection that fails once and succeeds the next time
 * would change the key and post the same sale twice. The key is built only from things
 * that cannot change: the channel and the platform's own order id. The prefixed code is
 * what a human reads, and it lives in reference_no.
 */
export const customIdFor = (order) => `TRL-${order.channel}-${order.id}`;

const rupiah = (n) => Math.round(Number(n) || 0);

/**
 * Who the invoice is raised against.
 *
 * Shopify gives a real name and address. The marketplaces mask theirs - Tokopedia and
 * TikTok send "N*** W***astuti", Shopee sends a username - so the contact created for
 * them is only as good as what they disclose. Two buyers whose masked names collide will
 * share a contact; that is a property of the data, not of this code, and the order code
 * in the memo still tells the two invoices apart.
 */
export function customerFor(order) {
  const named = String(order.customer ?? order.buyer ?? '').trim();
  return named || CUSTOMER_NAMES[order.channel] || (CHANNELS[order.channel]?.label ?? order.channel);
}

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

/**
 * The code Jurnal matches the line against.
 *
 * Matched on code rather than name because a name can be edited inside Jurnal, and the
 * day someone tidies one up every later invoice for it would be rejected. The master
 * catalogue resolves a channel's own SKU onto ours, so two channels spelling the same
 * product differently still land on one Jurnal product.
 */
export function productCodeFor(line) {
  const product = findProduct(line.sku);
  if (product) return product.sku;
  // Jurnal rejects a whole invoice whose line names a product it does not hold, so an
  // unmappable SKU is stopped here, where it reads as one order to look at, rather than
  // at the API, where it reads as an unexplained 422.
  throw new InvoiceError(`SKU ${line.sku || '(kosong)'} tidak ada di data master`);
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
    // Jurnal reads a line's `discount` as a PERCENTAGE, not an amount - proved twice
    // against the live account, which rejected a Rp125,000 discount with "Discount cannot
    // exceed the total item amount" even with discount_type_name: Value. So the seller's
    // discount is folded into the rate, which makes the total provably exact, and the
    // amount it came off is kept in the description so nothing is lost.
    const name = productNameFor(line);
    return {
      quantity: line.qty,
      rate: rate - discount,
      product_code: productCodeFor(line),
      // The readable name travels as the line description, so the invoice still reads
      // properly without making the name the thing Jurnal has to match on.
      description: discount > 0
        ? `${name} (disk. ${discount.toLocaleString('id-ID')} dari ${rate.toLocaleString('id-ID')})`
        : name,
    };
  });

  const goods = lines.reduce((n, l) => n + l.rate * l.quantity, 0);
  const shipping = rupiah(finance.shipping);
  if (shipping < 0) throw new InvoiceError(`${order.id}: ongkir negatif`);



  const date = jurnalDate(order.createdAt);
  // A typed-in transaction names its own source; the four online channels are named by
  // the channel table.
  const channel = CHANNELS[order.channel]?.label ?? PREFIXES[orderPrefix(order)]?.label ?? order.channel;
  // The business writes every order with its source prefix, so the books do too.
  const code = orderCode(order);

  const source = sourceOf(order);
  const invoice = {
    transaction_date: date,
    // Net 14 where the platform already took the money, Net 7 where somebody has to chase
    // it. The source table decides; nothing here knows which is which.
    due_date: jurnalDate(order.createdAt + termDaysFor(order) * 24 * 3600),
    person_name: customerFor(order),
    // Jurnal needs a term it already holds, or the invoice shows as "Custom" with no
    // term at all. Net 14 and Net 7 were created to match the order-code table; the
    // due date is still sent so the two can never disagree.
    term_name: `Net ${termDaysFor(order)}`,
    custom_id: customIdFor(order),
    reference_no: code,
    transaction_lines_attributes: lines,
    // Jurnal's own delivery field, which is where postage belongs and where it reads
    // properly - under the subtotal, not as a product nobody sells. Which account it
    // credits is a company setting rather than anything on this payload, so the sync
    // checks that setting before it will post an invoice carrying postage at all.
    shipping_price: shipping,
    // Written on every invoice rather than typed in afterwards. A tag that depends on
    // somebody remembering is a tag that is right for a fortnight and then silently is
    // not, and it is the only thing that lets one receivable be read back by channel.
    tags: [source.tag],
    // The buyer's name is masked by the marketplaces, so it belongs in the memo rather
    // than as a contact that could never be reached.
    memo: [channel, code, order.note].filter(Boolean).join(' · '),
  };

  // Each of these is sent only when the platform actually disclosed it. An empty field
  // in Jurnal is honest; a field filled with a placeholder is not.
  if (order.buyerEmail) invoice.email = order.buyerEmail;
  if (order.shipTo) invoice.shipping_address = order.shipTo;
  if (order.billTo || order.shipTo) invoice.address = order.billTo || order.shipTo;
  if (order.carrier) invoice.ship_via = order.carrier;
  if (order.tracking) invoice.tracking_no = order.tracking;

  // Jurnal gates its whole shipping block behind this flag: without it both
  // `shipping_price` and `shipping_address` are silently stored as empty, and the invoice
  // comes out short by the postage with no address on it. Set whenever there is anything
  // about the delivery to record, rather than only when there is postage to charge.
  if (shipping > 0 || invoice.shipping_address || invoice.ship_via || invoice.tracking_no) {
    invoice.is_shipped = true;
  }

  // Marking the invoice paid on deposit keeps receivables clean: a marketplace order is
  // settled before it ever ships, so leaving it open would overstate what is owed.
  //
  // Only for the sources where that is actually true. A consignment shop, a walk-in, a
  // WhatsApp order - the money for those arrives later, by transfer or in person, and
  // marking them paid on the day they were raised would empty the receivable that exists
  // precisely so somebody can chase them.
  if (depositTo && isAutoPaid(order)) {
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
  const invoice = payload.sales_invoice;
  const lines = invoice.transaction_lines_attributes;
  // Every rupiah is in the lines now, postage included, so this is the whole invoice.
  const goods = lines.reduce((n, l) => n + l.rate * l.quantity, 0);
  const shipping = invoice.shipping_price ?? 0;
  const total = goods + shipping;
  if (total !== expectedTotal) {
    throw new InvoiceError(`total faktur ${total} tidak sama dengan ${expectedTotal}`);
  }
  // Postage that is charged but not declared shipped is stored as zero by Jurnal, so the
  // invoice would be short by exactly the postage - five went into the books that way
  // before this check existed. The same flag gates the address and the waybill.
  if ((shipping > 0 || invoice.shipping_address) && invoice.is_shipped !== true) {
    throw new InvoiceError('ongkir dan alamat tidak akan tersimpan tanpa is_shipped');
  }
  if (lines.some((l) => l.discount !== undefined)) {
    throw new InvoiceError('diskon per baris dibaca Jurnal sebagai persen - harus dilipat ke rate');
  }
  if (payload.sales_invoice.deposit !== undefined && payload.sales_invoice.deposit !== total) {
    throw new InvoiceError(`deposit ${payload.sales_invoice.deposit} tidak sama dengan total ${total}`);
  }
  // An untagged invoice is not a cosmetic problem: the per-source receivables are only
  // readable back by channel because of the tag, and one missing tag is a sale that
  // disappears from whichever report the business actually looks at.
  if (!Array.isArray(invoice.tags) || invoice.tags.length === 0) {
    throw new InvoiceError('faktur tanpa tag sumber');
  }
  return total;
}
