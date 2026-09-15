import test from 'node:test';
import assert from 'node:assert/strict';
import { wibDate, wibDayStart, WIB_OFFSET_SECONDS, resolveRange } from '../src/range.js';
import { jurnalDate } from '../src/mekari/invoice.js';
import { wibDay } from '../src/forecast/series.js';

/**
 * The day an order belongs to, agreed on by everything that counts it.
 *
 * Finance recaps the day's orders from three places - the marketplace back office, this
 * dashboard, and Jurnal - and the only way those three agree is if all of them put an
 * order on the same calendar day. Every platform timestamps in UTC epoch seconds; the
 * seller's day is Jakarta's. Between 00:00 and 07:00 WIB those two disagree, so an order
 * at half past midnight is yesterday's in UTC and today's to the person who sold it.
 *
 * The box runs UTC, deliberately - no code here may depend on the machine's timezone -
 * which is exactly why these are pinned rather than assumed.
 */

/** 2026-09-15 00:30 WIB, which is 2026-09-14 17:30 UTC. The case that breaks recaps. */
const JUST_AFTER_MIDNIGHT = Math.floor(Date.parse('2026-09-14T17:30:00Z') / 1000);
/** 2026-09-15 23:45 WIB = 2026-09-15 16:45 UTC. The other end of the same day. */
const JUST_BEFORE_MIDNIGHT = Math.floor(Date.parse('2026-09-15T16:45:00Z') / 1000);

test('an order half an hour after midnight belongs to the day that just started', () => {
  // Read as UTC this is 14 September. To the seller it is the 15th, and so it must be to
  // the dashboard, to the forecast, and to the invoice in Jurnal - all three.
  assert.equal(new Date(JUST_AFTER_MIDNIGHT * 1000).toISOString().slice(0, 10), '2026-09-14');
  assert.equal(wibDate(JUST_AFTER_MIDNIGHT), '2026-09-15');
  assert.equal(jurnalDate(JUST_AFTER_MIDNIGHT), '2026-09-15');
  assert.equal(wibDay(JUST_AFTER_MIDNIGHT), '2026-09-15');
});

test('an order a quarter of an hour before midnight belongs to the day that is ending', () => {
  assert.equal(wibDate(JUST_BEFORE_MIDNIGHT), '2026-09-15');
  assert.equal(jurnalDate(JUST_BEFORE_MIDNIGHT), '2026-09-15');
  assert.equal(wibDay(JUST_BEFORE_MIDNIGHT), '2026-09-15');
});

test('a marketplace invoice follows the house clock across a whole day of ten-minute steps', () => {
  // This used to call jurnalDate(at) with no channel, which falls back to the house clock
  // - so all 144 assertions compared businessDate to itself and would have passed with the
  // channel mechanism deleted entirely. Named channels now, and the Shopify case below is
  // what proves the mechanism does something.
  const start = Math.floor(Date.parse('2026-09-14T17:00:00Z') / 1000);
  for (let i = 0; i < 144; i += 1) {
    const at = start + i * 600;
    const expected = wibDate(at);
    for (const channel of ['shopee', 'tokopedia', 'tiktok_shop']) {
      assert.equal(jurnalDate(at, channel), expected, `${channel} beda di menit ke-${i * 10}`);
    }
    assert.equal(wibDay(at), expected, `prakiraan beda di menit ke-${i * 10}`);
  }
});

test('Shopify parts company with the house clock for exactly one hour a night', () => {
  // The hour that only exists because the store is UTC+8 and the marketplaces are UTC+7.
  // If this count is not 6 - six ten-minute steps in one hour - the channel mechanism is
  // either not applied or applied to everybody.
  const start = Math.floor(Date.parse('2026-09-14T17:00:00Z') / 1000);
  let differing = 0;
  for (let i = 0; i < 144; i += 1) {
    const at = start + i * 600;
    if (jurnalDate(at, 'shopify') !== jurnalDate(at, 'shopee')) differing += 1;
  }
  assert.equal(differing, 6, 'tepat satu jam sehari, tidak lebih dan tidak kurang');
});

test('a day starts at 17:00 UTC the day before, and covers exactly 24 hours', () => {
  const start = wibDayStart('2026-09-15');
  assert.equal(new Date(start * 1000).toISOString(), '2026-09-14T17:00:00.000Z');
  // The first second of the day and the last both land on it; the second either side does not.
  assert.equal(wibDate(start), '2026-09-15');
  assert.equal(wibDate(start + 86_399), '2026-09-15');
  assert.equal(wibDate(start - 1), '2026-09-14');
  assert.equal(wibDate(start + 86_400), '2026-09-16');
  assert.equal(WIB_OFFSET_SECONDS, 7 * 3600);
});

test('the offset is fixed, because Indonesia has no daylight saving', () => {
  // Same offset in January and in July. A timezone database lookup would be the wrong
  // tool here and a source of drift between environments.
  for (const iso of ['2026-01-15T17:30:00Z', '2026-07-15T17:30:00Z', '2026-12-31T17:30:00Z']) {
    const at = Math.floor(Date.parse(iso) / 1000);
    const utcDay = new Date(at * 1000).toISOString().slice(0, 10);
    const [y, m, d] = utcDay.split('-').map(Number);
    const nextDay = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    assert.equal(wibDate(at), nextDay, iso);
  }
});

/* --------------------------------------------- the clock is one setting, not nine */

const { zone, businessDate, businessDayStart, ZONES } = await import('../src/clock.js');

test('WIB and WITA disagree for an hour every night, and that hour is real', () => {
  // 23:30 Jakarta on the 14th is 00:30 Makassar on the 15th. Measured on this account,
  // 17 of 719 September orders fall in that hour - about one a day, which is exactly the
  // size of discrepancy that makes a daily recap refuse to tie out.
  const at = Math.floor(Date.parse('2026-09-14T16:30:00Z') / 1000);
  assert.equal(ZONES['Asia/Jakarta'].offsetHours, 7);
  assert.equal(ZONES['Asia/Makassar'].offsetHours, 8);

  const before = process.env.BUSINESS_TZ;
  try {
    process.env.BUSINESS_TZ = 'Asia/Jakarta';
    assert.equal(businessDate(at), '2026-09-14');
    assert.equal(zone().label, 'WIB');

    process.env.BUSINESS_TZ = 'Asia/Makassar';
    assert.equal(businessDate(at), '2026-09-15');
    assert.equal(zone().label, 'WITA');
    // The day boundary moves with it, or the range and the date would disagree.
    assert.equal(new Date(businessDayStart('2026-09-15') * 1000).toISOString(), '2026-09-14T16:00:00.000Z');
  } finally {
    if (before === undefined) delete process.env.BUSINESS_TZ; else process.env.BUSINESS_TZ = before;
  }
});

test('an unknown or missing zone falls back rather than shifting the books silently', () => {
  const before = process.env.BUSINESS_TZ;
  try {
    process.env.BUSINESS_TZ = 'Mars/Olympus';
    assert.equal(zone().name, 'Asia/Jakarta');
    delete process.env.BUSINESS_TZ;
    assert.equal(zone().name, 'Asia/Jakarta');
  } finally {
    if (before === undefined) delete process.env.BUSINESS_TZ; else process.env.BUSINESS_TZ = before;
  }
});

/* ------------------------------------- each platform's invoice carries its own date */

const { channelDate, zoneForChannel, CHANNEL_ZONES } = await import('../src/clock.js');
const { jurnalDate: invoiceDate } = await import('../src/mekari/invoice.js');

test('an invoice is dated by the clock of the platform it came from', () => {
  // 23:30 in Jakarta, which is already the next day in Singapore - and the Shopify store
  // is configured Asia/Singapore, read from the live shop rather than assumed. Finance
  // recaps by opening each back office beside Jurnal, so both answers are right from
  // where they are looking, and one house clock would make one of them wrong.
  const at = Math.floor(Date.parse('2026-09-14T16:30:00Z') / 1000);

  for (const channel of ['shopee', 'tokopedia', 'tiktok_shop']) {
    assert.equal(channelDate(at, channel), '2026-09-14', channel);
    assert.equal(invoiceDate(at, channel), '2026-09-14', channel);
    assert.equal(zoneForChannel(channel).offsetHours, 7, channel);
  }
  assert.equal(channelDate(at, 'shopify'), '2026-09-15');
  assert.equal(invoiceDate(at, 'shopify'), '2026-09-15');
  assert.equal(zoneForChannel('shopify').offsetHours, 8);
});

test('a typed-in transaction has no platform, so it uses the house clock', () => {
  const at = Math.floor(Date.parse('2026-09-14T16:30:00Z') / 1000);
  assert.equal(channelDate(at, 'manual'), channelDate(at, null));
  assert.equal(zoneForChannel('manual').name, 'Asia/Jakarta');
  // Every channel that does have an entry must name a zone the table knows.
  for (const [channel, name] of Object.entries(CHANNEL_ZONES)) {
    assert.ok(zoneForChannel(channel).label, channel);
    assert.equal(zoneForChannel(channel).name, name, channel);
  }
});

test('away from the boundary every platform agrees, which is most of the day', () => {
  // Midday Jakarta is midday everywhere that matters here; only the last hour splits.
  const noon = Math.floor(Date.parse('2026-09-15T05:00:00Z') / 1000);
  const days = new Set(['shopee', 'tokopedia', 'tiktok_shop', 'shopify', 'manual'].map((c) => channelDate(noon, c)));
  assert.equal(days.size, 1);
  assert.deepEqual([...days], ['2026-09-15']);
});

/* ------------------------------------------- the day boundary moves with the label */

test('wibDayStart follows BUSINESS_TZ, not the value it had at import', async () => {
  // The offset constant was frozen at module load while the date helper read it live, so
  // the boundary and the label could disagree. Nothing in the suite checked the boundary.
  const { wibDayStart: dayStart, wibDate: dateOf } = await import('../src/range.js');
  const before = process.env.BUSINESS_TZ;
  try {
    process.env.BUSINESS_TZ = 'Asia/Makassar';
    const start = dayStart('2026-09-15');
    assert.equal(dateOf(start), '2026-09-15', 'awal hari harus jatuh pada hari itu sendiri');
    assert.equal(dateOf(start - 1), '2026-09-14', 'dan satu detik sebelumnya pada hari sebelumnya');
  } finally {
    if (before === undefined) delete process.env.BUSINESS_TZ; else process.env.BUSINESS_TZ = before;
  }
});

test('a window that ends before it starts is not produced at all', () => {
  // A range entirely in the future used to give since > until, which then wrote a coverage
  // row with covered_from after covered_through - after which that source never answered
  // from the database again.
  const now = Date.parse('2026-09-15T08:00:00Z');
  for (const [from, to] of [['2026-09-20', '2026-09-21'], ['2026-12-01', '2026-12-31']]) {
    const r = resolveRange({ from, to, now });
    assert.ok(r.since <= r.until, `${from}..${to} menghasilkan rentang terbalik`);
  }
});
