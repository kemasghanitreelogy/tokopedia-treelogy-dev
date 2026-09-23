import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import {
  LABEL_SIZES, DEFAULT_SIZE, mergeLabels, labelSizeMm, PRINTABLE_STAGES, labelReadiness, TIKTOK_DOCUMENT_TYPE,
} from '../src/labels.js';

/**
 * A real PDF of the given size. Pages carry actual content because pdf-lib refuses to
 * embed a page with no content stream - the same way a damaged carrier PDF would fail.
 */
async function samplePdf(width, height, pages = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([width, height]);
    page.drawRectangle({ x: 10, y: 10, width: width - 20, height: height - 20 });
  }
  return doc.save();
}

/** A structurally valid PDF whose page has no content stream. */
async function blankPagePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([297.1, 419.0]);
  return doc.save();
}

test('every label size is a sane thermal stock', () => {
  for (const [id, size] of Object.entries(LABEL_SIZES)) {
    assert.ok(size.width > 0 && size.height > 0, id);
    assert.ok(size.height >= size.width, `${id} should be portrait`);
  }
  assert.ok(Object.hasOwn(LABEL_SIZES, DEFAULT_SIZE));
});

test('the default is the page the couriers themselves issue', () => {
  // Both TikTok's document and Shopee's thermal waybill arrive at about 298 x 420pt.
  // Anything narrower fits them smaller than the courier drew them.
  assert.equal(DEFAULT_SIZE, 'a6');
  assert.deepEqual(labelSizeMm(DEFAULT_SIZE), { width: 105, height: 148 });
  const stock = LABEL_SIZES[DEFAULT_SIZE];
  assert.ok(stock.width >= 298 && stock.height >= 420, 'kertas tidak boleh lebih kecil dari dokumen kurir');
});

test('a courier page passes through the default at full size, and shrinks on narrower stock', async () => {
  const courier = await samplePdf(298, 420);
  const scaleOn = async (size) => {
    const { bytes } = await mergeLabels([{ order: { id: 'X', channel: 'shopee' }, bytes: courier }], size);
    const page = (await PDFDocument.load(bytes)).getPages()[0];
    const { width, height } = page.getSize();
    return Math.min(width / 298, height / 420);
  };
  // 1:1 is the whole point: a waybill printed at 95% is a waybill smaller than the one
  // every other tool prints from the same document.
  assert.ok(Math.abs(await scaleOn(DEFAULT_SIZE) - 1) < 0.001, 'ukuran asli tidak dikecilkan');
  assert.ok(Math.abs(await scaleOn('100x150') - 0.9512) < 0.001, '100x150 memang mengecilkan');
});

test('an unknown size falls back rather than producing a zero-sized page', () => {
  assert.deepEqual(labelSizeMm('tidak-ada'), labelSizeMm(DEFAULT_SIZE));
});

test('merged pages are all normalised to the requested stock', async () => {
  const merged = await mergeLabels([
    { order: { id: 'a', channel: 'shopee' }, bytes: await samplePdf(297.1, 419.0) },
    { order: { id: 'b', channel: 'tokopedia' }, bytes: await samplePdf(595, 842) }, // A4
  ], '100x150');

  const doc = await PDFDocument.load(merged.bytes);
  assert.equal(doc.getPageCount(), 2);
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    assert.ok(Math.abs(width - LABEL_SIZES['100x150'].width) < 0.01);
    assert.ok(Math.abs(height - LABEL_SIZES['100x150'].height) < 0.01);
  }
  assert.equal(merged.pageCount, 2);
});

test('a multi-page source contributes every page', async () => {
  const merged = await mergeLabels(
    [{ order: { id: 'batch', channel: 'shopee' }, bytes: await samplePdf(297.1, 419.0, 5) }],
    '100x150',
  );
  assert.equal(merged.pageCount, 5);
});

test('a corrupt document is reported, and the rest still print', async () => {
  const merged = await mergeLabels([
    { order: { id: 'rusak', channel: 'shopee' }, bytes: new Uint8Array([1, 2, 3, 4]) },
    { order: { id: 'baik', channel: 'shopee' }, bytes: await samplePdf(297.1, 419.0) },
  ], '100x150');

  assert.equal(merged.pageCount, 1);
  assert.equal(merged.failures.length, 1);
  assert.equal(merged.failures[0].id, 'rusak');
});

test('a landscape source is fitted, never cropped', async () => {
  // Fitting must preserve the aspect ratio; a barcode clipped at the edge is unscannable.
  const merged = await mergeLabels(
    [{ order: { id: 'wide', channel: 'shopee' }, bytes: await samplePdf(800, 200) }],
    '100x150',
  );
  const doc = await PDFDocument.load(merged.bytes);
  const { width, height } = doc.getPage(0).getSize();
  assert.ok(Math.abs(width - LABEL_SIZES['100x150'].width) < 0.01);
  assert.ok(Math.abs(height - LABEL_SIZES['100x150'].height) < 0.01);
  assert.equal(merged.pageCount, 1);
});

test('a page with no content stream is isolated, not fatal to the run', async () => {
  // pdf-lib throws on embed for such a page; without a guard it would abort the merge
  // and lose every other label in the batch.
  const merged = await mergeLabels([
    { order: { id: 'kosong', channel: 'shopee' }, bytes: await blankPagePdf() },
    { order: { id: 'baik', channel: 'shopee' }, bytes: await samplePdf(297.1, 419.0) },
  ], '100x150');

  assert.equal(merged.pageCount, 1);
  assert.equal(merged.failures.length, 1);
  assert.equal(merged.failures[0].id, 'kosong');
});

test('merging nothing yields an empty document, not a crash', async () => {
  const merged = await mergeLabels([], '100x150');
  assert.equal(merged.pageCount, 0);
  assert.equal(merged.failures.length, 0);
});

test('only stages whose waybill can exist are printable', () => {
  assert.equal(PRINTABLE_STAGES.has('to_ship'), true);
  assert.equal(PRINTABLE_STAGES.has('shipping'), true);
  assert.equal(PRINTABLE_STAGES.has('unpaid'), false);
  assert.equal(PRINTABLE_STAGES.has('cancelled'), false);
  assert.equal(PRINTABLE_STAGES.has('completed'), false);
});

test('only a document that exists and is still ours counts as needing print', async () => {
  const { labelReadiness } = await import('../src/labels.js');
  // Verified by actually printing against the live shop, status by status.
  assert.equal(labelReadiness({ channel: 'tokopedia', status: 'AWAITING_COLLECTION' }).state, 'needsPrint');
  assert.equal(labelReadiness({ channel: 'shopee', status: 'PROCESSED' }).state, 'needsPrint');
});

test('a parcel the courier already took is a reprint, not part of the batch', async () => {
  const { labelReadiness } = await import('../src/labels.js');
  for (const status of ['SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED']) {
    assert.equal(labelReadiness({ channel: 'shopee', status }).state, 'reprint');
  }
});

test('TikTok stops issuing documents after pickup, so a reprint is unavailable', async () => {
  const { labelReadiness } = await import('../src/labels.js');
  for (const status of ['IN_TRANSIT', 'DELIVERED', 'COMPLETED']) {
    const r = labelReadiness({ channel: 'tiktok_shop', status });
    assert.equal(r.state, 'reprint');
    assert.equal(r.unavailable, true, `${status} must be marked unavailable`);
  }
});

test('an order with no document yet is separated from one that never will have one', async () => {
  const { labelReadiness } = await import('../src/labels.js');
  assert.equal(labelReadiness({ channel: 'shopee', status: 'READY_TO_SHIP' }).state, 'waiting');
  assert.equal(labelReadiness({ channel: 'tokopedia', status: 'AWAITING_SHIPMENT' }).state, 'arrange');
  assert.equal(labelReadiness({ channel: 'shopee', status: 'CANCELLED' }).state, 'none');
});

test('every verdict carries a reason a human can act on', async () => {
  const { labelReadiness } = await import('../src/labels.js');
  for (const order of [
    { channel: 'tokopedia', status: 'AWAITING_SHIPMENT' },
    { channel: 'tokopedia', status: 'IN_TRANSIT' },
    { channel: 'shopee', status: 'READY_TO_SHIP' },
    { channel: 'shopee', status: 'SOMETHING_NEW' },
  ]) {
    const { note } = labelReadiness(order);
    assert.ok(note && note.length > 5, `${order.channel}/${order.status} has no usable note`);
  }
});

test('a typed-in sale with an address is a label we draw; without one it is nothing', () => {
  assert.equal(labelReadiness({ channel: 'manual', id: 'DP-1', stage: 'completed', shipTo: 'Jl. Nakula 5, Salatiga' }).state, 'needsPrint');
  assert.equal(labelReadiness({ channel: 'manual', id: 'DP-1', stage: 'completed', shipTo: 'Jl. Nakula 5, Salatiga' }, { 'DP-1': { at: 1 } }).state, 'reprint');
  const walkIn = labelReadiness({ channel: 'manual', id: 'DW-1', stage: 'completed', shipTo: '' });
  assert.equal(walkIn.state, 'none');
  assert.match(walkIn.note, /tanpa alamat/);
});

test('the TikTok waybill is fetched with the packing slip attached to it', () => {
  // Same A6 page, same barcode, but the slip under the waybill names every line, its
  // SKU and its quantity. Asking for the bare SHIPPING_LABEL sent parcels to the bench
  // with nothing on them saying what to put in the box. The value is the one the API
  // itself lists as allowed; a typo here fails the whole print run with 36009004.
  assert.equal(TIKTOK_DOCUMENT_TYPE, 'SHIPPING_LABEL_AND_PACKING_SLIP');
});

test('the waybill number is looked up only for the orders that do not carry one', async () => {
  const { shopeeTracking } = await import('../src/labels.js');
  const asked = [];
  const call = async (config, path, auth, query) => {
    assert.equal(path, '/api/v2/logistics/get_tracking_number');
    asked.push(query.order_sn);
    if (query.order_sn === 'C') throw new Error('logistics.order_not_found');
    // An order the courier has not numbered yet answers with an empty string.
    return { response: { tracking_number: query.order_sn === 'D' ? '' : `CM${query.order_sn}` } };
  };
  const found = await shopeeTracking({}, {}, [
    { id: 'A', tracking: 'CM111' },
    { id: 'B' },
    { id: 'C' },
    { id: 'D', tracking: '   ' },
  ], { call });

  assert.deepEqual(asked.sort(), ['B', 'C', 'D'], 'yang sudah punya resi tidak ditanyakan lagi');
  assert.equal(found.get('A'), 'CM111', 'yang sudah dipegang dipakai apa adanya');
  assert.equal(found.get('B'), 'CMB');
  // Neither a refusal nor a blank is a tracking number, and neither may be sent as one:
  // Shopee answers a create without it with "The tracking number is invalid".
  assert.equal(found.has('C'), false);
  assert.equal(found.has('D'), false);
});

test('a marketplace label that has been printed leaves the queue, the way a Shopify one does', () => {
  // Shopee holds an order at PROCESSED for hours after the waybill is printed, and
  // TikTok holds it at AWAITING_COLLECTION, so the platform's status cannot say whether
  // the sheet came out of the printer. Only our own ledger can.
  const shopee = { channel: 'shopee', id: '260922NYRBTMG5', status: 'PROCESSED' };
  const tiktok = { channel: 'tokopedia', id: '5861937', status: 'AWAITING_COLLECTION' };
  assert.equal(labelReadiness(shopee).state, 'needsPrint');
  assert.equal(labelReadiness(tiktok).state, 'needsPrint');

  const ledger = { 'shopee:260922NYRBTMG5': { at: 1 }, 'tokopedia:5861937': { at: 1 } };
  assert.equal(labelReadiness(shopee, ledger).state, 'reprint');
  assert.equal(labelReadiness(shopee, ledger).note, 'sudah dicetak');
  assert.equal(labelReadiness(tiktok, ledger).state, 'reprint');

  // A different channel's order of the same number is a different parcel.
  assert.equal(labelReadiness({ channel: 'shopify', id: '260922NYRBTMG5', stage: 'to_ship' }, ledger).state, 'needsPrint');
});

test('the ledger still recognises a Shopify order written before it had channels', () => {
  const order = { channel: 'shopify', id: '#10926', stage: 'to_ship' };
  assert.equal(labelReadiness(order, { '#10926': { at: 1 } }).state, 'reprint', 'entri lama tetap terbaca');
  assert.equal(labelReadiness(order, { 'shopify:#10926': { at: 1 } }).state, 'reprint');
});

test('an order whose document does not exist yet is never called printed', () => {
  // Nothing could have come out of the printer for it, and "menunggu dokumen terbit di
  // kurir" tells the bench what to do next; "sudah dicetak" would send them looking for
  // a sheet that was never made.
  const waiting = { channel: 'shopee', id: 'X', status: 'READY_TO_SHIP' };
  assert.equal(labelReadiness(waiting, { 'shopee:X': { at: 1 } }).state, 'waiting');
  assert.match(labelReadiness(waiting, { 'shopee:X': { at: 1 } }).note, /menunggu dokumen/);

  const unarranged = { channel: 'tokopedia', id: 'Y', status: 'AWAITING_SHIPMENT' };
  assert.equal(labelReadiness(unarranged, { 'tokopedia:Y': { at: 1 } }).state, 'arrange');

  // And one the courier already took stays a reprint for that reason, not for the ledger.
  const gone = { channel: 'shopee', id: 'Z', status: 'SHIPPED' };
  assert.equal(labelReadiness(gone, {}).note, 'sudah diambil kurir');
});

test('a run comes out as one stack per channel, with Tokopedia and TikTok on the same one', async () => {
  const { LABEL_GROUPS, labelGroup } = await import('../src/labels.js');
  // One shop behind one API, one courier booking and one pickup.
  assert.equal(labelGroup('tokopedia'), 'tiktok');
  assert.equal(labelGroup('tiktok_shop'), 'tiktok');
  assert.equal(LABEL_GROUPS.tiktok.label, 'Tokopedia & TikTok Shop');
  // The rest stand alone, because they are handed over separately.
  assert.equal(labelGroup('shopee'), 'shopee');
  assert.equal(labelGroup('shopify'), 'shopify');
  assert.equal(labelGroup('manual'), 'manual');
  // A channel nobody has heard of still lands on a stack rather than vanishing.
  assert.ok(LABEL_GROUPS[labelGroup('sesuatu')]);
});

test('the stacks are built in a fixed order, so the same run prints the same way twice', async () => {
  const { buildLabelSheet } = await import('../src/labels.js');
  const sheet = await buildLabelSheet({
    orders: [
      { channel: 'manual', id: 'DP-1' },
      { channel: 'shopify', id: '#1' },
    ],
    resolveShopify: async (selection) => selection.map((o) => ({
      ...o, buyer: 'X', shipTo: 'Jl. Satu', total: 1000, lines: [{ sku: 'A', name: 'A', variant: '', qty: 1 }], finance: { shipping: 0 },
    })),
  });
  assert.deepEqual(sheet.groups.map((g) => g.key), ['shopify', 'manual'], 'urutan mengikuti daftar, bukan urutan jawaban');
  // Two channels drawn by the same code are still two stacks at the printer.
  assert.equal(sheet.groups.length, 2);
  for (const group of sheet.groups) {
    assert.equal(group.pageCount, 1);
    assert.ok(group.bytes?.length > 0);
  }
  assert.equal(sheet.pageCount, 2);
  assert.deepEqual(sheet.printed.sort(), ['manual:DP-1', 'shopify:#1']);
});
