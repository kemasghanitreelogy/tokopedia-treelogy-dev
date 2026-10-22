import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financeFromShopify } from '../src/omni.js';
import { orderDetail } from '../src/dashboard-page.js';

// The shape the live Admin API returned for #11845 on 22 Oct 2026.
const welcome10 = {
  totalPriceSet: { shopMoney: { amount: '715500.0', currencyCode: 'IDR' } },
  lineItems: { nodes: [{
    quantity: 1, sku: 'OMC-180-001', title: 'Organic Moringa Capsules',
    originalUnitPriceSet: { shopMoney: { amount: '795000.0' } },
    totalDiscountSet: { shopMoney: { amount: '0.0' } },
    discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: '79500.0' } }, discountApplication: { index: 0 } }],
  }] },
  discountApplications: { nodes: [{ index: 0, targetType: 'LINE_ITEM', value: { percentage: 10 }, code: 'WELCOME10' }] },
  shippingLine: { originalPriceSet: { shopMoney: { amount: '0.0' } }, discountAllocations: [] },
};

test('a Shopify code keeps its name, its percentage and what it took off', () => {
  const finance = financeFromShopify(welcome10);
  assert.deepEqual(finance.discounts, [{ label: 'WELCOME10', code: true, percent: 10, amount: 79500, shipping: false }]);
  assert.equal(finance.lines[0].unitDiscount, 79500);
});

test('a fixed-amount discount on the shipping line is told apart', () => {
  const finance = financeFromShopify({
    ...welcome10,
    discountApplications: { nodes: [{ index: 0, targetType: 'SHIPPING_LINE', value: { amount: '25000.0' }, title: 'Gratis ongkir' }] },
    lineItems: { nodes: [{ ...welcome10.lineItems.nodes[0], discountAllocations: [] }] },
    shippingLine: {
      originalPriceSet: { shopMoney: { amount: '25000.0' } },
      discountAllocations: [{ allocatedAmountSet: { shopMoney: { amount: '25000.0' } }, discountApplication: { index: 0 } }],
    },
  });
  assert.deepEqual(finance.discounts, [{ label: 'Gratis ongkir', code: false, fixed: 25000, amount: 25000, shipping: true }]);
});

test('the order popup shows the code, the percentage and the discount total', () => {
  const html = orderDetail({
    channel: 'shopify', id: '#11845', stage: 'to_ship', createdAt: 0, total: 715500,
    finance: financeFromShopify(welcome10),
  }, 0);
  assert.match(html, /WELCOME10/);
  assert.match(html, /10%/);
  assert.match(html, /Diskon/);
  assert.match(html, /-Rp79\.500/);
});

test('a typed-in sale shows a percentage discount as it was typed', () => {
  const html = orderDetail({
    channel: 'manual', source: 'WA', id: 'WA-1', stage: 'to_ship', createdAt: 0, total: 160000,
    finance: { lines: [{ sku: 'X', name: 'X', qty: 2, unitPrice: 100000, unitDiscount: 20000, discountPercent: 20 }], shipping: 0 },
  }, 0);
  assert.match(html, /Diskon 20% &middot; -Rp40\.000/);
  assert.match(html, /Harga barang/);
});

test('an order without a discount shows no discount rows', () => {
  const html = orderDetail({
    channel: 'manual', source: 'WA', id: 'WA-2', stage: 'to_ship', createdAt: 0, total: 100000,
    finance: { lines: [{ sku: 'X', name: 'X', qty: 1, unitPrice: 100000, unitDiscount: 0 }], shipping: 0 },
  }, 0);
  assert.doesNotMatch(html, /Diskon|od__dl/);
});
