import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDashboard, renderPicklist, renderLabels, renderProducts, renderProcess, renderStock, renderJurnal,
  renderManual, renderLogin,
} from '../src/dashboard-page.js';
import { syncOverview } from '../src/mekari/sync.js';
import { summarize } from '../src/omni.js';
import { buildPicklist } from '../src/picklist.js';
import { LABEL_SIZES, DEFAULT_SIZE } from '../src/labels.js';

const range = { preset: '7d', from: '2026-09-01', to: '2026-09-08', label: '7 hari', since: 1, until: 2, clamped: false };

const order = {
  channel: 'shopee', id: '260909ABC', createdAt: 1788900000, status: 'READY_TO_SHIP',
  stage: 'to_ship', total: 100000, currency: 'IDR', carrier: 'JNE', tracking: '',
  buyer: 'pembeli', items: 1, lines: [{ sku: 'A', name: 'Produk A', variant: '', qty: 2 }],
};

const catalog = {
  skus: [{
    sku: 'MRS-002', title: 'Ritual Set + Powder 45g',
    tiktok: { qty: 74, price: 1210000, rows: [{ qty: 74, price: 1210000, productId: 'p', skuId: 's', warehouseId: 'w', title: 'x', status: 'ACTIVATE' }], ignored: [], conflict: false },
    shopee: { qty: 74, price: 1210000, hasPromotion: false, rows: [{ qty: 74, price: 1210000, itemId: 1, modelId: 2, title: 'x', status: 'NORMAL' }], ignored: [], conflict: false },
  }, {
    sku: 'A', title: 'Produk A',
    tiktok: { qty: 5, price: 10000, rows: [{ qty: 5, price: 10000 }], ignored: [], conflict: false },
    shopee: { qty: 5, price: 10000, hasPromotion: false, rows: [{ qty: 5, price: 10000 }], ignored: [], conflict: false },
  }],
  errors: {},
};
const ledger = { version: 1, skus: { A: { qty: 5 }, 'MRS-002': { qty: 74 } } };
const plan = { changes: [], review: [], blocked: [], unchanged: [], unmanaged: [], missing: [] };
const common = { range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf: 'tok' };

const booked = {
  ...order,
  finance: { lines: [{ sku: 'OMP-45-001', name: 'Produk A', qty: 2, unitPrice: 50_000, unitDiscount: 0 }], shipping: 0 },
};
const jurnalOverview = (over = {}) => syncOverview({
  orders: [booked, { ...booked, id: 'BATAL', stage: 'cancelled' }],
  ledger: { orders: {} },
  ...over,
});

const pages = () => [
  ['orders', renderDashboard({ orders: [order], summary: summarize([order]), ...common })],
  ['picklist', renderPicklist({ picklist: buildPicklist([order]), ...common })],
  ['labels', renderLabels({ orders: [order], sizes: LABEL_SIZES, defaultSize: DEFAULT_SIZE, ...common })],
  ['products', renderProducts({ catalog, ledger, ...common })],
  ['product-detail', renderProducts({ catalog, ledger, selected: 'MRS-002', ...common })],
  ['stock', renderStock({ catalog, ledger, plan, ...common })],
  ['process', renderProcess({ orders: [order], ...common })],
  ['jurnal', renderJurnal({ overview: jurnalOverview(), live: false, depositTo: null, configured: true, ...common })],
  ['manual', renderManual({ source: 'CS', code: 'CS-260911-001', today: '2026-09-11', contacts: ['Toko Sehat'], existingCodes: [], live: true, depositTo: 'Cash', ...common })],
  ['login', renderLogin({})],
];

const scriptBodies = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('no view nests a script tag inside another', () => {
  // A nested <script><script> makes the browser treat the inner tag as JavaScript, which
  // is a syntax error - the block silently never runs and the UI stops responding.
  for (const [name, html] of pages()) {
    assert.ok(!/<script>\s*<script>/.test(html), `${name} nests script tags`);
  }
});

test('every inline script in every view is syntactically valid JavaScript', () => {
  for (const [name, html] of pages()) {
    for (const body of scriptBodies(html)) {
      assert.doesNotThrow(() => new Function(body), `${name} has an invalid script block`);
    }
  }
});

test('no JavaScript leaks into the page as visible text', () => {
  // Emitting the per-view script outside <script> tags renders it as body text and the
  // handlers never bind - buttons look fine and do nothing.
  for (const [name, html] of pages()) {
    const tail = html.split('</script>').pop().trim();
    assert.ok(!tail.includes('function ('), `${name} leaks script text into the body`);
  }
});

test('every view closes as a complete document', () => {
  for (const [name, html] of pages()) {
    assert.ok(html.startsWith('<!doctype html>'), `${name} is missing a doctype`);
    assert.ok(html.trimEnd().endsWith('</html>'), `${name} is truncated`);
    assert.equal(
      (html.match(/<script>/g) ?? []).length,
      (html.match(/<\/script>/g) ?? []).length,
      `${name} has unbalanced script tags`,
    );
  }
});

test('the label view wires its controls to elements that exist', () => {
  const printable = { ...order, status: 'PROCESSED' };
  const html = renderLabels({ orders: [printable], sizes: LABEL_SIZES, defaultSize: DEFAULT_SIZE, ...common });
  for (const id of ['all', 'none', 'head', 'n']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('class="pick"'), 'missing order checkboxes');
});

test('untrusted text is escaped, not interpolated', () => {
  const hostile = { ...order, buyer: '<img src=x onerror=alert(1)>' };
  const html = renderDashboard({ orders: [hostile], summary: summarize([hostile]), ...common });
  assert.ok(!html.includes('<img src=x'), 'buyer name was not escaped');
  assert.ok(html.includes('&lt;img src=x'), 'escaped form missing');
});

test('the print report names every failure and embeds the PDF it did produce', async () => {
  const { renderLabelReport } = await import('../src/dashboard-page.js');
  const html = renderLabelReport({
    pageCount: 2,
    requested: 10,
    failures: [
      { id: '585971176970224650', channel: 'tiktok_shop', reason: 'atur pengiriman dulu' },
      { id: '260909HSHTD12F', channel: 'shopee', reason: 'dokumen belum siap' },
    ],
    pdfBase64: 'JVBERi0=',
    size: '100x150',
  });

  assert.ok(html.includes('585971176970224650'), 'a failed order is missing from the report');
  assert.ok(html.includes('atur pengiriman dulu'), 'the reason is missing');
  assert.ok(html.includes('2</span> dari <span class="count">10'), 'the counts are not shown');
  for (const body of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])) {
    assert.doesNotThrow(() => new Function(body));
  }
});

const labelOrder = (channel, status, id) => ({
  channel, id, status, stage: 'to_ship', createdAt: 1788900000,
  buyer: 'b', carrier: 'JNE', tracking: '', lines: [],
});

const labelPage = (orders, extra = {}) => renderLabels({
  orders, range, errors: {}, shopeeShop: null, generatedAt: Date.now(),
  csrf: 'tok', sizes: LABEL_SIZES, defaultSize: DEFAULT_SIZE, ...extra,
});

test('the daily list shows only orders that still need a label, and ticks them all', () => {
  const html = labelPage([
    labelOrder('shopee', 'PROCESSED', 'PERLU'),
    labelOrder('tokopedia', 'AWAITING_COLLECTION', 'PERLU2'),
    labelOrder('shopee', 'SHIPPED', 'SUDAH'),
    labelOrder('shopee', 'READY_TO_SHIP', 'MENUNGGU'),
    labelOrder('tokopedia', 'AWAITING_SHIPMENT', 'BELUMATUR'),
  ]);

  for (const id of ['PERLU', 'PERLU2']) assert.ok(html.includes(`:${id}"`), `${id} should be listed`);
  for (const id of ['SUDAH', 'MENUNGGU', 'BELUMATUR']) {
    assert.ok(!html.includes(`:${id}"`), `${id} must not clutter the daily list`);
  }
  const picks = html.match(/class="pick"[^>]*>/g) ?? [];
  assert.equal(picks.length, 2);
  assert.equal(picks.filter((p) => p.includes(' checked')).length, 2, 'everything listed must be ticked');
  assert.ok(html.includes('>2</span> label'), 'the button must count the listed rows');
});

test('the reprint view offers only documents that can still be fetched', () => {
  const html = labelPage([
    labelOrder('shopee', 'COMPLETED', 'SHOPEELAMA'),
    labelOrder('tiktok_shop', 'DELIVERED', 'TIKTOKLAMA'),
  ], { showReprints: true });

  assert.ok(html.includes(':SHOPEELAMA"'), 'Shopee reprints stay available');
  // TikTok refuses after pickup, so offering it would only produce a failure.
  assert.ok(!html.includes(':TIKTOKLAMA"'), 'an unavailable reprint must not be offered');
});

test('the list never offers more rows than one print run accepts', () => {
  const many = Array.from({ length: 130 }, (_, i) => labelOrder('shopee', 'PROCESSED', `SN${i}`));
  const html = labelPage(many);
  assert.equal((html.match(/class="pick"/g) ?? []).length, 100);
  assert.ok(html.includes('>100</span> label'));
});

test('the product list groups by the master catalogue and links each row', async () => {
  const { CATEGORIES } = await import('../src/master.js');
  const html = renderProducts({ catalog, ledger, ...common });
  for (const label of Object.values(CATEGORIES)) {
    // Labels are escaped on the way out, so "Set & Aksesori" renders as "Set &amp; ...".
    const escaped = label.replace(/&/g, '&amp;');
    assert.ok(html.includes(escaped), `category ${label} is missing`);
  }
  assert.ok(html.includes('?view=products&sku=MRS-002'), 'rows should link to their detail');
});

test('a bundle detail shows its components and what they can build', () => {
  const html = renderProducts({ catalog, ledger, selected: 'MRS-002', ...common });
  assert.ok(html.includes('Isi bundle'), 'the recipe section is missing');
  assert.ok(html.includes('MRS-001'), 'a component is missing');
  assert.ok(html.includes('OMP-45-001'), 'a component is missing');
  assert.ok(html.includes('Tokopedia + TikTok Shop') && html.includes('Shopee'), 'per-channel cards missing');
});

test('a product with no listing offers no price control', () => {
  // Setting a price on a SKU that is not listed anywhere can only fail.
  const html = renderProducts({ catalog, ledger, selected: 'Bamboo-Whisk', ...common });
  assert.ok(!html.includes('name="action" value="price"'), 'price form must be hidden');
  assert.ok(html.includes('Belum tayang'), 'the reason should be stated');
});

test('a channel that failed to load is never reported as "not listed there"', () => {
  // Saying "hanya Tokopedia" because Shopee errored is a claim the data cannot support,
  // and it is the kind of wrong that gets acted on.
  const onlyTiktok = {
    skus: [{
      sku: 'OMP-45-001', title: 'Powder',
      tiktok: { qty: 117, price: 395000, rows: [{ qty: 117, price: 395000 }], ignored: [], conflict: false },
      shopee: null,
    }],
    errors: {},
  };

  const healthy = renderProducts({ catalog: onlyTiktok, ledger, ...common, errors: {} });
  assert.ok(healthy.includes('hanya Tokopedia'), 'a genuinely single-channel SKU should say so');

  const degraded = renderProducts({ catalog: onlyTiktok, ledger, ...common, errors: { shopee: 'rate limit' } });
  assert.ok(!degraded.includes('hanya Tokopedia'), 'a failed channel must not become a claim');
  assert.ok(degraded.includes('tidak terbaca'), 'the failure should be named');
});

test('counts derived from a partial catalogue are withheld, not shown as facts', () => {
  const degraded = renderProducts({ catalog, ledger, ...common, errors: { shopee: 'rate limit' } });
  assert.match(degraded, /stat__n[^>]*>\?</, 'derived counts should read as unknown');
});

test('every page guards number inputs against wheel-scroll edits', () => {
  // A focused number input silently applies wheel deltas. On forms that write live
  // stock and prices, scrolling past turned 999999 into 1000246 with no visible cue.
  for (const [name, html] of pages()) {
    if (!html.includes('type="number"')) continue;
    assert.ok(html.includes(`input[type="number"]`), `${name} does not install the wheel guard`);
    assert.ok(html.includes('e.preventDefault()'), `${name} does not block the wheel default`);
  }
});

test('a form that writes to a marketplace confirms with the value it will write', () => {
  const html = renderProducts({ catalog, ledger, selected: 'MRS-002', ...common });
  assert.match(html, /data-confirm="[^"]*\{v\}/, 'the confirmation should quote the value');
  assert.ok(!html.includes('onsubmit='), 'inline handlers cannot show the live value');
});

test('the products view confirms both the ledger edit and the marketplace write', () => {
  const withPlan = { ...plan, changes: [{ sku: 'A', channel: 'tiktok', from: 1, to: 2, ref: {} }] };
  const list = renderProducts({ catalog, ledger, plan: withPlan, ...common });
  assert.match(list, /data-confirm="Tulis 1 perubahan/, 'the apply bar should confirm');

  const detail = renderProducts({ catalog, ledger, plan: withPlan, selected: 'MRS-002', ...common });
  assert.match(detail, /data-confirm="[^"]*\{v\}/, 'the ledger edit should quote its value');
});

test('the sync bar only appears when there is something to sync', () => {
  const quiet = renderProducts({ catalog, ledger, plan, ...common });
  assert.ok(!quiet.includes('class="sync"'), 'an empty plan needs no bar');

  const busy = renderProducts({
    catalog, ledger, ...common,
    plan: { ...plan, changes: [{ sku: 'A', channel: 'tiktok', from: 1, to: 2, ref: {} }] },
  });
  assert.ok(busy.includes('class="sync"'), 'a pending change should surface');
});

test('stock has its own editing surface, separate from browsing products', async () => {
  // The old stock tab duplicated the product list; this one exists to change numbers.
  const { VIEWS } = await import('../src/dashboard-page.js');
  assert.ok(Object.hasOwn(VIEWS, 'stock'));
  assert.ok(Object.hasOwn(VIEWS, 'products'));

  const html = renderStock({ catalog, ledger, plan, ...common });
  assert.ok(html.includes('id="stockform"'), 'stock should be editable in place');
  assert.ok(html.includes('data-step'), 'a stepper makes the common adjustment one click');
  assert.ok(!html.includes('<table'), 'editing should not be a report table');
});

test('every stock field starts from the saved value and knows it', () => {
  // data-original is what lets the page count real edits instead of every keystroke.
  const html = renderStock({ catalog, ledger, plan, ...common });
  const fields = [...html.matchAll(/<input class="st__in[^>]*>/g)].map((m) => m[0]);
  assert.ok(fields.length > 0, 'no editable fields rendered');
  for (const field of fields) assert.match(field, /data-original="/);
});

test('saving is disabled until something actually changes', () => {
  const html = renderStock({ catalog, ledger, plan, ...common });
  assert.match(html, /id="save"[^>]*disabled/, 'an untouched form should not offer a save');
});

test('pushing to the marketplaces stays a separate, deliberate form', () => {
  // Editing the ledger is local and safe; writing to live listings is not, so the two
  // must never share a submit.
  const html = renderStock({ catalog, ledger, plan: { ...plan, changes: [{ sku: 'A', channel: 'tiktok', from: 1, to: 2, ref: {} }] }, ...common });
  assert.ok(html.includes('id="applyform"'), 'the apply action needs its own form');
  assert.match(html, /data-confirm="Tulis 1 perubahan stok ke marketplace\?"/);
});

test('the reload button appears only when there is something to retry', () => {
  const btn = (html) => (html.match(/<a class="alert__btn"/g) ?? []).length;

  assert.equal(btn(renderProducts({ catalog, ledger, ...common, errors: {} })), 0,
    'a healthy page should not offer a retry');
  assert.equal(btn(renderProducts({ catalog, ledger, ...common, errors: { shopee: 'Service Error' } })), 1,
    'a failed channel should offer a retry');
  assert.equal(
    btn(renderProducts({ catalog: { ...catalog, stale: true, savedAt: new Date().toISOString() }, ledger, ...common })),
    1,
    'stale data should offer a retry',
  );
});

test('the retry link carries a cache-busting parameter', () => {
  // Without it the click would be served the same cached failure and appear to do nothing.
  const html = renderProducts({ catalog, ledger, ...common, errors: { shopee: 'x' } });
  assert.match(html, /alert__btn" href="[^"]*retry=\d+/);
});

test('stale data is labelled, never passed off as current', () => {
  const html = renderProducts({
    catalog: { ...catalog, stale: true, savedAt: '2026-09-09T02:00:00.000Z' },
    ledger, ...common,
  });
  assert.ok(html.includes('data terakhir yang berhasil'), 'the page must say the data is old');
  assert.ok(html.includes('WIB'), 'and when it was taken');
});

test('every page carries the Treelogy palette and typeface, never the old one', () => {
  for (const [name, html] of pages()) {
    assert.ok(html.includes('family=Inter'), `${name} is not on the brand typeface`);
    assert.ok(!/#2563EB|#7C3AED|#3B82F6|#1D4ED8/.test(html), `${name} still carries the old blue/purple`);
    assert.ok(html.includes('#526547'), `${name} is missing the brand sage`);
  }
});

test('a gradient that carries white text uses the deep fill, not the light sage', () => {
  // White on #8FA97F is 2.58:1 - unreadable. A gradient is only as legible as its
  // lightest stop, so any fill behind white text uses --fill-a/--fill-b. A 2px progress
  // bar carries no text and is exempt.
  for (const [name, html] of pages()) {
    const rules = [...html.matchAll(/\{[^{}]*linear-gradient\([^)]*\)[^{}]*\}/g)].map((m) => m[0]);
    for (const rule of rules) {
      if (!/color:\s*#fff/i.test(rule)) continue;
      assert.match(rule, /var\(--fill-a\)/, `${name} puts white text on a non-fill gradient`);
    }
  }
});

test('every view shows progress while a slow navigation is in flight', () => {
  // Four marketplaces answer in seconds and a full page load shows nothing until they
  // all do; without this the click reads as ignored.
  for (const [name, html] of pages()) {
    if (name === 'login' || name === 'report') continue;
    assert.ok(html.includes('id="nav-progress"'), `${name} has no progress bar`);
    assert.ok(html.includes('id="loader"'), `${name} has no skeleton`);
    assert.ok(html.includes('beginNavigation'), `${name} never arms the loader`);
  }
});

test('motion is opt-out for anyone who asks for less of it', () => {
  for (const [name, html] of pages()) {
    assert.ok(html.includes('prefers-reduced-motion'), `${name} ignores the motion preference`);
  }
});

test('entrance stagger stays inside one perceived beat', () => {
  // The motion doctrine caps a group arrival at about half a second end to end.
  const html = renderProducts({ catalog, ledger, ...common });
  const delays = [...html.matchAll(/\.cards \.card:nth-child\([^)]*\)\{animation-delay:(\d+)ms\}/g)]
    .map((m) => Number(m[1]));
  assert.ok(delays.length > 0, 'no staggered card delays found');
  assert.ok(Math.max(...delays) - Math.min(...delays) <= 500, 'the wave takes longer than one beat');
});

const processOrder = (channel, status, id, extra = {}) => ({
  channel, id, status, stage: 'to_ship', createdAt: 1788900000,
  buyer: 'b', carrier: 'JNE', tracking: '', total: 100000, lines: [], ...extra,
});

test('the worklist hides machine statuses and is not a report table', () => {
  const html = renderProcess({
    orders: [
      processOrder('tokopedia', 'AWAITING_SHIPMENT', 'A'),
      processOrder('shopee', 'READY_TO_SHIP', 'B'),
    ],
    ...common, csrf: 'tok',
  });

  // A raw enum means nothing to the person packing; the section heading already says it.
  assert.ok(!html.includes('AWAITING_SHIPMENT'), 'raw platform status leaked into the UI');
  assert.ok(!html.includes('READY_TO_SHIP'), 'raw platform status leaked into the UI');
  assert.ok(!html.includes('<table'), 'a worklist should not be a report table');
  assert.equal((html.match(/class="wo"/g) ?? []).length, 2, 'every order should be a card');
});

test('both marketplace paths commit through one button', () => {
  // The operator should not have to know that Shopee and TikTok batch differently.
  const html = renderProcess({
    orders: [
      processOrder('tokopedia', 'AWAITING_SHIPMENT', 'A'),
      processOrder('shopee', 'READY_TO_SHIP', 'B'),
    ],
    ...common, csrf: 'tok',
  });

  assert.equal((html.match(/<form[^>]*id="massform"/g) ?? []).length, 1, 'there should be one form');
  // The shell's date-range form has its own submit; only the worklist's is counted.
  assert.equal((html.match(/class="wo__go" type="submit"/g) ?? []).length, 1,
    'the worklist should commit through exactly one button');
  assert.match(html, /name="action" value="mass_arrange"/);
  assert.equal((html.match(/class="wo__pick"/g) ?? []).length, 2, 'every order needs a checkbox');
  assert.ok(html.includes('Pilih semua') && html.includes('Kosongkan'));
});

test('Shopify never appears in the shipment queue', () => {
  const html = renderProcess({
    orders: [processOrder('shopify', 'PAID/UNFULFILLED', 'SHOPIFY1')],
    ...common, csrf: 'tok',
  });
  assert.ok(!html.includes('SHOPIFY1'), 'Shopify was offered for batch arrangement');
  assert.ok(html.includes('Semua pesanan sudah diatur'), 'the empty state should show instead');
});

test('a row held because it came from the seed offers a way to vouch for it', async () => {
  // Without this the operator would have to nudge the number up and back down just to
  // make the save button light up on a value that was already correct.
  const held = {
    changes: [], review: [{ sku: 'MRS-002', channel: 'tiktok', from: 70, to: 74, reason: 'menaikkan stok +4 dari angka awal - pastikan barangnya memang ada' }],
    blocked: [], unchanged: [], unmanaged: [], missing: [],
  };
  const html = renderStock({ catalog, ledger, plan: held, ...common });
  assert.match(html, /name="vouch:MRS-002"/, 'a held row needs a vouch control');
  assert.ok(html.includes('Saya konfirmasi'), 'and it should say what it means');
});

test('a row that is not held shows no vouch control', () => {
  const html = renderStock({ catalog, ledger, plan, ...common });
  assert.ok(!html.includes('name="vouch:'), 'nothing to vouch for when nothing is held');
});

test('variants of one product are grouped together, singles are not', async () => {
  // Sorted by SKU the 45gr and 180gr land nowhere near each other; the master catalogue
  // knows they share a product name, and that is what the grid should follow.
  const { findProduct } = await import('../src/master.js');
  const entry = (sku) => ({
    sku, title: findProduct(sku)?.name ?? sku,
    tiktok: { qty: 10, price: 1, rows: [{ qty: 10, price: 1 }], ignored: [], conflict: false },
    shopee: null, shopify: null,
  });

  const html = renderStock({
    catalog: { skus: [entry('OMP-180-001'), entry('Bamboo-Scoop'), entry('OMP-45-001'), entry('OMP-90-001')], errors: {} },
    ledger: { skus: {} }, plan, ...common,
  });

  assert.match(html, /class="grp">Moringa Powder<span class="grp__n">3 varian/, 'the three sizes should form one group');
  assert.ok(!html.includes('>Bamboo Scoop<span class="grp__n"'), 'a single product needs no heading');

  // Inside the group the card shows the variant, since the name is already the heading.
  const order = [...html.matchAll(/class="st__name">([^<]*)/g)].map((m) => m[1].trim());
  assert.deepEqual(order.slice(0, 3), ['45 gram', '90 gram', '180 gram'], 'sizes should read in numeric order');
});

test('the ritual set sizes share one product name so they can group', async () => {
  const { findProduct } = await import('../src/master.js');
  const names = ['MRS-002', 'MRS-003', 'MRS-004'].map((s) => findProduct(s).name);
  assert.equal(new Set(names).size, 1, 'three powder sizes are one product, not three');
  for (const sku of ['MRS-002', 'MRS-003', 'MRS-004']) {
    assert.ok(findProduct(sku).variant, `${sku} needs a variant to tell it apart`);
  }
});

test('each stock card shows which channels it syncs to, and which it does not', async () => {
  // Shopify is read-only: its stock lives in location-scoped inventory levels and sync
  // never writes it. A card that drew all three identically would imply otherwise.
  const entry = {
    sku: 'OMP-45-001', title: 'Powder',
    tiktok: { qty: 10, price: 1, rows: [{ qty: 10, price: 1 }], ignored: [], conflict: false },
    shopee: { qty: 10, price: 1, rows: [{ qty: 10, price: 1 }], ignored: [], conflict: false },
    shopify: { qty: 10, price: 1, rows: [{ qty: 10, price: 1 }], ignored: [], conflict: false },
  };
  const html = renderStock({ catalog: { skus: [entry], errors: {} }, ledger: { skus: {} }, plan, ...common });

  assert.equal((html.match(/<span class="cm[^"]*"/g) ?? []).length, 3, 'all three channels need a mark');
  assert.equal((html.match(/<span class="cm[^"]*cm--ro/g) ?? []).length, 1, 'exactly one channel is read-only');
  assert.match(html, /title="Shopify - hanya dibaca[^"]*"/, 'and it must say so');
  assert.match(html, /title="Shopee - ikut disinkronkan"/);
  assert.equal((html.match(/class="cm__i[^"]*"/g) ?? []).length, 3, 'each mark needs its glyph');
  // Outline styling means two different things - a neutral glyph and a read-only channel -
  // so read-only carries a lock rather than relying on line weight alone.
  assert.equal((html.match(/class="cm__l"/g) ?? []).length, 1, 'read-only needs an unambiguous mark');
});

test('a channel out of step with the ledger is marked, not just listed', () => {
  const entry = {
    sku: 'A', title: 'A',
    tiktok: { qty: 10, price: 1, rows: [{ qty: 10, price: 1 }], ignored: [], conflict: false },
    shopee: { qty: 7, price: 1, rows: [{ qty: 7, price: 1 }], ignored: [], conflict: false },
    shopify: null,
  };
  const html = renderStock({
    catalog: { skus: [entry], errors: {} },
    ledger: { skus: { A: { qty: 10 } } }, plan, ...common,
  });
  assert.equal((html.match(/<span class="cm[^"]*cm--off/g) ?? []).length, 1, 'only the channel that differs is flagged');
});

test('filter chips carry their own counts and survive in the URL', () => {
  // A chip only appears when it has something to show, so the fixture needs a problem
  // for the attention chip to exist at all.
  const unmanaged = {
    skus: [{
      sku: 'ZZZ', title: 'Z',
      tiktok: { qty: 5, price: 1, rows: [{ qty: 5, price: 1 }], ignored: [], conflict: false },
      shopee: null, shopify: null,
    }],
    errors: {},
  };
  const html = renderStock({ catalog: unmanaged, ledger: { skus: {} }, plan, ...common });
  assert.match(html, /data-filter="attention"/, 'reviewing needs a way to see only problems');
  assert.match(html, /data-filter="all"/);
  assert.ok(html.includes('replaceState'), 'the chosen filter should be deep-linkable');
  assert.ok(html.includes('id="empty"'), 'an empty filter needs to explain itself');
});

test('the combined Tokopedia/TikTok column uses no invented brand logo', async () => {
  // Tokopedia has no Simple Icons entry. Drawing an approximation would be a fake brand
  // mark; a neutral storefront glyph with an honest label is the correct answer.
  const { renderStock } = await import('../src/dashboard-page.js');
  const entry = {
    sku: 'A', title: 'A',
    tiktok: { qty: 5, price: 1, rows: [{ qty: 5, price: 1 }], ignored: [], conflict: false },
    shopee: null, shopify: null,
  };
  const html = renderStock({ catalog: { skus: [entry], errors: {} }, ledger: { skus: {} }, plan, ...common });

  assert.match(html, /class="cm__i cm__i--o"/, 'the combined column should use the neutral glyph');
  assert.ok(html.includes('Tokped + TikTok'), 'and say it covers both storefronts');
  assert.match(html, /title="Tokopedia \+ TikTok Shop - ikut disinkronkan"/);
});

test('the shipment queue names the courier before anything is committed', () => {
  // Different couriers mean different dropoff points, so the split has to be visible
  // before the button is pressed, not discovered at the counter.
  const mk = (channel, status, id, carrier) => ({
    channel, id, status, carrier, stage: 'to_ship', createdAt: 1788900000,
    buyer: 'b', tracking: '', total: 1, lines: [], packageId: 'p', packageNumber: 'P',
  });
  const html = renderProcess({
    orders: [
      mk('shopee', 'READY_TO_SHIP', 'S1', 'JNE Reguler'),
      mk('shopee', 'READY_TO_SHIP', 'S2', 'JNE Reguler'),
      mk('tokopedia', 'AWAITING_SHIPMENT', 'T1', 'J&T Express'),
    ],
    ...common, csrf: 'tok',
  });

  assert.equal((html.match(/class="wo__car"/g) ?? []).length, 3, 'every card should name its courier');
  assert.match(html, /data-carrier="JNE Reguler"[^>]*>JNE Reguler <b>2<\/b>/, 'couriers should be counted');
  assert.match(html, /data-carrier=""[^>]*>Semua kurir <b>3<\/b>/);
});

test('an order with no courier yet says so rather than showing a blank', () => {
  const html = renderProcess({
    orders: [{
      channel: 'shopee', id: 'X', status: 'READY_TO_SHIP', stage: 'to_ship', carrier: '',
      createdAt: 1788900000, buyer: 'b', tracking: '', total: 1, lines: [], packageNumber: 'P',
    }],
    ...common, csrf: 'tok',
  });
  assert.ok(html.includes('kurir belum ditentukan'), 'an empty courier should be stated, not implied');
  assert.match(html, /data-carrier="Belum ditentukan"/);
});

test('the Jurnal view separates what is booked from what is only queued', () => {
  const overview = jurnalOverview();
  assert.equal(overview.queued, 1);
  assert.equal(overview.queuedValue, 100_000);
  assert.equal(overview.skipped, 1, 'pesanan batal tidak boleh masuk antrean');

  const html = renderJurnal({ overview, live: false, depositTo: null, configured: true, ...common });
  assert.match(html, /Antre/);
  assert.match(html, /Dilewati/);
  // Nothing may be posted while the brake is on, so no submit button is offered either.
  assert.match(html, /belum aktif/);
  assert.ok(!/name="action" value="mekari_sync"/.test(html), 'rem menyala tapi tombol kirim tetap muncul');
});

test('an order already in the ledger reads as booked, not as queued again', () => {
  const overview = syncOverview({
    orders: [booked],
    ledger: { orders: { 'TRL-shopee-260909ABC': { invoice_id: 77, total: 100_000, at: '2026-09-10T00:00:00Z' } } },
  });
  assert.equal(overview.synced, 1);
  assert.equal(overview.queued, 0);
  assert.match(renderJurnal({ overview, live: true, depositTo: 'Cash', configured: true, ...common }), /faktur 77/);
});

test('the send button appears only when live posting is on and something is queued', () => {
  const has = (html) => /name="action" value="mekari_sync"/.test(html);
  const overview = jurnalOverview();
  assert.equal(has(renderJurnal({ overview, live: true, depositTo: 'Cash', configured: true, ...common })), true);
  assert.equal(has(renderJurnal({ overview, live: true, depositTo: null, configured: false, ...common })), false,
    'tanpa kredensial tidak boleh ada tombol kirim');
  assert.equal(
    has(renderJurnal({ overview: syncOverview({ orders: [], ledger: { orders: {} } }), live: true, depositTo: null, configured: true, ...common })),
    false, 'antrean kosong tidak butuh tombol');
});

test('the Jurnal table shows the prefixed order code, not the bare platform id', () => {
  const html = renderJurnal({ overview: jurnalOverview(), live: false, depositTo: null, configured: true, ...common });
  assert.match(html, /SP-260909ABC/);
});

const manualPage = (over = {}) => renderManual({
  source: 'CS', code: 'CS-260911-001', today: '2026-09-11', contacts: ['Toko Sehat'],
  existingCodes: ['CS-260911-001'], live: true, depositTo: 'Cash', ...common, ...over,
});

test('the manual form offers every offline source and no online one', () => {
  const html = manualPage();
  for (const prefix of ['CS', 'LB', 'DP', 'DW', 'WS']) {
    assert.match(html, new RegExp(`value="${prefix}"`), prefix);
  }
  // An online sale must never be enterable by hand - it would duplicate the webhook.
  for (const prefix of ['SP', 'TP', 'TT', 'WA', 'WX']) {
    assert.ok(!new RegExp(`name="source" value="${prefix}"`).test(html), prefix);
  }
});

test('the form ships with a code, a date and one product row', () => {
  const html = manualPage();
  assert.match(html, /value="CS-260911-001"/);
  assert.match(html, /value="2026-09-11"/);
  // Counted in the markup only: the script below it also mentions the selector.
  const markup = html.split('<script>')[0];
  assert.equal((markup.match(/data-row/g) ?? []).length, 1, 'tepat satu baris awal');
  assert.match(html, /name="action" value="manual_invoice"/);
  assert.match(html, /name="csrf"/);
});

test('the submit button starts disabled, because an empty form is not a sale', () => {
  assert.match(manualPage(), /id="mxgo" disabled/);
});

test('the form says plainly when it cannot actually post yet', () => {
  assert.match(manualPage({ live: false }), /MEKARI_SYNC_LIVE/);
  assert.ok(!/MEKARI_SYNC_LIVE/.test(manualPage({ live: true }).split('<script>')[0]));
});

test('every number field in the manual form is wheel-guarded', () => {
  // The house rule: a focused number field must not change because the page scrolled.
  const body = manualPage().split('<script>').pop();
  assert.match(body, /addEventListener\('wheel'/);
  assert.match(body, /document\.activeElement !== input/);
});

test('the manual form is reachable from the Jurnal tab', () => {
  const html = renderJurnal({ overview: jurnalOverview(), live: false, depositTo: null, configured: true, ...common });
  assert.match(html, /\?view=jurnal&amp;add=1/);
});

test('a product with a picture shows it on its card and its detail page; one without says so', () => {
  const images = { 'MRS-002': { url: 'https://cdn.shopify.com/x/p.jpg?v=1', thumb: 'https://cdn.shopify.com/x/p.jpg?v=1&width=240', alt: 'Ritual', source: 'variant' } };
  const list = renderProducts({ catalog, ledger, ...common, images });
  assert.match(list, /class="card__img" src="https:\/\/cdn\.shopify\.com\/x\/p\.jpg\?v=1&amp;width=240"/);
  assert.match(list, /card__img--none/, 'produk tanpa gambar diberi tanda, bukan kotak kosong');
  const detail = renderProducts({ catalog, ledger, ...common, images, selected: 'MRS-002' });
  assert.match(detail, /class="pd__img"/);
  assert.match(detail, /terpasang di Jurnal/);
  const bare = renderProducts({ catalog, ledger, ...common, images: {}, selected: 'MRS-002' });
  // The stylesheet mentions the class on every page; only the element counts.
  assert.ok(!/class="pd__img"/.test(bare));
});

test('the manual form carries thumbnails for the product picker', () => {
  const html = renderManual({
    source: 'CS', code: 'CS-260911-001', today: '2026-09-11', contacts: [], existingCodes: [], live: true, depositTo: null,
    images: { 'OMP-45-001': { thumb: 'https://cdn.shopify.com/x/t.jpg?width=240' } }, ...common,
  });
  assert.match(html, /class="ln__pic"/);
  assert.match(html, /"OMP-45-001":"https:\/\/cdn\.shopify\.com\/x\/t\.jpg\?width=240"/);
});
