import { callApi } from './client.js';
import { loadConfig } from './config.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi } from './shopee/client.js';
import { shopifyGraphql } from './shopify/client.js';
import { loadShopifyConfig } from './shopify/config.js';
import { textToHtml, uploadTikTokImage, uploadShopeeImage, stageShopifyImage } from './listing.js';

/**
 * A new listing, created on the channels ticked.
 *
 * What a marketplace demands of a new listing is mostly not about the product: a leaf
 * category, that category's mandatory attributes, a brand, logistics, and on TikTok the
 * BPOM certificate a supplement needs before it clears audit. A Treelogy product is a
 * moringa product like the others, so all of that is copied from a listing the operator
 * picks ("like the 90 capsules") and only the product's own facts come from the form.
 *
 * Checked against the published schemas: TikTok CreateProduct 202309 (the only version),
 * Shopee v2.product.add_item, Shopify productSet through the Admin validator.
 *
 * `draft` keeps the new listing away from buyers - TikTok AS_DRAFT, Shopee UNLIST,
 * Shopify DRAFT - which is how this was tested against the live shops.
 */

const kg = (grams) => (Number(grams) / 1000).toFixed(3).replace(/\.?0+$/, '');

/* ------------------------------------------------------------------ TikTok / Tokopedia */

async function tiktokTemplate(productId) {
  const { data } = await callApi({ config: loadConfig(), path: `/product/202309/products/${productId}` });
  const leaf = (data.category_chains ?? []).find((c) => c.is_leaf) ?? (data.category_chains ?? []).at(-1);
  if (!leaf?.id) throw new Error('kategori listing contoh tidak terbaca');
  const warehouse = data.skus?.[0]?.inventory?.[0]?.warehouse_id;
  if (!warehouse) throw new Error('gudang listing contoh tidak terbaca');
  return {
    category_id: leaf.id,
    brand_id: data.brand?.id,
    product_attributes: (data.product_attributes ?? []).map((a) => ({
      id: a.id,
      values: (a.values ?? []).map((v) => (v.id ? { id: v.id } : { name: v.name })),
    })),
    certifications: (data.certifications ?? []).map((c) => ({
      id: c.id,
      ...(c.images?.length ? { images: c.images.map((i) => ({ uri: i.uri })) } : {}),
      ...(c.files?.length ? { files: c.files.map((f) => ({ id: f.id, name: f.name, format: f.format })) } : {}),
      ...(c.expiration_date ? { expiration_date: c.expiration_date } : {}),
    })),
    is_cod_allowed: data.is_cod_allowed,
    warehouse,
  };
}

export async function createTikTok(input, images, { templateId, draft = false }) {
  const t = await tiktokTemplate(templateId);
  const main = [];
  for (const file of images) main.push({ uri: await uploadTikTokImage(file) });
  const body = {
    title: input.title,
    description: textToHtml(input.description),
    category_id: t.category_id,
    // The shop is all-region, and TikTok refuses a create without V2 categories for one;
    // the example listing's category already is one.
    category_version: 'v2',
    ...(t.brand_id ? { brand_id: t.brand_id } : {}),
    main_images: main,
    package_weight: { value: kg(input.weightGram), unit: 'KILOGRAM' },
    package_dimensions: { length: String(input.dims.l), width: String(input.dims.w), height: String(input.dims.h), unit: 'CENTIMETER' },
    product_attributes: t.product_attributes,
    ...(t.certifications.length ? { certifications: t.certifications } : {}),
    ...(typeof t.is_cod_allowed === 'boolean' ? { is_cod_allowed: t.is_cod_allowed } : {}),
    listing_platforms: ['TOKOPEDIA', 'TIKTOK_SHOP'],
    skus: [{
      seller_sku: input.sku,
      price: { amount: String(input.price), currency: 'IDR' },
      inventory: [{ warehouse_id: t.warehouse, quantity: input.stock }],
    }],
    ...(draft ? { save_mode: 'AS_DRAFT' } : {}),
  };
  const { data } = await callApi({ config: loadConfig(), method: 'POST', path: '/product/202309/products', body });
  return {
    id: data.product_id, skuId: data.skus?.[0]?.id ?? null,
    warnings: (data.warnings ?? []).map((w) => w.message).filter(Boolean),
  };
}

/** Test cleanup only: the dashboard switches listings off, it never deletes them. */
export async function deleteTikTok(productId) {
  await callApi({ config: loadConfig(), method: 'DELETE', path: '/product/202309/products', body: { product_ids: [String(productId)] } });
}

/* ------------------------------------------------------------------------------ Shopee */

async function shopeeTemplate(itemId) {
  const { config, auth } = await resolveShopeeSession();
  const r = await callShopApi(config, '/api/v2/product/get_item_base_info', auth, { item_id_list: String(itemId), need_tax_info: false, need_complaint_policy: false });
  const item = r.response?.item_list?.[0];
  if (!item?.category_id) throw new Error('listing contoh Shopee tidak terbaca');
  const logistics = (item.logistic_info ?? []).filter((l) => l.enabled).map((l) => ({
    logistic_id: l.logistic_id, enabled: true,
    ...(l.is_free !== undefined ? { is_free: l.is_free } : {}),
    ...(l.size_id ? { size_id: l.size_id } : {}),
    ...(l.shipping_fee ? { shipping_fee: l.shipping_fee } : {}),
  }));
  if (logistics.length === 0) throw new Error('listing contoh Shopee tidak punya jasa kirim aktif');
  return {
    category_id: item.category_id,
    attribute_list: (item.attribute_list ?? []).map((a) => ({
      attribute_id: a.attribute_id,
      attribute_value_list: (a.attribute_value_list ?? []).map((v) => ({
        value_id: v.value_id ?? 0,
        ...(v.original_value_name ? { original_value_name: v.original_value_name } : {}),
        ...(v.value_unit ? { value_unit: v.value_unit } : {}),
      })),
    })),
    brand: item.brand?.brand_id !== undefined ? { brand_id: item.brand.brand_id, original_brand_name: item.brand.original_brand_name ?? 'No Brand' } : undefined,
    logistic_info: logistics,
    condition: item.condition || 'NEW',
    item_dangerous: item.item_dangerous,
  };
}

export async function createShopee(input, images, { templateId, draft = false }) {
  const t = await shopeeTemplate(templateId);
  const ids = [];
  for (const file of images) ids.push(await uploadShopeeImage(file));
  const body = {
    item_name: input.title,
    description: input.description,
    original_price: Number(input.price),
    weight: Number(kg(input.weightGram)),
    dimension: { package_length: input.dims.l, package_width: input.dims.w, package_height: input.dims.h },
    image: { image_id_list: ids },
    category_id: t.category_id,
    attribute_list: t.attribute_list,
    ...(t.brand ? { brand: t.brand } : {}),
    logistic_info: t.logistic_info,
    condition: t.condition,
    ...(t.item_dangerous !== undefined ? { item_dangerous: t.item_dangerous } : {}),
    item_sku: input.sku,
    seller_stock: [{ stock: input.stock }],
    item_status: draft ? 'UNLIST' : 'NORMAL',
  };
  const { config, auth } = await resolveShopeeSession();
  const r = await callShopApi(config, '/api/v2/product/add_item', auth, {}, body);
  const id = r.response?.item_id;
  if (!id) throw new Error('Shopee tidak mengembalikan item_id');
  return { id, warnings: r.warning ? [r.warning] : [] };
}

/** Test cleanup only. */
export async function deleteShopee(itemId) {
  const { config, auth } = await resolveShopeeSession();
  await callShopApi(config, '/api/v2/product/delete_item', auth, {}, { item_id: Number(itemId) });
}

/* ----------------------------------------------------------------------------- Shopify */

const LOCATIONS = `query TreelogyLocations { locations(first: 5) { nodes { id name isActive } } }`;
const PRODUCT_SET = `
mutation TreelogyProductSet($input: ProductSetInput!, $synchronous: Boolean!) {
  productSet(input: $input, synchronous: $synchronous) {
    product { id title status variants(first: 5) { nodes { id sku inventoryItem { id } } } }
    userErrors { field message code }
  }
}`;
const PRODUCT_DELETE = `mutation TreelogyProductDelete($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { field message } } }`;

export async function createShopify(input, images, { draft = false } = {}) {
  const config = loadShopifyConfig();
  const loc = await shopifyGraphql(LOCATIONS, {}, config);
  const active = (loc.locations?.nodes ?? []).filter((l) => l.isActive);
  // One stocked location, the same rule the stock writer keeps: guessing between two
  // would put the opening stock on a shelf nobody chose.
  if (active.length !== 1) throw new Error(`Shopify punya ${active.length} lokasi aktif - tidak menebak lokasi mana`);
  const files = [];
  for (const file of images) files.push({ originalSource: await stageShopifyImage(file), contentType: 'IMAGE', alt: input.title });
  const d = await shopifyGraphql(PRODUCT_SET, {
    synchronous: true,
    input: {
      title: input.title,
      descriptionHtml: textToHtml(input.description),
      status: draft ? 'DRAFT' : 'ACTIVE',
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      files,
      variants: [{
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
        price: Number(input.price),
        inventoryItem: { sku: input.sku, tracked: true, measurement: { weight: { value: Number(input.weightGram), unit: 'GRAMS' } } },
        inventoryQuantities: [{ locationId: active[0].id, name: 'available', quantity: input.stock }],
      }],
    },
  }, config);
  const errors = d.productSet?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
  const product = d.productSet.product;
  return { id: product.id, variantId: product.variants?.nodes?.[0]?.id ?? null, warnings: [] };
}

/** Test cleanup only. */
export async function deleteShopify(productId) {
  const d = await shopifyGraphql(PRODUCT_DELETE, { input: { id: productId } }, loadShopifyConfig());
  const errors = d.productDelete?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
}

export const CREATORS = { tiktok: createTikTok, shopee: createShopee, shopify: createShopify };
