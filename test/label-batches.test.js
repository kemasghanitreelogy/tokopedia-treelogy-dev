import test from 'node:test';
import assert from 'node:assert/strict';
import { printBatches, printBatchKey, printedEntry, printKey } from '../src/labels.js';
import { renderLabels } from '../src/dashboard-page.js';

/**
 * The reprint list, read the way it was made.
 *
 * Forty parcels printed in one click are one act by one person at one moment. Listed flat
 * they are forty unrelated rows, and reconstructing the run from timestamps is exactly
 * the work the operator opened this list to avoid.
 */

const order = (channel, id, extra = {}) => ({
  channel, id, createdAt: 1790261940, stage: 'shipping', status: 'SHIPPED',
  buyer: 'budi', carrier: 'JNE', lines: [], ...extra,
});
const row = (o) => ({ order: o, readiness: { state: 'reprint', note: 'sudah dicetak' } });

test('one run is one group, however many parcels it carried', () => {
  const printed = {
    'shopee:A': { at: 1790000000, by: 'vanya@treelogy.com', batch: 'b1', times: 1 },
    'shopee:B': { at: 1790000000, by: 'vanya@treelogy.com', batch: 'b1', times: 1 },
    'shopee:C': { at: 1790009999, by: 'kemas@treelogy.com', batch: 'b2', times: 1 },
  };
  const batches = printBatches([order('shopee', 'A'), order('shopee', 'B'), order('shopee', 'C')].map(row), printed);

  assert.equal(batches.length, 2);
  // Newest run first: that is the one somebody is most likely looking for.
  assert.equal(batches[0].key, 'b2');
  assert.equal(batches[0].by, 'kemas@treelogy.com');
  assert.deepEqual(batches[1].rows.map((r) => r.order.id), ['A', 'B']);
});

test('two people printing at the same second are two batches, not one', () => {
  const printed = {
    'shopee:A': { at: 1790000000, by: 'vanya@treelogy.com', batch: 'b1' },
    'shopee:B': { at: 1790000000, by: 'kemas@treelogy.com', batch: 'b2' },
  };
  assert.equal(printBatches([order('shopee', 'A'), order('shopee', 'B')].map(row), printed).length, 2);
});

test('prints recorded before batches existed still group by when and by whom', () => {
  // The ledger has plenty of these. markPrinted is called once per run, so a shared
  // timestamp and operator is what a batch was, before it had a name.
  const printed = {
    'shopee:A': { at: 1789000000, by: 'vanya@treelogy.com' },
    'shopee:B': { at: 1789000000, by: 'vanya@treelogy.com' },
    'shopee:C': { at: 1789000500, by: 'vanya@treelogy.com' },
  };
  const batches = printBatches([order('shopee', 'A'), order('shopee', 'B'), order('shopee', 'C')].map(row), printed);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].rows.length, 2);
  assert.equal(printBatchKey({ at: 7, by: 'x' }), '7|x');
  assert.equal(printBatchKey(null), null);
});

test('an order with no record at all is grouped last, never above a batch that knows its time', () => {
  const printed = { 'shopee:A': { at: 1790000000, by: 'vanya@treelogy.com', batch: 'b1' } };
  const batches = printBatches([order('shopee', 'A'), order('shopee', 'UNKNOWN')].map(row), printed);
  assert.equal(batches[0].key, 'b1');
  assert.equal(batches[1].key, 'tanpa-catatan');
  assert.equal(batches[1].at, null);
});

test('a legacy bare-id entry is still found, as it is everywhere else', () => {
  assert.equal(printKey('shopee', 'A'), 'shopee:A');
  assert.equal(printedEntry({ A: { at: 5 } }, order('shopee', 'A')).at, 5);
});

const page = (extra = {}) => renderLabels({
  orders: [order('shopee', '260918AAA'), order('shopee', '260918BBB'), order('tiktok_shop', '586000CCC', { status: 'AWAITING_COLLECTION' })],
  range: { from: '2026-09-18', to: '2026-09-25', label: '7 hari' },
  errors: {}, shopeeShop: null, generatedAt: 1790300000, csrf: 'x', flash: null,
  sizes: { a6: { label: 'A6' } }, defaultSize: 'a6',
  user: { name: 'Kemas', email: 'kemas@treelogy.com', role: 'owner' },
  ...extra,
});

test('the reprint page shows a heading per run, naming the person and the count', () => {
  const html = page({
    showReprints: true,
    printed: {
      'shopee:260918AAA': { at: 1790261000, by: 'vanya@treelogy.com', batch: 'b1', times: 1 },
      'shopee:260918BBB': { at: 1790261000, by: 'vanya@treelogy.com', batch: 'b1', times: 2 },
      'tiktok_shop:586000CCC': { at: 1790290000, by: 'kemas@treelogy.com', batch: 'b2', times: 1 },
    },
    people: { 'vanya@treelogy.com': 'Vanya', 'kemas@treelogy.com': 'Kemas Ghani' },
  });

  assert.match(html, /<tr class="grp" data-batch="b2"><td colspan="5">/);
  // The heading's own checkbox: reprinting one whole run is the reason this list exists.
  assert.match(html, /<input type="checkbox" class="grp__pick" data-batch="b1" checked/);
  assert.match(html, /class="pick"[^>]*value="shopee:260918AAA"[^>]*data-batch="b1"/);
  assert.match(html, /<span class="grp__by">Vanya<\/span>\s*<span class="grp__n grp__n--batch">2 label<\/span>/);
  assert.match(html, /<span class="grp__by">Kemas Ghani<\/span>\s*<span class="grp__n grp__n--batch">1 label<\/span>/);
  // Reprinted twice, and the list says so rather than looking identical to a first print.
  assert.match(html, /2&times;/);
  // The newest run's heading comes before the older one's.
  assert.ok(html.indexOf('>Kemas Ghani<') < html.indexOf('>Vanya<'));
});

test('an unknown printer falls back to the address, never to a blank heading', () => {
  const html = page({
    showReprints: true,
    printed: { 'shopee:260918AAA': { at: 1790261000, by: 'orang@lain.com', batch: 'b1' } },
    people: {},
  });
  assert.match(html, /<span class="grp__by">orang<\/span>/);
});

test('the daily list is not grouped, because nothing on it has been printed yet', () => {
  const html = page({ showReprints: false, printed: {} });
  assert.doesNotMatch(html, /<tr class="grp">/);
});
