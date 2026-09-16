import test from 'node:test';
import assert from 'node:assert/strict';

import { redatePayload } from '../src/mekari/redate.js';
import { jurnalDate } from '../src/mekari/invoice.js';

// 2026-09-13 16:30 UTC is 2026-09-14 00:30 in Shopee's own clock - the hour this whole
// correction exists for.
const AT = Date.parse('2026-09-13T16:30:00Z') / 1000;

const order = (over = {}) => ({
  channel: 'shopee',
  id: '2609140FJEFCSW',
  stage: 'to_ship',
  createdAt: AT,
  buyer: 'seorang pembeli',
  finance: { lines: [{ sku: 'OMO-30-001', name: 'Moringa Seed Oil 30ml', qty: 1, unitPrice: 505_000, unitDiscount: 0 }], shipping: 0 },
  ...over,
});

const item = (over = {}) => ({
  id: 1,
  no: '11812',
  customId: 'TRL-shopee-2609140FJEFCSW',
  channel: 'shopee',
  was: '2026-09-13',
  should: jurnalDate(AT, 'shopee'),
  total: 505_000,
  settled: true,
  order: order(),
  ...over,
});

test('the correction sends the whole invoice, because Jurnal PATCH replaces rather than patches', () => {
  // A body of {transaction_date} alone was refused twenty-two times with "transaction_lines
  // must not be blank" - the replace had emptied the invoice it was meant to move.
  const { payload } = redatePayload(item(), { depositTo: 'Kas' });
  assert.equal(payload.sales_invoice.transaction_date, '2026-09-14');
  assert.equal(payload.sales_invoice.transaction_lines_attributes.length, 1);
  assert.ok(payload.sales_invoice.due_date);
  assert.equal(payload.sales_invoice.custom_id, 'TRL-shopee-2609140FJEFCSW');
});

test('a paid marketplace invoice keeps its deposit, so the payment moves with the date', () => {
  const { payload } = redatePayload(item(), { depositTo: 'Kas' });
  assert.equal(payload.sales_invoice.deposit, 505_000);
});

test('a rebuild that changes the money is refused - a date is not worth rewriting the amount', () => {
  const { refuse, payload } = redatePayload(item({ total: 480_000 }), { depositTo: 'Kas' });
  assert.equal(payload, undefined);
  assert.match(refuse, /nilai berubah/);
});

test('a settled invoice whose rebuild carries no deposit is refused - replacing it would erase a hand-entered payment', () => {
  // A walk-in sale: the source table never marks these paid, so nothing in the payload
  // would restate the payment somebody recorded by hand.
  const walkIn = item({ order: order({ channel: 'manual', id: 'DW-0007' }), settled: true,
    customId: 'TRL-manual-DW-0007', should: jurnalDate(AT, 'manual') });
  const { refuse } = redatePayload(walkIn, { depositTo: 'Kas' });
  assert.match(refuse, /dicatat manual/);
});

test('an unpaid invoice is moved even though it carries no deposit', () => {
  const walkIn = item({ order: order({ channel: 'manual', id: 'DW-0007' }), settled: false,
    customId: 'TRL-manual-DW-0007', should: jurnalDate(AT, 'manual') });
  const { payload, refuse } = redatePayload(walkIn, { depositTo: 'Kas' });
  assert.equal(refuse, undefined);
  assert.equal(payload.sales_invoice.deposit, undefined);
});

test('a rebuild landing on a different day than planned is refused rather than sent', () => {
  const { refuse } = redatePayload(item({ should: '2026-09-15' }), { depositTo: 'Kas' });
  assert.match(refuse, /tidak sesuai rencana/);
});

test('an order that cannot be rebuilt is reported, not thrown', () => {
  const broken = item({ order: order({ finance: { lines: [], shipping: 0 } }) });
  const { refuse } = redatePayload(broken, { depositTo: 'Kas' });
  assert.match(refuse, /tidak bisa dibangun ulang/);
});
