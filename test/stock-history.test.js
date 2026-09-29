import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, drops, MAX_SAMPLES } from '../src/stock-history.js';

/**
 * Eight listings went from 172 to 71 between one day's top-up and the next, across two
 * marketplaces, while exactly one unit of those SKUs sold. Shopee accepted every write
 * cleanly and the value held for hours when read back. So the writes land, something
 * takes them away, and nothing we kept could say when.
 *
 * A number that is only read when somebody complains is a number with no history.
 */

const entry = (sku, per) => ({ sku, ...per });
const ch = (qty) => ({ qty, rows: [{ qty }], conflict: false });

test('a sample is every channel of every SKU, flat', () => {
  const qty = snapshot({ skus: [
    entry('MRS-001', { tiktok: ch(171), shopee: ch(171), shopify: ch(71) }),
    entry('MRS-002', { shopee: ch(71) }),
  ] });
  assert.deepEqual(qty, {
    'MRS-001|tiktok': 171, 'MRS-001|shopee': 171, 'MRS-001|shopify': 71,
    'MRS-002|shopee': 71,
  });
});

test('a quantity the channel never gave is left out rather than recorded as nothing', () => {
  // Number(null) is 0, and a zero in a stock history is a sell-out that never happened.
  const qty = snapshot({ skus: [entry('X', { tiktok: { qty: null, rows: [] }, shopee: ch(5) } )] });
  assert.deepEqual(qty, { 'X|shopee': 5 });
});

test('it names the fall, the moment, and what we were doing at the time', () => {
  const found = drops({ samples: [
    { at: 1000, note: 'sesudah tulis', qty: { 'MRS-002|shopee': 171 } },
    { at: 2000, note: 'sebelum tulis', qty: { 'MRS-002|shopee': 71 } },
  ] });
  assert.equal(found.length, 1);
  assert.deepEqual(
    { sku: found[0].sku, channel: found[0].channel, fell: found[0].fell, at: found[0].at },
    { sku: 'MRS-002', channel: 'shopee', fell: 100, at: 2000 },
  );
});

test('rises are not listed, because a rise is us or somebody restocking', () => {
  const found = drops({ samples: [
    { at: 1000, qty: { 'A|shopee': 71 } },
    { at: 2000, qty: { 'A|shopee': 171 } },
  ] });
  assert.deepEqual(found, []);
});

test('a SKU that appears or disappears between samples is not a fall', () => {
  const found = drops({ samples: [
    { at: 1000, qty: { 'GONE|shopee': 50 } },
    { at: 2000, qty: { 'NEW|shopee': 50 } },
  ] });
  assert.deepEqual(found, []);
});

test('small falls can be hidden, because a sale is a fall too', () => {
  const samples = [
    { at: 1000, qty: { 'A|shopee': 200, 'B|shopee': 200 } },
    { at: 2000, qty: { 'A|shopee': 199, 'B|shopee': 100 } },
  ];
  assert.deepEqual(drops({ samples }, { minDrop: 50 }).map((d) => d.sku), ['B']);
  assert.equal(drops({ samples }).length, 2);
});

test('newest first, and the biggest fall first within a moment', () => {
  const found = drops({ samples: [
    { at: 1000, qty: { 'A|shopee': 200, 'B|shopee': 200 } },
    { at: 2000, qty: { 'A|shopee': 190, 'B|shopee': 100 } },
    // B falls further than A in the same half hour, which is the tie to break.
    { at: 3000, qty: { 'A|shopee': 185, 'B|shopee': 60 } },
  ] });
  assert.equal(found[0].at, 3000);
  assert.deepEqual(found.slice(0, 2).map((d) => [d.sku, d.fell]), [['B', 40], ['A', 5]]);
});

test('an empty history is a quiet answer, not a crash', () => {
  assert.deepEqual(drops({}), []);
  assert.deepEqual(drops({ samples: [] }), []);
  assert.deepEqual(snapshot(undefined), {});
  assert.ok(MAX_SAMPLES >= 96, 'setidaknya dua hari pada setengah jam sekali');
});
