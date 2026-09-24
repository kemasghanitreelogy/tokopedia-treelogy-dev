import test from 'node:test';
import assert from 'node:assert/strict';
import { mapTikTokOrder, mapShopeeOrder } from '../src/omni.js';
import { untilText, untilTone } from '../src/dashboard-page.js';

/**
 * The deadline shown on the queue is the platform's own, never ours.
 *
 * Every number below is what the live shops answered on 24 Sep 2026, kept verbatim so a
 * change in how we read them has something to fail against. Tokopedia order
 * 586226398167336016 was created 11:10 and Shopee order 260924TR51CTMQ at 11:21, both on
 * the platform clock of UTC+8.
 */

const TOKOPEDIA = {
  id: '586226398167336016',
  commerce_platform: 'TOKOPEDIA',
  status: 'AWAITING_SHIPMENT',
  create_time: 1790219412,
  rts_sla_time: 1790240400, //           24 Sep 17:00 - mark it ready to ship by here
  tts_sla_time: 1790269199, //           25 Sep 00:59 - with the courier by here
  shipping_due_time: 1790614799, //      29 Sep
  collection_due_time: 1790701199, //    30 Sep
  recommended_shipping_time: 1790269199000, // milliseconds, unlike every field above it
  payment: { total_amount: '1125790', currency: 'IDR' },
  line_items: [],
  packages: [],
};

const SHOPEE = {
  order_sn: '260924TR51CTMQ',
  order_status: 'READY_TO_SHIP',
  create_time: 1790220060,
  ship_by_date: 1790269199, //           25 Sep 00:59
  total_amount: 458536,
  item_list: [],
};

test('an order nobody has arranged races the ready-to-ship clock, not the comfortable one', () => {
  const order = mapTikTokOrder(TOKOPEDIA);
  // Five hours fifty, not five days. Showing the later figure would say there is time
  // when there are six hours, which is worse than showing nothing at all.
  assert.equal(order.shipBy, 1790240400);
  assert.notEqual(order.shipBy, TOKOPEDIA.shipping_due_time);
  assert.notEqual(order.shipBy, TOKOPEDIA.collection_due_time);
});

test('once arranged, the handover clock is the one left to miss', () => {
  const order = mapTikTokOrder({ ...TOKOPEDIA, status: 'AWAITING_COLLECTION' });
  assert.equal(order.shipBy, 1790269199);
});

test('a field sent in milliseconds is not read as a date in the year 58000', () => {
  // recommended_shipping_time arrives in milliseconds while every SLA field beside it is
  // in seconds. Reading one as the other puts the deadline tens of thousands of years out
  // and the chip would read "calm" forever.
  const order = mapTikTokOrder({ ...TOKOPEDIA, rts_sla_time: 0, tts_sla_time: 1790269199000 });
  assert.equal(order.shipBy, 1790269199);
});

test('Shopee publishes one deadline and we show that one', () => {
  assert.equal(mapShopeeOrder(SHOPEE).shipBy, 1790269199);
  // And the two platforms agree on the shape of it: end of the following day.
  assert.equal(mapShopeeOrder(SHOPEE).shipBy, mapTikTokOrder({ ...TOKOPEDIA, status: 'AWAITING_COLLECTION' }).shipBy);
});

test('an order the platform gave no deadline for gets no deadline invented for it', () => {
  assert.equal(mapShopeeOrder({ ...SHOPEE, ship_by_date: undefined }).shipBy, 0);
  assert.equal(mapTikTokOrder({ ...TOKOPEDIA, rts_sla_time: 0, tts_sla_time: 0, collection_due_time: 0 }).shipBy, 0);
});

test('the countdown says what is left the way somebody at a bench would say it', () => {
  const at = 1790240400; // 24 Sep 17:00
  assert.equal(untilText(at, at - 120), '2 mnt lagi');
  assert.equal(untilText(at, at - 3600), '1 jam lagi');
  assert.equal(untilText(at, at - 4200), '1 jam 10 mnt lagi');
  assert.equal(untilText(at, at - 2 * 86400), '2 hari lagi');
  assert.equal(untilText(at, at + 1200), 'lewat 20 mnt');
  assert.equal(untilText(at, at), 'lewat 0 mnt');
});

test('only a deadline worth interrupting somebody for is loud', () => {
  const at = 1790240400;
  assert.equal(untilTone(at, at - 5 * 86400), 'calm');
  assert.equal(untilTone(at, at - 5 * 3600), 'soon');
  assert.equal(untilTone(at, at - 1800), 'now');
  assert.equal(untilTone(at, at + 60), 'over');
});

test('the queue draws a chip from the real field, and nothing where there is none', async () => {
  const { renderProcess } = await import('../src/dashboard-page.js');
  const range = { preset: '7d', from: '2026-09-01', to: '2026-09-08', label: '7 hari', since: 1, until: 2, clamped: false };
  const base = {
    createdAt: 1790220060, total: 1000, buyer: 'x', carrier: 'JNE', tracking: '', lines: [], packageNumber: 'P',
  };
  const html = renderProcess({
    range, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 'c', flash: null, user: null, arranged: {},
    orders: [
      { ...base, channel: 'shopee', id: 'S1', status: 'READY_TO_SHIP', stage: 'to_ship', shipBy: 1790269199 },
      { ...base, channel: 'shopify', id: '#1', status: 'PAID/UNFULFILLED', stage: 'to_ship' },
    ],
  });
  assert.ok(html.includes('data-deadline="1790269199"'), 'batas dari platform ikut terbawa');
  // Shopify has no marketplace behind it and no deadline to miss.
  assert.equal(html.split('class="sla"').length - 1, 1);
  // The epoch travels so the browser can keep counting without asking the server again.
  assert.match(html, /data-tone="(calm|soon|now|over)"/);
});
