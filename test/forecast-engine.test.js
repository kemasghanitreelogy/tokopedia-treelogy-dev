import test from 'node:test';
import assert from 'node:assert/strict';
import { explode, buildSeries } from '../src/forecast/series.js';
import { originsFor, evaluate, selectModel, forecastWith, HORIZONS } from '../src/forecast/backtest.js';
import { stockPolicy, urgencyOf } from '../src/forecast/policy.js';
import { onHandFrom, weeklyTotals, buildForecast } from '../src/forecast/engine.js';
import { seasonalNaive } from '../src/forecast/models.js';

test('a bundle is exploded into the things we actually make', () => {
  // MRS-002 is the ritual set plus a 45g powder; forecasting the bundle would say nothing
  // about how many jars of powder to produce.
  assert.deepEqual(explode('MRS-002', 1), { 'MRS-001': 1, 'OMP-45-001': 1 });
  assert.deepEqual(explode('MRS-002', 3), { 'MRS-001': 3, 'OMP-45-001': 3 });
  assert.deepEqual(explode('OMP-45-001', 2), { 'OMP-45-001': 2 });
  // Discovery-Pack is three different components at once.
  assert.deepEqual(explode('Discovery-Pack', 1), { 'OMP-45-001': 1, 'OMO-30-001': 1, 'OMC-90-001': 1 });
  // A channel alias resolves to the master SKU before exploding.
  assert.deepEqual(explode('GFT-POUCH-001', 1), { 'Travel-Pouch': 1 });
  // Something the master has never heard of is kept under its own name, not dropped.
  assert.deepEqual(explode('SKU-ASING', 4), { 'SKU-ASING': 4 });
});

const day = (n) => 1_780_000_000 + n * 86_400;

test('demand is daily, gaps are zeros, and cancelled orders are excluded not zeroed', () => {
  const orders = [
    { at: day(0), stage: 'completed', lines: [{ sku: 'OMP-45-001', qty: 2 }] },
    { at: day(0), stage: 'delivered', lines: [{ sku: 'MRS-002', qty: 1 }] },
    { at: day(2), stage: 'to_ship', lines: [{ sku: 'OMP-45-001', qty: 5 }] },
    { at: day(2), stage: 'cancelled', lines: [{ sku: 'OMP-45-001', qty: 99 }] },
  ];
  const { series, meta } = buildSeries(orders, { until: day(3) });
  const powder = series.get('OMP-45-001');
  assert.deepEqual(powder.values.slice(0, 4), [3, 0, 5, 0], 'hari 0 = 2 lepas + 1 dari bundle');
  assert.equal(series.get('MRS-001').values[0], 1);
  assert.equal(meta.orders, 3);
  assert.equal(meta.excluded, 1, 'yang batal dihitung terpisah, bukan jadi nol');
});

test('a SKU the master does not know is reported, not silently swallowed', () => {
  const { meta } = buildSeries([{ at: day(0), stage: 'completed', lines: [{ sku: 'SKU-HANTU', qty: 7 }] }], { until: day(1) });
  assert.deepEqual(meta.unknownSkus, [{ sku: 'SKU-HANTU', qty: 7 }]);
});

test('origins leave room for the horizon to be judged against real data', () => {
  assert.deepEqual(originsFor(40, 30), [], 'tidak cukup untuk dinilai');
  const origins = originsFor(200, 30);
  assert.ok(origins.length > 5);
  assert.ok(Math.max(...origins) <= 170, 'origin terakhir harus menyisakan 30 hari');
  assert.ok(Math.min(...origins) >= 28, 'harus ada data latih minimal');
});

test('a perfectly repeating series is forecast exactly, and beats nothing', () => {
  const pattern = [3, 3, 3, 3, 6, 9, 6];
  const series = Array.from({ length: 40 * 7 }, (_, i) => pattern[i % 7]);
  const selection = selectModel(series, 7);
  assert.ok(selection, 'harus bisa dinilai');
  assert.ok(selection.mase <= 1.05, `MASE ${selection.mase}`);
  const f = forecastWith(series, selection);
  assert.equal(f.horizon, 7);
  // 33 per week, exactly.
  assert.ok(Math.abs(f.p50 - 33) <= 3, `p50 ${f.p50}`);
  assert.ok(f.p10 <= f.p50 && f.p50 <= f.p90, 'interval harus mengurung p50');
});

test('a model is only reported as beating naive when it measurably does', () => {
  const noise = Array.from({ length: 300 }, (_, i) => (i * 7919 % 11));
  const selection = selectModel(noise, 14);
  assert.ok(selection);
  assert.equal(typeof selection.beatsNaive, 'boolean');
  assert.equal(selection.beatsNaive, selection.mase < 1);
  assert.ok(selection.origins >= 6);
});

test('too little history yields nothing rather than a number nobody can check', () => {
  assert.equal(selectModel([1, 2, 3, 4, 5], 7), null);
  assert.equal(forecastWith([1, 2, 3], null), null);
});

test('the policy answers the question a buyer actually asks', () => {
  // 10/day forecast, 30 on hand, 21-day lead time: it runs out in 3 days, long before a
  // reorder could land.
  const forecasts = { 30: { horizon: 30, p50: 300, p10: 240, p90: 390 } };
  const plan = stockPolicy({ forecasts, onHand: 30, policy: { leadTimeDays: 21, reviewDays: 7 } });
  assert.equal(plan.horizonUsed, 30, 'horizon yang dipakai harus menutupi lead time, bukan sekadar terdekat');
  assert.equal(plan.dailyRate, 10);
  assert.equal(plan.daysOfCover, 3);
  assert.equal(plan.leadDemand, 210);
  assert.equal(plan.safetyStock, 63, 'p90 3/hari di atas p50, dikali 21 hari');
  assert.equal(plan.reorderPoint, 273);
  assert.equal(plan.reorderQty, 273 + 70 - 30);
  assert.equal(plan.urgency, 'critical');
  assert.match(plan.stockoutDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('urgency separates "already out" from "will be out before stock arrives"', () => {
  const base = { leadTimeDays: 21, daily: 10 };
  assert.equal(urgencyOf({ ...base, onHand: 0, daysOfCover: 0, daysOfCoverFast: 0 }), 'stockout');
  assert.equal(urgencyOf({ ...base, onHand: 50, daysOfCover: 5, daysOfCoverFast: 4 }), 'critical');
  assert.equal(urgencyOf({ ...base, onHand: 250, daysOfCover: 25, daysOfCoverFast: 18 }), 'watch');
  assert.equal(urgencyOf({ ...base, onHand: 900, daysOfCover: 90, daysOfCoverFast: 70 }), 'ok');
  // Nothing selling is not a stock risk, however little there is.
  assert.equal(urgencyOf({ leadTimeDays: 21, daily: 0, onHand: 1, daysOfCover: null, daysOfCoverFast: null }), 'idle');
});

test('stock on hand prefers the ledger and resolves channel disagreement downwards', () => {
  const catalog = { skus: [
    { sku: 'OMP-45-001', tiktok: { qty: 80 }, shopee: { qty: 60 }, shopify: { qty: 70 } },
    { sku: 'OMC-90-001', tiktok: { qty: 12 } },
  ] };
  const ledger = { skus: { 'OMP-45-001': { qty: 55 } } };
  const { onHand, source } = onHandFrom({ ledger, catalog });
  assert.equal(onHand.get('OMP-45-001'), 55);
  assert.equal(source.get('OMP-45-001'), 'ledger');
  // Overstating stock hides a stockout; understating only causes an early reorder.
  assert.equal(onHand.get('OMC-90-001'), 12);
});

test('weekly totals group from the end so the newest week is whole', () => {
  assert.deepEqual(weeklyTotals([1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2]), [7, 14]);
  assert.deepEqual(weeklyTotals([5, 5, 5]), [15]);
});

test('the whole engine runs on synthetic history and produces checkable rows', async () => {
  const orders = [];
  for (let d = 0; d < 200; d++) {
    const qty = 4 + (d % 7 === 5 ? 6 : 0);
    orders.push({ at: day(d), stage: 'completed', lines: [{ sku: 'OMP-45-001', qty }] });
  }
  const result = await buildForecast({
    orders,
    ledger: { skus: { 'OMP-45-001': { qty: 100 } } },
    now: day(200) * 1000,
  });
  const row = result.rows.find((r) => r.sku === 'OMP-45-001');
  assert.equal(row.status, 'ok');
  assert.deepEqual(Object.keys(row.forecasts).map(Number).sort((a, b) => a - b), HORIZONS);
  assert.ok(row.accuracy[7].mase > 0, 'setiap ramalan membawa angka akurasinya');
  assert.ok(row.forecasts[7].p10 <= row.forecasts[7].p50);
  assert.equal(row.onHand, 100);
  assert.ok(row.stock.daysOfCover > 0);
  // A component that never sold is present but honest about having no basis.
  const quiet = result.rows.find((r) => r.sku === 'Bamboo-Whisk');
  assert.equal(quiet.status, 'belum cukup data');
  assert.deepEqual(quiet.forecasts, {});
});

test('the policy never decides on a horizon shorter than the lead time', () => {
  const forecasts = {
    7: { horizon: 7, p50: 0, p10: 0, p90: 0 },
    14: { horizon: 14, p50: 14, p10: 7, p90: 28 },
    30: { horizon: 30, p50: 60, p10: 30, p90: 120 },
  };
  // 21-day lead: 14 is closer in absolute terms but does not cover it, so 30 is used -
  // and that is also the number the dashboard shows, so the two cannot disagree.
  assert.equal(stockPolicy({ forecasts, onHand: 100, policy: { leadTimeDays: 21 } }).horizonUsed, 30);
  assert.equal(stockPolicy({ forecasts, onHand: 100, policy: { leadTimeDays: 7 } }).horizonUsed, 7);
  assert.equal(stockPolicy({ forecasts, onHand: 100, policy: { leadTimeDays: 10 } }).horizonUsed, 14);
  // Longer than anything forecast: fall back to the longest rather than refusing.
  assert.equal(stockPolicy({ forecasts, onHand: 100, policy: { leadTimeDays: 90 } }).horizonUsed, 30);
});

test('a manifest merge keeps every channel when two pulls finish at once', async () => {
  const { saveManifest, loadManifest } = await import('../src/history/store.js');
  const { deleteDoc } = await import('../src/store/index.js');
  await deleteDoc('history/manifest.json');
  // Exactly what happened in production: both pulls loaded {}, added their own channel,
  // and the later save erased the earlier channel from the index.
  await Promise.all([
    saveManifest({ version: 1, channels: { shopify: { months: { '2025-02': { orders: 5 } } } } }),
    saveManifest({ version: 1, channels: { tiktok: { months: { '2025-05': { orders: 9 } } } } }),
  ]);
  const manifest = await loadManifest();
  assert.deepEqual(Object.keys(manifest.channels).sort(), ['shopify', 'tiktok']);
  assert.equal(manifest.channels.tiktok.months['2025-05'].orders, 9);
  await deleteDoc('history/manifest.json');
});
