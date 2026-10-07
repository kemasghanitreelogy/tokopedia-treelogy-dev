import test from 'node:test';
import assert from 'node:assert/strict';
import { openWarehouse, applyOrders as readOrders, setRecipe, recipeOf, verifyWarehouse, emptyWarehouse, OPENING_AT } from '../src/warehouse.js';
// Taking an order off the shelf is a picklist confirmation (`admit`); these cases are about
// what happens once it is taken.
const applyOrders = (doc, orders, options = {}) => readOrders(doc, orders, { admit: true, ...options });
import { handleWrite } from '../api/dashboard.js';

/**
 * Recipes set on the Stok page. The point of them is that one product leaving takes every
 * part it is made of off the shelf; the danger is a recipe edit quietly re-counting orders
 * that already left, or a cancel returning parts that never went out.
 */

const opened = () => openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 3600) * 1000 });
const order = (id, stage, lines) => ({ id, channel: 'shopee', stage, createdAt: OPENING_AT + 600, lines: lines.map(([sku, qty]) => ({ sku, qty })) });
const qty = (doc, code) => doc.items[code].qty;
const RITUAL_WITH_BOX = [{ code: 'M-093', qty: 1 }, { code: 'M-092', qty: 1 }, { code: 'M-091', qty: 1 }, { code: 'M-094', qty: 1 }, { code: 'M-051', qty: 1 }];

test('an edited recipe takes every part it lists, a pouch included, from the next order', () => {
  let { doc } = setRecipe(opened(), { sku: 'MRS-001', parts: RITUAL_WITH_BOX, by: 'ika' });
  assert.deepEqual(recipeOf('MRS-001', doc.recipes), { 'M-093': 1, 'M-092': 1, 'M-091': 1, 'M-094': 1, 'M-051': 1 });
  // A bundle built on the Ritual Set follows the edit too.
  assert.equal(recipeOf('MRS-002', doc.recipes)['M-051'], 1);
  ({ doc } = applyOrders(doc, [order('A', 'shipping', [['MRS-001', 2]])]));
  assert.deepEqual([qty(doc, 'M-093'), qty(doc, 'M-051')], [216, 261]);
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('editing a recipe never re-counts an order that already left, and its cancel returns what it took', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['MRS-001', 1]])]);
  ({ doc } = setRecipe(doc, { sku: 'MRS-001', parts: RITUAL_WITH_BOX }));
  // The sweep re-reads the same order every 30 minutes.
  ({ doc } = applyOrders(doc, [order('A', 'delivered', [['MRS-001', 1]])]));
  assert.equal(qty(doc, 'M-051'), 263, 'pouch untouched: the order left before the recipe had it');
  ({ doc } = applyOrders(doc, [order('A', 'returned', [['MRS-001', 1]])]));
  assert.deepEqual([qty(doc, 'M-093'), qty(doc, 'M-051')], [218, 263], 'back exactly as it was, no pouch conjured');
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('a line edit after a recipe change moves only the changed lines', () => {
  let { doc } = applyOrders(opened(), [order('A', 'shipping', [['MRS-001', 1]])]);
  ({ doc } = setRecipe(doc, { sku: 'MRS-001', parts: RITUAL_WITH_BOX }));
  ({ doc } = applyOrders(doc, [order('A', 'shipping', [['MRS-001', 1], ['OMO-30-001', 1]])]));
  assert.deepEqual([qty(doc, 'M-038'), qty(doc, 'M-051'), qty(doc, 'M-093')], [57, 263, 217]);
  ({ doc } = applyOrders(doc, [order('A', 'cancelled', [['MRS-001', 1], ['OMO-30-001', 1]])]));
  assert.deepEqual([qty(doc, 'M-038'), qty(doc, 'M-051'), qty(doc, 'M-093')], [58, 263, 218]);
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

test('a removed recipe takes nothing, and a bundle built on it still takes its other parts', () => {
  let { doc, changed } = setRecipe(opened(), { sku: 'MRS-001', remove: true });
  assert.equal(changed, true);
  assert.equal(recipeOf('MRS-001', doc.recipes), null);
  assert.deepEqual(recipeOf('MRS-002', doc.recipes), { 'M-035': 1 }, 'Ritual Set + Powder 45 g: only the powder');
  ({ doc } = applyOrders(doc, [order('A', 'shipping', [['MRS-001', 1], ['MRS-002', 1]])]));
  assert.deepEqual([qty(doc, 'M-093'), qty(doc, 'M-035')], [218, 41]);
  assert.deepEqual(doc.orders['shopee|A'].unknown, ['MRS-001']);
  // Put back, and it takes its parts again from the next order.
  ({ doc } = setRecipe(doc, { sku: 'MRS-001', parts: null }));
  assert.deepEqual(doc.recipes, {});
  ({ doc } = applyOrders(doc, [order('B', 'shipping', [['MRS-001', 1]])]));
  assert.equal(qty(doc, 'M-093'), 217);
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('removing a product with no built-in recipe leaves nothing stored', () => {
  let { doc } = setRecipe(opened(), { sku: 'Bamboo-Whisk', parts: [{ code: 'M-092', qty: 1 }, { code: 'M-094', qty: 1 }] });
  ({ doc } = setRecipe(doc, { sku: 'Bamboo-Whisk', remove: true }));
  assert.deepEqual(doc.recipes, { 'Bamboo-Whisk': {} }, 'Bamboo-Whisk has a built-in recipe, so removal is kept explicitly');
  assert.equal(recipeOf('Bamboo-Whisk', doc.recipes), null);
});

test('packaging held from before is forgotten whole: item, movements, recipe mentions', async () => {
  const { UNTRACKED } = await import('../src/warehouse.js');
  // The production document as it stood: packaging items with their opening movements,
  // and a recipe that listed a card next to the sample bottle.
  const old = opened();
  old.items['M-095'] = { name: 'Card Oil 3 mL - Green', uom: 'PCS', group: 'pack', qty: 824 };
  old.moves.push({ id: 'open-M-095', at: OPENING_AT, code: 'M-095', kind: 'opening', delta: 824, after: 824 });
  old.folded['M-049'] = 5;
  old.recipes = { 'Mystery-Gift': { 'M-087': 1, 'M-095': 1 }, 'MRS-001': { 'M-049': 1 } };
  old.orders = { 'shopee|X': { at: OPENING_AT, rev: 1, lines: { 'Mystery-Gift': 1 }, items: { 'M-087': 1, 'M-095': 1 } } };
  const doc = openWarehouse(old);
  assert.ok(Object.keys(doc.items).every((c) => !UNTRACKED.has(c)));
  assert.ok(doc.moves.every((m) => !UNTRACKED.has(m.code)));
  assert.deepEqual(doc.folded, {});
  assert.deepEqual(doc.recipes, {}, 'card dropped leaves the built-in recipe; packaging-only recipe dropped');
  assert.deepEqual(doc.orders['shopee|X'].items, { 'M-087': 1 });
  assert.deepEqual(verifyWarehouse(doc), []);
  assert.throws(() => setRecipe(doc, { sku: 'MRS-001', parts: [{ code: 'M-049', qty: 1 }] }), /tidak ada/);
});

test('nothing leaves the shelf until the picklist is confirmed; the sheet era never does', async () => {
  const { awaitingPick, afterOpening } = await import('../src/warehouse.js');
  const old = { ...order('OLD', 'to_ship', [['OMC-90-001', 1]]), createdAt: OPENING_AT - 9000, printedAt: OPENING_AT - 600 };
  const late = { ...order('LATE', 'to_ship', [['OMC-90-001', 2]]), createdAt: OPENING_AT - 9000, printedAt: OPENING_AT + 60 };
  const fresh = order('NEW', 'to_ship', [['OMC-90-001', 1]]);
  // Arriving, printing and shipping move nothing on their own.
  let { doc } = readOrders(opened(), [old, late, fresh, { ...fresh, stage: 'shipping' }]);
  assert.equal(qty(doc, 'M-036'), 248);
  assert.deepEqual([old, late, fresh].map((o) => awaitingPick(doc, o)), [false, true, true]);
  assert.deepEqual([old, late, fresh].map(afterOpening), [false, true, true]);
  // Confirmed: taken once, even confirmed again, and off the waiting list.
  ({ doc } = readOrders(doc, [old, late, fresh], { admit: true, by: 'ika' }));
  ({ doc } = readOrders(doc, [late, fresh], { admit: true }));
  assert.equal(qty(doc, 'M-036'), 245);
  assert.equal(doc.moves.at(-1).by, 'ika');
  assert.deepEqual([late, fresh].map((o) => awaitingPick(doc, o)), [false, false]);
  // Cancelled after picking: back on the shelf automatically, and waiting again if revived.
  ({ doc } = readOrders(doc, [{ ...late, stage: 'cancelled' }]));
  assert.equal(qty(doc, 'M-036'), 247);
  assert.equal(awaitingPick(doc, late), true);
  ({ doc } = readOrders(doc, [late]));
  assert.equal(qty(doc, 'M-036'), 247, 'revived but not confirmed again: stays');
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('a push and a sweep counting the same orders at once take them off once', async () => {
  const { syncWarehouse } = await import('../src/warehouse-run.js');
  let state = null;
  // A store that makes the second writer collide and retry on the fresh document.
  const update = async (_key, fn, empty) => { const base = structuredClone(state ?? empty); await new Promise((r) => setImmediate(r)); state = fn(structuredClone(state ?? base)); return state; };
  const list = [order('P1', 'to_ship', [['MRS-001', 1]]), order('P2', 'to_ship', [['OMO-30-001', 3]])];
  await Promise.all([syncWarehouse(list, { update, printed: {}, arranged: {} }), syncWarehouse(list, { update, printed: {}, arranged: {} })]);
  assert.deepEqual([state.items['M-093'].qty, state.items['M-038'].qty], [217, 55]);
  assert.deepEqual(verifyWarehouse(state), []);
});

test('print times come from the ledger, and a backlog marked printed without printing does not count', async () => {
  const { withPrintTimes } = await import('../src/warehouse-run.js');
  const printed = {
    'shopee:A': { at: OPENING_AT + 100, first: OPENING_AT + 50 },
    'B': { at: OPENING_AT + 70 },
    'shopee:C': { at: OPENING_AT + 80, first: OPENING_AT + 80, marked: true },
  };
  const out = await withPrintTimes([order('A', 'to_ship', []), order('B', 'to_ship', []), order('C', 'to_ship', []), order('D', 'to_ship', [])], printed);
  assert.deepEqual(out.map((o) => o.printedAt), [OPENING_AT + 50, OPENING_AT + 70, undefined, undefined]);
});


test('the picklist holds only orders with nothing left to arrange on the Proses page', async () => {
  const { readyToPick } = await import('../src/picklist.js');
  const shelf = opened();
  const at = OPENING_AT + 600;
  const o = (channel, status, extra = {}) => ({ id: `${channel}-${status}`, channel, stage: 'to_ship', status, createdAt: at, lines: [{ sku: 'OMC-90-001', qty: 1 }], ...extra });
  const cases = [
    [o('shopee', 'READY_TO_SHIP'), false, 'Shopee belum diatur'],
    [o('shopee', 'PROCESSED'), true, 'Shopee sudah diatur'],
    [o('tokopedia', 'AWAITING_SHIPMENT'), false, 'Tokopedia belum diatur'],
    [o('tokopedia', 'AWAITING_COLLECTION'), true, 'Tokopedia sudah diatur'],
    [o('shopify', 'PAID/UNFULFILLED', { id: '#1' }), false, 'Shopify belum diatur'],
    [o('shopify', 'PAID/UNFULFILLED', { id: '#2' }), true, 'Shopify sudah diatur'],
    [o('manual', 'x', { source: 'OFFLINE' }), true, 'transaksi tanpa kurir'],
  ];
  const arranged = { '#2': { at } };
  for (const [order, want, why] of cases) assert.equal(readyToPick(order, { shelf, arranged }), want, why);
  assert.equal(readyToPick({ ...o('shopee', 'PROCESSED'), stage: 'shipping' }, { shelf, arranged }), false, 'sudah dikirim bukan picklist');
});

test('each run that takes orders lands in the picklist history with them, in the same write', async () => {
  const { syncWarehouse } = await import('../src/warehouse-run.js');
  let state = null;
  const update = async (_k, fn, empty) => { state = fn(structuredClone(state ?? empty)); return state; };
  await syncWarehouse([order('H1', 'to_ship', [['MRS-001', 1]]), order('H2', 'to_ship', [['OMC-90-001', 2]])], { update, printed: {}, arranged: {}, now: (OPENING_AT + 7200) * 1000 });
  await syncWarehouse([order('H1', 'to_ship', [['MRS-001', 1]])], { update, printed: {}, arranged: {}, now: (OPENING_AT + 7300) * 1000 });
  assert.equal(state.picks.length, 1, 'a run that took nothing new leaves no run');
  assert.deepEqual(state.picks[0].orders.map((x) => [x.key, x.units]), [['shopee|H1', 4], ['shopee|H2', 2]]);
  assert.equal(state.picks[0].by, 'otomatis');
});

test('a document confirmed before the history existed gets it from its orders', () => {
  const old = opened();
  old.orders = { 'shopee|A': { at: 1, picked: OPENING_AT + 99, by: 'Kemas', lines: { 'OMC-90-001': 1 }, items: { 'M-036': 1 } }, 'shopee|B': { at: 1, picked: OPENING_AT + 99, by: 'Kemas', lines: {}, items: { 'M-038': 2 } } };
  delete old.picks;
  const doc = openWarehouse(old);
  assert.equal(doc.picks.length, 1);
  assert.deepEqual([doc.picks[0].by, doc.picks[0].orders.length, doc.picks[0].orders[1].units], ['Kemas', 2, 2]);
});

test('an order leaves the shelf the moment it reaches the picklist, never before', async () => {
  const { syncWarehouse } = await import('../src/warehouse-run.js');
  let state = null;
  const update = async (_k, fn, empty) => { state = fn(structuredClone(state ?? empty)); return state; };
  const o = (id, channel, stage, status, extra = {}) => ({ id, channel, stage, status, createdAt: OPENING_AT + 600, lines: [{ sku: 'OMC-90-001', qty: 1 }], ...extra });
  const run = (orders, arranged = {}) => syncWarehouse(orders, { update, printed: {}, arranged });
  // Waiting on "Atur pengiriman": nothing moves.
  await run([o('A', 'shopee', 'to_ship', 'READY_TO_SHIP'), o('B', 'tokopedia', 'to_ship', 'AWAITING_SHIPMENT'), o('#C', 'shopify', 'to_ship', 'PAID'), o('D', 'shopee', 'unpaid', 'UNPAID')]);
  assert.equal(state.items['M-036'].qty, 248);
  // Arranged: on the picklist, off the shelf - each once, however often it is read.
  await run([o('A', 'shopee', 'to_ship', 'PROCESSED'), o('B', 'tokopedia', 'to_ship', 'AWAITING_COLLECTION'), o('#C', 'shopify', 'to_ship', 'PAID')], { '#C': { at: 1 } });
  await run([o('A', 'shopee', 'shipping', 'SHIPPED'), o('B', 'tokopedia', 'to_ship', 'AWAITING_COLLECTION')], { '#C': { at: 1 } });
  assert.equal(state.items['M-036'].qty, 245);
  // Shipped before anybody saw it on the list: it left all the same.
  await run([o('E', 'tiktok_shop', 'shipping', 'IN_TRANSIT')]);
  assert.equal(state.items['M-036'].qty, 244);
  // Cancelled after it was taken: back on the shelf.
  await run([o('A', 'shopee', 'cancelled', 'CANCELLED')]);
  assert.equal(state.items['M-036'].qty, 245);
  assert.deepEqual(verifyWarehouse(state), []);
});

test('a batch runs from 15:00 WITA the day before to 15:00 WITA, and leaves out what was cancelled', async () => {
  const { batchOf, batchWindow } = await import('../src/warehouse.js');
  const { batchOrders, batchesIn } = await import('../src/picklist.js');
  const at = (iso) => Date.parse(iso) / 1000;
  assert.equal(batchOf(at('2026-10-07T15:00:00+08:00')), '2026-10-07', '15.00 tepat masih batch hari itu');
  assert.equal(batchOf(at('2026-10-07T15:00:01+08:00')), '2026-10-08', 'lewat 15.00 masuk batch besok');
  assert.equal(batchOf(at('2026-10-06T15:00:01+08:00')), '2026-10-07');
  assert.deepEqual(batchWindow('2026-10-07'), { from: at('2026-10-06T15:00:00+08:00'), to: at('2026-10-07T15:00:00+08:00') });
  const doc = { orders: {
    'shopee|A': { picked: at('2026-10-07T09:00:00+08:00'), lines: { 'OMC-90-001': 2 }, buyer: 'Rina' },
    'shopify|#9': { picked: at('2026-10-06T16:00:00+08:00'), lines: { 'MRS-001': 1 } },
    'shopee|X': { picked: at('2026-10-07T10:00:00+08:00'), lines: { 'OMC-90-001': 1 }, undone: 1 },
    'shopee|N': { picked: at('2026-10-07T16:00:00+08:00'), lines: { 'OMO-30-001': 1 } },
  } };
  const b = batchOrders(doc, '2026-10-07');
  assert.deepEqual(b.map((o) => o.id), ['#9', 'A']);
  assert.equal(b[1].lines[0].name, 'Moringa Capsules', 'dinamai dari master');
  assert.deepEqual(batchesIn(doc), [['2026-10-08', 1], ['2026-10-07', 2]]);
});
