import { callApi } from './client.js';
import { loadConfig } from './config.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi } from './shopee/client.js';
import { shopifyGraphql } from './shopify/client.js';
import { loadShopifyConfig } from './shopify/config.js';

/**
 * One listing on one channel: read it, change it, switch it off and on.
 *
 * Every endpoint here was checked against the channel's own published schema before it
 * was written - TikTok's bundled OAS (partial_edit 202509 is the newest edit), Shopee's
 * v2 docs (update_item, unlist_item, media_space.upload_image), and the Shopify Admin
 * 2026-07 schema through the validator.
 *
 * What a listing is differs, and the caller has to know it: on TikTok and Shopee the
 * title, description, pictures, weight and box belong to the listing, so changing them
 * for one SKU changes them for every variant on that listing. Shopify keeps weight per
 * variant and has no box dimensions at all.
 *
 * A patch carries only what the operator changed. Descriptions are HTML on TikTok and
 * Shopify and plain text on Shopee, so rewriting one the operator did not touch, through a
 * plain textarea, would flatten its formatting for nothing.
 */

/** The dashboard's units: grams and centimetres. */
const kg = (grams) => (Number(grams) / 1000).toFixed(3).replace(/\.?0+$/, '');

/** Plain text, one paragraph per blank-line block, as HTML. */
export function textToHtml(text) {
  const escape = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return String(text ?? '').trim().split(/\n{2,}/).map((block) => `<p>${escape(block).replace(/\n/g, '<br>')}</p>`).join('');
}

/** HTML as the plain text a textarea can hold. */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ TikTok / Tokopedia */

const TIKTOK_PLATFORMS = ['TOKOPEDIA', 'TIKTOK_SHOP'];

async function readTikTok(ref) {
  const { data } = await callApi({ config: loadConfig(), path: `/product/202309/products/${ref.productId}` });
  const w = data.package_weight;
  const d = data.package_dimensions;
  return {
    title: data.title ?? '',
    description: htmlToText(data.description),
    images: (data.main_images ?? []).map((i) => i.urls?.[0] ?? i.thumb_urls?.[0]).filter(Boolean),
    weightGram: w?.value ? Math.round(Number(w.value) * (w.unit === 'POUND' ? 453.592 : 1000)) : null,
    dims: d?.length ? { l: Number(d.length), w: Number(d.width), h: Number(d.height) } : null,
    status: data.status ?? '',
    variants: (data.skus ?? []).length,
  };
}

export async function uploadTikTokImage(file) {
  const form = new FormData();
  form.append('data', new Blob([file.buffer], { type: file.type || 'image/jpeg' }), file.name || 'image.jpg');
  form.append('use_case', 'MAIN_IMAGE');
  // The upload is shop-agnostic: TikTok refuses it outright when shop_cipher is sent.
  const { data } = await callApi({ config: loadConfig(), method: 'POST', path: '/product/202309/images/upload', form, shopCipher: false });
  if (!data.uri) throw new Error('TikTok tidak mengembalikan URI gambar');
  return data.uri;
}

async function editTikTok(ref, patch, images) {
  const body = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.description !== undefined) body.description = textToHtml(patch.description);
  if (patch.weightGram !== undefined) body.package_weight = { value: kg(patch.weightGram), unit: 'KILOGRAM' };
  if (patch.dims !== undefined) {
    body.package_dimensions = { length: String(patch.dims.l), width: String(patch.dims.w), height: String(patch.dims.h), unit: 'CENTIMETER' };
  }
  if (images.length > 0) {
    const uris = [];
    for (const file of images) uris.push({ uri: await uploadTikTokImage(file) });
    body.main_images = uris;
  }
  if (Object.keys(body).length === 0) return { changed: [] };
  await callApi({ config: loadConfig(), method: 'POST', path: `/product/202509/products/${ref.productId}/partial_edit`, body });
  return { changed: Object.keys(body) };
}

async function activeTikTok(ref, active) {
  await callApi({
    config: loadConfig(), method: 'POST',
    path: `/product/202309/products/${active ? 'activate' : 'deactivate'}`,
    body: { product_ids: [String(ref.productId)], listing_platforms: TIKTOK_PLATFORMS },
  });
}

/* ------------------------------------------------------------------------------ Shopee */

async function readShopee(ref) {
  const { config, auth } = await resolveShopeeSession();
  const r = await callShopApi(config, '/api/v2/product/get_item_base_info', auth, { item_id_list: String(ref.itemId), need_tax_info: false, need_complaint_policy: false });
  const item = r.response?.item_list?.[0] ?? {};
  const text = item.description
    ?? (item.description_info?.extended_description?.field_list ?? []).filter((f) => f.field_type === 'text').map((f) => f.text).join('\n\n');
  const d = item.dimension;
  return {
    title: item.item_name ?? '',
    description: String(text ?? '').trim(),
    images: item.image?.image_url_list ?? [],
    weightGram: item.weight ? Math.round(Number(item.weight) * 1000) : null,
    dims: d?.package_length ? { l: d.package_length, w: d.package_width, h: d.package_height } : null,
    status: item.item_status ?? '',
    variants: item.has_model ? null : 1,
  };
}

export async function uploadShopeeImage(file) {
  const { config, auth } = await resolveShopeeSession();
  const form = new FormData();
  form.append('image', new Blob([file.buffer], { type: file.type || 'image/jpeg' }), file.name || 'image.jpg');
  const r = await callShopApi(config, '/api/v2/media_space/upload_image', auth, {}, form);
  const id = r.response?.image_info?.image_id ?? r.response?.image_info_list?.[0]?.image_info?.image_id;
  if (!id) throw new Error('Shopee tidak mengembalikan image_id');
  return id;
}

async function editShopee(ref, patch, images) {
  const body = { item_id: Number(ref.itemId) };
  if (patch.title !== undefined) body.item_name = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.weightGram !== undefined) body.weight = Number(kg(patch.weightGram));
  if (patch.dims !== undefined) body.dimension = { package_length: patch.dims.l, package_width: patch.dims.w, package_height: patch.dims.h };
  if (images.length > 0) {
    const ids = [];
    for (const file of images) ids.push(await uploadShopeeImage(file));
    body.image = { image_id_list: ids };
  }
  if (Object.keys(body).length === 1) return { changed: [] };
  const { config, auth } = await resolveShopeeSession();
  await callShopApi(config, '/api/v2/product/update_item', auth, {}, body);
  return { changed: Object.keys(body).filter((k) => k !== 'item_id') };
}

async function activeShopee(ref, active) {
  const { config, auth } = await resolveShopeeSession();
  const r = await callShopApi(config, '/api/v2/product/unlist_item', auth, {}, { item_list: [{ item_id: Number(ref.itemId), unlist: !active }] });
  const failed = r.response?.failure_list?.[0];
  if (failed) throw new Error(failed.failed_reason || 'Shopee menolak');
}

/* ----------------------------------------------------------------------------- Shopify */

const SHOPIFY_DETAIL = `
query TreelogyListingDetail($id: ID!) {
  product(id: $id) {
    id title descriptionHtml status
    media(first: 20) { nodes { id mediaContentType ... on MediaImage { image { url } } } }
    variants(first: 50) { nodes { id sku inventoryItem { measurement { weight { value unit } } } } }
  }
}`;

const SHOPIFY_UPDATE = `
mutation TreelogyListingUpdate($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
    product { id title status }
    userErrors { field message }
  }
}`;

const SHOPIFY_WEIGHT = `
mutation TreelogyVariantWeight($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

const SHOPIFY_STAGE = `
mutation TreelogyStagedUpload($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

const SHOPIFY_DETACH = `
mutation TreelogyDetachMedia($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) {
    files { id }
    userErrors { field message code }
  }
}`;

const userErrors = (errors) => {
  if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
};

const toGrams = (w) => {
  if (!w?.value) return null;
  const f = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.3495, POUNDS: 453.592 }[w.unit] ?? 1;
  return Math.round(Number(w.value) * f);
};

async function readShopify(ref) {
  const d = await shopifyGraphql(SHOPIFY_DETAIL, { id: ref.productId }, loadShopifyConfig());
  const p = d.product;
  const variant = p?.variants?.nodes?.find((v) => v.id === ref.variantId) ?? p?.variants?.nodes?.[0];
  return {
    title: p?.title ?? '',
    description: htmlToText(p?.descriptionHtml),
    images: (p?.media?.nodes ?? []).map((m) => m.image?.url).filter(Boolean),
    weightGram: toGrams(variant?.inventoryItem?.measurement?.weight),
    dims: null,
    status: p?.status ?? '',
    variants: p?.variants?.nodes?.length ?? 1,
  };
}

/** Shopify takes a file in two steps: a staged target, then a POST of the bytes to it. */
export async function stageShopifyImage(file) {
  const d = await shopifyGraphql(SHOPIFY_STAGE, {
    input: [{ filename: file.name || 'image.jpg', mimeType: file.type || 'image/jpeg', resource: 'IMAGE', httpMethod: 'POST' }],
  }, loadShopifyConfig());
  userErrors(d.stagedUploadsCreate.userErrors);
  const target = d.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([file.buffer], { type: file.type || 'image/jpeg' }), file.name || 'image.jpg');
  const res = await fetch(target.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`unggah gambar Shopify gagal (HTTP ${res.status})`);
  return target.resourceUrl;
}

async function editShopify(ref, patch, images) {
  const config = loadShopifyConfig();
  const changed = [];
  const product = { id: ref.productId };
  if (patch.title !== undefined) { product.title = patch.title; changed.push('title'); }
  if (patch.description !== undefined) { product.descriptionHtml = textToHtml(patch.description); changed.push('description'); }

  let media;
  let oldMedia = [];
  if (images.length > 0) {
    const current = await shopifyGraphql(SHOPIFY_DETAIL, { id: ref.productId }, config);
    oldMedia = (current.product?.media?.nodes ?? []).map((m) => m.id);
    media = [];
    for (const file of images) media.push({ originalSource: await stageShopifyImage(file), mediaContentType: 'IMAGE', alt: patch.title ?? '' });
    changed.push('images');
  }

  if (Object.keys(product).length > 1 || media) {
    const d = await shopifyGraphql(SHOPIFY_UPDATE, { product, media }, config);
    userErrors(d.productUpdate.userErrors);
  }
  // The new pictures replace the old: attached first, the old ones let go after, so a
  // failure halfway leaves too many pictures rather than none.
  if (oldMedia.length > 0) {
    const d = await shopifyGraphql(SHOPIFY_DETACH, { files: oldMedia.map((id) => ({ id, referencesToRemove: [ref.productId] })) }, config);
    userErrors(d.fileUpdate.userErrors);
  }
  if (patch.weightGram !== undefined && ref.variantId) {
    const d = await shopifyGraphql(SHOPIFY_WEIGHT, {
      productId: ref.productId,
      variants: [{ id: ref.variantId, inventoryItem: { measurement: { weight: { value: Number(patch.weightGram), unit: 'GRAMS' } } } }],
    }, config);
    userErrors(d.productVariantsBulkUpdate.userErrors);
    changed.push('weight');
  }
  return { changed };
}

/** A variant's price. Same validated bulk-update mutation the weight goes through. */
export async function setShopifyPrice(ref, price) {
  const d = await shopifyGraphql(SHOPIFY_WEIGHT, {
    productId: ref.productId, variants: [{ id: ref.variantId, price: String(price) }],
  }, loadShopifyConfig());
  userErrors(d.productVariantsBulkUpdate.userErrors);
}

async function activeShopify(ref, active) {
  const d = await shopifyGraphql(SHOPIFY_UPDATE, { product: { id: ref.productId, status: active ? 'ACTIVE' : 'ARCHIVED' } }, loadShopifyConfig());
  userErrors(d.productUpdate.userErrors);
}

/* ---------------------------------------------------------------------------- dispatch */

export const LISTING_CHANNELS = {
  tiktok: { label: 'Tokopedia + TikTok', read: readTikTok, edit: editTikTok, setActive: activeTikTok, dims: true },
  shopee: { label: 'Shopee', read: readShopee, edit: editShopee, setActive: activeShopee, dims: true },
  shopify: { label: 'Shopify', read: readShopify, edit: editShopify, setActive: activeShopify, dims: false },
};

/** A catalogue row as the ref each channel's calls need. */
export function refOf(channel, row) {
  if (!row) return null;
  if (channel === 'tiktok') return row.productId ? { productId: row.productId, skuId: row.skuId } : null;
  if (channel === 'shopee') return row.itemId ? { itemId: row.itemId, modelId: row.modelId } : null;
  return row.productId ? { productId: row.productId, variantId: row.variantId } : null;
}

/**
 * The fields the operator actually changed, compared with what the form was filled from.
 * Only these are sent anywhere.
 */
export function diffPatch(before, after) {
  const patch = {};
  const text = (v) => String(v ?? '').replace(/\r\n/g, '\n').trim();
  if (after.title !== undefined && text(after.title) && text(after.title) !== text(before.title)) patch.title = text(after.title);
  if (after.description !== undefined && text(after.description) && text(after.description) !== text(before.description)) patch.description = text(after.description);
  const g = Number(after.weightGram);
  if (after.weightGram !== '' && after.weightGram !== undefined && Number.isFinite(g) && g > 0 && g !== Number(before.weightGram)) patch.weightGram = Math.round(g);
  const dims = ['l', 'w', 'h'].map((k) => Number(after.dims?.[k]));
  if (dims.every((n) => Number.isInteger(n) && n > 0)) {
    const prev = before.dims ? ['l', 'w', 'h'].map((k) => Number(before.dims[k])) : [];
    if (dims.join() !== prev.join()) patch.dims = { l: dims[0], w: dims[1], h: dims[2] };
  }
  return patch;
}
