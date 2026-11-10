import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOrder, withoutRemoved } from '../src/shopify/shop.js';
import { shopifyPushOrder } from '../src/webhooks/shopify-push.js';
import { isOrderEdit, statusFor } from '../src/webhooks/handle.js';

const money = (amount) => ({ shopMoney: { amount: String(amount), currencyCode: 'IDR' } });
const line = (id, sku, quantity, currentQuantity, price, discount = 0) => ({
  id: `gid://shopify/LineItem/${id}`, sku, title: sku, variantTitle: '', quantity, currentQuantity,
  originalUnitPriceSet: money(price), totalDiscountSet: money(0),
  discountAllocations: discount ? [{ allocatedAmountSet: money(discount), discountApplication: { index: 0 } }] : [],
});

// #13131 as Shopify returned it on 2026-11-10: the bundle and its two gifts removed in
// the order editor, 270 capsules and a free oil added.
const order13131 = () => ({
  id: 'gid://shopify/Order/18983230898418', name: '#13131', createdAt: '2026-11-10T01:02:00Z',
  displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
  totalPriceSet: money(2190000), currentTotalPriceSet: money(1145000), totalRefundedSet: money(0),
  // The edit itself, as Shopify records it: a Rp0 refund of the removed lines, CANCEL.
  refunds: [{ totalRefundedSet: money(0), refundLineItems: { nodes: [1, 2, 3].map((n) => ({ quantity: 1, restockType: 'CANCEL', lineItem: { id: `gid://shopify/LineItem/${n}` } })) } }],
  lineItems: { nodes: [
    line(1, 'Inside-Out-60-Protocol180+30', 1, 0, 1045000),
    line(2, 'GFT-POUCH-001', 1, 0, 0),
    line(3, 'GFT-MYST-001', 1, 0, 0),
    line(4, 'OMC-270-001', 1, 1, 1145000),
    line(5, 'OMO-30-001', 1, 1, 470000, 470000),
  ] },
  discountApplications: { nodes: [{ index: 0, targetType: 'LINE_ITEM', value: { amount: '470000' }, title: 'Gift' }] },
  shippingLine: { originalPriceSet: money(0), discountAllocations: [] },
});

test('lines removed in the order editor are gone from the order, the picklist and the books', () => {
  const mapped = mapOrder(order13131());
  assert.deepEqual(mapped.lines.map((l) => `${l.sku}x${l.qty}`).sort(), ['OMC-270-001x1', 'OMO-30-001x1']);
  assert.equal(mapped.items, 2);
  assert.equal(mapped.total, 1145000);
  assert.deepEqual(mapped.finance.lines.map((l) => [l.sku, l.qty, l.unitPrice, l.unitDiscount]), [
    ['OMC-270-001', 1, 1145000, 0],
    ['OMO-30-001', 1, 470000, 470000],
  ]);
});

test('refunded units are not mistaken for removed ones', () => {
  const order = order13131();
  order.lineItems.nodes = [line(9, 'OMC-180-001', 2, 1, 700000)];
  order.totalPriceSet = money(1400000);
  order.currentTotalPriceSet = money(700000);
  order.totalRefundedSet = money(700000);
  order.refunds = [{ totalRefundedSet: money(700000), refundLineItems: { nodes: [{ quantity: 1, restockType: 'RETURN', lineItem: { id: 'gid://shopify/LineItem/9' } }] } }];
  assert.equal(withoutRemoved(order), order, 'untouched: refunds keep their own handling');
  assert.equal(mapOrder(order).lines[0].qty, 2);
  assert.equal(mapOrder(order).total, 1400000);
});

test('a partly removed line keeps only its share of the discount', () => {
  const order = order13131();
  order.lineItems.nodes = [line(7, 'OMO-30-001', 3, 1, 470000, 300000)];
  order.totalPriceSet = money(1110000);
  order.currentTotalPriceSet = money(370000);
  order.refunds = [];
  const [l] = mapOrder(order).finance.lines;
  assert.deepEqual([l.qty, l.unitDiscount], [1, 100000]);
  assert.equal(mapOrder(order).total, 370000);
});

test('an order read without currentQuantity is left exactly as it was', () => {
  const order = order13131();
  for (const li of order.lineItems.nodes) delete li.currentQuantity;
  assert.equal(withoutRemoved(order), order);
  assert.equal(mapOrder(order).total, 2190000);
});

test('an orders/edited push names its order through order_edit.order_id', () => {
  const pushed = shopifyPushOrder({ order_edit: { id: 1, order_id: 18983230898418, line_items: { additions: [], removals: [] } } });
  assert.equal(pushed.admin_graphql_api_id, 'gid://shopify/Order/18983230898418');
  const paid = { name: '#13131', admin_graphql_api_id: 'gid://shopify/Order/1' };
  assert.equal(shopifyPushOrder(paid), paid);
});

test('only a Shopify orders/edited push rewrites an invoice, and an amend answers 200', () => {
  assert.equal(isOrderEdit({ channel: 'shopify', reason: 'orders/edited' }), true);
  assert.equal(isOrderEdit({ channel: 'shopify', reason: 'orders/paid' }), false);
  assert.equal(isOrderEdit({ channel: 'shopee', reason: 'orders/edited' }), false);
  assert.equal(statusFor({ status: 'amended' }), 200);
});

test('an order cancelled whole keeps showing what was bought', () => {
  const order = order13131();
  order.lineItems.nodes = [line(1, 'OMC-180-001', 1, 0, 700000)];
  order.refunds = [{ totalRefundedSet: money(700000), refundLineItems: { nodes: [{ quantity: 1, restockType: 'CANCEL', lineItem: { id: 'gid://shopify/LineItem/1' } }] } }];
  assert.equal(mapOrder(order).lines[0].qty, 1);
});
