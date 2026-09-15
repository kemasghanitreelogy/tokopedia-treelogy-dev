import { gql, STOREFRONT_URL } from './gql.js';
import { readEnv } from '../env-file.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';
import { readDoc, updateDoc } from '../store/index.js';
import { PRODUCTS, findProduct } from '../master.js';

/**
 * Tokopedia reviews for the shop, read the way the storefront reads them.
 *
 * Two queries, each good at one thing:
 *
 *   - ReviewList (shop-level) returns every written review in the shop in one paginated
 *     list, with the product and variant each belongs to. It is the discovery pass. Its
 *     one gap: time is relative text ("4 hari lalu"), never a timestamp.
 *   - productReviewList (product-level) returns the same reviews per product, with an
 *     exact epoch `reviewCreateTime`, but pages of fifty and no product list of its own.
 *
 * So a sync walks the shop list, then visits only the products whose reviews still lack
 * an exact time, and stops paging each product as soon as those are covered. A first run
 * reads everything; a nightly run is the shop list plus a page or two.
 *
 * Reviews without text (the majority of ratings - the shop has ~2,700 ratings and ~400
 * written reviews) are not items in either list. They exist only in the summary counts.
 */

export const REVIEWS_DOC = 'tokopedia/reviews.json';
export const DEFAULT_SHOP_ID = '17210983';
export const DEFAULT_SHOP_SLUG = 'treelogy-moringa';

/** Verified live: the shop list accepts 200 per page; the product list rejects anything over 50. */
export const SHOP_PAGE_SIZE = 100;
export const PRODUCT_PAGE_SIZE = 50;
const MAX_SHOP_PAGES = 200;
const MAX_PRODUCT_PAGES = 100;
export const LOW_RATING_MAX = 3;

export function loadTokopediaConfig() {
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';
  return {
    shopId: get('TOKOPEDIA_SHOP_ID') || DEFAULT_SHOP_ID,
    shopSlug: get('TOKOPEDIA_SHOP_SLUG') || DEFAULT_SHOP_SLUG,
  };
}

export const shopReviewUrl = (slug) => `${STOREFRONT_URL}/${slug}/review`;

// --- Queries, verbatim from the storefront bundle (chunk.shop-review / review-common-view).
// Field names are the storefront's; renaming any of them is a schema error, not a typo.

export const SHOP_REVIEWS_QUERY =
  'query ReviewList($shopID:String!,$limit:Int!,$page:Int!,$filterBy:String,$sortBy:String){' +
  'productrevGetShopReviewReadingList(shopID:$shopID limit:$limit page:$page filterBy:$filterBy sortBy:$sortBy){' +
  'list{id:reviewID product{productID productName productImageURL productPageURL productStatus isDeletedProduct ' +
  'productVariant{variantID variantName}}rating reviewTime reviewText reviewerID reviewerName avatar replyText replyTime ' +
  'attachments{attachmentID thumbnailURL fullsizeURL}videoAttachments{attachmentID videoUrl}' +
  'state{isReportable isAnonymous}likeDislike{totalLike likeStatus}badRatingReasonFmt}hasNext shopName totalReviews}}';

export const PRODUCT_REVIEWS_QUERY =
  'query productReviewList($productID:String!,$page:Int!,$limit:Int!,$sortBy:String,$filterBy:String){' +
  'productrevGetProductReviewList(productID:$productID,page:$page,limit:$limit,sortBy:$sortBy,filterBy:$filterBy){' +
  'productID list{id:feedbackID variantName message productRating reviewCreateTime reviewCreateTimestamp ' +
  'isAnonymous reviewResponse{message createTime}likeDislike{totalLike likeStatus}}hasNext totalReviews}}';

export const SHOP_SUMMARY_QUERY =
  'query ReviewSummary($shopID:String!){productrevGetShopRatingAndTopics(shopID:$shopID){' +
  'rating{positivePercentageFmt ratingScore totalRating totalRatingTextAndImage ' +
  'detail{rate totalReviews formattedTotalReviews percentageFloat}isAggregatedWithTTS}' +
  'topics{rating ratingFmt formatted key reviewCount reviewCountFmt show}}}';

// --- Raw fetches

export async function fetchShopReviewPage({ shopId, page, limit = SHOP_PAGE_SIZE, filterBy = '', sortBy = 'create_time desc', slug = DEFAULT_SHOP_SLUG, fetchImpl, sleepImpl, minGapMs }) {
  const data = await gql({
    operationName: 'ReviewList',
    query: SHOP_REVIEWS_QUERY,
    variables: { shopID: String(shopId), limit, page, filterBy, sortBy },
    referer: shopReviewUrl(slug),
    fetchImpl,
    sleepImpl,
    minGapMs,
  });
  const result = data.productrevGetShopReviewReadingList ?? {};
  return { list: result.list ?? [], hasNext: Boolean(result.hasNext), total: result.totalReviews ?? 0, shopName: result.shopName ?? '' };
}

export async function fetchProductReviewPage({ productId, page, limit = PRODUCT_PAGE_SIZE, sortBy = 'create_time desc', productUrl, fetchImpl, sleepImpl, minGapMs }) {
  const data = await gql({
    operationName: 'productReviewList',
    query: PRODUCT_REVIEWS_QUERY,
    variables: { productID: String(productId), page, limit, sortBy, filterBy: '' },
    referer: productUrl || `${STOREFRONT_URL}/`,
    fetchImpl,
    sleepImpl,
    minGapMs,
  });
  const result = data.productrevGetProductReviewList ?? {};
  return { list: result.list ?? [], hasNext: Boolean(result.hasNext), total: result.totalReviews ?? 0 };
}

export async function fetchShopSummary({ shopId, slug = DEFAULT_SHOP_SLUG, fetchImpl, sleepImpl, minGapMs }) {
  const data = await gql({
    operationName: 'ReviewSummary',
    query: SHOP_SUMMARY_QUERY,
    variables: { shopID: String(shopId) },
    referer: shopReviewUrl(slug),
    fetchImpl,
    sleepImpl,
    minGapMs,
  });
  const raw = data.productrevGetShopRatingAndTopics ?? {};
  const rating = raw.rating ?? {};
  return {
    score: Number(rating.ratingScore) || 0,
    totalRatings: rating.totalRating ?? 0,
    totalWritten: rating.totalRatingTextAndImage ?? 0,
    satisfied: rating.positivePercentageFmt ?? '',
    aggregatedWithTikTok: Boolean(rating.isAggregatedWithTTS),
    distribution: Object.fromEntries((rating.detail ?? []).map((d) => [d.rate, d.totalReviews ?? 0])),
    topics: (raw.topics ?? []).map((t) => ({ key: t.key, title: t.formatted, rating: t.rating, reviews: t.reviewCount })),
  };
}

// --- Time

const UNIT_SECONDS = {
  detik: 1,
  menit: 60,
  jam: 3600,
  hari: 86400,
  minggu: 7 * 86400,
  bulan: 30 * 86400,
  tahun: 365 * 86400,
};
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, mei: 4, jun: 5, jul: 6, agu: 7, ags: 7, sep: 8, okt: 9, nov: 10, des: 11 };

/**
 * "4 hari lalu" to an epoch, given when it was read. The result is a floor: Tokopedia
 * rounds down ("4 hari lalu" is anywhere from 4 to 5 days), so the true time is at or
 * after it. Absolute dates ("12 Mar 2025") are parsed as noon WIB. Anything else is null.
 */
export function parseRelativeTime(text, nowEpoch = Math.floor(Date.now() / 1000)) {
  const s = String(text ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'baru saja' || s === 'sekarang') return nowEpoch;
  const rel = s.match(/^(\d+)\s*(detik|menit|jam|hari|minggu|bulan|tahun)\s*(?:yang\s+)?lalu$/);
  if (rel) return nowEpoch - Number(rel[1]) * UNIT_SECONDS[rel[2]];
  const abs = s.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (abs && abs[2] in MONTHS) {
    return Math.floor(Date.UTC(Number(abs[3]), MONTHS[abs[2]], Number(abs[1]), 12 - 7) / 1000);
  }
  return null;
}

const iso = (epoch) => (epoch ? new Date(epoch * 1000).toISOString() : null);

// --- SKU

const UNIT_CATEGORY = { caps: 'capsules', capsule: 'capsules', capsules: 'capsules', kapsul: 'capsules', gram: 'powder', gr: 'powder', g: 'powder', ml: 'oil' };

/**
 * Sets and bundles, by the words in the listing title. These come first: a title like
 * "Consistency Pack | 180 Kapsul + 90g Bubuk" would otherwise read as 180 capsules.
 * Each entry is [pattern, sku]; the first match wins, so the specific ones lead.
 */
const NAMED_SETS = [
  [/inside\s*out.*\b30\b/i, 'The-Inside-&-Out30'],
  [/inside\s*out.*\b60\b/i, 'The-Inside-&-Out60'],
  [/movement\s*&\s*relief/i, 'The-Movement-&-Relief'],
  [/discovery\s*pack/i, 'The-Discovery-Pack'],
  [/ritual\s*set/i, 'MRS-001'],
];

/**
 * Which master SKU a review is about.
 *
 * Tokopedia's product URL ends in the TikTok Shop product id, and the master list already
 * carries those as aliases - but a listing with variants ("180 Caps" / "270 Caps") has one
 * id for several SKUs, so the variant name decides first and the URL id is the fallback.
 * Null means the listing is not in the master list (a promo bundle, say), not a bug.
 */
export function matchSku({ productName = '', productUrl = '', variantName = '' } = {}) {
  const named = NAMED_SETS.find(([pattern]) => pattern.test(productName));
  if (named && findProduct(named[1])) return named[1];
  // A pack the master list does not know is not any one of its parts.
  if (/\b(pack|paket|bundle|bundling)\b/i.test(productName)) return null;

  const byQuantity = (text) => {
    const s = String(text).toLowerCase();
    // "180 Caps", "90 gram", "30ml", and the other way round: "Capsules 180".
    const before = s.match(/(\d+)\s*(caps|capsules|capsule|kapsul|gram|gr|g|ml)\b/);
    const after = s.match(/\b(caps|capsules|capsule|kapsul|gram|gr|g|ml)\s*(\d+)\b/);
    const [n, unit] = before ? [before[1], before[2]] : after ? [after[2], after[1]] : [];
    if (!n) return null;
    const category = UNIT_CATEGORY[unit];
    const hit = PRODUCTS.find(
      (p) => p.category === category && !p.components && String(p.variant ?? '').startsWith(`${n} `),
    );
    return hit?.sku ?? null;
  };
  const urlId = String(productUrl).match(/(\d{15,})\/?(?:\?.*)?$/)?.[1];
  return byQuantity(variantName) ?? byQuantity(productName) ?? (urlId ? findProduct(urlId)?.sku : null) ?? null;
}

// --- Normalisation

export function normalizeShopReview(raw, { shopId, nowEpoch }) {
  const product = raw.product ?? {};
  const variant = product.productVariant ?? {};
  const approx = parseRelativeTime(raw.reviewTime, nowEpoch);
  const replyApprox = raw.replyText ? parseRelativeTime(raw.replyTime, nowEpoch) : null;
  return {
    id: String(raw.id),
    shopId: String(shopId),
    productId: String(product.productID ?? ''),
    productName: product.productName ?? '',
    productUrl: product.productPageURL ?? '',
    productImage: product.productImageURL ?? '',
    productDeleted: Boolean(product.isDeletedProduct),
    variantId: String(variant.variantID ?? ''),
    variantName: variant.variantName ?? '',
    sku: matchSku({ productName: product.productName, productUrl: product.productPageURL, variantName: variant.variantName }),
    rating: Number(raw.rating) || 0,
    text: raw.reviewText ?? '',
    badRatingReason: raw.badRatingReasonFmt ?? '',
    reviewerId: String(raw.reviewerID ?? ''),
    reviewerName: raw.reviewerName ?? '',
    anonymous: Boolean(raw.state?.isAnonymous),
    createdAt: iso(approx),
    createdAtEpoch: approx,
    createdAtPrecision: approx ? 'approx' : 'unknown',
    createdAtRelative: raw.reviewTime ?? '',
    reply: raw.replyText
      ? { text: raw.replyText, relative: raw.replyTime ?? '', atEpoch: replyApprox, at: iso(replyApprox) }
      : null,
    // Attachment URLs are signed and expire within days; the ids are stable.
    images: (raw.attachments ?? []).map((a) => ({ id: String(a.attachmentID ?? ''), thumbnail: a.thumbnailURL ?? '', full: a.fullsizeURL ?? '' })),
    videos: (raw.videoAttachments ?? []).map((v) => ({ id: String(v.attachmentID ?? ''), url: v.videoUrl ?? '' })),
    likes: raw.likeDislike?.totalLike ?? 0,
  };
}

/** The product-level fields worth merging in: the exact time, and nothing the shop list already said better. */
export function normalizeProductReview(raw) {
  const epoch = Number(raw.reviewCreateTime) || null;
  return { id: String(raw.id), createdAtEpoch: epoch, createdAt: iso(epoch), rating: Number(raw.productRating) || 0 };
}

// --- Crawl

/**
 * Every written review in the shop, newest first.
 *
 * `stopWhenKnown` ends the walk at the first page that holds nothing new - the shape of
 * a quick check. The default walks to the end, because a reply the shop wrote to a
 * three-month-old review is a change too, and at a hundred per page the whole shop is a
 * handful of requests.
 */
export async function crawlShopReviews({ shopId, slug, knownIds = new Set(), stopWhenKnown = false, nowEpoch, fetchImpl, sleepImpl, minGapMs, log = () => {} }) {
  const reviews = [];
  let pages = 0;
  let total = 0;
  let shopName = '';
  for (let page = 1; page <= MAX_SHOP_PAGES; page++) {
    const result = await fetchShopReviewPage({ shopId, slug, page, fetchImpl, sleepImpl, minGapMs });
    pages++;
    total = result.total;
    shopName = result.shopName || shopName;
    const batch = result.list.map((raw) => normalizeShopReview(raw, { shopId, nowEpoch }));
    reviews.push(...batch);
    log(`  halaman ${page}: ${batch.length} ulasan${result.hasNext ? '' : ' (terakhir)'}`);
    if (!result.hasNext || batch.length === 0) break;
    if (stopWhenKnown && batch.every((r) => knownIds.has(r.id))) break;
  }
  return { reviews, pages, total, shopName };
}

/**
 * Exact creation times for the given review ids, grouped by product.
 *
 * Pages each product newest-first and stops the moment every wanted id for that product
 * has been seen, so the cost tracks what is missing, not the size of the catalogue.
 */
export async function fetchExactTimes({ wanted, fetchImpl, sleepImpl, minGapMs, log = () => {} }) {
  const byProduct = new Map();
  for (const { id, productId, productUrl } of wanted) {
    if (!productId) continue;
    if (!byProduct.has(productId)) byProduct.set(productId, { ids: new Set(), productUrl });
    byProduct.get(productId).ids.add(id);
  }

  const found = new Map();
  let pages = 0;
  for (const [productId, { ids, productUrl }] of byProduct) {
    const pending = new Set(ids);
    for (let page = 1; page <= MAX_PRODUCT_PAGES && pending.size; page++) {
      const result = await fetchProductReviewPage({ productId, productUrl, page, fetchImpl, sleepImpl, minGapMs });
      pages++;
      for (const raw of result.list) {
        const exact = normalizeProductReview(raw);
        if (pending.delete(exact.id)) found.set(exact.id, exact);
      }
      if (!result.hasNext || result.list.length === 0) break;
    }
    log(`  produk ${productId}: ${ids.size - pending.size}/${ids.size} waktu persis`);
  }
  return { found, pages };
}

// --- Store

export const emptyDoc = (shopId) => ({ shopId: String(shopId), shopName: '', syncedAt: null, summary: null, reviews: {} });

export async function loadReviews(shopId = loadTokopediaConfig().shopId) {
  const doc = await readDoc(REVIEWS_DOC);
  return doc && doc.shopId === String(shopId) ? doc : emptyDoc(shopId);
}

const WATCHED = ['rating', 'text', 'variantName', 'likes', 'productDeleted'];
const changed = (before, after) =>
  WATCHED.some((k) => before[k] !== after[k]) || (before.reply?.text ?? '') !== (after.reply?.text ?? '');

/**
 * Fold a crawl into the stored set. Exact times, once known, are never overwritten by an
 * approximate one; everything else takes the fresh value. Returns what changed, so the
 * caller can tell a person about the new one-star review and nothing else.
 */
export function mergeReviews(existing, fresh, { exact = new Map(), nowIso }) {
  const reviews = { ...existing };
  const added = [];
  const updated = [];
  for (const review of fresh) {
    const before = reviews[review.id];
    const precise = exact.get(review.id);
    const next = {
      ...(before ?? {}),
      ...review,
      firstSeenAt: before?.firstSeenAt ?? nowIso,
      lastSeenAt: nowIso,
    };
    if (precise?.createdAtEpoch) {
      Object.assign(next, { createdAtEpoch: precise.createdAtEpoch, createdAt: precise.createdAt, createdAtPrecision: 'exact' });
    } else if (before?.createdAtPrecision === 'exact') {
      Object.assign(next, { createdAtEpoch: before.createdAtEpoch, createdAt: before.createdAt, createdAtPrecision: 'exact' });
    }
    if (!before) added.push(next);
    else if (changed(before, next)) updated.push(next);
    reviews[review.id] = next;
  }
  return { reviews, added, updated };
}

/**
 * One sync: summary, shop list, exact times for whatever lacks them, merge, save.
 *
 * @param {{shopId?: string, slug?: string, quick?: boolean, fetchImpl?: typeof fetch,
 *          sleepImpl?: Function, minGapMs?: number, now?: Date, log?: Function}} options
 */
export async function syncReviews(options = {}) {
  const config = loadTokopediaConfig();
  const {
    shopId = config.shopId,
    slug = config.shopSlug,
    quick = false,
    fetchImpl,
    sleepImpl,
    minGapMs,
    now = new Date(),
    log = () => {},
  } = options;
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const nowIso = now.toISOString();
  const transport = { fetchImpl, sleepImpl, minGapMs };

  const before = await loadReviews(shopId);
  const knownIds = new Set(Object.keys(before.reviews));

  log('ringkasan toko...');
  const summary = await fetchShopSummary({ shopId, slug, ...transport });

  log(`daftar ulasan toko${quick ? ' (berhenti di halaman tanpa ulasan baru)' : ''}...`);
  const crawl = await crawlShopReviews({ shopId, slug, knownIds, stopWhenKnown: quick, nowEpoch, log, ...transport });

  const wanted = crawl.reviews.filter((r) => before.reviews[r.id]?.createdAtPrecision !== 'exact');
  let exact = new Map();
  let productPages = 0;
  if (wanted.length) {
    log(`waktu persis untuk ${wanted.length} ulasan...`);
    ({ found: exact, pages: productPages } = await fetchExactTimes({ wanted, log, ...transport }));
  }

  const merged = mergeReviews(before.reviews, crawl.reviews, { exact, nowIso });
  const doc = { ...before, shopName: crawl.shopName || before.shopName, syncedAt: nowIso, summary, reviews: merged.reviews };
  await updateDoc(REVIEWS_DOC, () => doc, emptyDoc(shopId));

  return {
    shopId: String(shopId),
    syncedAt: nowIso,
    // The first sync imports history; nothing in it is news.
    initial: knownIds.size === 0,
    summary,
    total: Object.keys(merged.reviews).length,
    listed: crawl.total,
    added: merged.added,
    updated: merged.updated,
    requests: 1 + crawl.pages + productPages,
  };
}

// --- Reading

export const sortNewest = (reviews) =>
  [...reviews].sort((a, b) => (b.createdAtEpoch ?? 0) - (a.createdAtEpoch ?? 0) || b.id.localeCompare(a.id));

/**
 * @param {object} doc  the stored document
 * @param {{ratings?: number[], sku?: string, productId?: string, sinceEpoch?: number, withText?: boolean, limit?: number}} filter
 */
export function selectReviews(doc, { ratings, sku, productId, sinceEpoch, withText, limit } = {}) {
  let list = sortNewest(Object.values(doc.reviews ?? {}));
  if (ratings?.length) list = list.filter((r) => ratings.includes(r.rating));
  if (sku) list = list.filter((r) => r.sku === sku);
  if (productId) list = list.filter((r) => r.productId === String(productId));
  if (sinceEpoch) list = list.filter((r) => (r.createdAtEpoch ?? 0) >= sinceEpoch);
  if (withText) list = list.filter((r) => r.text.trim());
  if (limit) list = list.slice(0, limit);
  return list;
}

export function reviewStats(doc, { nowEpoch = Math.floor(Date.now() / 1000) } = {}) {
  const all = Object.values(doc.reviews ?? {});
  const bucket = () => ({ count: 0, sum: 0, low: 0 });
  const add = (b, r) => {
    b.count++;
    b.sum += r.rating;
    if (r.rating <= LOW_RATING_MAX) b.low++;
  };
  const finish = (b) => ({ count: b.count, average: b.count ? Math.round((b.sum / b.count) * 100) / 100 : null, low: b.low });

  const overall = bucket();
  const last30 = bucket();
  const bySku = new Map();
  const byRating = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let unreplied = 0;
  for (const r of all) {
    add(overall, r);
    if ((r.createdAtEpoch ?? 0) >= nowEpoch - 30 * 86400) add(last30, r);
    const key = r.sku ?? `(tanpa SKU) ${r.productName}`;
    if (!bySku.has(key)) bySku.set(key, bucket());
    add(bySku.get(key), r);
    if (r.rating in byRating) byRating[r.rating]++;
    if (!r.reply) unreplied++;
  }
  return {
    written: finish(overall),
    last30Days: finish(last30),
    byRating,
    bySku: Object.fromEntries([...bySku].map(([k, b]) => [k, finish(b)]).sort((a, b) => b[1].count - a[1].count)),
    unreplied,
    summary: doc.summary ?? null,
    syncedAt: doc.syncedAt ?? null,
  };
}

// --- Export

const csvCell = (value) => {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const CSV_COLUMNS = ['id', 'created_at', 'time_precision', 'rating', 'sku', 'product', 'variant', 'reviewer', 'text', 'reply', 'images', 'videos', 'likes', 'url'];

export function toCsv(reviews) {
  const rows = reviews.map((r) => [
    r.id,
    r.createdAt ?? '',
    r.createdAtPrecision,
    r.rating,
    r.sku ?? '',
    r.productName,
    r.variantName,
    r.anonymous ? '(anonim)' : r.reviewerName,
    r.text,
    r.reply?.text ?? '',
    r.images.map((i) => i.full).join(' '),
    r.videos.map((v) => v.url).join(' '),
    r.likes,
    r.productUrl,
  ]);
  return [CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}
