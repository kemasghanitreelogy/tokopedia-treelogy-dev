import crypto from 'node:crypto';
import { readDoc, writeDoc } from '../store/index.js';
import { mekari } from './client.js';
import { listProducts } from './setup.js';
import { fetchProductImages, sizedUrl } from '../shopify/images.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { loadConfig } from '../config.js';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

/**
 * Put the product pictures where the people who use them can see them.
 *
 * Jurnal takes one picture per product through a multipart upload; the dashboard shows
 * them from a small manifest in Blob. Both are fed from Shopify, keyed by master SKU, and
 * both remember what they were last given so an unchanged picture costs nothing on the
 * next run - Jurnal's quota is forty requests a minute and every upload is one of them.
 */

export const IMAGES_PATHNAME = 'mekari/images.json';
/** Big enough for a Jurnal product page, small enough that 25 of them upload in a minute. */
export const JURNAL_IMAGE_WIDTH = 1200;
export const THUMB_WIDTH = 240;

export async function loadImageManifest() {
  try {
    return (await readDoc(IMAGES_PATHNAME)) ?? { version: 1, images: {} };
  } catch {
    return { version: 1, images: {} };
  }
}

export async function saveImageManifest(manifest) {
  await writeDoc(IMAGES_PATHNAME, { ...manifest, version: 1, updated_at: new Date().toISOString() });
}

/**
 * The same picture, in a format Jurnal will accept.
 *
 * The shop's media is webp. Shopify's CDN will hand back jpeg for a client that does not
 * advertise webp, which is why this worked at all - but that makes the format a property
 * of whatever Accept header the runtime happens to send, and Jurnal rejects anything that
 * is not jpg or png. Asking for it by name removes the guess.
 */
export const jurnalUrl = (url) => {
  const sized = sizedUrl(url, JURNAL_IMAGE_WIDTH);
  try {
    const u = new URL(sized);
    u.searchParams.set('format', 'jpg');
    return u.toString();
  } catch {
    return sized;
  }
};

/** A picture's identity is its Shopify URL without the size parameter Shopify lets us add. */
export const imageKey = (url) => crypto.createHash('sha1').update(String(url).replace(/\?.*$/, '')).digest('hex').slice(0, 16);

async function download(url) {
  // A 2-megapixel product photo is legitimately slower than a JSON call.
  const response = await fetchWithTimeout(url, { timeout: TIMEOUTS.download });
  if (!response.ok) throw new Error(`gambar tidak bisa diunduh: HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (!/image\/(jpeg|jpg|png)/.test(type)) throw new Error(`format ${type || 'tak dikenal'} - Jurnal hanya menerima jpg/png`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, type: type.includes('png') ? 'image/png' : 'image/jpeg' };
}

/** Jurnal's documented shape: form-data with a file under `product[image]`. */
export async function uploadProductImage(productId, { bytes, type }, { deadlineAt = null } = {}) {
  const form = new FormData();
  form.append('product[image]', new Blob([bytes], { type }), type === 'image/png' ? 'product.png' : 'product.jpg');
  const result = await mekari({ method: 'POST', path: `/public/jurnal/api/v1/products/${productId}/upload_product_image`, form, deadlineAt });
  return result?.image ?? result;
}

/**
 * Shopify to the dashboard manifest, and nothing else.
 *
 * Split out from the Jurnal upload because the two had been one job, and that job asked
 * Jurnal for its product list before it did anything at all. When the monthly API package
 * ran out, the whole thing died on its first request - so the dashboard sat on an empty
 * manifest and showed "tanpa gambar" for every product, for a reason that had nothing to
 * do with the dashboard. The pictures come from Shopify; Jurnal has no part in getting
 * them onto a page here, and now does not get a say in it.
 *
 * An entry already carrying a Jurnal upload keeps it: this refreshes where the picture
 * lives, not what has been done with it.
 *
 * @returns {Promise<{total: number, changed: number, unknown: string[]}>}
 */
export async function refreshImageManifest() {
  const [{ images, unknown }, manifest] = await Promise.all([fetchProductImages(), loadImageManifest()]);

  let changed = 0;
  for (const image of images.values()) {
    const key = imageKey(image.url);
    const known = manifest.images[image.sku];
    if (known?.key === key && known?.thumb) continue;
    manifest.images[image.sku] = {
      ...(known ?? {}),
      sku: image.sku,
      source: image.source,
      key,
      url: image.url,
      thumb: sizedUrl(image.url, THUMB_WIDTH),
      alt: image.alt,
      at: new Date().toISOString(),
    };
    changed += 1;
  }
  if (changed > 0) await saveImageManifest(manifest);
  return { total: images.size, changed, unknown };
}

/**
 * Sync pictures from Shopify to Jurnal and the dashboard manifest.
 *
 * @param {{dryRun?: boolean, deadlineAt?: number|null}} options
 */
export async function syncProductImages({ dryRun = true, deadlineAt = null } = {}) {
  // The dashboard's half runs first and on its own terms, so whatever Jurnal does or
  // refuses to do below, the pictures are on the page.
  const refreshed = dryRun ? { total: 0, changed: 0, unknown: [] } : await refreshImageManifest();

  const [{ images, unknown }, manifest, jurnalProducts] = await Promise.all([
    fetchProductImages(),
    loadImageManifest(),
    listProducts(),
  ]);

  const results = [];
  for (const image of images.values()) {
    const key = imageKey(image.url);
    const known = manifest.images[image.sku];
    const jurnalProduct = jurnalProducts.get(image.sku);
    const entry = {
      sku: image.sku, source: image.source, key,
      url: image.url, thumb: sizedUrl(image.url, THUMB_WIDTH), alt: image.alt,
    };

    if (!jurnalProduct) {
      results.push({ sku: image.sku, status: 'no-jurnal-product' });
      continue;
    }
    if (known?.key === key && known?.jurnal_image_url) {
      results.push({ sku: image.sku, status: 'unchanged' });
      continue;
    }
    if (dryRun) {
      results.push({ sku: image.sku, status: 'would-upload', source: image.source });
      continue;
    }
    if (isReadOnly()) throw new ReadOnlyError(`gambar produk ${image.sku}`);

    try {
      const file = await download(jurnalUrl(image.url));
      const uploaded = await uploadProductImage(jurnalProduct.id, file, { deadlineAt });
      manifest.images[image.sku] = { ...entry, jurnal_image_url: uploaded?.url ?? '', jurnal_product_id: jurnalProduct.id, at: new Date().toISOString() };
      // Saved after every upload, like the ledger: a run killed halfway leaves nothing to redo.
      await saveImageManifest(manifest);
      results.push({ sku: image.sku, status: 'uploaded', bytes: file.bytes.length, source: image.source });
    } catch (error) {
      results.push({ sku: image.sku, status: 'failed', error: error.message });
    }
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    dryRun, results, unknown, refreshed,
    withImage: images.size, uploaded: count('uploaded'), unchanged: count('unchanged'),
    wouldUpload: count('would-upload'), failed: count('failed'), noJurnalProduct: count('no-jurnal-product'),
  };
}
