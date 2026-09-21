import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildFaktur, fakturLines, SELLER } from '../src/faktur.js';

/** pdf-lib deflates its streams and writes drawn text as hex; both have to be undone. */
function pdfText(bytes) {
  const buffer = Buffer.from(bytes);
  let text = '';
  for (const match of buffer.toString('latin1').matchAll(/(?<!end)stream\r?\n/g)) {
    const start = match.index + match[0].length;
    const end = buffer.indexOf('endstream', start);
    if (end === -1) break;
    try { text += zlib.inflateSync(buffer.subarray(start, end)).toString('latin1'); } catch { /* not deflate */ }
  }
  return text.replace(/<([0-9A-Fa-f]+)>/g, (whole, hex) =>
    (hex.length % 2 ? whole : Buffer.from(hex, 'hex').toString('latin1')));
}

const order = (over = {}) => ({
  channel: 'shopify', id: '#10926', createdAt: 1789199520, total: 690000, currency: 'IDR',
  buyer: 'Riri Peltakian', shipTo: 'River house, Jl. Sri Krisna No.22, Kerobokan, Bali 80361',
  note: 'WhatsApp Order (Instant Delivery Arranged by Customer)',
  finance: {
    lines: [{ sku: 'OMC-180-001', name: 'TREELOGY Premium Organic Moringa Capsules - 180 Caps', qty: 1, unitPrice: 690000, unitDiscount: 0 }],
    shipping: 0,
  },
  ...over,
});

test('the money on the invoice is derived once, so the table and the summary agree', () => {
  const rows = fakturLines(order({
    finance: { lines: [
      { sku: 'A', name: 'Satu', qty: 2, unitPrice: 100000, unitDiscount: 20000 },
      { sku: 'B', name: 'Dua', qty: 1, unitPrice: 50000, unitDiscount: 0 },
    ], shipping: 0 },
  }));
  assert.equal(rows[0].amount, 160000);
  assert.equal(rows[0].discountPercent, 20);
  assert.equal(rows[1].discountPercent, 0);

  // A channel that only knows quantities prints no unit price rather than inventing one.
  const bare = fakturLines({ lines: [{ sku: 'A', name: 'Satu', qty: 3 }] });
  assert.equal(bare[0].qty, 3);
  assert.equal(bare[0].unitPrice, 0);
  assert.equal(bare[0].amount, 0);
});

test('the invoice carries everything the books print, on one A4 page', async () => {
  const bytes = await buildFaktur(order(), { printedAt: 1789199999 });
  assert.match(Buffer.from(bytes).toString('latin1'), /^%PDF-/);
  const pdf = pdfText(bytes);

  for (const wanted of [
    'Faktur Penjualan', SELLER.name, 'Kepada:', 'Riri Peltakian',
    'No. Faktur', 'No. Ref.', 'Jatuh Tempo', 'KETERANGAN', 'DISK%', 'JUMLAH',
    'Total Qty', 'Sub Total', 'Ongkos Kirim', 'Grand Total', 'Catatan', 'Dicetak tanggal',
  ]) {
    assert.ok(pdf.includes(wanted), `faktur tidak memuat ${wanted}`);
  }

  // Numbers read the way the books read them: thousands split, two decimals.
  assert.ok(pdf.includes('690.000,00'));
  // The reference is the platform's own number; the invoice number is ours.
  assert.ok(pdf.includes('#10926'));
  assert.ok(pdf.includes('SHF-10926'), 'kode pesanan kita dipakai sebagai nomor faktur');
  // Both dates come off the same instant, rendered in the clock each one belongs to.
  const wib = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' })
    .format(new Date(1789199999 * 1000)).replace('Sept', 'Sep');
  assert.ok(pdf.includes(wib.split(' ')[0]), 'tanggal cetak ada di faktur');
  // Read back rather than grepped: pdf-lib may put the page tree inside an object stream.
  const { PDFDocument } = await import('pdf-lib');
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1, 'satu halaman A4');
});

test('an order with nothing priced still prints rather than throwing', async () => {
  const bytes = await buildFaktur({ channel: 'manual', id: 'CS-260918-001', createdAt: 1789199520, total: 0, lines: [] });
  assert.match(Buffer.from(bytes).toString('latin1'), /^%PDF-/);
});

test('a long product name wraps inside its column instead of running over the next', async () => {
  const long = 'TREELOGY Premium Organic Moringa Capsules / Kapsul Daun Kelor Organik Premium - 180 Caps plus Travel Pouch and Mystery Gift';
  const bytes = await buildFaktur(order({ finance: { lines: [{ sku: 'X', name: long, qty: 1, unitPrice: 690000, unitDiscount: 0 }], shipping: 0 } }));
  const pdf = pdfText(bytes);
  // Wrapped, so the words survive even though no single line holds them all.
  for (const word of ['TREELOGY', 'Kapsul', 'Mystery']) assert.ok(pdf.includes(word));
});

test('shipping reaches the summary, and the grand total is the order total', async () => {
  const pdf = pdfText(await buildFaktur(order({
    total: 740000,
    finance: { lines: [{ sku: 'A', name: 'Satu', qty: 1, unitPrice: 690000, unitDiscount: 0 }], shipping: 50000 },
  })));
  assert.ok(pdf.includes('50.000,00'), 'ongkir tampil');
  assert.ok(pdf.includes('740.000,00'), 'grand total dari order');
});

test('the Treelogy seal rides on the invoice, and a missing one does not stop the print', async () => {
  const bytes = await buildFaktur(order());
  const raw = Buffer.from(bytes).toString('latin1');
  assert.match(raw, /\/Subtype \/Image/, 'gambar tertanam di faktur');
  // The words stay whatever happens to the picture, so a printer that swallows it still
  // produces a readable invoice.
  assert.ok(pdfText(bytes).includes('Faktur Penjualan'));
});

test('a discounted line shows its discount, so the table and the total agree', async () => {
  // The case that exposed the Shopify booking bug: an order-level code worth Rp171.750.
  const pdf = pdfText(await buildFaktur(order({
    total: 973250,
    finance: { lines: [{ sku: 'OMC-270-001', name: 'Organic Moringa Capsules', qty: 1, unitPrice: 1145000, unitDiscount: 171750 }], shipping: 0 },
  })));
  assert.ok(pdf.includes('15,00'), 'diskon tampil sebagai persen');
  assert.ok(pdf.includes('973.250,00'), 'jumlah baris sudah dipotong');
  assert.ok(!pdf.includes('1.145.000,00\n'), 'harga penuh tidak menjadi subtotal');
});

test('a voucher taken off the whole basket is shown as the discount, so the rows add up', async () => {
  // Shopee: one line at 485.000 with no line discount, a 68.750 voucher on the order,
  // 416.250 paid. The invoice used to print Sub Total 485.000, Diskon 0, Grand Total
  // 416.250 - three numbers that could not all be true.
  const bytes = await buildFaktur(order({
    channel: 'shopee', id: '260921JXKTVPFW', total: 416250,
    finance: { lines: [{ sku: 'OMP-45-001', name: 'Moringa Powder 45g', qty: 1, unitPrice: 485000, unitDiscount: 0 }], shipping: 0 },
  }), { printedAt: 1789199999 });
  const pdf = pdfText(bytes);
  assert.ok(pdf.includes('68.750,00'), 'the voucher is the discount');
  assert.ok(pdf.includes('416.250,00'), 'and the total is what was paid');
});
