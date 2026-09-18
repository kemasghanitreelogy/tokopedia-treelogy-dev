import test from 'node:test';
import assert from 'node:assert/strict';
import { shopifyStage, PRODUCTS_QUERY, ORDERS_QUERY, SHOP_QUERY } from '../src/shopify/shop.js';
import { loadShopifyConfig } from '../src/shopify/config.js';
import { STAGES, financeFromShopify } from '../src/omni.js';
import { labelReadiness } from '../src/labels.js';

const order = (financial, fulfillment, extra = {}) => ({
  displayFinancialStatus: financial, displayFulfillmentStatus: fulfillment, ...extra,
});

test('Shopify two-axis status collapses onto the shared lifecycle', () => {
  // Shopify tracks paid and fulfilled separately where the marketplaces have one status;
  // folding them the same way is what makes a cross-channel count meaningful.
  assert.equal(shopifyStage(order('PENDING', 'UNFULFILLED')), 'unpaid');
  assert.equal(shopifyStage(order('AUTHORIZED', 'UNFULFILLED')), 'unpaid');
  assert.equal(shopifyStage(order('PAID', 'UNFULFILLED')), 'to_ship');
  assert.equal(shopifyStage(order('PAID', 'PARTIALLY_FULFILLED')), 'shipping');
  assert.equal(shopifyStage(order('PAID', 'IN_PROGRESS')), 'shipping');
  assert.equal(shopifyStage(order('PAID', 'FULFILLED')), 'completed');
  assert.equal(shopifyStage(order('REFUNDED', 'FULFILLED')), 'returned');
  assert.equal(shopifyStage(order('VOIDED', 'UNFULFILLED')), 'returned');
});

test('a cancelled order is cancelled regardless of fulfillment', () => {
  assert.equal(shopifyStage(order('PAID', 'UNFULFILLED', { cancelledAt: '2026-09-09T00:00:00Z' })), 'cancelled');
});

test('every Shopify stage is one the dashboard already knows', () => {
  for (const [f, s] of [['PAID', 'FULFILLED'], ['PENDING', 'UNFULFILLED'], ['REFUNDED', 'FULFILLED']]) {
    assert.ok(STAGES.includes(shopifyStage(order(f, s))));
  }
});

test('the shop domain is accepted in any of the forms a human would paste', () => {
  // STORE_NAME is a legitimate fallback source, so it has to be cleared too or the
  // "no domain configured" case cannot be observed at all.
  const saved = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_SHOP', 'STORE_NAME'].map((k) => [k, process.env[k]]);
  const restore = () => saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });

  try {
    for (const key of ['SHOPIFY_SHOP', 'STORE_NAME']) process.env[key] = '';
    for (const input of ['treelogy', 'treelogy.myshopify.com', 'https://treelogy.myshopify.com/admin']) {
      process.env.SHOPIFY_SHOP_DOMAIN = input;
      assert.equal(loadShopifyConfig().domain, 'treelogy.myshopify.com', `failed for ${input}`);
    }
    process.env.SHOPIFY_SHOP_DOMAIN = '';
    assert.equal(loadShopifyConfig().domain, '', 'an empty setting must not become ".myshopify.com"');
  } finally {
    restore();
  }
});

test('STORE_NAME stands in when no dedicated domain variable is set', () => {
  const saved = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_SHOP', 'STORE_NAME'].map((k) => [k, process.env[k]]);
  try {
    process.env.SHOPIFY_SHOP_DOMAIN = '';
    process.env.SHOPIFY_SHOP = '';
    process.env.STORE_NAME = 'treelogymoringa.myshopify.com';
    assert.equal(loadShopifyConfig().domain, 'treelogymoringa.myshopify.com');
  } finally {
    saved.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
});

test('a Shopify order needs a label until one has been printed for it', () => {
  // No waybill exists to fetch - Shopify Shipping does not serve a SG-registered shop
  // delivering in ID, and this store rates shipping manually - so the label is the
  // packing sheet drawn here, and Shopify cannot tell us whether it was printed.
  const order = { channel: 'shopify', id: '#10926', status: 'PAID/UNFULFILLED', stage: 'to_ship' };
  assert.equal(labelReadiness(order).state, 'needsPrint');
  assert.equal(labelReadiness(order, { '#10926': { at: 1 } }).state, 'reprint');
  assert.equal(labelReadiness({ ...order, stage: 'completed' }).state, 'none');
});

test('the queries ask for pagination and nothing undefined', () => {
  for (const [name, query] of [['products', PRODUCTS_QUERY], ['orders', ORDERS_QUERY]]) {
    assert.ok(query.includes('pageInfo'), `${name} must paginate`);
    assert.ok(query.includes('$cursor'), `${name} must accept a cursor`);
    assert.ok(!query.includes('undefined'), `${name} has an interpolation hole`);
  }
  assert.ok(SHOP_QUERY.includes('myshopifyDomain'));
});

test('a channel-specific SKU merges onto its master product, not a separate row', async () => {
  // Shopify lists the pouch as GFT-POUCH-001 while the marketplaces call it Travel-Pouch.
  // Splitting them would report each half as "missing" on the other channels.
  const { findProduct } = await import('../src/master.js');
  assert.equal(findProduct('GFT-POUCH-001').sku, 'Travel-Pouch');
  assert.equal(findProduct('GFT-MYST-001').sku, 'Mystery-Gift');
});

test('Shopify is never a target of a stock or price write', async () => {
  // Its stock lives in location-scoped inventory levels, and its prices are deliberately
  // set lower than the marketplaces - writing either from here would be wrong.
  const { WRITABLE_CHANNELS } = await import('../src/stock-sync.js');
  assert.deepEqual(WRITABLE_CHANNELS, ['tiktok', 'shopee']);
  assert.ok(!WRITABLE_CHANNELS.includes('shopify'));
});

test('an address is joined from the parts the buyer filled in, skipping the blanks', async () => {
  const { formatAddress } = await import('../src/shopify/shop.js');
  assert.equal(
    formatAddress({ address1: 'Luxmore GA7 no 9', address2: null, city: 'BSD', province: 'Banten', zip: '15331', countryCodeV2: 'ID' }),
    'Luxmore GA7 no 9, BSD, Banten, 15331, ID',
  );
  assert.equal(formatAddress(null), '');
  assert.equal(formatAddress({}), '');
  assert.equal(formatAddress({ city: '  ', province: 'Bali' }), 'Bali');
});

test('a shop discount code reduces the sale, because nobody reimburses it', () => {
  // Read from discountAllocations, not totalDiscountSet. On order #10926 the second is
  // zero while a WELCOME15 code took Rp171.750 off - so every discounted Shopify sale
  // was booked at its full price, which is money the seller never received.
  const order = {
    totalPriceSet: { shopMoney: { amount: '973250.0', currencyCode: 'IDR' } },
    shippingLine: { originalPriceSet: { shopMoney: { amount: '0.0' } } },
    lineItems: {
      nodes: [
        {
          sku: 'GFT-MYST-001', quantity: 1, title: 'Moringa Seed Oil 3ml',
          originalUnitPriceSet: { shopMoney: { amount: '0.0' } },
          totalDiscountSet: { shopMoney: { amount: '0.0' } },
          discountAllocations: [],
        },
        {
          sku: 'OMC-270-001', quantity: 1, title: 'Organic Moringa Capsules',
          originalUnitPriceSet: { shopMoney: { amount: '1145000.0' } },
          totalDiscountSet: { shopMoney: { amount: '0.0' } },
          discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: '171750.0' } } }],
        },
      ],
    },
  };
  const finance = financeFromShopify(order);
  const capsules = finance.lines.find((l) => l.sku === 'OMC-270-001');
  assert.equal(capsules.unitDiscount, 171750);
  const goods = finance.lines.reduce((n, l) => n + (l.unitPrice - l.unitDiscount) * l.qty, 0);
  assert.equal(goods + finance.shipping, 973250, 'yang dibukukan sama dengan yang dibayar');
});

test('a line discounted in the order editor still counts, and is never counted twice', () => {
  const line = (over) => ({
    sku: 'A', quantity: 2, title: 'Satu',
    originalUnitPriceSet: { shopMoney: { amount: '100000.0' } },
    totalDiscountSet: { shopMoney: { amount: '0.0' } },
    discountAllocations: [],
    ...over,
  });
  const of = (nodes) => financeFromShopify({
    totalPriceSet: { shopMoney: { amount: '0.0', currencyCode: 'IDR' } },
    shippingLine: { originalPriceSet: { shopMoney: { amount: '0.0' } } },
    lineItems: { nodes },
  }).lines[0];

  // Only the old field: it is still the answer.
  assert.equal(of([line({ totalDiscountSet: { shopMoney: { amount: '20000.0' } } })]).unitDiscount, 10000);
  // Both filled in: allocations win rather than the two being added together.
  assert.equal(of([line({
    totalDiscountSet: { shopMoney: { amount: '20000.0' } },
    discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: '30000.0' } } }],
  })]).unitDiscount, 15000);
  // Several allocations on one line add up, because each is a different discount.
  assert.equal(of([line({
    discountAllocations: [
      { allocatedAmountSet: { shopMoney: { amount: '10000.0' } } },
      { allocatedAmountSet: { shopMoney: { amount: '30000.0' } } },
    ],
  })]).unitDiscount, 20000);
});
