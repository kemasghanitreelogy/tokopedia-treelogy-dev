import test from 'node:test';
import assert from 'node:assert/strict';

import { discardManual, refusalFor } from '../src/mekari/discard.js';
import { renderDashboard } from '../src/dashboard-page.js';
import { summarize } from '../src/omni.js';

/**
 * Taking back a sale that was typed in by mistake.
 *
 * Two removals that have to agree - the invoice in Jurnal and the row in our table - and
 * the order they happen in is the design: a row dropped before a refused invoice would
 * leave a sale in the books that no screen here can see.
 */

const manual = {
  channel: 'manual', id: 'CS-260929-00002GP', source: 'CS', total: 1265000,
  createdAt: 1790000000, status: 'unpaid', stage: 'to_ship',
  lines: [{ sku: 'Inside-Out-60-Protocol180+30', qty: 1, unitPrice: 1265000, unitDiscount: 0 }],
};

const ledgerWith = (entry) => ({ orders: { 'TRL-manual-CS-260929-00002GP': entry } });

test('an invoice that has been paid against is never deleted, and says why', () => {
  assert.match(
    refusalFor({ transaction_no: 'INV-1', payment_received_amount: '500000', deletable: true }),
    /sudah menerima pembayaran Rp500\.000/,
  );
  // Jurnal's own veto is the second authority.
  assert.match(refusalFor({ transaction_no: 'INV-1', payment_received_amount: 0, deletable: false }), /menolak menghapus/);
  // Silence is not permission.
  assert.match(refusalFor({ transaction_no: 'INV-1' }), /tidak menyebut status pembayaran/);
  // And an invoice that answered, with nothing received, goes.
  assert.equal(refusalFor({ transaction_no: 'INV-1', payment_received_amount: 0, deletable: true }), null);
  assert.equal(refusalFor({ transaction_no: 'INV-1', has_payments: false }), null);
});

test('the invoice goes first, then the row, and the ledger is told in between', async () => {
  const calls = [];
  const saved = [];
  let dropped = null;

  const out = await discardManual('CS-260929-00002GP', {
    read: async () => manual,
    drop: async (channel, id) => { dropped = [channel, id]; return 1; },
    call: async ({ method = 'GET', path }) => {
      calls.push(`${method} ${path}`);
      if (method === 'GET') return { transaction_no: 'INV-9', payment_received_amount: 0, deletable: true };
      return {};
    },
    loadLedger: async () => ledgerWith({ invoice_id: 4321 }),
    saveLedger: async (l) => { saved.push(l); },
  });

  assert.deepEqual(calls, [
    'GET /public/jurnal/api/v1/sales_invoices/4321',
    'DELETE /public/jurnal/api/v1/sales_invoices/4321',
  ]);
  assert.deepEqual(dropped, ['manual', 'CS-260929-00002GP']);
  assert.equal(saved[0].orders['TRL-manual-CS-260929-00002GP'].voided, true);
  assert.deepEqual(
    { ...out, transactionNo: out.transactionNo },
    { id: 'CS-260929-00002GP', total: 1265000, invoiceId: 4321, transactionNo: 'INV-9', wasInvoiced: true, removedFromList: true },
  );
});

test('a refused invoice leaves the row exactly where it was', async () => {
  let dropped = false;
  await assert.rejects(
    () => discardManual('CS-260929-00002GP', {
      read: async () => manual,
      drop: async () => { dropped = true; return 1; },
      call: async () => ({ transaction_no: 'INV-9', payment_received_amount: '1265000', deletable: false }),
      loadLedger: async () => ledgerWith({ invoice_id: 4321 }),
      saveLedger: async () => {},
    }),
    /sudah menerima pembayaran/,
  );
  assert.equal(dropped, false, 'baris pesanan tidak boleh hilang saat faktur bertahan');
});

test('a transaction that never reached Jurnal just goes', async () => {
  let asked = 0;
  const out = await discardManual('CS-260929-00002GP', {
    read: async () => manual,
    drop: async () => 1,
    call: async () => { asked += 1; return {}; },
    loadLedger: async () => ({ orders: {} }),
    saveLedger: async () => {},
  });
  assert.equal(asked, 0, 'tidak ada yang perlu ditanyakan ke Jurnal');
  assert.equal(out.wasInvoiced, false);
  assert.equal(out.removedFromList, true);
});

test('an invoice already voided is not deleted twice', async () => {
  let asked = 0;
  const out = await discardManual('CS-260929-00002GP', {
    read: async () => manual,
    drop: async () => 1,
    call: async () => { asked += 1; return {}; },
    loadLedger: async () => ledgerWith({ invoice_id: 4321, voided: true }),
    saveLedger: async () => {},
  });
  assert.equal(asked, 0);
  assert.equal(out.wasInvoiced, false);
});

test('nothing but a typed-in sale can be discarded this way', async () => {
  // A marketplace order deleted here would come back on the next sweep, and its invoice
  // is not ours to remove on a whim - so a form naming one is refused outright.
  await assert.rejects(
    () => discardManual('260930ABC', { read: async () => ({ channel: 'shopee', id: '260930ABC' }), call: async () => {} }),
    /bukan transaksi yang diketik manual/,
  );
  await assert.rejects(
    () => discardManual('CS-404', { read: async () => null }),
    /tidak ada di daftar/,
  );
});

/* ------------------------------------------------------------------ the button */

const page = (orders, over = {}) => renderDashboard({
  orders, summary: summarize(orders), errors: {}, shopeeShop: null,
  range: { preset: '7d', from: '2026-09-23', to: '2026-09-30', label: '7 hari', since: 1, until: 2, clamped: false },
  generatedAt: Date.now(), baseQuery: 'view=orders&preset=7d', csrf: 'tok', ...over,
});

test('only a typed-in sale offers the delete button, and it asks first', () => {
  const html = page([manual, { ...manual, channel: 'shopify', id: '#11107', source: undefined }]);

  assert.match(html, /name="action" value="discard_manual"/);
  assert.equal((html.match(/value="discard_manual"/g) ?? []).length, 1);
  assert.match(html, /Hapus transaksi/);
  // The question names the code, the money and what else goes with it.
  assert.match(html, /data-confirm="Hapus CS-260929-00002GP senilai Rp1\.265\.000\?[^"]*Jurnal ikut dihapus/);
  assert.match(html, /um__act--bad/, 'dialognya bernada merah, seperti hapus pengguna');
});

test('without a token there is no delete button', () => {
  assert.ok(!/discard_manual/.test(page([manual], { csrf: null })));
});
