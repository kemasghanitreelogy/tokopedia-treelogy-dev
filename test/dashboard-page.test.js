import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDashboard, renderPicklist, renderLabels, renderProducts, renderProcess, renderStock, renderJurnal,
  renderManual, renderForecast, renderLogin,
} from '../src/dashboard-page.js';
import { syncOverview } from '../src/mekari/sync.js';
import { summarize, filterOrders } from '../src/omni.js';
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
  for (const id of ['pickall', 'head', 'n']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  assert.ok(html.includes('class="pick"'), 'missing order checkboxes');
  // One control that says what pressing it does, rather than two that say what is true.
  assert.ok(!html.includes('id="all"') && !html.includes('id="none"'));
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

test('a gradient that carries white text uses a fill that can carry it', () => {
  // White on #8FA97F is 2.58:1 - unreadable. A gradient is only as legible as its
  // lightest stop, so any fill behind white text uses the deep sage (--fill-a/--fill-b)
  // or the commit orange (--cta-a/--cta-b, 4.6:1 at its lightest stop). A 2px progress
  // bar carries no text and is exempt.
  for (const [name, html] of pages()) {
    const rules = [...html.matchAll(/\{[^{}]*linear-gradient\([^)]*\)[^{}]*\}/g)].map((m) => m[0]);
    for (const rule of rules) {
      if (!/color:\s*#fff/i.test(rule)) continue;
      assert.match(rule, /var\(--(fill|cta)-a\)/, `${name} puts white text on a non-fill gradient`);
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

test('Shopify stands in the same queue, under the same button', () => {
  const html = renderProcess({
    orders: [
      processOrder('shopify', 'PAID/UNFULFILLED', 'SHOPIFY1'),
      processOrder('shopee', 'READY_TO_SHIP', 'SHOPEE1'),
    ],
    ...common, csrf: 'tok',
  });
  assert.match(html, /SHOPIFY1/);
  assert.match(html, /<h3>Shopify<span class="wl__n">1<\/span>/);
  assert.match(html, /name="order" value="shopify:SHOPIFY1"/, 'ikut satu seleksi dengan yang lain');
  assert.match(html, /Atur pengiriman <span id="n">2<\/span> pesanan/, 'satu tombol untuk dua kanal');
  assert.ok(!html.includes('Cetak'), 'label dicetak di menu Label, bukan di sini');

  // Once it has been arranged, our own record is what takes it out of the queue.
  const done = renderProcess({
    orders: [processOrder('shopify', 'PAID/UNFULFILLED', 'SHOPIFY1')],
    arranged: { SHOPIFY1: { at: 1 } }, ...common, csrf: 'tok',
  });
  assert.ok(!done.includes('SHOPIFY1'));
  assert.match(done, /Semua pesanan sudah diatur/);
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
  assert.match(manualPage({ live: false }), /Sinkronisasi belum aktif/);
  assert.ok(!/Sinkronisasi belum aktif/.test(manualPage({ live: true }).split('<script>')[0]));
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


const forecastFixture = {
  generated_at: '2026-09-14T02:30:00.000Z',
  policy: { leadTimeDays: 21, reviewDays: 7 },
  history: { from: '2025-02-26', to: '2026-09-14', orders: 22658, excluded: 1204, unknownSkus: [] },
  counts: { stockout: 1, critical: 2, watch: 1, ok: 5, idle: 0 },
  rows: [
    {
      sku: 'OMP-45-001', name: 'Moringa Powder - 45 gram', status: 'ok', historyDays: 560,
      onHand: 30, sold90: 900, weekly: [40, 52, 48, 61, 55, 70, 66, 58, 72, 64, 69, 75],
      forecasts: { 30: { horizon: 30, p50: 300, p10: 240, p90: 390 } },
      accuracy: { 30: { model: 'hw7', modelName: 'Holt-Winters mingguan', mase: 0.74, beatsNaive: true } },
      stock: { daysOfCover: 3, stockoutDate: '2026-09-17', reorderQty: 313 }, urgency: 'critical',
    },
    {
      sku: 'Bamboo-Whisk', name: 'Bamboo Whisk - 120 prongs', status: 'belum cukup data',
      historyDays: 12, onHand: 40, forecasts: {}, accuracy: {}, stock: null, urgency: 'idle',
    },
    {
      sku: 'OMC-90-001', name: 'Moringa Capsules - 90 caps', status: 'ok', historyDays: 500,
      onHand: 500, sold90: 300, weekly: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
      forecasts: { 30: { horizon: 30, p50: 20, p10: 10, p90: 40 } },
      accuracy: { 30: { model: 'snaive', modelName: 'Seasonal naive', mase: 1.12, beatsNaive: false } },
      stock: { daysOfCover: 750, stockoutDate: null, reorderQty: 0 }, urgency: 'ok',
    },
  ],
};

test('the forecast view leads with urgency and carries the accuracy of every number', () => {
  const html = renderForecast({ forecast: forecastFixture, ...common });
  assert.match(html, /fc__u--critical/);
  assert.match(html, /Moringa Powder - 45 gram/);
  assert.match(html, /240&ndash;390/, 'rentang p10-p90 harus tampil, bukan satu angka');
  assert.match(html, /MASE/);
  assert.match(html, /0\.74/);
  assert.match(html, /313/, 'jumlah yang harus dipesan');
  assert.match(html, /2026-09-17/, 'tanggal perkiraan habis');
  // A model that did not beat naive must say so rather than look authoritative.
  assert.match(html, /tak lebih baik dari pola minggu lalu/);
  // A SKU without enough history gets no number at all.
  assert.match(html, /Belum cukup riwayat \(12 hari/);
  assert.ok(!/Bamboo Whisk[\s\S]{0,200}MASE/.test(html));
});

test('a sparkline is drawn inline, and a series too short to plot says so', () => {
  const html = renderForecast({ forecast: forecastFixture, ...common });
  assert.match(html, /<svg class="fc__spark"[\s\S]*?<path d="M0\.0,/);
  const flat = { ...forecastFixture, rows: [{ ...forecastFixture.rows[0], weekly: [3] }] };
  const html2 = renderForecast({ forecast: flat, ...common });
  assert.ok(!/<svg class="fc__spark"/.test(html2));
});

test('with no forecast yet the page says so, rather than breaking', () => {
  const html = renderForecast({ forecast: null, ...common });
  assert.match(html, /Belum ada prakiraan/);
});

test('the manual form asks who the parcel goes to, and fills a price when one is known', () => {
  const html = renderManual({
    source: 'CS', code: 'CS-260918-001', today: '2026-09-18', contacts: [], existingCodes: [],
    live: true, seqTail: '0000001', prices: { 'OMP-45-001': 199000 }, ...common,
  });

  // One customer, typed once: the name on the parcel is the contact the invoice bills,
  // so the second "Pelanggan" box that used to sit under Detail is gone.
  assert.ok(!html.includes('name="customer"'), 'kolom pelanggan ganda masih ada');
  assert.match(html, /<label for="buyer">Nama pelanggan<\/label>/);
  assert.match(html, /<input id="buyer" name="buyer" list="mxcontacts"/, 'kontak Jurnal yang sudah ada tetap bisa dipilih');
  assert.match(html, /<label for="buyerPhone">Nomor telepon<\/label>/);
  assert.match(html, /<input id="buyerEmail" name="buyerEmail" type="email"/);
  assert.match(html, /<label for="shipTo">Alamat<\/label>/);
  assert.match(html, /<textarea id="shipTo" name="shipTo"/);

  // A fixed courier list, so one courier is one name in the books.
  for (const courier of ['Grab Express Instant', 'Lion Parcel', 'JNE', 'J&amp;T', 'PAXEL', 'DHL Express']) {
    assert.ok(html.includes(`<option value="${courier}">${courier}</option>`), `kurir ${courier} tidak ada`);
  }

  // The price rides on the option, so choosing a product needs no request.
  assert.match(html, /<option value="OMP-45-001" data-price="199000">/);
  assert.match(html, /data-price="0"/, 'produk tanpa harga tersimpan tetap bisa dipilih');
  assert.match(html, /function fillPrice/);
  assert.match(html, /if \(price > 0 && !field\.value\)/, 'harga yang sudah diketik tidak ditimpa');
});

test('each discount cell can be switched between rupiah and percent', () => {
  const html = renderManual({
    source: 'CS', code: 'CS-260918-001', today: '2026-09-18', contacts: [], existingCodes: [],
    live: true, seqTail: '0000001', prices: {}, ...common,
  });
  assert.match(html, /<span class="seg" role="group"/);
  assert.match(html, /data-mode="rp" aria-pressed="true">Rp</);
  assert.match(html, /data-mode="pct" aria-pressed="false">%</);
  assert.match(html, /<input type="hidden" name="discountMode" value="rp">/, 'rupiah tetap bawaan');
  // The browser's arithmetic is a courtesy; it still has to agree with the server's.
  assert.match(html, /function discountOf/);
  assert.match(html, /Math\.round\(price \* Math\.min\(value, 100\) \/ 100\)/);
});

test('the cut-off is three in the afternoon in the shop own clock, whatever the server thinks', async () => {
  const { dispatchCutoff, DISPATCH_HOUR_WITA } = await import('../src/dashboard-page.js');
  assert.equal(DISPATCH_HOUR_WITA, 15);
  const wita = (iso) => Math.floor(Date.parse(iso) / 1000);
  const reads = (epoch) => new Date(dispatchCutoff(epoch) * 1000)
    .toLocaleString('sv-SE', { timeZone: 'Asia/Makassar' });

  // Morning, afternoon and late night on the same WITA day all mean the same van.
  assert.equal(reads(wita('2026-09-18T08:00:00+08:00')), '2026-09-18 15:00:00');
  assert.equal(reads(wita('2026-09-18T15:30:00+08:00')), '2026-09-18 15:00:00');
  assert.equal(reads(wita('2026-09-18T23:59:00+08:00')), '2026-09-18 15:00:00');
  // And a minute later is the next day's van.
  assert.equal(reads(wita('2026-09-19T00:01:00+08:00')), '2026-09-19 15:00:00');
});

test('the process page can select everything that still makes today van', async () => {
  const { dispatchCutoff } = await import('../src/dashboard-page.js');
  const now = Date.parse('2026-09-18T16:00:00+08:00');
  const cutoff = dispatchCutoff(Math.floor(now / 1000));
  const at = (offset) => ({ ...processOrder('shopee', 'READY_TO_SHIP', `S${offset}`), createdAt: cutoff + offset });

  const html = renderProcess({
    orders: [at(-3600), at(-60), at(60)], ...common, csrf: 'tok', generatedAt: now,
  });
  assert.match(html, /data-early>Masuk sebelum 15\.00 WITA <b>2<\/b>/, 'dua dari tiga masih terkejar');
  assert.equal((html.match(/data-early="1"/g) ?? []).length, 2);
  assert.equal((html.match(/data-early="0"/g) ?? []).length, 1);

  // Nothing to choose between when every order is on the same side of the line.
  const allEarly = renderProcess({ orders: [at(-3600), at(-60)], ...common, csrf: 'tok', generatedAt: now });
  assert.ok(!allEarly.includes('data-early>'), 'tombolnya tidak muncul kalau semua sama');
});

test('a typed-in sale sits in the order list, opens, and offers its invoice', () => {
  const manual = {
    channel: 'manual', id: 'CS-260921-0000125', createdAt: 1789992000, status: 'MANUAL', stage: 'completed',
    source: 'CS', customer: 'Toko Sehat', buyer: 'Toko Sehat', buyerPhone: '0812-3456-7890', buyerEmail: 'toko@contoh.id',
    shipTo: 'Jln. Belida 1, Tenggarong', carrier: 'JNE', tracking: '', total: 300000, currency: 'IDR', items: 1,
    note: 'titip - ditambahkan oleh Dewi',
    lines: [{ sku: 'OMP-45-001', name: 'Moringa Powder - 45 gram', qty: 2 }],
    finance: { lines: [{ sku: 'OMP-45-001', name: 'Moringa Powder - 45 gram', qty: 2, unitPrice: 150000, unitDiscount: 0 }], shipping: 0 },
  };
  const orders = [manual, order];
  const html = renderDashboard({ orders, summary: summarize(orders), ...common });
  assert.match(html, /<span class="tag" style="--accent:#C2531C">Manual<\/span>/, 'the row names its channel');
  assert.match(html, /aria-label="Rincian pesanan CS-260921-0000125"/, 'the row opens like any other');
  assert.match(html, /href="\/api\/invoice\?channel=manual&amp;id=CS-260921-0000125"/, 'the popup offers the invoice');
  assert.match(html, /class="chip [^"]*" href="\?channel=manual" style="--chip:#C2531C"[^>]*>Manual</, 'a chip filters down to typed-in sales');
  assert.ok(!/<article class="ch" style="--accent:#C2531C">/.test(html), 'no channel card: nothing is pulled or shipped for it');
  // Its money counts with everybody else's.
  assert.equal(summarize(orders).all.revenue, summarize([order]).all.revenue + 300000);
  assert.equal(summarize(orders).byChannel.manual.count, 1);
  // And the filter reaches it.
  const only = renderDashboard({ orders: filterOrders(orders, { channel: 'manual' }), summary: summarize(orders), filter: { channel: 'manual' }, ...common });
  assert.ok(only.includes('CS-260921-0000125') && !only.includes(`Rincian pesanan ${order.id}`));
});

test('the reviews page offers a fresh pull and the Klaviyo file', async () => {
  const { renderReviews } = await import('../src/dashboard-page.js');
  const doc = { syncedAt: '2026-09-21T00:00:00.000Z', channels: {}, reviews: {} };
  const stats = { written: { count: 0, low: 0, average: null }, last30Days: { count: 0, low: 0, average: null }, unreplied: 0, byRating: {}, bySku: {}, byChannel: {} };
  const html = renderReviews({ doc, stats, reviews: [], baseQuery: 'view=reviews&channel=shopee', ...common });
  assert.match(html, /name="action" value="reviews_sync"/, 'no button to pull new reviews');
  assert.match(html, /data-confirm-text="Ambil ulasan baru/, 'a pull that reads two marketplaces asks first');
  assert.match(html, /href="\?view=reviews&amp;channel=shopee&amp;export=klaviyo" download/, 'the file follows the filters');
  assert.match(html, /Unduh CSV Klaviyo/);
  // A viewer gets neither the form nor the file: no csrf, no form.
  const viewer = renderReviews({ doc, stats, reviews: [], ...common, csrf: '' });
  assert.ok(!viewer.includes('reviews_sync'));
});

test('a success note leaves after two seconds, an error note stays', () => {
  const ok = renderDashboard({ orders: [order], summary: summarize([order]), ...common, flash: { kind: 'ok', text: 'tersimpan' } });
  assert.match(ok, /<div class="alert alert--ok" data-brief role="status">/);
  assert.ok(ok.includes("querySelectorAll('.alert[data-brief]')"), 'the note is never scheduled to leave');
  assert.ok(ok.includes('}, 2000);'), 'two seconds, as asked');
  assert.ok(ok.includes("searchParams.delete('done')"), 'the done flag must be stripped so a reload cannot bring it back');
  const bad = renderDashboard({ orders: [order], summary: summarize([order]), ...common, flash: { kind: 'error', text: 'gagal' } });
  assert.match(bad, /<div class="alert " role="status">/);
  assert.ok(!/<div class="alert [^>]*data-brief/.test(bad), 'an error must not disappear on its own');
});

test('a saved manual sale is celebrated once, and an ordinary flash is not', () => {
  const plain = renderDashboard({ orders: [order], summary: summarize([order]), ...common,
    flash: { kind: 'ok', text: 'CS-260921-0000070 tersimpan di Jurnal senilai Rp2.380.000' } });
  assert.ok(!plain.includes('id="yay"'), 'a plain success flash must not throw confetti');

  const party = renderDashboard({ orders: [order], summary: summarize([order]), ...common,
    flash: { kind: 'ok', text: 'CS-260921-0000070 tersimpan di Jurnal senilai Rp2.380.000', celebrate: { title: 'Tersimpan di Jurnal' } } });
  assert.match(party, /<div class="yay" id="yay" role="status"/, 'the celebration overlay is missing');
  assert.match(party, /<h2 class="yay__title">Tersimpan di Jurnal<\/h2>/);
  assert.ok(party.includes('CS-260921-0000070 tersimpan di Jurnal senilai Rp2.380.000'), 'the overlay repeats what was saved');
  // Deterministic confetti: the same burst every time, built on the server.
  const particles = party.match(/class="pt pt--(dot|chip|arc)"/g) ?? [];
  assert.equal(particles.length, 52);
  assert.equal(party.match(/class="pt pt--/g).length, renderDashboard({ orders: [order], summary: summarize([order]), ...common,
    flash: { kind: 'ok', text: 'x', celebrate: { title: 'y' } } }).match(/class="pt pt--/g).length);
  // It leaves on its own, and it takes its own query flag out of the address bar.
  assert.ok(party.includes("searchParams.delete('yay')"), 'the yay flag must be stripped so a reload cannot replay it');
  assert.ok(party.includes('prefers-reduced-motion: reduce'), 'the celebration ignores the motion preference');
  assert.match(party, /id="yay-ok"/, 'there is no way to dismiss it by hand');
});

test('every page carries one confirmation dialog, and nothing falls back to the browser', () => {
  for (const [name, html] of pages()) {
    if (name === 'login') continue;
    assert.match(html, /<dialog class="cf" id="confirm"/, `${name}: tidak punya dialog konfirmasi`);
    assert.match(html, /id="cf-yes"/, `${name}: tidak punya tombol lanjutkan`);
    assert.match(html, /id="cf-no"/, `${name}: tidak punya tombol batal`);
    // window.confirm survives only as the fallback inside the dialog helper itself.
    const calls = (html.match(/window\.confirm\(/g) ?? []).length;
    assert.equal(calls, 1, `${name}: masih memanggil window.confirm ${calls} kali`);
    assert.match(html, /if \(!dialog \|\| !dialog\.showModal\) return Promise\.resolve\(window\.confirm/);
  }
});

test('a cancelled submit takes the loading skeleton down with it', () => {
  // The bug this guards: the loader is armed on submit in the capture phase, and every
  // confirmation cancels that submit in a later phase. Pressing Batal left a skeleton
  // over the page forever, with no way back but a reload.
  const [, html] = pages().find(([name]) => name === 'manual');
  assert.match(html, /function endNavigation\(\)/);
  assert.match(html, /window\.setTimeout\(function \(\) \{ if \(e\.defaultPrevented\) endNavigation\(\); \}, 0\);/);
  // And the question is asked before the form is allowed through, not after.
  assert.match(html, /form\.dataset\.confirmed = '1';/);
  assert.match(html, /form\.requestSubmit\(submitter \|\| undefined\)/, 'tombol yang menekan ikut terkirim');
});

test('the dialog answers no to escape, to the backdrop and to nothing at all', () => {
  const [, html] = pages().find(([name]) => name === 'stock');
  assert.match(html, /dialog\.addEventListener\('close', onClose\)/);
  assert.match(html, /function onBackdrop\(e\) \{ if \(e\.target === dialog\) finish\(false\); \}/);
  assert.match(html, /no\.focus\(\);/, 'pilihan aman yang mendapat fokus');
});
