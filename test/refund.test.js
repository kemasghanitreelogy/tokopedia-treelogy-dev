import test from 'node:test';
import assert from 'node:assert/strict';
import { refundOrder, withoutRefunds, REFUNDS_DOC } from '../src/mekari/refund.js';

/**
 * Refund: the order leaves every list and its invoice leaves Jurnal. Money is finance's,
 * by hand - nothing here calls a platform.
 */

const order = { channel: 'shopify', id: '#11452', total: 1145000, stage: 'to_ship' };
const CID = 'TRL-shopify-11452';

function rig({ entry = { invoice_id: 77, total: 1145000 }, invoice = { transaction_no: 'INV-9', payment_received_amount: 0, deletable: true }, getError = null } = {}) {
  const calls = [];
  const state = { ledger: { orders: entry ? { [CID]: entry } : {} }, refunds: null, saved: 0 };
  const deps = {
    read: async (c, id) => (c === order.channel && id === order.id ? order : null),
    call: async (req) => {
      calls.push(`${req.method ?? 'GET'} ${req.path}`);
      if (!req.method && getError) throw getError;
      return { sales_invoice: invoice };
    },
    loadLedger: async () => structuredClone(state.ledger),
    saveLedger: async (l) => { state.ledger = l; state.saved += 1; },
    update: async (key, fn, initial) => { assert.equal(key, REFUNDS_DOC); state.refunds = fn(state.refunds ?? initial); },
  };
  return { calls, state, deps };
}

test('an invoiced order: the invoice is deleted, the ledger voided, the order hidden', async () => {
  const { calls, state, deps } = rig();
  const out = await refundOrder({ channel: 'shopify', id: '#11452', by: 'Kemas' }, deps);
  assert.deepEqual(calls, ['GET /public/jurnal/api/v1/sales_invoices/77', 'DELETE /public/jurnal/api/v1/sales_invoices/77']);
  assert.equal(out.deleted, true);
  assert.equal(out.transactionNo, 'INV-9');
  assert.equal(state.ledger.orders[CID].voided, true);
  assert.equal(state.ledger.orders[CID].refunded, true);
  assert.equal(state.refunds.orders['shopify:#11452'].by, 'Kemas');
});

test('not invoiced yet: no Jurnal call, but the ledger is marked so the sync never posts it', async () => {
  const { calls, state, deps } = rig({ entry: null });
  const out = await refundOrder({ channel: 'shopify', id: '#11452' }, deps);
  assert.deepEqual(calls, []);
  assert.equal(out.deleted, false);
  assert.equal(state.ledger.orders[CID].voided, true);
  assert.ok(state.refunds.orders['shopify:#11452']);
});

test('an invoice with a payment recorded is refused, and the order stays visible', async () => {
  const { calls, state, deps } = rig({ invoice: { transaction_no: 'INV-9', payment_received_amount: 500000, deletable: true } });
  await assert.rejects(() => refundOrder({ channel: 'shopify', id: '#11452' }, deps), /sudah menerima pembayaran/);
  assert.deepEqual(calls, ['GET /public/jurnal/api/v1/sales_invoices/77']);
  assert.equal(state.saved, 0);
  assert.equal(state.refunds, null);
});

test('a Jurnal error other than "not found" stops everything', async () => {
  const { state, deps } = rig({ getError: Object.assign(new Error('timeout'), { status: 503 }) });
  await assert.rejects(() => refundOrder({ channel: 'shopify', id: '#11452' }, deps), /timeout/);
  assert.equal(state.saved, 0);
  assert.equal(state.refunds, null);
});

test('an invoice already gone from Jurnal still lets the order be refunded', async () => {
  const { calls, state, deps } = rig({ getError: Object.assign(new Error('Not Found'), { status: 404 }) });
  const out = await refundOrder({ channel: 'shopify', id: '#11452' }, deps);
  assert.equal(out.deleted, false);
  assert.equal(calls.length, 1, 'no DELETE for an invoice that is not there');
  assert.ok(state.refunds.orders['shopify:#11452']);
});

test('a typed-in sale or an unknown order is refused', async () => {
  const { deps } = rig();
  await assert.rejects(() => refundOrder({ channel: 'manual', id: 'CS-1' }, deps), /Hapus transaksi/);
  await assert.rejects(() => refundOrder({ channel: 'shopee', id: 'NOPE' }, deps), /tidak ada/);
});

test('refunded orders are left out of a list, and only those', () => {
  const data = { orders: [order, { channel: 'shopee', id: 'A' }], range: {} };
  assert.deepEqual(withoutRefunds(data, { 'shopify:#11452': {} }).orders.map((o) => o.id), ['A']);
  assert.equal(withoutRefunds(data, {}), data);
});
