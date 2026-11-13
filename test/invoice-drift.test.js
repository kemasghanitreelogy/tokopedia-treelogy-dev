import test from 'node:test';
import assert from 'node:assert/strict';
import { invoiceSignature, invoiceDrift } from '../src/mekari/drift.js';
import { pendingAmends } from '../src/mekari/sync.js';
import { customIdFor } from '../src/mekari/invoice.js';

const order = (lines, extra = {}) => ({
  channel: 'shopify', id: '#13131', stage: 'to_ship',
  finance: { lines, shipping: 0, currency: 'IDR' }, ...extra,
});
const bundle = [{ sku: 'Inside-Out-60-Protocol180+30', qty: 1, unitPrice: 1045000, unitDiscount: 0 }];
const swapped = [
  { sku: 'OMC-270-001', qty: 1, unitPrice: 1145000, unitDiscount: 0 },
  { sku: 'OMO-30-001', qty: 1, unitPrice: 470000, unitDiscount: 470000 },
];

test('the fingerprint ignores line order and notices any change to what is invoiced', () => {
  assert.equal(invoiceSignature(order(swapped)), invoiceSignature(order([...swapped].reverse())));
  assert.notEqual(invoiceSignature(order(bundle)), invoiceSignature(order(swapped)));
  const sameTotalSwap = [{ sku: 'OMC-180-001', qty: 1, unitPrice: 1045000, unitDiscount: 0 }];
  assert.notEqual(invoiceSignature(order(bundle)), invoiceSignature(order(sameTotalSwap)), 'a swap at the same price is still a change');
  const discounted = [{ ...bundle[0], unitDiscount: 100000 }];
  assert.notEqual(invoiceSignature(order(bundle)), invoiceSignature(order(discounted)));
});

test('an invoice whose order changed is rewritten; one that did not is left alone', () => {
  const entry = { invoice_id: 1, total: 1045000, sig: invoiceSignature(order(bundle)) };
  assert.equal(invoiceDrift(order(bundle), entry), null);
  assert.equal(invoiceDrift(order(swapped), entry), 'changed');
  assert.equal(invoiceDrift(order(swapped), { ...entry, voided: true }), null);
  assert.equal(invoiceDrift(order(swapped), { ...entry, needs_review: 'paid' }), null, 'a refusal is not retried every push');
  assert.equal(invoiceDrift({ ...order(swapped), channel: 'shopee' }, entry), null);
});

test('an older invoice without a fingerprint is adopted when it agrees, untouched when it does not', () => {
  assert.equal(invoiceDrift(order(bundle), { invoice_id: 1, total: 1045000 }), 'adopt');
  assert.equal(invoiceDrift(order(swapped), { invoice_id: 1, total: 1160000 }), null, 'old discount gaps wait for the audit');
});

test('the sweep picks up a changed order whose push never arrived', () => {
  const o = order(swapped);
  const ledger = { orders: { [customIdFor(o)]: { invoice_id: 1, total: 1045000, sig: invoiceSignature(order(bundle)) } } };
  assert.equal(pendingAmends([o], ledger).length, 1);
  ledger.orders[customIdFor(o)].sig = invoiceSignature(o);
  assert.equal(pendingAmends([o], ledger).length, 0);
  assert.equal(pendingAmends([{ ...o, stage: 'cancelled' }], ledger).length, 0);
});
