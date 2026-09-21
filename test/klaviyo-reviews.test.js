import test from 'node:test';
import assert from 'node:assert/strict';
import {
  klaviyoProductFor, reviewerEmail, imageUrls, klaviyoRows, toKlaviyoCsv, klaviyoSummary, KLAVIYO_COLUMNS, KLAVIYO_PRODUCTS,
} from '../src/klaviyo/reviews.js';

const review = (over = {}) => ({
  id: '109358801068', channel: 'shopee', sku: 'OMO-60-001', productName: 'TREELOGY - Organic Moringa Cold-Pressed Seed Oil',
  rating: 5, text: 'Sangat bermanfaat, "wangi" dan cepat meresap', reviewerId: '', reviewerName: 'schintyaaa23', anonymous: false,
  createdAt: '2026-09-11T09:03:36.000Z', images: [{ id: '1011248965190', thumbnail: 'https://mms.img.susercontent.com/a', full: 'https://mms.img.susercontent.com/a' }],
  reply: { text: 'Terima kasih, Kak', at: '2026-09-12T02:34:06.000Z' },
  ...over,
});

test('every SKU the shop has ever sold lands on one Shopify product, sets on what they are built around', () => {
  assert.equal(klaviyoProductFor({ sku: 'OMP-180-001' }).id, KLAVIYO_PRODUCTS.powder.id);
  assert.equal(klaviyoProductFor({ sku: 'OMC-90-001' }).key, 'capsules');
  assert.equal(klaviyoProductFor({ sku: 'MRS-003' }).key, 'ritual');
  assert.equal(klaviyoProductFor({ sku: 'The-Inside-&-Out60' }).key, 'insideOut');
  assert.equal(klaviyoProductFor({ sku: 'The-Movement-&-Relief' }).key, 'capsules', 'a set with a draft listing goes to its main product');
  assert.equal(klaviyoProductFor({ sku: 'GFT-MYST-001' }).key, 'oil', 'the free 3ml oil is the oil');
  // No SKU, but the listing's name still says what it was.
  assert.equal(klaviyoProductFor({ sku: null, productName: 'TREELOGY - Organic Moringa Capsules | Kapsul Suplemen' }).key, 'capsules');
  assert.equal(klaviyoProductFor({ sku: null, productName: '(FREE GIFT - DO NOT ORDER) Treelogy Gift with Purchase' }), null, 'a gift line names no product');
});

test('the reviewer address is ours, one per reviewer, or one per channel when asked', () => {
  // One per channel made Klaviyo fold every star-only review into the last one it saw.
  assert.equal(reviewerEmail(review()), 'shopee-schintyaaa23@ulasan.treelogy.com');
  assert.equal(reviewerEmail(review({ channel: 'tokopedia', reviewerId: '2405911' })), 'tokopedia-2405911@ulasan.treelogy.com');
  assert.equal(reviewerEmail(review({ reviewerName: 'Dewi L.' })), 'shopee-dewi-l@ulasan.treelogy.com');
  assert.equal(reviewerEmail(review(), { perReviewer: false }), 'shopee@ulasan.treelogy.com');
  assert.equal(reviewerEmail(review({ channel: 'tokopedia' }), { perReviewer: false }), 'tokopedia@ulasan.treelogy.com');
});

test('images are served from where they will still exist when Klaviyo fetches them', () => {
  assert.deepEqual(imageUrls(review()), ['https://mms.img.susercontent.com/a']);
  const tokped = review({ channel: 'tokopedia', images: [{ id: '200509029', thumbnail: 'https://p16-images-sign-sg.tokopedia-static.net/x?x-expires=1', full: 'https://p19-images-sign-sg.tokopedia-static.net/y?x-expires=1' }] });
  // Signed, because Klaviyo fetches with no session: 209 photos were "invalid image" without it.
  assert.deepEqual(imageUrls(tokped, 'https://api.treelogy-services.my.id', (id, size) => `sig-${id}-${size}`),
    ['https://api.treelogy-services.my.id/api/tokopedia/media?id=200509029&s=full&sig=sig-200509029-full']);
});

test('the CSV is the template, column for column, with quotes and dates Klaviyo reads', () => {
  const csv = toKlaviyoCsv([review(), review({ channel: 'tokopedia', id: '1', sku: null, productName: '(FREE GIFT) Gift', text: '', images: [], reply: null, anonymous: true, rating: 4, createdAt: '2025-05-12T22:02:25.000Z' })]);
  const lines = csv.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  assert.equal(lines[0], KLAVIYO_COLUMNS.join(','));
  assert.equal(lines.length, 3);
  const [first, second] = lines.slice(1);
  assert.ok(first.startsWith(`${KLAVIYO_PRODUCTS.oil.id},organic-moringa-oil,OMO-60-001,Organic Moringa Cold-Pressed Seed Oil,shopee-schintyaaa23@ulasan.treelogy.com,schintyaaa23,5,,`), first);
  assert.ok(first.includes('"Sangat bermanfaat, ""wangi"" dan cepat meresap"'), 'quotes and commas are escaped the CSV way');
  assert.ok(first.includes(',2026-09-11 09:03:36,Published,Yes,https://mms.img.susercontent.com/a,,'), 'the date is one Klaviyo accepts');
  assert.ok(first.includes(',2026-09-12 02:34:06,ID,false,id-ID'));
  assert.ok(second.startsWith(',,,,tokopedia-schintyaaa23@ulasan.treelogy.com,Pembeli,4,,,2025-05-12 22:02:25,Published,Yes,,,,,ID,true,id-ID'), second);
  // A set's own SKU is not a Shopify SKU, so the product's lead SKU goes in its place.
  const set = klaviyoRows([review({ sku: 'The-Inside-&-Out60', videos: [{ id: 'v', url: 'https://cf.shopee.co.id/v.mp4' }] })])[0];
  assert.equal(set.product_handle, 'moringa-inside-out-protocol');
  assert.equal(set.product_sku, 'Inside-Out-Protocol');
  assert.equal(set.video_urls, 'https://cf.shopee.co.id/v.mp4');

  const summary = klaviyoSummary([review(), review({ sku: 'OMC-90-001' }), review({ sku: null, productName: 'Gift' })]);
  assert.equal(summary.total, 3);
  assert.equal(summary.unmapped, 1);
  assert.equal(summary.byProduct['Organic Moringa Capsules'], 1);
});

test('a signed photo URL opens for that photo and no other', async () => {
  const { mediaSignature, mediaSignatureMatches } = await import('../src/dashboard-auth.js');
  const had = process.env.DASHBOARD_TOKEN;
  process.env.DASHBOARD_TOKEN = 'kunci-uji-yang-panjang';
  try {
    const sig = mediaSignature('200509029', 'full');
    assert.match(sig, /^[A-Za-z0-9_-]{24}$/);
    assert.ok(mediaSignatureMatches('200509029', 'full', sig));
    assert.ok(!mediaSignatureMatches('200509030', 'full', sig), 'another photo');
    assert.ok(!mediaSignatureMatches('200509029', 'thumb', sig), 'another size');
    assert.ok(!mediaSignatureMatches('200509029', 'full', ''), 'no signature at all');
  } finally {
    if (had === undefined) delete process.env.DASHBOARD_TOKEN; else process.env.DASHBOARD_TOKEN = had;
  }
});

test('a repeat rating of the same product by the same buyer is not folded away', () => {
  const twice = [review({ id: 'a', text: '' }), review({ id: 'b', text: '' }), review({ id: 'c', text: '' }), review({ id: 'd', text: 'beda' })];
  const rows = klaviyoRows(twice);
  assert.deepEqual(rows.map((r) => r.reviewer_email), [
    'shopee-schintyaaa23@ulasan.treelogy.com', 'shopee-schintyaaa23-2@ulasan.treelogy.com', 'shopee-schintyaaa23-3@ulasan.treelogy.com',
    'shopee-schintyaaa23@ulasan.treelogy.com',
  ]);
});
