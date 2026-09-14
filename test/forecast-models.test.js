import test from 'node:test';
import assert from 'node:assert/strict';
import { seasonalNaive, movingAverage, ses, holt, holtWinters, tsb, ensemble, median, quantile, zeroShare } from '../src/forecast/models.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('seasonal naive repeats last week, and degrades honestly on short series', () => {
  const week = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(seasonalNaive([...week, ...week], 9), [1, 2, 3, 4, 5, 6, 7, 1, 2]);
  assert.deepEqual(seasonalNaive([4, 5], 3), [5, 5, 5]);
  assert.deepEqual(seasonalNaive([], 2), [0, 0]);
});

test('a flat series is forecast flat by every level model', () => {
  const flat = Array(60).fill(5);
  for (const fn of [movingAverage, ses, holt, holtWinters, tsb]) {
    for (const v of fn(flat, 14)) close(v, 5, 0.05, fn.name);
  }
});

test('Holt follows a steady trend but damps it rather than extrapolating forever', () => {
  const up = Array.from({ length: 60 }, (_, i) => 10 + i); // +1 per day
  const f = holt(up, 30);
  // Damping and smoothing lag the true level a little; the point is the direction and the cap.
  assert.ok(f[0] > 64 && f[0] < 72, `hari pertama ${f[0]}`);
  assert.ok(f[29] < 100, `tren teredam: ${f[29]}`);
  assert.ok(f[29] > f[0], 'tetap naik');
});

test('Holt-Winters recovers a weekly pattern', () => {
  const pattern = [2, 2, 2, 2, 5, 9, 8]; // weekend peaks
  const series = Array.from({ length: 12 * 7 }, (_, i) => pattern[i % 7]);
  const f = holtWinters(series, 7);
  for (let i = 0; i < 7; i++) close(f[i], pattern[i], 0.6, `hari ${i}`);
});

test('TSB forecasts intermittent demand down when it stops, not frozen at the last size', () => {
  const active = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 8 : 0)); // 2/day average
  const f1 = tsb(active, 1)[0];
  close(f1, 2, 0.8, 'rata-rata saat aktif');
  const stopped = [...active, ...Array(40).fill(0)];
  assert.ok(tsb(stopped, 1)[0] < f1 / 4, 'setelah 40 hari nol harus turun jauh');
});

test('no model ever forecasts below zero', () => {
  const crash = [50, 40, 30, 20, 10, 5, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const fn of [ses, holt, holtWinters, tsb, movingAverage]) {
    for (const v of fn(crash, 30)) assert.ok(v >= 0, fn.name);
  }
});

test('the ensemble is a per-step median, so one wild model cannot drag it', () => {
  assert.deepEqual(ensemble([[1, 1], [2, 2], [100, 100]], 2), [2, 2]);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  close(quantile([1, 2, 3, 4, 5], 0.9), 4.6, 1e-9, 'q90');
  assert.equal(zeroShare([0, 0, 1, 0]), 0.75);
});
