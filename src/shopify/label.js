import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readDoc, updateDoc } from '../store/index.js';
import { wibDate } from '../range.js';

/**
 * The packing label for a Shopify order, drawn here rather than fetched.
 *
 * Every other channel hands us a courier's waybill and we only merge the pages. Shopify
 * has no waybill to hand over: this shop books its couriers outside Shopify, so nothing
 * in the Admin API issues a document. What the bench actually needs is the same sheet
 * they were printing by hand - who it goes to, what is in the box, and a barcode the
 * picker can scan - so it is generated from the order we already hold. No Shopify API
 * call is made to print, and none is made afterwards: printing changes nothing on
 * Shopify's side, which is exactly how the shop wants it.
 */

const GRAY = rgb(0.42, 0.42, 0.42);
const BLACK = rgb(0, 0, 0);

/* ------------------------------------------------------------------ Code 128 */

/**
 * The 107 Code 128 symbols, each six bar/space widths that sum to 11 modules.
 *
 * A mistyped row here is a barcode that scans as the wrong thing, which is worse than
 * one that does not scan at all, so the shape of every row is asserted by the tests:
 * six digits, summing to eleven, and a seven-digit stop summing to thirteen.
 */
export const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

const START_B = 104;
const STOP = 106;

/**
 * Code 128 subset B: every printable ASCII character, one symbol each.
 *
 * @param {string} text
 * @returns {number[]} module widths, alternating bar and space, starting with a bar.
 */
export function code128Modules(text) {
  const chars = [...String(text)].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126);
  if (chars.length === 0) return [];

  const values = [START_B, ...chars.map((c) => c.charCodeAt(0) - 32)];
  // The check digit is the weighted sum of everything before it, the start code counting
  // once and each payload symbol counting by its position.
  let sum = START_B;
  chars.forEach((c, index) => { sum += (c.charCodeAt(0) - 32) * (index + 1); });
  values.push(sum % 103, STOP);

  return values.flatMap((value) => [...CODE128_PATTERNS[value]].map(Number));
}

/** Draw the barcode as filled rectangles; odd positions are bars, even are gaps. */
function drawBarcode(page, { text, x, y, width, height }) {
  const modules = code128Modules(text);
  if (modules.length === 0) return;
  const unit = width / modules.reduce((a, b) => a + b, 0);
  let cursor = x;
  modules.forEach((count, index) => {
    const span = count * unit;
    if (index % 2 === 0) page.drawRectangle({ x: cursor, y, width: span, height, color: BLACK });
    cursor += span;
  });
}

/* -------------------------------------------------------------------- layout */

const rupiah = (n) => 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID');

const stamp = (epochSeconds) =>
  new Date(epochSeconds * 1000).toLocaleString('id-ID', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Jakarta', hour12: false,
  }).replace(/\./g, ':');

/**
 * Break `text` into lines that fit `width` at `size`, up to `maxLines`.
 *
 * A SKU has no spaces in it, so a word wider than the column is broken by character
 * rather than left to run across the next one - which is what a SKU did to the variant.
 */
function wrap(font, text, size, width, maxLines = 3) {
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

/** Trim a single line to fit, with an ellipsis when it does not. */
function fit(font, text, size, width) {
  let value = String(text ?? '');
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  while (value.length > 1 && font.widthOfTextAtSize(`${value}…`, size) > width) value = value.slice(0, -1);
  return `${value}…`;
}

/**
 * The Shopify bag, read once and embedded on every label.
 *
 * A thermal printer has no colour, so this prints as a dithered grey - the shape is what
 * the bench recognises at a glance, and the shape survives. If the file ever goes missing
 * the label still prints; it just wears the word alone.
 */
const MARK_PATH = new URL('./shopify-mark.png', import.meta.url);
let markBytes;
function shopifyMark() {
  if (markBytes === undefined) {
    try { markBytes = fs.readFileSync(MARK_PATH); } catch { markBytes = null; }
  }
  return markBytes;
}

export const SENDER = 'treelogy.com';
export const UNBOXING_NOTICE = 'WAJIB Video Unboxing. Tanpa video unboxing, komplain tidak diterima.';

/**
 * One label page, laid out like the sheet the bench already knows.
 *
 * @param {object} order      an order in the shared omni shape
 * @param {{pick: string, printedAt?: number, width?: number, height?: number}} options
 * @returns {Promise<Uint8Array>} a one-page PDF
 */
export async function buildShopifyLabel(order, options = {}) {
  return buildShopifyLabels([{ order, pick: options.pick }], options);
}

/**
 * A whole print run in one document.
 *
 * One PDF per label meant embedding Helvetica, Helvetica-Bold and the Shopify mark once
 * per parcel, and then embedding every one of those documents again into the merged
 * sheet. Fifty labels carried fifty copies of the same picture. Drawn into a single
 * document they are embedded once, which is both faster and about four times smaller -
 * and a smaller file is the part the operator actually waits for.
 *
 * @param {{order: object, pick: string}[]} jobs
 * @returns {Promise<Uint8Array>} one PDF, one page per job, in the order given
 */
export async function buildShopifyLabels(jobs, { printedAt = Math.floor(Date.now() / 1000), width = 283.46, height = 425.20 } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const raw = shopifyMark();
  let mark = null;
  if (raw) {
    // Embedded once for the run: the same image object is referenced by every page.
    try { mark = await pdf.embedPng(raw); } catch { mark = null; }
  }

  for (const job of jobs) {
    drawLabel(pdf.addPage([width, height]), {
      order: job.order, pick: job.pick, printedAt, font, bold, mark, width, height,
    });
  }
  return pdf.save();
}

/** One label, onto a page that already exists, with fonts and mark already embedded. */
function drawLabel(page, { order, pick, printedAt, font, bold, mark, width, height }) {
  const pad = 12;
  const right = width - pad;
  const inner = width - pad * 2;
  let y = height - pad;

  const text = (value, { x = pad, size = 7.5, at = y, face = font, color = BLACK } = {}) => {
    page.drawText(String(value ?? ''), { x, y: at, size, font: face, color });
  };
  const rightText = (value, { size = 7.5, at = y, face = font, color = BLACK } = {}) => {
    page.drawText(String(value ?? ''), { x: right - face.widthOfTextAtSize(String(value ?? ''), size), y: at, size, font: face, color });
  };
  const line = (at, from = pad, to = right, thickness = 0.5) => {
    page.drawLine({ start: { x: from, y: at }, end: { x: to, y: at }, thickness, color: BLACK });
  };

  // --- header: pick number on the left, the two timestamps on the right
  y -= 8;
  text(`PICK-${pick}`, { size: 7, face: bold });
  rightText(`Waktu Order  ${stamp(order.createdAt)}`, { size: 6.5, color: GRAY });
  y -= 9;
  rightText(`Waktu Print  ${stamp(printedAt)}`, { size: 6.5, at: y, color: GRAY });

  y -= 24;
  let wordX = pad;
  if (mark) {
    const markHeight = 22;
    const markWidth = (mark.width / mark.height) * markHeight;
    page.drawImage(mark, { x: pad, y: y - 5, width: markWidth, height: markHeight });
    wordX = pad + markWidth + 5;
  }
  page.drawText('Shopify', { x: wordX, y, size: 13, font: bold });
  rightText('Pengiriman', { size: 7, at: y + 3, color: GRAY });
  y -= 13;
  const codWidth = 52;
  page.drawRectangle({ x: right - codWidth, y: y - 2, width: codWidth, height: 13, borderColor: BLACK, borderWidth: 0.7 });
  page.drawText('NON COD', { x: right - codWidth + 9, y: y + 2, size: 7, font: bold });

  // --- the unboxing notice, boxed so it survives a bad thermal print
  y -= 16;
  page.drawRectangle({ x: pad, y: y - 12, width: inner, height: 14, borderColor: BLACK, borderWidth: 0.6 });
  page.drawText(fit(font, UNBOXING_NOTICE, 6, inner - 8), { x: pad + 4, y: y - 8, size: 6, font });

  // --- barcode: what the picker scans, with the human-readable number under it
  y -= 26;
  const code = String(order.id ?? '').replace(/^#/, '');
  drawBarcode(page, { text: code, x: pad + 14, y: y - 34, width: inner - 28, height: 34 });
  y -= 44;
  const label = `${code}`;
  page.drawText(label, { x: (width - bold.widthOfTextAtSize(label, 9)) / 2, y, size: 9, font: bold });

  // --- two columns: the recipient on the left, the parcel's numbers on the right
  y -= 14;
  line(y);
  y -= 10;

  const leftWidth = inner * 0.54;
  const rightX = pad + leftWidth + 6;
  const keyed = (x, key, value, at, keyWidth = 44) => {
    page.drawText(key, { x, y: at, size: 6.5, font, color: GRAY });
    page.drawText(': ', { x: x + keyWidth - 6, y: at, size: 6.5, font, color: GRAY });
    page.drawText(String(value ?? ''), { x: x + keyWidth, y: at, size: 6.5, font: bold });
  };

  let leftY = y;
  keyed(pad, 'Kepada', fit(bold, order.buyer || '-', 6.5, leftWidth - 48), leftY);
  leftY -= 9;
  keyed(pad, 'No.Telp', fit(bold, order.buyerPhone || '-', 6.5, leftWidth - 48), leftY);
  leftY -= 9;
  page.drawText('Alamat Penerima', { x: pad, y: leftY, size: 6.5, font, color: GRAY });
  leftY -= 9;
  for (const row of wrap(bold, order.shipTo || '-', 6.5, leftWidth, 4)) {
    page.drawText(row, { x: pad, y: leftY, size: 6.5, font: bold });
    leftY -= 8;
  }

  let rightY = y;
  const rightWidth = right - rightX;
  for (const [key, value] of [
    ['Dari', SENDER],
    ['Asuransi', '0'],
    ['Biaya Kirim', rupiah(order.finance?.shipping ?? 0)],
    ['Total Biaya', rupiah(order.total ?? 0)],
    ['Berat', `${(Number(order.weightGram) || 0).toLocaleString('id-ID')} Gram`],
  ]) {
    keyed(rightX, key, fit(bold, value, 6.5, rightWidth - 52), rightY, 48);
    rightY -= 9;
  }

  y = Math.min(leftY, rightY) - 6;
  line(y);

  // --- what is in the box
  y -= 12;
  const cols = [pad + 2, pad + 16, pad + 16 + inner * 0.40, pad + 16 + inner * 0.68, right - 22];
  const head = ['No', 'Nama Produk', 'SKU', 'Variant', 'QTY'];
  head.forEach((title, index) => {
    page.drawText(title, { x: cols[index], y, size: 6, font: bold, color: GRAY });
  });
  y -= 4;
  line(y);

  const rows = order.lines ?? [];
  let total = 0;
  for (const [index, row] of rows.entries()) {
    // Every cell wraps rather than truncates: a packer reading half a SKU is a packer
    // who has to open the laptop, which is the whole thing this sheet exists to avoid.
    const name = wrap(bold, row.name || row.sku, 6.5, cols[2] - cols[1] - 6, 3);
    const sku = wrap(font, row.sku ?? '', 6.5, cols[3] - cols[2] - 6, 3);
    const variant = wrap(font, row.variant ?? '', 6.5, cols[4] - cols[3] - 6, 3);
    const tall = Math.max(name.length, sku.length, variant.length, 1);

    y -= 10;
    page.drawText(String(index + 1), { x: cols[0], y, size: 6.5, font });
    name.forEach((part, i) => page.drawText(part, { x: cols[1], y: y - i * 8, size: 6.5, font: bold }));
    sku.forEach((part, i) => page.drawText(part, { x: cols[2], y: y - i * 8, size: 6.5, font }));
    variant.forEach((part, i) => page.drawText(part, { x: cols[3], y: y - i * 8, size: 6.5, font }));
    page.drawText(String(row.qty ?? 0), { x: cols[4], y, size: 6.5, font: bold });
    total += Number(row.qty) || 0;

    y -= (tall - 1) * 8 + 4;
    line(y, pad, right, 0.25);
  }

  // --- the note the packer reads last, and the count they check against the box
  y -= 11;
  page.drawText('Catatan', { x: pad + 2, y, size: 6.5, font, color: GRAY });
  page.drawText(': ', { x: pad + 36, y, size: 6.5, font, color: GRAY });
  page.drawText(fit(font, order.note || '', 6.5, inner * 0.55), { x: pad + 44, y, size: 6.5, font });
  rightText(`Total Qty : ${total}`, { size: 6.5, at: y, face: bold });
  y -= 5;
  line(y);
}

/* ------------------------------------------------------------ printing state */

export const PRINTED_DOC = 'labels/shopify-printed.json';
const EMPTY = { version: 1, printed: {} };

/**
 * Shopify orders already worked through the Proses queue.
 *
 * Arranging a marketplace order calls its courier and the platform's own status moves on.
 * Shopify has no courier to call and nothing of ours changes there, so "done with this
 * one" has to be written down somewhere, and this is it. It is deliberately separate
 * from the print ledger: a label can be reprinted long after the parcel was arranged.
 */
export const ARRANGED_DOC = 'shopify/arranged.json';
const EMPTY_ARRANGED = { version: 1, arranged: {} };

export async function arrangedOrders() {
  const doc = await readDoc(ARRANGED_DOC).catch(() => null);
  return doc?.arranged ?? {};
}

/** @param {string[]} ids order names, exactly as they appear on the order */
export async function markArranged(ids, { by = '', at = Math.floor(Date.now() / 1000) } = {}) {
  if (ids.length === 0) return;
  await updateDoc(ARRANGED_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY_ARRANGED);
    for (const id of ids) next.arranged[id] = { at, by };
    return next;
  }, structuredClone(EMPTY_ARRANGED));
}

/**
 * Which Shopify orders have already had a label printed.
 *
 * Shopify itself cannot answer this: printing is invisible to it, and an order stays
 * UNFULFILLED whether the sheet came out of the printer or not. So the answer lives
 * here, written when a label is actually produced.
 */
export async function printedLabels() {
  const doc = await readDoc(PRINTED_DOC).catch(() => null);
  return doc?.printed ?? {};
}

/** @param {string[]} ids order names, exactly as they appear on the order */
export async function markPrinted(ids, { by = '', at = Math.floor(Date.now() / 1000) } = {}) {
  if (ids.length === 0) return;
  await updateDoc(PRINTED_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY);
    for (const id of ids) {
      const existing = next.printed[id];
      next.printed[id] = {
        at, by,
        // A reprint does not rewrite history; it counts.
        first: existing?.first ?? at,
        times: (existing?.times ?? 0) + 1,
      };
    }
    return next;
  }, structuredClone(EMPTY));
}

/**
 * The running pick number, reserved inside a store transaction so two printers cannot
 * be handed the same one. An abandoned print leaves a gap, never a repeat.
 */
export const PICK_DOC = 'labels/shopify-pick-sequence.json';

export async function reservePickNumbers(count) {
  if (count <= 0) return [];
  const doc = await updateDoc(PICK_DOC, (current) => {
    const next = current ?? { version: 1, day: '', next: 1 };
    next.next = (next.next ?? 1) + count;
    next.day = wibDate(Math.floor(Date.now() / 1000));
    return next;
  }, { version: 1, day: '', next: 1 });
  const end = doc.next;
  return Array.from({ length: count }, (_, i) => String(end - count + i).padStart(9, '0'));
}
