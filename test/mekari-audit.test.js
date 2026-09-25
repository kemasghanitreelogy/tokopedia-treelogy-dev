import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyRecap } from '../src/mekari/recap.js';
import { formatUninvoiced, notifyUninvoiced } from '../src/notify/telegram.js';

/**
 * The nightly proof that every sale reached the books.
 *
 * The sweep looks at seven days and knows only about orders it attempted. An order whose
 * stage moves to completed a fortnight after it was placed is outside that window, and
 * until this ran nothing would ever have noticed it was never invoiced.
 */

const order = (id, extra = {}) => ({
  channel: 'shopee', id, createdAt: 1790000000, stage: 'completed', total: 100000, customer: 'budi',
  finance: { lines: [{ sku: 'OMC-90-001', qty: 1, unitPrice: 100000, unitDiscount: 0 }], shipping: 0 },
  ...extra,
});

const recapOf = (orders, invoices = []) => dailyRecap({
  from: '2026-08-01',
  until: 1790500000,
  readOrders: async () => orders,
  readInvoices: async () => ({ invoices, cached: false, requests: 1, complete: true, walked: invoices.length, expected: invoices.length }),
});

test('an unbooked sale is named, not just counted', async () => {
  const r = await recapOf([order('AAA'), order('BBB')], [
    { id: 9, customId: 'TRL-shopee-AAA', date: '2026-09-21', total: 100000 },
  ]);

  assert.equal(r.missing, 1);
  assert.deepEqual(r.missingOrders.map((o) => o.id), ['BBB']);
  assert.equal(r.missingOrders[0].channel, 'shopee');
  assert.equal(r.missingOrders[0].total, 100000);
  assert.equal(r.missingOrders[0].customer, 'budi');
});

test('an order with no priced lines is separated, because no sweep could ever post it', async () => {
  // Otherwise this reads as a sale somebody forgot, every night, for ever.
  const r = await recapOf([order('CCC', { finance: { lines: [], shipping: 0 } })]);
  assert.deepEqual(r.missingOrders, []);
  assert.deepEqual(r.uninvoiceable.map((o) => o.id), ['CCC']);
  assert.match(r.uninvoiceable[0].reason, /tanpa baris keuangan/);
});

test('an order that is not a sale yet is not missing from anything', async () => {
  const r = await recapOf([order('DDD', { stage: 'to_pay' }), order('EEE', { stage: 'cancelled' })]);
  assert.equal(r.missing, 0);
  assert.deepEqual(r.missingOrders, []);
  assert.deepEqual(r.uninvoiceable, []);
});

test('the message carries what an operator needs to chase the sale', () => {
  const html = formatUninvoiced({
    from: '2026-08-01',
    missingValue: 250000,
    missingOrders: [{ customId: 'TRL-shopee-ZZZ', channel: 'shopee', id: 'ZZZ', customer: 'nanikyusie', total: 250000, day: '2026-09-10', stage: 'completed', orderedAt: 1789000000 }],
    uninvoiceable: [{ customId: 'TRL-tokopedia-QQQ', id: 'QQQ' }],
  }, { now: 1790000000_000 });

  assert.match(html, /ZZZ/);
  assert.match(html, /nanikyusie/);
  assert.match(html, /Rp250\.000/);
  assert.match(html, /2026-09-10/);
  assert.match(html, /completed/);
  assert.match(html, /hari lalu/);
  assert.match(html, /QQQ/, 'yang tidak bisa difakturkan tetap disebut, terpisah');
});

test('a scan that came back short reports itself instead of accusing anyone', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).text); return { ok: true, json: async () => ({ ok: true }) }; };
  const config = { token: 'tok', chatId: '42' };

  const result = await notifyUninvoiced(
    { from: '2026-08-01', complete: false, walked: 900, expected: 2472, missingOrders: [{ customId: 'X' }] },
    { fetchImpl, config },
  );
  assert.equal(result.sent, true);
  assert.match(sent[0], /tidak bisa diselesaikan/);
  assert.match(sent[0], /900 dari 2472/);
  assert.doesNotMatch(sent[0], /belum ada fakturnya/, 'tidak menuduh saat datanya sendiri tidak lengkap');
});

test('a clean night is silence', async () => {
  const result = await notifyUninvoiced({ from: '2026-08-01', complete: true, missingOrders: [], uninvoiceable: [] }, {
    fetchImpl: async () => { throw new Error('tidak boleh dipanggil'); },
    config: { token: 'tok', chatId: '42' },
  });
  assert.equal(result.sent, false);
});
