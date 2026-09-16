import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCES, RECEIVABLE_NUMBERS, TAGS, SHIPPING_ACCOUNT_NUMBER,
  sourceOf, tagFor, receivableFor, termDaysFor, isAutoPaid, uncoveredPrefixes,
  POOLING_NUMBERS, poolingFor,
} from '../src/mekari/sources.js';
import { PREFIXES } from '../src/mekari/prefix.js';

/**
 * The booking policy, checked as a policy rather than as a list of known rows.
 *
 * test/mekari.test.js asserts the term and the receivable for each prefix by name, which
 * catches a changed row but not an added one - a new source spelled into SOURCES with the
 * wrong half of the policy passes every existing test. These derive the split from the
 * table itself, so the eleventh source has to obey the same rule as the first ten.
 *
 * The rule, from Keputusan-Integrasi-Mekari-Jurnal.docx: a platform that collects the
 * money itself is invoiced and settled in the same breath, on Net 14. Everything invoiced
 * and then chased is Net 7 and stays open until somebody records the payment.
 */

const entries = Object.entries(SOURCES);

test('the whole table splits exactly two ways: taken at the till, or chased afterwards', () => {
  // Not a list of names - a rule. Auto-paid and Net 14 are the same decision seen from two
  // sides, and a row that says one but not the other is a row that either overstates
  // receivables for a fortnight or closes an invoice nobody paid.
  for (const [prefix, source] of entries) {
    assert.equal(source.termDays, source.autoPaid ? 14 : 7,
      `${prefix}: autoPaid=${source.autoPaid} tapi termin ${source.termDays} hari`);
    assert.equal(typeof source.autoPaid, 'boolean', `${prefix}: autoPaid harus boolean`);
  }
});

test('which sources are settled by the platform, named the way the business names them', () => {
  // Derived from the table, so adding a source puts its label in one of these two sets and
  // the test says which. Marketplaces and the web shop take the money before the parcel
  // ships; a consignment shop, a wholesale buyer, La Brisa, a WhatsApp order and a walk-in
  // all pay later, and their invoices are the only prompt anybody has to chase them.
  const labels = (wanted) => [...new Set(entries.filter(([, s]) => s.autoPaid === wanted).map(([, s]) => s.label))].sort();

  assert.deepEqual(labels(true), ['Shopee', 'TikTok Shop', 'Tokopedia', 'Website']);
  assert.deepEqual(labels(false), ['Consignment', 'La Brisa', 'Walk in', 'WhatsApp', 'Wholesale']);
});

test('money already taken and money still owed never share a receivable', () => {
  // The receivable is how the books are read back by source. If a chased source shared an
  // account with a settled one, the balance in that account would no longer mean "owed to
  // us" and the ageing report built on it would be meaningless.
  const settled = new Set(entries.filter(([, s]) => s.autoPaid).map(([, s]) => s.receivable));
  const chased = new Set(entries.filter(([, s]) => !s.autoPaid).map(([, s]) => s.receivable));
  for (const number of settled) {
    assert.ok(!chased.has(number), `akun ${number} dipakai untuk dua perlakuan sekaligus`);
  }
  assert.deepEqual([...settled].sort(), ['1503', '1504', '1505']);
  assert.deepEqual([...chased].sort(), ['1501', '1502']);
});

test('the setup check knows about every account this system will book into', () => {
  // accounts.js verifies exactly this list exists in Jurnal before anything is posted. An
  // account missing from it is an account nobody checks, and the first invoice that needs
  // it fails as an unexplained 422 in the middle of a sweep.
  assert.deepEqual(RECEIVABLE_NUMBERS, ['1501', '1502', '1503', '1504', '1505']);
  assert.equal(RECEIVABLE_NUMBERS.length, new Set(RECEIVABLE_NUMBERS).size, 'tidak boleh ada yang dobel');
  for (const [prefix, source] of entries) {
    assert.ok(RECEIVABLE_NUMBERS.includes(source.receivable), `${prefix}: akun ${source.receivable} tidak diperiksa saat setup`);
  }
});

test('the setup check knows about every tag this system will write', () => {
  // Every invoice carries its source's tag, written at creation rather than typed in
  // afterwards - a tag that depends on somebody remembering is right for a fortnight and
  // then silently is not. coa.js creates whatever is in this list before the first sweep;
  // a tag missing from it is one Jurnal has never heard of.
  assert.deepEqual(TAGS, ['Consignment', 'La Brisa', 'Shopee', 'Tokopedia', 'Walk in', 'Website', 'Whatsapp', 'Wholesale']);
  for (const [prefix, source] of entries) {
    assert.ok(TAGS.includes(source.tag), `${prefix}: tag "${source.tag}" tidak pernah dibuat di Jurnal`);
    assert.equal(source.tag, source.tag.trim(), `${prefix}: tag berspasi tidak akan cocok dengan yang ada di Jurnal`);
    assert.ok(source.tag.length > 0, `${prefix}: tag kosong`);
  }
});

test('TikTok Shop is booked as Tokopedia, on purpose and in both places', () => {
  // One API, one entity, one receivable - decided, not inherited. Splitting them later is
  // a decision somebody makes; splitting them by accident here would leave two months of
  // TikTok revenue in an account the seller never opens.
  assert.equal(SOURCES.TT.receivable, SOURCES.TP.receivable);
  assert.equal(SOURCES.TT.tag, SOURCES.TP.tag);
  assert.equal(SOURCES.TT.label, 'TikTok Shop', 'labelnya tetap sendiri - yang disatukan hanya akun dan tag');
  // Wholesale and consignment share theirs by the same kind of decision.
  assert.equal(SOURCES.WS.receivable, SOURCES.CS.receivable);
  assert.notEqual(SOURCES.WS.tag, SOURCES.CS.tag, 'satu akun, tetapi masih bisa dibaca terpisah lewat tag');
});

test('the three Shopify prefixes are one source wearing three names', () => {
  // SHF, WA and WX differ only in how the buyer paid, which is a fact about the payment
  // and not about the shop. If they ever pointed at different receivables, the web shop's
  // balance would depend on gateway detection - which is a guess, and falls back to SHF.
  for (const prefix of ['SHF', 'WA', 'WX']) {
    assert.equal(SOURCES[prefix].receivable, '1505', prefix);
    assert.equal(SOURCES[prefix].tag, 'Website', prefix);
    assert.equal(SOURCES[prefix].termDays, 14, prefix);
    assert.equal(SOURCES[prefix].autoPaid, true, prefix);
  }
});

test('no prefix falls through the table in either direction', () => {
  // A prefix with no source is booked as the web shop, silently and correctly-looking. A
  // source with no prefix is a row nothing can ever reach.
  assert.deepEqual(uncoveredPrefixes(), [], 'ada prefiks tanpa sumber');
  assert.deepEqual(Object.keys(SOURCES).filter((p) => !PREFIXES[p]), [], 'ada sumber tanpa prefiks');
});

test('an order nobody can classify is still booked, and always the same way', () => {
  // The only place in this system that guesses. It has to return something - stopping a
  // sweep over one unclassifiable order would be worse than booking it as the commonest
  // case - but it must be the *same* something every time, or a retry would move a sale
  // between accounts.
  for (const order of [{ channel: 'lazada' }, { channel: '' }, {}, { channel: null }]) {
    assert.equal(sourceOf(order), SOURCES.SHF, JSON.stringify(order));
    assert.equal(tagFor(order), 'Website');
    assert.equal(receivableFor(order), '1505');
    assert.equal(termDaysFor(order), 14);
    assert.equal(isAutoPaid(order), true);
  }
});

test('postage is booked to Other Income, and deliberately not to 5030', () => {
  // The business asked for 5030 Delivery to Customer and it cannot be had: the account a
  // sales invoice credits for postage is a company-level mapping, that mapping is not
  // writable through the API - PATCH answers 400 even when setting the value it already
  // holds - and in the UI Jurnal will only offer income accounts, which 5030 is not.
  // Changing this back would make every invoice carrying postage fail.
  //
  // '7099', not '7-70099'. Jurnal numbers its other Other Income accounts 7-70000 upward,
  // which is what the wrong value was copied from, but the shipping one is plain 7099 -
  // read back from the live chart, where the wrong number matched nothing at all.
  assert.equal(SHIPPING_ACCOUNT_NUMBER, '7099');
  assert.notEqual(SHIPPING_ACCOUNT_NUMBER, '5030');
  assert.ok(!RECEIVABLE_NUMBERS.includes(SHIPPING_ACCOUNT_NUMBER), 'ongkir bukan piutang');
});

test('each channel settles into its own pooling account, and TikTok shares Tokopedia\'s', () => {
  // The account is read from the order, not from configuration, so a Shopee sale can never
  // be deposited into the website's account - which one shared deposit account made
  // impossible to even express, let alone catch.
  const sale = (channel, id) => ({
    channel, id, stage: 'to_ship', createdAt: 1_757_500_000,
    finance: { lines: [{ sku: 'OMO-30-001', name: 'Moringa Seed Oil 30ml', qty: 1, unitPrice: 100_000, unitDiscount: 0 }], shipping: 0 },
  });
  assert.equal(poolingFor(sale('shopee', '2609140FJEFCSW')), '1111');
  assert.equal(poolingFor(sale('tokopedia', '585859894801303056')), '1112');
  assert.equal(poolingFor(sale('tiktok_shop', '577000000000000000')), '1112',
    'TikTok Shop settles through the same entity as Tokopedia, by decision');
  assert.equal(poolingFor(sale('shopify', '10899')), '1113');
});

test('a source somebody has to chase has no pooling account at all', () => {
  // Nothing has been received, so there is nowhere for it to wait. An account here would
  // book money the business does not have.
  for (const prefix of ['CS', 'WS', 'LB', 'DP', 'DW']) {
    assert.equal(SOURCES[prefix].pooling, null, `${prefix} tidak boleh punya akun penampung`);
    assert.equal(SOURCES[prefix].autoPaid, false);
  }
});

test('every pooling account a source names is one the system checks for', () => {
  // requiredAccounts is what fails loudly when an account is missing from Jurnal; a
  // pooling account left out of that list would fail silently as an invoice raised open.
  for (const source of Object.values(SOURCES)) {
    if (source.pooling) assert.ok(POOLING_NUMBERS.includes(source.pooling));
  }
});
