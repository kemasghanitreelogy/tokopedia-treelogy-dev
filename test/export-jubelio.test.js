import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExport, exportFilename, DATASETS } from '../src/export/orders.js';

/**
 * Jubelio's "Daftar Penjualan", as closely as our own data allows.
 *
 * Every expectation here was read off a real export - Daftar Penjualan (4).xlsx, 332
 * rows - rather than described from memory.
 */

const order = (channel, id, over = {}) => ({
  channel, id, buyer: 'Puji', buyerPhone: '', carrier: 'JNE Reguler',
  stage: 'completed', status: 'COMPLETED', total: 418275, createdAt: 1790000000,
  lines: [{ sku: 'OMC-90-001', qty: 1 }],
  finance: { lines: [{ sku: 'OMC-90-001', qty: 1, unitPrice: 485000, unitDiscount: 0 }], shipping: 0 },
  ...over,
});

const sheetOf = (orders) => buildExport({ dataset: 'jubelio', orders, channels: null, products: null, range: null });
const row = (orders, i = 0) => sheetOf(orders).rows[i];

test('the twenty-two columns, in Jubelio’s order', () => {
  assert.deepEqual(sheetOf([order('shopee', 'A')]).columns.map((c) => c.label), [
    'Tanggal', 'No Pesanan', 'REF', 'No Invoice', 'Channel', 'Nama Toko', 'Lokasi',
    'Pelanggan', 'No Telp', 'Kurir', 'Status', 'Diskon', 'Diskon Lainnya',
    'Potongan Biaya', 'Biaya Lainnya', 'Pajak', 'Ongkir', 'Asuransi', 'Tip Shopify',
    'Biaya Proses Pesanan', 'Total', 'Grand Total',
  ]);
});

test('each channel gets the name, store and prefix Jubelio gives it', () => {
  const seen = (ch, id, over) => {
    const r = row([order(ch, id, over)]);
    return [r.channel, r.store, r.number, r.ref];
  };
  assert.deepEqual(seen('shopee', '260923Q39BFE95'),
    ['SHOPEE', 'Treelogy Moringa', 'SP-260923Q39BFE95', '260923Q39BFE95']);
  assert.deepEqual(seen('tokopedia', '586207367899284488'),
    ['TOKOPEDIA', 'Treelogy Moringa (TTS)', 'TP-586207367899284488', '586207367899284488']);
  // TikTok Shop is "Shop | Tokopedia" in their file, sharing the TTS store.
  assert.deepEqual(seen('tiktok_shop', '586207028279870613'),
    ['Shop | Tokopedia', 'Treelogy Moringa (TTS)', 'TT-586207028279870613', '586207028279870613']);
});

test('Shopify numbers by its name and refs by the numeric id behind it', () => {
  // Their row: SHF-10983 with REF 6696815689916. The number is on the order, the id is
  // in the gid.
  const r = row([order('shopify', '#10983', { gid: 'gid://shopify/Order/6696815689916' })]);
  assert.equal(r.number, 'SHF-10983');
  assert.equal(r.ref, '6696815689916');
  assert.equal(r.store, 'treelogy.com');
});

test('Jubelio’s running id is left off, because it belongs to Jubelio', () => {
  // Theirs read TP-586207367899284488-128884. That suffix is a row id in their database
  // and cannot be reproduced from outside it; inventing one would be worse than omitting.
  const r = row([order('tokopedia', '586207367899284488')]);
  // The number is the prefix and the platform id, and stops there. Asserted as equality
  // rather than "no trailing digits", which the platform id itself would have matched.
  assert.equal(r.number, `TP-${r.ref}`);
});

test('every row says Gudang Pusat, as all 332 of theirs did', () => {
  assert.equal(row([order('shopee', 'A')]).location, 'Gudang Pusat');
});

test('the arithmetic is theirs, and holds', () => {
  // Grand Total = Total - Diskon - Diskon Lainnya - Potongan Biaya - Biaya Lainnya
  //                     + Pajak + Ongkir + Asuransi - Biaya Proses Pesanan
  const r = row([order('shopify', '#1', {
    finance: { lines: [{ sku: 'X', qty: 2, unitPrice: 400000, unitDiscount: 50000 }], shipping: 25000 },
  })]);
  assert.equal(r.total, 700000, 'nilai barang setelah diskon baris');
  assert.equal(r.shipping, 25000);
  const calc = r.total - r.discount - r.otherDiscount - r.feeDeduction - r.otherFee
    + r.tax + r.shipping + r.insurance - r.processFee;
  assert.equal(r.grandTotal, calc);
  assert.equal(r.grandTotal, 725000);
});

test('the fee columns stay at zero rather than carrying a plausible guess', () => {
  /*
   * Jubelio fills Potongan Biaya and Biaya Proses Pesanan because it pulls each
   * marketplace's settlement report. We read orders, and an order does not carry what
   * the platform will later deduct from it. A number there would make the file reconcile
   * against nothing while looking like it should.
   */
  const r = row([order('shopee', 'A', { total: 418275 })]);
  assert.equal(r.feeDeduction, 0);
  assert.equal(r.processFee, 0);
  assert.equal(r.tax, 0);
  assert.equal(r.insurance, 0);
  assert.equal(r.tip, '', 'Tip Shopify kosong di seluruh 332 baris mereka');
  assert.equal(r.invoice, '', 'No Invoice juga');
});

test('our stage is written in their vocabulary', () => {
  const statusOf = (stage) => row([order('shopee', 'A', { stage })]).status;
  assert.equal(statusOf('to_ship'), 'PAID');
  assert.equal(statusOf('shipping'), 'SHIPPED');
  assert.equal(statusOf('completed'), 'COMPLETED');
  assert.equal(statusOf('delivered'), 'COMPLETED');
  // Not in their sample of live orders, but a cancelled order has to say so.
  assert.equal(statusOf('cancelled'), 'CANCELLED');
  assert.equal(statusOf('unpaid'), 'PENDING');
});

test('oldest first, the way a sales list reads', () => {
  const rows = sheetOf([
    order('shopee', 'NEW', { createdAt: 2000 }),
    order('shopee', 'OLD', { createdAt: 1000 }),
  ]).rows;
  assert.deepEqual(rows.map((r) => r.ref), ['OLD', 'NEW']);
});

test('the file is named the way Jubelio names it', () => {
  // The point of the format is that somebody downstream recognises it unopened.
  const sheet = sheetOf([order('shopee', 'A')]);
  assert.equal(exportFilename(sheet, 'xlsx', { from: '2026-09-23', to: '2026-09-29' }),
    'Daftar Penjualan 2026-09-23_2026-09-29.xlsx');
  assert.equal(exportFilename(sheet, 'csv', { from: '2026-09-29', to: '2026-09-29' }),
    'Daftar Penjualan 2026-09-29.csv');
});

test('it is offered in the dialog like every other shape', () => {
  assert.equal(DATASETS.jubelio.label, 'Format Jubelio');
  assert.match(DATASETS.jubelio.hint, /settlement/);
});
