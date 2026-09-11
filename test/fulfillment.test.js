import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAction, pending } from '../src/fulfillment.js';

const order = (channel, status, stage, extra = {}) => ({
  channel, status, stage, id: 'X', createdAt: 1, ...extra,
});

test('Shopify stays out of this queue entirely', () => {
  // It is fulfilled in its own admin and needs a typed tracking number, which cannot be
  // part of a one-click batch. Mixing it in would make the batch impossible.
  assert.equal(nextAction(order('shopify', 'PAID/UNFULFILLED', 'to_ship')), null);
  assert.equal(nextAction(order('shopify', 'PAID/FULFILLED', 'completed')), null);
});

test('Shopee needs shipment arranged only while it is READY_TO_SHIP', () => {
  assert.equal(nextAction(order('shopee', 'READY_TO_SHIP', 'to_ship')).action, 'shopee_ship');
  assert.equal(nextAction(order('shopee', 'RETRY_SHIP', 'to_ship')).action, 'shopee_ship');
  // PROCESSED means the waybill exists and the courier simply has not collected yet.
  assert.equal(nextAction(order('shopee', 'PROCESSED', 'to_ship')), null);
  assert.equal(nextAction(order('shopee', 'SHIPPED', 'shipping')), null);
});

test('TikTok needs RTS only before a waybill exists', () => {
  assert.equal(nextAction(order('tokopedia', 'AWAITING_SHIPMENT', 'to_ship')).action, 'tiktok_rts');
  // AWAITING_COLLECTION is already arranged - the label prints and pickup is pending.
  assert.equal(nextAction(order('tiktok_shop', 'AWAITING_COLLECTION', 'to_ship')), null);
  assert.equal(nextAction(order('tokopedia', 'IN_TRANSIT', 'shipping')), null);
});

test('an unpaid order is never actionable', () => {
  assert.equal(nextAction(order('shopee', 'UNPAID', 'unpaid')), null);
  assert.equal(nextAction(order('shopify', 'PENDING/UNFULFILLED', 'unpaid')), null);
});

test('the pending list keeps only actionable orders, newest first', () => {
  const rows = pending([
    order('shopee', 'PROCESSED', 'to_ship', { id: 'skip', createdAt: 99 }),
    order('shopee', 'READY_TO_SHIP', 'to_ship', { id: 'old', createdAt: 1 }),
    order('tokopedia', 'AWAITING_SHIPMENT', 'to_ship', { id: 'new', createdAt: 50 }),
    order('shopify', 'PAID/UNFULFILLED', 'to_ship', { id: 'shopify', createdAt: 98 }),
  ]);
  assert.deepEqual(rows.map((r) => r.order.id), ['new', 'old']);
});

test('a mass arrangement is blocked in read-only mode before any call is made', async () => {
  const before = process.env.TREELOGY_READONLY;
  process.env.TREELOGY_READONLY = '1';
  try {
    const { massArrange } = await import('../src/fulfillment.js');
    await assert.rejects(
      () => massArrange([order('shopee', 'READY_TO_SHIP', 'to_ship', { packageNumber: 'P1' })]),
      (e) => e.name === 'ReadOnlyError',
    );
  } finally {
    if (before === undefined) delete process.env.TREELOGY_READONLY;
    else process.env.TREELOGY_READONLY = before;
  }
});

test('an unknown action is refused rather than guessed at', async () => {
  const { runAction } = await import('../src/fulfillment.js');
  const result = await runAction({ action: 'menghapus_semua', order: order('shopee', 'X', 'to_ship') });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /tidak dikenal/);
});

test('read-only mode blocks every fulfillment action', async () => {
  const before = process.env.TREELOGY_READONLY;
  process.env.TREELOGY_READONLY = '1';
  try {
    const { runAction } = await import('../src/fulfillment.js');
    for (const action of ['shopee_ship', 'tiktok_rts', 'shopify_fulfill']) {
      const result = await runAction({
        action,
        order: order('shopee', 'READY_TO_SHIP', 'to_ship', { packageId: '1', gid: 'gid://x' }),
      });
      assert.equal(result.status, 'failed', `${action} was not blocked`);
      assert.match(result.error, /READ-ONLY/);
    }
  } finally {
    if (before === undefined) delete process.env.TREELOGY_READONLY;
    else process.env.TREELOGY_READONLY = before;
  }
});
