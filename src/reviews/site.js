import { readDoc, writeDoc } from '../store/index.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Reviews written on treelogy.com itself, read from Klaviyo Reviews.
 *
 * Klaviyo holds three kinds of review, and only one of them belongs here:
 *
 * - The marketplace imports (reviewer address under ulasan.treelogy.com, see
 *   src/klaviyo/reviews.js). Those reviews already come straight from Shopee and
 *   Tokopedia; reading them back through Klaviyo would count every one twice.
 * - Reviews Klaviyo marks `verified`: written by someone with an order on the store.
 * - Everything else: carried over from Judge.me with no order behind it. The store's
 *   history includes a batch of sixty-odd reviews on one day in March 2025, a founder's
 *   letter filed as a review and a review that reads "Test". A public review page that
 *   repeats those as buyer reviews is what the FTC's rule calls an insider or fake review,
 *   so unverified reviews are never shown and never counted.
 *
 * The list is fetched at most once an hour; Klaviyo's review endpoint is paged at 100 and
 * the whole account is about two dozen requests.
 */

export const SITE_REVIEWS_DOC = 'reviews/site.json';
const IMPORT_DOMAIN = '@ulasan.treelogy.com';
const REVISION = '2026-07-15';
const MAX_AGE_MS = 60 * 60 * 1000;

const handleOf = (url) => String(url ?? '').match(/\/products\/([^/?#]+)/)?.[1] ?? '';

export function normalizeKlaviyoReview(item) {
  const a = item.attributes ?? {};
  const email = String(a.email ?? '');
  if (email.endsWith(IMPORT_DOMAIN)) return null;
  if (a.status?.value !== 'published' || a.verified !== true) return null;
  const created = a.created ? new Date(a.created) : null;
  return {
    id: String(item.id),
    channel: 'site',
    productHandle: handleOf(a.product?.url),
    productName: a.product?.name ?? '',
    sku: null,
    variantName: '',
    rating: Number(a.rating) || 0,
    text: [a.title, a.content].filter(Boolean).join('\n').trim(),
    reviewerName: a.author ?? '',
    anonymous: !a.author,
    hidden: false,
    createdAt: created ? created.toISOString() : null,
    createdAtEpoch: created ? Math.floor(created.getTime() / 1000) : null,
    createdAtPrecision: 'exact',
    reply: a.public_reply?.content ? { text: a.public_reply.content, at: a.public_reply.updated ?? null } : null,
    images: (a.images ?? []).map((url, i) => ({ id: `site${item.id}-${i}`, full: url, thumbnail: url })),
    videos: [],
    productUrl: '',
  };
}

export async function fetchSiteReviews({ apiKey = process.env.KLAVIYO_PRIVATE_API_KEY, fetchImpl = fetchWithTimeout } = {}) {
  if (!apiKey) throw new Error('KLAVIYO_PRIVATE_API_KEY belum diisi');
  const reviews = [];
  let url = 'https://a.klaviyo.com/api/reviews/?page%5Bsize%5D=100';
  for (let page = 0; url && page < 200; page++) {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Klaviyo-API-Key ${apiKey}`, revision: REVISION, accept: 'application/vnd.api+json' },
    });
    if (!response.ok) throw new Error(`Klaviyo reviews HTTP ${response.status}`);
    const body = await response.json();
    for (const item of body.data ?? []) {
      const review = normalizeKlaviyoReview(item);
      if (review) reviews.push(review);
    }
    url = body.links?.next ?? null;
  }
  return reviews;
}

/** The cached list, refreshed when older than an hour (or when `force`). A failed refresh keeps the last good list. */
export async function loadSiteReviews({ force = false, now = Date.now(), log = () => {} } = {}) {
  const cached = await readDoc(SITE_REVIEWS_DOC);
  if (!force && cached?.fetchedAt && now - Date.parse(cached.fetchedAt) < MAX_AGE_MS) return cached.reviews;
  try {
    const reviews = await fetchSiteReviews();
    await writeDoc(SITE_REVIEWS_DOC, { fetchedAt: new Date(now).toISOString(), reviews });
    return reviews;
  } catch (error) {
    log(`ulasan situs (Klaviyo): ${error.message} - memakai salinan terakhir`);
    return cached?.reviews ?? [];
  }
}
