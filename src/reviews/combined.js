import { loadReviews as loadTokopediaReviews } from '../tokopedia/reviews.js';
import { loadShopeeReviews } from '../shopee/reviews.js';

/**
 * Both marketplaces' reviews as one set.
 *
 * Each channel keeps its own document, written by its own sync on its own schedule; the
 * dashboard and the CLI read them together. Records are keyed by channel and id, because
 * both marketplaces hand out plain numbers that could one day collide.
 */

export const REVIEW_CHANNELS = {
  tokopedia: { label: 'Tokopedia', short: 'TP', accent: '#42B549' },
  shopee: { label: 'Shopee', short: 'SP', accent: '#EE4D2D' },
};

export const reviewKey = (review) => `${review.channel ?? 'tokopedia'}:${review.id}`;

export function combineReviewDocs({ tokopedia = null, shopee = null } = {}) {
  const reviews = {};
  const channels = {};
  const add = (channel, doc) => {
    if (!doc) return;
    channels[channel] = { syncedAt: doc.syncedAt ?? null, summary: doc.summary ?? null, shopName: doc.shopName ?? '', shopId: doc.shopId ?? '' };
    for (const r of Object.values(doc.reviews ?? {})) {
      const record = { ...r, channel: r.channel ?? channel };
      reviews[reviewKey(record)] = record;
    }
  };
  add('tokopedia', tokopedia);
  add('shopee', shopee);
  const stamps = Object.values(channels).map((c) => c.syncedAt).filter(Boolean).sort();
  return { channels, syncedAt: stamps.at(-1) ?? null, reviews };
}

export async function loadAllReviews() {
  const [tokopedia, shopee] = await Promise.all([loadTokopediaReviews(), loadShopeeReviews()]);
  return combineReviewDocs({ tokopedia, shopee });
}
