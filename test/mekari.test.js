import test from 'node:test';
import assert from 'node:assert/strict';

import { signRequest, httpDate } from '../src/mekari/client.js';
import {
  buildInvoice, verifyInvoice, customIdFor, jurnalDate, productNameFor, productCodeFor,
  InvoiceError, CUSTOMER_NAMES,
} from '../src/mekari/invoice.js';
import { postable, postOrder, POSTABLE_STAGES } from '../src/mekari/sync.js';

const order = (over = {}) => ({
  channel: 'shopee',
  id: '260911QF5PA82R',
  stage: 'to_ship',
  createdAt: 1_757_500_000,
  buyer: 'nurizaamelia',
  carrier: 'JNE Reguler',
  finance: { lines: [{ sku: 'OMO-30-001', name: 'Moringa Seed Oil 30ml', qty: 1, unitPrice: 505_000, unitDiscount: 0 }], shipping: 0 },
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
  assert.equal(invoice.person_name, 'nurizaamelia', 'faktur atas nama pembelinya');
  assert.equal(invoice.term_name, 'Net 14');
  assert.equal(invoice.reference_no, 'SP-260911QF5PA82R');
  assert.ok(invoice.due_date > invoice.transaction_date, 'termin Net 14 harus menggeser jatuh tempo');
  assert.equal(invoice.ship_via, 'JNE Reguler');
  assert.equal(invoice.deposit, undefined, 'tanpa deposit_to faktur tetap terbuka');
});

test('a seller-funded discount reduces the line, quantity multiplies it', () => {
  const { sales_invoice: invoice, expectedTotal } = buildInvoice({
    order: order({ finance: { lines: [{ sku: 'OMO-30-001', qty: 3, unitPrice: 100_000, unitDiscount: 10_000 }], shipping: 15_000 } }),
  });
  assert.equal(expectedTotal, 3 * 90_000 + 15_000);
  assert.equal(verifyInvoice({ sales_invoice: invoice }, expectedTotal), 285_000);
});

test('deposit_to marks the invoice paid for the exact total', () => {
  const built = buildInvoice({ order: order({ finance: { lines: [{ sku: 'OMC-90-001', qty: 2, unitPrice: 50_000, unitDiscount: 0 }], shipping: 9_000 } }), depositTo: 'Cash' });
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
    { lines: [{ sku: 'OMP-45-001', qty: 0, unitPrice: 1000, unitDiscount: 0 }], shipping: 0 },
    { lines: [{ sku: 'OMP-45-001', qty: 1.5, unitPrice: 1000, unitDiscount: 0 }], shipping: 0 },
    { lines: [{ sku: 'OMP-45-001', qty: 1, unitPrice: -1, unitDiscount: 0 }], shipping: 0 },
    { lines: [{ sku: 'OMP-45-001', qty: 1, unitPrice: 1000, unitDiscount: 2000 }], shipping: 0 },
    { lines: [{ sku: 'OMP-45-001', qty: 1, unitPrice: 1000, unitDiscount: 0 }], shipping: -5 },
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

const { orderCode, orderPrefix, shopifyPrefix, PREFIXES } = await import('../src/mekari/prefix.js');
const { SOURCES, termDaysFor, isAutoPaid, tagFor, receivableFor, uncoveredPrefixes } = await import('../src/mekari/sources.js');

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

test('the invoice is raised against the buyer, falling back to the channel', () => {
  assert.equal(buildInvoice({ order: order() }).sales_invoice.person_name, 'nurizaamelia');
  // A marketplace that discloses nothing usable still has to name somebody.
  assert.equal(buildInvoice({ order: order({ buyer: '' }) }).sales_invoice.person_name, CUSTOMER_NAMES.shopee);
  assert.equal(buildInvoice({ order: order({ buyer: '   ' }) }).sales_invoice.person_name, CUSTOMER_NAMES.shopee);
});

test('an email is sent only when there is one, never as an empty field', () => {
  assert.equal(buildInvoice({ order: order() }).sales_invoice.email, undefined);
  assert.equal(
    buildInvoice({ order: order({ buyerEmail: 'budi@contoh.id' }) }).sales_invoice.email,
    'budi@contoh.id',
  );
});

test('the term names one Jurnal actually holds, and agrees with the due date', () => {
  // Sending a due date with no matching term makes Jurnal show the invoice as "Custom"
  // with no term at all, which is what the books showed before this was added.
  const online = buildInvoice({ order: order() }).sales_invoice;
  assert.equal(online.term_name, 'Net 14');
  assert.equal(online.due_date, jurnalDate(order().createdAt + 14 * 24 * 3600));
});

test('a platform that already took the money gets Net 14; everything chased gets Net 7', () => {
  // The split is not about size or channel, it is about who is holding the money on the
  // day the invoice is raised.
  assert.equal(termDaysFor({ channel: 'shopee' }), 14);
  assert.equal(termDaysFor({ channel: 'tiktok_shop' }), 14);
  assert.equal(termDaysFor({ channel: 'shopify' }), 14);
  for (const prefix of ['CS', 'LB', 'DP', 'DW', 'WS']) {
    assert.equal(SOURCES[prefix].termDays, 7, prefix);
    assert.equal(SOURCES[prefix].autoPaid, false, prefix);
  }
  for (const prefix of ['SP', 'TP', 'TT', 'SHF', 'WA', 'WX']) {
    assert.equal(SOURCES[prefix].termDays, 14, prefix);
    assert.equal(SOURCES[prefix].autoPaid, true, prefix);
  }
});

test('every source names a receivable and a tag, and no prefix falls through', () => {
  // A prefix with no source silently books into the web shop's receivable, which is how a
  // wholesale sale ends up in the wrong account and balances anyway.
  assert.deepEqual(uncoveredPrefixes(), []);
  for (const [prefix, source] of Object.entries(SOURCES)) {
    assert.match(source.receivable, /^1(50[1-5])$/, prefix);
    assert.ok(source.tag, `${prefix} tanpa tag`);
    assert.ok(PREFIXES[prefix]?.label, `${prefix} tanpa arti`);
  }
});

test('the receivable follows the source the business asked for', () => {
  assert.equal(receivableFor({ channel: 'shopee' }), '1503');
  assert.equal(receivableFor({ channel: 'tokopedia' }), '1504');
  // TikTok Shop settles through Tokopedia's receivable and carries its tag: one API, one
  // entity, one number.
  assert.equal(receivableFor({ channel: 'tiktok_shop' }), '1504');
  assert.equal(tagFor({ channel: 'tiktok_shop' }), 'Tokopedia');
  assert.equal(receivableFor({ channel: 'shopify' }), '1505');
  // Wholesale and consignment share one receivable by decision, not by accident.
  assert.equal(SOURCES.WS.receivable, SOURCES.CS.receivable);
  // WhatsApp, La Brisa and a walk-in are all the general consumer.
  for (const prefix of ['DP', 'LB', 'DW']) assert.equal(SOURCES[prefix].receivable, '1502', prefix);
});

test('due date is the transaction date plus the term, in WIB', () => {
  const { sales_invoice: invoice } = buildInvoice({
    order: order({ createdAt: Math.floor(Date.parse('2026-09-11T03:00:00Z') / 1000) }),
  });
  assert.equal(invoice.transaction_date, '2026-09-11');
  assert.equal(invoice.due_date, '2026-09-25');
});

/* ------------------------------------------------------- transaksi manual */

const { buildManualOrder, suggestCode, SOURCE_OPTIONS, SELLABLE } = await import('../src/mekari/manual.js');
const { manualCodes } = await import('../src/mekari/sync.js');

const manual = (over = {}) => ({
  source: 'CS', code: 'CS-260911-001', date: '2026-09-11', customer: 'Toko Sehat',
  shipping: 0, lines: [{ sku: 'OMP-45-001', qty: 2, unitPrice: 150_000, unitDiscount: 0 }],
  ...over,
});

test('a typed transaction becomes the same order shape as an online one', () => {
  const order = buildManualOrder(manual());
  assert.equal(order.channel, 'manual');
  assert.equal(order.id, 'CS-260911-001');
  assert.equal(order.stage, 'completed');
  assert.equal(order.customer, 'Toko Sehat');
  assert.equal(order.total, 300_000);
  assert.equal(order.finance.lines[0].name, 'Moringa Powder - 45 gram', 'nama diambil dari data master');

  const built = buildInvoice({ order, depositTo: 'Cash' });
  assert.equal(verifyInvoice(built, built.expectedTotal), 300_000);
  assert.equal(built.sales_invoice.reference_no, 'CS-260911-001', 'kode tidak boleh diberi prefiks dua kali');
  assert.equal(built.sales_invoice.custom_id, 'TRL-manual-CS-260911-001');
  assert.equal(built.sales_invoice.person_name, 'Toko Sehat');
  assert.equal(built.sales_invoice.due_date, '2026-09-18', 'consignment Net 7');
});

test('without a customer the source itself is the customer', () => {
  const built = buildInvoice({ order: buildManualOrder(manual({ customer: '' })) });
  assert.equal(built.sales_invoice.person_name, 'Consignment');
});

test('the note reaches the invoice memo', () => {
  const built = buildInvoice({ order: buildManualOrder(manual({ note: 'titip di toko A' })) });
  assert.match(built.sales_invoice.memo, /titip di toko A/);
});

test('every online prefix is refused as a manual source', () => {
  for (const source of ['SP', 'TP', 'TT', 'SHF', 'WA', 'WX', '', 'ZZ']) {
    assert.throws(() => buildManualOrder(manual({ source, code: `${source}-260911-001` })), InvoiceError, source);
  }
});

test('a code that does not match its source is refused', () => {
  assert.throws(() => buildManualOrder(manual({ source: 'CS', code: 'DW-260911-001' })), /tidak cocok/);
  assert.throws(() => buildManualOrder(manual({ code: 'sembarangan' })), /tidak berbentuk/);
  assert.throws(() => buildManualOrder(manual({ code: '' })), /tidak berbentuk/);
});

test('a transaction cannot be dated into the future', () => {
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  assert.throws(() => buildManualOrder(manual({ date: tomorrow })), /masa depan/);
  assert.throws(() => buildManualOrder(manual({ date: '2026-02-31' })), /tanggal tidak valid/);
  assert.throws(() => buildManualOrder(manual({ date: '' })), /tanggal tidak valid/);
});

test('money that is not money never becomes a line', () => {
  const bad = [
    { lines: [] },
    { lines: [{ sku: 'tidak-ada', qty: 1, unitPrice: 1000 }] },
    { lines: [{ sku: 'OMP-45-001', qty: 0, unitPrice: 1000 }] },
    { lines: [{ sku: 'OMP-45-001', qty: 1.5, unitPrice: 1000 }] },
    { lines: [{ sku: 'OMP-45-001', qty: 1, unitPrice: 1000.5 }] },
    { lines: [{ sku: 'OMP-45-001', qty: 1, unitPrice: -1 }] },
    { lines: [{ sku: 'OMP-45-001', qty: 1, unitPrice: 'abc' }] },
    { lines: [{ sku: 'OMP-45-001', qty: 1, unitPrice: 1000, unitDiscount: 2000 }] },
    { shipping: -1 },
    { shipping: 'gratis' },
  ];
  for (const over of bad) {
    assert.throws(() => buildManualOrder(manual(over)), InvoiceError, JSON.stringify(over));
  }
});

test('a blank row is dropped rather than failing the whole entry', () => {
  // The form always leaves an empty row at the bottom; submitting with it there is normal.
  const order = buildManualOrder(manual({
    lines: [{ sku: 'OMP-45-001', qty: 1, unitPrice: 100_000 }, { sku: '', qty: 1, unitPrice: 0 }],
  }));
  assert.equal(order.finance.lines.length, 1);
});

test('a suggested code never collides with one already used', () => {
  const now = Date.parse('2026-09-11T05:00:00Z');
  assert.equal(suggestCode('CS', [], now), 'CS-260911-001');
  assert.equal(suggestCode('CS', ['CS-260911-001', 'CS-260911-002'], now), 'CS-260911-003');
  // Another source's codes, and another day's, are none of this one's business.
  assert.equal(suggestCode('DW', ['CS-260911-009'], now), 'DW-260911-001');
  assert.equal(suggestCode('CS', ['CS-260910-009'], now), 'CS-260911-001');
});

test('used codes are read back out of the ledger', () => {
  const ledger = { orders: { 'TRL-manual-CS-260911-001': {}, 'TRL-shopee-260911X': {} } };
  assert.deepEqual(manualCodes(ledger), ['CS-260911-001']);
});

test('the form is offered exactly the five offline sources and real SKUs', () => {
  assert.deepEqual(SOURCE_OPTIONS.map((o) => o.prefix), ['CS', 'LB', 'DP', 'DW', 'WS']);
  for (const option of SOURCE_OPTIONS) assert.equal(option.termDays, 7, option.prefix);
  assert.ok(SELLABLE.length > 0);
  for (const product of SELLABLE) assert.ok(findProductForTest(product.sku), product.sku);
});

function findProductForTest(sku) {
  return SELLABLE.some((p) => p.sku === sku);
}

test('a line is matched on SKU, and an unknown SKU is stopped before the API sees it', () => {
  const { sales_invoice: invoice } = buildInvoice({ order: order() });
  const line = invoice.transaction_lines_attributes[0];
  // Matched on code, not name: a name edited inside Jurnal must not break later invoices.
  assert.equal(line.product_code, 'OMO-30-001');
  assert.equal(line.description, 'Moringa Seed Oil - 30 ml');
  assert.equal(line.product_name, undefined);

  // Jurnal rejects the whole invoice for an unknown product with an unexplained 422, so
  // it has to fail here instead, where it reads as one order to look at.
  assert.throws(
    () => buildInvoice({ order: order({ finance: { lines: [{ sku: 'tidak-ada', qty: 1, unitPrice: 1000, unitDiscount: 0 }], shipping: 0 } }) }),
    /tidak ada di data master/,
  );
});

test('every SKU that has ever sold is in the master catalogue', () => {
  // Two were missing and cost 86 orders their invoices before this was checked.
  for (const sku of ['The-Inside-&-Out30', 'The-Inside-&-Out60', 'The-Movement-&-Relief']) {
    assert.ok(productCodeFor({ sku }), sku);
  }
});


test('a line discount is folded into the rate, never sent as a field', () => {
  // Jurnal reads a line `discount` as a percentage. Sending Rp125,000 is rejected with
  // "Discount cannot exceed the total item amount" - confirmed twice against the live
  // account - and anything it did accept would be wrong by orders of magnitude.
  const built = buildInvoice({
    order: order({ finance: { lines: [{ sku: 'OMC-180-001', qty: 2, unitPrice: 970_000, unitDiscount: 125_000 }], shipping: 0 } }),
  });
  const line = built.sales_invoice.transaction_lines_attributes[0];
  assert.equal(line.discount, undefined, 'diskon per baris tidak boleh dikirim');
  assert.equal(line.rate, 845_000);
  assert.equal(built.expectedTotal, 1_690_000);
  assert.match(line.description, /disk\. 125\.000 dari 970\.000/, 'diskonnya tetap tercatat');
});

test('verification refuses a payload that still carries a line discount', () => {
  const built = buildInvoice({ order: order() });
  built.sales_invoice.transaction_lines_attributes[0].discount = 1;
  assert.throws(() => verifyInvoice(built, built.expectedTotal), /persen/);
});

test('postage is declared shipped, or it silently vanishes', () => {
  // Jurnal stores shipping_price as zero unless is_shipped is true. Five invoices went
  // into the books short by exactly the postage before this was caught.
  const withPostage = buildInvoice({
    order: order({ finance: { lines: [{ sku: 'OMC-90-001', qty: 1, unitPrice: 455_000, unitDiscount: 0 }], shipping: 15_000 } }),
  });
  assert.equal(withPostage.sales_invoice.is_shipped, true);
  assert.equal(withPostage.expectedTotal, 470_000);

  // An order with nothing at all to say about delivery must not claim to have shipped.
  assert.equal(buildInvoice({ order: order({ carrier: '' }) }).sales_invoice.is_shipped, undefined);
  // ...but a delivery address alone is enough, because Jurnal drops it otherwise.
  assert.equal(buildInvoice({ order: order({ carrier: '', shipTo: 'Bali, ID' }) }).sales_invoice.is_shipped, true);

  withPostage.sales_invoice.is_shipped = false;
  assert.throws(() => verifyInvoice(withPostage, withPostage.expectedTotal), /is_shipped/);
});

test('buyer details are sent only when the platform actually disclosed them', () => {
  // An empty field in Jurnal is honest; a field filled with a placeholder is not.
  const bare = buildInvoice({ order: order() }).sales_invoice;
  assert.equal(bare.email, undefined);
  assert.equal(bare.shipping_address, undefined);
  assert.equal(bare.address, undefined);

  const full = buildInvoice({
    order: order({
      buyer: 'Edy Gautama',
      buyerEmail: 'edy@contoh.id',
      shipTo: 'Jalan Ngurah Rai, Karangasem, Bali, 80811, ID',
      billTo: 'Jalan Ngurah Rai, Karangasem, Bali, 80811, ID',
    }),
  }).sales_invoice;
  assert.equal(full.person_name, 'Edy Gautama');
  assert.equal(full.email, 'edy@contoh.id');
  assert.equal(full.shipping_address, 'Jalan Ngurah Rai, Karangasem, Bali, 80811, ID');
  assert.equal(full.address, full.shipping_address);
});

test('a shipping address stands in for a missing billing address', () => {
  const invoice = buildInvoice({ order: order({ shipTo: 'Bali, ID', billTo: '' }) }).sales_invoice;
  assert.equal(invoice.address, 'Bali, ID');
});

test('a transient failure is deferred, a real one is failed', async () => {
  const { isTransient } = await import('../src/mekari/sync.js');
  const { MekariError } = await import('../src/mekari/client.js');
  // Not now: the next sweep takes these again, nobody needs waking.
  assert.equal(isTransient(new MekariError('x', { status: 429 })), true);
  assert.equal(isTransient(new MekariError('x', { status: 503 })), true);
  assert.equal(isTransient(new MekariError('tidak terjangkau: fetch failed')), true);
  assert.equal(isTransient(new MekariError('POST -> HTTP 429, tenggat habis sebelum bisa dicoba lagi', { status: 429 })), true);
  // Not like this: Jurnal rejected the content, and retrying cannot change that.
  assert.equal(isTransient(new MekariError('HTTP 422: product not available', { status: 422 })), false);
  assert.equal(isTransient(new MekariError('HTTP 409', { status: 409 })), false);
  assert.equal(isTransient(new Error('SKU tidak ada di data master')), false);
});

/* ------------------------------------------------------------- kuota & 409 */

test('the request budget stops before the fortieth call, and a 429 opens a cool-down', async () => {
  const { budgetWaitMs, noteRateLimited, resetBudget, REQUESTS_PER_MINUTE } = await import('../src/mekari/client.js');
  resetBudget();
  // Measured live: 40 unpaced requests went through, then everything was 429 for the rest
  // of the minute. The budget keeps a margin under that for webhooks on other instances.
  assert.ok(REQUESTS_PER_MINUTE < 40);
  assert.equal(budgetWaitMs(1_000_000), 0);
  resetBudget();
  noteRateLimited(2_000_000);
  assert.ok(budgetWaitMs(2_000_100) > 59_000, 'setelah 429 seluruh proses menunggu jendela berikutnya');
  assert.equal(budgetWaitMs(2_061_000), 0, 'dan jendela itu berlalu');
  resetBudget();
});

test('a duplicate invoice is an "exists" with the id Jurnal returned, never a failure', async () => {
  // Live 409 body: {"custom_id":"(Custom id attribute had already been used.)","id":1967902018,...}
  // A concurrent webhook or an earlier run simply got there first.
  const { MekariError } = await import('../src/mekari/client.js');
  const { isTransient } = await import('../src/mekari/sync.js');
  const dup = new MekariError('POST -> HTTP 409', { status: 409, body: { id: 1967902018, custom_id: '(Custom id attribute had already been used.)' } });
  assert.equal(isTransient(dup), false, '409 bukan sementara, tapi juga bukan gagal - ditangani terpisah');
  assert.equal(dup.body.id, 1967902018);
});

test('the Shopify subscription is paid-only; create is retired, not merely unused', async () => {
  const { SHOPIFY_TOPICS, SHOPIFY_RETIRED_TOPICS } = await import('../src/webhooks/register.js');
  assert.deepEqual(SHOPIFY_TOPICS, ['ORDERS_PAID']);
  assert.deepEqual(SHOPIFY_RETIRED_TOPICS, ['ORDERS_CREATE']);
});

/* ------------------------------------------------------- pembatalan & verifikasi */

const { undoneCandidates, voidInvoice, VOID_STATUSES, UNDONE_STAGES, syncOverview: overviewOf } = await import('../src/mekari/sync.js');

test('only an invoiced order that has since been undone is a candidate', () => {
  const ledger = { orders: {
    'TRL-shopee-A': { invoice_id: 1 },
    'TRL-shopee-B': { invoice_id: 2, voided: true },
    'TRL-shopee-C': { invoice_id: 3, needs_review: 'x' },
    'TRL-shopee-D': { invoice_id: null },
  } };
  const orders = [
    order({ id: 'A', stage: 'cancelled', status: 'CANCELLED' }),   // yes
    order({ id: 'B', stage: 'cancelled', status: 'CANCELLED' }),   // already voided
    order({ id: 'C', stage: 'returned', status: 'TO_RETURN' }),    // already with a person
    order({ id: 'D', stage: 'cancelled', status: 'CANCELLED' }),   // never had an invoice
    order({ id: 'E', stage: 'cancelled', status: 'CANCELLED' }),   // never in the ledger
    order({ id: 'A2', stage: 'completed' }),                        // not undone
  ];
  assert.deepEqual(undoneCandidates(orders, ledger).map((o) => o.id), ['A']);
});

test('a cancellation request or a return in progress is handed to a person, not acted on', async () => {
  // IN_CANCEL can still be refused by the seller; TO_RETURN is a dispute. Deleting the
  // invoice on either would be deleting a sale that may yet stand.
  assert.ok(VOID_STATUSES.has('CANCELLED'));
  assert.ok(!VOID_STATUSES.has('IN_CANCEL'));
  assert.deepEqual([...UNDONE_STAGES].sort(), ['cancelled', 'returned']);

  const asked = await voidInvoice(order({ stage: 'cancelled', status: 'IN_CANCEL' }), { invoice_id: 9 }, { dryRun: true });
  assert.equal(asked.outcome, 'needs_review');
  const returned = await voidInvoice(order({ stage: 'returned', status: 'TO_RETURN' }), { invoice_id: 9 }, { dryRun: true });
  assert.equal(returned.outcome, 'needs_review');
  // A final cancellation would be acted on - and a dry run says so without touching Jurnal.
  const final = await voidInvoice(order({ stage: 'cancelled', status: 'CANCELLED' }), { invoice_id: 9 }, { dryRun: true });
  assert.equal(final.outcome, 'dry-run');
  const shopify = await voidInvoice({ channel: 'shopify', id: '#1', stage: 'cancelled', status: 'VOIDED/UNFULFILLED' }, { invoice_id: 9 }, { dryRun: true });
  assert.equal(shopify.outcome, 'dry-run');
});

test('the Jurnal tab shows a wrong number, a voided sale and a review case for what they are', () => {
  const ledger = { orders: {
    'TRL-shopee-M': { invoice_id: 1, total: 100, mismatch: true, stored: 85 },
    'TRL-shopee-V': { invoice_id: 2, total: 100, voided: true },
    'TRL-shopee-R': { invoice_id: 3, total: 100, needs_review: 'faktur sudah menerima pembayaran' },
  } };
  const ov = overviewOf({ orders: [order({ id: 'M' }), order({ id: 'V', stage: 'cancelled' }), order({ id: 'R', stage: 'returned' })], ledger });
  const by = Object.fromEntries(ov.rows.map((r) => [r.order.id, r]));
  assert.equal(by.M.state, 'broken'); assert.match(by.M.reason, /85/);
  assert.equal(by.V.state, 'skipped'); assert.match(by.V.reason, /dihapus/);
  assert.equal(by.R.state, 'broken'); assert.match(by.R.reason, /pembayaran/);
  assert.equal(ov.synced, 0, 'tidak satu pun boleh mengaku tersinkron rapi');
});

test('readiness proven within a day is not proven again', async () => {
  const { ensureReady } = await import('../src/mekari/setup.js');
  const fresh = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const result = await ensureReady({ dryRun: false, readyAt: fresh });
  assert.equal(result.skipped, 'sudah dipastikan dalam 24 jam terakhir');
});

/* ------------------------------------------------- per-source booking policy */

const { jurnalDateToIso } = await import('../src/mekari/rebuild.js');

test('Jurnal dates are read day-first, because Date.parse reads them month-first', () => {
  // 09/11/2026 is 9 November in Jurnal and 11 September to Date.parse. A walk that stops
  // at a date would have stopped on the wrong page for most of the year.
  assert.equal(jurnalDateToIso('09/11/2026'), '2026-11-09');
  assert.equal(jurnalDateToIso('15/09/2026'), '2026-09-15');
  assert.equal(jurnalDateToIso('2026-09-15'), null);
  assert.equal(jurnalDateToIso(''), null);
});

test('an invoice carries its source tag, and refuses to exist without one', () => {
  const online = buildInvoice({ order: order() });
  assert.deepEqual(online.sales_invoice.tags, ['Shopee']);
  verifyInvoice(online, online.expectedTotal);

  // The tag is the only thing that makes one receivable readable back by channel, so a
  // missing one is a sale that vanishes from the report the business actually opens.
  const untagged = { sales_invoice: { ...online.sales_invoice, tags: [] } };
  assert.throws(() => verifyInvoice(untagged, online.expectedTotal), /tanpa tag/);
});

test('only a platform that already took the money produces a paid invoice', () => {
  const paid = buildInvoice({ order: order(), depositTo: 'BCA' }).sales_invoice;
  assert.equal(paid.deposit_to_name, 'BCA');

  // A consignment shop pays later, by transfer. Marking it paid on the day it was raised
  // would empty the receivable that exists precisely so somebody can chase it.
  const manual = buildInvoice({
    order: { ...order(), channel: 'manual', id: 'CS-260901-001' },
    depositTo: 'BCA',
  }).sales_invoice;
  assert.equal(manual.deposit_to_name, undefined);
  assert.equal(manual.deposit, undefined);
  assert.equal(manual.term_name, 'Net 7');
  assert.deepEqual(manual.tags, ['Consignment']);
});
