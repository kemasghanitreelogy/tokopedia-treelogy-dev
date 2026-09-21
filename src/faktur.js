import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { orderCode } from './mekari/prefix.js';
import { termDaysFor, isAutoPaid } from './mekari/sources.js';
import { zoneForChannel } from './clock.js';

/**
 * A sales invoice, in the shape the books already print.
 *
 * Jurnal issues the authoritative faktur once an order has been posted, but that is a
 * round trip and a quota for something somebody wants in their hand now - and for an
 * order that has not been posted yet, there is nothing to ask for. So the same document
 * is drawn here from the order we already hold, laid out to match what finance is used
 * to reading, and numbered with our own order code rather than pretending to carry
 * Jurnal's.
 */

const BLACK = rgb(0, 0, 0);
const RULE = rgb(0.45, 0.45, 0.45);

/**
 * The seal that goes at the head of the invoice, read once per process.
 *
 * Supplied as WebP, which pdf-lib cannot embed, so it is kept here as the PNG it has to
 * be. A missing file leaves the invoice without its mark rather than without an invoice.
 */
const MARK_PATH = new URL('./treelogy-mark.png', import.meta.url);
let markBytes;
function treelogyMark() {
  if (markBytes === undefined) {
    try { markBytes = fs.readFileSync(MARK_PATH); } catch { markBytes = null; }
  }
  return markBytes;
}

/** Who is selling. One place to change it when the address does. */
export const SELLER = {
  name: 'Treelogy | Premium Organic Moringa',
  lines: [
    'Jl. Bumbak, Kerobokan, Kec. Kuta Utara,',
    'Kabupaten Badung, Bali 80361',
    '',
    'Kab. Badung',
    'Bali, 80361',
    'Indonesia',
  ],
};

const money = (n) => Number(Math.round(Number(n) || 0)).toLocaleString('id-ID') + ',00';
const percent = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('id-ID', { minimumFractionDigits: 2 });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** "16 Aug 2026" in the sample is a date in the platform's own clock, not ours. */
function dateOf(epochSeconds, channel) {
  const zone = zoneForChannel(channel).name;
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'numeric', year: 'numeric', timeZone: zone,
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${MONTHS[Number(get('month')) - 1]} ${get('year')}`;
}

function stamp(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hour12: false, timeZone: 'Asia/Jakarta',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')} ${MONTHS[Number(get('month')) - 1]} ${get('year')} ${get('hour')}:${get('minute')}`;
}

/** Break text to a width, hard-breaking a word that cannot fit on its own. */
function wrap(font, text, size, width, maxLines = 6) {
  const pieces = [];
  for (const word of String(text ?? '').split(/\s+/).filter(Boolean)) {
    if (font.widthOfTextAtSize(word, size) <= width) { pieces.push(word); continue; }
    let chunk = '';
    for (const char of word) {
      if (chunk && font.widthOfTextAtSize(chunk + char, size) > width) { pieces.push(chunk); chunk = char; }
      else chunk += char;
    }
    if (chunk) pieces.push(chunk);
  }
  const lines = [];
  let line = '';
  for (const piece of pieces) {
    const candidate = line ? `${line} ${piece}` : piece;
    if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate;
    else { lines.push(line); line = piece; }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  return lines;
}

/**
 * The money on the invoice, derived once so the table and the summary cannot disagree.
 *
 * `finance.lines` is the priced view every channel produces; a channel that only knows
 * quantities falls back to the plain lines and prints no unit price, which is honest -
 * an invoice that invents a price is worse than one that leaves the column empty.
 */
export function fakturLines(order) {
  const priced = order.finance?.lines?.length ? order.finance.lines : null;
  const rows = priced ?? (order.lines ?? []).map((l) => ({ ...l, unitPrice: undefined, unitDiscount: 0 }));
  return rows.map((line) => {
    const qty = Number(line.qty) || 0;
    const unitPrice = Number(line.unitPrice) || 0;
    const unitDiscount = Number(line.unitDiscount) || 0;
    return {
      name: line.name || line.sku || '',
      qty,
      unitPrice,
      discountPercent: unitPrice > 0 ? (unitDiscount / unitPrice) * 100 : 0,
      amount: Math.max(0, unitPrice - unitDiscount) * qty,
    };
  });
}

/**
 * @param {object} order   an order in the shared omni shape
 * @param {{printedAt?: number, seller?: typeof SELLER}} [options]
 * @returns {Promise<Uint8Array>} a one-page A4 invoice
 */
export async function buildFaktur(order, { printedAt = Math.floor(Date.now() / 1000), seller = SELLER } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pad = 48;
  const right = 595.28 - pad;
  let y = 841.89 - pad;

  const text = (value, { x = pad, size = 8, at = y, face = font, color = BLACK } = {}) =>
    page.drawText(String(value ?? ''), { x, y: at, size, font: face, color });
  const rightOf = (value, { x = right, size = 8, at = y, face = font } = {}) =>
    page.drawText(String(value ?? ''), { x: x - face.widthOfTextAtSize(String(value ?? ''), size), y: at, size, font: face });

  // --- the seal on the left, the title on the right, as the books print it
  const mark = treelogyMark();
  if (mark) {
    try {
      const image = await pdf.embedPng(mark);
      const size = 58;
      page.drawImage(image, { x: pad, y: y - size + 4, width: (image.width / image.height) * size, height: size });
    } catch { /* an unreadable mark is not a reason to fail the invoice */ }
  }
  rightOf('Faktur Penjualan', { size: 20, at: y - 14, face: bold });

  // --- three columns: who is selling, who is buying, and the invoice's own facts
  y -= 78;
  const colB = pad + 190;
  const colLabel = pad + 352;
  const colValue = right;

  let leftY = y;
  for (const line of wrap(bold, seller.name, 9, 170, 2)) { text(line, { at: leftY, size: 9, face: bold }); leftY -= 11; }
  leftY -= 2;
  for (const line of seller.lines) {
    if (line) text(line, { at: leftY, size: 7.5 });
    leftY -= 11;
  }

  let midY = y;
  text('Kepada:', { x: colB, at: midY, size: 9.5, face: bold });
  text(order.buyer || order.customer || '-', { x: colB + bold.widthOfTextAtSize('Kepada: ', 9.5), at: midY, size: 9.5, face: bold });
  midY -= 14;
  for (const line of wrap(font, order.shipTo || '', 7.5, 158, 5)) { text(line, { x: colB, at: midY, size: 7.5 }); midY -= 10; }

  const facts = [
    ['No. Faktur', orderCode(order)],
    ['Tanggal', dateOf(order.createdAt, order.channel)],
    ['No. Ref.', String(order.id ?? '')],
    // A marketplace sale was paid before it shipped; a typed-in sale is owed on the terms
    // its source carries, which is what the invoice in Jurnal says too.
    ['Term', order.term || (isAutoPaid(order) ? 'TUNAI' : `Net ${termDaysFor(order)}`)],
    ['Jatuh Tempo', dateOf(order.dueAt ?? (isAutoPaid(order) ? order.createdAt : order.createdAt + termDaysFor(order) * 86400), order.channel)],
  ];
  let factY = y;
  for (const [label, value] of facts) {
    rightOf(label, { x: colLabel + 70, at: factY, size: 8, face: bold });
    // A long reference wraps under itself rather than running into the label.
    const wrapped = wrap(font, value, 8, colValue - colLabel - 78, 3);
    for (const [index, part] of wrapped.entries()) {
      rightOf(part, { at: factY - index * 10, size: 8 });
    }
    factY -= Math.max(1, wrapped.length) * 10 + 5;
  }

  // --- the goods
  y = Math.min(leftY, midY, factY) - 14;
  // Eight columns, nine boundaries; the widths add up to the page so the frame closes.
  const widths = [24, 200, 28, 38, 70, 42, 42, 55];
  const cols = widths.reduce((acc, w) => [...acc, acc[acc.length - 1] + w], [pad]);
  const headers = ['NO', 'KETERANGAN', 'QTY', 'UNIT', 'HARGA', 'DISK%', 'PAJAK%', 'JUMLAH'];
  // Everything but the description and the unit reads as a number, right-aligned.
  const RIGHT = new Set([2, 4, 5, 6, 7]);

  const box = (top, bottom) => {
    page.drawRectangle({ x: pad, y: bottom, width: right - pad, height: top - bottom, borderColor: BLACK, borderWidth: 0.7 });
    for (const x of cols.slice(1, -1)) {
      page.drawLine({ start: { x, y: top }, end: { x, y: bottom }, thickness: 0.7, color: BLACK });
    }
  };
  const cell = (index, value, at, { face = font, size = 7.5 } = {}) => {
    if (RIGHT.has(index)) rightOf(value, { x: cols[index + 1] - 3, at, size, face });
    else text(value, { x: cols[index] + 3, at, size, face });
  };

  const headTop = y;
  y -= 13;
  headers.forEach((title, index) => cell(index, title, y + 3.5, { face: bold }));
  page.drawLine({ start: { x: pad, y }, end: { x: right, y }, thickness: 0.7, color: BLACK });

  const rows = fakturLines(order);
  let subtotal = 0;
  let units = 0;
  for (const [index, row] of rows.entries()) {
    const name = wrap(font, row.name, 7.5, cols[2] - cols[1] - 6, 4);
    const top = y;
    y -= name.length * 9 + 6;

    cell(0, String(index + 1), top - 10);
    name.forEach((part, i) => text(part, { x: cols[1] + 3, at: top - 10 - i * 9, size: 7.5 }));
    cell(2, String(row.qty), top - 10);
    cell(3, 'Buah', top - 10);
    cell(4, row.unitPrice ? money(row.unitPrice) : '', top - 10);
    cell(5, percent(row.discountPercent), top - 10);
    cell(6, '0,00', top - 10);
    cell(7, money(row.amount), top - 10);

    subtotal += row.amount;
    units += row.qty;
    if (index < rows.length - 1) {
      page.drawLine({ start: { x: pad, y }, end: { x: right, y }, thickness: 0.4, color: RULE });
    }
  }
  box(headTop, y);

  // --- what it comes to
  const shipping = Number(order.finance?.shipping) || 0;
  const grand = Number(order.total) || subtotal + shipping;
  // What the lines add up to and what the buyer paid can differ by an order-level
  // voucher the platform took off the whole basket rather than off a line. A document
  // whose rows do not add up to its total is one nobody trusts, so the gap is shown
  // for what it is.
  const discount = Math.max(0, subtotal + shipping - grand);

  y -= 16;
  rightOf('Total Qty', { x: cols[2] - 6, at: y, size: 8, face: bold });
  cell(2, String(units), y, { size: 8 });

  const summary = [
    ['Sub Total', money(subtotal), false],
    ['Diskon', money(discount), false],
    ['Diskon Lainnya', money(0), false],
    ['Potongan Biaya', money(0), false],
    ['Pajak', money(0), false],
    ['Ongkos Kirim', money(shipping), false],
    ['Diskon Ongkos Kirim', money(0), false],
    ['Biaya Lainnya', money(0), false],
    ['Asuransi', money(0), false],
    ['Grand Total', money(grand), true],
  ];
  let sumY = y;
  for (const [label, value, strong] of summary) {
    if (strong) {
      page.drawLine({ start: { x: cols[5], y: sumY + 9 }, end: { x: right, y: sumY + 9 }, thickness: 0.7, color: BLACK });
      sumY -= 4;
    }
    rightOf(label, { x: cols[7] - 6, at: sumY, size: 8, face: bold });
    rightOf(value, { at: sumY, size: 8, face: strong ? bold : font });
    sumY -= 14;
  }

  // --- the note, beside the summary rather than under it
  let noteY = y - 28;
  text('Catatan :', { at: noteY, size: 8, face: bold });
  noteY -= 22;
  for (const line of wrap(font, order.note || '', 7.5, cols[5] - pad - 10, 6)) {
    text(line, { at: noteY, size: 7.5 });
    noteY -= 10;
  }

  // --- and when it came off the printer
  const footY = Math.min(sumY, noteY) - 26;
  text('Dicetak tanggal :', { at: Math.max(footY, pad), size: 7.5 });
  text(stamp(printedAt), { x: pad + 90, at: Math.max(footY, pad), size: 7.5 });

  return pdf.save();
}
