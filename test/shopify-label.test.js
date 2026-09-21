import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE128_PATTERNS, code128Modules, buildShopifyLabel, printedLabels, markPrinted,
  reservePickNumbers, PRINTED_DOC, PICK_DOC, UNBOXING_NOTICE,
} from '../src/shopify/label.js';
import { buildLabelSheet, labelReadiness } from '../src/labels.js';
import { labelHeading } from '../src/shopify/label.js';
import { deleteDoc, closeStore } from '../src/store/index.js';
import zlib from 'node:zlib';

/**
 * Read the words back out of a PDF.
 *
 * pdf-lib deflates its content streams and writes each drawn string as hex, so both have
 * to be undone before the sheet can be asserted on.
 */
function pdfText(bytes) {
  const buffer = Buffer.from(bytes);
  let text = '';
  // "endstream" contains "stream", so the keyword only counts when nothing ends there.
  for (const match of buffer.toString('latin1').matchAll(/(?<!end)stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = buffer.indexOf('endstream', start);
    if (end === -1) break;
    try { text += zlib.inflateSync(buffer.subarray(start, end)).toString('latin1'); } catch { /* not deflate */ }
  }
  return text.replace(/<([0-9A-Fa-f]+)>/g, (whole, hex) =>
    (hex.length % 2 ? whole : Buffer.from(hex, 'hex').toString('latin1')));
}

test.after(async () => { await closeStore(); });

const order = (over = {}) => ({
  channel: 'shopify', id: '#10926', createdAt: 1789199520, total: 973250,
  status: 'PAID/UNFULFILLED', stage: 'to_ship',
  buyer: 'Anik Maturafiah', buyerPhone: '0812-3456-7890',
  shipTo: 'Jln. Belida 1 Blok C2 no 21 Rt 31, Timbau, Tenggarong, Kalimantan Timur, 75511, ID',
  weightGram: 4500, note: 'titip di pos satpam',
  finance: { shipping: 263914 },
  lines: [
    { sku: 'GFT-MYST-001', name: 'TREELOGY Mystery Gift', variant: '', qty: 6 },
    { sku: 'Inside-Out-60-Protocol180+30', name: 'Inside Out Moringa Protocol - 60 Days', variant: '270 Moringa Capsules', qty: 6 },
  ],
  ...over,
});

test('every Code 128 symbol has the shape the standard gives it', () => {
  // A mistyped width here scans as a different character, which is worse than not
  // scanning at all: the parcel would be picked against somebody else's order.
  assert.equal(CODE128_PATTERNS.length, 107);
  CODE128_PATTERNS.forEach((pattern, value) => {
    const widths = [...pattern].map(Number);
    const isStop = value === 106;
    assert.equal(widths.length, isStop ? 7 : 6, `pola ${value} panjangnya salah`);
    assert.equal(widths.reduce((a, b) => a + b, 0), isStop ? 13 : 11, `pola ${value} tidak 11 modul`);
    assert.ok(widths.every((w) => w >= 1 && w <= 4), `pola ${value} punya lebar di luar 1..4`);
  });
});

test('a barcode carries a start, a check digit and a stop, in that order', () => {
  const modules = code128Modules('10926');
  // 1 start + 5 payload + 1 check, six modules each, plus the seven-module stop.
  assert.equal(modules.length, 7 * 6 + 7);
  assert.equal(modules.reduce((a, b) => a + b, 0), 7 * 11 + 13);

  const start = [...CODE128_PATTERNS[104]].map(Number);
  assert.deepEqual(modules.slice(0, 6), start);
  const stop = [...CODE128_PATTERNS[106]].map(Number);
  assert.deepEqual(modules.slice(-7), stop);

  // 104 + 1*(49-48+... ) worked out by hand for "10926": digits are values 17,16,25,18,22.
  const expected = (104 + 17 * 1 + 16 * 2 + 25 * 3 + 18 * 4 + 22 * 5) % 103;
  assert.deepEqual(modules.slice(36, 42), [...CODE128_PATTERNS[expected]].map(Number));

  assert.deepEqual(code128Modules(''), []);
});

test('the label is a one-page PDF that names the parcel and its contents', async () => {
  const bytes = await buildShopifyLabel(order(), { pick: '000000712', printedAt: 1789199999 });
  assert.match(Buffer.from(bytes).toString('latin1'), /^%PDF-/);
  assert.equal(bytes.length > 1500, true);
  const pdf = pdfText(bytes);
  for (const wanted of ['PICK-000000712', 'Anik Maturafiah', 'NON COD', 'treelogy.com', 'GFT-MYST-001', '270 Moringa', 'Total Qty']) {
    assert.ok(pdf.includes(wanted), `label tidak memuat ${wanted}`);
  }
  assert.ok(pdf.includes(UNBOXING_NOTICE.slice(0, 30)));
  assert.match(pdf, /\/Count 1/, 'satu halaman per label');
});

test('the Shopify mark rides on the label, and a missing one does not stop the print', async () => {
  const bytes = await buildShopifyLabel(order(), { pick: '000000712' });
  const raw = Buffer.from(bytes).toString('latin1');
  // An embedded image announces itself in the PDF's own vocabulary.
  assert.match(raw, /\/Subtype \/Image/);
  assert.match(raw, /\/ColorSpace \/DeviceRGB/);
  // The word stays beside it, so a printer that swallows the picture still says Shopify.
  assert.ok(pdfText(bytes).includes('Shopify'));
});

test('a label with nothing in it still prints rather than throwing', async () => {
  const bare = await buildShopifyLabel({ id: '#1', createdAt: 1789199520, lines: [] }, { pick: '000000001' });
  assert.match(Buffer.from(bare).toString('latin1'), /^%PDF-/);
});

test('printing is remembered here, because Shopify cannot remember it', async () => {
  await deleteDoc(PRINTED_DOC);
  assert.deepEqual(await printedLabels(), {});

  await markPrinted(['#10926', '#10925'], { by: 'kemas@treelogy.com' });
  const first = await printedLabels();
  assert.equal(first['#10926'].times, 1);
  assert.equal(first['#10926'].by, 'kemas@treelogy.com');

  await markPrinted(['#10926'], { by: 'dewi@treelogy.com' });
  const again = await printedLabels();
  assert.equal(again['#10926'].times, 2, 'cetak ulang dihitung');
  assert.equal(again['#10926'].first, first['#10926'].first, 'cetakan pertama tidak ditimpa');
  await markPrinted([]);
});

test('pick numbers are handed out once each, even to callers arriving together', async () => {
  await deleteDoc(PICK_DOC);
  const batches = await Promise.all([reservePickNumbers(3), reservePickNumbers(3), reservePickNumbers(3)]);
  const all = batches.flat();
  assert.equal(all.length, 9);
  assert.equal(new Set(all).size, 9, 'tidak ada nomor kembar');
  for (const pick of all) assert.match(pick, /^\d{9}$/);
  assert.deepEqual(await reservePickNumbers(0), []);
});

test('the sheet draws Shopify pages instead of fetching them, and names what it could not find', async () => {
  await deleteDoc(PICK_DOC);
  const sheet = await buildLabelSheet({
    orders: [{ channel: 'shopify', id: '#10926' }, { channel: 'shopify', id: '#404' }],
    resolveShopify: async () => [order()],
  });
  assert.equal(sheet.pageCount, 1);
  assert.deepEqual(sheet.printed, ['#10926']);
  assert.equal(sheet.failures.length, 1);
  assert.equal(sheet.failures[0].id, '#404');
  assert.match(sheet.failures[0].reason, /tidak ditemukan/);
});

test('without a way to read the order, a Shopify label is refused rather than drawn blank', async () => {
  const sheet = await buildLabelSheet({ orders: [{ channel: 'shopify', id: '#10926' }] });
  assert.equal(sheet.bytes, null);
  assert.match(sheet.failures[0].reason, /tidak tersedia/);
});

test('a printed Shopify order leaves the daily list and joins the reprints', () => {
  const o = order();
  assert.equal(labelReadiness(o, {}).state, 'needsPrint');
  assert.equal(labelReadiness(o, { '#10926': { at: 1, times: 1 } }).state, 'reprint');
});

test('a whole run is one document, with the mark embedded once rather than once a parcel', async () => {
  const { buildShopifyLabels } = await import('../src/shopify/label.js');
  const { PDFDocument } = await import('pdf-lib');

  const jobs = Array.from({ length: 20 }, (_, i) => ({ order: order({ id: `#${10900 + i}` }), pick: String(i).padStart(9, '0') }));
  const many = await buildShopifyLabels(jobs);
  assert.equal((await PDFDocument.load(many)).getPageCount(), 20);

  // Twenty labels drawn together must not weigh twenty times one: the picture and the
  // fonts are shared, which is most of what a print run used to cost.
  const one = await buildShopifyLabels(jobs.slice(0, 1));
  assert.ok(many.length < one.length * 3, `20 label ${many.length}B vs 1 label ${one.length}B`);

  // Each page still carries its own pick number, in the order it was asked for.
  const text = pdfText(many);
  assert.ok(text.includes('PICK-000000000'));
  assert.ok(text.includes('PICK-000000019'));
});

test('a typed-in sale prints on the same sheet, under its source and the house mark', async () => {
  const manual = {
    channel: 'manual', id: 'DP-260921-00001AD', source: 'DP', createdAt: 1789992000, total: 795000,
    buyer: 'Dian Novitasari', buyerPhone: '0812-0000-0000', shipTo: 'Jl. Nakula Sadewa V No 15, Salatiga, Jawa Tengah 50722', carrier: 'Lion Parcel',
    lines: [{ sku: 'OMC-180-001', name: 'Moringa Capsules - 180 caps', variant: '', qty: 1 }], finance: { shipping: 0 },
  };
  // The box a customer opens says Treelogy and nothing about how we classify the sale.
  assert.equal(labelHeading(manual), '');
  assert.equal(labelHeading({ channel: 'shopify' }), 'Shopify');
  const bytes = await buildShopifyLabel(manual, { pick: '000000900', printedAt: 1789199999 });
  const pdf = pdfText(bytes);
  for (const wanted of ['Dian Novitasari', 'Lion Parcel', 'DP-260921-00001AD', 'Salatiga']) {
    assert.ok(pdf.includes(wanted), `label tidak memuat ${wanted}`);
  }
  assert.ok(!pdf.includes('Shopify'), 'a typed-in parcel does not claim to be from Shopify');
  assert.ok(!pdf.includes('direct sales'), 'nor does it print how we classify the sale');
  const noted = pdfText(await buildShopifyLabel({ ...manual, note: 'Bungkus kado - ditambahkan oleh Rindang' }, { pick: '000000901', printedAt: 1789199999 }));
  assert.ok(noted.includes('Bungkus kado') && !noted.includes('ditambahkan oleh'), 'the author suffix stays off the box');
  // The instruction is the one coloured thing on the sheet, so the bench cannot miss it.
  assert.match(noted, /0\.78 0\.13 0\.11 rg/, 'the note is drawn in red');
  // And a note that only names the source is not an instruction at all.
  assert.ok(!pdf.includes('WhatsApp Order'), 'the filing habit stays off the box');

  // The sheet resolves it like a Shopify parcel, keyed by channel and id.
  const sheet = await buildLabelSheet({
    orders: [{ id: 'DP-260921-00001AD', channel: 'manual' }, { id: 'DP-missing', channel: 'manual' }],
    size: '100x150',
    resolveShopify: async () => [manual],
  });
  assert.equal(sheet.pageCount, 1);
  assert.deepEqual(sheet.printed, ['DP-260921-00001AD']);
  assert.deepEqual(sheet.failures, [{ id: 'DP-missing', channel: 'manual', reason: 'transaksi manual tidak ditemukan' }]);
});
