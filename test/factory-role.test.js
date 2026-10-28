import test from 'node:test';
import assert from 'node:assert/strict';
import { can, canView, homeView, ASSIGNABLE_ROLES, ROLES } from '../src/users.js';
import { openWarehouse, emptyWarehouse, OPENING_AT } from '../src/warehouse.js';
import { renderWarehouse } from '../src/pages/warehouse.js';
import { renderForecast } from '../src/dashboard-page.js';

/**
 * The factory role (26 Oct 2026): sees the warehouse stock and the forecast, nothing
 * else - no order, no buyer, no label - and changes nothing.
 */

const { handleWrite } = await import('../api/dashboard.js');
const factory = { id: 'f1', email: 'factory@treelogy.com', name: 'Factory', role: 'factory', status: 'active' };
const operator = { ...factory, id: 'o1', role: 'operator' };
const form = (pairs) => { const f = new URLSearchParams(); for (const [k, v] of pairs) f.append(k, v); return f; };
const page = (user) => renderWarehouse({
  warehouse: openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 60) * 1000 }),
  csrf: 'c', user, range: { preset: '7d' }, errors: {}, generatedAt: Date.now(),
});

test('an admin can hand out the factory role', () => {
  assert.ok(ASSIGNABLE_ROLES.includes('factory'));
  assert.equal(ROLES.factory.label, 'Factory');
});

test('the factory opens only the stock and forecast views, and lands on stock', () => {
  for (const view of ['stock', 'forecast']) assert.ok(canView(factory, view), view);
  for (const view of ['orders', 'process', 'picklist', 'labels', 'products', 'reviews', 'users', 'jurnal', 'activity', 'express']) {
    assert.equal(canView(factory, view), false, view);
  }
  assert.equal(homeView(factory), 'stock');
  assert.ok(canView(operator, 'orders'));
  assert.equal(homeView(operator), 'orders');
});

test('the factory sees no orders and may not write or manage users', () => {
  assert.equal(can(factory, 'orders'), false);
  assert.equal(can(factory, 'write'), false);
  assert.equal(can(factory, 'users'), false);
  assert.ok(can(operator, 'orders'));
});

test('a disabled factory account opens nothing', () => {
  assert.equal(canView({ ...factory, status: 'disabled' }, 'stock'), false);
});

for (const [label, pairs] of [
  ['opname', [['action', 'wh_move'], ['code', 'M-036'], ['kind', 'count'], ['qty', '1']]],
  ['barang masuk', [['action', 'wh_receive'], ['code', 'M-036'], ['qty', '5']]],
  ['isi produk', [['action', 'wh_recipe'], ['sku', 'OMC-90-001'], ['remove', '1']]],
  ['stok induk', [['action', 'ledger'], ['sku', 'OMC-90-001'], ['qty', '0']]],
  ['undang pengguna', [['action', 'user_invite'], ['email', 'x@y.z'], ['role', 'admin']]],
]) {
  test(`the factory's ${label} is refused before anything is read`, async () => {
    await assert.rejects(() => handleWrite(form(pairs), '127.0.0.1', factory, 'csrf'), /hanya bisa melihat|hanya admin/);
  });
}

test('the menu shows the factory only Stok and Prakiraan, with no order bell or log', () => {
  const html = page(factory);
  const tabs = [...html.matchAll(/class="viewtab[^"]*" href="\?view=(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['stock', 'forecast']);
  assert.doesNotMatch(html, /href="\?view=express"/);
  assert.doesNotMatch(html, /view=activity/);
  assert.doesNotMatch(html, /new EventSource/);
  assert.match(html, /class="brandline" href="\?view=stock"/);
});

test('the stock page carries no form for the factory, and keeps them for an operator', () => {
  const html = page(factory);
  assert.doesNotMatch(html, /<form[^>]*method="post"/);
  assert.doesNotMatch(html, /Tambah stok|Atur isi produk/);
  assert.match(html, /Riwayat gerakan/);
  assert.match(page(operator), /name="action" value="wh_move"/);
});

test('the forecast page renders for the factory', () => {
  const html = renderForecast({ forecast: null, range: { preset: '7d', label: '7 hari' }, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf: 'c', flash: null, user: factory });
  assert.match(html, /class="viewtab is-on" href="\?view=forecast/);
});

test('the stock tab counts the refunds still waiting for the warehouse, and shows nothing at zero', () => {
  const tab = (html) => html.match(/<a class="viewtab[^"]*" href="\?view=stock[^"]*">[\s\S]*?<\/a>/)[0];
  assert.match(tab(page({ ...operator, badges: { stock: 3 } })), /<span class="viewtab__n"[^>]*>3<\/span>/);
  assert.match(tab(page({ ...factory, badges: { stock: 120 } })), />99\+<\/span>/);
  assert.doesNotMatch(tab(page(operator)), /viewtab__n/);
});
