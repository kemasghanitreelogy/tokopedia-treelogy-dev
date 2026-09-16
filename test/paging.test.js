import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaging, paginate, withoutPaging, pageHref, pageWindow, DEFAULT_PER_PAGE } from '../src/paging.js';
import { filterOrders, summarize } from '../src/omni.js';
import { renderDashboard, renderJurnal, renderReviews } from '../src/dashboard-page.js';
import { syncOverview } from '../src/mekari/sync.js';

const params = (s) => new URLSearchParams(s);

test('paging comes from the URL, with junk and unknown sizes falling back', () => {
  assert.deepEqual(parsePaging(params('')), { page: 1, perPage: DEFAULT_PER_PAGE });
  assert.deepEqual(parsePaging(params('page=3&per=100')), { page: 3, perPage: 100 });
  assert.deepEqual(parsePaging(params('page=-2&per=33')), { page: 1, perPage: DEFAULT_PER_PAGE });
  assert.deepEqual(parsePaging(params('page=abc')), { page: 1, perPage: DEFAULT_PER_PAGE });
});

test('a page is a clamped slice with human-facing bounds', () => {
  const items = Array.from({ length: 120 }, (_, i) => i + 1);
  const p1 = paginate(items, { page: 1, perPage: 50 });
  assert.deepEqual([p1.from, p1.to, p1.pages, p1.total, p1.items.length], [1, 50, 3, 120, 50]);
  const p3 = paginate(items, { page: 3, perPage: 50 });
  assert.deepEqual([p3.from, p3.to, p3.items[0], p3.items.at(-1)], [101, 120, 101, 120]);
  const stale = paginate(items, { page: 40, perPage: 50 });
  assert.equal(stale.page, 3, 'a stale link lands on the last page, not an empty one');
  const empty = paginate([], { page: 2, perPage: 50 });
  assert.deepEqual([empty.page, empty.pages, empty.from, empty.to], [1, 1, 0, 0]);
});

test('page links keep every other parameter and leave defaults implicit', () => {
  const base = withoutPaging(params('view=orders&preset=30d&channel=shopee&page=4&per=100'));
  assert.equal(base, 'view=orders&preset=30d&channel=shopee');
  assert.equal(pageHref(base, 1), '?view=orders&preset=30d&channel=shopee');
  assert.equal(pageHref(base, 2), '?view=orders&preset=30d&channel=shopee&page=2');
  assert.equal(pageHref(base, 1, 100), '?view=orders&preset=30d&channel=shopee&per=100');
});

test('the page window always shows the ends and never grows past nine entries', () => {
  assert.deepEqual(pageWindow(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageWindow(1, 44), [1, 2, 3, 4, 5, 6, null, 44]);
  assert.deepEqual(pageWindow(6, 44), [1, null, 4, 5, 6, 7, 8, null, 44]);
  assert.deepEqual(pageWindow(44, 44), [1, null, 39, 40, 41, 42, 43, 44]);
  for (let p = 1; p <= 200; p++) assert.ok(pageWindow(p, 200).length <= 9, `page ${p}`);
});

const order = (id, extra = {}) => ({
  id, channel: 'shopee', stage: 'to_ship', buyer: 'Wiwik', tracking: '', total: 10000, createdAt: 1_789_000_000 + Number(id),
  carrier: 'JNE', status: 'READY_TO_SHIP', ...extra,
});

test('server-side order filters read the same three fields the old client search did', () => {
  const orders = [order(1), order(2, { channel: 'tiktok_shop', stage: 'shipping', tracking: 'JX123' }), order(3, { buyer: 'Elisa' })];
  assert.deepEqual(filterOrders(orders, {}).map((o) => o.id), [1, 2, 3]);
  assert.deepEqual(filterOrders(orders, { channel: 'tiktok_shop' }).map((o) => o.id), [2]);
  assert.deepEqual(filterOrders(orders, { stage: 'to_ship' }).map((o) => o.id), [1, 3]);
  assert.deepEqual(filterOrders(orders, { q: 'jx1' }).map((o) => o.id), [2]);
  assert.deepEqual(filterOrders(orders, { q: 'ELISA' }).map((o) => o.id), [3]);
  assert.deepEqual(filterOrders(orders, { channel: 'shopee', stage: 'to_ship', q: 'wiw' }).map((o) => o.id), [1]);
});

const range = { preset: '30d', from: '2026-08-17', to: '2026-09-16', label: '30 hari' };
const common = { range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf: 'tok' };

test('the orders view renders one page, links the others, and keeps filters in every link', () => {
  const all = Array.from({ length: 130 }, (_, i) => order(String(i + 1).padStart(3, '0'), i % 2 ? { channel: 'tiktok_shop' } : {}));
  const filter = { channel: 'shopee', stage: 'all', q: '' };
  const orders = filterOrders(all, filter);
  const baseQuery = 'view=orders&preset=30d&channel=shopee';
  const html = renderDashboard({ orders, summary: summarize(all), filter, paging: { page: 2, perPage: 25 }, baseQuery, ...common });

  assert.equal((html.match(/<tr data-channel/g) ?? []).length, 25, 'one page of rows');
  assert.match(html, /Menampilkan <b>26&ndash;50<\/b> dari <b>65<\/b> pesanan cocok/);
  assert.match(html, /href="\?view=orders&amp;preset=30d&amp;channel=shopee&amp;page=3&amp;per=25" rel="next"/);
  assert.match(html, /href="\?view=orders&amp;preset=30d&amp;channel=shopee&amp;per=25" rel="prev"/, 'page one is implicit');
  assert.match(html, /aria-current="page">2</);
  assert.match(html, /class="chip is-on" href="\?view=orders&amp;preset=30d&amp;channel=shopee" style="[^"]*" aria-current="true">Shopee/);
  assert.match(html, /class="chip " href="\?view=orders&amp;preset=30d">Semua kanal/, 'the chip that clears the channel drops the parameter and the page');
  assert.match(html, /name="channel" value="shopee"/, 'the search form carries the chips along');
  assert.doesNotMatch(html, /data-search=/, 'the old client-side filter data is gone with the script that read it');
  assert.match(html, /130 pesanan pada rentang ini/);

  const none = renderDashboard({ orders: [], summary: summarize(all), filter: { channel: 'all', stage: 'all', q: 'zzz' }, paging: { page: 1, perPage: 50 }, baseQuery: 'view=orders&q=zzz', ...common });
  assert.match(none, /Tidak ada pesanan yang cocok/);
  assert.match(none, /Hapus pencarian/);
});

test('jurnal and reviews page the same way', () => {
  const booked = { ...order(1), finance: { lines: [{ sku: 'OMP-45-001', name: 'A', qty: 1, unitPrice: 50_000, unitDiscount: 0 }], shipping: 0 } };
  const many = Array.from({ length: 60 }, (_, i) => ({ ...booked, id: `J${i}`, createdAt: booked.createdAt + i }));
  const overview = syncOverview({ orders: many, ledger: { orders: {} } });
  const jurnal = renderJurnal({ overview, live: false, depositTo: null, configured: true, paging: { page: 2, perPage: 50 }, baseQuery: 'view=jurnal&preset=30d', ...common });
  assert.equal((jurnal.match(/<tr data-state/g) ?? []).length, 10);
  assert.match(jurnal, /dari <b>60<\/b> pesanan/);

  const review = (i) => ({ id: String(i), channel: 'shopee', productName: 'X', productUrl: '', variantName: '', sku: null, rating: 5, text: 't', reviewerName: 'a', anonymous: false, createdAt: '2026-09-01T00:00:00.000Z', createdAtEpoch: 1_788_000_000 + i, createdAtPrecision: 'exact', createdAtRelative: '', reply: null, images: [], videos: [], likes: 0 });
  const reviews = Array.from({ length: 120 }, (_, i) => review(i));
  const doc = { syncedAt: '2026-09-15T00:00:00.000Z', channels: { shopee: { syncedAt: '2026-09-15T00:00:00.000Z', summary: { score: 5, totalRatings: 120, distribution: { 5: 120 } } } }, reviews: Object.fromEntries(reviews.map((r) => [`shopee:${r.id}`, r])) };
  const stats = { written: { count: 120, average: 5, low: 0 }, last30Days: { count: 0, average: null, low: 0 }, byRating: { 5: 120 }, bySku: {}, byChannel: { shopee: { count: 120, average: 5, low: 0 } }, unreplied: 120 };
  const html = renderReviews({ doc, stats, reviews, paging: { page: 3, perPage: 50 }, baseQuery: 'view=reviews&channel=shopee', ...common });
  assert.equal((html.match(/<article class="rv /g) ?? []).length, 20);
  assert.match(html, /Menampilkan <b>101&ndash;120<\/b> dari <b>120<\/b> ulasan/);
  assert.match(html, /href="\?view=reviews&amp;channel=shopee&amp;page=2" rel="prev"/);
});
