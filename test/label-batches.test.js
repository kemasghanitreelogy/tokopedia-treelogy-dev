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

/* ---------------------------------------------------------------- filters */

const batch = (key, at, by, n = 1) => ({ key, at, by, rows: Array.from({ length: n }, (_, i) => ({ order: { id: `${key}-${i}` } })) });

test('a date range and a person stack, and either alone still works', async () => {
  const { filterPrintBatches } = await import('../src/labels.js');
  // 1790300000 is 25 Sep WIB, 1790261000 is 24 Sep WIB, 1789900000 is 20 Sep WIB.
  const all = [batch('b3', 1790300000, 'vanya@x'), batch('b2', 1790261000, 'kemas@x'), batch('b1', 1789900000, 'vanya@x')];

  assert.deepEqual(filterPrintBatches(all, {}).map((b) => b.key), ['b3', 'b2', 'b1'], 'tanpa filter, semuanya');
  assert.deepEqual(filterPrintBatches(all, { from: '2026-09-24' }).map((b) => b.key), ['b3', 'b2']);
  assert.deepEqual(filterPrintBatches(all, { to: '2026-09-24' }).map((b) => b.key), ['b2', 'b1']);
  assert.deepEqual(filterPrintBatches(all, { from: '2026-09-24', to: '2026-09-24' }).map((b) => b.key), ['b2']);
  assert.deepEqual(filterPrintBatches(all, { by: 'vanya@x' }).map((b) => b.key), ['b3', 'b1']);
  // Stacked: the person narrows what the dates left.
  assert.deepEqual(filterPrintBatches(all, { from: '2026-09-24', by: 'vanya@x' }).map((b) => b.key), ['b3']);
  assert.deepEqual(filterPrintBatches(all, { from: '2026-09-24', by: 'kemas@x' }).map((b) => b.key), ['b2']);
});

test('a run whose date was never recorded cannot be placed on a calendar', async () => {
  const { filterPrintBatches } = await import('../src/labels.js');
  const all = [batch('tanpa-catatan', null, ''), batch('b1', 1790300000, 'vanya@x')];
  assert.deepEqual(filterPrintBatches(all, {}).map((b) => b.key), ['tanpa-catatan', 'b1'], 'tetap ada saat tidak disaring');
  // Any date bound at all excludes it: better certainly right than padded with maybes.
  assert.deepEqual(filterPrintBatches(all, { from: '2020-01-01' }).map((b) => b.key), ['b1']);
});

test('the filter offers the days and people that actually printed, biggest first', async () => {
  const { printersIn, printDaysIn } = await import('../src/labels.js');
  const all = [batch('b3', 1790300000, 'vanya@x', 3), batch('b2', 1790261000, 'kemas@x', 1), batch('b1', 1789900000, 'vanya@x', 2)];

  assert.deepEqual(printersIn(all), [{ email: 'vanya@x', labels: 5 }, { email: 'kemas@x', labels: 1 }]);
  assert.deepEqual(printDaysIn(all).map((d) => d.day), ['2026-09-25', '2026-09-24', '2026-09-20'], 'terbaru dulu');
  assert.equal(printDaysIn(all)[0].labels, 3);
});

const printedThree = {
  'shopee:260918AAA': { at: 1790261000, by: 'vanya@treelogy.com', batch: 'b1', times: 1 },
  'shopee:260918BBB': { at: 1790261000, by: 'vanya@treelogy.com', batch: 'b1', times: 1 },
  'tiktok_shop:586000CCC': { at: 1790300000, by: 'kemas@treelogy.com', batch: 'b2', times: 1 },
};
const staff = { 'vanya@treelogy.com': 'Vanya', 'kemas@treelogy.com': 'Kemas Ghani' };

test('the filter bar is its own form, never nested inside the one that prints', () => {
  const html = page({ showReprints: true, printed: printedThree, people: staff });
  assert.match(html, /<form class="filters rpf" method="get">/);
  // A form cannot be nested in another, and filtering must not be one slip from printing.
  assert.ok(html.indexOf('class="filters rpf"') < html.indexOf('action="/api/labels"'));
  assert.match(html, /name="pfrom"/);
  assert.match(html, /name="pto"/);
  assert.match(html, /<option value="vanya@treelogy\.com">Vanya \(2\)<\/option>/);
  assert.match(html, /<option value="kemas@treelogy\.com">Kemas Ghani \(1\)<\/option>/);
  assert.match(html, /2 batch &middot; 3 label/);
});

test('filtering to one day leaves that run grouped and drops the rest', () => {
  const html = page({ showReprints: true, printed: printedThree, people: staff, reprintFilter: { from: '2026-09-25', to: '2026-09-25' } });
  assert.match(html, /<span class="grp__by">Kemas Ghani<\/span>/);
  assert.doesNotMatch(html, /<span class="grp__by">Vanya<\/span>/);
  assert.match(html, /1 batch &middot; 1 label <span class="dim">dari 2 batch<\/span>/);
  assert.match(html, /Hapus filter/);
  // The date it was filtered on comes back in the field, so it can be adjusted not retyped.
  assert.match(html, /id="pfrom" name="pfrom" value="2026-09-25"/);
});

test('a filter that matches nothing says so, and offers the way back', () => {
  const html = page({ showReprints: true, printed: printedThree, people: staff, reprintFilter: { from: '2020-01-01', to: '2020-01-02' } });
  assert.match(html, /Tidak ada batch cetak yang cocok dengan filter ini/);
  assert.match(html, /Hapus filter/);
  // The bar stays on screen: an empty result the operator cannot change is a dead end.
  assert.match(html, /<form class="filters rpf" method="get">/);
});

test('the daily list has no reprint filter at all', () => {
  assert.doesNotMatch(page({ showReprints: false, printed: {} }), /class="filters rpf"/);
});

/* ------------------------------------------------------- one-click ranges */

test('today and yesterday are closed ranges on the house clock', async () => {
  const { reprintPresets } = await import('../src/labels.js');
  const presets = reprintPresets(1790300000); // 25 Sep 2026, 08.33 WIB

  assert.deepEqual(presets.map((p) => p.id), ['today', 'yesterday', '7d']);
  assert.deepEqual(presets[0], { id: 'today', label: 'Hari ini', from: '2026-09-25', to: '2026-09-25' });
  // Closed at both ends, so "kemarin" stays kemarin as the day goes on rather than
  // quietly coming to mean "yesterday and everything since".
  assert.deepEqual(presets[1], { id: 'yesterday', label: 'Kemarin', from: '2026-09-24', to: '2026-09-24' });
  assert.equal(presets[2].from, '2026-09-19');
});

test('the day boundary is the one the run headings are printed in', async () => {
  const { reprintPresets, printDay } = await import('../src/labels.js');
  // 17.30 UTC is already the next day in WIB, and the heading above the rows says so too.
  const lateEvening = Date.parse('2026-09-24T17:30:00Z') / 1000;
  assert.equal(reprintPresets(lateEvening)[0].from, '2026-09-25');
  assert.equal(printDay({ at: lateEvening }), '2026-09-25');
});

test('the quick chips are one click and carry the printer through', () => {
  const html = page({
    showReprints: true, printed: printedThree, people: staff,
    reprintFilter: { by: 'vanya@treelogy.com' }, now: 1790300000,
  });
  // Narrowing to today must not quietly widen the list back to everyone.
  assert.match(html, /href="\?view=labels&amp;reprint=1&amp;pfrom=2026-09-25&amp;pto=2026-09-25&amp;pby=vanya%40treelogy\.com"[^>]*>Hari ini</);
  assert.match(html, /pfrom=2026-09-24&amp;pto=2026-09-24&amp;pby=vanya%40treelogy\.com"[^>]*>Kemarin</);
});

test('the chip for the range in force is the one that looks pressed', () => {
  const html = page({
    showReprints: true, printed: printedThree, people: staff,
    reprintFilter: { from: '2026-09-24', to: '2026-09-24' }, now: 1790300000,
  });
  assert.match(html, /<a class="chip is-on"[^>]*>Kemarin<\/a>/);
  assert.match(html, /<a class="chip"[^>]*>Hari ini<\/a>/);
  // With nothing else filtering, "clear the dates" and "clear the filter" are one act,
  // and offering it twice only makes the operator wonder what the difference is.
  assert.doesNotMatch(html, /Semua tanggal/);
  assert.match(html, /Hapus filter/);
});

test('dropping just the dates is offered only when a printer would survive it', () => {
  const html = page({
    showReprints: true, printed: printedThree, people: staff,
    reprintFilter: { from: '2026-09-24', to: '2026-09-24', by: 'vanya@treelogy.com' }, now: 1790300000,
  });
  assert.match(html, /href="\?view=labels&reprint=1&pby=vanya%40treelogy\.com">Semua tanggal<\/a>/);
});

test('nothing is pressed when no date is filtered, and no way-out chip is offered', () => {
  const html = page({ showReprints: true, printed: printedThree, people: staff, now: 1790300000 });
  assert.doesNotMatch(html, /chip is-on/);
  assert.doesNotMatch(html, /Semua tanggal/);
  assert.match(html, />Hari ini</);
});
