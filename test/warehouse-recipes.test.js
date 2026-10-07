import test from 'node:test';
import assert from 'node:assert/strict';
import { openWarehouse, applyOrders, setRecipe, recipeOf, verifyWarehouse, emptyWarehouse, OPENING_AT } from '../src/warehouse.js';
import { handleWrite } from '../api/dashboard.js';

/**
 * Recipes set on the Stok page. The point of them is that one product leaving takes every
 * part it is made of off the shelf; the danger is a recipe edit quietly re-counting orders
 * that already left, or a cancel returning parts that never went out.
 */

const opened = () => openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 3600) * 1000 });
const order = (id, stage, lines) => ({ id, channel: 'shopee', stage, createdAt: OPENING_AT + 600, lines: lines.map(([sku, qty]) => ({ sku, qty })) });
const qty = (doc, code) => doc.items[code].qty;
const RITUAL_WITH_BOX = [{ code: 'M-093', qty: 1 }, { code: 'M-092', qty: 1 }, { code: 'M-091', qty: 1 }, { code: 'M-094', qty: 1 }, { code: 'M-049', qty: 1 }];

test('an edited recipe takes every part it lists, packaging included, from the next order', () => {
  let { doc } = setRecipe(opened(), { sku: 'MRS-001', parts: RITUAL_WITH_BOX, by: 'ika' });
  assert.deepEqual(recipeOf('MRS-001', doc.recipes), { 'M-093': 1, 'M-092': 1, 'M-091': 1, 'M-094': 1, 'M-049': 1 });
  // A bundle built on the Ritual Set follows the edit too.
  assert.equal(recipeOf('MRS-002', doc.recipes)['M-049'], 1);
  ({ doc } = applyOrders(doc, [order('A', 'shipping', [['MRS-001', 2]])]));
  assert.deepEqual([qty(doc, 'M-093'), qty(doc, 'M-049')], [216, 7471]);
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('editing a recipe never re-counts an order that already left, and its cancel returns what it took', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['MRS-001', 1]])]);
  ({ doc } = setRecipe(doc, { sku: 'MRS-001', parts: RITUAL_WITH_BOX }));
  // The sweep re-reads the same order every 30 minutes.
  ({ doc } = applyOrders(doc, [order('A', 'delivered', [['MRS-001', 1]])]));
  assert.equal(qty(doc, 'M-049'), 7473, 'mailerbox untouched: the order left before the recipe had it');
  ({ doc } = applyOrders(doc, [order('A', 'returned', [['MRS-001', 1]])]));
  assert.deepEqual([qty(doc, 'M-093'), qty(doc, 'M-049')], [218, 7473], 'back exactly as it was, no mailerbox conjured');
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('a line edit after a recipe change moves only the changed lines', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['MRS-001', 1]])]);
  ({ doc } = setRecipe(doc, { sku: 'MRS-001', parts: RITUAL_WITH_BOX }));
  ({ doc } = applyOrders(doc, [order('A', 'shipping', [['MRS-001', 1], ['OMO-30-001', 1]])]));
  assert.deepEqual([qty(doc, 'M-038'), qty(doc, 'M-049'), qty(doc, 'M-093')], [57, 7473, 217]);
  ({ doc } = applyOrders(doc, [order('A', 'cancelled', [['MRS-001', 1], ['OMO-30-001', 1]])]));
  assert.deepEqual([qty(doc, 'M-038'), qty(doc, 'M-049'), qty(doc, 'M-093')], [58, 7473, 218]);
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('saving the built-in recipe, or putting it back, leaves no edit behind', () => {
  let { doc, changed } = setRecipe(opened(), { sku: 'MRS-001', parts: [{ code: 'M-094', qty: 1 }, { code: 'M-093', qty: 1 }, { code: 'M-092', qty: 1 }, { code: 'M-091', qty: 1 }] });
  assert.equal(changed, false);
  assert.deepEqual(doc.recipes, {});
  ({ doc } = setRecipe(doc, { sku: 'OMC-270-001', parts: [{ code: 'M-036', qty: 2 }, { code: 'M-036', qty: 2 }] }));
  assert.deepEqual(doc.recipes['OMC-270-001'], { 'M-036': 4 }, 'the same part twice adds up');
  ({ doc, changed } = setRecipe(doc, { sku: 'OMC-270-001', parts: null }));
  assert.equal(changed, true);
  assert.deepEqual(recipeOf('OMC-270-001', doc.recipes), { 'M-036': 3 });
  assert.equal(doc.recipeLog.length, 2);
});

test('a recipe naming a missing item, no items, or a silly quantity is refused', () => {
  const doc = opened();
  assert.throws(() => setRecipe(doc, { sku: 'MRS-001', parts: [] }), /minimal/);
  assert.throws(() => setRecipe(doc, { sku: 'MRS-001', parts: [{ code: 'M-999', qty: 1 }] }), /tidak ada/);
  assert.throws(() => setRecipe(doc, { sku: 'MRS-001', parts: [{ code: 'M-093', qty: 0 }] }), /1-99/);
  assert.throws(() => setRecipe(doc, { sku: 'MRS-001', parts: [{ code: 'M-093', qty: 1.5 }] }), /1-99/);
  assert.throws(() => setRecipe(doc, { sku: 'NOPE', parts: [{ code: 'M-093', qty: 1 }] }), /tidak dikenal/);
});

test('the dashboard refuses a recipe for a product it does not know before touching anything', async () => {
  const form = new URLSearchParams({ action: 'wh_recipe', sku: 'NOPE', code: 'M-093', qty: '1' });
  await assert.rejects(() => handleWrite(form, '127.0.0.1', { name: 'qa', email: 'qa@x', role: 'owner', status: 'active' }, 'csrf'), /tidak dikenal/);
});
