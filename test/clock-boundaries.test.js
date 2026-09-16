import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZONES, CHANNEL_ZONES, zoneForChannel, channelDate,
  businessDate, businessMonth, businessDayStart,
} from '../src/clock.js';

/**
 * The edges of the clock: month ends, the turn of the year, and dates that do not exist.
 *
 * test/timezone.test.js pins the ordinary case - an order near midnight belongs to the day
 * the seller is living in, and Shopify's is an hour ahead of everyone else's. These pin
 * what happens when that same hour falls on the last night of a month or of a year, which
 * is when a one-order discrepancy stops being a rounding error and becomes a month-end
 * close that does not tie out; and they pin businessMonth and the rejection of impossible
 * dates, neither of which anything tested at all.
 *
 * BUSINESS_TZ is restored after every test that touches it, because these run in the same
 * process as each other.
 */

/** 23:30 Jakarta on the last day of August 2026. Midnight has already passed in Makassar. */
const END_OF_AUGUST = Math.floor(Date.parse('2026-08-31T16:30:00Z') / 1000);
/** 23:30 Jakarta on New Year's Eve. In Singapore - and so to Shopify - it is already 2027. */
const NEW_YEARS_EVE = Math.floor(Date.parse('2026-12-31T16:30:00Z') / 1000);
/** 00:30 Jakarta on New Year's Day, which UTC still calls the old year. */
const NEW_YEARS_DAY = Math.floor(Date.parse('2026-12-31T17:30:00Z') / 1000);

function withZone(name, fn) {
  const before = process.env.BUSINESS_TZ;
  process.env.BUSINESS_TZ = name;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env.BUSINESS_TZ;
    else process.env.BUSINESS_TZ = before;
  }
}

/* ---------------------------------------------------------- the platform's own calendar */

test('an order at half past eleven at night is the 14th to Shopee and the 15th to Shopify', () => {
  // The headline property, stated as finance sees it. The store is configured
  // Asia/Singapore - read from the live shop via shop { ianaTimezone } on 2026-09-15, not
  // assumed - so its books turn over an hour before the marketplaces'. Both answers are
  // right from where they are being read, and a single house clock makes one of them wrong.
  const at = Math.floor(Date.parse('2026-09-14T16:30:00Z') / 1000);
  assert.equal(channelDate(at, 'shopee'), '2026-09-14');
  assert.equal(channelDate(at, 'tokopedia'), '2026-09-14');
  assert.equal(channelDate(at, 'tiktok_shop'), '2026-09-14');
  assert.equal(channelDate(at, 'shopify'), '2026-09-15', 'toko Shopify UTC+8, sudah ganti hari');
});

test('that same hour moves a sale into the next month, and into the next year', () => {
  // A day's discrepancy inside a month is a recap that is off by one order. The same hour
  // on the last night of a month moves the sale into the next month's revenue, and on the
  // last night of the year into the next year's books - which is not a recap problem any
  // more, it is a closed period.
  assert.equal(channelDate(END_OF_AUGUST, 'shopee'), '2026-08-31');
  assert.equal(channelDate(END_OF_AUGUST, 'shopify'), '2026-09-01', 'pindah bulan, bukan cuma pindah hari');

  assert.equal(channelDate(NEW_YEARS_EVE, 'shopee'), '2026-12-31');
  assert.equal(channelDate(NEW_YEARS_EVE, 'shopify'), '2027-01-01', 'pindah tahun buku');
  assert.equal(channelDate(NEW_YEARS_EVE, 'tokopedia'), '2026-12-31');
});

test('a channel keeps its own clock even when the house clock is moved', () => {
  // CHANNEL_ZONES is not a default that BUSINESS_TZ overrides - it is what each platform's
  // back office shows, and that does not change because the business moved its own books
  // to Makassar or Jayapura. Collapsing the two would re-date every marketplace invoice
  // ever raised the next time this setting is touched.
  withZone('Asia/Jayapura', () => {
    assert.equal(zoneForChannel('shopee').offsetHours, 7, 'Shopee tetap WIB');
    assert.equal(zoneForChannel('shopify').offsetHours, 8, 'Shopify tetap UTC+8');
    assert.equal(channelDate(END_OF_AUGUST, 'shopee'), '2026-08-31');
    // Only a channel with no platform of its own follows the house clock. WIT is +9, so
    // 23:30 Jakarta is already 01:30 the next day there.
    assert.equal(zoneForChannel('manual').offsetHours, 9);
    assert.equal(channelDate(END_OF_AUGUST, 'manual'), '2026-09-01');
    assert.equal(businessDate(END_OF_AUGUST), '2026-09-01');
  });
});

test('every channel with an entry names a zone that exists, and an unknown one falls back', () => {
  for (const [channel, name] of Object.entries(CHANNEL_ZONES)) {
    assert.ok(ZONES[name], `${channel} menunjuk zona ${name} yang tidak ada di tabel`);
    assert.equal(zoneForChannel(channel).name, name, channel);
    assert.ok(zoneForChannel(channel).label, `${channel} tanpa label`);
  }
  // Nothing may return undefined here: the offset is multiplied straight into a date.
  for (const channel of ['manual', 'lazada', '', null, undefined]) {
    assert.equal(typeof zoneForChannel(channel).offsetHours, 'number', String(channel));
  }
});

/* ------------------------------------------------------------------------ the month */

test('the month an order belongs to turns over with the clock, not with UTC', () => {
  // Monthly history is bucketed on this. Read as UTC, 23:30 on 31 August is 16:30 on the
  // 31st - the right month by luck. Read as UTC at 00:30 on 1 September it is the 31st of
  // August, which is the wrong one, and a month-end close that is short by a day's orders.
  assert.equal(new Date(NEW_YEARS_DAY * 1000).toISOString().slice(0, 7), '2026-12');
  withZone('Asia/Jakarta', () => {
    assert.equal(businessMonth(NEW_YEARS_DAY), '2027-01', 'pukul 00:30 WIB sudah bulan berikutnya');
    assert.equal(businessDate(NEW_YEARS_DAY), '2027-01-01');
    assert.equal(businessMonth(END_OF_AUGUST), '2026-08');
    assert.equal(businessMonth(NEW_YEARS_EVE), '2026-12');
  });
  // And it moves with the setting, exactly as the date does: 23:30 Jakarta on 31 August is
  // already September in Makassar.
  withZone('Asia/Makassar', () => {
    assert.equal(businessMonth(END_OF_AUGUST), '2026-09');
    assert.equal(businessDate(END_OF_AUGUST), '2026-09-01');
  });
});

test('the month is always the first seven characters of the day, never computed twice', () => {
  // Two helpers, one fact. A month derived independently - getMonth() + 1 without padding,
  // say - reads "2026-9" and sorts before "2026-10", which is how a chart puts October
  // before September. Walked across a whole day in ten-minute steps so the boundary hour
  // is included, in a zone that is not the default.
  withZone('Asia/Makassar', () => {
    const start = Math.floor(Date.parse('2026-12-31T00:00:00Z') / 1000);
    for (let i = 0; i < 144; i += 1) {
      const at = start + i * 600;
      assert.equal(businessMonth(at), businessDate(at).slice(0, 7), `beda di menit ke-${i * 10}`);
      assert.match(businessMonth(at), /^\d{4}-\d{2}$/);
    }
  });
});

/* --------------------------------------------------------------- the start of a day */

test('the start of a day lands on that day, in every zone the table offers', () => {
  // The offset used to be frozen at import in one place and read live in another, so the
  // boundary and the label could disagree. Checked in all four zones rather than the two
  // that were, because the bug was a constant standing in for a lookup.
  for (const name of Object.keys(ZONES)) {
    withZone(name, () => {
      const start = businessDayStart('2026-09-15');
      assert.equal(businessDate(start), '2026-09-15', `${name}: awal hari jatuh di hari lain`);
      assert.equal(businessDate(start + 86_399), '2026-09-15', `${name}: detik terakhir bocor ke hari berikutnya`);
      assert.equal(businessDate(start - 1), '2026-09-14', `${name}: sedetik sebelumnya bukan hari sebelumnya`);
      assert.equal(businessDate(start + 86_400), '2026-09-16', `${name}`);
      assert.equal(start, Date.UTC(2026, 8, 15) / 1000 - ZONES[name].offsetHours * 3600, name);
    });
  }
});

test('a day that starts a month or a year still starts exactly one day', () => {
  withZone('Asia/Jakarta', () => {
    const newYear = businessDayStart('2027-01-01');
    assert.equal(new Date(newYear * 1000).toISOString(), '2026-12-31T17:00:00.000Z');
    assert.equal(businessDate(newYear), '2027-01-01');
    assert.equal(businessDate(newYear - 1), '2026-12-31', 'tahun sebelumnya berakhir tepat di sini');
    assert.equal(businessMonth(newYear - 1), '2026-12');
    assert.equal(businessMonth(newYear), '2027-01');

    const march = businessDayStart('2026-03-01');
    assert.equal(businessDate(march - 1), '2026-02-28', '2026 bukan tahun kabisat');
    assert.equal(businessDate(businessDayStart('2028-03-01') - 1), '2028-02-29', '2028 tahun kabisat');
  });
});

test('a date that does not exist is refused, not quietly turned into another one', () => {
  // Date.UTC(2026, 1, 31) is 3 March. Without the round-trip guard a typo'd --from would
  // produce a window that silently starts in a different month, and every report built on
  // it would be for a period nobody asked for - while looking entirely normal.
  for (const bad of [
    '2026-02-31',            // February never has 31 days
    '2026-02-29',            // nor 29, in a year that is not a leap year
    '2026-09-31',            // September has 30
    '2026-13-01',            // no thirteenth month
    '2026-00-10',            // nor a zeroth
    '2026-09-00',
    '2026-09-32',
    '2026-9-15',             // unpadded: not the format anything here writes
    '26-09-15',
    '2026-09-15T00:00:00Z',  // a timestamp is not a date string
    ' 2026-09-15',
    '2026-09-15 ',
    'kemarin',
    '',
    null,
    undefined,
  ]) {
    assert.equal(businessDayStart(bad), null, `${JSON.stringify(bad)} seharusnya ditolak`);
  }
  // A real leap day is not refused along with them.
  assert.equal(businessDate(businessDayStart('2028-02-29')), '2028-02-29');
});

test('every day of a year round-trips through its own start', () => {
  // Cheap and total: 365 days, each one asked for by name, each one landing on itself.
  // Catches an off-by-one in the offset arithmetic that only shows up in one month.
  withZone('Asia/Jakarta', () => {
    for (let i = 0; i < 365; i += 1) {
      const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      const start = businessDayStart(date);
      assert.ok(start !== null, `${date} ditolak padahal tanggal sah`);
      assert.equal(businessDate(start), date, `${date} tidak kembali ke dirinya sendiri`);
      assert.equal(businessDate(start - 1) < date, true, `${date}: hari sebelumnya tidak lebih awal`);
    }
  });
});
