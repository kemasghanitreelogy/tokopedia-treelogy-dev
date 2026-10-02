import test from 'node:test';
import assert from 'node:assert/strict';
import { printBatches, printBatchKey, printedEntry, printKey } from '../src/labels.js';
import { renderLabels, renderLabelLookup } from '../src/dashboard-page.js';

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

  assert.match(html, /<tr class="grp" data-grp="b2"><td colspan="5">/);
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
  // Vanya's run is still sent, but hidden and unprintable: only a search may bring it back.
  assert.match(html, /<tr class="grp" data-grp="[^"]*" data-out="1" hidden>(?:(?!<\/tr>)[\s\S])*<span class="grp__by">Vanya<\/span>/);
  assert.doesNotMatch(html, /<tr class="grp" data-grp="[^"]*">(?:(?!<\/tr>)[\s\S])*<span class="grp__by">Vanya<\/span>/);
  assert.match(html, /1 batch &middot; 1 label <span class="dim">dari 2 batch<\/span>/);
  // Out of the filter means out of the print and out of the count on the button.
  const outside = html.match(/<tr data-id="[^"]*" data-batch="[^"]*" data-out="1" hidden>\s*<td><input class="pick"[^>]*>/g) ?? [];
  assert.equal(outside.length, 2, 'both of Vanya\'s parcels stay reachable by the search');
  for (const pick of outside) assert.match(pick, / disabled/);
  assert.match(html, /<span id="n">1<\/span> label/);
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

test('today and yesterday are closed ranges on the bench clock', async () => {
  const { reprintPresets } = await import('../src/labels.js');
  const presets = reprintPresets(1790300000); // 25 Sep 2026, 08.33 WIB

  assert.deepEqual(presets.map((p) => p.id), ['today', 'yesterday', '7d']);
  assert.deepEqual(presets[0], { id: 'today', label: 'Hari ini', from: '2026-09-25', to: '2026-09-25' });
  // Closed at both ends, so "kemarin" stays kemarin as the day goes on rather than
  // quietly coming to mean "yesterday and everything since".
  assert.deepEqual(presets[1], { id: 'yesterday', label: 'Kemarin', from: '2026-09-24', to: '2026-09-24' });
  assert.equal(presets[2].from, '2026-09-19');
});

test('a print is filed on the clock of the bench it came off, not the house clock', async () => {
  const { reprintPresets, printDay, printZoneLabel } = await import('../src/labels.js');
  /*
   * The hour that tells the two apart. 16.30 UTC is 23.30 on 24 September in Jakarta and
   * 00.30 on the 25th in Bali, where the printer is. Filing it under the 24th would put
   * it in the wrong bucket for "kemarin" and contradict the time on its own heading.
   */
  const acrossMidnight = Date.parse('2026-09-24T16:30:00Z') / 1000;
  assert.equal(printDay({ at: acrossMidnight }), '2026-09-25');
  assert.equal(reprintPresets(acrossMidnight)[0].from, '2026-09-25', 'hari ini ikut jam meja');
  assert.equal(reprintPresets(acrossMidnight)[1].from, '2026-09-24');
  assert.equal(printZoneLabel(), 'WITA');
});

test('a heading says which clock its time is on', () => {
  // 16.30 UTC: 23.30 in Jakarta, 00.30 the next day in Bali. The heading has to show the
  // Bali reading, and has to say so - a bare time beside the order times in the rows
  // below, which are on their own platforms' clocks, would be a trap.
  const at = Date.parse('2026-09-24T16:30:00Z') / 1000;
  const html = page({
    showReprints: true,
    printed: { 'shopee:260918AAA': { at, by: 'vanya@treelogy.com', batch: 'b1', times: 1 } },
    people: staff,
  });
  assert.match(html, /<span class="grp__t">25 Sep, 00\.30 WITA<\/span>/);
  assert.match(html, /jam WITA/, 'dan bilah filternya menyebut jam yang sama');
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

test('a search over the print list filters as it is typed, and takes hidden rows out of the print', () => {
  const html = page({
    showReprints: true,
    printed: {
      'shopee:260918AAA': { at: 1790261000, by: 'vanya@treelogy.com', batch: 'b1', times: 1 },
      'tiktok_shop:586000CCC': { at: 1790290000, by: 'kemas@treelogy.com', batch: 'b2', times: 1 },
    },
    people: {},
  });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

  // Outside both forms: inside the filter form Enter reloads the page, and inside the
  // print form it sends a print job.
  assert.match(html, /<div class="filters lbs">/);
  assert.ok(html.indexOf('class="filters lbs"') < html.indexOf('<form method="post" action="/api/labels"'));
  assert.match(html, /id="lbq"[^>]*type="search"|type="search"[^>]*id="lbq"/);
  assert.ok(!/id="lbq"[^>]*\sname=/.test(html), 'kotak cari tidak ikut terkirim ke mana pun');

  // input alone: keyup as well would send every keystroke's search to the server twice.
  assert.match(script, /box\.addEventListener\('input', apply\)/);
  assert.doesNotMatch(script, /addEventListener\('keyup'/);
  // Past the rows on the page, the search asks the server about every order.
  assert.match(script, /\?view=labels&lookup=/);
  assert.match(html, /<tbody id="lbq-more"><\/tbody>/);
  // A hidden row is disabled, and a disabled control is not submitted - so "Cetak" after
  // a search prints what is on screen.
  assert.match(script, /pick\.disabled = !hit/);
  assert.match(script, /function visible\(\)/);
  // Every row carries the id the filter reads, rather than the filter reading markup.
  assert.match(html, /<tr data-id="260918aaa"/, 'id disimpan di baris, sudah huruf kecil');
});

test('a filtered day is never cut short by the hundred orders that came back first', () => {
  // 120 older Shopee prints arrive ahead of yesterday's one Tokopedia print. Cutting to the
  // print cap before grouping used to keep only Shopee, so "kemarin" showed Shopee alone.
  const old = Array.from({ length: 120 }, (_, i) => order('shopee', `OLD${i}`));
  const printed = Object.fromEntries(old.map((o) => [`shopee:${o.id}`, { at: 1790200000, by: 'vanya@treelogy.com', batch: 'old' }]));
  printed['tiktok_shop:586NEW'] = { at: 1790300000, by: 'kemas@treelogy.com', batch: 'new' };
  const html = page({
    orders: [...old, order('tiktok_shop', '586NEW', { status: 'AWAITING_COLLECTION' })],
    showReprints: true, printed, people: staff,
    reprintFilter: { from: '2026-09-25', to: '2026-09-25' },
  });
  assert.match(html, /value="tiktok_shop:586NEW" checked/);
  assert.match(html, /1 batch &middot; 1 label/);
  assert.match(html, /<span id="n">1<\/span> label/);
});

test('the unfiltered reprint list keeps every row but ticks no more than one print run', () => {
  const many = Array.from({ length: 130 }, (_, i) => order('shopee', `SN${i}`));
  const printed = Object.fromEntries(many.map((o) => [`shopee:${o.id}`, { at: 1790200000, by: 'vanya@treelogy.com', batch: 'b' }]));
  const html = page({ orders: many, showReprints: true, printed, people: staff });
  const picks = html.match(/<input class="pick"[^>]*>/g) ?? [];
  assert.equal(picks.length, 130);
  assert.equal(picks.filter((p) => / checked/.test(p)).length, 100);
  assert.match(html, /<span id="n">100<\/span> label/);
});

test('a parcel the courier took is still found in its run, with no way to print it', () => {
  // TikTok refuses the document after pickup, so it cannot be offered - but a search for it
  // answering "0 label" read as "never printed".
  const printed = { 'tokopedia:586GONE': { at: 1790300000, by: 'kemas@treelogy.com', batch: 'b1' } };
  const html = page({
    orders: [order('tokopedia', '586GONE', { status: 'DELIVERED' }), order('tokopedia', '586SELLERCENTER', { status: 'DELIVERED' })],
    showReprints: true, printed, people: staff,
  });
  assert.match(html, /<tr data-id="586gone" data-batch="b1">/);
  assert.match(html, /label tidak bisa dicetak ulang setelah pickup/);
  assert.doesNotMatch(html, /value="tokopedia:586GONE"/);
  // Printed outside the dashboard: no run to sit in, so not listed.
  assert.doesNotMatch(html, /586sellercenter/);
  assert.match(html, /<span id="n">0<\/span> label/);
});

test('a search across every order lists them all, printable or not, and says which', () => {
  const html = renderLabelLookup({
    orders: [
      order('shopee', '2609SHIP', { status: 'SHIPPED' }),
      order('tokopedia', '5863GONE', { status: 'DELIVERED' }),
      order('tokopedia', '5863WAIT', { status: 'AWAITING_SHIPMENT' }),
    ],
    printed: { 'tokopedia:5863GONE': { at: 1790300000, by: 'ika@treelogy.com', batch: 'b1' } },
    people: { 'ika@treelogy.com': 'Ika' },
  });
  // Shopee still issues a waybill after pickup: found, and ticked to print.
  assert.match(html, /value="shopee:2609SHIP" checked/);
  // Tokopedia does not: listed, no checkbox, and when it was printed and by whom.
  assert.match(html, /<tr data-id="5863gone">/);
  assert.doesNotMatch(html, /value="tokopedia:5863GONE"/);
  assert.match(html, /label tidak bisa dicetak ulang setelah pickup · dicetak [^<]* oleh Ika/);
  // Not arranged yet: listed with the reason, nothing to print.
  assert.match(html, /<tr data-id="5863wait">/);
  assert.doesNotMatch(html, /value="tokopedia:5863WAIT"/);
  assert.match(html, /atur pengiriman dulu di Seller Center/);
});

test('an empty list still offers the search, with the table waiting for its results', () => {
  const html = page({ orders: [], showReprints: false, printed: {} });
  assert.match(html, /id="lbq"/);
  assert.match(html, /<form method="post" action="\/api\/labels" target="_blank" id="lbform" data-empty hidden>/);
  assert.match(html, /Semua label sudah dicetak/);
});
