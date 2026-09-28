import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitingCarrier, pending } from '../src/fulfillment.js';
import { refreshOrders } from '../src/orders-refresh.js';

/**
 * A Shopee order that is arrangeable with no courier on it.
 *
 * Shopee assigns the courier when the buyer pays, and for an instant courier that is a
 * live booking with Grab or Gojek. A push reaching us in those seconds gives a row with
 * an empty carrier, and nothing fills it in afterwards.
 *
 * Order 2609287GUBMJ7N is what that cost: stored as arrangeable with no courier, while
 * Shopee had it CANCELLED with GrabExpress Instant and a LOGISTICS_INVALID package. It
 * sat at the top of the worklist, ticked, waiting to be arranged.
 */

const shopee = (over = {}) => ({ channel: 'shopee', id: 'X', status: 'READY_TO_SHIP', stage: 'to_ship', carrier: '', createdAt: 1, ...over });

test('an arrangeable Shopee order with no courier is a snapshot, not a fact', () => {
  assert.equal(awaitingCarrier(shopee()), true);
  assert.equal(awaitingCarrier(shopee({ status: 'RETRY_SHIP' })), true);
  assert.equal(awaitingCarrier(shopee({ carrier: 'JNE Reguler' })), false, 'sudah lengkap');
});

test('an unpaid order genuinely has no courier, and Shopee agrees', () => {
  // Checked against the live API: four UNPAID orders, all with an empty shipping_carrier
  // on Shopee's side too. Re-reading those would buy nothing.
  assert.equal(awaitingCarrier(shopee({ status: 'UNPAID', stage: 'unpaid' })), false);
});

test('only Shopee, because only Shopee books the courier at payment', () => {
  assert.equal(awaitingCarrier({ channel: 'tokopedia', status: 'AWAITING_SHIPMENT', carrier: '' }), false);
  assert.equal(awaitingCarrier({ channel: 'shopify', stage: 'to_ship', carrier: '' }), false);
  assert.equal(awaitingCarrier({ channel: 'manual', status: 'MANUAL', carrier: '' }), false);
  assert.equal(awaitingCarrier(null), false);
});

test('a cancelled order drops out of the worklist once the row is settled', () => {
  // The whole point. Before the re-read it is ticked and waiting to be arranged; after
  // it, nextAction refuses it and it is simply gone.
  const stale = shopee({ id: '2609287GUBMJ7N' });
  assert.equal(pending([stale]).length, 1, 'sebelum dibaca ulang: masih di daftar');

  const settled = { ...stale, status: 'CANCELLED', stage: 'cancelled', carrier: 'GrabExpress Instant' };
  assert.equal(pending([settled]).length, 0, 'sesudah: hilang sendiri');
});

test('the refresh hands back what it stored, so the page need not read twice', async () => {
  const fresh = [{ channel: 'shopee', id: 'A', status: 'CANCELLED', carrier: 'GrabExpress Instant' }];
  let saved = null;
  const out = await refreshOrders([{ channel: 'shopee', id: 'A' }], {
    read: async () => ({ orders: fresh }),
    save: async (orders) => { saved = orders; },
    hasDatabase: () => true,
  });
  assert.equal(out.refreshed, 1);
  assert.deepEqual(out.orders, fresh);
  assert.deepEqual(saved, fresh);
});

test('a platform that will not answer leaves the page drawable', async () => {
  const out = await refreshOrders([{ channel: 'shopee', id: 'A' }], {
    read: async () => { throw new Error('shopee tidak menjawab'); },
    save: async () => {},
    hasDatabase: () => true,
  });
  // The worklist is still drawn from what we have; it simply stays as stale as it was.
  assert.deepEqual(out.orders, []);
  assert.match(out.error, /tidak menjawab/);
});
