import { shopifyGraphql, paginate } from './client.js';
import { loadShopifyConfig } from './config.js';
import { financeFromShopify } from '../omni.js';

/**
 * Products and orders, shaped to match the other channels.
 *
 * Every query here was validated against the Admin GraphQL schema for 2026-07 before
 * being written into the codebase, so field names are not guesses.
 */

export const SHOP_QUERY = `
query TreelogyShop {
  shop { name myshopifyDomain currencyCode }
}`;

export const PRODUCTS_QUERY = `
query TreelogyProducts($cursor: String) {
  products(first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      status
      variants(first: 100) {
        nodes {
          id
          sku
          price
          inventoryQuantity
        }
      }
    }
  }
}`;

/**
 * The buyer's identity comes off the order, not off the customer record.
 *
 * `customer { ... }` needs `read_customers`, which this token does not carry - which is
 * why invoices went into the books named "Shopify" with no email. `email`,
 * `shippingAddress` and `billingAddress` sit on the order itself and need only
 * `read_orders`, and they carry the same name, address and address that the buyer typed.
 * The two-shape fallback below is kept because the query is still built in two variants
 * elsewhere, but nothing in it needs the customer scope any more.
 */
const ordersQuery = ({ withCustomer }) => `
query TreelogyOrders($cursor: String, $query: String) {
  orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      note
      totalWeight
      createdAt
      displayFinancialStatus
      displayFulfillmentStatus
      paymentGatewayNames
      totalPriceSet { shopMoney { amount currencyCode } }
      email
      shippingAddress { name address1 address2 city province zip countryCodeV2 phone }
      billingAddress { name address1 address2 city province zip countryCodeV2 }
      lineItems(first: 50) {
        nodes {
          quantity sku title variantTitle
          originalUnitPriceSet { shopMoney { amount } }
          totalDiscountSet { shopMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } }
        }
      }
      shippingLine { originalPriceSet { shopMoney { amount } } }
      fulfillments(first: 5) {
        trackingInfo { number company }
      }
    }
  }
}`;

export const ORDERS_QUERY = ordersQuery({ withCustomer: true });
export const ORDERS_QUERY_NO_CUSTOMER = ordersQuery({ withCustomer: false });

/** Remembered per process so the fallback is paid for once, not on every page load. */
let customerScope = null;

const missingScope = (error) => /access scope|Access denied/i.test(error.message ?? '');

export async function fetchShop(config = loadShopifyConfig()) {
  const data = await shopifyGraphql(SHOP_QUERY, {}, config);
  return data.shop;
}

/** Only ACTIVE products are sellable, so only they belong in a stock comparison. */
export async function fetchProducts(config = loadShopifyConfig()) {
  const products = await paginate(PRODUCTS_QUERY, {}, (d) => d.products, { config });

  const rows = [];
  for (const product of products) {
    for (const variant of product.variants?.nodes ?? []) {
      if (!variant.sku) continue;
      rows.push({
        sku: variant.sku,
        qty: Number(variant.inventoryQuantity) || 0,
        price: Math.round(Number(variant.price) || 0),
        currency: 'IDR',
        title: product.title ?? '',
        variant: '',
        status: product.status ?? '',
        productId: product.id,
        variantId: variant.id,
      });
    }
  }
  return rows;
}

/**
 * Shopify has two independent statuses - paid and fulfilled - where the marketplaces
 * have one. Collapsing them the same way keeps the omnichannel counts comparable.
 */
/** One address on one line, skipping whatever the buyer left blank. */
export function formatAddress(address) {
  if (!address) return '';
  return [
    address.address1, address.address2, address.city, address.province, address.zip,
    address.countryCodeV2,
  ].map((part) => String(part ?? '').trim()).filter(Boolean).join(', ');
}

export function shopifyStage(order) {
  const paid = order.displayFinancialStatus;
  const shipped = order.displayFulfillmentStatus;

  if (paid === 'REFUNDED' || paid === 'VOIDED') return 'returned';
  if (order.cancelledAt) return 'cancelled';
  if (paid === 'PENDING' || paid === 'AUTHORIZED') return 'unpaid';
  if (shipped === 'FULFILLED') return 'completed';
  if (shipped === 'PARTIALLY_FULFILLED' || shipped === 'IN_PROGRESS') return 'shipping';
  return 'to_ship';
}

const lines = (order) => {
  const bySku = new Map();
  for (const item of order.lineItems?.nodes ?? []) {
    const sku = item.sku || item.title || '(tanpa sku)';
    const qty = Number(item.quantity) || 0;
    const existing = bySku.get(sku);
    if (existing) existing.qty += qty;
    // The variant is what tells 180 capsules from 270 on a packing bench, so it travels
    // with the line rather than being dropped on the way in.
    else bySku.set(sku, { sku, name: item.title ?? '', variant: item.variantTitle ?? '', qty });
  }
  return [...bySku.values()];
};

/** `since` and `until` are epoch seconds, matching the other channels. */
export async function fetchOrders({ since, until, max = 800, config = loadShopifyConfig() } = {}) {
  const range = `created_at:>='${new Date(since * 1000).toISOString()}' AND created_at:<='${new Date(until * 1000).toISOString()}'`;

  let orders;
  if (customerScope === false) {
    orders = await paginate(ORDERS_QUERY_NO_CUSTOMER, { query: range }, (d) => d.orders, { max, config });
  } else {
    try {
      orders = await paginate(ORDERS_QUERY, { query: range }, (d) => d.orders, { max, config });
      customerScope = true;
    } catch (error) {
      if (!missingScope(error)) throw error;
      customerScope = false;
      console.warn('shopify: token tanpa read_customers - nama pembeli dilewati');
      orders = await paginate(ORDERS_QUERY_NO_CUSTOMER, { query: range }, (d) => d.orders, { max, config });
    }
  }

  return orders.map(mapOrder);
}

/** One GraphQL order node in the shape every channel shares. */
export function mapOrder(order) {
  const tracking = order.fulfillments?.[0]?.trackingInfo?.[0] ?? {};
  return {
    channel: 'shopify',
    id: order.name || order.id,
    // The mutation addresses orders by GID; the human-facing name cannot be used.
    gid: order.id,
    createdAt: Math.floor(Date.parse(order.createdAt) / 1000),
    status: `${order.displayFinancialStatus}/${order.displayFulfillmentStatus}`,
    stage: shopifyStage(order),
    total: Math.round(Number(order.totalPriceSet?.shopMoney?.amount) || 0),
    currency: order.totalPriceSet?.shopMoney?.currencyCode ?? 'IDR',
    carrier: tracking.company ?? '',
    tracking: tracking.number ?? '',
    // Only Shopify discloses the buyer in full; the marketplaces mask name, address and
    // phone, and Shopee masks all of it.
    buyer: order.shippingAddress?.name || order.billingAddress?.name || '',
    buyerEmail: order.email ?? '',
    buyerPhone: order.shippingAddress?.phone ?? '',
    shipTo: formatAddress(order.shippingAddress),
    billTo: formatAddress(order.billingAddress),
    // How the buyer paid decides the order-code prefix (Xendit vs Shopify Payments).
    gateways: order.paymentGatewayNames ?? [],
    items: order.lineItems?.nodes?.length ?? 0,
    lines: lines(order),
    // Grams, as Shopify keeps it. The packing label prints it; nothing else reads it.
    weightGram: Number(order.totalWeight) || 0,
    note: order.note ?? '',
    finance: financeFromShopify(order),
  };
}

/** Validated against the live 2026-07 schema via the Shopify Admin skill. */
export const ORDER_BY_GID_QUERY = `
query TreelogyOrderByGid($id: ID!) {
  order(id: $id) {
    id
    name
    createdAt
    cancelledAt
    displayFinancialStatus
    displayFulfillmentStatus
    paymentGatewayNames
    totalPriceSet { shopMoney { amount currencyCode } }
    email
    shippingAddress { name address1 address2 city province zip countryCodeV2 phone }
    billingAddress { name address1 address2 city province zip countryCodeV2 }
    lineItems(first: 50) {
      nodes {
        quantity sku title variantTitle
        originalUnitPriceSet { shopMoney { amount } }
        totalDiscountSet { shopMoney { amount } }
        discountAllocations { allocatedAmountSet { shopMoney { amount } } }
      }
    }
    shippingLine { originalPriceSet { shopMoney { amount } } }
    fulfillments(first: 5) { trackingInfo { number company } }
  }
}`;

const ORDER_BY_GID_QUERY_NO_CUSTOMER = ORDER_BY_GID_QUERY;

/**
 * Read exactly one order.
 *
 * A webhook names a single order, and scanning sixty days of history to find it would
 * cost hundreds of orders' worth of API budget per push. The same `read_customers`
 * fallback applies as for the range read.
 */
export async function fetchOrderByGid(gid, config = loadShopifyConfig()) {
  const run = (query) => shopifyGraphql(query, { id: gid }, config);

  let data;
  if (customerScope === false) {
    data = await run(ORDER_BY_GID_QUERY_NO_CUSTOMER);
  } else {
    try {
      data = await run(ORDER_BY_GID_QUERY);
      customerScope = true;
    } catch (error) {
      if (!missingScope(error)) throw error;
      customerScope = false;
      data = await run(ORDER_BY_GID_QUERY_NO_CUSTOMER);
    }
  }

  return data?.order ? mapOrder(data.order) : null;
}
