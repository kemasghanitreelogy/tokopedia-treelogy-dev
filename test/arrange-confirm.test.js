import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arrangeShopee, arrangeSummary, confirmArranged, nextAction, runAction, RETRY_REFUSAL, SELLER_CENTRE_ORDERS,
} from '../src/fulfillment.js';
import { renderProcess } from '../src/dashboard-page.js';

/*
 * 261105GEVT7Q6C, 6 Nov 2026: pickup failed, Shopee said RETRY_SHIP, and ship_order was
 * sent ten times. Every call came back without an error, every one was reported as
 * "berhasil", and Shopee's status and tracking never moved.
 */
const row = (id, channel = 'shopee') => ({ channel, id, status: 'ok' });
const live = (id, status, stage = 'to_ship', channel = 'shopee') => ({ channel, id, status, stage });
const answering = (...reads) => {
  const asked = [];
  const refresh = async (selection) => { asked.push(selection); return reads.shift() ?? { orders: [] }; };
  return { refresh, asked };
};
const noWait = { waits: [1, 1], wait: async () => {} };

test('a call without an error is not a success until the platform status moved', async () => {
  const { refresh } = answering({ orders: [live('A', 'READY_TO_SHIP')] }, { orders: [live('A', 'READY_TO_SHIP')] }, { orders: [live('A', 'READY_TO_SHIP')] });
  const [result] = await confirmArranged([row('A')], { refresh, ...noWait });
  assert.equal(result.status, 'unconfirmed');
  assert.match(result.error, /masih READY_TO_SHIP/);
});

test('a status that moves a moment later is confirmed, and only that parcel is read again', async () => {
  const { refresh, asked } = answering(
    { orders: [live('A', 'PROCESSED'), live('B', 'READY_TO_SHIP')] },
    { orders: [live('B', 'PROCESSED')] },
  );
  const results = await confirmArranged([row('A'), row('B')], { refresh, ...noWait });
  assert.deepEqual(results.map((r) => r.status), ['ok', 'ok']);
  assert.deepEqual(asked[1], [{ channel: 'shopee', id: 'B' }]);
});

test('TikTok and Tokopedia are held to the same read', async () => {
  const still = { orders: [live('T', 'AWAITING_SHIPMENT', 'to_ship', 'tokopedia')] };
  const { refresh } = answering(still, still, still);
  const [stuck] = await confirmArranged([row('T', 'tokopedia')], { refresh, ...noWait });
  assert.equal(stuck.status, 'unconfirmed');
  const moved = answering({ orders: [live('T', 'AWAITING_COLLECTION', 'to_ship', 'tokopedia')] });
  assert.equal((await confirmArranged([row('T', 'tokopedia')], { refresh: moved.refresh, ...noWait }))[0].status, 'ok');
});

test('a status that cannot be read is never reported as done, and says why', async () => {
  const { refresh } = answering({ orders: [], error: 'platform sedang mati' }, { orders: [], error: 'platform sedang mati' }, { orders: [], error: 'platform sedang mati' });
  const [result] = await confirmArranged([row('A')], { refresh, ...noWait });
  assert.equal(result.status, 'unconfirmed');
  assert.match(result.error, /tidak terbaca \(platform sedang mati\)/);
});

test('a cancelled order is a failure, a refusal keeps its own words, and no platform means no read', async () => {
  const { refresh, asked } = answering({ orders: [] }, { orders: [live('C', 'CANCELLED', 'cancelled')] });
  const refused = { channel: 'shopee', id: 'R', status: 'failed', error: 'logistics.error_x' };
  const results = await confirmArranged([row('#1', 'shopify'), refused, row('C')], { refresh, ...noWait });
  assert.equal(results[0].status, 'ok');
  assert.deepEqual(results[1], refused);
  assert.equal(results[2].status, 'failed');
  assert.match(results[2].error, /CANCELLED/);
  assert.equal(asked.length, 2);
});

test('the summary only says berhasil for what was confirmed, and gives the real reason', () => {
  assert.deepEqual(arrangeSummary([row('A')]), { ok: true, message: '1 pesanan berhasil diatur pengirimannya' });
  const { ok, message } = arrangeSummary([
    row('A'),
    { ...row('B'), status: 'unconfirmed', error: 'platform tidak menolak, tapi statusnya masih READY_TO_SHIP' },
    { ...row('C'), status: 'failed', error: 'x' },
  ]);
  assert.equal(ok, false);
  assert.match(message, /^1 berhasil, 1 gagal, 1 belum terkonfirmasi - B: .*masih READY_TO_SHIP \(dan 1 lainnya/);
});

test('a failed pickup is never sent to Shopee, whichever way it arrives', async () => {
  const order = { channel: 'shopee', id: '261105GEVT7Q6C', status: 'RETRY_SHIP', stage: 'to_ship', packageNumber: 'P' };
  const calls = [];
  const results = await arrangeShopee([order], { session: { config: {}, auth: {} }, call: async (...a) => calls.push(a), shipOne: async (...a) => calls.push(a) });
  assert.deepEqual(results, [{ channel: 'shopee', id: order.id, status: 'failed', error: RETRY_REFUSAL }]);
  assert.equal(calls.length, 0);
  const single = await runAction({ action: 'shopee_ship', order, refresh: async () => ({ orders: [] }) });
  assert.equal(single.status, 'failed');
  assert.equal(single.error, RETRY_REFUSAL);
});

test('Proses shows a failed pickup with a way out, and nothing to tick', () => {
  const failedPickup = { channel: 'shopee', id: 'RS1', status: 'RETRY_SHIP', stage: 'to_ship', buyer: 'E', createdAt: 1, carrier: 'GrabExpress Instant', lines: [] };
  const ready = { ...failedPickup, id: 'OK1', status: 'READY_TO_SHIP' };
  assert.equal(nextAction({ ...failedPickup, rearranged: 5 }), null, 'arranged again in Seller Centre, it leaves the list');
  const page = renderProcess({
    orders: [failedPickup, ready], range: { preset: '7d', label: '7 hari', from: '2026-11-01', to: '2026-11-06' }, errors: {},
    shopeeShop: null, generatedAt: Date.now(), csrf: 'c', user: { role: 'owner', email: 'a@b.c', name: 'A' },
  });
  assert.doesNotMatch(page, /value="shopee:RS1"/);
  assert.match(page, /value="shopee:OK1"/);
  assert.ok(page.includes(`href="${SELLER_CENTRE_ORDERS}"`));
  assert.match(page, /Gagal jemput: atur ulang di Seller Centre/);
});
