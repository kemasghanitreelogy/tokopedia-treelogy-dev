import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { toCsv, toXlsx, columnName, excelSerial } from '../src/export/sheet.js';
import {
  buildExport, resolveChannels, exportFilename, renderExport, channelLabel, DATASETS,
} from '../src/export/orders.js';

/* ------------------------------------------------------------------- the zip */

/** Read one file back out of the workbook, the way a spreadsheet would. */
function unzip(bytes) {
  const files = {};
  // Walk the central directory rather than scanning for signatures: a deflate stream can
  // contain the local-header magic by chance, and a reader that guesses finds it.
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'tidak ada end-of-central-directory');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(at), 0x02014b50);
    const nameLen = bytes.readUInt16LE(at + 28);
    const extraLen = bytes.readUInt16LE(at + 30);
    const commentLen = bytes.readUInt16LE(at + 32);
    const size = bytes.readUInt32LE(at + 20);
    const offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const localNameLen = bytes.readUInt16LE(offset + 26);
    const localExtraLen = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    files[name] = zlib.inflateRawSync(bytes.subarray(start, start + size)).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const sheet = {
  name: 'Produk',
  columns: [
    { key: 'sku', label: 'SKU' },
    { key: 'name', label: 'Produk' },
    { key: 'qty', label: 'Qty', type: 'int' },
    { key: 'revenue', label: 'Omzet', type: 'money' },
    { key: 'at', label: 'Waktu', type: 'date' },
  ],
  rows: [
    { sku: 'OMC-180-001', name: 'Moringa "Premium", 180', qty: 3, revenue: 1182500, at: { n: 46287.5, s: '22/09/2026 12:00' } },
    { sku: 'OMP-45-001', name: 'Moringa Powder', qty: 0, revenue: null, at: { n: 46287, s: '22/09/2026 00:00' } },
  ],
};

test('the workbook is a zip a spreadsheet can open, with the parts the format requires', () => {
  const files = unzip(toXlsx(sheet));
  for (const part of [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
  ]) {
    assert.ok(files[part], `${part} tidak ada di dalam workbook`);
  }
  assert.match(files['xl/workbook.xml'], /name="Produk"/);
  // Every relationship the workbook names has to resolve, or Excel calls the file corrupt.
  assert.match(files['xl/_rels/workbook.xml.rels'], /Target="worksheets\/sheet1\.xml"/);
  assert.match(files['xl/_rels/workbook.xml.rels'], /Target="styles\.xml"/);
});

test('numbers stay numbers, dates stay dates, and only text is written as text', () => {
  const xml = unzip(toXlsx(sheet))['xl/worksheets/sheet1.xml'];
  // A quantity Excel can sum, not a string that looks like one.
  assert.match(xml, /<c r="C2" s="2"><v>3<\/v><\/c>/);
  assert.match(xml, /<c r="D2" s="3"><v>1182500<\/v><\/c>/);
  assert.match(xml, /<c r="E2" s="4"><v>46287.5<\/v><\/c>/);
  assert.match(xml, /<c r="A2" s="0" t="inlineStr">/);
  // No revenue is an empty cell, not a zero: nothing sold and sold for nothing differ.
  assert.ok(!/<c r="D3"/.test(xml), 'sel kosong tidak boleh ditulis sebagai nol');
  // Zero is a real measurement, so it is written; null is the absence of one.
  assert.match(xml, /<c r="C3" s="2"><v>0<\/v><\/c>/);
  assert.match(xml, /<autoFilter ref="A1:E3"\/>/, 'header bisa difilter');
  assert.match(xml, /state="frozen"/, 'baris judul ikut saat di-scroll');
});

test('a quote or an ampersand in a product name does not break the file', () => {
  const xml = unzip(toXlsx(sheet))['xl/worksheets/sheet1.xml'];
  assert.ok(xml.includes('Moringa "Premium", 180'), 'tanda kutip aman di dalam XML');
  const wild = unzip(toXlsx({
    ...sheet,
    rows: [{ sku: 'A&B', name: '<script>', qty: 1, revenue: 1, at: { n: 1, s: 'x' } }],
  }))['xl/worksheets/sheet1.xml'];
  assert.ok(wild.includes('A&amp;B') && wild.includes('&lt;script&gt;'));
});

test('a control character is dropped rather than made into an unopenable workbook', () => {
  const bell = String.fromCharCode(7);
  const xml = unzip(toXlsx({
    ...sheet,
    rows: [{ sku: `A${bell}B`, name: 'x', qty: 1, revenue: 1, at: { n: 1, s: 'x' } }],
  }))['xl/worksheets/sheet1.xml'];
  assert.ok(xml.includes('AB'), 'karakter kontrol dibuang, hurufnya tetap');
  assert.ok(!xml.includes(bell), 'satu karakter kontrol bikin seluruh workbook tidak bisa dibuka');
});

test('two exports of the same table are byte for byte the same file', () => {
  assert.deepEqual(toXlsx(sheet), toXlsx(sheet), 'timestamp tidak boleh bikin file berbeda');
});

test('column names carry past Z the way a spreadsheet does', () => {
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(27), 'AB');
  assert.equal(columnName(51), 'AZ');
  assert.equal(columnName(52), 'BA');
});

test('the serial is the one Excel counts in', () => {
  // 1970-01-01 is day 25569 in Excel's calendar; noon is half a day past it.
  assert.equal(excelSerial(0), 25569);
  assert.equal(excelSerial(43200), 25569.5);
});

/* ------------------------------------------------------------------- the CSV */

test('the CSV opens as UTF-8 and quotes only what has to be quoted', () => {
  const csv = toCsv(sheet);
  assert.ok(csv.startsWith('﻿'), 'tanpa BOM, Excel salah baca huruf beraksen');
  assert.ok(csv.includes('\r\n'), 'akhir baris CRLF');
  assert.ok(csv.includes('"Moringa ""Premium"", 180"'), 'kutip digandakan, koma dikurung');
  assert.ok(csv.includes('OMC-180-001,'), 'yang tidak perlu dikutip dibiarkan polos');
  // Unformatted on purpose: a thousands separator is a number that will not parse.
  assert.ok(csv.includes(',1182500,'), 'angka tanpa pemisah ribuan');
  assert.ok(csv.includes('22/09/2026 12:00'), 'tanggal sebagai teks yang terbaca');
});

test('an empty number is an empty field, not a zero', () => {
  const csv = toCsv(sheet);
  const rows = csv.split('\r\n');
  assert.ok(rows[2].includes(',,'), 'omzet kosong tetap kosong');
});

/* -------------------------------------------------------------- the datasets */

const order = (over = {}) => ({
  channel: 'shopee', id: '260922NPCNPHTP', createdAt: 1790000000, stage: 'completed', status: 'COMPLETED',
  buyer: 'marfrisk', buyerPhone: '0812', shipTo: 'Denpasar', carrier: 'JNE Reguler', tracking: 'JX1',
  total: 651054,
  lines: [{ sku: 'OMC180', name: 'Kapsul', variant: '180 caps', qty: 2 }],
  finance: { lines: [{ sku: 'OMC180', name: 'Kapsul', variant: '180 caps', qty: 2, unitPrice: 300000, unitDiscount: 25000 }], shipping: 0 },
  ...over,
});

test('the product sheet folds a SKU across channels into one row, under the catalogue name', () => {
  const sheetOut = buildExport({
    orders: [
      order(),
      // The same product, listed under its TikTok id - the catalogue knows it is the same.
      order({ channel: 'tokopedia', id: '586', lines: [{ sku: '1731010208236668891', name: 'x', variant: '', qty: 1 }],
        finance: { lines: [{ sku: '1731010208236668891', name: 'x', variant: '', qty: 1, unitPrice: 300000, unitDiscount: 0 }], shipping: 0 } }),
    ],
    dataset: 'product',
  });
  assert.equal(sheetOut.rows.length, 1, 'satu produk, satu baris');
  const row = sheetOut.rows[0];
  assert.equal(row.sku, 'OMC-180-001', 'nama SKU dari katalog, bukan dari listing');
  assert.equal(row.name, 'Moringa Capsules');
  assert.equal(row.qty, 3);
  assert.equal(row.orders, 2);
  assert.equal(row.revenue, 2 * 275000 + 300000);
  assert.equal(row.discount, 50000);
  assert.equal(row.ch_shopee, 2);
  assert.equal(row.ch_tokopedia, 1);
});

test('one channel means no per-channel columns, because they would repeat the quantity', () => {
  const one = buildExport({ orders: [order()], dataset: 'product', channels: ['shopee'] });
  assert.ok(!one.columns.some((c) => c.key.startsWith('ch_')));
  const many = buildExport({ orders: [order()], dataset: 'product' });
  assert.ok(many.columns.some((c) => c.key === 'ch_shopee'));
});

test('the order sheet carries the sale, and the item sheet carries its lines', () => {
  const orders = buildExport({ orders: [order()], dataset: 'order' });
  assert.equal(orders.rows.length, 1);
  assert.equal(orders.rows[0].id, '260922NPCNPHTP');
  assert.equal(orders.rows[0].units, 2);
  assert.equal(orders.rows[0].goods, 550000);
  assert.equal(orders.rows[0].total, 651054);
  assert.equal(orders.rows[0].stage, 'Selesai', 'status ditulis seperti di layar');
  assert.equal(typeof orders.rows[0].at.n, 'number');

  const items = buildExport({ orders: [order()], dataset: 'item' });
  assert.equal(items.rows.length, 1);
  assert.equal(items.rows[0].sku, 'OMC-180-001');
  assert.equal(items.rows[0].listed, 'OMC180', 'SKU asli di listing tetap tercatat');
  assert.equal(items.rows[0].revenue, 550000);
});

test('an order with no priced lines still counts its units, and claims no revenue', () => {
  const bare = order({ finance: undefined });
  const out = buildExport({ orders: [bare], dataset: 'product' });
  assert.equal(out.rows[0].qty, 2);
  assert.equal(out.rows[0].revenue, null, 'tanpa harga, omzet kosong - bukan nol');
});

test('a typed-in sale is named by where it came from, not as "Manual"', () => {
  assert.equal(channelLabel({ channel: 'manual', source: 'DP' }), 'WhatsApp / direct sales');
  assert.equal(channelLabel({ channel: 'manual', source: 'CS' }), 'Consignment');
  assert.equal(channelLabel({ channel: 'shopee' }), 'Shopee');
});

test('each channel filters the rows, and asking for none means asking for all', () => {
  const both = [order(), order({ channel: 'shopify', id: '#10977' })];
  assert.equal(buildExport({ orders: both, dataset: 'order', channels: ['shopee'] }).rows.length, 1);
  assert.equal(buildExport({ orders: both, dataset: 'order', channels: [] }).rows.length, 2);
  assert.equal(buildExport({ orders: both, dataset: 'order', channels: ['nonsense'] }).rows.length, 2);
  // A comma-joined value is what a hand-written URL looks like; it works too.
  assert.deepEqual(resolveChannels(['shopee,shopify']), ['shopee', 'shopify']);
  assert.deepEqual(resolveChannels('shopee'), ['shopee']);
});

test('the file says what is in it and which days it covers', () => {
  const out = buildExport({ orders: [order()], dataset: 'product', range: { from: '2026-09-01', to: '2026-09-22' } });
  assert.equal(exportFilename(out, 'xlsx', { from: '2026-09-01', to: '2026-09-22' }), 'treelogy-product-2026-09-01_2026-09-22.xlsx');
  assert.equal(exportFilename(out, 'csv', { from: '2026-09-22', to: '2026-09-22' }), 'treelogy-product-2026-09-22.csv');
});

test('each format answers with the type its reader expects', () => {
  const out = buildExport({ orders: [order()], dataset: 'order' });
  const csv = renderExport(out, 'csv');
  assert.match(csv.type, /^text\/csv/);
  const xlsx = renderExport(out, 'xlsx');
  assert.match(xlsx.type, /spreadsheetml\.sheet$/);
  assert.equal(xlsx.body.subarray(0, 2).toString(), 'PK', 'xlsx selalu diawali tanda zip');
});

test('every dataset names itself and its tab', () => {
  for (const spec of Object.values(DATASETS)) {
    assert.ok(spec.label && spec.hint && spec.sheet, spec.id);
    assert.ok(spec.sheet.length <= 31, 'nama tab tidak boleh lebih dari 31 huruf');
  }
});

test('a product filter selects rows in the product and item sheets', async () => {
  const { buildExport } = await import('../src/export/orders.js');
  const orders = [
    order(),
    order({ channel: 'shopify', id: '#1', lines: [{ sku: 'OMP-90-001', name: 'Powder', variant: '', qty: 4 }],
      finance: { lines: [{ sku: 'OMP-90-001', name: 'Powder', variant: '', qty: 4, unitPrice: 150000, unitDiscount: 0 }], shipping: 0 } }),
  ];
  const only = buildExport({ orders, dataset: 'product', products: ['OMP-90-001'] });
  assert.equal(only.rows.length, 1);
  assert.equal(only.rows[0].sku, 'OMP-90-001');
  assert.deepEqual(only.products, ['OMP-90-001']);

  const items = buildExport({ orders, dataset: 'item', products: ['OMP-90-001'] });
  assert.equal(items.rows.length, 1);
  assert.equal(items.rows[0].sku, 'OMP-90-001');
});

test('a product filter picks which orders appear, and never rewrites what one is worth', async () => {
  const { buildExport } = await import('../src/export/orders.js');
  const mixed = order({
    lines: [
      { sku: 'OMC180', name: 'Kapsul', variant: '', qty: 2 },
      { sku: 'OMP-90-001', name: 'Powder', variant: '', qty: 1 },
    ],
    finance: { lines: [
      { sku: 'OMC180', name: 'Kapsul', variant: '', qty: 2, unitPrice: 300000, unitDiscount: 25000 },
      { sku: 'OMP-90-001', name: 'Powder', variant: '', qty: 1, unitPrice: 150000, unitDiscount: 0 },
    ], shipping: 0 },
    total: 700000,
  });
  const out = buildExport({ orders: [mixed, order({ id: 'B' })], dataset: 'order', products: ['OMP-90-001'] });
  assert.equal(out.rows.length, 1, 'hanya pesanan yang memuat produk itu');
  // The row is still the whole sale. Reporting part of an order as the whole would be a
  // number that reconciles against nothing.
  assert.equal(out.rows[0].total, 700000);
  assert.equal(out.rows[0].units, 3);
});

test('asking for every product is the same as asking for none of them in particular', async () => {
  const { buildExport, resolveProducts, EXPORT_PRODUCTS } = await import('../src/export/orders.js');
  assert.equal(resolveProducts([]), null);
  assert.equal(resolveProducts(EXPORT_PRODUCTS.map((p) => p.sku)), null, 'semua = tanpa filter');
  assert.equal(resolveProducts(['tidak-ada']), null, 'SKU asing bukan filter');
  // With no filter, a SKU the catalogue has never heard of is still exported.
  const stranger = order({ lines: [{ sku: 'BARU-001', name: 'Baru', variant: '', qty: 1 }], finance: undefined });
  assert.equal(buildExport({ orders: [stranger], dataset: 'product' }).rows.length, 1);
  assert.equal(buildExport({ orders: [stranger], dataset: 'product', products: ['OMP-90-001'] }).rows.length, 0);
});

test('a workbook can carry more than one tab, each with its own rows', () => {
  const second = { ...sheet, name: 'Pesanan', rows: [{ sku: 'X', name: 'y', qty: 9, revenue: 1, at: { n: 1, s: 'z' } }] };
  const files = unzip(toXlsx([sheet, second]));
  assert.ok(files['xl/worksheets/sheet1.xml'] && files['xl/worksheets/sheet2.xml']);
  assert.match(files['xl/workbook.xml'], /name="Produk" sheetId="1" r:id="rId1"/);
  assert.match(files['xl/workbook.xml'], /name="Pesanan" sheetId="2" r:id="rId2"/);
  // Styles must not reuse a worksheet's relationship id, or the workbook will not open.
  assert.match(files['xl/_rels/workbook.xml.rels'], /Id="rId3"[^>]*styles\.xml/);
  assert.match(files['[Content_Types].xml'], /sheet2\.xml/);
  assert.match(files['xl/worksheets/sheet2.xml'], /<v>9<\/v>/);
});

test('two tabs asking for the same name do not collide', () => {
  const files = unzip(toXlsx([sheet, { ...sheet }]));
  assert.match(files['xl/workbook.xml'], /name="Produk"/);
  assert.match(files['xl/workbook.xml'], /name="Produk 2"/);
});

test('one sheet still works exactly as it did', () => {
  assert.deepEqual(toXlsx(sheet), toXlsx([sheet]));
});
