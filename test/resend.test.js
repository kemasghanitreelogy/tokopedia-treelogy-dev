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

// The shape accountMap actually answers with, read off the live account on 2 Oct: the
// whole account, not its name. An earlier version of this file took the name for granted
// and would have sent "[object Object]" to Jurnal.
const accounts = {
  [WASTE_ACCOUNT]: { id: 112195862, number: WASTE_ACCOUNT, name: 'Waste Goods Expense' },
  [INVENTORY_ACCOUNT]: { id: 112195990, number: INVENTORY_ACCOUNT, name: 'Inventory' },
};

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
  assert.throws(() => buildWasteEntry(order, { [INVENTORY_ACCOUNT]: accounts[INVENTORY_ACCOUNT] }), ResendError);
  assert.throws(() => buildWasteEntry(order, { [WASTE_ACCOUNT]: accounts[WASTE_ACCOUNT] }), /persediaan/);
  // A plain string is still accepted, which is what keeps the rest of these readable.
  assert.doesNotThrow(() => buildWasteEntry(order, { [WASTE_ACCOUNT]: 'Waste Goods Expense', [INVENTORY_ACCOUNT]: 'Inventory' }));
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

/* ------------------------------------------------------------------ the picker */

test('a match is shown with enough to recognise it by, not just its number', async () => {
  const { renderOrderPicks } = await import('../src/dashboard-page.js');
  const html = renderOrderPicks({
    orders: [{
      channel: 'shopify', id: '#11123', buyer: 'Dewi Lestari', buyerPhone: '0812', carrier: 'JNE',
      tracking: 'JX1', createdAt: 1790000000, total: 1145000, shipTo: 'Jl. Mawar 1, Jakarta',
      finance: { lines: [{ sku: 'OMP-180-001', name: 'Moringa Powder - 180 gram', qty: 2 }] },
    }],
  });

  // Nobody recognises an order by its number alone, and recording a mistake against the
  // wrong one is worse than the mistake being recorded.
  assert.match(html, /role="option"/);
  assert.match(html, /data-channel="shopify"/);
  assert.match(html, /data-id="#11123"/);
  assert.match(html, /Dewi Lestari/);
  assert.match(html, /Moringa Powder - 180 gram ×2/);
  // The preview travels with the row, so choosing costs no second request - in a template,
  // whose contents are inert, so the card's buttons exist exactly once in the document.
  assert.match(html, /<template class="pick0__prev">/);
  assert.match(html, /Jl\. Mawar 1, Jakarta/);
  assert.match(html, /Rp1\.145\.000/);
});

test('an empty answer says so rather than leaving a blank box', async () => {
  const { renderOrderPicks } = await import('../src/dashboard-page.js');
  assert.match(renderOrderPicks({ orders: [] }), /role="status"[^>]*>Tidak ada pesanan/);
});

test('a buyer name cannot smuggle markup into the picker', async () => {
  const { renderOrderPicks } = await import('../src/dashboard-page.js');
  const html = renderOrderPicks({
    orders: [{ channel: 'shopee', id: 'A', buyer: '<img src=x onerror=alert(1)>', createdAt: 1, total: 0, lines: [] }],
  });
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x/);
});

test('the picker is a combobox people can use without a mouse', async () => {
  const { renderManual } = await import('../src/dashboard-page.js');
  const html = renderManual({
    source: 'RS', code: 'RS-1', today: '2026-10-02', contacts: [], existingCodes: [], live: true,
    prices: {}, csrf: 'tok', range: {}, errors: {}, generatedAt: 0,
  });
  const [body] = html.split('<script>');
  const script = html.split('<script>').pop().split('</script>')[0];

  assert.match(body, /role="combobox"/);
  assert.match(body, /aria-controls="rs-picks"/);
  assert.match(body, /id="rs-picks" role="listbox"/);
  // Async answers have to be announced, not silently swapped in.
  assert.match(body, /id="rs-status" role="status" aria-live="polite"/);

  assert.match(script, /e\.key === 'ArrowDown'/);
  assert.match(script, /e\.key === 'ArrowUp'/);
  assert.match(script, /e\.key === 'Enter' && active >= 0/);
  assert.match(script, /e\.key === 'Escape'/);
  assert.match(script, /aria-activedescendant/);
  // A stale answer to a fragment already typed past is not an answer.
  assert.match(script, /if \(mine !== pickSeq\) return;/);
  assert.match(script, /status\.textContent = 'Mencari/);
});

test('the panel never shows a resend charging anybody', async () => {
  const { renderManual } = await import('../src/dashboard-page.js');
  const script = renderManual({
    source: 'RS', code: 'RS-1', today: '2026-10-02', contacts: [], existingCodes: [], live: true,
    prices: {}, csrf: 'tok', range: {}, errors: {}, generatedAt: 0,
  }).split('<script>').pop().split('</script>')[0];

  // The replacement lines carry prices - what is being sent is worth knowing - and the
  // server zeroes every one of them. The running total has to agree with the record.
  assert.match(script, /form\.querySelector\('\[data-sum-total\]'\)\.textContent = rupiah\(0\)/);
  assert.match(script, /form\.querySelector\('\[data-total-field\]'\)\.value = '0'/);
});

test('one match is chosen rather than offered, and the card can fill the replacement', async () => {
  const { renderManual } = await import('../src/dashboard-page.js');
  const script = renderManual({
    source: 'RS', code: 'RS-1', today: '2026-10-02', contacts: [], existingCodes: [], live: true,
    prices: {}, csrf: 'tok', range: {}, errors: {}, generatedAt: 0,
  }).split('<script>').pop().split('</script>')[0];

  // Leaving a single row to be clicked is asking somebody to confirm the only possible
  // answer - and the list closes on blur, which is how a typed-in order number showed
  // "1 pesanan cocok" and then nothing at all.
  assert.match(script, /if \(data\.count === 1\) \{ choose\(rows\[0\]\); return; \}/);
  // A click on a row must land before the blur that closes the list.
  assert.match(script, /addEventListener\('mousedown', function \(e\) \{ e\.preventDefault\(\); \}\)/);
  /*
   * What they ordered is what has to be sent, so it is done rather than offered - but
   * never over a row somebody has already named a product in, which is a decision and
   * not an empty space to write into.
   */
  assert.match(script, /function useContents\(card, button\)/);
  assert.match(script, /var filled = replacementEmpty\(\) && useContents\(card, use\);/);
  assert.match(script, /function replacementEmpty\(\)/);
  // Swapping the order takes what it filled in with it, so the next one fills cleanly.
  assert.match(script, /if \(filled\) clearReplacement\(\);/);
  assert.match(script, /baris pengganti terisi dari pesanan ini/);
  // The button stays for the case the fill skipped.
  assert.match(script, /if \(use && !filled\) use\.addEventListener/);
});

test('the order that went wrong is asked for before anything that is read off it', async () => {
  const { renderManual } = await import('../src/dashboard-page.js');
  const [body] = renderManual({
    source: 'RS', code: 'RS-1', today: '2026-10-02', contacts: [], existingCodes: [], live: true,
    prices: {}, csrf: 'tok', range: {}, errors: {}, generatedAt: 0,
  }).split('<script>');

  // The customer, the address and the replacement goods are all answered by that one
  // question, and two of them fill themselves in the moment it is answered.
  // Matched on the fieldset heading, not the word: "Produk" is also a column label.
  const head = (name) => body.indexOf(`class="fset__h">${name}<`);
  const at = (needle) => body.indexOf(needle);
  assert.ok(at('id="rsref"') > head('Sumber'), 'sumber tetap yang pertama ditanya');
  assert.ok(at('id="rsref"') < head('Detail'), 'referensi di atas detail');
  assert.ok(at('id="rsref"') < head('Pelanggan'), 'referensi di atas pelanggan');
  assert.ok(at('id="rsref"') < head('Produk'), 'referensi di atas produk');
  // The goods that went out wrongly stay with the other product rows, where they belong.
  assert.ok(at('id="rsfields"') > head('Produk'));
});

/* ------------------------------------------------- never posted as a sale */

test('a resend is never queued as an invoice, however complete it looks', async () => {
  const { postable, waiting, syncOverview, earnsRevenue } = await import('../src/mekari/sync.js');
  const resend = buildResend(input());
  const sale = {
    channel: 'manual', id: 'DP-261002-0001', source: 'DP', stage: 'completed', status: 'MANUAL',
    createdAt: 1790000000, customer: 'Toko A', total: 100000,
    finance: { lines: [{ sku: 'OMC-270-001', name: 'x', qty: 1, unitPrice: 100000, unitDiscount: 0 }], shipping: 0 },
  };

  /*
   * It passed every other test: stage 'completed', product lines, nothing in the ledger.
   * The sweep would have raised a Rp0 invoice for it every fifteen minutes.
   */
  assert.equal(earnsRevenue(resend), false);
  assert.equal(earnsRevenue(sale), true);
  assert.equal(earnsRevenue({ channel: 'shopee', id: 'x' }), true, 'kanal online tidak punya source');

  const ledger = { orders: {} };
  assert.deepEqual(postable([resend, sale], ledger).map((o) => o.id), ['DP-261002-0001']);
  // Held back by a backoff, which is a list a resend must never appear on either: it is
  // not waiting for anything, it was never going to be posted.
  const later = Date.now() + 60_000;
  const held = { orders: { 'TRL-manual-DP-261002-0001': { next_at: later }, 'TRL-manual-RS-261002-00001AB': { next_at: later } } };
  assert.deepEqual(
    waiting([resend, sale], ledger, { retry: held, now: Date.now() }).map((w) => w.id),
    ['DP-261002-0001'],
  );

  // And the dashboard never shows it as waiting to be booked, because it is not.
  const row = syncOverview({ orders: [resend], ledger, accounts: {} }).rows[0];
  assert.equal(row.state, 'skipped');
  assert.equal(row.total, 0);
  assert.match(row.reason, /dibukukan sebagai beban, bukan penjualan/);
});
