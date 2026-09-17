import test from 'node:test';
import assert from 'node:assert/strict';
import { recordActivity, readActivity, daysBetween, actorsIn, AUDIT_PREFIX, MENUS, VERBS } from '../src/audit.js';
import { listDocs, deleteDoc, closeStore } from '../src/store/index.js';
import { wibDate } from '../src/range.js';

test.after(async () => { await closeStore(); });
test.beforeEach(async () => {
  for (const d of await listDocs(AUDIT_PREFIX)) await deleteDoc(d.key);
});

const kemas = { id: 'owner', email: 'kemas@treelogy.com', name: 'Kemas' };
const dewi = { id: 'u-dewi', email: 'dewi@treelogy.com', name: 'Dewi' };
const today = () => wibDate(Math.floor(Date.now() / 1000));

test('an action is recorded with its actor, menu, verb and before/after pairs', async () => {
  const stored = await recordActivity({
    actor: kemas, ip: '10.0.0.1', menu: 'products', action: 'ledger', verb: 'edit', target: 'MRS-002',
    summary: 'Mengubah stok ledger MRS-002 dari 74 menjadi 70', changes: [{ field: 'stok MRS-002', from: 74, to: 70 }],
  });
  assert.ok(stored.id);
  assert.equal(stored.status, 'ok');
  const [entry] = await readActivity({ from: today(), to: today() });
  assert.equal(entry.id, stored.id);
  assert.deepEqual(entry.actor, kemas);
  assert.equal(entry.menu, 'products');
  assert.equal(entry.verb, 'edit');
  assert.deepEqual(entry.changes, [{ field: 'stok MRS-002', from: 74, to: 70 }]);
  assert.equal(entry.ip, '10.0.0.1');
});

test('entries are appended, never overwritten, and come back newest first', async () => {
  await Promise.all([
    recordActivity({ actor: kemas, menu: 'stock', action: 'ledger_batch', summary: 'a' }),
    recordActivity({ actor: dewi, menu: 'process', action: 'fulfil', verb: 'send', summary: 'b' }),
    recordActivity({ actor: dewi, menu: 'jurnal', action: 'manual_invoice', verb: 'add', summary: 'c', status: 'failed', error: 'kode dipakai' }),
  ]);
  const all = await readActivity({ from: today(), to: today() });
  assert.equal(all.length, 3);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].at >= all[i].at);

  assert.equal((await readActivity({ from: today(), to: today(), actor: 'u-dewi' })).length, 2);
  assert.equal((await readActivity({ from: today(), to: today(), menu: 'jurnal' })).length, 1);
  assert.equal((await readActivity({ from: today(), to: today(), status: 'failed' }))[0].error, 'kode dipakai');
  assert.equal((await readActivity({ from: today(), to: today(), q: 'DEWI' })).length, 2);
  assert.deepEqual(actorsIn(all).map((a) => a.id), ['u-dewi', 'owner']);
});

test('a failed action is part of the record, and unknown menus or verbs fall back rather than throw', async () => {
  const stored = await recordActivity({ actor: kemas, menu: 'nope', action: 'x', verb: 'explode', summary: 's', status: 'failed', error: 'e' });
  assert.equal(stored.menu, 'orders');
  assert.equal(stored.verb, 'edit');
  assert.equal(stored.status, 'failed');
});

test('long values are clipped and the change list is capped, so one batch cannot bloat a day', async () => {
  const changes = Array.from({ length: 400 }, (_, i) => ({ field: `SKU-${i}`, from: i, to: i + 1 }));
  const stored = await recordActivity({ actor: kemas, menu: 'stock', action: 'ledger_batch', summary: 'x'.repeat(1000), changes });
  assert.equal(stored.changes.length, 250);
  assert.equal(stored.changesTruncated, 400);
  assert.ok(stored.summary.length < 320);
});

test('a day range enumerates WIB days newest first and is capped', () => {
  assert.deepEqual(daysBetween('2026-09-15', '2026-09-17'), ['2026-09-17', '2026-09-16', '2026-09-15']);
  assert.deepEqual(daysBetween('2026-09-17', '2026-09-15'), []);
  assert.equal(daysBetween('2020-01-01', '2026-09-17').length, 92);
});

test('every verb has a label and every dashboard view has a menu name', () => {
  for (const v of Object.values(VERBS)) assert.ok(v.label && v.tone);
  for (const m of ['orders', 'process', 'stock', 'products', 'jurnal', 'labels', 'users', 'auth']) assert.ok(MENUS[m]);
});
