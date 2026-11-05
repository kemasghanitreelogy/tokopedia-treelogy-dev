import test from 'node:test';
import assert from 'node:assert/strict';
import { resendSwap, swapGoods, verifyWarehouse, emptyWarehouse, applyOrders } from '../src/warehouse.js';
import { renderDashboard } from '../src/dashboard-page.js';
import { summarize } from '../src/omni.js';
import { afterWrite } from '../api/dashboard.js';

const item = (name, qty) => ({ name, qty, uom: 'PCS', group: 'finished' });
const KEY = 'shopify|#12349';
const base = () => ({
  ...emptyWarehouse(),
  items: { 'M-037': item('Capsules 180', 20), 'M-033': item('Powder 180 g', 5) },
  folded: { 'M-037': 20, 'M-033': 5 },
  orders: { [KEY]: { at: 1, rev: 1, lines: { 'OMC-180-001': 1 }, items: { 'M-037': 1 } } },
});
const original = { channel: 'shopify', id: '#12349' };
const resend = (lines = [{ sku: 'OMP-180-001', qty: 2 }]) => ({ id: 'RS-1', channel: 'manual', stage: 'processing', createdAt: 2e9, lines: [{ sku: 'OMC-180-001', qty: 1 }], finance: { wrongGoods: { lines } } });
const quantities = (doc) => Object.fromEntries(Object.entries(doc.items).map(([code, it]) => [code, it.qty]));

test('the proposal gives back what the order took and takes out what was sent by mistake', () => {
  const plan = resendSwap(base(), original, resend());
  assert.deepEqual(plan.back.map((r) => [r.code, r.qty]), [['M-037', 1]]);
  assert.equal(plan.out.length, 1);
  assert.equal(plan.out[0].qty, 2);
  assert.equal(plan.done, false);
});

test('an order the log never took, or already put back, has nothing to give back', () => {
  assert.deepEqual(resendSwap({ ...base(), orders: {} }, original, resend()).back, []);
  const undone = base();
  undone.orders[KEY].undone = true;
  assert.deepEqual(resendSwap(undone, original, resend()).back, []);
});

test('a confirmed swap moves the edited numbers, balances, and counts once', () => {
  const input = { key: KEY, resendId: 'RS-1', back: [{ code: 'M-037', qty: 1 }], out: [{ code: 'M-033', qty: 3 }], by: 'Kemas' };
  const { doc, records } = swapGoods(base(), input);
  assert.deepEqual(quantities(doc), { 'M-037': 21, 'M-033': 2 });
  assert.deepEqual(records.map((r) => [r.kind, r.delta]), [['in', 1], ['out', -3]]);
  assert.deepEqual(verifyWarehouse(doc), []);
  const again = swapGoods(doc, input);
  assert.equal(again.duplicate, true);
  assert.deepEqual(quantities(again.doc), quantities(doc));
  assert.equal(resendSwap(doc, original, resend()).done, true);
});

test('a zero leaves its line out, and all zeros or a bad number record nothing', () => {
  const swap = (back, out) => swapGoods(base(), { key: KEY, resendId: 'RS-1', back, out, by: 'K' });
  assert.deepEqual(quantities(swap([{ code: 'M-037', qty: 0 }], [{ code: 'M-033', qty: 1 }]).doc), { 'M-037': 20, 'M-033': 4 });
  assert.throws(() => swap([{ code: 'M-037', qty: 0 }], []), /minimal satu/);
  assert.throws(() => swap([{ code: 'M-037', qty: -1 }], []), /bilangan bulat/);
  assert.throws(() => swap([{ code: 'M-999', qty: 1 }], []), /tidak ada di gudang/);
});

test('after a swap the order records what really left, and a later cancel offers that', () => {
  const { doc } = swapGoods(base(), { key: KEY, resendId: 'RS-1', back: [{ code: 'M-037', qty: 1 }], out: [{ code: 'M-033', qty: 2 }], by: 'K' });
  assert.deepEqual(doc.orders[KEY].items, { 'M-033': 2 });
  const { moved } = applyOrders(doc, [{ channel: 'shopify', id: '#12349', stage: 'shipping', lines: [{ sku: 'OMC-180-001', qty: 1 }] }]);
  assert.deepEqual(moved, [], 'the unchanged order must not move the shelf again');
});

test('the proposal also names the replacement, unless the resend already left', () => {
  assert.deepEqual(resendSwap(base(), original, resend()).take.map((r) => [r.code, r.qty]), [['M-037', 1]]);
  const counted = base();
  counted.orders['manual|RS-1'] = { at: 1, rev: 1, items: { 'M-037': 1 } };
  assert.deepEqual(resendSwap(counted, original, resend()).take, []);
});

test('a confirmed replacement leaves once: the picklist finds the resend already counted', () => {
  const order = resend();
  const input = { key: KEY, resendId: 'RS-1', back: [{ code: 'M-037', qty: 1 }], out: [{ code: 'M-033', qty: 2 }], take: [{ code: 'M-037', qty: 3 }], order, by: 'K' };
  const { doc, records } = swapGoods(base(), input);
  assert.deepEqual(quantities(doc), { 'M-037': 18, 'M-033': 3 });
  assert.deepEqual(records.map((r) => [r.kind, r.delta]), [['in', 1], ['out', -2], ['order', -3]]);
  assert.deepEqual(verifyWarehouse(doc), []);
  assert.deepEqual(doc.orders['manual|RS-1'].items, { 'M-037': 3 }, 'a later cancel offers the confirmed number');
  assert.equal(doc.picks.at(-1).orders[0].key, 'manual|RS-1');
  const { moved } = applyOrders(doc, [{ ...order, labelled: true }], { admit: () => true });
  assert.deepEqual(moved, [], 'the picklist must not take the replacement again');
});

test('a replacement set to zero stays out of the picklist too, and skipping leaves it to the picklist', () => {
  const order = resend();
  const zero = swapGoods(base(), { key: KEY, resendId: 'RS-1', back: [{ code: 'M-037', qty: 1 }], out: [], take: [{ code: 'M-037', qty: 0 }], order, by: 'K' }).doc;
  assert.deepEqual(applyOrders(zero, [order], { admit: () => true }).moved, []);
  const { moved } = applyOrders(base(), [order], { admit: () => true });
  assert.deepEqual(moved.map((m) => [m.code, m.delta]), [['M-037', -1]]);
});

test('a picklist that got there first keeps the replacement from leaving twice', () => {
  const order = resend();
  const picked = applyOrders(base(), [order], { admit: () => true }).doc;
  const { doc, records } = swapGoods(picked, { key: KEY, resendId: 'RS-1', back: [{ code: 'M-037', qty: 1 }], out: [], take: [{ code: 'M-037', qty: 1 }], order, by: 'K' });
  assert.deepEqual(records.map((r) => r.kind), ['in']);
  assert.deepEqual(quantities(doc), { 'M-037': 20, 'M-033': 5 });
  assert.deepEqual(verifyWarehouse(doc), []);
});

test('saving a resend lands on the offer, and the page opens it with the numbers editable', () => {
  const form = new URLSearchParams({ back: '?view=jurnal&add=1' });
  const to = afterWrite({ view: 'orders', message: 'ok', back: '?view=orders&swap=RS-1' }, form);
  assert.equal(new URL(to, 'http://x').searchParams.get('swap'), 'RS-1');

  const render = (swap) => renderDashboard({
    orders: [], summary: summarize([]), errors: {}, shopeeShop: null, generatedAt: Date.now(),
    range: { preset: '7d', label: '7 hari', from: '2026-11-01', to: '2026-11-05' }, truncated: [], maxPerPlatform: 800,
    user: { role: 'owner', email: 'a@b.c', name: 'A' }, csrf: 'c', swap,
  });
  const page = render({ ...resendSwap(base(), original, resend()), resendId: 'RS-1', orderId: '#12349' });
  assert.match(page, /id="swapdlg"/);
  assert.match(page, /name="bqty"[^>]*value="1"/);
  assert.match(page, /name="oqty"[^>]*value="2"/);
  assert.match(page, /name="tqty"[^>]*value="1"/);
  assert.match(page, /data-sw-res="M-037" data-now="20"/);
  assert.match(page, /data-sw-res="M-033"[^]*?<b data-sw-after>3<\/b>/, 'the outcome shows the shelf after the swap');
  assert.match(page, /name="action" value="wh_swap"/);
  assert.doesNotMatch(render(null), /<dialog class="od sw"/);
});
