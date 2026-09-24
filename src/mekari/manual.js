import { SOURCES } from './sources.js';
import { MANUAL_SOURCES, PREFIXES, isManualSource } from './prefix.js';
import { findProduct, PRODUCTS } from '../master.js';
import { InvoiceError } from './invoice.js';
import { channelDayStart, channelDate, channelToday } from '../clock.js';

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
  const day = channelDate(Math.floor(now / 1000), 'manual').replace(/-/g, '').slice(2);
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
 * symbol is a check that catches a mistyped or transposed character, so a typo fails
 * validation instead of quietly pointing at somebody else's transaction.
 *
 * The check is taken mod 29, not Crockford's own mod 37. His table pads the alphabet
 * with * ~ $ = U, and a code has to survive a URL, a Jurnal custom_id and the code
 * validator here, none of which want a dollar sign in it: numbers 32 and 33 were handed
 * out with * and ~ on the end and both were refused at the door. 29 is prime and 32 is
 * 3 mod 29, so a single wrong symbol and a swapped pair are still both caught, and
 * every check symbol is a plain digit or letter.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CHECK_MOD = 29;
const CHECK = CROCKFORD.slice(0, CHECK_MOD);
// The table the first thirty-one numbers were issued with, still recognised on the way in.
const CHECK_LEGACY = `${CROCKFORD}*~$=U`;
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
  return out.padStart(SEQUENCE_LENGTH, '0') + CHECK[n % CHECK_MOD];
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
  if (n < 1) return null;
  const check = s[SEQUENCE_LENGTH];
  return check === CHECK[n % CHECK_MOD] || check === CHECK_LEGACY[n % 37] ? n : null;
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
 * @param {{source, code, date, customer?, buyer?, buyerPhone?, buyerEmail?, shipTo?, carrier?, note, shipping, paid, depositTo, lines, addedBy?: string}} input
 *   `addedBy` is the name of the person who typed the sale in. It is stamped on the end of
 *   the note - which is what Jurnal shows as the memo - so the invoice itself says who
 *   entered it, not just the activity log here.
 * @returns {object} an order, ready for buildInvoice
 */
/** "titip di toko A" + Kemas → "titip di toko A - ditambahkan oleh Kemas"; no name, no suffix. */
export const withAuthor = (note, addedBy) => {
  const name = String(addedBy ?? '').trim();
  if (!name) return note;
  return note ? `${note} - ditambahkan oleh ${name}` : `ditambahkan oleh ${name}`;
};

/**
 * The couriers this shop actually books for a sale it took by hand.
 *
 * A fixed list rather than free text: the same courier spelled three ways is three
 * couriers to anyone reading the books back, and nobody types "Grab Express Instant"
 * the same way twice.
 */
export const MANUAL_CARRIERS = [
  'Grab Express Instant',
  'Lion Parcel',
  'JNE',
  'J&T',
  'PAXEL',
  'DHL Express',
];

export function buildManualOrder(input) {
  const source = String(input.source ?? '').trim().toUpperCase();
  if (!isManualSource(source)) throw new InvoiceError(`sumber "${source}" bukan sumber manual`);

  const code = String(input.code ?? '').trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new InvoiceError(`kode "${code}" tidak berbentuk PREFIX-xxxx`);
  if (!code.startsWith(`${source}-`)) throw new InvoiceError(`kode ${code} tidak cocok dengan sumber ${source}`);

  const dayStart = channelDayStart(String(input.date ?? ''), 'manual');
  if (dayStart === null) throw new InvoiceError('tanggal tidak valid');
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const todayStart = channelDayStart(channelDate(now, 'manual'), 'manual');
  if (dayStart > todayStart) throw new InvoiceError('tanggal ada di masa depan');
  /**
   * A sale dated today is stamped the moment it was typed. A back-dated one is stamped
   * midday of the day it names.
   *
   * The midday stamp exists for one reason: a back-dated entry carries a date and no
   * time, and midnight is close enough to the boundary that a few hours of timezone slip
   * would move it onto the day before. Midday has hours of room on either side. Today's
   * entry has no such problem, because the moment it was typed is not in doubt.
   *
   * The day is WITA throughout, because a typed-in sale has no platform behind it and
   * the only clock that means anything is the one the person entering it is reading.
   *
   * Clamping today's entry to midday as well - which is what `Math.min(noon, now)` did -
   * traded one wrong time for another: a sale typed at 16:02 read 12.00 on the order
   * list, three hours behind the operator who had just entered it. Before that it was
   * pinned to midday outright, which put a nine-in-the-morning sale in the future and
   * hid it from a list that asks for everything up to now until lunchtime.
   */
  const createdAt = dayStart === todayStart ? now : dayStart + 12 * 3600;

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
    // A discount can be typed either way round. A percentage is only ever a way of saying
    // an amount, so it becomes one here - on the side that decides - and everything
    // downstream keeps dealing in rupiah exactly as before.
    const percent = String(line.discountMode ?? 'rp') === 'pct';
    const typed = Number(line.unitDiscount ?? 0);
    if (percent && (!Number.isFinite(typed) || typed < 0 || typed > 100)) {
      throw new InvoiceError(`diskon baris ${index + 1} harus antara 0 dan 100 persen`);
    }
    const unitDiscount = percent
      ? Math.round((unitPrice * typed) / 100)
      : money(line.unitDiscount ?? 0, `diskon baris ${index + 1}`);
    if (unitDiscount > unitPrice) throw new InvoiceError(`diskon baris ${index + 1} melebihi harganya`);

    return {
      sku: product.sku,
      name: product.variant ? `${product.name} - ${product.variant}` : product.name,
      variant: product.variant ?? '',
      qty,
      unitPrice,
      unitDiscount,
      // Kept for the record: "20%" and "Rp229.000" are the same money but not the same
      // instruction, and the activity log should show which one somebody actually gave.
      ...(percent ? { discountPercent: typed } : {}),
    };
  });

  const shipping = money(input.shipping ?? 0, 'ongkir');

  // One customer, typed once. The name on the form is the contact the invoice is raised
  // against in Jurnal and the name on the parcel; left empty, the source itself is the
  // customer, which is what a consignment shop's monthly invoice wants anyway.
  const buyer = String(input.buyer ?? '').trim();
  if (buyer.length > 120) throw new InvoiceError('nama pelanggan terlalu panjang');
  const customer = String(input.customer ?? '').trim() || buyer || PREFIXES[source].label;
  if (customer.length > 120) throw new InvoiceError('nama pelanggan terlalu panjang');
  const buyerPhone = String(input.buyerPhone ?? '').trim();
  if (buyerPhone.length > 40) throw new InvoiceError('nomor telepon terlalu panjang');
  const buyerEmail = String(input.buyerEmail ?? '').trim();
  if (buyerEmail.length > 120) throw new InvoiceError('email terlalu panjang');
  // Jurnal validates the email itself and rejects the whole invoice over it, so a typo
  // is caught here where the operator can still fix it.
  if (buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) throw new InvoiceError(`email "${buyerEmail}" tidak valid`);
  const shipTo = String(input.shipTo ?? '').trim();
  if (shipTo.length > 400) throw new InvoiceError('alamat terlalu panjang');
  const carrier = String(input.carrier ?? '').trim();
  if (carrier && !MANUAL_CARRIERS.includes(carrier)) throw new InvoiceError(`kurir "${carrier}" tidak ada di daftar`);

  return {
    channel: 'manual',
    id: code,
    // A typed transaction is money already earned, so it enters at the stage that posts.
    stage: 'completed',
    status: 'MANUAL',
    createdAt,
    source,
    customer,
    buyer,
    buyerPhone,
    buyerEmail,
    shipTo,
    carrier,
    tracking: '',
    total: lines.reduce((n, l) => n + (l.unitPrice - l.unitDiscount) * l.qty, 0) + shipping,
    currency: 'IDR',
    items: lines.length,
    note: withAuthor(String(input.note ?? '').trim().slice(0, 200), input.addedBy),
    lines: lines.map((l) => ({ sku: l.sku, name: l.name, variant: l.variant, qty: l.qty })),
    finance: { lines, shipping, shippingPassThrough: false },
  };
}


/**
 * What to tell the operator after a typed-in sale, and it is only ever what happened.
 *
 * `postManual` answers with five different things and the screen used to celebrate four
 * of them. `mismatch` is the one that matters: Jurnal accepted the invoice and stored a
 * different number than it was sent, so an invoice exists and it is wrong - and the popup
 * said "Tersimpan di Jurnal" beside the amount we had meant to send, which was the one
 * number on the screen that was not true.
 *
 * Only a clean create, that also reached our own table, celebrates. Everything else says
 * what it is. Anything needing a decision is an error-coloured note that stays on screen
 * rather than a green one that leaves after two seconds, and it is logged as a failure,
 * because a mismatch recorded as "ok" is how an invoice holding the wrong number stops
 * being anybody's problem.
 *
 * Pure on purpose: what an operator is told about money is a decision worth being able
 * to test without a network.
 */
export function manualOutcome({ status, error = '', id, total, listed = true, listError = '' }) {
  const amount = `Rp${Number(total ?? 0).toLocaleString('id-ID')}`;

  if (status === 'created' && listed) {
    return { kind: 'ok', message: `${id} tersimpan di Jurnal senilai ${amount}`, celebrate: 'Tersimpan di Jurnal' };
  }
  if (status === 'created') {
    // The books have it, the order list does not. Both halves are said, because
    // "tersimpan" alone is what sends somebody looking for a sale that is not on screen.
    return { kind: 'error', message: `${id} masuk Jurnal senilai ${amount}, tapi belum masuk daftar pesanan: ${listError}` };
  }
  if (status === 'exists') {
    return { kind: 'ok', message: `${id} sudah ada di Jurnal, tidak dibuat dua kali` };
  }
  if (status === 'mismatch') {
    return { kind: 'error', message: `${id}: ${error}` };
  }
  // 'failed' never reaches here - it throws further up - and anything else is a status
  // this code has not been taught. Saying so is safer than guessing which way it went.
  return {
    kind: 'error',
    message: `${id}: Jurnal menjawab "${status}", belum tentu tersimpan - periksa di Jurnal sebelum mengulang`,
  };
}
