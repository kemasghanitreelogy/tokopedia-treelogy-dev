import test from 'node:test';
import assert from 'node:assert/strict';
import { labelReadiness, labelSignature, printKey } from '../src/labels.js';

const order = (lines, extra = {}) => ({
  channel: 'shopify', id: '#13131', stage: 'to_ship', buyer: 'Wiwiek', buyerPhone: '0813', shipTo: 'Cengkareng',
  lines, ...extra,
});
const bundle = [{ sku: 'Inside-Out-60-Protocol180+30', qty: 1 }, { sku: 'GFT-POUCH-001', qty: 1 }];
const swapped = [{ sku: 'OMC-270-001', qty: 1 }, { sku: 'OMO-30-001', qty: 1 }];
const arranged = { '#13131': 1 };
const printedAs = (o) => ({ [printKey('shopify', '#13131')]: { at: 1, by: 'a', times: 1, sig: labelSignature(o) } });

test('a Shopify label printed and then edited in Shopify goes back to the queue, named', () => {
  const printed = printedAs(order(bundle));
  assert.equal(labelReadiness(order(bundle), printed, arranged).state, 'reprint');
  assert.deepEqual(labelReadiness(order(swapped), printed, arranged), { state: 'needsPrint', note: 'diubah setelah dicetak - cetak ulang' });
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
