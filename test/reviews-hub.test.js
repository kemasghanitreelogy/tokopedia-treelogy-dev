import test from 'node:test';
import assert from 'node:assert/strict';
import { moderate } from '../src/reviews/moderation.js';
import { normalizeKlaviyoReview } from '../src/reviews/site.js';
import { buildHub, imageKey } from '../src/reviews/hub.js';
import { photoSource } from '../src/reviews/publish.js';

const review = (over = {}) => ({
  id: '1', channel: 'shopee', sku: 'OMC-90-001', productName: 'TREELOGY - Organic Moringa Capsules', variantName: '1 Month',
  rating: 5, text: 'Packing rapi, pengiriman cepat', reviewerName: 'bytian', anonymous: false, hidden: false,
  createdAt: '2026-10-29T18:58:09.000Z', createdAtEpoch: 1793300289, createdAtPrecision: 'exact',
  reply: { text: 'Terima kasih, Kak' }, images: [], videos: [], productUrl: 'https://shopee.co.id/product/1/2',
  ...over,
});

const doc = (reviews, channels = {}) => ({
  channels,
  reviews: Object.fromEntries(reviews.map((r) => [`${r.channel}:${r.id}`, r])),
});

test('health and vitality claims are held, in either language and with Indonesian clitics', () => {
  assert.equal(moderate('Sendi saya tidak kaku lagi').reason, 'health_claim');
  assert.equal(moderate('blm tahu khasiatnya').reason, 'health_claim');
  assert.equal(moderate('I sleep much better now').reason, 'health_claim');
  assert.equal(moderate('cocok apa pun keluhannya').reason, 'health_claim');
});

test('ordinary words that merely contain a held word are not held', () => {
  // "asi" sits inside "biasa" and "sesuai"; "bab" inside "abab"
  assert.equal(moderate('Biasa beli di sini, barang sesuai pesanan').show, true);
  assert.equal(moderate('Packing rapi dan aman').show, true);
});

test('phone numbers and e-mail addresses are held as contact details', () => {
  assert.equal(moderate('hubungi 0812 3456 7890 ya').reason, 'contact');
  assert.equal(moderate('email saya a.b@gmail.com').reason, 'contact');
});

test('only verified, published, non-imported Klaviyo reviews are site reviews', () => {
  const item = (attrs) => ({ id: '9', attributes: { status: { value: 'published' }, verified: true, rating: 5, author: 'Ana', content: 'Enak', created: '2026-09-01T00:00:00+00:00', product: { url: 'https://x.myshopify.com/products/organic-moringa-powder' }, images: [], email: 'ana@gmail.com', ...attrs } });
  assert.equal(normalizeKlaviyoReview(item({})).productHandle, 'organic-moringa-powder');
  assert.equal(normalizeKlaviyoReview(item({ email: 'shopee-x@ulasan.treelogy.com' })), null, 'a marketplace import would be counted twice');
  assert.equal(normalizeKlaviyoReview(item({ verified: false })), null, 'no order behind it, never shown');
  assert.equal(normalizeKlaviyoReview(item({ status: { value: 'rejected' } })), null);
});

test('every rating counts, but only written reviews that pass moderation become cards', () => {
  const reviews = [
    review({ id: '1', createdAtEpoch: 3 }),
    review({ id: '2', text: '', rating: 4, createdAtEpoch: 2 }),
    review({ id: '3', text: 'Gula darah saya turun', rating: 5, createdAtEpoch: 1 }),
    review({ id: '4', text: 'Kurang cocok rasanya', rating: 2, createdAtEpoch: 4, hidden: true }),
  ];
  const { summary, pages } = buildHub({ doc: doc(reviews), now: '2026-10-30T00:00:00Z' });
  assert.deepEqual(pages.flat().map((c) => c.k), ['shopee:1']);
  assert.equal(summary.ratings, 4, 'star-only, held and hidden reviews still count');
  assert.deepEqual(summary.written.held, { health_claim: 1, contact: 0, hidden: 1 });
  assert.equal(summary.products[0].handle, 'organic-moringa-capsules');
});

test('cards are newest first and cut into pages', () => {
  const reviews = Array.from({ length: 5 }, (_, i) => review({ id: String(i), createdAtEpoch: i }));
  const { pages, summary } = buildHub({ doc: doc(reviews), perPage: 2 });
  assert.deepEqual(pages.map((p) => p.map((c) => c.k)), [['shopee:4', 'shopee:3'], ['shopee:2', 'shopee:1'], ['shopee:0']]);
  assert.equal(summary.pages, 3);
});

test('a channel with a shop summary is counted from it, star-only ratings included', () => {
  const channels = { tokopedia: { syncedAt: 'x', summary: { score: 5, totalRatings: 2876, aggregatedWithTikTok: true, distribution: { 1: 0, 2: 5, 3: 4, 4: 53, 5: 2814 }, topics: [] } } };
  const { summary } = buildHub({ doc: doc([review({ channel: 'tokopedia' })], channels) });
  assert.equal(summary.channels.tokopedia.ratings, 2876);
  assert.equal(summary.channels.tokopedia.includes_tiktok, true);
  assert.equal(summary.ratings, 2876, 'the one stored Tokopedia review is inside the summary, not added to it');
});

test('a photo appears only once it is on Shopify; until then it is asked for', () => {
  const r = review({ images: [{ id: 'a1', full: 'https://down-id.img.susercontent.com/x' }] });
  const first = buildHub({ doc: doc([r]) });
  assert.equal(first.wantedImages.length, 1);
  assert.equal(first.pages[0][0].im.length, 0);
  const key = imageKey(r, r.images[0], 0);
  const second = buildHub({ doc: doc([r]), media: { [key]: { u: 'https://cdn.shopify.com/x.jpg', w: 800, h: 800 } } });
  assert.equal(second.wantedImages.length, 0);
  assert.equal(second.pages[0][0].im[0].u, 'https://cdn.shopify.com/x.jpg');
  assert.equal(photoSource(r, r.images[0]), 'https://down-id.img.susercontent.com/x', 'Shopee photos come from Shopee');
  assert.match(photoSource({ channel: 'tokopedia' }, { id: '77' }), /\/api\/tokopedia\/media\?id=77&s=full/, 'Tokopedia photos come from our cache');
});

test('a store reply that itself makes a claim is not shown', () => {
  const { pages } = buildHub({ doc: doc([review({ reply: { text: 'Semoga sendinya cepat membaik ya Kak' } })]) });
  assert.equal(pages[0][0].rp, null);
});
