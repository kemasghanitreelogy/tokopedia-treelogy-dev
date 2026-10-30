import { klaviyoProductFor, KLAVIYO_PRODUCTS } from '../klaviyo/reviews.js';
import { moderate, MODERATION_POLICY_VERSION } from './moderation.js';

/**
 * The public review page on treelogy.com, as data.
 *
 * Everything the storefront shows about reviews is computed here and nowhere else: the
 * page is rendered by Liquid from what this module produces (see publish.js), so search
 * engines and AI crawlers - which do not run JavaScript - read the same numbers a buyer
 * sees, and no number is ever typed by hand.
 *
 * Two outputs:
 *
 * - `pages`: written reviews that pass moderation, newest first, cut into pages. A card
 *   is small on purpose (short keys) because each page is one JSON field on a metaobject.
 * - `summary`: every rating counted, including star-only ones and reviews whose text is
 *   held, per channel, per star and per product, with how many were held and why.
 *
 * Ratings per channel come from each marketplace's own shop summary where it has one
 * (Tokopedia's counts star-only ratings this service cannot list, and includes TikTok
 * Shop), so the page states the figure a buyer can check on the marketplace itself.
 */

export const PER_PAGE = 40;
const MAX_TEXT = 1200;

export const SOURCES = {
  shopee: { label: 'Shopee', url: 'https://shopee.co.id/shop/1592826980', verification: 'shopee_buyer' },
  tokopedia: { label: 'Tokopedia', url: 'https://www.tokopedia.com/treelogy-moringa/review', verification: 'tokopedia_buyer' },
  site: { label: 'treelogy.com', url: '', verification: 'site_verified' },
};

const BY_HANDLE = Object.fromEntries(Object.entries(KLAVIYO_PRODUCTS).map(([key, p]) => [p.handle, { key, ...p }]));

export function productOf(review) {
  if (review.channel === 'site') return BY_HANDLE[review.productHandle] ?? null;
  return klaviyoProductFor(review);
}

/** The key a photo is filed under in the media ledger. */
export const imageKey = (review, image, index) => `${review.channel}:${review.id}:${image.id || index}`;

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const emptyDist = () => ({ 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 });

function stats(dist) {
  const count = Object.values(dist).reduce((a, b) => a + b, 0);
  const sum = Object.entries(dist).reduce((a, [star, n]) => a + Number(star) * n, 0);
  return { ratings: count, average: count ? round(sum / count) : null, distribution: dist };
}

function distOf(reviews) {
  const dist = emptyDist();
  for (const r of reviews) if (r.rating >= 1 && r.rating <= 5) dist[r.rating] += 1;
  return dist;
}

const hasContent = (r) => Boolean(String(r.text ?? '').trim()) || (r.images?.length ?? 0) > 0;

/**
 * @param {object} input
 * @param {object} input.doc         combined marketplace doc (src/reviews/combined.js)
 * @param {object[]} input.site      verified treelogy.com reviews (src/reviews/site.js)
 * @param {object} input.media       image key -> { u, w, h } of photos already on Shopify Files
 * @param {string} input.now         ISO timestamp of this build
 */
export function buildHub({ doc, site = [], media = {}, now = new Date().toISOString(), perPage = PER_PAGE }) {
  const marketplace = Object.values(doc.reviews ?? {});
  const all = [...marketplace, ...site];

  const held = { health_claim: 0, contact: 0, hidden: 0 };
  const cards = [];
  const wantedImages = [];
  for (const r of all) {
    if (!hasContent(r)) continue;
    if (r.hidden) {
      held.hidden += 1;
      continue;
    }
    const verdict = moderate(r.text);
    if (!verdict.show) {
      held[verdict.reason] += 1;
      continue;
    }
    const product = productOf(r);
    const images = [];
    (r.images ?? []).forEach((image, i) => {
      const key = imageKey(r, image, i);
      if (media[key]?.u) images.push(media[key]);
      else wantedImages.push({ key, review: r, image });
    });
    const reply = r.reply?.text && moderate(r.reply.text).show ? r.reply.text.slice(0, MAX_TEXT) : null;
    cards.push({
      k: `${r.channel}:${r.id}`,
      c: r.channel,
      r: r.rating,
      t: String(r.text ?? '').trim().slice(0, MAX_TEXT),
      n: r.anonymous || !r.reviewerName ? '' : r.reviewerName,
      d: day(r.createdAt),
      a: r.createdAtPrecision === 'approx' ? 1 : 0,
      h: product?.handle ?? '',
      v: r.variantName || '',
      im: images,
      vd: (r.videos ?? []).length,
      rp: reply,
      u: r.productUrl || SOURCES[r.channel]?.url || '',
      _e: r.createdAtEpoch ?? 0,
    });
  }
  cards.sort((a, b) => b._e - a._e || (a.k < b.k ? -1 : 1));
  for (const card of cards) delete card._e;

  const pages = [];
  for (let i = 0; i < cards.length; i += perPage) pages.push(cards.slice(i, i + perPage));

  // Per channel: the marketplace's own shop summary when it has one.
  const channels = {};
  for (const id of ['shopee', 'tokopedia']) {
    const s = doc.channels?.[id]?.summary;
    const own = marketplace.filter((r) => r.channel === id);
    const dist = s?.distribution ? { ...emptyDist(), ...Object.fromEntries(Object.entries(s.distribution).map(([k, v]) => [k, Number(v) || 0])) } : distOf(own);
    channels[id] = {
      label: SOURCES[id].label,
      url: SOURCES[id].url,
      ...stats(dist),
      score: s?.score ?? null,
      written: own.filter(hasContent).length,
      includes_tiktok: Boolean(s?.aggregatedWithTikTok),
      synced_at: doc.channels?.[id]?.syncedAt ?? null,
    };
  }
  channels.site = { label: SOURCES.site.label, url: '', ...stats(distOf(site)), score: null, written: site.filter(hasContent).length, includes_tiktok: false, synced_at: now };

  const total = emptyDist();
  for (const c of Object.values(channels)) for (const star of Object.keys(total)) total[star] += c.distribution[star] ?? 0;

  // Per product: every rating this service holds a record of (Tokopedia's star-only ratings have no product).
  const products = {};
  for (const r of all) {
    const p = productOf(r);
    if (!p) continue;
    products[p.key] ??= { handle: p.handle, name: p.name, dist: emptyDist(), written: 0 };
    if (r.rating >= 1 && r.rating <= 5) products[p.key].dist[r.rating] += 1;
  }
  for (const card of cards) {
    const entry = Object.values(products).find((p) => p.handle === card.h);
    if (entry) entry.written += 1;
  }
  const productList = Object.values(products)
    .map(({ dist, ...p }) => ({ ...p, ...stats(dist) }))
    .filter((p) => p.ratings > 0)
    .sort((a, b) => b.ratings - a.ratings);

  const latest = cards.find((c) => c.d)?.d ?? null;
  const summary = {
    updated_at: now,
    policy_version: MODERATION_POLICY_VERSION,
    ...stats(total),
    channels,
    products: productList,
    written: {
      total: all.filter(hasContent).length,
      shown: cards.length,
      held,
      with_photos: cards.filter((c) => c.im.length).length,
      photos: cards.reduce((n, c) => n + c.im.length, 0),
      with_reply: cards.filter((c) => c.rp).length,
    },
    topics: (doc.channels?.tokopedia?.summary?.topics ?? []).map((t) => ({ key: t.key, title: t.title, rating: round(t.rating), reviews: t.reviews })),
    latest_review: latest,
    pages: pages.length,
    per_page: perPage,
  };

  return { summary, pages, wantedImages };
}
