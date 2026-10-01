import test from 'node:test';
import assert from 'node:assert/strict';

import { renderManual, renderDashboard, EDITABLE_MANUAL_SOURCES } from '../src/dashboard-page.js';
import { amendManualInvoice } from '../src/mekari/amend.js';
import { labelReadiness } from '../src/labels.js';
import { summarize } from '../src/omni.js';

/**
 * Correcting a WhatsApp sale that was agreed in a conversation that carried on.
 *
 * Three things have to move together: the invoice in Jurnal, our own row, and a label
 * already on paper that no longer describes the parcel.
 */

const whatsapp = {
  channel: 'manual', id: 'DP-261001-000036F', source: 'DP', total: 1940000,
  createdAt: 1790000000, status: 'MANUAL', stage: 'completed',
  buyer: 'Rahtika Widania', buyerPhone: '08111-67020', buyerEmail: '',
  shipTo: 'Jl. Jaya Mandala 3 No.9 Tebet', carrier: 'Lion Parcel', tracking: '',
  note: 'titip salam - ditambahkan oleh Kemas', items: 2,
  lines: [{ sku: 'OMC-270-001', name: 'Moringa Capsules', variant: '270 caps', qty: 1 }],
  finance: {
    lines: [
      { sku: 'OMC-270-001', name: 'Moringa Capsules', variant: '270 caps', qty: 1, unitPrice: 1145000, unitDiscount: 0 },
      { sku: 'OMC-180-001', name: 'Moringa Capsules', variant: '180 caps', qty: 2, unitPrice: 795000, unitDiscount: 39750, discountPercent: 5 },
    ],
    shipping: 25000,
  },
};

/** The page body, and the form's own script - which is the last one on the page. */
const form = (over = {}) => {
  const parts = renderManual({
    source: 'DP', code: 'DP-x', today: '2026-10-01', contacts: [], existingCodes: [], live: true,
    prices: { 'OMC-270-001': 1145000, 'OMC-180-001': 795000 },
    csrf: 'tok', range: {}, errors: {}, generatedAt: 0, ...over,
  }).split('<script>');
  return [parts[0], parts[parts.length - 1].split('</script>')[0]];
};

test('the edit form opens on what is already there, down to the discount unit', () => {
  const [body] = form({ editing: whatsapp });

  assert.match(body, /name="action" value="manual_update"/);
  assert.match(body, /<option value="OMC-270-001" selected/);
  assert.match(body, /<option value="OMC-180-001" selected/);
  assert.deepEqual(body.match(/name="qty" value="\d+"/g), ['name="qty" value="1"', 'name="qty" value="2"']);
  assert.match(body, /id="shipping"[^>]*value="25000"/);
  assert.match(body, /value="Rahtika Widania"/);
  assert.match(body, /<option value="Lion Parcel" selected>/);
  assert.match(body, /Jl\. Jaya Mandala 3 No\.9 Tebet/);
  // A discount given as a percentage comes back as a percentage: the operator gave an
  // instruction, not an amount, and the form should show the instruction back.
  assert.deepEqual(body.match(/name="discountMode" value="\w+"/g),
    ['name="discountMode" value="rp"', 'name="discountMode" value="pct"']);
  assert.match(body, /name="unitDiscount" value="5"/);
  // The author suffix is added again on save, so it must not be edited back in by hand.
  assert.match(body, /id="note"[^>]*value="titip salam"/);
  assert.ok(!/ditambahkan oleh/.test(body.match(/id="note"[^>]*>/)[0]));
});

test('the code and the source are fixed, because both are the invoice identity', () => {
  const [body] = form({ editing: whatsapp });
  assert.match(body, /id="code"[^>]*value="DP-261001-000036F"[^>]*readonly/s);
  assert.ok(!/data-code/.test(body), 'kode tidak diregenerasi saat mengubah');
  assert.deepEqual(body.match(/name="source" value="\w+"/g), ['name="source" value="DP"']);
  assert.match(body, /Simpan perubahan/);
  assert.match(body, /nomor fakturnya tidak berubah/);
});

test('a product the storefront no longer sells keeps its place on a line already there', () => {
  // Narrowing the list to what Shopify prices must not silently empty a row nobody
  // touched - the save would then rebuild the sale without it.
  const gift = {
    ...whatsapp,
    finance: { lines: [{ sku: 'GFT-MYST-001', name: 'Moringa Seed Oil 3ml', qty: 1, unitPrice: 0, unitDiscount: 0 }], shipping: 0 },
  };
  const [body] = form({ editing: gift });
  assert.match(body, /<option value="GFT-MYST-001" selected/);
});

test('a new row added while editing arrives empty, not carrying the row it was cloned from', () => {
  const [, script] = form({ editing: whatsapp });
  assert.match(script, /row\.querySelector\('\[name="qty"\]'\)\.value = '1';/);
  assert.match(script, /row\.querySelector\('\[name="discountMode"\]'\)\.value = 'rp';/);
  // And every row is wired, not just the first: rows past it had no remove button.
  assert.match(script, /lines\.querySelectorAll\('\[data-row\]'\), wire/);
});

test('the form still works where there is no code field to regenerate', () => {
  const [, script] = form({ editing: whatsapp });
  assert.match(script, /if \(codeIsOurs && codeField\)/);
  assert.doesNotThrow(() => new Function(script));
});

/* ------------------------------------------------------------------ the invoice */

const ledgerWith = (entry) => ({ orders: { 'TRL-manual-DP-261001-000036F': entry } });

const rebuilt = {
  ...whatsapp,
  customer: 'Rahtika Widania',
  total: 1484250,
  finance: { lines: [{ sku: 'OMC-270-001', name: 'Moringa Capsules - 270 caps', variant: '270 caps', qty: 1, unitPrice: 1145000, unitDiscount: 0 }], shipping: 339250 },
};

test('an edited invoice is rewritten in place, so its number survives the correction', async () => {
  const calls = [];
  const saved = [];
  const out = await amendManualInvoice(rebuilt, {
    accounts: {},
    call: async ({ method = 'GET', path, body }) => {
      calls.push({ method, path, hasLines: Boolean(body?.sales_invoice?.transaction_lines_attributes) });
      if (method === 'GET') return { transaction_no: 'INV-77', payment_received_amount: 0, deletable: true };
      return {};
    },
    loadLedger: async () => ledgerWith({ invoice_id: 991 }),
    saveLedger: async (l) => saved.push(l),
    forget: async () => {},
  });

  assert.deepEqual(calls.map((c) => c.method), ['GET', 'PATCH']);
  assert.equal(calls[1].path, '/public/jurnal/api/v1/sales_invoices/991');
  assert.equal(calls[1].hasLines, true, 'PATCH membawa baris produknya, bukan cuma tanggal');
  assert.equal(out.amended, true);
  assert.equal(out.invoiceId, 991);
  assert.equal(out.transactionNo, 'INV-77');
  assert.equal(saved[0].orders['TRL-manual-DP-261001-000036F'].total, out.total);
});

test('an invoice with money against it is never rewritten', async () => {
  let patched = false;
  await assert.rejects(
    () => amendManualInvoice(rebuilt, {
      accounts: {},
      call: async ({ method = 'GET' }) => {
        if (method === 'PATCH') { patched = true; return {}; }
        return { transaction_no: 'INV-77', payment_received_amount: '1940000', deletable: false };
      },
      loadLedger: async () => ledgerWith({ invoice_id: 991 }),
      saveLedger: async () => {},
      forget: async () => {},
    }),
    /sudah menerima pembayaran/,
  );
  assert.equal(patched, false);
});

test('a sale that never reached Jurnal is not pretended to have been amended', async () => {
  let asked = 0;
  const out = await amendManualInvoice(rebuilt, {
    accounts: {},
    call: async () => { asked += 1; return {}; },
    loadLedger: async () => ({ orders: {} }),
    saveLedger: async () => {},
    forget: async () => {},
  });
  assert.equal(asked, 0);
  assert.equal(out.amended, false);
  assert.equal(out.invoiceId, null);
});

/* -------------------------------------------------------------------- the label */

test('a label printed before the edit goes back into the queue, and says why', () => {
  const shipping = { ...whatsapp, shipTo: 'Jl. Jaya Mandala 3 No.9 Tebet' };
  const key = 'manual:DP-261001-000036F';

  assert.deepEqual(labelReadiness(shipping, { [key]: { at: 1, by: 'a', times: 1 } }),
    { state: 'reprint', note: 'sudah dicetak' });

  // Marked stale by an edit: the sheet exists and it is wrong, so the parcel is waiting
  // to be printed again rather than done.
  assert.deepEqual(labelReadiness(shipping, { [key]: { at: 1, by: 'a', times: 1, stale: true } }),
    { state: 'needsPrint', note: 'diubah setelah dicetak - cetak ulang' });
});

/* ------------------------------------------------------------------- the buttons */

const page = (orders, over = {}) => renderDashboard({
  orders, summary: summarize(orders), errors: {}, shopeeShop: null,
  range: { preset: '7d', from: '2026-09-23', to: '2026-10-01', label: '7 hari', since: 1, until: 2, clamped: false },
  generatedAt: Date.now(), baseQuery: 'view=orders&channel=manual', csrf: 'tok', ...over,
});

test('only a WhatsApp sale offers the edit button', () => {
  assert.deepEqual([...EDITABLE_MANUAL_SOURCES], ['DP']);

  const html = page([whatsapp, { ...whatsapp, id: 'CS-1', source: 'CS' }]);
  assert.match(html, /href="\?view=jurnal&amp;edit=DP-261001-000036F/);
  assert.equal((html.match(/view=jurnal&amp;edit=/g) ?? []).length, 1, 'konsinyasi tidak ditawari ubah');
  // Both still offer delete: taking back a slip entered twice is every source's problem.
  assert.equal((html.match(/value="discard_manual"/g) ?? []).length, 2);
});

test('an order that has been edited says so, and by whom', () => {
  const html = page([{ ...whatsapp, editedBy: 'Kemas', editedAt: 1790003600, editedTimes: 2 }]);
  assert.match(html, /class="od__edited"/);
  assert.match(html, /Diubah oleh <b>Kemas<\/b>/);
  assert.match(html, /2&times;/, 'berapa kali diubah ikut disebut');
  // An untouched order carries no such line at all; the stylesheet names the class on
  // every page, so only the markup after it counts.
  assert.ok(!/class="od__edited"/.test(page([whatsapp])));
});
