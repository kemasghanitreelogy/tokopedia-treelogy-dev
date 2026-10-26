import test from 'node:test';
import assert from 'node:assert/strict';
import { openWarehouse, emptyWarehouse, OPENING_AT } from '../src/warehouse.js';
import { renderWarehouse } from '../src/pages/warehouse.js';
import { loadWarehouse } from '../src/warehouse-run.js';

/**
 * Barang masuk: a supplier delivery recorded from the Stok tab, several items at once.
 * Runs against the test store only (NODE_TEST_CONTEXT always wins over STATE_BACKEND).
 */

const { handleWrite } = await import('../api/dashboard.js');
const owner = { id: 'owner', email: 'o@x', name: 'O', role: 'owner', status: 'active' };
const form = (pairs) => { const f = new URLSearchParams(); for (const [k, v] of pairs) f.append(k, v); return f; };

test('the Stok tab offers a Tambah stok button with a delivery form', () => {
  const warehouse = openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 60) * 1000 });
  const html = renderWarehouse({ warehouse, csrf: 'c', user: owner, range: { preset: '7d' }, errors: {}, generatedAt: Date.now() });
  assert.match(html, /data-open-receive[^>]*>.*Tambah stok/s);
  assert.match(html, /name="action" value="wh_receive"/);
  assert.match(html, /name="token" value="[a-f0-9-]{36}"/);
});

test('a delivery posted from the form adds to the shelf once, and a resubmit adds nothing', async () => {
  const before = await loadWarehouse();
  const token = 'aaaaaaaa-bbbb-cccc-dddd-000000000001';
  const pairs = [['action', 'wh_receive'], ['token', token], ['note', 'PO-9'], ['code', 'M-037'], ['qty', '10'], ['code', 'M-091'], ['qty', '4'], ['code', ''], ['qty', '']];
  const out = await handleWrite(form(pairs), '127.0.0.1', owner, 'csrf');
  assert.match(out.message ?? JSON.stringify(out), /M-037 \+10/);
  const after = await loadWarehouse();
  assert.equal(after.items['M-037'].qty, before.items['M-037'].qty + 10);
  assert.equal(after.items['M-091'].qty, before.items['M-091'].qty + 4);
  await handleWrite(form(pairs), '127.0.0.1', owner, 'csrf');
  assert.equal((await loadWarehouse()).items['M-037'].qty, before.items['M-037'].qty + 10);
});

test('a delivery with a bad line is refused and moves nothing', async () => {
  const before = await loadWarehouse();
  const pairs = [['action', 'wh_receive'], ['token', 'aaaaaaaa-bbbb-cccc-dddd-000000000002'], ['code', 'M-037'], ['qty', '5'], ['code', 'M-038'], ['qty', '0']];
  await assert.rejects(() => handleWrite(form(pairs), '127.0.0.1', owner, 'csrf'), /bilangan bulat/);
  assert.equal((await loadWarehouse()).items['M-037'].qty, before.items['M-037'].qty);
});

test('a refund row sits under the strip with both answers, and only asks people who may write', async () => {
  const { holdRefund, applyOrders } = await import('../src/warehouse.js');
  let warehouse = openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 60) * 1000 });
  const placed = { id: 'X1', channel: 'shopee', stage: 'shipping', createdAt: OPENING_AT + 600, buyer: 'Gree', lines: [{ sku: 'OMO-30-001', qty: 2 }] };
  ({ doc: warehouse } = applyOrders(warehouse, [placed], { admit: true }));
  warehouse = { ...warehouse, ...holdRefund(warehouse, 'shopee|X1', { at: OPENING_AT + 900, reason: 'refund', label: 'shopee X1' }) };
  const render = (user) => renderWarehouse({ warehouse, csrf: 'c', user, range: { preset: '7d' }, errors: {}, generatedAt: Date.now() });
  const html = render(owner);
  assert.ok(html.indexOf('class="rf"') > html.indexOf('class="strip"'), 'under the strip');
  assert.match(html, /<span class="rf__k">Refund<\/span><span class="mono">shopee X1<\/span><span class="dim">Gree<\/span>/);
  assert.match(html, /<b class="mono">2×<\/b> Organic Moringa Oil 30 mL/);
  assert.match(html, /name="decision" value="back"/);
  assert.match(html, /name="decision" value="gone"/);
  const factory = render({ id: 'f', email: 'f@x', name: 'F', role: 'factory', status: 'active' });
  assert.match(factory, /class="rf__row"/);
  assert.doesNotMatch(factory, /name="decision"/);
  assert.doesNotMatch(factory, /Gree/, 'no buyer for a role that never sees orders');
});

test('answering a refund row puts the goods back once, and the factory cannot answer', async () => {
  const { holdRefund, applyOrders } = await import('../src/warehouse.js');
  const { updateDoc } = await import('../src/store/index.js');
  const { WAREHOUSE_DOC } = await import('../src/warehouse.js');
  await updateDoc(WAREHOUSE_DOC, (current) => {
    let doc = openWarehouse(current ?? emptyWarehouse(), { now: (OPENING_AT + 60) * 1000 });
    ({ doc } = applyOrders(doc, [{ id: 'R9', channel: 'shopee', stage: 'shipping', createdAt: OPENING_AT + 600, lines: [{ sku: 'OMO-60-001', qty: 1 }] }], { admit: true }));
    return { ...doc, ...holdRefund(doc, 'shopee|R9', { at: OPENING_AT + 900, reason: 'cancelled', label: 'shopee R9' }) };
  }, emptyWarehouse());
  const before = (await loadWarehouse()).items['M-039'].qty;
  const answer = (user, decision, token) => handleWrite(form([['action', 'wh_refund'], ['key', 'shopee|R9'], ['decision', decision], ['token', token]]), '127.0.0.1', user, 'csrf');
  await assert.rejects(() => answer({ id: 'f', email: 'f@x', name: 'F', role: 'factory', status: 'active' }, 'back', 'aaaaaaaaaaaaaaaa-1'), /hanya bisa melihat/);
  const out = await answer(owner, 'back', 'aaaaaaaaaaaaaaaa-2');
  assert.match(out.message, /kembali ke rak/);
  assert.equal((await loadWarehouse()).items['M-039'].qty, before + 1);
  await assert.rejects(() => answer(owner, 'gone', 'aaaaaaaaaaaaaaaa-3'), /sudah diputuskan/);
  assert.equal((await loadWarehouse()).items['M-039'].qty, before + 1);
});
