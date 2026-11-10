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
      currentTotalPriceSet { shopMoney { amount } }
      totalRefundedSet { shopMoney { amount } }
      refunds(first: 10) { totalRefundedSet { shopMoney { amount } } refundLineItems(first: 50) { nodes { quantity restockType lineItem { id } } } }
      email
      shippingAddress { name address1 address2 city province zip countryCodeV2 phone }
      billingAddress { name address1 address2 city province zip countryCodeV2 }
      lineItems(first: 50) {
        nodes {
          id quantity currentQuantity sku title variantTitle
          originalUnitPriceSet { shopMoney { amount } }
          totalDiscountSet { shopMoney { amount } }
          discountAllocations { allocatedAmountSet { shopMoney { amount } } discountApplication { index } }
        }
      }
      discountApplications(first: 10) {
        nodes {
          index targetType
          value { ... on MoneyV2 { amount } ... on PricingPercentageValue { percentage } }
          ... on DiscountCodeApplication { code }
          ... on ManualDiscountApplication { title }
          ... on AutomaticDiscountApplication { title }
          ... on ScriptDiscountApplication { title }
        }
      }
      shippingLine {
        originalPriceSet { shopMoney { amount } }
        discountAllocations { allocatedAmountSet { shopMoney { amount } } discountApplication { index } }
      }
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
    // A line removed in the order editor stays in the list at zero; nobody packs it.
    if (qty <= 0) continue;
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

/**
 * The order as it stands after any edit, with refunds left exactly as they were.
 *
 * `LineItem.quantity` is what the buyer put in the cart at checkout and it never moves.
 * An order edited in the admin keeps the removed lines in `lineItems` with that original
 * quantity, and only `currentQuantity` says they are gone. Reading `quantity` alone,
 * #13131 - edited from an Inside Out bundle to 270 capsules plus a free oil - showed all
 * five lines and a total of Rp2.190.000 on the dashboard, sent the warehouse a bundle
 * that was no longer sold, and went into Jurnal as the bundle at Rp1.045.000.
 *
 * `currentQuantity` also takes out refunded units, and refunds already have their own
 * handling here (a refunded order is voided in the books, not shrunk). So only the
 * edited-away units come off: kept = currentQuantity + units refunded as returns, never
 * above the original. Discounts Shopify allocated to removed units go with them, and the
 * total moves only when something was actually removed, so an untouched order reads
 * exactly as it always has.
 *
 * An edit is itself recorded as a refund: removing the bundle from #13131 created a
 * Rp0 refund whose refundLineItems carry restockType CANCEL. Those are units that never
 * leave the shelf - removed, or cancelled before fulfilment - and they come off the
 * order. Only RETURN / NO_RESTOCK / LEGACY_RESTOCK lines are a refund of goods sold, and
 * only refunds with no CANCEL line add their money back onto the total.
 *
 * A node without `currentQuantity` (a test fixture, an old stored payload) is returned
 * unchanged.
 */
export function withoutRemoved(order) {
  const nodes = order?.lineItems?.nodes;
  if (!Array.isArray(nodes) || !nodes.some((li) => li.currentQuantity !== undefined && li.currentQuantity !== null)) return order;

  const refunded = new Map();
  let refundedMoney = 0;
  for (const refund of order.refunds ?? []) {
    const rows = refund.refundLineItems?.nodes ?? [];
    const cancels = rows.some((row) => row.restockType === 'CANCEL');
    if (!cancels) refundedMoney += Number(refund.totalRefundedSet?.shopMoney?.amount) || 0;
    for (const row of rows) {
      if (row.restockType === 'CANCEL') continue;
      const id = row.lineItem?.id;
      if (id) refunded.set(id, (refunded.get(id) ?? 0) + (Number(row.quantity) || 0));
    }
  }

  let removedAny = false;
  const kept = nodes.map((li) => {
    const original = Number(li.quantity) || 0;
    if (li.currentQuantity === undefined || li.currentQuantity === null) return li;
    const qty = Math.min(original, (Number(li.currentQuantity) || 0) + (refunded.get(li.id) ?? 0));
    if (qty >= original) return li;
    removedAny = true;
    const share = original > 0 ? qty / original : 0;
    const scale = (set) => (set?.shopMoney ? { ...set, shopMoney: { ...set.shopMoney, amount: String(Math.round(Number(set.shopMoney.amount || 0) * share)) } } : set);
    return {
      ...li,
      quantity: qty,
      totalDiscountSet: scale(li.totalDiscountSet),
      discountAllocations: (li.discountAllocations ?? []).map((a) => ({ ...a, allocatedAmountSet: scale(a.allocatedAmountSet) })),
    };
  });
  if (!removedAny) return order;
  // Nothing left at all is a cancelled or wholly refunded order, not an edit: it keeps
  // showing what was bought, and its stage already takes it out of the books.
  if (kept.every((li) => (Number(li.quantity) || 0) <= 0)) return order;

  const amount = (set) => Number(set?.shopMoney?.amount) || 0;
  const total = Math.min(amount(order.totalPriceSet), amount(order.currentTotalPriceSet) + refundedMoney);
  return {
    ...order,
    lineItems: { ...order.lineItems, nodes: kept },
    totalPriceSet: { ...order.totalPriceSet, shopMoney: { ...order.totalPriceSet?.shopMoney, amount: String(total) } },
  };
}

/** One GraphQL order node in the shape every channel shares. */
export function mapOrder(raw) {
  const order = withoutRemoved(raw);
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
    items: (order.lineItems?.nodes ?? []).filter((li) => (Number(li.quantity) || 0) > 0).length,
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
    currentTotalPriceSet { shopMoney { amount } }
    totalRefundedSet { shopMoney { amount } }
    refunds(first: 10) { totalRefundedSet { shopMoney { amount } } refundLineItems(first: 50) { nodes { quantity restockType lineItem { id } } } }
    email
    shippingAddress { name address1 address2 city province zip countryCodeV2 phone }
    billingAddress { name address1 address2 city province zip countryCodeV2 }
    lineItems(first: 50) {
      nodes {
        id quantity currentQuantity sku title variantTitle
        originalUnitPriceSet { shopMoney { amount } }
        totalDiscountSet { shopMoney { amount } }
        discountAllocations { allocatedAmountSet { shopMoney { amount } } discountApplication { index } }
      }
    }
    discountApplications(first: 10) {
      nodes {
        index targetType
        value { ... on MoneyV2 { amount } ... on PricingPercentageValue { percentage } }
        ... on DiscountCodeApplication { code }
        ... on ManualDiscountApplication { title }
        ... on AutomaticDiscountApplication { title }
        ... on ScriptDiscountApplication { title }
      }
    }
    shippingLine {
      originalPriceSet { shopMoney { amount } }
      discountAllocations { allocatedAmountSet { shopMoney { amount } } discountApplication { index } }
    }
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
