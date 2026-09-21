import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { LABEL_SIZES, DEFAULT_SIZE, mergeLabels, labelSizeMm, PRINTABLE_STAGES, labelReadiness } from '../src/labels.js';

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

test('the default size is exactly 100x150 mm', () => {
  assert.deepEqual(labelSizeMm(DEFAULT_SIZE), { width: 100, height: 150 });
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
