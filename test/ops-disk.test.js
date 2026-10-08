import test from 'node:test';
import assert from 'node:assert/strict';
import { diskAlert, diskUsage } from '../src/ops/disk.js';

const GB = 1024 ** 3;

test('nothing is said below 80%, a warning from 80%, an alarm from 95%', () => {
  const at = new Date('2026-10-08T10:20:00Z');
  assert.equal(diskAlert({ percent: 79.9, free: 8 * GB, total: 38 * GB }, at), null);
  const warn = diskAlert({ percent: 81.2, free: 7 * GB, total: 38 * GB }, at);
  assert.match(warn.html, /terisi 81,2%/);
  assert.match(warn.html, /Sisa 7,0 GB dari 38,0 GB/);
  assert.equal(warn.critical, false);
  const crit = diskAlert({ percent: 99.9, free: 0.01 * GB, total: 38 * GB }, at);
  assert.equal(crit.critical, true);
  assert.match(crit.html, /Redis/);
});

test('a warning repeats every six hours, an alarm every hour', () => {
  const k = (iso, percent) => diskAlert({ percent, free: GB, total: 38 * GB }, new Date(iso)).key;
  assert.equal(k('2026-10-08T07:00:00Z', 85), k('2026-10-08T11:59:00Z', 85));
  assert.notEqual(k('2026-10-08T11:59:00Z', 85), k('2026-10-08T12:00:00Z', 85));
  assert.notEqual(k('2026-10-08T10:59:00Z', 97), k('2026-10-08T11:00:00Z', 97));
});

test('the reading is real numbers from the filesystem', async () => {
  const u = await diskUsage('/');
  assert.ok(u.total > 0 && u.free >= 0 && u.percent >= 0 && u.percent <= 100);
});
