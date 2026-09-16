import { SOURCES } from './sources.js';
import { MANUAL_SOURCES, PREFIXES, isManualSource } from './prefix.js';
import { findProduct, PRODUCTS } from '../master.js';
import { InvoiceError } from './invoice.js';
import { WIB_OFFSET_SECONDS, wibDayStart, wibDate } from '../range.js';

/**
 * Transactions that were never online.
 *
 * Consignment, La Brisa, WhatsApp, walk-in and wholesale have no marketplace behind them,
 * so somebody types them in. They are turned into exactly the same order shape the four
 * channels produce, which means they go through the same invoice mapper, the same total
 * verification and the same idempotency key - one set of books, not two.
 *
 * Nothing here talks to a network. Everything a typed transaction can get wrong is
 * caught in this file, before anything reaches the accounts.
 */

const MAX_LINES = 40;

export const SOURCE_OPTIONS = MANUAL_SOURCES.map((prefix) => ({
  prefix,
  label: PREFIXES[prefix].label,
  // From the source table, which is where terms live now. Every typed-in source settles
  // on seven days: these are the sales somebody has to chase, which is exactly why they
  // are not given the fortnight a marketplace gets for money it has already taken.
  termDays: SOURCES[prefix].termDays,
  tag: SOURCES[prefix].tag,
}));

/** Products worth offering, newest naming first; gifts are sellable too (as a zero line). */
export const SELLABLE = PRODUCTS.map((p) => ({
  sku: p.sku,
  name: p.variant ? `${p.name} - ${p.variant}` : p.name,
  category: p.category,
}));

/**
 * A code that reads like the ones already in the books and cannot collide with them.
 *
 * Dated rather than a running counter: a counter would need a lock and a single source of
 * truth, and getting it wrong means two transactions sharing an identity. The date plus a
 * sequence within that date is unique without coordination, and a human can still tell at
 * a glance when it was written.
 */
export function suggestCode(prefix, existingCodes = [], now = Date.now()) {
  const day = wibDate(Math.floor(now / 1000)).replace(/-/g, '').slice(2);
  const stem = `${prefix}-${day}-`;
  const used = existingCodes
    .filter((code) => code.startsWith(stem))
    .map((code) => Number(code.slice(stem.length)))
    .filter((n) => Number.isInteger(n));
  const next = used.length > 0 ? Math.max(...used) + 1 : 1;
  return `${stem}${String(next).padStart(3, '0')}`;
}

/**
 * Codes that cannot collide, however many are ever issued.
 *
 * The date in the middle is for people; it proves nothing about uniqueness, because two
 * operators can open the form in the same minute and clocks can be wrong. What makes a
 * code unique is the tail: a number from one counter that only ever goes up, handed out
 * inside a store transaction (see sequence.js), so no two requests can receive the same
 * one - not across processes, not across restarts, not after ten million issues.
 *
 * The number is written in Crockford base32: no I, L, O or U, so a code read over the
 * phone or off a slip is not misheard, and six symbols hold a billion values. The last
 * symbol is a check (mod 37) that catches a mistyped or transposed character, so a typo
 * fails validation instead of quietly pointing at somebody else's transaction.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHECK = `${CROCKFORD}*~$=U`;
export const SEQUENCE_LENGTH = 6;
export const SEQUENCE_MAX = 32 ** SEQUENCE_LENGTH - 1; // 1,073,741,823

export function encodeSequence(n) {
  if (!Number.isInteger(n) || n < 1 || n > SEQUENCE_MAX) throw new InvoiceError(`nomor urut ${n} di luar jangkauan`);
  let value = n;
  let out = '';
  while (value > 0) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out.padStart(SEQUENCE_LENGTH, '0') + CHECK[n % 37];
}

/** The number behind a tail, or null when it is not one of ours or the check fails. */
export function decodeSequence(tail) {
  const s = String(tail ?? '').toUpperCase()
    // Crockford's forgiveness: what people misread is accepted, then normalised.
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== SEQUENCE_LENGTH + 1) return null;
  let n = 0;
  for (const ch of s.slice(0, SEQUENCE_LENGTH)) {
    const digit = CROCKFORD.indexOf(ch);
    if (digit < 0) return null;
    n = n * 32 + digit;
  }
  return n >= 1 && CHECK[n % 37] === s[SEQUENCE_LENGTH] ? n : null;
}

/** `CS-260916-00004K7` for source CS on 16 Sep 2026 with sequence number n. */
export function formatManualCode(prefix, dateIso, n) {
  const day = String(dateIso).replace(/-/g, '').slice(2, 8);
  return `${prefix}-${day}-${encodeSequence(n)}`;
}

/** Whether a code carries a valid sequence tail; a hand-typed code does not have to. */
export const sequenceOf = (code) => decodeSequence(String(code ?? '').split('-').at(-1));

const CODE_PATTERN = /^[A-Z]{2}-[A-Za-z0-9-]{1,40}$/;

const money = (value, field) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new InvoiceError(`${field} bukan angka`);
  if (n < 0) throw new InvoiceError(`${field} tidak boleh negatif`);
  if (!Number.isInteger(n)) throw new InvoiceError(`${field} harus bilangan bulat rupiah`);
  return n;
};

/**
 * Turn submitted form fields into the order shape the rest of the system already speaks.
 *
 * @param {{source, code, date, customer, note, shipping, paid, depositTo, lines}} input
 * @returns {object} an order, ready for buildInvoice
 */
export function buildManualOrder(input) {
  const source = String(input.source ?? '').trim().toUpperCase();
  if (!isManualSource(source)) throw new InvoiceError(`sumber "${source}" bukan sumber manual`);

  const code = String(input.code ?? '').trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new InvoiceError(`kode "${code}" tidak berbentuk PREFIX-xxxx`);
  if (!code.startsWith(`${source}-`)) throw new InvoiceError(`kode ${code} tidak cocok dengan sumber ${source}`);

  const dayStart = wibDayStart(String(input.date ?? ''));
  if (dayStart === null) throw new InvoiceError('tanggal tidak valid');
  // Booked at midday WIB rather than midnight, so a timezone slip of a few hours cannot
  // push the transaction onto the day before.
  const createdAt = dayStart + 12 * 3600;
  if (createdAt > Math.floor(Date.now() / 1000) + WIB_OFFSET_SECONDS) {
    throw new InvoiceError('tanggal ada di masa depan');
  }

  const rows = (input.lines ?? []).filter((l) => l && l.sku);
  if (rows.length === 0) throw new InvoiceError('belum ada baris produk');
  if (rows.length > MAX_LINES) throw new InvoiceError(`maksimal ${MAX_LINES} baris`);

  const lines = rows.map((line, index) => {
    const sku = String(line.sku).trim();
    const product = findProduct(sku);
    if (!product) throw new InvoiceError(`SKU ${sku} tidak ada di data master`);

    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty <= 0) throw new InvoiceError(`kuantitas baris ${index + 1} tidak valid`);

    const unitPrice = money(line.unitPrice, `harga baris ${index + 1}`);
    const unitDiscount = money(line.unitDiscount ?? 0, `diskon baris ${index + 1}`);
    if (unitDiscount > unitPrice) throw new InvoiceError(`diskon baris ${index + 1} melebihi harganya`);

    return {
      sku: product.sku,
      name: product.variant ? `${product.name} - ${product.variant}` : product.name,
      variant: product.variant ?? '',
      qty,
      unitPrice,
      unitDiscount,
    };
  });

  const shipping = money(input.shipping ?? 0, 'ongkir');
  const customer = String(input.customer ?? '').trim() || PREFIXES[source].label;
  if (customer.length > 120) throw new InvoiceError('nama pelanggan terlalu panjang');

  return {
    channel: 'manual',
    id: code,
    // A typed transaction is money already earned, so it enters at the stage that posts.
    stage: 'completed',
    status: 'MANUAL',
    createdAt,
    source,
    customer,
    buyer: String(input.buyer ?? '').trim(),
    carrier: String(input.carrier ?? '').trim(),
    tracking: '',
    total: lines.reduce((n, l) => n + (l.unitPrice - l.unitDiscount) * l.qty, 0) + shipping,
    currency: 'IDR',
    items: lines.length,
    note: String(input.note ?? '').trim().slice(0, 200),
    lines: lines.map((l) => ({ sku: l.sku, name: l.name, variant: l.variant, qty: l.qty })),
    finance: { lines, shipping, shippingPassThrough: false },
  };
}
