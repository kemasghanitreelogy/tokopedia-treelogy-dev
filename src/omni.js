import { loadConfig } from './config.js';
import { searchOrders, getOrderDetail } from './orders.js';
import { refreshAccessToken as refreshTikTokToken, persistTokens, hydrateFromBundle } from './auth.js';
import { accessTokenExpired } from './client.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi, getOrderList } from './shopee/client.js';
import { resolveRange, chunkRange } from './range.js';
import { fetchOrders as fetchShopifyOrders } from './shopify/shop.js';
import { isShopifyConfigured } from './shopify/config.js';

/**
 * One order shape across three sales channels.
 *
 * Tokopedia and TikTok Shop are the same TikTok Shop Open API account - they are told
 * apart by `commerce_platform` on the order detail, not by separate credentials. Shopee
 * is a genuinely separate integration.
 */

export const CHANNELS = {
  tokopedia: { id: 'tokopedia', label: 'Tokopedia', accent: '#42B549' },
  tiktok_shop: { id: 'tiktok_shop', label: 'TikTok Shop', accent: '#FE2C55' },
  shopee: { id: 'shopee', label: 'Shopee', accent: '#EE4D2D' },
  shopify: { id: 'shopify', label: 'Shopify', accent: '#5E8E3E' },
};

/**
 * The two platforms name the same lifecycle differently. Collapsing both into one set of
 * stages is what makes a cross-channel count meaningful.
 */
export const STAGES = ['unpaid', 'to_ship', 'shipping', 'delivered', 'completed', 'cancelled', 'returned'];

const STAGE_BY_STATUS = {
  // TikTok Shop / Tokopedia
  UNPAID: 'unpaid',
  ON_HOLD: 'unpaid',
  AWAITING_SHIPMENT: 'to_ship',
  AWAITING_COLLECTION: 'to_ship',
  PARTIALLY_SHIPPING: 'shipping',
  IN_TRANSIT: 'shipping',
  DELIVERED: 'delivered',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  // Shopee
  INVOICE_PENDING: 'unpaid',
  READY_TO_SHIP: 'to_ship',
  PROCESSED: 'to_ship',
  RETRY_SHIP: 'to_ship',
  SHIPPED: 'shipping',
  TO_CONFIRM_RECEIVE: 'shipping',
  IN_CANCEL: 'cancelled',
  TO_RETURN: 'returned',
  UNRESPONSIVE: 'unpaid',
};

export const stageOf = (status) => STAGE_BY_STATUS[status] ?? 'unpaid';

/** Stages that still need a human to do something. */
export const ACTIONABLE = new Set(['unpaid', 'to_ship']);

/** Bounded-concurrency map: order detail is fetched 50 at a time, several batches at once. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

const batches = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// Detail endpoints are the bulk of a dashboard load and both platforms tolerate this
// comfortably; measured against the live shop, raising it from 4 roughly halves the wait.
const DETAIL_CONCURRENCY = 8;

/**
 * Shopee has no batch tracking endpoint - get_tracking_number is one call per order
 * (~780ms each), so this is deliberately narrow: only orders that are actually moving
 * carry a useful AWB, and the lookup is capped so a wide date range cannot stall the page.
 */
const TRACKING_CONCURRENCY = 16;
const TRACKING_MAX = 300;
const TRACKING_STAGES = new Set(['to_ship', 'shipping']);

async function attachShopeeTracking(config, auth, orders) {
  const wanted = orders.filter((o) => TRACKING_STAGES.has(o.stage)).slice(0, TRACKING_MAX);

  await mapLimit(wanted, TRACKING_CONCURRENCY, async (order) => {
    try {
      const { response } = await callShopApi(config, '/api/v2/logistics/get_tracking_number', auth, {
        order_sn: order.id,
      });
      // An order awaiting pickup answers with an empty string rather than an error.
      order.tracking = response?.tracking_number ?? '';
    } catch {
      // A single unreachable AWB must not cost us the whole channel.
      order.tracking = '';
    }
  });

  return { looked: wanted.length, capped: orders.filter((o) => TRACKING_STAGES.has(o.stage)).length > TRACKING_MAX };
}

/**
 * TikTok repeats a line item per unit and carries no quantity field, while Shopee sends
 * one row with model_quantity_purchased. Counting Shopee rows - or trusting a quantity
 * field on TikTok - undercounts a picklist, so each platform is folded its own way.
 */
function tiktokLines(lineItems = []) {
  const bySku = new Map();
  for (const li of lineItems) {
    const sku = li.seller_sku || li.sku_id || '(tanpa sku)';
    const existing = bySku.get(sku);
    if (existing) existing.qty += 1;
    else bySku.set(sku, { sku, name: li.product_name ?? '', variant: li.sku_name ?? '', qty: 1 });
  }
  return [...bySku.values()];
}

function shopeeLines(itemList = []) {
  const bySku = new Map();
  for (const item of itemList) {
    const sku = item.model_sku || item.item_sku || String(item.item_id ?? '(tanpa sku)');
    const qty = Number(item.model_quantity_purchased) || 0;
    const existing = bySku.get(sku);
    if (existing) existing.qty += qty;
    else bySku.set(sku, { sku, name: item.item_name ?? '', variant: item.model_name ?? '', qty });
  }
  return [...bySku.values()];
}

/**
 * The money an invoice needs, separated the way accounting needs it.
 *
 * The decision recorded for this integration is to book the gross selling price and keep
 * platform costs out of revenue. That makes one distinction load-bearing: a discount the
 * SELLER funds reduces what the seller earns, while a voucher the PLATFORM funds does
 * not - the platform reimburses it. Treating the second as a discount would understate
 * revenue on every subsidised order.
 */
/**
 * One TikTok Shop order detail in the shape every channel shares.
 *
 * Shared by the range read and the by-id read on purpose. They used to map separately and
 * the by-id one carried no `finance`, which meant a webhook could never have posted an
 * invoice - every push would have died on "rincian keuangan tidak tersedia".
 */
export function mapTikTokOrder(o) {
  return {
    channel: o.commerce_platform === 'TIKTOK_SHOP' ? 'tiktok_shop' : 'tokopedia',
    id: o.id,
    createdAt: Number(o.create_time),
    status: o.status,
    stage: stageOf(o.status),
    total: toNumber(o.payment?.total_amount),
    currency: o.payment?.currency ?? 'IDR',
    carrier: o.shipping_provider ?? '',
    tracking: o.tracking_number ?? '',
    buyer: o.recipient_address?.name ?? '',
    // TikTok masks the buyer: the name arrives as "N*** W***astuti", the street as
    // asterisks, the phone partly hidden. Province and city come through intact, and the
    // email is a relay address that really does reach the buyer - so what can be carried
    // is carried, and what is masked stays masked rather than being invented.
    buyerEmail: o.buyer_email ?? '',
    buyerPhone: o.recipient_address?.phone_number ?? '',
    shipTo: o.recipient_address?.full_address ?? '',
    billTo: '',
    items: (o.line_items ?? []).length,
    lines: tiktokLines(o.line_items),
    finance: financeFromTikTok(o),
    // Shipping documents are issued per package, not per order.
    packageId: (o.packages ?? [])[0]?.id ?? '',
  };
}

function financeFromTikTok(order) {
  const lines = (order.line_items ?? []).map((li) => ({
    sku: li.seller_sku || li.sku_id || '',
    name: li.product_name ?? '',
    variant: li.sku_name ?? '',
    qty: 1, // TikTok repeats a line per unit and carries no quantity field.
    unitPrice: toNumber(li.original_price),
    unitDiscount: toNumber(li.seller_discount),
  }));
  return {
    lines: foldLines(lines),
    // Delivery on a marketplace is collected by the platform and paid to the courier;
    // Shopee's settlement proves it nets to zero for the seller (actual_shipping_fee
    // 24,000 against shopee_shipping_rebate 24,000). Booking it as revenue would
    // overstate turnover by the freight, so it is excluded. Verified: goods-only totals
    // match `order_selling_price` exactly on every sampled order.
    shipping: 0,
    shippingPassThrough: toNumber(order.payment?.shipping_fee),
    currency: order.payment?.currency ?? 'IDR',
  };
}

/** One Shopee order detail in the shared shape; see mapTikTokOrder for why it is shared. */
export function mapShopeeOrder(o) {
  return {
    channel: 'shopee',
    id: o.order_sn,
    createdAt: Number(o.create_time),
    status: o.order_status,
    stage: stageOf(o.order_status),
    total: toNumber(o.total_amount),
    currency: o.currency ?? 'IDR',
    carrier: o.shipping_carrier ?? '',
    tracking: '',
    buyer: o.buyer_username ?? '',
    // Shopee masks the whole address - every field comes back as "****" - so there is
    // nothing to carry here beyond the username.
    buyerEmail: '',
    buyerPhone: '',
    shipTo: '',
    billTo: '',
    items: (o.item_list ?? []).length,
    lines: shopeeLines(o.item_list),
    finance: financeFromShopee(o),
    packageNumber: o.package_list?.[0]?.package_number ?? '',
  };
}

function financeFromShopee(order) {
  const lines = (order.item_list ?? []).map((item) => ({
    sku: item.model_sku || item.item_sku || '',
    name: item.item_name ?? '',
    variant: item.model_name ?? '',
    qty: Number(item.model_quantity_purchased) || 0,
    unitPrice: toNumber(item.model_original_price),
    unitDiscount: Math.max(0, toNumber(item.model_original_price) - toNumber(item.model_discounted_price)),
  }));
  return {
    lines: foldLines(lines),
    shipping: 0, // pass-through, as above
    shippingPassThrough: toNumber(order.estimated_shipping_fee),
    currency: order.currency ?? 'IDR',
  };
}

export function financeFromShopify(order) {
  const lines = (order.lineItems?.nodes ?? []).map((li) => {
    const qty = Number(li.quantity) || 0;
    const unit = toNumber(li.originalUnitPriceSet?.shopMoney?.amount);
    // Shopify allocates order-level discounts down to the lines, so the per-line total
    // discount is the honest figure - an order-level number would double-count.
    const discountTotal = toNumber(li.totalDiscountSet?.shopMoney?.amount);
    return {
      sku: li.sku || li.title || '',
      name: li.title ?? '',
      variant: '',
      qty,
      unitPrice: unit,
      unitDiscount: qty > 0 ? Math.round(discountTotal / qty) : 0,
    };
  });
  return {
    // Shopify is the seller's own store: the shipping charge is set by the seller and
    // received by the seller, so unlike the marketplaces it is genuine revenue.
    lines: foldLines(lines),
    shipping: toNumber(order.shippingLine?.originalPriceSet?.shopMoney?.amount),
    currency: order.totalPriceSet?.shopMoney?.currencyCode ?? 'IDR',
  };
}

/** Identical SKUs at the same price become one line with a quantity. */
function foldLines(lines) {
  const bySku = new Map();
  for (const line of lines) {
    if (line.qty <= 0) continue;
    const key = `${line.sku}|${line.unitPrice}|${line.unitDiscount}`;
    const existing = bySku.get(key);
    if (existing) existing.qty += line.qty;
    else bySku.set(key, { ...line });
  }
  return [...bySku.values()];
}

/** What the invoice should total: goods after seller discounts, plus delivery. */
export function financeTotal(finance) {
  const goods = finance.lines.reduce((n, l) => n + (l.unitPrice - l.unitDiscount) * l.qty, 0);
  return goods + finance.shipping;
}

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** TikTok Shop tokens outlive a dashboard request, but refresh anyway when they are due. */
/**
 * The TikTok Shop config the way the deployment must see it: tokens from the shared Blob
 * bundle, refreshed when stale, refresh written straight back. One resolution in flight
 * per process so two callers racing cannot each refresh - the refresh token rotates, and
 * the second refresh would invalidate the first.
 */
let tiktokInflight = null;
let tiktokCached = null;

export function invalidateTikTokConfig() {
  tiktokInflight = null;
  tiktokCached = null;
}

export async function tiktokConfig() {
  if (tiktokCached && !accessTokenExpired(tiktokCached)) return tiktokCached;
  if (!tiktokInflight) {
    tiktokInflight = (async () => {
      const config = await hydrateFromBundle(loadConfig());
      if (config.refreshToken && accessTokenExpired(config)) {
        try {
          await persistTokens(config, await refreshTikTokToken({ config }));
        } catch (error) {
          // TikTok rotates the refresh token on every refresh. Two instances reaching
          // expiry together both try; the second holds a token the first just retired.
          // The first has already written the new pair to Blob, so read it back before
          // deciding anything is wrong.
          const again = await hydrateFromBundle(loadConfig());
          if (!again.accessToken || accessTokenExpired(again)) throw error;
          Object.assign(config, again);
        }
      }
      tiktokCached = config;
      return config;
    })().finally(() => { tiktokInflight = null; });
  }
  return tiktokInflight;
}

/** The window is applied server-side, so every page returned is already in range. */
export async function fetchTikTokOrders({ config, since, until, max }) {
  const summaries = [];
  let pageToken = null;

  do {
    const page = await searchOrders({
      config, pageSize: 100, pageToken, createTimeGe: since, createTimeLt: until,
    });
    summaries.push(...page.orders);
    pageToken = page.nextPageToken;
  } while (pageToken && summaries.length < max);

  const ids = summaries.slice(0, max).map((o) => o.id);
  const pages = await mapLimit(batches(ids, 50), DETAIL_CONCURRENCY, (chunk) =>
    getOrderDetail({ config, ids: chunk }).then((r) => r.orders),
  );
  const detailed = pages.flat();

  const orders = detailed
    .filter((o) => Number(o.create_time) >= since && Number(o.create_time) <= until)
    .map(mapTikTokOrder);

  return { orders, truncated: summaries.length > max };
}

export async function fetchShopeeOrders({ since, until, max, tracking = true }) {
  const { config, auth, shop, refreshed } = await resolveShopeeSession();

  // Shopee caps a single query at 15 days, so a wider window is stitched from chunks.
  const summaries = [];
  for (const chunk of chunkRange(since, until, 15)) {
    let cursor = '';
    do {
      const { response } = await getOrderList(config, auth, {
        from: chunk.from, to: chunk.to, pageSize: 100, cursor,
      });
      summaries.push(...(response.order_list ?? []));
      cursor = response.more ? response.next_cursor : '';
    } while (cursor && summaries.length < max);
    if (summaries.length >= max) break;
  }

  const sns = summaries.slice(0, max).map((o) => o.order_sn);
  const pages = await mapLimit(batches(sns, 50), DETAIL_CONCURRENCY, (chunk) =>
    callShopApi(config, '/api/v2/order/get_order_detail', auth, {
      order_sn_list: chunk.join(','),
      response_optional_fields: 'total_amount,buyer_username,item_list,shipping_carrier,order_status,create_time',
    }).then((r) => r.response.order_list ?? []),
  );
  const detailed = pages.flat();

  const orders = detailed
    .filter((o) => Number(o.create_time) >= since && Number(o.create_time) <= until)
    .map(mapShopeeOrder);

  if (tracking) await attachShopeeTracking(config, auth, orders);

  return { orders, shop, refreshed, truncated: summaries.length > max };
}

/**
 * Every channel is fetched concurrently and failures are isolated: one dead integration
 * degrades the dashboard to the channels that still answer instead of blanking it.
 */
export async function collectOrders({ range, maxPerPlatform = 800, tracking = true, ...rest } = {}) {
  const window = range ?? resolveRange(rest);
  const { since, until } = window;

  // Shopify is optional: a shop that has not configured it should see three channels,
  // not an error banner on every page.
  const [tiktok, shopee, shopify] = await Promise.allSettled([
    tiktokConfig().then((config) => fetchTikTokOrders({ config, since, until, max: maxPerPlatform })),
    fetchShopeeOrders({ since, until, max: maxPerPlatform, tracking }),
    isShopifyConfigured() ? fetchShopifyOrders({ since, until, max: maxPerPlatform }) : Promise.resolve([]),
  ]);

  const orders = [];
  const errors = {};
  const truncated = [];
  let shopeeShop = null;

  if (tiktok.status === 'fulfilled') {
    orders.push(...tiktok.value.orders);
    if (tiktok.value.truncated) truncated.push('Tokopedia + TikTok Shop');
  } else {
    errors.tiktok = tiktok.reason.message;
  }

  if (shopee.status === 'fulfilled') {
    orders.push(...shopee.value.orders);
    shopeeShop = shopee.value.shop;
    if (shopee.value.truncated) truncated.push('Shopee');
  } else {
    errors.shopee = shopee.reason.message;
  }

  if (shopify.status === 'fulfilled') orders.push(...shopify.value);
  else errors.shopify = shopify.reason.message;

  orders.sort((a, b) => b.createdAt - a.createdAt);
  return { orders, errors, truncated, maxPerPlatform, range: window, shopeeShop, generatedAt: Date.now() };
}

/**
 * Fetch just the orders named, without walking a date range.
 *
 * Printing labels needs a handful of orders by id; collecting a whole window to find
 * them costs tens of seconds and grows with the shop. Both platforms accept a list of
 * ids directly, so this stays flat regardless of how busy the shop is.
 */
export async function fetchOrdersByIds(selection) {
  const tiktokIds = selection
    .filter((s) => s.channel !== 'shopee' && s.channel !== 'shopify')
    .map((s) => s.id);
  const shopeeIds = selection.filter((s) => s.channel === 'shopee').map((s) => s.id);
  const shopifyIds = selection.filter((s) => s.channel === 'shopify').map((s) => s.id);

  const [tiktok, shopee, shopify] = await Promise.allSettled([
    (async () => {
      if (tiktokIds.length === 0) return [];
      const config = await tiktokConfig();
      const pages = await mapLimit(batches(tiktokIds, 50), DETAIL_CONCURRENCY, (chunk) =>
        getOrderDetail({ config, ids: chunk }).then((r) => r.orders),
      );
      return pages.flat().map(mapTikTokOrder);
    })(),
    (async () => {
      if (shopeeIds.length === 0) return [];
      const { config, auth } = await resolveShopeeSession();
      const pages = await mapLimit(batches(shopeeIds, 50), DETAIL_CONCURRENCY, (chunk) =>
        callShopApi(config, '/api/v2/order/get_order_detail', auth, {
          order_sn_list: chunk.join(','),
          // item_list and total_amount are what the invoice is built from; asking for
          // less here is what made a by-id read unable to produce one.
          response_optional_fields:
            'order_status,shipping_carrier,buyer_username,create_time,package_list,item_list,total_amount',
        }).then((r) => r.response.order_list ?? []),
      );
      return pages.flat().map(mapShopeeOrder);
    })(),
    (async () => {
      if (shopifyIds.length === 0 || !isShopifyConfigured()) return [];
      // Shopify has no by-id batch read here, so the window is searched and filtered -
      // an order being fulfilled is by definition recent.
      const now = Math.floor(Date.now() / 1000);
      const recent = await fetchShopifyOrders({ since: now - 60 * 86400, until: now, max: 800 });
      return recent.filter((o) => shopifyIds.includes(o.id));
    })(),
  ]);

  const orders = [];
  const errors = {};
  if (tiktok.status === 'fulfilled') orders.push(...tiktok.value);
  else errors.tiktok = tiktok.reason.message;
  if (shopee.status === 'fulfilled') orders.push(...shopee.value);
  else errors.shopee = shopee.reason.message;
  if (shopify.status === 'fulfilled') orders.push(...shopify.value);
  else errors.shopify = shopify.reason.message;

  return { orders, errors };
}

/** Totals the dashboard needs, computed once so the view stays dumb. */
export function summarize(orders) {
  const blank = () => ({ count: 0, revenue: 0, actionable: 0, stages: Object.fromEntries(STAGES.map((s) => [s, 0])) });
  const all = blank();
  const byChannel = Object.fromEntries(Object.keys(CHANNELS).map((id) => [id, blank()]));

  for (const order of orders) {
    for (const bucket of [all, byChannel[order.channel]]) {
      if (!bucket) continue;
      bucket.count += 1;
      bucket.stages[order.stage] += 1;
      if (ACTIONABLE.has(order.stage)) bucket.actionable += 1;
      // Cancelled money was never earned; counting it would overstate every channel.
      if (order.stage !== 'cancelled' && order.stage !== 'returned') bucket.revenue += order.total;
    }
  }

  return { all, byChannel };
}
