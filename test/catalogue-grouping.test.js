import test from 'node:test';
import assert from 'node:assert/strict';
import { ours, duplicates } from '../src/mekari/catalogue.js';

/**
 * The two functions that decide which invoice is real, tested on the real exports.
 *
 * test/dedupe.test.js pins these properties against a *copy* of the grouping pasted into
 * the test file, so it would keep passing with src/mekari/catalogue.js deleted. These
 * exercise the shipped `ours()` and `duplicates()` themselves, and cover the three cases
 * the existing catalogue tests leave open: an invoice a person typed into Jurnal by hand,
 * ids where numeric and alphabetical order disagree, and whether the keeper the
 * deduplicator saves is the same row the reconciler considers canonical.
 *
 * All of it exists because of one afternoon: paging through the invoice list while
 * deleting from it shifted rows between pages, the same invoice came back twice, and
 * "delete the second copy" deleted the only one - about five hundred times.
 */

const row = (id, customId, extra = {}) => ({
  id,
  customId,
  no: `INV-${id}`,
  date: '2026-09-10',
  total: 100_000,
  remaining: 0,
  ...extra,
});

test('an invoice a person typed into Jurnal is never grouped and never dropped', () => {
  // Jurnal holds invoices this system did not write - opening balances, corrections, and
  // anything the bookkeeper raised by hand. Two of those sharing a custom_id is their
  // business, not ours, and the deduplicator deletes what it is given. The TRL- guard in
  // duplicates() is the only thing between a hand-written pair and a DELETE.
  assert.deepEqual(duplicates([
    row(100, 'INV/2026/VIII/001'),
    row(200, 'INV/2026/VIII/001'),
    row(300, ''),
    row(400, ''),
  ]), [], 'faktur di luar sistem ini tidak boleh masuk daftar hapus');

  // And a real duplicate of ours in the same list is still found, so the guard is a
  // filter and not an early return.
  const found = duplicates([
    row(100, 'INV/2026/VIII/001'),
    row(200, 'INV/2026/VIII/001'),
    row(300, 'TRL-shopee-260915X'),
    row(400, 'TRL-shopee-260915X'),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].customId, 'TRL-shopee-260915X');
  assert.deepEqual(found[0].drop.map((d) => d.id), [400]);
});

test('the keeper is the lowest id by number, not the first read and not alphabetically', () => {
  // Jurnal's ids run past a thousand, where alphabetical and numeric order part company:
  // "1000" sorts before "900". A default .sort() or a string comparison would name the
  // newer invoice the keeper and delete the original - the one already referenced by a
  // payment, a delivery and whatever the seller has quoted to the buyer.
  const held = ours([row(1000, 'TRL-shopee-A'), row(900, 'TRL-shopee-A'), row(90, 'TRL-shopee-A')]);
  assert.equal(held.get('TRL-shopee-A').id, 90, 'faktur tertua yang disimpan, bukan yang urutan hurufnya terkecil');

  const [group] = duplicates([row(1000, 'TRL-shopee-A'), row(900, 'TRL-shopee-A'), row(90, 'TRL-shopee-A')]);
  assert.equal(group.keep.id, 90);
  assert.deepEqual(group.drop.map((d) => d.id), [900, 1000], 'yang dihapus urut dari yang paling tua');
});

test('ours() and duplicates() never disagree about which copy survives', () => {
  // Two functions, one decision. reconcile reads its canonical invoice out of ours() and
  // dedupe deletes everything duplicates() puts in `drop`; if they ever picked different
  // rows, the deduplicator would delete precisely the invoice the reconciler had just
  // matched an order against, and the order would read as uninvoiced forever after.
  const invoices = [
    row(4100, 'TRL-shopee-260915X'),
    row(300, 'TRL-shopee-260915X'),
    row(980, 'TRL-tiktok_shop-585123'),
    row(1200, 'TRL-tiktok_shop-585123'),
    row(1201, 'TRL-tiktok_shop-585123'),
    row(700, 'TRL-shopify-10892'),
  ];
  const held = ours(invoices);

  for (const group of duplicates(invoices)) {
    assert.equal(group.keep.id, held.get(group.customId).id, `beda pilihan untuk ${group.customId}`);
    for (const dropped of group.drop) {
      assert.notEqual(dropped.id, held.get(group.customId).id, 'yang disimpan ikut terhapus');
    }
  }
  // An order with exactly one invoice is not a duplicate group at all.
  assert.deepEqual(duplicates(invoices).map((g) => g.customId).sort(),
    ['TRL-shopee-260915X', 'TRL-tiktok_shop-585123']);
});

test('the same invoice read three times is still one invoice', () => {
  // A page size that steps down mid-scan restarts the walk from the top, and a list being
  // written to while it is read gives the same row back more than twice. Keyed by id, so
  // the count of copies makes no difference; keyed by anything else - an array, a Set of
  // row objects, object identity - and three reads read as two duplicates.
  assert.deepEqual(duplicates([
    row(100, 'TRL-shopee-A'),
    row(100, 'TRL-shopee-A'),
    row(100, 'TRL-shopee-A'),
  ]), [], 'satu faktur dibaca tiga kali bukan tiga faktur');

  // Two real invoices, each read twice: one keeper, one deletion, not three.
  const [group] = duplicates([
    row(100, 'TRL-shopee-A'), row(200, 'TRL-shopee-A'),
    row(100, 'TRL-shopee-A'), row(200, 'TRL-shopee-A'),
  ]);
  assert.equal(group.keep.id, 100);
  assert.deepEqual(group.drop.map((d) => d.id), [200]);
});

test('two different orders are never collapsed into one group', () => {
  // The grouping key is the whole custom_id. A prefix-only or truncated key would put
  // every Shopee order of a day in one group and delete all but the first.
  assert.deepEqual(duplicates([
    row(100, 'TRL-shopee-260915X'),
    row(200, 'TRL-shopee-260915Y'),
    row(300, 'TRL-shopee-260915Z'),
  ]), []);

  const held = ours([row(100, 'TRL-shopee-260915X'), row(200, 'TRL-shopee-260915Y')]);
  assert.equal(held.size, 2);
  assert.deepEqual([...held.keys()].sort(), ['TRL-shopee-260915X', 'TRL-shopee-260915Y']);
});

test('an invoice with no custom_id at all is ignored, not treated as a nameless order', () => {
  // Jurnal returns null for custom_id on anything raised in its own UI, and the scan
  // passes that through as ''. Grouped rather than skipped, every one of them would share
  // the empty key and all but the oldest would be queued for deletion.
  const invoices = [
    row(100, undefined),
    row(200, null),
    row(300, ''),
    row(400, 'TRL-shopee-A'),
  ];
  assert.equal(ours(invoices).size, 1, 'hanya faktur bertanda TRL- yang diakui milik sistem ini');
  assert.deepEqual(duplicates(invoices), []);
});

test('the TRL- mark is read at the start of the id, not anywhere inside it', () => {
  // A hand-written invoice whose memo or number happens to mention one of ours must not
  // be adopted by this system on the strength of a substring.
  assert.equal(ours([row(100, 'lihat-TRL-shopee-A')]).size, 0, 'TRL- di tengah bukan milik kita');
  assert.equal(ours([row(100, 'TRL-shopee-A')]).size, 1);
});
