import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeOf, itemsForOrder, openWarehouse, applyOrders as readOrders, manualMove, makeable, emptyWarehouse, OPENING_AT, OPENING_ITEMS } from '../src/warehouse.js';
// Taking an order off the shelf is a picklist confirmation (`admit`); these cases are about
// what happens once it is taken.
const applyOrders = (doc, orders, options = {}) => readOrders(doc, orders, { admit: true, ...options });

/**
 * The real warehouse, migrated from the sheet on 7 Oct 2026 and kept apart from every
 * marketplace figure. The cases that would corrupt a real count: an order taken twice,
 * an order from before the migration taken at all, a cancellation never put back, and a
 * bundle resolved to the wrong parts.
 */

const opened = () => openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 3600) * 1000 });
const order = (id, stage, lines, createdAt = OPENING_AT + 600, channel = 'shopee') => ({ id, channel, stage, createdAt, lines: lines.map(([sku, qty]) => ({ sku, qty })) });
const qty = (doc, code) => doc.items[code].qty;

test('the opening stock is the sheet\'s Current Stock, item by item', () => {
  const doc = opened();
  assert.equal(Object.keys(doc.items).length, OPENING_ITEMS.length);
  assert.equal(qty(doc, 'M-036'), 248);
  assert.equal(qty(doc, 'M-093'), 218);
  assert.equal(doc.items['M-058'], undefined, 'kemasan tidak dilacak');
});

test('a Ritual Set is a bowl, a whisk, a scoop and a wooden box; with powder, the powder too', () => {
  assert.deepEqual(recipeOf('MRS-001'), { 'M-093': 1, 'M-092': 1, 'M-091': 1, 'M-094': 1 });
  assert.deepEqual(recipeOf('MRS-002'), { 'M-093': 1, 'M-092': 1, 'M-091': 1, 'M-094': 1, 'M-035': 1 });
  assert.deepEqual(recipeOf('Discovery-Pack'), { 'M-035': 1, 'M-038': 1, 'M-036': 1 });
  assert.deepEqual(recipeOf('OMC-270-001'), { 'M-036': 3 }, '270 caps = tiga toples 90');
  assert.deepEqual(recipeOf('The-Movement-&-Relief'), { 'M-036': 1, 'M-038': 1 });
  assert.deepEqual(recipeOf('OMC90'), { 'M-036': 1 }, 'alias kanal ikut');
});

test('a shipped order comes off the shelf once, however often it is pushed', () => {
  const sale = order('A', 'shipping', [['MRS-002', 2]]);
  let { doc } = applyOrders(opened(), [sale]);
  ({ doc } = applyOrders(doc, [{ ...sale, stage: 'delivered' }, { ...sale, stage: 'completed' }]));
  assert.equal(qty(doc, 'M-093'), 216);
  assert.equal(qty(doc, 'M-035'), 40);
});

test('an order that is not confirmed on the picklist has not left the shelf, shipped or not', () => {
  const { doc } = readOrders(opened(), [order('A', 'to_ship', [['OMC-90-001', 5]]), order('B', 'completed', [['OMC-90-001', 5]])]);
  assert.equal(qty(doc, 'M-036'), 248);
});

test('orders from before the migration were the sheet\'s to count', () => {
  const { doc } = applyOrders(opened(), [order('OLD', 'completed', [['OMC-90-001', 5]], OPENING_AT - 60)]);
  assert.equal(qty(doc, 'M-036'), 248);
});

test('a cancelled or returned order goes back on, once', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['OMC-270-001', 1]])]);
  assert.equal(qty(doc, 'M-036'), 245);
  ({ doc } = applyOrders(doc, [order('A', 'returned', [['OMC-270-001', 1]])]));
  ({ doc } = applyOrders(doc, [order('A', 'returned', [['OMC-270-001', 1]])]));
  assert.equal(qty(doc, 'M-036'), 248);
});

test('a line the recipes cannot place is remembered, not guessed', () => {
  const { items, unknown } = itemsForOrder(order('A', 'shipping', [['TIDAK-ADA', 1], ['OMO-30-001', 1]]));
  assert.deepEqual(items, { 'M-038': 1 });
  assert.deepEqual(unknown, ['TIDAK-ADA']);
});

test('goods in, goods out and a count each leave a movement with who and why', () => {
  let { doc, record } = manualMove(opened(), { code: 'M-094', kind: 'in', qty: 50, note: 'PO-12', by: 'ika' });
  assert.equal(qty(doc, 'M-094'), 248);
  assert.deepEqual([record.delta, record.after, record.by, record.note], [50, 248, 'ika', 'PO-12']);
  ({ doc } = manualMove(doc, { code: 'M-094', kind: 'out', qty: 8, by: 'ika' }));
  assert.equal(qty(doc, 'M-094'), 240);
  ({ doc, record } = manualMove(doc, { code: 'M-094', kind: 'count', qty: 237, note: 'opname', by: 'ika' }));
  assert.deepEqual([qty(doc, 'M-094'), record.delta], [237, -3]);
  assert.throws(() => manualMove(doc, { code: 'M-094', kind: 'in', qty: 0, by: 'x' }), /positif/);
  assert.throws(() => manualMove(doc, { code: 'NOPE', kind: 'in', qty: 1, by: 'x' }), /tidak ada/);
});

test('what the shelf can make is decided by the scarcest part', () => {
  const r = makeable('MRS-001', opened().items);
  assert.equal(r.can, 114);
  assert.equal(r.limit, 'M-091', 'scoop paling sedikit');
  assert.equal(makeable('OMC-270-001', opened().items).can, 82, 'floor(248/3)');
});
