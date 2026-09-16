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

test('a September window holds the Shopify sale Tokopedia would call August', () => {
  const september = { from: '2026-09-01', to: '2026-09-16' };

  // Same instant, two answers, and both are right where they are read.
  assert.equal(channelDate(LATE_31_AUG, 'shopify'), '2026-09-01');
  assert.equal(channelDate(LATE_31_AUG, 'tokopedia'), '2026-08-31');

  assert.equal(withinDays(order('shopify', LATE_31_AUG), september), true);
  assert.equal(withinDays(order('tokopedia', LATE_31_AUG), september), false);
  assert.equal(withinDays(order('tokopedia', LATE_31_AUG), september), false);
  assert.equal(withinDays(order('tiktok_shop', LATE_31_AUG), september), false);
});

test('an August window holds it the other way round', () => {
  const august = { from: '2026-08-17', to: '2026-08-31' };
  assert.equal(withinDays(order('tokopedia', LATE_31_AUG), august), true);
  assert.equal(withinDays(order('shopify', LATE_31_AUG), august), false, 'Shopify sudah 1 September');
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

test('the database path filters by platform day too, not only the live one', async () => {
  // It did not, and nothing said so. A parallel edit had added a `channels` argument to
  // that line, so the patch adding the filter matched the two live branches and silently
  // missed the one the dashboard actually uses. A 1 September window came back with 84
  // orders where the day holds 59 - the extra 25 were 31 August and 2 September sales the
  // widened fetch had pulled in for filtering, and nothing filtered them.
  const { loadOrders } = await import('../src/orders-source.js');

  const at = (iso) => Math.floor(Date.parse(iso) / 1000);
  const stored = [
    { channel: 'tokopedia', id: 'A', createdAt: at('2026-08-31T18:00:00Z'), stage: 'completed', total: 1 },   // 1 Sep WIB
    { channel: 'tokopedia', id: 'B', createdAt: at('2026-09-01T17:30:00Z'), stage: 'completed', total: 1 },   // 2 Sep WIB - keluar
    { channel: 'tokopedia', id: 'C', createdAt: at('2026-08-31T16:30:00Z'), stage: 'completed', total: 1 },   // 31 Agu WIB - keluar
    { channel: 'shopify', id: 'D', createdAt: at('2026-08-31T16:30:00Z'), stage: 'completed', total: 1 },  // 1 Sep di Shopify - masuk
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
