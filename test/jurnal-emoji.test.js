import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutEmoji, buildInvoice } from '../src/mekari/invoice.js';

/**
 * Jurnal answers 422 "Memo may not contain emoji" and throws the whole invoice away.
 * A walk-in sale typed at 12:01 on 24 Sep 2026 was lost exactly that way.
 */

test('the characters Jurnal refuses are the ones taken out', () => {
  assert.equal(withoutEmoji('Kasih bonus ya 🎁 thanks!'), 'Kasih bonus ya thanks!');
  // A smiling face carries a variation selector behind it; left alone it is the invisible
  // remains of a character that is no longer there.
  assert.equal(withoutEmoji('Walk-in ☺️ Vanya'), 'Walk-in Vanya');
  assert.equal(withoutEmoji('👨🏽‍🍳 masak'), 'masak', 'skin tone and the joiner go too');
  // The keycap wrapper goes; the digit is not an emoji and nobody objects to it.
  assert.equal(withoutEmoji('7\u{FE0F}\u{20E3} botol'), '7 botol');
  assert.equal(withoutEmoji('🎉'), '', 'a note that was only an emoji becomes nothing');
});

test('ordinary Indonesian text comes through untouched', () => {
  for (const text of [
    'Kapsul 90 X 3 (Box Terpisah)',
    'Bayar tunai, minta nota',
    'Jl. Kertha Dalem IV No 10, Denpasar 80224',
    'Ambil sendiri - Rp1.250.000',
    'Café & Co.',
  ]) {
    assert.equal(withoutEmoji(text), text, text);
  }
});

test('nothing at all is still nothing, not the word undefined', () => {
  assert.equal(withoutEmoji(undefined), '');
  assert.equal(withoutEmoji(null), '');
  assert.equal(withoutEmoji('   '), '');
});

const order = (over = {}) => ({
  channel: 'manual', id: 'DW-260924-00001JN', source: 'DW', createdAt: 1790222400,
  buyer: 'Vanya', buyerPhone: '08123456789', shipTo: '', total: 250000, currency: 'IDR',
  stage: 'completed', status: 'MANUAL',
  lines: [{ sku: 'OMC-90-001', name: 'Moringa Capsules', variant: '90 caps', qty: 1 }],
  finance: { lines: [{ sku: 'OMC-90-001', name: 'Moringa Capsules', variant: '90 caps', qty: 1, unitPrice: 250000, unitDiscount: 0 }], shipping: 0 },
  ...over,
});

test('the memo Jurnal is sent carries the note without the emoji', () => {
  const { sales_invoice: invoice } = buildInvoice({
    order: order({ note: 'Walk-in bonus 🎁 buat Bu Sinta' }),
    accounts: { sales: 1, shipping: 2, deposit: 3 },
  });
  assert.ok(invoice.memo.includes('Walk-in bonus buat Bu Sinta'));
  assert.ok(!/\p{Extended_Pictographic}/u.test(invoice.memo), 'tidak ada emoji tersisa di memo');
  // And the rest of the memo is untouched: the channel, the code and the phone.
  assert.ok(invoice.memo.includes('DW-260924-00001JN'));
  assert.ok(invoice.memo.includes('Telp 08123456789'));
});

test('an address with an emoji in it is sent clean, and still an address', () => {
  const { sales_invoice: invoice } = buildInvoice({
    order: order({ shipTo: 'Jl. Mawar 12 🏠 Denpasar' }),
    accounts: { sales: 1, shipping: 2, deposit: 3 },
  });
  assert.equal(invoice.shipping_address, 'Jl. Mawar 12 Denpasar');
});

test('a note that was nothing but an emoji leaves no empty separator behind', () => {
  const { sales_invoice: invoice } = buildInvoice({
    order: order({ note: '🎉', buyerPhone: '' }),
    accounts: { sales: 1, shipping: 2, deposit: 3 },
  });
  assert.ok(!invoice.memo.includes('· ·'));
  assert.ok(!invoice.memo.trim().endsWith('·'));
});

test('our own copy of the note keeps the emoji, because the customer is not objecting', async () => {
  const { buildManualOrder } = await import('../src/mekari/manual.js');
  const built = buildManualOrder({
    source: 'DW', code: 'DW-260924-00001JN', date: '2026-09-24', customer: 'Bu Sinta',
    note: 'Walk-in bonus 🎁', shipping: 0,
    lines: [{ sku: 'OMC-90-001', qty: 1, unitPrice: 250000, unitDiscount: 0 }],
    now: Date.parse('2026-09-24T04:01:00Z'),
  });
  // Stripped only on the way to Jurnal. The label and the invoice we draw are for the
  // customer, and the customer is not the one refusing it.
  assert.ok(built.note.includes('🎁'));
});

test('the guard that runs in the browser is the regex we meant to send', async () => {
  const { renderManual } = await import('../src/dashboard-page.js');
  const html = renderManual({
    range: { preset: '7d', from: '2026-09-24', to: '2026-09-24', label: 'hari ini', since: 1, until: 2, clamped: false },
    errors: {}, shopeeShop: null, generatedAt: 0, csrf: 'c', flash: null,
    source: 'DW', code: 'DW-260924-00001KP', today: '2026-09-24', contacts: [],
    live: true, existingCodes: [], images: {}, seqTail: '', prices: {}, user: null,
  });

  // The whole script is a template literal, so a single backslash is eaten before it
  // reaches the browser. Written that way, the class that arrives is a list of the
  // letters in "p{Extended_Pictographic}" and it matches the t, i and p in "titip".
  const emitted = /var pictographs = ([^;]+);/.exec(html)?.[1];
  assert.ok(emitted, 'penjaga tidak ikut terkirim');
  assert.ok(emitted.includes('\\p{Extended_Pictographic}'), 'escape hilang di perjalanan');

  // Built from the emitted text, not from a copy of it, so the two cannot drift apart.
  const guard = new RegExp(emitted.slice(1, emitted.lastIndexOf('/')), 'u');
  for (const quiet of ['titip di toko A', 'Kapsul 90 X 3 (Box Terpisah)', 'Café & Co.', 'Bayar tunai']) {
    assert.equal(guard.test(quiet), false, `${quiet} seharusnya tidak memicu peringatan`);
  }
  for (const loud of ['bonus 🎁 buat Bu Sinta', 'Walk-in ☺️ Vanya', '🎉']) {
    assert.equal(guard.test(loud), true, `${loud} seharusnya memicu peringatan`);
  }
  // And it agrees with the server, which is what actually protects the invoice.
  for (const text of ['titip di toko A', 'bonus 🎁 buat Bu Sinta', 'Walk-in ☺️ Vanya']) {
    assert.equal(guard.test(text), withoutEmoji(text) !== text, `penjaga dan pembersih tidak sepakat soal ${text}`);
  }
});
