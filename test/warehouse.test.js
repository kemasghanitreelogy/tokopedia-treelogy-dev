import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeOf, itemsForOrder, openWarehouse, applyOrders as readOrders, manualMove, resolveRefund, holdRefund, receiveGoods, verifyWarehouse, makeable, emptyWarehouse, OPENING_AT, OPENING_ITEMS } from '../src/warehouse.js';
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

test('a cancelled or returned order waits for a person, and goes back on once if they say so', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['OMC-270-001', 1]])]);
  assert.equal(qty(doc, 'M-036'), 245);
  ({ doc } = applyOrders(doc, [order('A', 'returned', [['OMC-270-001', 1]])]));
  ({ doc } = applyOrders(doc, [order('A', 'returned', [['OMC-270-001', 1]])]));
  assert.equal(qty(doc, 'M-036'), 245, 'nothing moves on the status alone');
  assert.deepEqual(Object.keys(doc.refunds), ['shopee|A']);
  assert.deepEqual([doc.refunds['shopee|A'].reason, doc.refunds['shopee|A'].items], ['returned', { 'M-036': 3 }]);
  let records;
  ({ doc, records } = resolveRefund(doc, { key: 'shopee|A', back: true, by: 'ika', token: 't1' }));
  assert.equal(qty(doc, 'M-036'), 248);
  assert.deepEqual([records.length, records[0].kind, records[0].by], [1, 'return', 'ika']);
  assert.deepEqual(doc.refunds, {});
  // The same press twice, or a second answer, moves nothing more.
  assert.equal(resolveRefund(doc, { key: 'shopee|A', back: true, token: 't1' }).duplicate, true);
  assert.throws(() => resolveRefund(doc, { key: 'shopee|A', back: true }), /sudah diputuskan/);
  ({ doc } = applyOrders(doc, [order('A', 'returned', [['OMC-270-001', 1]])]));
  assert.equal(qty(doc, 'M-036'), 248);
  assert.deepEqual(doc.refunds, {});
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('goods the buyer kept never come back, and the refunds stack one row each', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['OMO-30-001', 1]]), order('B', 'shipping', [['OMO-30-001', 2]]), order('C', 'to_ship', [['OMO-30-001', 1]])]);
  assert.equal(qty(doc, 'M-038'), 54);
  ({ doc } = applyOrders(doc, [order('A', 'returned', [['OMO-30-001', 1]]), order('B', 'cancelled', [['OMO-30-001', 2]])]));
  assert.deepEqual(Object.keys(doc.refunds).sort(), ['shopee|A', 'shopee|B']);
  ({ doc } = resolveRefund(doc, { key: 'shopee|A', back: false, by: 'ika' }));
  ({ doc } = resolveRefund(doc, { key: 'shopee|B', back: true, by: 'ika' }));
  assert.equal(qty(doc, 'M-038'), 56, 'only B came back');
  assert.deepEqual(doc.refundLog.map((r) => [r.key, r.back]), [['shopee|A', false], ['shopee|B', true]]);
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('a refund from the dashboard holds the order the same way, once', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['OMO-30-001', 1]])]);
  doc = { ...doc, ...holdRefund(doc, 'shopee|A', { at: 1, reason: 'refund', label: 'shopee A' }) };
  assert.equal(doc.refunds['shopee|A'].reason, 'refund');
  assert.deepEqual(holdRefund(doc, 'shopee|A', { at: 2, reason: 'refund' }), {}, 'already held');
  assert.deepEqual(holdRefund(doc, 'shopee|NEVER', { at: 2, reason: 'refund' }), {}, 'never left the shelf');
  // The platform still reading "shipping" does not revive it, before or after the answer.
  ({ doc } = applyOrders(doc, [order('A', 'shipping', [['OMO-30-001', 1]])]));
  assert.equal(doc.refunds['shopee|A'].reason, 'refund');
  ({ doc } = resolveRefund(doc, { key: 'shopee|A', back: true }));
  ({ doc } = applyOrders(doc, [order('A', 'shipping', [['OMO-30-001', 1]])]));
  assert.equal(qty(doc, 'M-038'), 58, 'came back once, never taken again');
  // The platform reporting the cancel afterwards is not a second row.
  ({ doc } = applyOrders(doc, [order('A', 'cancelled', [['OMO-30-001', 1]])]));
  assert.deepEqual(doc.refunds, {});
  assert.equal(qty(doc, 'M-038'), 58);
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('an order revived before anyone answered is live again, its goods still out', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['OMO-30-001', 1]])]);
  ({ doc } = applyOrders(doc, [order('A', 'cancelled', [['OMO-30-001', 1]])]));
  ({ doc } = applyOrders(doc, [order('A', 'shipping', [['OMO-30-001', 1]])]));
  assert.equal(qty(doc, 'M-038'), 57, 'taken once, never twice');
  assert.deepEqual(doc.refunds, {});
  assert.equal(doc.orders['shopee|A'].undone, undefined);
  assert.deepEqual(verifyWarehouse(doc), []);
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

test('a supplier delivery adds every line at once, and a resubmit adds nothing', () => {
  const lines = [{ code: 'M-037', qty: 200 }, { code: 'M-038', qty: 120 }, { code: 'M-037', qty: 6 }];
  let { doc, records } = receiveGoods(opened(), { lines, note: 'PO-77', by: 'ika', token: 'rcv-aaaaaaaaaaaaaaaa' });
  assert.equal(qty(doc, 'M-037'), 126 + 206, 'baris yang sama dijumlah');
  assert.equal(qty(doc, 'M-038'), 58 + 120);
  assert.deepEqual(records.map((r) => [r.code, r.kind, r.delta, r.note, r.by]), [['M-037', 'in', 206, 'PO-77', 'ika'], ['M-038', 'in', 120, 'PO-77', 'ika']]);
  assert.deepEqual(verifyWarehouse(doc), []);
  const again = receiveGoods(doc, { lines, by: 'ika', token: 'rcv-aaaaaaaaaaaaaaaa' });
  assert.equal(again.duplicate, true);
  assert.equal(qty(again.doc, 'M-037'), 126 + 206);
});

test('a delivery with one bad line records none of it', () => {
  const start = opened();
  assert.throws(() => receiveGoods(start, { lines: [{ code: 'M-037', qty: 5 }, { code: 'NOPE', qty: 1 }], by: 'x' }), /tidak ada/);
  assert.throws(() => receiveGoods(start, { lines: [{ code: 'M-037', qty: 0 }], by: 'x' }), /bilangan bulat/);
  assert.throws(() => receiveGoods(start, { lines: [{ code: 'M-037', qty: 1.5 }], by: 'x' }), /bilangan bulat/);
  assert.throws(() => receiveGoods(start, { lines: [], by: 'x' }), /minimal satu/);
  assert.equal(qty(start, 'M-037'), 126);
  assert.equal(start.moves.some((m) => m.kind === 'in'), false);
});
