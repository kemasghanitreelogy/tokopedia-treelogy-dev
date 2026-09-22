import test from 'node:test';
import assert from 'node:assert/strict';
import { withinDays, ZONE_SPREAD_SECONDS, channelDate } from '../src/clock.js';

/**
 * The dashboard filters by the same clock the invoice date follows.
 *
 * It did not, and the gap was measurable: four Shopify sales placed on 31 August between
 * 23:00 and midnight Jakarta are already 1 September to Shopify, which is UTC+8, and were
 * invoiced as such. The dashboard counted them in August using one Jakarta window for
 * every channel. A month's orders and a month's invoices therefore differed by four, and
 * nobody comparing the two screens could ever have reconciled it.
 */

/** 31 Aug 23:30 WIB = 1 Sep 00:30 Singapore. The hour where the two clocks disagree. */
const LATE_31_AUG = Math.floor(Date.parse('2026-08-31T16:30:00Z') / 1000);
/** Midday, where every clock agrees. */
const MIDDAY_5_SEP = Math.floor(Date.parse('2026-09-05T05:00:00Z') / 1000);

const order = (channel, at) => ({ channel, createdAt: at });

test('a September window holds the marketplace sale the house clock would call August', () => {
  const september = { from: '2026-09-01', to: '2026-09-16' };
  // 31 Aug 23:30 Jakarta is already 1 September to every platform we sell on.
  for (const channel of ['shopee', 'tokopedia', 'tiktok_shop', 'shopify']) {
    assert.equal(channelDate(LATE_31_AUG, channel), '2026-09-01', channel);
    assert.equal(withinDays(order(channel, LATE_31_AUG), september), true, channel);
  }
  // A typed-in sale has no platform and stays on the day it was entered.
  assert.equal(withinDays(order('manual', LATE_31_AUG), september), false);
});

test('an August window holds the typed-in sale and not the marketplace one', () => {
  const august = { from: '2026-08-17', to: '2026-08-31' };
  assert.equal(withinDays(order('manual', LATE_31_AUG), august), true);
  assert.equal(withinDays(order('shopee', LATE_31_AUG), august), false, 'Shopee sudah 1 September');
});

test('away from the boundary every channel agrees, which is most of the month', () => {
  const september = { from: '2026-09-01', to: '2026-09-16' };
  for (const channel of ['tokopedia', 'tokopedia', 'tiktok_shop', 'shopify']) {
    assert.equal(withinDays(order(channel, MIDDAY_5_SEP), september), true, channel);
  }
});

test('the fetch reaches past both ends, or the overlap is dropped before it can be filtered', () => {
  // A day named by two clocks an hour apart spans 25 hours. A fetch aligned to one of them
  // cannot contain the other's, so the widening is not a safety margin - it is the
  // difference between finding those four Shopify orders and never seeing them.
  assert.equal(ZONE_SPREAD_SECONDS, 2 * 3600, 'WIB +7 sampai WIT +9');
  assert.ok(ZONE_SPREAD_SECONDS >= 3600, 'harus menutup selisih Jakarta-Singapura');
});

test('a range with no dates keeps everything, rather than silently emptying the page', () => {
  assert.equal(withinDays(order('shopify', LATE_31_AUG), {}), true);
  assert.equal(withinDays(order('shopify', LATE_31_AUG), { from: '2026-09-01' }), true);
});

/* --------------------- every path out of loadOrders applies the same filter */

test('the database path filters by platform day too, not only the live one', () => {
  // It did not, and nothing said so. A parallel edit had added a `channels` argument to
  // that line, so the patch adding the filter matched the two live branches and silently
  // missed the one the dashboard actually uses. A 1 September window came back with 84
  // orders where the day holds 59 - the extra 25 were 31 August and 2 September sales the
  // widened fetch had pulled in for filtering, and which nothing then filtered.
  return import('../src/orders-source.js').then(async ({ loadOrders }) => {
    const at = (iso) => Math.floor(Date.parse(iso) / 1000);
    const stored = [
      // 31 Aug 17:00 UTC = 1 Sep 01:00 on every platform clock. In.
      { channel: 'shopee', id: 'A', createdAt: at('2026-08-31T17:00:00Z'), stage: 'completed', total: 1 },
      // 1 Sep 16:30 UTC = 2 Sep 00:30 on a platform clock. Out.
      { channel: 'shopee', id: 'B', createdAt: at('2026-09-01T16:30:00Z'), stage: 'completed', total: 1 },
      // 31 Aug 15:00 UTC = 31 Aug 23:00 on a platform clock. Out.
      { channel: 'tokopedia', id: 'C', createdAt: at('2026-08-31T15:00:00Z'), stage: 'completed', total: 1 },
      { channel: 'shopify', id: 'D', createdAt: at('2026-09-01T04:00:00Z'), stage: 'completed', total: 1 },
    ];

    const seen = await loadOrders({
      range: { since: at('2026-08-31T17:00:00Z'), until: at('2026-09-01T16:59:59Z'), from: '2026-09-01', to: '2026-09-01', label: '1 Sep' },
      readStored: async () => stored,
      readLive: async () => ({ orders: stored, errors: {}, truncated: [] }),
    });

    assert.deepEqual(seen.orders.map((o) => o.id).sort(), ['A', 'D'],
      'hanya pesanan yang platformnya sendiri sebut 1 September');
    // The window the caller asked for is what comes back, not the widened one it was
    // fetched with - otherwise the page would label itself with an hour it did not show.
    assert.equal(seen.range.from, '2026-09-01');
    assert.equal(seen.range.to, '2026-09-01');
  });
});

test('a typed-in sale is read from the table on both paths, and never asked of a platform', () => {
  return import('../src/orders-source.js').then(async ({ loadOrders }) => {
    const at = (iso) => Math.floor(Date.parse(iso) / 1000);
    const range = { since: at('2026-08-31T17:00:00Z'), until: at('2026-09-01T16:59:59Z'), from: '2026-09-01', to: '2026-09-01', label: '1 Sep' };
    const manual = { channel: 'manual', id: 'CS-260901-0000012', createdAt: at('2026-09-01T05:00:00Z'), stage: 'completed', status: 'MANUAL', total: 300000 };
    const shopee = { channel: 'shopee', id: 'A', createdAt: at('2026-09-01T04:00:00Z'), stage: 'completed', total: 1 };
    const asked = [];
    const readStored = async ({ channels }) => {
      asked.push(channels);
      return [shopee, manual].filter((o) => !channels || channels.includes(o.channel));
    };

    // The live path: the platforms answer for theirs, the table for the manual one.
    const live = await loadOrders({ range, readStored, readLive: async () => ({ orders: [shopee], errors: {}, truncated: [] }) });
    assert.deepEqual(live.orders.map((o) => o.id).sort(), ['A', 'CS-260901-0000012']);
    assert.deepEqual(asked.at(-1), ['manual'], 'the live path asks the table for manual sales only');

    // A table that cannot be read costs the manual rows, never the page.
    const blind = await loadOrders({ range, readStored: async () => { throw new Error('db down'); }, readLive: async () => ({ orders: [shopee], errors: {}, truncated: [] }) });
    assert.deepEqual(blind.orders.map((o) => o.id), ['A']);
  });
});

test('a worklist reads what is open, and a database that will not answer does not empty it', async () => {
  const { loadOutstanding } = await import('../src/orders-source.js');
  const open = [
    { channel: 'shopify', id: '#10971', stage: 'to_ship', createdAt: 1_789_000_000, buyer: 'Hj Ineu' },
    { channel: 'shopee', id: 'SP1', stage: 'to_ship', createdAt: 1_779_000_000, buyer: 'namaakun' },
  ];
  let liveReads = 0;

  const fromDb = await loadOutstanding({
    hasDatabase: () => true,
    readOutstanding: async () => open,
    readLive: async () => { liveReads += 1; return { orders: [], errors: {}, truncated: [] }; },
    readRecipients: async () => ({ SP1: { name: 'Stefani Wijaya' } }),
  });
  // Nothing is dropped for being old: the second order is four months back and still open.
  assert.deepEqual(fromDb.orders.map((o) => o.id), ['#10971', 'SP1']);
  assert.equal(fromDb.from, 'db');
  assert.equal(liveReads, 0, 'the platforms are not asked when the table can answer');
  assert.equal(fromDb.orders[1].buyer, 'Stefani Wijaya', 'a Shopee buyer is still named');
  assert.equal(fromDb.orders[1].buyerUsername, 'namaakun');

  const blind = await loadOutstanding({
    hasDatabase: () => true,
    readOutstanding: async () => { throw new Error('db down'); },
    readLive: async () => { liveReads += 1; return { orders: open, errors: {}, truncated: [] }; },
    readRecipients: async () => ({}),
  });
  assert.deepEqual(blind.orders.map((o) => o.id), ['#10971', 'SP1']);
  assert.equal(blind.from, 'live');
  assert.equal(liveReads, 1);
});
