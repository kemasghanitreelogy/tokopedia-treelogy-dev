import { sendTelegram, escapeHtml } from '../notify/telegram.js';
import { LOW_RATING_MAX } from './reviews.js';

const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);
const clip = (text, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text);
const CHANNEL_LABEL = { tokopedia: 'Tokopedia', shopee: 'Shopee' };
const channelLabel = (channel) => CHANNEL_LABEL[channel] ?? 'Tokopedia';

/** One message per low review: the thing a person wants to see the morning it lands. */
export function formatLowReview(review) {
  const who = review.anonymous ? 'anonim' : review.reviewerName || 'pembeli';
  const product = [review.productName, review.variantName].filter(Boolean).join(' · ');
  const lines = [
    `<b>Ulasan ${channelLabel(review.channel)} ${stars(review.rating)}</b> (${review.rating}/5)`,
    escapeHtml(product) + (review.sku ? ` <code>${escapeHtml(review.sku)}</code>` : ''),
    review.text ? `“${escapeHtml(clip(review.text))}”` : '(tanpa teks)',
    review.badRatingReason ? `Alasan: ${escapeHtml(review.badRatingReason)}` : null,
    `— ${escapeHtml(who)}, ${escapeHtml(review.createdAtRelative || review.createdAt || '')}`,
    review.reply ? 'Sudah dibalas.' : 'Belum dibalas.',
    review.productUrl ? `<a href="${escapeHtml(review.productUrl)}${review.channel === 'shopee' ? '' : '/review'}">buka produk</a>` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/** The digest after a sync that found anything new. */
export function formatDigest(result) {
  const { added, summary } = result;
  const dist = [5, 4, 3, 2, 1]
    .map((n) => [n, added.filter((r) => r.rating === n).length])
    .filter(([, c]) => c)
    .map(([n, c]) => `${c}×${n}★`)
    .join(', ');
  const label = channelLabel(result.channel);
  const lines = [
    result.initial
      ? `<b>${label}: ${added.length} ulasan diimpor</b> (${dist}) — sinkron pertama, riwayat lama tidak dilaporkan satu per satu.`
      : `<b>${label}: ${added.length} ulasan baru</b> (${dist})`,
    summary ? `Rating toko ${summary.score} dari ${summary.totalRatings} penilaian, ${summary.totalWritten} tertulis.` : null,
    result.updated.length ? `${result.updated.length} ulasan lama berubah (balasan/teks).` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Tell Telegram about a sync: each new review at or under three stars on its own, then
 * one digest. Keys are per review id, so a re-run in the same hour cannot repeat them.
 * The first sync of a shop sends the digest only: a year of old two-star reviews landing
 * as seven separate alerts at 02:30 is noise, not news.
 */
export async function notifyReviewSync(result, { threshold = LOW_RATING_MAX, send = sendTelegram } = {}) {
  const sent = [];
  const alerts = result.initial ? [] : result.added.filter((r) => r.rating <= threshold);
  for (const review of alerts) {
    const outcome = await send(formatLowReview(review), { key: `${review.channel ?? 'tokopedia'}-review-${review.id}` });
    if (outcome.sent) sent.push(review.id);
  }
  if (result.added.length) {
    const outcome = await send(formatDigest(result), { key: `${result.channel ?? 'tokopedia'}-review-digest-${result.syncedAt}` });
    if (outcome.sent) sent.push('digest');
  }
  return sent;
}
