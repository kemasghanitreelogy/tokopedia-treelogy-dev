import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShopeeComment, shopeeSku, listItemIds, loadCatalog, crawlItemComments, syncShopeeReviews,
  loadShopeeReviews, summarizeShopee, SHOPEE_REVIEWS_DOC,
} from '../src/shopee/reviews.js';
import { combineReviewDocs, loadAllReviews, reviewKey } from '../src/reviews/combined.js';
import { selectReviews, reviewStats, toCsv, REVIEWS_DOC, normalizeShopReview } from '../src/tokopedia/reviews.js';
import { attachmentIndex } from '../src/tokopedia/media.js';
import { deleteDoc, writeDoc, closeStore } from '../src/store/index.js';

test.after(async () => { await closeStore(); });

const NOW = 1_789_500_000;

/** A fake shop: items with models, and comments per item, newest first. */
function fakeShop({ comments }) {
  const log = [];
  const call = async (path, params) => {
    log.push({ path, params });
    switch (path) {
      case '/api/v2/product/get_item_list':
        return { response: params.item_status === 'NORMAL'
          ? { item: [{ item_id: 48200274325 }, { item_id: 49000815284 }], has_next_page: false }
          : { item: [{ item_id: 54104387502 }], has_next_page: false } };
      case '/api/v2/product/get_item_base_info':
        return { response: { item_list: [
          { item_id: 48200274325, item_name: 'TREELOGY - Organic Moringa Capsules', item_sku: 'OMC-001', has_model: true },
          { item_id: 49000815284, item_name: 'TREELOGY - The Discovery Pack', item_sku: 'Discovery-Pack', has_model: true },
          { item_id: 54104387502, item_name: '[BELI2 GRATIS1] Capsules 90caps', item_sku: 'OMC-90', has_model: false },
        ].filter((i) => params.item_id_list.split(',').includes(String(i.item_id))) } };
      case '/api/v2/product/get_model_list':
        return { response: { model: params.item_id === 48200274325
          ? [{ model_id: 138482721046, model_name: '3 Months', model_sku: 'OMC-270-001' }, { model_id: 320025050815, model_name: '2 Months', model_sku: 'OMC-180-001' }]
          : [{ model_id: 1, model_name: 'Set', model_sku: '' }] } };
      case '/api/v2/product/get_comment': {
        const list = comments[params.item_id] ?? [];
        const start = Number(params.cursor || 0);
        const page = list.slice(start, start + params.page_size);
        const more = start + page.length < list.length;
        return { response: { item_comment_list: page, more, next_cursor: more ? String(start + page.length) : '' } };
      }
      default:
        throw new Error(`unexpected ${path}`);
    }
  };
  call.shopId = '17210983';
  call.log = log;
  return call;
}

const comment = (id, extra = {}) => ({
  comment_id: id, comment: '', buyer_username: 'wenny', order_sn: 'SN' + id, item_id: 48200274325, model_id: 0,
  create_time: NOW - id, rating_star: 5, editable: 'EDITABLE', hidden: false, media: {}, model_id_list: [320025050815], ...extra,
});

test('a Shopee comment normalises with the model name and the SKU the catalogue carries', async () => {
  const call = fakeShop({ comments: {} });
  const catalog = await loadCatalog(call, ['48200274325', '54104387502']);
  const r = normalizeShopeeComment(comment(7, {
    comment: 'mantap', rating_star: 4, media: { image_url_list: ['https://mms/a', 'https://mms/b'] },
    comment_reply: { reply: 'terima kasih', hidden: false, create_time: NOW - 3 }, model_id_list: [138482721046],
  }), { catalog, shopId: '17210983' });
  assert.equal(r.channel, 'shopee');
  assert.equal(r.id, '7');
  assert.equal(r.sku, 'OMC-270-001');
  assert.equal(r.variantName, '3 Months');
  assert.equal(r.productName, 'TREELOGY - Organic Moringa Capsules');
  assert.equal(r.productUrl, 'https://shopee.co.id/product/17210983/48200274325');
  assert.equal(r.createdAtPrecision, 'exact');
  assert.equal(r.createdAtEpoch, NOW - 7);
  assert.equal(r.reply.text, 'terima kasih');
  assert.equal(r.reply.atEpoch, NOW - 3);
  assert.deepEqual(r.images.map((i) => i.id), ['70', '71'], 'photo ids are numeric and derived from the comment');
  assert.equal(r.anonymous, false);

  const noModel = normalizeShopeeComment(comment(8, { item_id: 54104387502, model_id_list: [] }), { catalog, shopId: '1' });
  assert.equal(noModel.sku, 'OMC-90-001', 'the listing SKU is an alias in the master list');
  assert.equal(noModel.variantName, '');
});

test('the SKU falls back from model code to listing code to the title', () => {
  assert.equal(shopeeSku({ modelSku: 'OMC-180-001' }), 'OMC-180-001');
  assert.equal(shopeeSku({ modelSku: '', itemSku: 'Ritual-Set' }), 'MRS-001');
  assert.equal(shopeeSku({ modelSku: '', itemSku: 'Discovery-Pack' }), 'Discovery-Pack', 'the Shopee listing code is itself a master SKU');
  assert.equal(shopeeSku({ modelSku: '', itemSku: 'Gift-With-Purchase', productName: 'Treelogy Gift', variantName: '30 ml' }), 'OMO-30-001');
  assert.equal(shopeeSku({ modelSku: '', itemSku: 'Gift-With-Purchase', productName: 'Treelogy Gift', variantName: '' }), null);
});

test('items of every listed status are read and each item is paged to its end', async () => {
  const comments = { 48200274325: Array.from({ length: 250 }, (_, i) => comment(1000 - i)), 49000815284: [comment(5, { item_id: 49000815284 })], 54104387502: [] };
  const call = fakeShop({ comments });
  const ids = await listItemIds(call);
  assert.deepEqual(ids, ['48200274325', '49000815284', '54104387502']);

  const full = await crawlItemComments(call, '48200274325', { catalog: new Map(), shopId: '1' });
  assert.equal(full.reviews.length, 250);
  assert.equal(full.pages, 3);

  const quick = await crawlItemComments(call, '48200274325', { knownIds: new Set(comments[48200274325].map((c) => String(c.comment_id))), stopWhenKnown: true, catalog: new Map(), shopId: '1' });
  assert.equal(quick.pages, 1, 'the first page was all known');
});

test('a sync stores every rating, counts a summary from them, and the next sync reports only what is new', async () => {
  await deleteDoc(SHOPEE_REVIEWS_DOC);
  const comments = { 48200274325: [comment(30, { comment: 'bagus' }), comment(20, { rating_star: 3, comment: 'kurang' })], 49000815284: [], 54104387502: [comment(10, { item_id: 54104387502, model_id_list: [] })] };
  const call = fakeShop({ comments });
  const first = await syncShopeeReviews({ call, now: new Date(NOW * 1000), prefetch: false });
  assert.equal(first.channel, 'shopee');
  assert.equal(first.initial, true);
  assert.equal(first.added.length, 3);
  assert.deepEqual(first.summary.distribution, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 2 });
  assert.equal(first.summary.score, 4.33);
  assert.equal(first.summary.totalWritten, 2);

  const stored = await loadShopeeReviews();
  assert.equal(stored.shopId, '17210983');
  assert.equal(stored.reviews['20'].sku, 'OMC-180-001');

  comments[48200274325].unshift(comment(40, { rating_star: 2, comment: 'rusak', media: { image_url_list: ['https://mms/c'] } }));
  const second = await syncShopeeReviews({ call, now: new Date((NOW + 60) * 1000), prefetch: false });
  assert.equal(second.initial, false);
  assert.deepEqual(second.added.map((r) => r.id), ['40']);
  assert.equal(second.updated.length, 0);
  assert.equal(second.summary.totalRatings, 4);
  await deleteDoc(SHOPEE_REVIEWS_DOC);
});

test('both channels combine into one set with stable keys, shared stats and one photo index', async () => {
  await deleteDoc(REVIEWS_DOC);
  await deleteDoc(SHOPEE_REVIEWS_DOC);
  const tp = normalizeShopReview({
    id: '2299542285', product: { productID: '1', productName: 'Capsules', productPageURL: 'https://www.tokopedia.com/x/y-1731010208236537819', productVariant: { variantName: '270 Caps' } },
    rating: 5, reviewTime: '4 hari lalu', reviewText: 'mantab', reviewerName: 'Lith', attachments: [{ attachmentID: '359838891', thumbnailURL: 't', fullsizeURL: 'f' }],
    videoAttachments: [], state: {}, likeDislike: {},
  }, { shopId: '17210983', nowEpoch: NOW });
  const sp = normalizeShopeeComment(comment(2299542285, { rating_star: 2, comment: 'penyok', media: { image_url_list: ['https://mms/z'] } }), { shopId: '9' });
  await writeDoc(REVIEWS_DOC, { shopId: '17210983', shopName: 'Treelogy Moringa', syncedAt: '2026-09-15T01:00:00.000Z', summary: { score: 5, totalRatings: 2732, distribution: { 5: 2670, 4: 53, 3: 4, 2: 5, 1: 0 } }, reviews: { [tp.id]: tp } });
  await writeDoc(SHOPEE_REVIEWS_DOC, { shopId: '9', shopName: '', syncedAt: '2026-09-15T02:00:00.000Z', summary: summarizeShopee({ [sp.id]: sp }), reviews: { [sp.id]: sp } });

  const all = await loadAllReviews();
  assert.equal(all.syncedAt, '2026-09-15T02:00:00.000Z', 'the newest sync of either channel');
  assert.deepEqual(Object.keys(all.reviews).sort(), ['shopee:2299542285', 'tokopedia:2299542285'], 'same id on both marketplaces, two records');
  assert.equal(reviewKey(sp), 'shopee:2299542285');
  assert.equal(all.channels.tokopedia.shopName, 'Treelogy Moringa');
  assert.equal(all.channels.shopee.summary.totalRatings, 1);

  assert.deepEqual(selectReviews(all, { channel: 'shopee' }).map((r) => r.id), ['2299542285']);
  assert.equal(selectReviews(all, { channel: 'shopee' })[0].channel, 'shopee');
  assert.equal(selectReviews(all, { ratings: [1, 2, 3] }).length, 1);
  const stats = reviewStats(all, { nowEpoch: NOW });
  assert.equal(stats.written.count, 2);
  assert.equal(stats.byChannel.shopee.low, 1);
  assert.equal(stats.byChannel.tokopedia.count, 1);
  assert.match(toCsv(selectReviews(all)), /^channel,id,/);
  assert.match(toCsv(selectReviews(all)), /\nshopee,2299542285,/);

  const index = attachmentIndex(all);
  assert.deepEqual(index.get('22995422850'), { thumb: 'https://mms/z', full: 'https://mms/z', reviewId: '2299542285' });
  assert.equal(index.get('359838891').reviewId, '2299542285');

  const empty = combineReviewDocs({});
  assert.equal(empty.syncedAt, null);
  await deleteDoc(REVIEWS_DOC);
  await deleteDoc(SHOPEE_REVIEWS_DOC);
});
