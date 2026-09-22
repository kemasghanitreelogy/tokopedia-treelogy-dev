import test from 'node:test';
import assert from 'node:assert/strict';
import { nextAction, pending } from '../src/fulfillment.js';

const order = (channel, status, stage, extra = {}) => ({
  channel, status, stage, id: 'X', createdAt: 1, ...extra,
});

test('a Shopify order is arranged like any other, and the record of it lives here', () => {
  // Nothing is called for it, so nothing on Shopify's side could say it was handled.
  const waiting = order('shopify', 'PAID/UNFULFILLED', 'to_ship', { id: '#10926' });
  assert.equal(nextAction(waiting).action, 'shopify_arrange');
  assert.equal(nextAction(waiting).label, 'Atur pengiriman', 'kata kerjanya sama dengan kanal lain');
  assert.equal(nextAction(waiting, { '#10926': { at: 1 } }), null, 'sudah diproses, keluar dari antrean');
  assert.equal(nextAction(order('shopify', 'PAID/FULFILLED', 'completed')), null);
  assert.equal(nextAction(order('shopify', 'PENDING/UNFULFILLED', 'unpaid')), null);
});

test('a batch takes a Shopify order by writing it down, never by calling Shopify', async () => {
  const { massArrange } = await import('../src/fulfillment.js');
  const { arrangedOrders, markArranged, ARRANGED_DOC } = await import('../src/shopify/label.js');
  const { deleteDoc } = await import('../src/store/index.js');
  await deleteDoc(ARRANGED_DOC);

  const result = await massArrange([order('shopify', 'PAID/UNFULFILLED', 'to_ship', { id: '#10922' })]);
  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 0);
  // The whole point: the order is done because our own store says so.
  assert.ok((await arrangedOrders())['#10922']);
  await markArranged([]);
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
  assert.deepEqual(rows.map((r) => r.order.id), ['shopify', 'new', 'old']);
  // Printing it is what takes it out, and nothing else can.
  const afterPrint = pending([order('shopify', 'PAID/UNFULFILLED', 'to_ship', { id: 'shopify' })], { shopify: { at: 1 } });
  assert.deepEqual(afterPrint, []);
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

/* ------------------------------------------- the batch: every parcel, every verdict */

const shopeeOrder = (id, over = {}) => ({ channel: 'shopee', id, packageNumber: `P${id}`, status: 'READY_TO_SHIP', stage: 'to_ship', createdAt: 1, ...over });
const session = { config: {}, auth: {} };
const dropoffPlans = (ids) => Object.fromEntries(ids.map((id) => [id, { id, method: 'dropoff', fields: [] }]));

/** A stand-in Shopee that answers mass_ship_order and get_order_detail, and records both. */
function fakeShopee({ reject = {}, throwOn = () => false, statusAfter = () => 'PROCESSED' } = {}) {
  const calls = { mass: [], detail: [] };
  const call = async (config, path, auth, query, body) => {
    if (path === '/api/v2/logistics/mass_ship_order') {
      const sns = body.package_list.map((p) => p.order_sn);
      calls.mass.push(sns);
      if (throwOn(sns)) throw new Error('logistics.package_not_exist');
      return {
        response: {
          result_list: sns.map((order_sn) => (reject[order_sn]
            ? { order_sn, fail_error: 'logistics.order_not_eligible', fail_message: reject[order_sn] }
            : { order_sn })),
        },
      };
    }
    if (path === '/api/v2/order/get_order_detail') {
      const sns = String(query.order_sn_list).split(',');
      calls.detail.push(sns);
      return { response: { order_list: sns.map((order_sn) => ({ order_sn, order_status: statusAfter(order_sn) })) } };
    }
    throw new Error(`tak terduga: ${path}`);
  };
  return { call, calls };
}

test('an order Shopee names as failed is reported as failed, not swallowed by a 200', async () => {
  const { arrangeShopee } = await import('../src/fulfillment.js');
  const ids = ['A', 'B', 'C'];
  const shopee = fakeShopee({
    reject: { B: 'Order is not eligible to ship' },
    statusAfter: (sn) => (sn === 'B' ? 'READY_TO_SHIP' : 'PROCESSED'),
  });
  const results = await arrangeShopee(ids.map((id) => shopeeOrder(id)), {
    session, call: shopee.call, methods: dropoffPlans(ids), shipOne: async () => {},
  });
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.A.status, 'ok');
  assert.equal(by.C.status, 'ok');
  assert.equal(by.B.status, 'failed', 'satu pesanan ditolak Shopee tidak boleh dihitung berhasil');
  assert.match(by.B.error, /not eligible/);
});

test('a parcel Shopee still calls READY_TO_SHIP is not arranged, whatever the call answered', async () => {
  const { arrangeShopee } = await import('../src/fulfillment.js');
  // The call says everything went through; the shop says one of them did not move.
  const shopee = fakeShopee({ statusAfter: (sn) => (sn === 'B' ? 'READY_TO_SHIP' : 'PROCESSED') });
  const results = await arrangeShopee(['A', 'B'].map((id) => shopeeOrder(id)), {
    session, call: shopee.call, methods: dropoffPlans(['A', 'B']), shipOne: async () => {},
  });
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.A.status, 'ok');
  assert.equal(by.B.status, 'failed');
  assert.match(by.B.error, /masih READY_TO_SHIP/);
});

test('a batch Shopee refuses outright costs only the order that caused it', async () => {
  const { shipShopeeDropoffs } = await import('../src/fulfillment.js');
  const ids = ['A', 'BAD', 'C'];
  const shopee = fakeShopee({ throwOn: (sns) => sns.includes('BAD') });
  const tried = [];
  const results = await shipShopeeDropoffs({}, {}, ids.map((id) => shopeeOrder(id)), {
    call: shopee.call,
    shipOne: async (config, auth, sn) => {
      tried.push(sn);
      if (sn === 'BAD') throw new Error('Package does not exist');
    },
  });
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.A.status, 'ok');
  assert.equal(by.C.status, 'ok');
  assert.equal(by.BAD.status, 'failed');
  assert.deepEqual(tried.sort(), ['A', 'BAD', 'C'], 'setiap pesanan dicoba sendiri-sendiri');
});

test('Shopee is asked fifty at a time, because it refuses a fifty-first', async () => {
  const { shipShopeeDropoffs } = await import('../src/fulfillment.js');
  const orders = Array.from({ length: 120 }, (_, i) => shopeeOrder(`S${i}`));
  const shopee = fakeShopee();
  const results = await shipShopeeDropoffs({}, {}, orders, { call: shopee.call, shipOne: async () => {} });
  assert.equal(results.length, 120, 'semua yang dipilih ikut diatur');
  assert.deepEqual(shopee.calls.mass.map((c) => c.length), [50, 50, 20]);
  assert.ok(results.every((r) => r.status === 'ok'));
});

test('a hundred parcels are verified in two reads, not a hundred', async () => {
  const { verifyShopee } = await import('../src/fulfillment.js');
  const shopee = fakeShopee();
  const status = await verifyShopee({}, {}, Array.from({ length: 100 }, (_, i) => `S${i}`), { call: shopee.call });
  assert.equal(Object.keys(status).length, 100);
  assert.deepEqual(shopee.calls.detail.map((c) => c.length), [50, 50]);
});

test('a TikTok package that fails takes only itself down, not the whole selection', async () => {
  const { arrangeTikTok } = await import('../src/fulfillment.js');
  const sent = [];
  const call = async ({ body }) => {
    const id = body.packages[0].id;
    sent.push(id);
    // What the live API answers when one package in a body is not shippable - and, when
    // they travel together, what it answers for every other package too.
    if (id === '999') throw new Error('Invalid parameters; detail:No Valid FulfillUnit error');
    return { data: {} };
  };
  const orders = [
    { channel: 'tiktok_shop', id: 'T1', packageId: '111' },
    { channel: 'tokopedia', id: 'T2', packageId: '999' },
    { channel: 'tokopedia', id: 'T3', packageId: '333' },
    { channel: 'tokopedia', id: 'T4' },
  ];
  const results = await arrangeTikTok(orders, { call, config: {} });
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(by.T1.status, 'ok');
  assert.equal(by.T3.status, 'ok');
  assert.equal(by.T2.status, 'failed');
  assert.equal(by.T4.status, 'failed');
  assert.match(by.T4.error, /belum punya paket/);
  assert.deepEqual(sent.sort(), ['111', '333', '999'], 'satu panggilan per paket');
});

test('an order somebody else arranged mid-batch is counted as arranged, not as a failure', async () => {
  const { arrangeShopee } = await import('../src/fulfillment.js');
  // The ship call fails because the parcel had already moved; the shop agrees it moved.
  const shopee = fakeShopee({ throwOn: () => true, statusAfter: () => 'PROCESSED' });
  const results = await arrangeShopee([shopeeOrder('A')], {
    session, call: shopee.call, methods: dropoffPlans(['A']),
    shipOne: async () => { throw new Error('Order status is not ready to ship'); },
  });
  assert.equal(results[0].status, 'ok');
});

test('a parcel with no package number is refused by name rather than sent', async () => {
  const { arrangeShopee } = await import('../src/fulfillment.js');
  const shopee = fakeShopee();
  const results = await arrangeShopee([shopeeOrder('A', { packageNumber: '' })], {
    session, call: shopee.call, methods: {}, shipOne: async () => {},
  });
  assert.equal(results[0].status, 'failed');
  assert.match(results[0].error, /nomor paket/);
});
