import test from 'node:test';
import assert from 'node:assert/strict';
import { ours, duplicates, PAGE_SIZES, TTL_MS } from '../src/mekari/catalogue.js';

/**
 * One reading of Jurnal's invoice list, shared.
 *
 * Four modules used to walk the same thirteen hundred rows independently - reconcile,
 * dedupe, settle and rebuild - so a recovery run spent around a hundred requests learning
 * one set of facts, out of ninety a minute that the sweep and the webhooks also spend.
 */

const row = (id, customId, extra = {}) => ({ id, customId, no: String(id), date: '2026-09-10', total: 100, remaining: 0, ...extra });

test('only our own invoices are returned, and the oldest copy wins', () => {
  const held = ours([
    row(300, 'TRL-shopee-A'),
    row(100, 'TRL-shopee-A'),
    row(200, 'TRL-shopee-B'),
    row(400, 'INV-dibuat-manusia'),
  ]);
  assert.equal(held.size, 2, 'faktur yang diketik orang bukan urusan kita');
  assert.equal(held.get('TRL-shopee-A').id, 100, 'yang tertua - itu yang mungkin sudah dirujuk');
  assert.equal(held.get('TRL-shopee-B').id, 200);
});

test('an invoice read twice is not its own duplicate', () => {
  // Pagination over a list that is being deleted from shifts rows, so the same invoice
  // comes back on two pages. Collected into a list that reads as two copies, and deleting
  // "the second" deletes the only one - about five hundred went that way once.
  assert.deepEqual(duplicates([row(100, 'TRL-shopee-A'), row(100, 'TRL-shopee-A')]), []);

  const [group] = duplicates([row(200, 'TRL-shopee-A'), row(100, 'TRL-shopee-A'), row(100, 'TRL-shopee-A')]);
  assert.equal(group.keep.id, 100);
  assert.deepEqual(group.drop.map((d) => d.id), [200]);
});

test('page sizes step down, never up, and start at the cheapest', () => {
  // A hundred rows is one large query that on a bad day outlived our thirty-second
  // deadline and failed the whole scan. Asking large first and stepping down only on a
  // real failure gets half the requests on a normal day and a scan that still finishes on
  // a bad one.
  assert.deepEqual(PAGE_SIZES, [...PAGE_SIZES].sort((a, b) => b - a));
  assert.equal(PAGE_SIZES[0], 100);
  assert.ok(PAGE_SIZES.at(-1) >= 25, 'terlalu kecil justru memboroskan kuota');
});

test('the cache is short enough to still be true', () => {
  // It exists to make a five-step recovery cost one scan, not to spare the next hour's
  // work: an invoice list that is minutes stale is how a deduplicator deletes a row that
  // is already gone.
  assert.ok(TTL_MS >= 60_000 && TTL_MS <= 10 * 60_000);
});
