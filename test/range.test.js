import test from 'node:test';
import assert from 'node:assert/strict';
import { wibDayStart, wibDate, resolveRange, chunkRange, MAX_SPAN_DAYS } from '../src/range.js';

const DAY = 24 * 3600;
// 2026-09-08 10:00 WIB
const NOW = Date.UTC(2026, 8, 8, 3, 0, 0);

test('a WIB calendar date starts 7 hours before UTC midnight', () => {
  assert.equal(wibDayStart('2026-09-08'), Date.UTC(2026, 8, 8) / 1000 - 7 * 3600);
  assert.equal(wibDate(wibDayStart('2026-09-08')), '2026-09-08');
});

test('an instant just before WIB midnight still belongs to the previous day', () => {
  const start = wibDayStart('2026-09-08');
  assert.equal(wibDate(start - 1), '2026-09-07');
  assert.equal(wibDate(start), '2026-09-08');
});

test('impossible dates are rejected rather than rolling over', () => {
  assert.equal(wibDayStart('2026-02-31'), null);
  assert.equal(wibDayStart('2026-13-01'), null);
  assert.equal(wibDayStart('08-09-2026'), null);
  assert.equal(wibDayStart('not-a-date'), null);
});

test('"today" starts at WIB midnight, not 24 hours ago', () => {
  const r = resolveRange({ preset: 'today', now: NOW });
  assert.equal(r.since, wibDayStart('2026-09-08'));
  assert.equal(r.until, Math.floor(NOW / 1000));
  assert.equal(r.label, 'Hari ini');
});

test('day presets are rolling windows ending now', () => {
  const r = resolveRange({ preset: '30d', now: NOW });
  assert.equal(r.until - r.since, 30 * DAY);
});

test('an unknown preset falls back instead of throwing', () => {
  assert.equal(resolveRange({ preset: 'sejak-kemarin', now: NOW }).preset, '7d');
  assert.equal(resolveRange({ now: NOW }).preset, '7d');
});

test('a custom range covers whole WIB days, inclusive of the end date', () => {
  const r = resolveRange({ from: '2026-09-01', to: '2026-09-03', now: NOW });
  assert.equal(r.since, wibDayStart('2026-09-01'));
  assert.equal(r.until, wibDayStart('2026-09-03') + DAY - 1);
  assert.equal(r.from, '2026-09-01');
  assert.equal(r.to, '2026-09-03');
});

test('a reversed range is tolerated, not rejected', () => {
  const forward = resolveRange({ from: '2026-09-01', to: '2026-09-03', now: NOW });
  const reversed = resolveRange({ from: '2026-09-03', to: '2026-09-01', now: NOW });
  assert.equal(reversed.since, forward.since);
  assert.equal(reversed.until, forward.until);
});

test('a range ending in the future is trimmed to now', () => {
  const r = resolveRange({ from: '2026-09-08', to: '2026-12-31', now: NOW });
  assert.equal(r.until, Math.floor(NOW / 1000));
});

test('an over-long range is clamped instead of fetching forever', () => {
  const r = resolveRange({ from: '2020-01-01', to: '2026-09-08', now: NOW });
  assert.equal(r.clamped, true);
  assert.ok(r.until - r.since <= MAX_SPAN_DAYS * DAY);
});

test('a custom range with only one endpoint falls back to a preset', () => {
  assert.equal(resolveRange({ from: '2026-09-01', now: NOW }).preset, '7d');
});

test('chunking never emits a window wider than the platform limit', () => {
  const until = Math.floor(NOW / 1000);
  const since = until - 40 * DAY;
  const chunks = chunkRange(since, until, 15);
  for (const c of chunks) assert.ok(c.to - c.from < 15 * DAY, `${c.to - c.from}s`);
  assert.equal(chunks[0].to, until);
  assert.equal(chunks[chunks.length - 1].from, since);
});

test('chunks tile the whole range without gaps or overlap', () => {
  const until = Math.floor(NOW / 1000);
  const since = until - 40 * DAY;
  const chunks = chunkRange(since, until, 15);
  const ordered = [...chunks].sort((a, b) => a.from - b.from);
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(ordered[i].from, ordered[i - 1].to + 1);
  }
});

test('a range shorter than the limit stays a single chunk', () => {
  const until = Math.floor(NOW / 1000);
  assert.equal(chunkRange(until - 3 * DAY, until, 15).length, 1);
});
