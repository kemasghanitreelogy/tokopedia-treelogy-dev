import { loadShopeeConfig } from './config.js';
import { resolveShopeeSession } from './session.js';
import { callShopApi } from './client.js';
import { readDoc, updateDoc } from '../store/index.js';
import { findProduct } from '../master.js';
import { matchSku, mergeReviews } from '../tokopedia/reviews.js';
import { prefetchMedia } from '../tokopedia/media.js';

/**
 * Shopee reviews, through the official Open API this time.
 *
 * `product/get_comment` returns every rating the shop has received - the ones without
 * text too, which is most of them - with an exact create time, the buyer's reply and
 * photos. Without an item filter the cursor stops at the newest thousand, so the walk
 * is per item: each listing is paged newest-first until its end, or until a page holds
 * nothing new when a quick check is all that is wanted.
 *
 * Variant names and SKUs come from the catalogue (`get_model_list`), where every model
 * carries the same SKU code the master list uses. That makes the SKU exact, not guessed.
 */

export const SHOPEE_REVIEWS_DOC = 'shopee/reviews.json';
export const COMMENT_PAGE_SIZE = 100;
const MAX_PAGES_PER_ITEM = 50;
const ITEM_STATUSES = ['NORMAL', 'UNLIST'];

/** A caller bound to the live shop: (path, params) => response body. */
export async function shopCaller() {
  const config = loadShopeeConfig();
  const { auth } = await resolveShopeeSession({ config });
  return Object.assign((path, params) => callShopApi(config, path, auth, params), { shopId: String(auth.shopId) });
}

export async function listItemIds(call) {
  const ids = [];
  for (const status of ITEM_STATUSES) {
    let offset = 0;
    for (let page = 0; page < 100; page++) {
      const { response = {} } = await call('/api/v2/product/get_item_list', { offset, page_size: 100, item_status: status });
      for (const item of response.item ?? []) ids.push(String(item.item_id));
      if (!response.has_next_page) break;
      offset = response.next_offset;
    }
  }
  return [...new Set(ids)];
}

/** item id -> { name, sku, models: Map(model id -> { name, sku }) } */
export async function loadCatalog(call, itemIds) {
  const catalog = new Map();
  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50);
    const { response = {} } = await call('/api/v2/product/get_item_base_info', { item_id_list: batch.join(',') });
    for (const item of response.item_list ?? []) {
      catalog.set(String(item.item_id), { name: item.item_name ?? '', sku: item.item_sku ?? '', hasModel: Boolean(item.has_model), models: new Map() });
    }
  }
  for (const [itemId, entry] of catalog) {
    if (!entry.hasModel) continue;
    const { response = {} } = await call('/api/v2/product/get_model_list', { item_id: Number(itemId) });
    for (const model of response.model ?? []) {
      entry.models.set(String(model.model_id), { name: model.model_name ?? '', sku: model.model_sku ?? '' });
    }
  }
  return catalog;
}

const iso = (epoch) => (epoch ? new Date(epoch * 1000).toISOString() : null);

/** The master SKU: the model's own code first, then the listing's, then the title. */
export function shopeeSku({ modelSku, itemSku, productName, variantName }) {
  return findProduct(modelSku)?.sku ?? findProduct(itemSku)?.sku ?? matchSku({ productName, variantName }) ?? null;
}

export function normalizeShopeeComment(raw, { catalog = new Map(), shopId = '' } = {}) {
  const itemId = String(raw.item_id ?? '');
  const item = catalog.get(itemId) ?? { name: '', sku: '', models: new Map() };
  const modelId = String((raw.model_id_list ?? [])[0] ?? raw.model_id ?? '');
  const model = modelId && modelId !== '0' ? item.models.get(modelId) : null;
  const id = String(raw.comment_id);
  const images = (raw.media?.image_url_list ?? []).map((url, i) => ({ id: `${id}${i}`, thumbnail: url, full: url }));
  const videos = (raw.media?.video_url_list ?? []).map((url, i) => ({ id: `${id}9${i}`, url }));
  const reply = raw.comment_reply?.reply
    ? { text: raw.comment_reply.reply, relative: '', atEpoch: raw.comment_reply.create_time ?? null, at: iso(raw.comment_reply.create_time) }
    : null;
  return {
    id,
    channel: 'shopee',
    shopId: String(shopId),
    productId: itemId,
    productName: item.name,
    productUrl: shopId && itemId ? `https://shopee.co.id/product/${shopId}/${itemId}` : '',
    productImage: '',
    productDeleted: false,
    variantId: model ? modelId : '',
    variantName: model?.name ?? '',
    sku: shopeeSku({ modelSku: model?.sku, itemSku: item.sku, productName: item.name, variantName: model?.name }),
    rating: Number(raw.rating_star) || 0,
    text: raw.comment ?? '',
    badRatingReason: '',
    reviewerId: '',
    reviewerName: raw.buyer_username ?? '',
    anonymous: !raw.buyer_username,
    orderSn: raw.order_sn ?? '',
    hidden: Boolean(raw.hidden),
    createdAt: iso(raw.create_time),
    createdAtEpoch: raw.create_time ?? null,
    createdAtPrecision: raw.create_time ? 'exact' : 'unknown',
    createdAtRelative: '',
    reply,
    images,
    videos,
    likes: 0,
  };
}

export async function crawlItemComments(call, itemId, { knownIds = new Set(), stopWhenKnown = false, catalog, shopId, log = () => {} } = {}) {
  const reviews = [];
  let cursor = '';
  let pages = 0;
  for (let page = 0; page < MAX_PAGES_PER_ITEM; page++) {
    const { response = {} } = await call('/api/v2/product/get_comment', { item_id: Number(itemId), cursor, page_size: COMMENT_PAGE_SIZE });
    pages++;
    const batch = (response.item_comment_list ?? []).map((raw) => normalizeShopeeComment(raw, { catalog, shopId }));
    reviews.push(...batch);
    if (!response.more || !batch.length) break;
    if (stopWhenKnown && batch.every((r) => knownIds.has(r.id))) break;
    cursor = String(response.next_cursor ?? '');
    if (!cursor) break;
  }
  log(`  item ${itemId}: ${reviews.length} ulasan, ${pages} halaman`);
  return { reviews, pages };
}

export const emptyShopeeDoc = (shopId = '') => ({ shopId: String(shopId), shopName: '', syncedAt: null, summary: null, reviews: {} });

export async function loadShopeeReviews() {
  return (await readDoc(SHOPEE_REVIEWS_DOC)) ?? emptyShopeeDoc();
}

/** Shopee has no shop-rating call worth the name, so the summary is counted from the ratings themselves. */
export function summarizeShopee(reviews) {
  const list = Object.values(reviews);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  let written = 0;
  for (const r of list) {
    if (r.rating in distribution) distribution[r.rating]++;
    sum += r.rating;
    if (r.text.trim() || r.images.length) written++;
  }
  return {
    score: list.length ? Math.round((sum / list.length) * 100) / 100 : 0,
    totalRatings: list.length,
    totalWritten: written,
    satisfied: '',
    aggregatedWithTikTok: false,
    distribution,
    topics: [],
  };
}

/**
 * One sync: items, catalogue, every item's comments, merge, save, photos of the new ones.
 *
 * @param {{call?: Function, quick?: boolean, prefetch?: boolean, now?: Date, log?: Function, mediaFetchImpl?: typeof fetch}} options
 */
export async function syncShopeeReviews(options = {}) {
  const { quick = false, prefetch = true, now = new Date(), log = () => {} } = options;
  const call = options.call ?? (await shopCaller());
  const shopId = options.shopId ?? call.shopId ?? '';
  const nowIso = now.toISOString();

  const before = await loadShopeeReviews();
  const knownIds = new Set(Object.keys(before.reviews));

  log('daftar produk...');
  const itemIds = await listItemIds(call);
  log(`katalog ${itemIds.length} produk...`);
  const catalog = await loadCatalog(call, itemIds);

  const fresh = [];
  let requests = 2 + itemIds.length; // item pages + base info batch + one model list per item, roughly
  for (const itemId of itemIds) {
    const { reviews, pages } = await crawlItemComments(call, itemId, { knownIds, stopWhenKnown: quick, catalog, shopId, log });
    fresh.push(...reviews);
    requests += pages;
  }

  const merged = mergeReviews(before.reviews, fresh, { exact: new Map(), nowIso });
  const summary = summarizeShopee(merged.reviews);
  const doc = { ...before, shopId: String(shopId), syncedAt: nowIso, summary, reviews: merged.reviews };
  await updateDoc(SHOPEE_REVIEWS_DOC, () => doc, emptyShopeeDoc(shopId));

  let media = null;
  if (prefetch) {
    const withPhotos = merged.added.filter((r) => r.images.length);
    if (withPhotos.length) {
      log(`foto untuk ${withPhotos.length} ulasan baru...`);
      media = await prefetchMedia(withPhotos, { fetchImpl: options.mediaFetchImpl, log });
    }
  }

  return {
    channel: 'shopee',
    shopId: String(shopId),
    syncedAt: nowIso,
    initial: knownIds.size === 0,
    summary,
    total: Object.keys(merged.reviews).length,
    listed: fresh.length,
    added: merged.added,
    updated: merged.updated,
    requests,
    media,
  };
}
