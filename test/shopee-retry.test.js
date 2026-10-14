import test from 'node:test';
import assert from 'node:assert/strict';
import { rearrangedAfterFailure, markRearranged, resetRetryMemo, RETRY_CHECK_MS } from '../src/shopee/retry.js';
import { nextAction } from '../src/fulfillment.js';
import { labelReadiness } from '../src/labels.js';

/**
 * 261013GVQ7G0ND, 14 Oct 2026: Gosend gave the parcel back, Shopee went RETRY_SHIP, the
 * team arranged it again in Seller Centre - and Shopee still said RETRY_SHIP, so the
 * Proses page kept offering it. The tracking history, newest first, as Shopee sent it.
 */
const history = [
  { update_time: 1791962066, logistics_status: 'ORDER_CREATED', description: 'Sedang mencari Kurir , mohon tunggu beberapa saat.' },
  { update_time: 1791962066, logistics_status: 'ORDER_CREATED', description: 'Pengirim telah mengatur pengiriman. Menunggu pesanan diserahkan ke pihak jasa kirim.' },
  { update_time: 1791960631, logistics_status: 'UNKNOW', description: 'Pesanan gagal di-pick up :no_space_in_bag - Paket terlalu besar/berat untuk kendaraan. Segera jadwalkan ulang pick up pesananan.' },
  { update_time: 1791960622, logistics_status: 'ORDER_CREATED', description: 'Kurir ditugaskan untuk menjemput pesanan.' },
  { update_time: 1791948495, logistics_status: 'ORDER_CREATED', description: 'Pengirim telah mengatur pengiriman. Menunggu pesanan diserahkan ke pihak jasa kirim.' },
];
const retry = { channel: 'shopee', id: '261013GVQ7G0ND', stage: 'to_ship', status: 'RETRY_SHIP', carrier: 'Gosend Instant' };

test('arranged again after the failed pickup counts as arranged', () => {
  assert.equal(rearrangedAfterFailure(history), 1791962066);
});

test('a failed pickup not yet arranged again still needs arranging', () => {
  assert.equal(rearrangedAfterFailure(history.slice(2)), 0, 'only the arrangement before the failure');
  assert.equal(rearrangedAfterFailure(history.slice(3)), 0, 'arranged but never failed is not this case');
  assert.equal(rearrangedAfterFailure([]), 0);
});

test('a second failure after the re-arrangement needs arranging again', () => {
  const again = [{ update_time: 1791963000, logistics_status: 'UNKNOW', description: 'Pesanan gagal di-pick up: kurir tidak ditemukan' }, ...history];
  assert.equal(rearrangedAfterFailure(again), 0);
});

test('the Proses page stops offering a re-arranged order, and only that one', async () => {
  resetRetryMemo();
  const fresh = { channel: 'shopee', id: 'X', stage: 'to_ship', status: 'RETRY_SHIP' };
  const ready = { channel: 'shopee', id: 'Y', stage: 'to_ship', status: 'READY_TO_SHIP', carrier: 'J&T' };
  const asked = [];
  const data = await markRearranged({ orders: [retry, fresh, ready] }, { read: async (sn) => { asked.push(sn); return sn === retry.id ? history : history.slice(2); } });
  assert.deepEqual(asked, [retry.id, 'X'], 'READY_TO_SHIP is never looked up');
  assert.equal(nextAction(data.orders[0]), null);
  assert.equal(nextAction(data.orders[1]).action, 'shopee_ship');
  assert.equal(nextAction(data.orders[2]).action, 'shopee_ship');
});

test('a history read is reused for a while, and a failed read leaves the row offered', async () => {
  resetRetryMemo();
  let reads = 0;
  const read = async () => { reads += 1; return history; };
  await markRearranged({ orders: [retry] }, { read, now: 1000 });
  await markRearranged({ orders: [retry] }, { read, now: 1000 + RETRY_CHECK_MS - 1 });
  assert.equal(reads, 1);
  await markRearranged({ orders: [retry] }, { read, now: 1000 + RETRY_CHECK_MS + 1 });
  assert.equal(reads, 2);

  resetRetryMemo();
  const data = await markRearranged({ orders: [retry] }, { read: async () => { throw new Error('down'); } });
  assert.equal(nextAction(data.orders[0]).action, 'shopee_ship');
});

test('the Label tab offers the new waybill, and a label printed before the re-arrangement is not it', () => {
  const at = 1791962066;
  const o = { ...retry, rearranged: at };
  assert.equal(labelReadiness(o, {}).state, 'needsPrint');
  const old = labelReadiness(o, { 'shopee:261013GVQ7G0ND': { at: 1791946615, first: 1791946615 } });
  assert.equal(old.state, 'needsPrint');
  assert.match(old.note, /cetak label baru/);
  assert.equal(labelReadiness(o, { 'shopee:261013GVQ7G0ND': { at: at + 60, first: 1791946615 } }).state, 'reprint');
  assert.equal(labelReadiness(retry, {}).state, 'waiting', 'not re-arranged yet: no waybill to print');
});
