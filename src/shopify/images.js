import { shopifyGraphql, paginate } from './client.js';
import { loadShopifyConfig } from './config.js';
import { findProduct } from '../master.js';

/**
 * Product pictures, from the one channel that has them in a usable form.
 *
 * Shopify holds a picture per product and, where the merchant set one, per variant. The
 * marketplaces have pictures too, but behind their own CDNs with expiring links, so
 * Shopify is the source. Every picture is keyed by our master SKU - the master catalogue
 * resolves a channel's own SKU onto ours - so one picture serves the same product on
 * every channel, in Jurnal and on the dashboard alike.
 */

/** Validated against the live 2026-07 schema via the Shopify Admin skill. */
export const PRODUCT_IMAGES_QUERY = `
query TreelogyProductImages($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      status
      featuredMedia {
        preview { image { url altText width height } }
      }
      variants(first: 100) {
        nodes {
          id
          sku
          title
          media(first: 1) {
            nodes { preview { image { url altText width height } } }
          }
        }
      }
    }
  }
}`;

/**
 * Shopify's CDN takes a size in the URL, so the same picture can be fetched as a thumbnail
 * for a card and at full size for Jurnal without storing two files.
 */
export function sizedUrl(url, size) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.searchParams.set('width', String(size));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * @returns {Map<string, {sku, url, alt, source: 'variant'|'product', product, variant}>}
 *   keyed by master SKU. A variant's own picture wins over the product's; a SKU the master
 *   does not know is left out rather than guessed at.
 */
export async function fetchProductImages(config = loadShopifyConfig()) {
  const products = await paginate(PRODUCT_IMAGES_QUERY, {}, (d) => d.products, { max: 500, config });
  return mapImages(products);
}

/** The pure half: GraphQL product nodes in, master-keyed pictures out. */
export function mapImages(products) {
  const bySku = new Map();
  const unknown = [];

  for (const product of products) {
    if (product.status !== 'ACTIVE') continue;
    const productImage = product.featuredMedia?.preview?.image ?? null;
    for (const variant of product.variants?.nodes ?? []) {
      if (!variant.sku) continue;
      const master = findProduct(variant.sku);
      if (!master) { unknown.push(variant.sku); continue; }
      const variantImage = variant.media?.nodes?.[0]?.preview?.image ?? null;
      const image = variantImage ?? productImage;
      if (!image?.url) continue;
      // First live variant to claim a master SKU keeps it; a duplicate listing of the
      // same SKU does not get to overwrite a variant-specific picture with a generic one.
      const existing = bySku.get(master.sku);
      if (existing && existing.source === 'variant' && !variantImage) continue;
      bySku.set(master.sku, {
        sku: master.sku,
        url: image.url,
        alt: image.altText ?? '',
        width: image.width ?? null,
        height: image.height ?? null,
        source: variantImage ? 'variant' : 'product',
        product: product.title,
        variant: variant.title,
      });
    }
  }
  return { images: bySku, unknown: [...new Set(unknown)] };
}
