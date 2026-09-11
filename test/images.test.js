import test from 'node:test';
import assert from 'node:assert/strict';
import { mapImages, sizedUrl } from '../src/shopify/images.js';
import { imageKey } from '../src/mekari/images.js';

const img = (name) => ({ url: `https://cdn.shopify.com/s/files/1/x/${name}?v=1`, altText: name, width: 2048, height: 2048 });
const node = ({ status = 'ACTIVE', featured = null, variants = [] }) => ({
  id: 'gid://shopify/Product/1', title: 'P', status,
  featuredMedia: featured ? { preview: { image: featured } } : null,
  variants: { nodes: variants.map(([sku, media]) => ({ id: 'v', sku, title: sku, media: { nodes: media ? [{ preview: { image: media } }] : [] } })) },
});

test("a variant's own picture wins over the product's, and both map onto the master SKU", () => {
  const { images } = mapImages([node({
    featured: img('product.jpg'),
    variants: [['OMP-45-001', img('v45.jpg')], ['OMP-90-001', null]],
  })]);
  assert.equal(images.get('OMP-45-001').source, 'variant');
  assert.match(images.get('OMP-45-001').url, /v45\.jpg/);
  assert.equal(images.get('OMP-90-001').source, 'product');
  assert.match(images.get('OMP-90-001').url, /product\.jpg/);
});

test('a channel alias lands on the master SKU, an unknown SKU is reported not guessed', () => {
  const { images, unknown } = mapImages([node({ featured: img('p.jpg'), variants: [['GFT-POUCH-001', null], ['SKU-ASING', null]] })]);
  assert.ok(images.has('Travel-Pouch'), 'GFT-POUCH-001 adalah alias Travel-Pouch');
  assert.deepEqual(unknown, ['SKU-ASING']);
});

test('a draft or archived listing contributes nothing', () => {
  const { images } = mapImages([node({ status: 'DRAFT', featured: img('p.jpg'), variants: [['OMP-45-001', null]] })]);
  assert.equal(images.size, 0);
});

test('a generic duplicate listing cannot overwrite a variant-specific picture', () => {
  const { images } = mapImages([
    node({ featured: img('a.jpg'), variants: [['OMP-45-001', img('specific.jpg')]] }),
    node({ featured: img('generic.jpg'), variants: [['OMP-45-001', null]] }),
  ]);
  assert.match(images.get('OMP-45-001').url, /specific\.jpg/);
});

test('one picture serves as thumbnail and as full size through the CDN width parameter', () => {
  const url = 'https://cdn.shopify.com/s/files/1/x/p.webp?v=123';
  assert.equal(sizedUrl(url, 240), 'https://cdn.shopify.com/s/files/1/x/p.webp?v=123&width=240');
  assert.equal(sizedUrl('', 240), '');
  // Its identity ignores the size, so a re-sized fetch is not mistaken for a new picture.
  assert.equal(imageKey(sizedUrl(url, 240)), imageKey(sizedUrl(url, 1200)));
  assert.notEqual(imageKey(url), imageKey(url.replace('p.webp', 'q.webp')));
});
