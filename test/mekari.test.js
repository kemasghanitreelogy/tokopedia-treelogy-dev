import test from 'node:test';
import assert from 'node:assert/strict';

import { signRequest, httpDate } from '../src/mekari/client.js';
import {
  buildInvoice, verifyInvoice, customIdFor, jurnalDate, productNameFor, InvoiceError, CUSTOMER_NAMES,
} from '../src/mekari/invoice.js';
import { postable, postOrder, POSTABLE_STAGES } from '../src/mekari/sync.js';

const order = (over = {}) => ({
  channel: 'shopee',
  id: '260911QF5PA82R',
  stage: 'to_ship',
  createdAt: 1_757_500_000,
  buyer: 'nurizaamelia',
  carrier: 'JNE Reguler',
  finance: { lines: [{ sku: 'MSO-30', name: 'Moringa Seed Oil 30ml', qty: 1, unitPrice: 505_000, unitDiscount: 0 }], shipping: 0 },
  ...over,
});

test('signature signs the date and request line exactly as documented', () => {
  const { payload, header } = signRequest({
    method: 'get', path: '/public/jurnal/api/v1/sales_invoices?page=1',
    date: 'Mon, 08 Sep 2026 04:05:06 GMT', clientId: 'id-abc', clientSecret: 'rahasia',
  });

  assert.equal(payload, 'date: Mon, 08 Sep 2026 04:05:06 GMT\nGET /public/jurnal/api/v1/sales_invoices?page=1 HTTP/1.1');
  assert.match(header, /^hmac username="id-abc", algorithm="hmac-sha256", headers="date request-line", signature="/);
  // Stable across runs - a signature that drifted would fail intermittently in production.
  const again = signRequest({
    method: 'GET', path: '/public/jurnal/api/v1/sales_invoices?page=1',
    date: 'Mon, 08 Sep 2026 04:05:06 GMT', clientId: 'id-abc', clientSecret: 'rahasia',
  });
  assert.equal(again.header, header);
});

test('a different secret produces a different signature', () => {
  const base = { method: 'GET', path: '/x', date: 'Mon, 08 Sep 2026 04:05:06 GMT', clientId: 'id' };
  assert.notEqual(
    signRequest({ ...base, clientSecret: 'a' }).header,
    signRequest({ ...base, clientSecret: 'b' }).header,
  );
});

test('httpDate is RFC 1123 in GMT', () => {
  assert.match(httpDate(new Date('2026-09-08T04:05:06Z')), /^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
});

test('an order just before WIB midnight books on the seller day, not the UTC day', () => {
  // 2026-09-11 23:30 WIB is still 16:30 UTC on the 11th; an order at 00:30 WIB on the
  // 12th is 17:30 UTC on the 11th and must book on the 12th.
  assert.equal(jurnalDate(Date.parse('2026-09-11T16:30:00Z') / 1000), '2026-09-11');
  assert.equal(jurnalDate(Date.parse('2026-09-11T17:30:00Z') / 1000), '2026-09-12');
});

test('custom_id is stable and namespaced per channel', () => {
  assert.equal(customIdFor(order()), 'TRL-shopee-260911QF5PA82R');
  assert.notEqual(customIdFor(order()), customIdFor(order({ channel: 'tokopedia' })));
});

test('invoice totals goods plus shipping and carries the reference', () => {
  const { sales_invoice: invoice, expectedTotal } = buildInvoice({ order: order() });
  assert.equal(expectedTotal, 505_000);
  assert.equal(verifyInvoice({ sales_invoice: invoice }, expectedTotal), 505_000);
  assert.equal(invoice.person_name, CUSTOMER_NAMES.shopee);
  assert.equal(invoice.reference_no, 'SP-260911QF5PA82R');
  assert.ok(invoice.due_date > invoice.transaction_date, 'termin Net 14 harus menggeser jatuh tempo');
  assert.equal(invoice.ship_via, 'JNE Reguler');
  assert.equal(invoice.deposit, undefined, 'tanpa deposit_to faktur tetap terbuka');
});

test('a seller-funded discount reduces the line, quantity multiplies it', () => {
  const { sales_invoice: invoice, expectedTotal } = buildInvoice({
    order: order({ finance: { lines: [{ sku: 'MSO-30', qty: 3, unitPrice: 100_000, unitDiscount: 10_000 }], shipping: 15_000 } }),
  });
  assert.equal(expectedTotal, 3 * 90_000 + 15_000);
  assert.equal(verifyInvoice({ sales_invoice: invoice }, expectedTotal), 285_000);
});

test('deposit_to marks the invoice paid for the exact total', () => {
  const built = buildInvoice({ order: order({ finance: { lines: [{ sku: 'X', qty: 2, unitPrice: 50_000, unitDiscount: 0 }], shipping: 9_000 } }), depositTo: 'Cash' });
  assert.equal(built.sales_invoice.deposit, 109_000);
  assert.equal(built.sales_invoice.deposit_to_name, 'Cash');
  assert.equal(verifyInvoice(built, built.expectedTotal), 109_000);
});

test('verification rejects a total that does not add up', () => {
  const built = buildInvoice({ order: order() });
  built.sales_invoice.transaction_lines_attributes[0].rate = 999;
  assert.throws(() => verifyInvoice(built, built.expectedTotal), InvoiceError);
});

test('verification rejects a deposit that disagrees with the total', () => {
  const built = buildInvoice({ order: order(), depositTo: 'Cash' });
  built.sales_invoice.deposit = 1;
  assert.throws(() => verifyInvoice(built, built.expectedTotal), InvoiceError);
});

test('malformed money never becomes an invoice', () => {
  const bad = [
    { lines: [], shipping: 0 },
    { lines: [{ sku: 'A', qty: 0, unitPrice: 1000, unitDiscount: 0 }], shipping: 0 },
    { lines: [{ sku: 'A', qty: 1.5, unitPrice: 1000, unitDiscount: 0 }], shipping: 0 },
    { lines: [{ sku: 'A', qty: 1, unitPrice: -1, unitDiscount: 0 }], shipping: 0 },
    { lines: [{ sku: 'A', qty: 1, unitPrice: 1000, unitDiscount: 2000 }], shipping: 0 },
    { lines: [{ sku: 'A', qty: 1, unitPrice: 1000, unitDiscount: 0 }], shipping: -5 },
  ];
  for (const finance of bad) {
    assert.throws(() => buildInvoice({ order: order({ finance }) }), InvoiceError, JSON.stringify(finance));
  }
  assert.throws(() => buildInvoice({ order: order({ finance: undefined }) }), InvoiceError);
});

test('a known SKU is named from the master catalogue, an unknown one falls back', () => {
  assert.equal(productNameFor({ sku: 'tidak-ada-di-master', name: 'Nama dari channel' }), 'Nama dari channel');
  assert.equal(productNameFor({ sku: 'tidak-ada', name: '' }), 'tidak-ada');
});

test('only paid, uncancelled, unsynced orders are queued', () => {
  const ledger = { orders: { 'TRL-shopee-sudah': { invoice_id: 1 } } };
  const queue = postable([
    order({ id: 'belum-bayar', stage: 'unpaid' }),
    order({ id: 'batal', stage: 'cancelled' }),
    order({ id: 'retur', stage: 'returned' }),
    order({ id: 'sudah' }),
    order({ id: 'kosong', finance: { lines: [], shipping: 0 } }),
    order({ id: 'baru', createdAt: 2_000 }),
    order({ id: 'lama', createdAt: 1_000 }),
  ], ledger);

  assert.deepEqual(queue.map((o) => o.id), ['lama', 'baru'], 'urut dari yang paling lama');
  for (const stage of queue.map((o) => o.stage)) assert.ok(POSTABLE_STAGES.has(stage));
});

test('a dry run builds the payload and posts nothing', async () => {
  const result = await postOrder(order(), { dryRun: true, depositTo: 'Cash' });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.total, 505_000);
  assert.equal(result.payload.sales_invoice.custom_id, 'TRL-shopee-260911QF5PA82R');
});

test('a bad order fails alone instead of throwing the batch away', async () => {
  const result = await postOrder(order({ finance: { lines: [], shipping: 0 } }), { dryRun: true });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /tidak ada baris produk/);
});

test('the read-only brake stops a live post before any request is built', async () => {
  const before = process.env.TREELOGY_READONLY;
  process.env.TREELOGY_READONLY = '1';
  try {
    await assert.rejects(() => postOrder(order(), { dryRun: false }), /ReadOnly|hanya-baca|read-only/i);
  } finally {
    if (before === undefined) delete process.env.TREELOGY_READONLY;
    else process.env.TREELOGY_READONLY = before;
  }
});

/* ----------------------------------------------------------- order-code prefixes */

const { orderCode, orderPrefix, shopifyPrefix, termDaysFor, PREFIXES } = await import('../src/mekari/prefix.js');

test('each channel gets the prefix the business already uses for it', () => {
  assert.equal(orderCode({ channel: 'shopee', id: '260911QF5PA82R' }), 'SP-260911QF5PA82R');
  assert.equal(orderCode({ channel: 'tokopedia', id: '586012744627029642' }), 'TP-586012744627029642');
  assert.equal(orderCode({ channel: 'tiktok_shop', id: '586012445975348822' }), 'TT-586012445975348822');
});

test("Shopify's prefix follows how the buyer paid", () => {
  // The live shop reports the gateway by display name, and 599 of its last 600 orders
  // say exactly this - including the "(New)" a merchant can rename away at any time.
  assert.equal(shopifyPrefix(['Xendit Payment Gateway (New)']), 'WA');
  assert.equal(shopifyPrefix(['Xendit']), 'WA');
  assert.equal(shopifyPrefix(['shopify_payments']), 'WX');
  assert.equal(shopifyPrefix(['Shopify Payments']), 'WX');
  // A recognised gateway wins over an unrecognised one listed alongside it.
  assert.equal(shopifyPrefix(['manual', 'Xendit Payment Gateway (New)']), 'WA');
  // Detection that cannot tell falls back rather than guessing.
  assert.equal(shopifyPrefix([]), 'SHF');
  assert.equal(shopifyPrefix(['sesuatu yang lain']), 'SHF');
  assert.equal(shopifyPrefix(undefined ?? []), 'SHF');
});

test('the hash in a Shopify order name is dropped, not doubled up', () => {
  assert.equal(orderCode({ channel: 'shopify', id: '#10848', gateways: ['Xendit Payment Gateway (New)'] }), 'WA-10848');
  assert.equal(orderCode({ channel: 'shopify', id: '10848', gateways: ['shopify_payments'] }), 'WX-10848');
});

test('an unknown channel is labelled, never left bare', () => {
  assert.equal(orderPrefix({ channel: 'entah' }), 'SHF');
  assert.match(orderCode({ channel: 'entah', id: 'Z1' }), /^SHF-Z1$/);
});

test('the prefix goes in reference_no, never in the idempotency key', () => {
  // A Shopify prefix depends on gateway detection. If it leaked into custom_id, a
  // detection that failed once and succeeded later would post the same sale twice.
  const base = { ...order({ channel: 'shopify', id: '#10848' }), gateways: ['Xendit Payment Gateway (New)'] };
  const detected = buildInvoice({ order: base });
  const failed = buildInvoice({ order: { ...base, gateways: [] } });

  assert.equal(detected.sales_invoice.reference_no, 'WA-10848');
  assert.equal(failed.sales_invoice.reference_no, 'SHF-10848');
  assert.equal(detected.sales_invoice.custom_id, failed.sales_invoice.custom_id,
    'kunci idempotensi berubah saat deteksi gateway gagal');
});

test('the memo carries the prefixed code too, so a search finds it either way', () => {
  const { sales_invoice: invoice } = buildInvoice({ order: order() });
  assert.match(invoice.memo, /SP-260911QF5PA82R/);
});

test('payment terms are Net 14, except consignment at Net 7', () => {
  assert.equal(termDaysFor({ channel: 'shopee' }), 14);
  assert.equal(PREFIXES.CS.termDays, 7);
  for (const [code, meta] of Object.entries(PREFIXES)) {
    assert.ok(meta.termDays > 0, `${code} tanpa termin`);
    assert.ok(meta.label, `${code} tanpa arti`);
  }
});

test('due date is the transaction date plus the term, in WIB', () => {
  const { sales_invoice: invoice } = buildInvoice({
    order: order({ createdAt: Math.floor(Date.parse('2026-09-11T03:00:00Z') / 1000) }),
  });
  assert.equal(invoice.transaction_date, '2026-09-11');
  assert.equal(invoice.due_date, '2026-09-25');
});
