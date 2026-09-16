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

test('every platform is a day ahead of the house clock for the last hour of the night', () => {
  // Checked against each seller centre rather than reasoned about from the shops' region.
  // Shopee reads "New Order 14/09/2026 00:38" for an instant this system had at 13 Sep
  // 23:38; Tokopedia reads "Waktu pembuatan 03/09/2026 00:25:24" for one it had at 2 Sep
  // 23:25. All four platforms are UTC+8. A sale typed in by hand has no platform and
  // belongs to the day the person entering it is living in.
  const at = Math.floor(Date.parse('2026-09-13T16:38:00Z') / 1000); // 23:38 WIB, 00:38 +8
  for (const channel of ['shopee', 'tokopedia', 'tiktok_shop', 'shopify']) {
    assert.equal(channelDate(at, channel), '2026-09-14', channel);
  }
  assert.equal(channelDate(at, 'manual'), '2026-09-13', 'transaksi manual pakai jam rumah');
  assert.equal(channelDate(at, null), '2026-09-13');
});

test('that same hour moves a sale into the next month, and into the next year', () => {
  // The boundary that matters for a monthly close, and for a financial year.
  const endOfAugust = Math.floor(Date.parse('2026-08-31T16:30:00Z') / 1000);
  assert.equal(channelDate(endOfAugust, 'shopee'), '2026-09-01');
  assert.equal(channelDate(endOfAugust, 'manual'), '2026-08-31');

  const endOfYear = Math.floor(Date.parse('2026-12-31T16:30:00Z') / 1000);
  assert.equal(channelDate(endOfYear, 'tokopedia'), '2027-01-01');
  assert.equal(channelDate(endOfYear, 'manual'), '2026-12-31');
});

test('a channel keeps its own clock even when the house clock is moved', () => {
  // Otherwise changing BUSINESS_TZ would silently re-date every marketplace invoice, and
  // the books would stop agreeing with the seller centres they were reconciled against.
  const at = Math.floor(Date.parse('2026-09-13T16:38:00Z') / 1000);
  const before = process.env.BUSINESS_TZ;
  try {
    for (const zone of ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']) {
      process.env.BUSINESS_TZ = zone;
      for (const channel of ['shopee', 'tokopedia', 'tiktok_shop', 'shopify']) {
        assert.equal(channelDate(at, channel), '2026-09-14', `${channel} di bawah ${zone}`);
      }
    }
  } finally {
    if (before === undefined) delete process.env.BUSINESS_TZ; else process.env.BUSINESS_TZ = before;
  }
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

/* ------------------------- each channel's zone, as the platform itself states it */

test("every platform is UTC+8, and each one's own records are what say so", async () => {
  // The shops are Indonesian, the buyers are Indonesian, Shopee's region reads ID and
  // Tokopedia's seller centre says "Lokasi: ID". I checked those, saw ID, and stopped -
  // which is how every marketplace sale placed between 23:00 and midnight was invoiced a
  // day early for as long as this integration has run.
  //
  // What each platform actually says about the same kind of instant:
  //   Shopee      2609140FJEFCSW -> "New Order 14/09/2026 00:38"; we had 13 Sep 23:38.
  //   Tokopedia   585859894801303056 -> "Waktu pembuatan 03/09/2026 00:25:24"; the stored
  //               instant is 2026-09-02 16:25:24 UTC, which is 00:25 at +8.
  //   TikTok Shop the same seller centre and the same API as Tokopedia.
  //   Shopify     read from the shop's own ianaTimezone.
  const { channelDate: dateFor, zoneForChannel: zoneOf } = await import('../src/clock.js');

  // 13 Sep 16:38 UTC = 14 Sep 00:38 at +8 = 13 Sep 23:38 in Jakarta.
  const shopeeAt = Math.floor(Date.parse('2026-09-13T16:38:00Z') / 1000);
  assert.equal(dateFor(shopeeAt, 'shopee'), '2026-09-14', 'id pesanannya diawali 260914');

  // The Tokopedia order, to the second, exactly as its seller centre prints it.
  const tokopediaAt = Math.floor(Date.parse('2026-09-02T16:25:24Z') / 1000);
  assert.equal(dateFor(tokopediaAt, 'tokopedia'), '2026-09-03');

  for (const channel of ['shopee', 'tokopedia', 'tiktok_shop', 'shopify']) {
    assert.equal(zoneOf(channel).offsetHours, 8, channel);
  }
  // A typed-in sale has no platform, so it keeps the day the person entering it is in.
  assert.equal(dateFor(shopeeAt, 'manual'), '2026-09-13');
  assert.equal(zoneOf('manual').offsetHours, 7);
});

test('a Shopee order id carries the day the platform assigns it', async () => {
  // The check that caught this, kept as a check. If anybody ever moves Shopee back to
  // Jakarta, these real order ids stop matching the day the code computes for them.
  const { channelDate: dateFor } = await import('../src/clock.js');
  const dayFromId = (id) => `20${id.slice(0, 2)}-${id.slice(2, 4)}-${id.slice(4, 6)}`;

  for (const [id, iso] of [
    ['2609140FJEFCSW', '2026-09-13T16:38:00Z'],  // 00:38 di Shopee, 23:38 WIB
    ['260901TRYK3GKA', '2026-09-01T03:00:00Z'],  // tengah hari, semua zona sepakat
  ]) {
    const at = Math.floor(Date.parse(iso) / 1000);
    assert.equal(dateFor(at, 'shopee'), dayFromId(id), `${id} harus jatuh pada hari yang Shopee tulis di id-nya`);
  }
});
