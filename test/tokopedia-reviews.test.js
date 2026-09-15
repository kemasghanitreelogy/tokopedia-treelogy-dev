import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRelativeTime, matchSku, normalizeShopReview, mergeReviews, crawlShopReviews, fetchExactTimes,
  syncReviews, loadReviews, selectReviews, reviewStats, toCsv, REVIEWS_DOC, SHOP_PAGE_SIZE,
} from '../src/tokopedia/reviews.js';
import { gql, resetPacer, TokopediaError } from '../src/tokopedia/gql.js';
import { formatLowReview, notifyReviewSync } from '../src/tokopedia/notify.js';
import { deleteDoc, closeStore } from '../src/store/index.js';
import { renderReviews, VIEWS } from '../src/dashboard-page.js';

test.after(async () => { await closeStore(); });

const NOW = 1_789_500_000; // 2026-09-15-ish
const noSleep = async () => {};

/** A fetch that answers from a table of operation -> (variables) => data, in the gateway's array envelope. */
function fakeGateway(table, { status = 200, log = [] } = {}) {
  return async (url, init) => {
    const [{ operationName, variables }] = JSON.parse(init.body);
    log.push({ operationName, variables });
    const answer = table[operationName];
    if (!answer) return { status: 200, ok: true, text: async () => JSON.stringify([{ data: null, errors: [{ message: 'Invalid request schema received. Kindly correct it.' }] }]) };
    const data = answer(variables);
    return { status, ok: status < 400, text: async () => JSON.stringify([{ data }]) };
  };
}

const shopRaw = (id, extra = {}) => ({
  id,
  product: {
    productID: '16441446901', productName: 'TREELOGY - Organic Moringa Capsules', productImageURL: 'img',
    productPageURL: 'https://www.tokopedia.com/treelogy-moringa/x-1731010208236537819', productStatus: 0, isDeletedProduct: false,
    productVariant: { variantID: '1', variantName: '270 Caps' },
  },
  rating: 5, reviewTime: '4 hari lalu', reviewText: 'mantab', reviewerID: '7', reviewerName: 'Lith', avatar: '',
  replyText: '', replyTime: '', attachments: [], videoAttachments: [], state: { isReportable: false, isAnonymous: false },
  likeDislike: { totalLike: 0, likeStatus: 0 }, badRatingReasonFmt: '',
  ...extra,
});

// --- time

test('relative Indonesian time becomes a floor epoch; absolute dates and junk are handled', () => {
  assert.equal(parseRelativeTime('4 hari lalu', NOW), NOW - 4 * 86400);
  assert.equal(parseRelativeTime('1 minggu lalu', NOW), NOW - 7 * 86400);
  assert.equal(parseRelativeTime('2 bulan yang lalu', NOW), NOW - 60 * 86400);
  assert.equal(parseRelativeTime('3 jam lalu', NOW), NOW - 3 * 3600);
  assert.equal(parseRelativeTime('baru saja', NOW), NOW);
  assert.equal(parseRelativeTime('12 Mar 2025', NOW), Math.floor(Date.UTC(2025, 2, 12, 5) / 1000));
  assert.equal(parseRelativeTime('12 Maret 2025', NOW), Math.floor(Date.UTC(2025, 2, 12, 5) / 1000));
  assert.equal(parseRelativeTime('', NOW), null);
  assert.equal(parseRelativeTime('kapan-kapan', NOW), null);
});

// --- sku

test('the variant name decides the SKU; the URL id is the fallback for listings without variants', () => {
  const url = 'https://www.tokopedia.com/treelogy-moringa/x-1731010208236537819';
  assert.equal(matchSku({ productName: 'Organic Moringa Capsules', productUrl: url, variantName: '270 Caps' }), 'OMC-270-001');
  assert.equal(matchSku({ productName: 'Organic Moringa Capsules', productUrl: url, variantName: '180 Caps' }), 'OMC-180-001');
  assert.equal(matchSku({ productName: 'Moringa Powder 90 gram', productUrl: url, variantName: '' }), 'OMP-90-001');
  assert.equal(matchSku({ productName: 'Moringa Seed Oil', variantName: '30 ml' }), 'OMO-30-001');
  assert.equal(matchSku({ productName: 'Kapsul', productUrl: 'https://www.tokopedia.com/treelogy-moringa/y-1731010208236668891', variantName: '' }), 'OMC-180-001');
  assert.equal(matchSku({ productName: 'Sesuatu', productUrl: 'https://www.tokopedia.com/treelogy-moringa/z-1', variantName: '' }), null);
});

test('sets are recognised by name before any quantity in the title is read', () => {
  assert.equal(matchSku({ productName: 'TREELOGY - Inside Out Moringa Protocol 30 Days | Set Suplemen' }), 'The-Inside-&-Out30');
  assert.equal(matchSku({ productName: 'TREELOGY - Inside Out Moringa Protocol 60 Days | Set Suplemen' }), 'The-Inside-&-Out60');
  assert.equal(matchSku({ productName: 'Treelogy The Discovery Pack | Minyak, Bubuk & Kapsul Kelor' }), 'The-Discovery-Pack');
  assert.equal(matchSku({ productName: 'TREELOGY The Movement & Relief | Moringa Daun Kelor Premium' }), 'The-Movement-&-Relief');
  assert.equal(matchSku({ productName: 'TREELOGY - Moringa Ritual Set | Komplit Bamboo Set Box & Bubuk 45 gram' }), 'MRS-001');
  assert.equal(matchSku({ productName: '(FREE GIFT - DO NOT ORDER) TREELOGY Moringa Capsule', variantName: 'Capsules 180' }), 'OMC-180-001');
  assert.equal(matchSku({ productName: 'Treelogy Consistency Pack | 180 Kapsul + 90g Bubuk' }), null, 'a pack the master list does not know is not 180 capsules');
});

// --- normalisation

test('a shop-list review normalises with an approximate time and its SKU', () => {
  const r = normalizeShopReview(shopRaw('1'), { shopId: '17210983', nowEpoch: NOW });
  assert.equal(r.id, '1');
  assert.equal(r.sku, 'OMC-270-001');
  assert.equal(r.createdAtPrecision, 'approx');
  assert.equal(r.createdAtEpoch, NOW - 4 * 86400);
  assert.equal(r.reply, null);
  const replied = normalizeShopReview(shopRaw('2', { replyText: 'terima kasih', replyTime: '1 hari lalu' }), { shopId: '1', nowEpoch: NOW });
  assert.equal(replied.reply.text, 'terima kasih');
  assert.equal(replied.reply.atEpoch, NOW - 86400);
});

// --- merge

test('merge keeps an exact time over a later approximate one and reports what changed', () => {
  const nowIso = '2026-09-15T00:00:00.000Z';
  const first = normalizeShopReview(shopRaw('1'), { shopId: '1', nowEpoch: NOW });
  const exact = new Map([['1', { id: '1', createdAtEpoch: 1789090887, createdAt: '2026-09-10T20:21:27.000Z', rating: 5 }]]);
  const one = mergeReviews({}, [first], { exact, nowIso });
  assert.equal(one.added.length, 1);
  assert.equal(one.reviews['1'].createdAtPrecision, 'exact');
  assert.equal(one.reviews['1'].createdAtEpoch, 1789090887);

  // Next day: same review, relative text moved on, the shop has replied.
  const again = normalizeShopReview(shopRaw('1', { reviewTime: '5 hari lalu', replyText: 'makasih', replyTime: 'baru saja' }), { shopId: '1', nowEpoch: NOW + 86400 });
  const two = mergeReviews(one.reviews, [again], { exact: new Map(), nowIso: '2026-09-16T00:00:00.000Z' });
  assert.equal(two.added.length, 0);
  assert.equal(two.updated.length, 1, 'a new reply is a change');
  assert.equal(two.reviews['1'].createdAtPrecision, 'exact', 'the exact time survives');
  assert.equal(two.reviews['1'].createdAtEpoch, 1789090887);
  assert.equal(two.reviews['1'].reply.text, 'makasih');
  assert.equal(two.reviews['1'].firstSeenAt, nowIso);

  // And once more with nothing different: silence.
  const three = mergeReviews(two.reviews, [again], { exact: new Map(), nowIso: '2026-09-17T00:00:00.000Z' });
  assert.equal(three.updated.length, 0);
});

// --- crawl

test('the shop crawl pages to the end, or stops at the first page with nothing new when asked', async () => {
  resetPacer();
  const pages = { 1: ['a', 'b'], 2: ['c'] };
  const log = [];
  const fetchImpl = fakeGateway({
    ReviewList: ({ page }) => ({ productrevGetShopReviewReadingList: { list: (pages[page] ?? []).map((id) => shopRaw(id)), hasNext: page < 2, shopName: 'Treelogy', totalReviews: 3 } }),
  }, { log });

  const full = await crawlShopReviews({ shopId: '1', nowEpoch: NOW, fetchImpl, sleepImpl: noSleep, minGapMs: 0 });
  assert.deepEqual(full.reviews.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(full.pages, 2);
  assert.equal(full.shopName, 'Treelogy');
  assert.equal(log[0].variables.limit, SHOP_PAGE_SIZE);

  const quick = await crawlShopReviews({ shopId: '1', nowEpoch: NOW, knownIds: new Set(['a', 'b']), stopWhenKnown: true, fetchImpl, sleepImpl: noSleep, minGapMs: 0 });
  assert.equal(quick.pages, 1, 'page one was all known, so page two was never asked for');
});

test('exact times are fetched per product and paging stops once every wanted id is seen', async () => {
  resetPacer();
  const log = [];
  const fetchImpl = fakeGateway({
    productReviewList: ({ productID, page }) => ({
      productrevGetProductReviewList: {
        productID,
        list: page === 1
          ? [{ id: 'a', productRating: 5, reviewCreateTime: '1789090887' }, { id: 'b', productRating: 4, reviewCreateTime: '1789000000' }]
          : [{ id: 'c', productRating: 3, reviewCreateTime: '1788000000' }],
        hasNext: page < 2,
        totalReviews: 3,
      },
    }),
  }, { log });

  const { found, pages } = await fetchExactTimes({
    wanted: [{ id: 'b', productId: 'P1', productUrl: 'u' }, { id: 'zz', productId: '', productUrl: '' }],
    fetchImpl, sleepImpl: noSleep, minGapMs: 0,
  });
  assert.equal(pages, 1, 'b was on page one, so page two was not needed');
  assert.equal(found.get('b').createdAtEpoch, 1789000000);
  assert.equal(found.get('b').createdAt, new Date(1789000000 * 1000).toISOString());
  assert.equal(found.has('a'), false, 'only what was asked for');

  const deep = await fetchExactTimes({ wanted: [{ id: 'c', productId: 'P1', productUrl: 'u' }], fetchImpl, sleepImpl: noSleep, minGapMs: 0 });
  assert.equal(deep.pages, 2);
  assert.equal(deep.found.get('c').createdAtEpoch, 1788000000);
});

// --- sync end to end against the (test) store

test('a sync stores reviews with exact times, and a second sync only pays for what is new', async () => {
  resetPacer();
  await deleteDoc(REVIEWS_DOC);
  let listed = ['a', 'b'];
  const exact = { a: '1789090887', b: '1789000000', c: '1789400000' };
  const log = [];
  const fetchImpl = fakeGateway({
    ReviewSummary: () => ({ productrevGetShopRatingAndTopics: { rating: { ratingScore: '5.0', totalRating: 2732, totalRatingTextAndImage: 361, positivePercentageFmt: '99%', detail: [{ rate: 5, totalReviews: 2670 }], isAggregatedWithTTS: true }, topics: [] } }),
    ReviewList: () => ({ productrevGetShopReviewReadingList: { list: listed.map((id) => shopRaw(id, id === 'c' ? { rating: 2, reviewText: 'penyok' } : {})), hasNext: false, shopName: 'Treelogy', totalReviews: listed.length } }),
    productReviewList: () => ({ productrevGetProductReviewList: { productID: '16441446901', list: listed.map((id) => ({ id, productRating: 5, reviewCreateTime: exact[id] })), hasNext: false, totalReviews: listed.length } }),
  }, { log });
  const transport = { shopId: '17210983', slug: 'treelogy-moringa', fetchImpl, sleepImpl: noSleep, minGapMs: 0, now: new Date(NOW * 1000) };

  const first = await syncReviews(transport);
  assert.equal(first.added.length, 2);
  assert.equal(first.initial, true);
  assert.equal(first.media, null, 'no photos in these reviews, so nothing was prefetched');
  assert.equal(first.requests, 3, 'summary + one shop page + one product page');
  assert.equal(first.summary.totalRatings, 2732);

  const stored = await loadReviews('17210983');
  assert.equal(stored.syncedAt, new Date(NOW * 1000).toISOString());
  assert.equal(stored.reviews.a.createdAtPrecision, 'exact');
  assert.equal(stored.reviews.a.createdAtEpoch, 1789090887);

  listed = ['c', 'a', 'b'];
  log.length = 0;
  const second = await syncReviews(transport);
  assert.deepEqual(second.added.map((r) => r.id), ['c']);
  assert.equal(second.initial, false);
  assert.equal(second.updated.length, 0);
  assert.equal(second.requests, 3);
  assert.equal(log.filter((l) => l.operationName === 'productReviewList').length, 1, 'only c needed an exact time');

  const doc = await loadReviews('17210983');
  assert.deepEqual(selectReviews(doc).map((r) => r.id), ['c', 'a', 'b'], 'newest first');
  assert.deepEqual(selectReviews(doc, { ratings: [1, 2, 3] }).map((r) => r.id), ['c']);
  assert.deepEqual(selectReviews(doc, { sku: 'OMC-270-001', limit: 1 }).map((r) => r.id), ['c']);
  const stats = reviewStats(doc, { nowEpoch: NOW });
  assert.equal(stats.written.count, 3);
  assert.equal(stats.written.low, 1);
  assert.equal(stats.byRating[2], 1);
  assert.equal(stats.bySku['OMC-270-001'].count, 3);
  assert.equal(stats.unreplied, 3);

  const csv = toCsv(selectReviews(doc));
  assert.match(csv.split('\n')[0], /^id,created_at,time_precision,rating,sku/);
  assert.equal(csv.trim().split('\n').length, 4);

  await deleteDoc(REVIEWS_DOC);
});

test('a stored document for another shop is not mistaken for this one', async () => {
  await deleteDoc(REVIEWS_DOC);
  const doc = await loadReviews('999');
  assert.equal(doc.syncedAt, null);
  assert.deepEqual(doc.reviews, {});
});

// --- dashboard view

test('the reviews view has a menu entry, leads with low ratings, and escapes what buyers wrote', () => {
  const common = { range: { preset: '7d', from: '2026-09-08', to: '2026-09-15' }, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf: 'tok' };
  assert.equal(VIEWS.reviews, 'Ulasan');

  const empty = renderReviews({ doc: null, stats: null, reviews: [], ...common });
  assert.match(empty, /Belum ada ulasan tersimpan/);
  assert.match(empty, /npm run tokopedia:reviews/);

  const low = normalizeShopReview(shopRaw('9', {
    rating: 2, reviewText: 'Paket <b>penyok</b>', badRatingReasonFmt: 'Kemasan',
    attachments: [{ attachmentID: '359838891', thumbnailURL: 'https://signed/t?x=1', fullsizeURL: 'https://signed/f?x=1' }],
    videoAttachments: [{ attachmentID: '77', videoUrl: 'https://signed/v.mp4' }],
  }), { shopId: '1', nowEpoch: NOW });
  const fine = normalizeShopReview(shopRaw('10', { replyText: 'Terima kasih', replyTime: '1 hari lalu' }), { shopId: '1', nowEpoch: NOW });
  const doc = {
    shopId: '1', shopName: 'Treelogy Moringa', syncedAt: new Date(NOW * 1000).toISOString(),
    summary: { score: 5, totalRatings: 2732, totalWritten: 361, aggregatedWithTikTok: true, distribution: { 5: 2670, 4: 53, 3: 4, 2: 5, 1: 0 }, topics: [] },
    reviews: { 9: { ...low, createdAtPrecision: 'exact' }, 10: fine },
  };
  const html = renderReviews({ doc, stats: reviewStats(doc, { nowEpoch: NOW }), reviews: selectReviews(doc), filter: { rating: '1,2,3' }, ...common });
  assert.match(html, /Ulasan Tokopedia/);
  assert.match(html, /aria-label="2 dari 5 bintang"/);
  assert.match(html, /rv__stars--low/);
  assert.match(html, /Paket &lt;b&gt;penyok&lt;\/b&gt;/, 'buyer text is untrusted HTML');
  assert.doesNotMatch(html, /Paket <b>penyok/);
  assert.match(html, /Kemasan/);
  assert.match(html, /Belum dibalas/);
  assert.match(html, /Dibalas/);
  assert.match(html, /2\.732/, 'rating count in Indonesian digits');
  assert.match(html, /penilaian gabungan Tokopedia \+ TikTok Shop/);
  assert.match(html, /OMC-270-001/);
  assert.match(html, /<option value="1,2,3" selected>/, 'the filter form reflects the current filter');
  assert.match(html, /class="viewtab is-on" href="\?view=reviews/);

  // Photos go through our cache, never to Tokopedia's signed URL, and open in the lightbox.
  assert.match(html, /<img src="\/api\/tokopedia\/media\?id=359838891&amp;s=thumb"[^>]*loading="lazy"/);
  assert.match(html, /data-full="\/api\/tokopedia\/media\?id=359838891&amp;s=full"/);
  assert.doesNotMatch(html, /https:\/\/signed\/t\?x=1/);
  assert.match(html, /<dialog id="rv-lightbox"/);
  assert.match(html, /getElementById\('rv-lightbox'\)/);
  assert.match(html, /href="https:\/\/signed\/v\.mp4"/, 'videos link out');
  assert.match(html, /1 berfoto/);
  assert.match(html, /rv--low/);
  assert.doesNotMatch(html, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji icons');
});

// --- transport

test('the gateway client retries a 429 and surfaces a schema error without retrying it', async () => {
  resetPacer();
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) return { status: 429, ok: false, text: async () => 'slow down' };
    return { status: 200, ok: true, text: async () => JSON.stringify([{ data: { fine: true } }]) };
  };
  const data = await gql({ operationName: 'X', query: 'query X { fine }', variables: {}, fetchImpl: flaky, sleepImpl: noSleep, minGapMs: 0 });
  assert.deepEqual(data, { fine: true });
  assert.equal(calls, 2);

  let schemaCalls = 0;
  const wrong = async () => {
    schemaCalls++;
    return { status: 200, ok: true, text: async () => JSON.stringify([{ data: null, errors: [{ message: 'Invalid request schema received. Kindly correct it.' }] }]) };
  };
  await assert.rejects(
    gql({ operationName: 'X', query: 'q', variables: {}, fetchImpl: wrong, sleepImpl: noSleep, minGapMs: 0 }),
    (error) => error instanceof TokopediaError && /Invalid request schema/.test(error.message) && !error.retryable,
  );
  assert.equal(schemaCalls, 1, 'a wrong query is wrong every time; do not hammer the gateway with it');
});

test('requests are spaced by the minimum gap', async () => {
  resetPacer();
  const waits = [];
  const sleepImpl = async (ms) => { waits.push(ms); };
  const fetchImpl = async () => ({ status: 200, ok: true, text: async () => JSON.stringify([{ data: { n: 1 } }]) });
  await gql({ operationName: 'A', query: 'q', variables: {}, fetchImpl, sleepImpl, minGapMs: 700 });
  await gql({ operationName: 'A', query: 'q', variables: {}, fetchImpl, sleepImpl, minGapMs: 700 });
  assert.equal(waits.length, 1, 'the first request goes straight out, the second waits');
  assert.ok(waits[0] >= 600 && waits[0] <= 1000, `waited ${waits[0]}ms`);
});

// --- notify

test('a low review is announced once, then the digest; nothing is sent when nothing is new', async () => {
  const sent = [];
  const send = async (html, { key }) => { sent.push({ html, key }); return { sent: true }; };
  const low = { ...normalizeShopReview(shopRaw('9', { rating: 2, reviewText: 'Paket sampai dengan bbrp bagian yg penyok.', badRatingReasonFmt: 'Kemasan' }), { shopId: '1', nowEpoch: NOW }) };
  const fine = normalizeShopReview(shopRaw('10'), { shopId: '1', nowEpoch: NOW });
  const result = { syncedAt: 't', added: [low, fine], updated: [], summary: { score: 5, totalRatings: 2732, totalWritten: 361 } };

  const keys = await notifyReviewSync(result, { send });
  assert.deepEqual(keys, ['9', 'digest']);
  assert.equal(sent[0].key, 'tokopedia-review-9');
  assert.match(sent[0].html, /★★☆☆☆/);
  assert.match(sent[0].html, /penyok/);
  assert.match(sent[0].html, /OMC-270-001/);
  assert.match(sent[0].html, /Belum dibalas/);
  assert.match(sent[1].html, /2 ulasan baru/);
  assert.match(sent[1].html, /1×5★, 1×2★/);

  sent.length = 0;
  assert.deepEqual(await notifyReviewSync({ syncedAt: 't', added: [], updated: [], summary: null }, { send }), []);
  assert.equal(sent.length, 0);

  sent.length = 0;
  assert.deepEqual(await notifyReviewSync({ ...result, initial: true }, { send }), ['digest'], 'the first import is one digest, not one alert per old review');
  assert.match(sent[0].html, /diimpor/);

  assert.match(formatLowReview({ ...low, text: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/, 'review text is escaped, it is untrusted');
});
