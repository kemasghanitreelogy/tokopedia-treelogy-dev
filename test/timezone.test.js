import test from 'node:test';
import assert from 'node:assert/strict';
import { wibDate, wibDayStart, WIB_OFFSET_SECONDS } from '../src/range.js';
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

test('the three date helpers never disagree, across a whole day of ten-minute steps', () => {
  // One disagreement anywhere in the 144 steps is one order a recap cannot reconcile.
  const start = Math.floor(Date.parse('2026-09-14T17:00:00Z') / 1000);
  for (let i = 0; i < 144; i += 1) {
    const at = start + i * 600;
    const expected = wibDate(at);
    assert.equal(jurnalDate(at), expected, `faktur beda di menit ke-${i * 10}`);
    assert.equal(wibDay(at), expected, `prakiraan beda di menit ke-${i * 10}`);
  }
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
