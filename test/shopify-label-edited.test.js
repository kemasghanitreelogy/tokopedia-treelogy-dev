import test from 'node:test';
import assert from 'node:assert/strict';
import { labelReadiness, labelSignature, labelSnapshot, printKey } from '../src/labels.js';
import { renderLabels } from '../src/dashboard-page.js';

const order = (lines, extra = {}) => ({
  channel: 'shopify', id: '#13131', stage: 'to_ship', buyer: 'Wiwiek', buyerPhone: '0813', shipTo: 'Cengkareng',
  lines, ...extra,
});
const bundle = [{ sku: 'Inside-Out-60-Protocol180+30', qty: 1 }, { sku: 'GFT-POUCH-001', qty: 1 }];
const swapped = [{ sku: 'OMC-270-001', qty: 1 }, { sku: 'OMO-30-001', qty: 1 }];
const arranged = { '#13131': 1 };
const printedAs = (o) => ({ [printKey('shopify', '#13131')]: { at: 1, by: 'a', times: 1, sig: labelSignature(o), as: labelSnapshot(o) } });

test('a Shopify label printed and then edited in Shopify goes back to the queue, named', () => {
  const printed = printedAs(order(bundle));
  assert.equal(labelReadiness(order(bundle), printed, arranged).state, 'reprint');
  assert.deepEqual(labelReadiness(order(swapped), printed, arranged), { state: 'needsPrint', changed: true, note: 'diubah setelah dicetak - cetak ulang', what: ['produk'] });
});

test('the address or the name moving sends it back too; nothing else on the order does', () => {
  const printed = printedAs(order(bundle));
  assert.equal(labelReadiness(order(bundle, { shipTo: 'Kebon Jeruk' }), printed, arranged).state, 'needsPrint');
  assert.equal(labelReadiness(order(bundle, { buyer: 'Budi' }), printed, arranged).state, 'needsPrint');
  assert.equal(labelReadiness(order(bundle, { note: 'kirim pagi', total: 1 }), printed, arranged).state, 'reprint');
  assert.equal(labelReadiness(order([...bundle].reverse()), printed, arranged).state, 'reprint', 'line order is not a change');
});

test('a label printed before fingerprints existed stays printed', () => {
  const printed = { [printKey('shopify', '#13131')]: { at: 1, by: 'a', times: 1 } };
  assert.equal(labelReadiness(order(swapped), printed, arranged).state, 'reprint');
});

test('reprinting with the new contents settles it', () => {
  assert.equal(labelReadiness(order(swapped), printedAs(order(swapped)), arranged).state, 'reprint');
});

test('which part of the sheet is wrong is kept for the info icon, not written into the note', () => {
  const printed = printedAs(order(bundle));
  const moved = labelReadiness(order(bundle, { shipTo: 'Kebon Jeruk' }), printed, arranged);
  assert.equal(moved.note, 'diubah setelah dicetak - cetak ulang');
  assert.deepEqual(moved.what, ['alamat']);
  assert.deepEqual(labelReadiness(order(swapped, { buyer: 'Budi', buyerPhone: '0812' }), printed, arranged).what, ['produk', 'nama', 'telepon']);
  const hashOnly = { [printKey('shopify', '#13131')]: { at: 1, by: 'a', times: 1, sig: labelSignature(order(bundle)) } };
  assert.equal(labelReadiness(order(swapped), hashOnly, arranged).what, undefined);
});

test('labels to reprint lead the list, and their filter shows only when there are some', () => {
  const fresh = order(bundle, { id: '#13200', createdAt: 1 });
  const edited = order(swapped, { createdAt: 2 });
  const args = { range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null,
    sizes: { a6: { label: 'A6' } }, defaultSize: 'a6', arranged: { '#13131': 1, '#13200': 1 } };
  const html = renderLabels({ ...args, orders: [fresh, edited], printed: printedAs(order(bundle)) });
  assert.ok(html.indexOf('data-id="#13131"') < html.indexOf('data-id="#13200"'), 'the edited one is first');
  assert.match(html, /changed=1">Data berubah &middot; 1/);
  assert.match(html, /class="lb-tip"[^>]*data-tip="Yang berubah: produk"/);
  const only = renderLabels({ ...args, orders: [fresh, edited], printed: printedAs(order(bundle)), onlyChanged: true });
  assert.doesNotMatch(only, /data-id="#13200"/);
  const none = renderLabels({ ...args, orders: [fresh], printed: {} });
  assert.doesNotMatch(none, /changed=1/);
});
