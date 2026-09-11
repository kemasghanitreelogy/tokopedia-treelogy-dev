import { loadConfig } from './config.js';
import { callApi } from './client.js';
import { resolveShopeeSession } from './shopee/session.js';
import { fetchProducts as fetchShopifyProducts } from './shopify/shop.js';
import { isShopifyConfigured } from './shopify/config.js';
import { findProduct } from './master.js';
import { callShopApi, getItemList } from './shopee/client.js';

/**
 * The stock each channel currently believes it has, keyed by seller SKU.
 *
 * Tokopedia and TikTok Shop share one catalogue (a single TikTok Shop account), so there
 * are two catalogues here, not three. The join key is the seller-assigned SKU: TikTok
 * calls it `seller_sku`, Shopee calls it `model_sku` on a variant and `item_sku` on a
 * simple item. Verified against the live shop - the values already line up.
 */

const PRODUCT_SEARCH_PATH = '/product/202312/products/search';

/**
 * Only live listings may be written to.
 *
 * The shop has old TikTok products in DELETED / SELLER_DEACTIVATED that still carry the
 * same seller_sku as the live one - three of them. Merging without checking status let a
 * dead listing win and reported the wrong stock; writing to one would be a no-op at best.
 * Shopee's get_item_list already defaults to NORMAL, but the set is spelled out here so
 * the rule lives in one place.
 */
export const WRITABLE_STATUS = {
  tiktok: new Set(['ACTIVATE']),
  shopee: new Set(['NORMAL']),
  shopify: new Set(['ACTIVE']),
};

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

/** TikTok keeps quantity per warehouse; a seller with one warehouse still gets an array. */
const totalQuantity = (inventory = []) => inventory.reduce((n, i) => n + (Number(i.quantity) || 0), 0);

export async function readTikTokCatalog(config = loadConfig()) {
  const found = [];
  let pageToken = null;

  do {
    const query = { page_size: '100' };
    if (pageToken) query.page_token = pageToken;
    const { data } = await callApi({ config, method: 'POST', path: PRODUCT_SEARCH_PATH, query, body: {} });
    found.push(...(data.products ?? []));
    pageToken = data.next_page_token || null;
  } while (pageToken);

  // The search response carries tax_exclusive_price but not sale_price, which is the
  // number a buyer actually sees and the one a price edit has to move. Only the detail
  // endpoint returns it, so live products are fetched individually.
  const live = found.filter((p) => WRITABLE_STATUS.tiktok.has(p.status));
  const details = await mapLimit(live, 4, (product) =>
    callApi({ config, method: 'GET', path: `/product/202309/products/${product.id}` })
      .then((r) => [product.id, r.data])
      .catch(() => [product.id, null]),
  );
  const detailById = new Map(details);

  const rows = [];
  for (const product of found) {
    const detail = detailById.get(product.id);
    const priceBySkuId = new Map(
      (detail?.skus ?? []).map((s) => [s.id, Number(s.price?.sale_price ?? 0)]),
    );

    for (const sku of product.skus ?? []) {
      if (!sku.seller_sku) continue;
      rows.push({
        sku: sku.seller_sku,
        qty: totalQuantity(sku.inventory),
        price: priceBySkuId.get(sku.id) ?? Number(sku.price?.tax_exclusive_price ?? 0),
        currency: sku.price?.currency ?? 'IDR',
        title: product.title ?? '',
        variant: sku.sales_attributes?.map((a) => a.value_name).join(' / ') ?? '',
        status: product.status ?? '',
        productId: product.id,
        skuId: sku.id,
        warehouseId: sku.inventory?.[0]?.warehouse_id ?? '',
      });
    }
  }

  return rows;
}

export async function readShopeeCatalog() {
  const { config, auth } = await resolveShopeeSession();

  const ids = [];
  let offset = 0;
  let more = true;
  while (more) {
    const { response } = await getItemList(config, auth, { offset, pageSize: 100 });
    ids.push(...(response.item ?? []).map((i) => i.item_id));
    more = Boolean(response.has_next_page);
    offset = response.next_offset;
  }

  const batches = [];
  for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
  const infoPages = await mapLimit(batches, 2, (batch) =>
    callShopApi(config, '/api/v2/product/get_item_base_info', auth, { item_id_list: batch.join(',') })
      .then((r) => r.response.item_list ?? []),
  );
  const items = infoPages.flat();

  const rows = [];
  const withModels = items.filter((i) => i.has_model);

  const modelPages = await mapLimit(withModels, 2, (item) =>
    callShopApi(config, '/api/v2/product/get_model_list', auth, { item_id: item.item_id })
      .then((r) => ({ item, models: r.response.model ?? [] })),
  );

  for (const { item, models } of modelPages) {
    for (const model of models) {
      if (!model.model_sku) continue;
      rows.push({
        sku: model.model_sku,
        qty: Number(model.stock_info_v2?.summary_info?.total_available_stock ?? 0),
        reserved: Number(model.stock_info_v2?.summary_info?.total_reserved_stock ?? 0),
        // Shopee reports price in the shop currency already; original_price is the
        // list price, current_price reflects any running promotion we must not clobber.
        price: Number(model.price_info?.[0]?.original_price ?? 0),
        promoPrice: Number(model.price_info?.[0]?.current_price ?? 0),
        hasPromotion: Boolean(model.has_promotion),
        currency: model.price_info?.[0]?.currency ?? 'IDR',
        title: item.item_name ?? '',
        variant: model.model_name ?? '',
        status: item.item_status ?? '',
        itemId: item.item_id,
        modelId: model.model_id,
      });
    }
  }

  for (const item of items.filter((i) => !i.has_model)) {
    if (!item.item_sku) continue;
    rows.push({
      sku: item.item_sku,
      qty: Number(item.stock_info_v2?.summary_info?.total_available_stock ?? 0),
      reserved: Number(item.stock_info_v2?.summary_info?.total_reserved_stock ?? 0),
      price: Number(item.price_info?.[0]?.original_price ?? 0),
      promoPrice: Number(item.price_info?.[0]?.current_price ?? 0),
      hasPromotion: Boolean(item.has_promotion),
      currency: item.price_info?.[0]?.currency ?? 'IDR',
      title: item.item_name ?? '',
      variant: '',
      status: item.item_status ?? '',
      itemId: item.item_id,
      modelId: 0,
    });
  }

  return rows;
}

/** Both catalogues merged on SKU. A failing channel is reported, never silently dropped. */
/**
 * Merge per-channel listing rows into one entry per product.
 *
 * Extracted so the rules that matter can be tested without three live APIs: dead
 * listings are ignored, channel-specific SKUs fold onto their master product, and two
 * live listings disagreeing takes the lower number rather than a coin flip.
 */
export function mergeCatalog({ tiktok = [], shopee = [], shopify = [], errors = {} } = {}) {
  const bySku = new Map();
  const canonical = (sku) => findProduct(sku)?.sku ?? sku;

  const put = (channel, rows) => {
    for (const row of rows) {
      const key = canonical(row.sku);
      const entry = bySku.get(key)
        ?? { sku: key, title: '', tiktok: null, shopee: null, shopify: null };
      const writable = WRITABLE_STATUS[channel].has(row.status);
      const bucket = entry[channel] ?? { qty: null, rows: [], ignored: [], conflict: false };

      if (writable) bucket.rows.push(row);
      else bucket.ignored.push(row);

      entry[channel] = bucket;
      if (writable && (!entry.title || !row.title)) entry.title = entry.title || row.title;
      if (!entry.title && row.title) entry.title = row.title;
      bySku.set(key, entry);
    }
  };

  put('tiktok', tiktok);
  put('shopee', shopee);
  put('shopify', shopify);

  for (const entry of bySku.values()) {
    for (const channel of ['tiktok', 'shopee', 'shopify']) {
      const bucket = entry[channel];
      if (!bucket) continue;
      if (bucket.rows.length === 0) {
        entry[channel] = null;
        entry[`${channel}_ignored`] = bucket.ignored;
        continue;
      }
      const quantities = bucket.rows.map((r) => r.qty);
      bucket.conflict = new Set(quantities).size > 1;
      bucket.qty = Math.min(...quantities);
      bucket.price = bucket.rows[0].price ?? 0;
      bucket.hasPromotion = bucket.rows.some((r) => r.hasPromotion);
    }
  }

  return { skus: [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku)), errors, readAt: Date.now() };
}

export async function readCatalog() {
  const [tiktok, shopee, shopify] = await Promise.allSettled([
    readTikTokCatalog(),
    readShopeeCatalog(),
    isShopifyConfigured() ? fetchShopifyProducts() : Promise.resolve([]),
  ]);

  const errors = {};
  const rows = { tiktok: [], shopee: [], shopify: [] };

  if (tiktok.status === 'fulfilled') rows.tiktok = tiktok.value;
  else errors.tiktok = tiktok.reason.message;

  if (shopee.status === 'fulfilled') rows.shopee = shopee.value;
  else errors.shopee = shopee.reason.message;

  if (shopify.status === 'fulfilled') rows.shopify = shopify.value;
  else errors.shopify = shopify.reason.message;

  return mergeCatalog({ ...rows, errors });
}
