import test from 'node:test';
import assert from 'node:assert/strict';

import { buildResend } from '../src/mekari/manual.js';
import { buildWasteEntry, resendCustomId, WASTE_ACCOUNT, INVENTORY_ACCOUNT, ResendError } from '../src/mekari/resend.js';
import { PREFIXES, sourceShips } from '../src/mekari/prefix.js';
import { SOURCES } from '../src/mekari/sources.js';

/**
 * A resend puts right a parcel we got wrong.
 *
 * The customer paid once, for what they ordered, and that invoice already records it. So a
 * resend earns nothing and must never raise a second one. What it does owe the books is
 * the goods that went out by mistake and, by house rule, stay with the customer.
 */

const accounts = { [WASTE_ACCOUNT]: 'Waste Goods Expense', [INVENTORY_ACCOUNT]: 'Inventory' };

const input = (over = {}) => ({
  source: 'RS',
  code: 'RS-261002-00001AB',
  date: '2026-10-02',
  buyer: 'Pelanggan A',
  shipTo: 'Jl. Mawar 1, Jakarta',
  carrier: 'JNE',
  note: 'salah kirim powder',
  addedBy: 'Kemas',
  resendFor: { channel: 'shopee', id: '2609ABCDE' },
  // What they actually ordered and are now getting.
  lines: [{ sku: 'OMC-270-001', qty: 1, unitPrice: 1145000, unitDiscount: 0 }],
  // What went out by mistake and is staying with them.
  wrongLines: [{ sku: 'OMP-180-001', qty: 1, unitPrice: 1145000 }],
  ...over,
});

test('a resend is a parcel, not a sale', () => {
  const order = buildResend(input());

  // The replacement is free however the form was filled in: the price typed above is
  // what the goods are worth, not what anybody is being charged.
  assert.equal(order.total, 0);
  assert.equal(order.finance.lines[0].unitPrice, 0);
  assert.equal(order.finance.shipping, 0);
  assert.deepEqual(order.resendFor, { channel: 'shopee', id: '2609ABCDE' });
});

test('the goods left behind are recorded at what they sell for', () => {
  const order = buildResend(input({ wrongLines: [{ sku: 'OMP-180-001', qty: 2, unitPrice: 1145000 }] }));
  assert.equal(order.finance.wrongGoods.value, 2290000);
  assert.equal(order.finance.wrongGoods.lines[0].sku, 'OMP-180-001');
  assert.equal(order.finance.wrongGoods.date, '2026-10-02');
});

test('a resend must say what it is putting right, and cannot point at another resend', () => {
  assert.throws(() => buildResend(input({ resendFor: null })), /harus menyebut pesanan/);
  assert.throws(() => buildResend(input({ resendFor: { channel: 'shopee', id: '' } })), /harus menyebut pesanan/);
  // Otherwise a free parcel could be justified by a free parcel, forever.
  assert.throws(
    () => buildResend(input({ resendFor: { channel: 'manual', id: 'RS-261001-00009ZZ' } })),
    /tidak bisa menunjuk kirim ulang lain/,
  );
});

test('a resend with nothing left behind has nothing to book, and says so', () => {
  assert.throws(() => buildResend(input({ wrongLines: [] })), /barang yang terlanjur salah kirim/);
  assert.throws(() => buildResend(input({ wrongLines: [{ sku: 'OMP-180-001', qty: 1, unitPrice: 0 }] })), /nilai barang salah kirim nol/);
  assert.throws(() => buildResend(input({ wrongLines: [{ sku: 'TIDAK-ADA', qty: 1, unitPrice: 1000 }] })), /tidak ada di data master/);
});

test('only RS builds a resend', () => {
  assert.throws(() => buildResend(input({ source: 'DP', code: 'DP-261002-00001AB' })), /bukan kirim ulang/);
});

/* ------------------------------------------------------------------- the books */

test('the entry debits the loss and credits the goods, and nothing else', () => {
  const order = buildResend(input());
  const { payload, value } = buildWasteEntry(order, accounts);
  const lines = payload.journal_entry.transaction_account_lines_attributes;

  assert.equal(value, 1145000);
  assert.deepEqual(lines, [
    { account_name: 'Waste Goods Expense', debit: 1145000 },
    { account_name: 'Inventory', credit: 1145000 },
  ]);
  // It balances, which is the one thing a journal entry has to do.
  assert.equal(
    lines.reduce((n, l) => n + (l.debit ?? 0), 0),
    lines.reduce((n, l) => n + (l.credit ?? 0), 0),
  );
});

test('the entry says the whole story, because the ledger is read without an order list beside it', () => {
  const { payload } = buildWasteEntry(buildResend(input()), accounts);
  const entry = payload.journal_entry;

  assert.match(entry.memo, /Salah kirim pada shopee 2609ABCDE/);
  assert.match(entry.memo, /Moringa Powder - 180 gram ×1/);
  assert.match(entry.memo, /diganti lewat RS-261002-00001AB/);
  assert.equal(entry.transaction_no, 'RS-261002-00001AB');
  assert.equal(entry.transaction_date, '2026-10-02');
  assert.deepEqual(entry.tags, ['Kirim ulang']);
  // One entry per resend, so a double submit is refused by Jurnal rather than doubled.
  assert.equal(entry.custom_id, resendCustomId('RS-261002-00001AB'));
});

test('a missing account is caught here, not by a validation error that names none', () => {
  const order = buildResend(input());
  assert.throws(() => buildWasteEntry(order, { [INVENTORY_ACCOUNT]: 'Inventory' }), ResendError);
  assert.throws(() => buildWasteEntry(order, { [WASTE_ACCOUNT]: 'Waste Goods Expense' }), /persediaan/);
});

/* ------------------------------------------------------------------ the parcel */

test('a resend ships, because the whole point is a parcel going out', () => {
  assert.equal(sourceShips('RS'), true);
  assert.equal(PREFIXES.RS.label, 'Kirim ulang');
  assert.equal(SOURCES.RS.tag, 'Kirim ulang');
});

/* --------------------------------------------------------------------- the form */

test('the form grows a resend half when RS is chosen, and only then', async () => {
  const { renderManual } = await import('../src/dashboard-page.js');
  const html = renderManual({
    source: 'CS', code: 'CS-1', today: '2026-10-02', contacts: [], existingCodes: [], live: true,
    prices: { 'OMC-270-001': 1145000 }, csrf: 'tok', range: {}, errors: {}, generatedAt: 0,
  });
  const [body] = html.split('<script>');
  const script = html.split('<script>').pop().split('</script>')[0];

  // Rendered always and shown by the radio: choosing RS must not cost a page load, because
  // the operator is standing in front of a mistake with the form already open.
  assert.match(body, /id="rsfields" hidden/);
  assert.match(body, /name="resendFor"/);
  assert.match(body, /name="wsku"/);
  assert.match(body, /value="RS"/);

  // The three things that make it a resend; any one missing and the button stays down.
  assert.match(script, /hasReplacement\(\) && wrongValue > 0 && linked\.value\.trim\(\)\.length > 0/);
  // And the button stops claiming it sends an invoice, because it does not.
  assert.match(script, /go\.textContent = on \? 'Simpan kirim ulang'/);
});

test('an edit form carries no resend half at all', async () => {
  const { renderManual } = await import('../src/dashboard-page.js');
  const html = renderManual({
    source: 'DP', code: 'DP-1', today: '2026-10-02', contacts: [], existingCodes: [], live: true,
    prices: {}, csrf: 'tok', range: {}, errors: {}, generatedAt: 0,
    editing: {
      channel: 'manual', id: 'DP-261001-0001', source: 'DP', total: 1, createdAt: 1790000000,
      finance: { lines: [{ sku: 'OMC-270-001', qty: 1, unitPrice: 1, unitDiscount: 0 }], shipping: 0 },
    },
  });
  assert.ok(!/id="rsfields"/.test(html), 'mengubah transaksi lama tidak menawarkan kirim ulang');
});
