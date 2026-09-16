import test from 'node:test';
import assert from 'node:assert/strict';
import { PREFIXES, MANUAL_SOURCES, orderPrefix, orderCode, shopifyPrefix, isManualSource } from '../src/mekari/prefix.js';
import { SOURCES, sourceOf } from '../src/mekari/sources.js';
import { customIdFor } from '../src/mekari/invoice.js';

/**
 * The order code an accountant reads, and the two things it must never do.
 *
 * test/mekari.test.js covers the four marketplace channels and the ordinary Shopify
 * gateways. These fill in what it does not: the typed-in branch, which decides how a
 * consignment or walk-in sale is booked; the order in which several gateways are
 * considered, which decides which half of the web shop a sale lands in; and the '#' in a
 * Shopify order name, which broke idempotency once already.
 */

/* ------------------------------------------------------- a sale somebody typed in */

test('a typed-in sale keeps the code the person entered, with nothing added to it', () => {
  // The prefix is already inside a manual code - that is what the person chose when they
  // entered it. Sending it through the generic path would write CS-CS-260916-001 into
  // reference_no and into the memo, on every consignment invoice.
  assert.equal(orderCode({ channel: 'manual', id: 'CS-260916-001' }), 'CS-260916-001');
  assert.equal(orderCode({ channel: 'manual', id: 'DW-260916-002' }), 'DW-260916-002');
  assert.equal(orderPrefix({ channel: 'manual', id: 'CS-260916-001' }), 'CS');
});

test('every manual source is recognised from its own code, and booked as chased money', () => {
  // The whole reason the manual branch exists. If the prefix stopped being read out of the
  // code, orderPrefix falls back to SHF - and a consignment sale would be booked into the
  // web shop's receivable on Net 14 and marked as money already received. It is not: that
  // invoice is open precisely because the shop has not paid yet.
  for (const prefix of MANUAL_SOURCES) {
    const order = { channel: 'manual', id: `${prefix}-260916-001` };
    assert.equal(orderPrefix(order), prefix);
    assert.equal(sourceOf(order), SOURCES[prefix], `${prefix} tidak terbaca dari kodenya sendiri`);
    assert.equal(sourceOf(order).autoPaid, false, `${prefix} belum dibayar siapa pun`);
    assert.equal(sourceOf(order).termDays, 7, `${prefix} ditagih, jadi jatuh tempo seminggu`);
    assert.ok(isManualSource(prefix));
  }
});

test('the prefix is read up to the first dash, so the date in the code is not part of it', () => {
  // Codes are PREFIX-YYMMDD-NNN. Splitting on the wrong separator, or taking a fixed
  // number of characters, would produce "CS-260916" or "C" - neither of which is a source,
  // so both fall through to the web shop.
  assert.equal(orderPrefix({ channel: 'manual', id: 'LB-260916-001' }), 'LB');
  assert.equal(orderPrefix({ channel: 'manual', id: 'WS-261231-999' }), 'WS');
  // A code with no dash at all cannot come from buildManualOrder - it validates the shape -
  // but nothing here may throw on one.
  assert.doesNotThrow(() => orderPrefix({ channel: 'manual', id: 'CS' }));
  assert.equal(orderPrefix({ channel: 'manual' }), 'SHF', 'tanpa kode, tidak ada yang bisa dibaca');
});

/* ------------------------------------------- which gateway paid for a Shopify order */

test('the first gateway the order lists that we recognise is the one that counts', () => {
  // Shopify can report several gateways on one order. The loop walks the order's own list
  // and takes the first entry that matches anything - not the first *pattern* that matches
  // anything. Invert those two loops and every order that mentions Xendit anywhere becomes
  // WA, including the ones Shopify Payments actually settled, and the two halves of the web
  // shop stop adding up.
  assert.equal(shopifyPrefix(['shopify_payments', 'Xendit Payment Gateway (New)']), 'WX');
  assert.equal(shopifyPrefix(['Xendit Payment Gateway (New)', 'shopify_payments']), 'WA');
  // An unrecognised name does not consume the turn; the next one is still considered.
  assert.equal(shopifyPrefix(['manual', 'gift_card', 'shopify_payments']), 'WX');
});

test('the gateway is matched by pattern, because its display name is the merchant\'s to rename', () => {
  // The live shop currently says "Xendit Payment Gateway (New)". The "(New)" is exactly
  // the kind of thing that disappears one afternoon, and an exact-string match would take
  // every Shopify order to SHF the moment it did.
  for (const name of ['Xendit', 'XENDIT', 'Xendit Payment Gateway (New)', 'xendit payment gateway']) {
    assert.equal(shopifyPrefix([name]), 'WA', name);
  }
  for (const name of ['shopify_payments', 'Shopify Payments', 'shopify-payments', 'SHOPIFY PAYMENTS']) {
    assert.equal(shopifyPrefix([name]), 'WX', name);
  }
});

test('an unrecognised or unusable gateway is SHF, and never an exception', () => {
  // Detection that cannot tell must fall back, not throw: a gateway name is data from
  // outside, and one bad value would stop the whole sweep rather than one order.
  assert.equal(shopifyPrefix([]), 'SHF');
  assert.equal(shopifyPrefix(['paypal', 'cash_on_delivery']), 'SHF');
  assert.equal(shopifyPrefix([null, undefined, 123, {}]), 'SHF');
  assert.equal(orderPrefix({ channel: 'shopify', id: '#10848' }), 'SHF', 'tanpa daftar gateway pun tidak boleh gagal');
});

/* --------------------------------------------------- the '#' in a Shopify order name */

test("the '#' in a Shopify order name reaches neither the code nor the key", () => {
  // Jurnal cannot hold one. Proved live: invoices #13230 and #13231 both carried
  // custom_id "TRL-shopify-#10892" - the uniqueness constraint never fired - while GET on
  // that custom_id answered 404, so the lookup could not see either. Shopify was the one
  // channel with no duplicate protection at all.
  const order = { channel: 'shopify', id: '#10848', gateways: ['Xendit Payment Gateway (New)'] };
  assert.equal(orderCode(order), 'WA-10848');
  assert.ok(!orderCode(order).includes('#'), 'kode yang dibaca orang tidak boleh membawa #');
  assert.ok(!customIdFor(order).includes('#'), 'kunci idempotensi tidak boleh membawa #');
  // The same order name with the hash already gone must produce the same code, or the two
  // forms would read as two different orders.
  assert.equal(orderCode({ ...order, id: '10848' }), orderCode(order));
});

test('a hash is stripped whatever channel it arrives on', () => {
  // No other platform sends one today, but the stripping is not conditional on Shopify and
  // must not become so - a channel that starts sending one would silently get it back.
  assert.equal(orderCode({ channel: 'shopee', id: '#260911QF5PA82R' }), 'SP-260911QF5PA82R');
  assert.equal(orderCode({ channel: 'tokopedia', id: '#586012744627029642' }), 'TP-586012744627029642');
});

/* ----------------------------------------------------------------- the table itself */

test('every channel in the table maps back to a prefix that names that same channel', () => {
  // Derived rather than spelled out, so a channel added to PREFIXES but forgotten in the
  // channel lookup is caught here instead of in the books. A missed entry is not an error
  // anywhere - it falls through to SHF - so a TikTok sale would be tagged Website and
  // booked into the web shop's receivable, and balance perfectly while doing it.
  for (const [prefix, entry] of Object.entries(PREFIXES)) {
    if (!entry.channel) continue;
    const resolved = orderPrefix({ channel: entry.channel, id: 'X' });
    assert.ok(PREFIXES[resolved], `${prefix}: kanal ${entry.channel} memberi prefiks tak dikenal ${resolved}`);
    assert.equal(PREFIXES[resolved].channel, entry.channel,
      `kanal ${entry.channel} memberi prefiks ${resolved}, yang bukan kanal itu`);
  }
  // A channel nobody has heard of is labelled rather than left bare.
  for (const channel of ['lazada', '', null, undefined]) {
    assert.equal(orderPrefix({ channel, id: 'X' }), 'SHF', String(channel));
  }
});

test('the codes on the two sides of a Shopify order differ, and only one of them is the key', () => {
  // The prefix depends on gateway detection, so it must never be part of the idempotency
  // key: a detection that failed once and succeeded the next time would change the key and
  // post the same sale a second time.
  const detected = { channel: 'shopify', id: '#10892', gateways: ['Xendit Payment Gateway (New)'] };
  const undetected = { ...detected, gateways: [] };
  assert.notEqual(orderCode(detected), orderCode(undetected));
  assert.equal(customIdFor(detected), customIdFor(undetected), 'kunci berubah saat deteksi gateway gagal');
});
