import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETRY_DOC, BACKOFF_MINUTES, ALERT_AFTER_ATTEMPTS,
  backoffMs, loadRetryBook, recordOutcomes, isDue, overdue, escalations, markAlerted, retryNow, forgetRetry,
} from '../src/mekari/retry.js';
import { postable, waiting } from '../src/mekari/sync.js';
import { formatStuckOrders } from '../src/notify/telegram.js';
import { deleteDoc, closeStore } from '../src/store/index.js';

/**
 * Every order reaches the books, or somebody is told why not.
 *
 * Ten Shopee orders whose SKU was missing from the master data were refused every quarter
 * of an hour from 18 to 25 September. The retry worked - it just never stopped, never
 * widened, never escalated, and would have lost them entirely once they aged out of the
 * sweep's seven-day window.
 */

test.after(async () => { await closeStore(); });
const clean = () => deleteDoc(RETRY_DOC);

const order = (id, extra = {}) => ({
  channel: 'shopee', id, createdAt: 1790000000, stage: 'completed', total: 395000, customer: 'nanikyusie',
  lines: [{ sku: 'OMC-90-001', qty: 1 }],
  finance: { lines: [{ sku: 'OMC-90-001', qty: 1, unitPrice: 395000, unitDiscount: 0 }], shipping: 0 },
  ...extra,
});
const failed = (id, error = 'SKU Oil-3ml tidak ada di data master') =>
  ({ customId: `TRL-shopee-${id}`, id, channel: 'shopee', status: 'failed', error });

test('the wait widens with each attempt and then stops widening', () => {
  assert.equal(backoffMs(1), 0, 'kegagalan pertama dicoba lagi di sweep berikutnya');
  assert.equal(backoffMs(2), 15 * 60_000);
  assert.equal(backoffMs(3), 30 * 60_000);
  // Capped, because the far end of this schedule is where an operator is waiting for the
  // fix they just made to be picked up.
  const cap = BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1] * 60_000;
  assert.equal(backoffMs(9), cap);
  assert.equal(backoffMs(99), cap);
});

test('a failure is written down with everything needed to act on it', async () => {
  await clean();
  const now = Date.parse('2026-09-25T04:00:00Z');
  await recordOutcomes([failed('260918CC2WWVTR')], { orders: [order('260918CC2WWVTR')], now });

  const book = await loadRetryBook();
  const entry = book.orders['TRL-shopee-260918CC2WWVTR'];
  assert.equal(entry.attempts, 1);
  assert.equal(entry.channel, 'shopee');
  assert.equal(entry.order_id, '260918CC2WWVTR');
  assert.equal(entry.total, 395000, 'nilainya ikut, supaya pesan Telegram tidak perlu baca ulang');
  assert.equal(entry.customer, 'nanikyusie');
  assert.match(entry.error, /Oil-3ml/);
  assert.equal(entry.first_failed_at, new Date(now).toISOString());
});

test('trying again counts up but keeps when it first went wrong', async () => {
  await clean();
  const first = Date.parse('2026-09-25T04:00:00Z');
  await recordOutcomes([failed('A')], { orders: [order('A')], now: first });
  await recordOutcomes([failed('A')], { orders: [order('A')], now: first + 20 * 60_000 });
  await recordOutcomes([failed('A')], { orders: [order('A')], now: first + 50 * 60_000 });

  const entry = (await loadRetryBook()).orders['TRL-shopee-A'];
  assert.equal(entry.attempts, 3);
  assert.equal(entry.first_failed_at, new Date(first).toISOString(), 'sejak kapan, bukan terakhir kapan');
  assert.equal(entry.next_at, first + 50 * 60_000 + backoffMs(3));
});

test('an order that reaches the books leaves the book, however it got there', async () => {
  await clean();
  await recordOutcomes([failed('B')], { orders: [order('B')] });
  assert.ok((await loadRetryBook()).orders['TRL-shopee-B']);

  // 'exists' matters as much as 'created': a webhook may have posted it between sweeps.
  await recordOutcomes([{ customId: 'TRL-shopee-B', id: 'B', channel: 'shopee', status: 'exists', invoiceId: 7 }], {});
  assert.equal((await loadRetryBook()).orders['TRL-shopee-B'], undefined);
});

test('a deferral is not a failure and never enters the book', async () => {
  await clean();
  await recordOutcomes([{ customId: 'TRL-shopee-C', id: 'C', channel: 'shopee', status: 'deferred', busy: true }], {});
  assert.deepEqual(Object.keys((await loadRetryBook()).orders), [], 'ditunda bukan gagal');
});

test('an order serving its backoff is not attempted, and says so rather than vanishing', async () => {
  const now = Date.parse('2026-09-25T04:00:00Z');
  const ledger = { orders: {} };
  const retry = { orders: { 'TRL-shopee-D': { attempts: 2, next_at: now + 10 * 60_000, error: 'kontak gagal' } } };
  const orders = [order('D'), order('E')];

  assert.deepEqual(postable(orders, ledger, { retry, now }).map((o) => o.id), ['E']);
  assert.deepEqual(waiting(orders, ledger, { retry, now }).map((w) => w.id), ['D']);

  // Once the wait has elapsed it is simply an order again.
  assert.deepEqual(postable(orders, ledger, { retry, now: now + 11 * 60_000 }).map((o) => o.id), ['D', 'E']);
});

test('a caller that passes no book behaves exactly as before', () => {
  const orders = [order('F')];
  assert.deepEqual(postable(orders, { orders: {} }).map((o) => o.id), ['F']);
  assert.deepEqual(waiting(orders, { orders: {} }), []);
});

test('the book carries orders past the edge of the sweep window', async () => {
  await clean();
  const now = Date.parse('2026-09-25T04:00:00Z');
  await recordOutcomes([failed('OLD')], { orders: [order('OLD')], now });

  // One failure is due immediately; that is what stops it ageing out of a --7d sweep.
  const due = overdue(await loadRetryBook(), { now: now + 1000 });
  assert.deepEqual(due.map((d) => d.id), ['OLD']);
  assert.equal(due[0].channel, 'shopee');

  await recordOutcomes([failed('OLD')], { orders: [order('OLD')], now: now + 1000 });
  assert.deepEqual(overdue(await loadRetryBook(), { now: now + 2000 }), [], 'yang sedang menunggu tidak ikut');
});

test('a first failure is not news; a third one is', async () => {
  await clean();
  const now = Date.parse('2026-09-25T04:00:00Z');
  for (let i = 1; i <= ALERT_AFTER_ATTEMPTS - 1; i += 1) {
    await recordOutcomes([failed('G')], { orders: [order('G')], now: now + i * 60_000 });
    assert.deepEqual(escalations(await loadRetryBook()), [], `percobaan ${i} belum dilaporkan`);
  }
  await recordOutcomes([failed('G')], { orders: [order('G')], now: now + 99 * 60_000 });
  assert.deepEqual((escalations(await loadRetryBook())).map((e) => e.customId), ['TRL-shopee-G']);
});

test('what has been reported is not reported again until it has been tried again', async () => {
  await clean();
  const now = Date.parse('2026-09-25T04:00:00Z');
  for (let i = 1; i <= 3; i += 1) await recordOutcomes([failed('H')], { orders: [order('H')], now: now + i * 60_000 });

  const first = escalations(await loadRetryBook());
  assert.equal(first.length, 1);
  await markAlerted(first.map((e) => e.customId));
  assert.deepEqual(escalations(await loadRetryBook()), [], 'sekali per percobaan, bukan sekali per sweep');

  // Tried again, failed again - that is new information, so it goes out again.
  await recordOutcomes([failed('H')], { orders: [order('H')], now: now + 200 * 60_000 });
  assert.deepEqual((escalations(await loadRetryBook())).map((e) => e.customId), ['TRL-shopee-H']);
});

test('the message says which sale, whose, how much, since when and exactly why', () => {
  const html = formatStuckOrders([{
    customId: 'TRL-shopee-260918CC2WWVTR',
    channel: 'shopee',
    order_id: '260918CC2WWVTR',
    customer: 'nanikyusie',
    attempts: 5,
    total: 395000,
    ordered_at: 1790000000,
    first_failed_at: '2026-09-25T02:00:00Z',
    error: 'SKU Oil-3ml tidak ada di data master',
  }], { now: Date.parse('2026-09-25T05:00:00Z') });

  assert.match(html, /260918CC2WWVTR/);
  assert.match(html, /nanikyusie/);
  assert.match(html, /Rp395\.000/);
  assert.match(html, /gagal <b>5×<\/b>/);
  assert.match(html, /3 jam/, 'sejak kapan, dalam satuan yang bisa dibaca');
  assert.match(html, /Oil-3ml/, 'alasannya apa adanya, bukan diringkas');
});

test('a reason carrying markup cannot break the message', () => {
  const html = formatStuckOrders([{ customId: 'X', channel: 'shopee', order_id: 'X', attempts: 3, error: '<b>alamat & "kutip"</b>' }]);
  assert.match(html, /&lt;b&gt;alamat &amp; "kutip"&lt;\/b&gt;/);
});

test('an operator who has fixed the cause need not wait out the schedule', async () => {
  await clean();
  const now = Date.now();
  await recordOutcomes([failed('I'), failed('J')], { orders: [order('I'), order('J')], now });
  await recordOutcomes([failed('I')], { orders: [order('I')], now });
  assert.equal(overdue(await loadRetryBook()).length, 1, 'satu sedang menunggu');

  assert.equal(await retryNow(), 2);
  assert.equal(overdue(await loadRetryBook()).length, 2, 'dua-duanya siap dicoba lagi');
});

test('an entry can be dropped by hand for a sale that will never be invoiced', async () => {
  await clean();
  await recordOutcomes([failed('K')], { orders: [order('K')] });
  await forgetRetry('TRL-shopee-K');
  assert.deepEqual(Object.keys((await loadRetryBook()).orders), []);
});

test('isDue treats an order nobody has ever failed on as ready', () => {
  assert.equal(isDue(undefined), true);
  assert.equal(isDue(null), true);
});
