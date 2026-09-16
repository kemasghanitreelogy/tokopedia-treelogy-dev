import test from 'node:test';
import assert from 'node:assert/strict';

import { repoolBody, DEFAULT_METHOD } from '../src/mekari/repool.js';

const item = (over = {}) => ({
  id: 1972447248,
  no: '12634',
  date: '15/09/2026',
  was: '1104 BCA',
  to: 'Pooling Account for Shopee',
  toNumber: '1111',
  amount: 1_225_000,
  person: 'ronisyah1',
  method: null,
  memo: null,
  records: [{ id: 726128316, transaction_no: '13234', amount: 1_225_000 }],
  ...over,
});

test('the body carries everything Jurnal demands, because its PATCH replaces the payment', () => {
  // Sending the account alone is refused with "Payment method must be sent" and the record
  // rows blank - the replace had emptied the payment it was meant to move.
  const { body } = repoolBody(item());
  const p = body.receive_payment;
  assert.equal(p.deposit_to_name, 'Pooling Account for Shopee');
  assert.equal(p.transaction_date, '2026-09-15', 'dd/mm/yyyy dibaca, yyyy-mm-dd dikirim');
  assert.equal(p.person_name, 'ronisyah1');
  assert.deepEqual(p.records_attributes, [{ id: 726128316, transaction_no: '13234', amount: 1_225_000 }]);
});

test('a payment with no method of its own is called a transfer, which is what a payout is', () => {
  assert.equal(repoolBody(item()).body.receive_payment.payment_method_name, DEFAULT_METHOD);
  assert.equal(repoolBody(item({ method: 'Cash' })).body.receive_payment.payment_method_name, 'Cash',
    'metode yang sudah ada tidak boleh ditimpa');
});

test('a memo is preserved and an absent one is not invented', () => {
  assert.equal(repoolBody(item({ memo: 'Pelunasan otomatis' })).body.receive_payment.memo, 'Pelunasan otomatis');
  assert.ok(!('memo' in repoolBody(item()).body.receive_payment));
});

test('a payment missing what the replace needs is refused rather than sent half-formed', () => {
  // Each of these would be accepted as a request and land as a payment stripped of the
  // thing it was missing.
  assert.match(repoolBody(item({ person: null })).refuse, /nama orang/);
  assert.match(repoolBody(item({ records: [] })).refuse, /tidak menunjuk faktur/);
  assert.match(repoolBody(item({ date: 'kemarin' })).refuse, /tanggal tidak terbaca/);
});

test('a date written with dashes reads the same as one with slashes', () => {
  // Jurnal answers with both spellings on the same record - transaction_date with slashes,
  // due_date with dashes - so the parser has to take either.
  assert.equal(repoolBody(item({ date: '15-09-2026' })).body.receive_payment.transaction_date, '2026-09-15');
});

test('the window is read from the payment\'s own date, so an excluded one is never fetched twice', () => {
  // --from exists to not pay for what it excludes: a payment before the window is dropped
  // before anything else is done with it.
  const iso = (d) => repoolBody(item({ date: d })).body.receive_payment.transaction_date;
  assert.equal(iso('01/09/2026'), '2026-09-01');
  assert.ok(iso('31/08/2026') < '2026-09-01', 'Agustus jatuh di luar jendela September');
});
