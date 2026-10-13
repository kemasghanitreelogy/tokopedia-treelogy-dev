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
