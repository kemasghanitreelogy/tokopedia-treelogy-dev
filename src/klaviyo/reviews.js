import { publicBaseUrl } from '../config.js';
import { mediaSignature } from '../dashboard-auth.js';

/**
 * Marketplace reviews, in the shape Klaviyo Reviews imports.
 *
 * Klaviyo's Reviews API is read-only - it lists and exports, it does not create - so the
 * way in is the CSV import under Reviews > All reviews > Options > Import Reviews
 * ("Other/not sure"). This module writes that file, column for column as Klaviyo's
 * template has them, and decides which Shopify product each marketplace review belongs
 * to, because Klaviyo's catalogue is the Shopify one and a Tokopedia listing means
 * nothing to it.
 *
 * Two things a marketplace never gives us are still required by the template:
 *
 * - `reviewer_email`. Tokopedia and Shopee disclose a display name and nothing else. The
 *   file therefore carries an address we control, one per reviewer, under a domain of
 *   ours. One per channel was tried first and Klaviyo folded 1,513 star-only reviews into
 *   each other as duplicates - same address, same product, same empty text - so each
 *   reviewer gets their own. Klaviyo bills by active profile, which is why the profiles
 *   this creates are suppressed afterwards; a review shows the reviewer's name, never the
 *   address. `perReviewer: false` gives the one-per-channel file back.
 * - `product_id`. Klaviyo matches it against the Shopify product ID exactly. The map
 *   below is the decision of which product a marketplace SKU is a review of; a bundle or
 *   a set is credited to the product it is built around.
 */

/** Shopify product IDs, from the live catalogue on 2026-09-21. Lower IDs are the storefront originals. */
export const KLAVIYO_PRODUCTS = {
  powder: { id: '8641940390076', handle: 'organic-moringa-powder', sku: 'OMP-45-001', name: 'Organic Moringa Powder' },
  oil: { id: '8641972207804', handle: 'organic-moringa-oil', sku: 'OMO-30-001', name: 'Organic Moringa Cold-Pressed Seed Oil' },
  capsules: { id: '8642235236540', handle: 'organic-moringa-capsules', sku: 'OMC-90-001', name: 'Organic Moringa Capsules' },
  ritual: { id: '8709764841660', handle: 'moringa-ritual-set', sku: 'MRS-001', name: 'Moringa Ritual Set' },
  scoop: { id: '9043106922684', handle: 'bamboo-scoop', sku: 'Bamboo-Scoop', name: 'Bamboo Scoop' },
  whisk: { id: '9043110133948', handle: 'bamboo-whisk', sku: 'Bamboo-Whisk', name: 'Bamboo Whisk' },
  discovery: { id: '9074141200572', handle: 'the-discovery-pack', sku: 'Discovery-Pack', name: 'The Discovery Pack' },
  insideOut: { id: '9291531649212', handle: 'moringa-inside-out-protocol', sku: 'Inside-Out-Protocol', name: 'Inside Out Moringa Protocol' },
  pouch: { id: '9487891071164', handle: 'travel-pouch', sku: 'GFT-POUCH-001', name: 'Travel Pouch' },
};

/** The SKUs Shopify itself lists, so a review's own SKU can be sent when Shopify would recognise it. */
const SHOPIFY_SKUS = new Set([
  'OMP-45-001', 'OMP-90-001', 'OMP-180-001', 'OMO-30-001', 'OMO-60-001', 'OMC-90-001', 'OMC-180-001', 'OMC-270-001',
  'MRS-001', 'MRS-002', 'MRS-003', 'MRS-004', 'Bamboo-Scoop', 'Bamboo-Whisk', 'Discovery-Pack',
  'Inside-Out-Protocol', 'Inside-Out-60-Protocol180+30', 'GFT-POUCH-001', 'GFT-MYST-001',
]);

/** Which product a SKU is a review of. Sets and bundles go to the product they are built around. */
const SKU_PRODUCT = {
  'OMP-45-001': 'powder', 'OMP-90-001': 'powder', 'OMP-180-001': 'powder',
  'OMO-30-001': 'oil', 'OMO-60-001': 'oil',
  'OMC-90-001': 'capsules', 'OMC-180-001': 'capsules', 'OMC-270-001': 'capsules',
  'MRS-001': 'ritual', 'MRS-002': 'ritual', 'MRS-003': 'ritual', 'MRS-004': 'ritual',
  'Bamboo-Scoop': 'scoop', 'Bamboo-Whisk': 'whisk',
  'Discovery-Pack': 'discovery', 'The-Discovery-Pack': 'discovery',
  'The-Inside-&-Out30': 'insideOut', 'The-Inside-&-Out60': 'insideOut',
  'Inside-Out-Protocol': 'insideOut', 'Inside-Out-60-Protocol180+30': 'insideOut', 'The-Inside-&-Out180+30': 'insideOut',
  // Movement & Relief is a capsules-and-oil set whose own listing is still a Shopify draft.
  'The-Movement-&-Relief': 'capsules',
  'Travel-Pouch': 'pouch', 'GFT-POUCH-001': 'pouch',
  // A review left on the free 3ml oil is a review of the oil.
  'Mystery-Gift': 'oil', 'GFT-MYST-001': 'oil',
  '1736924837905663963': 'scoop',
};

/** A review with no SKU still names its listing; the listing's words say what it was. */
const NAME_HINTS = [
  [/kapsul|capsul/i, 'capsules'],
  [/oil|minyak/i, 'oil'],
  [/powder|bubuk/i, 'powder'],
  [/ritual/i, 'ritual'],
  [/discovery/i, 'discovery'],
  [/inside/i, 'insideOut'],
  [/scoop|sendok/i, 'scoop'],
  [/whisk/i, 'whisk'],
  [/pouch/i, 'pouch'],
];

/** @returns {{key: string, id: string, name: string}|null} */
export function klaviyoProductFor(review) {
  const key = SKU_PRODUCT[review?.sku ?? ''] ?? NAME_HINTS.find(([re]) => re.test(review?.productName ?? ''))?.[1] ?? null;
  return key ? { key, ...KLAVIYO_PRODUCTS[key] } : null;
}

const CHANNEL_LABEL = { tokopedia: 'Tokopedia', shopee: 'Shopee' };
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'anonim';

/** The mailbox a review is filed under; see the header for why it is not the reviewer's. */
export function reviewerEmail(review, { domain = 'ulasan.treelogy.com', perReviewer = true } = {}) {
  const channel = review.channel ?? 'tokopedia';
  if (!perReviewer) return `${channel}@${domain}`;
  const who = review.reviewerId && review.reviewerId !== '0' ? review.reviewerId : slug(review.reviewerName);
  return `${channel}-${who}@${domain}`;
}

const stamp = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '') : '');

/**
 * Image URLs Klaviyo can fetch: ours for Tokopedia (theirs expire), signed so they open
 * without a session; Shopee's own CDN for Shopee.
 */
export function imageUrls(review, base = publicBaseUrl(), sign = mediaSignature) {
  return (review.images ?? []).map((image) => {
    if (review.channel === 'shopee' || /^https?:\/\/(mms|cf|down-)/.test(image.full ?? '')) return image.full;
    const sig = sign(image.id, 'full');
    return `${base}/api/tokopedia/media?id=${encodeURIComponent(image.id)}&s=full${sig ? `&sig=${sig}` : ''}`;
  }).filter(Boolean);
}

export const KLAVIYO_COLUMNS = [
  'product_id', 'product_handle', 'product_sku', 'product_name', 'reviewer_email', 'reviewer_name', 'rating', 'review_title', 'review_content',
  'review_date', 'status', 'verified', 'image_urls', 'video_urls', 'reply_content', 'reply_date', 'reviewer_location', 'is_store_review', 'locale',
];

/** Video URLs as the marketplaces host them; Tokopedia's are signed and may lapse, Shopee's do not. */
export const videoUrls = (review) => (review.videos ?? []).map((v) => v?.url).filter(Boolean);

/**
 * One row per review, in the template's columns. Reviews without a product become store reviews.
 *
 * Klaviyo folds two reviews with the same address, product and text into one. A repeat
 * buyer who rates the same product again without a word is exactly that - 239 of them
 * on the second import - so the second and later such reviews get a numbered address,
 * and every rating the buyer left is counted.
 */
export function klaviyoRows(reviews, options = {}) {
  const seen = new Map();
  return reviews.map((review) => {
    const product = klaviyoProductFor(review);
    let email = reviewerEmail(review, options);
    const key = `${email}|${product?.id ?? ''}|${String(review.text ?? '').trim()}`;
    const times = (seen.get(key) ?? 0) + 1;
    seen.set(key, times);
    if (times > 1) email = email.replace('@', `-${times}@`);
    return {
      product_id: product?.id ?? '',
      product_handle: product?.handle ?? '',
      // The review's own SKU when Shopify lists it, otherwise the product's lead SKU.
      product_sku: product ? (SHOPIFY_SKUS.has(review.sku ?? '') ? review.sku : product.sku) : '',
      product_name: product?.name ?? '',
      reviewer_email: email,
      reviewer_name: review.anonymous ? 'Pembeli' : (review.reviewerName || 'Pembeli'),
      rating: Number(review.rating) || 0,
      review_title: '',
      review_content: String(review.text ?? '').trim(),
      review_date: stamp(review.createdAt),
      status: 'Published',
      // Every marketplace review sits on an order the marketplace itself verified.
      verified: 'Yes',
      image_urls: imageUrls(review, options.base, options.sign).join(','),
      video_urls: videoUrls(review).join(','),
      reply_content: String(review.reply?.text ?? '').trim(),
      reply_date: stamp(review.reply?.at),
      reviewer_location: 'ID',
      is_store_review: product ? 'false' : 'true',
      locale: 'id-ID',
      channel: CHANNEL_LABEL[review.channel ?? 'tokopedia'] ?? review.channel,
    };
  });
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The file Klaviyo imports. A UTF-8 BOM, so Excel and Klaviyo both read the accents. */
export function toKlaviyoCsv(reviews, options = {}) {
  const rows = klaviyoRows(reviews, options);
  const lines = [KLAVIYO_COLUMNS.join(',')];
  for (const row of rows) lines.push(KLAVIYO_COLUMNS.map((col) => csvCell(row[col])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** What the export will contain, for the message beside the button. */
export function klaviyoSummary(reviews) {
  const rows = klaviyoRows(reviews);
  const byProduct = {};
  let unmapped = 0;
  for (const row of rows) {
    if (!row.product_id) { unmapped += 1; continue; }
    byProduct[row.product_name] = (byProduct[row.product_name] ?? 0) + 1;
  }
  return { total: rows.length, unmapped, byProduct };
}
