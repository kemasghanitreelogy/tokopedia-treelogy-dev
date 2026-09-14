import { PRODUCTS, isBundle, findProduct } from '../master.js';
import { readDoc, writeDoc } from '../store/index.js';
import { loadAllOrders, buildSeries } from './series.js';
import { HORIZONS, selectModel, forecastWith } from './backtest.js';
import { stockPolicy, DEFAULT_POLICY, URGENCY_ORDER } from './policy.js';

/**
 * The whole forecast, from stored history to a decision per SKU.
 *
 * Deliberately not a web request: it reads every order ever recorded, backtests six
 * models at three horizons for every component, and writes one document the dashboard
 * reads. On a serverless function that would not fit in the time limit; as a nightly job
 * it takes seconds and nobody waits for it.
 *
 * A SKU with too little history is reported as such rather than given a number. A
 * forecast nobody can check is worse than an honest gap, because someone will act on it.
 */

export const FORECAST_PATHNAME = 'forecast/latest.json';
export const MIN_HISTORY_DAYS = 42; // six weeks: enough for the weekly seasonality to exist

export const loadForecast = () => readDoc(FORECAST_PATHNAME);

/**
 * Stock on hand per component SKU.
 *
 * The ledger is the intended master. Where it has nothing, the live channel catalogues
 * stand in, and disagreement between channels is resolved downwards - the same rule the
 * stock sync uses, because over-stating stock hides a stockout and under-stating it only
 * causes an early reorder.
 */
export function onHandFrom({ ledger = null, catalog = null }) {
  const out = new Map();
  const source = new Map();

  for (const [sku, entry] of Object.entries(ledger?.skus ?? {})) {
    if (Number.isFinite(Number(entry?.qty))) { out.set(sku, Number(entry.qty)); source.set(sku, 'ledger'); }
  }
  for (const row of catalog?.skus ?? []) {
    if (out.has(row.sku)) continue;
    const quantities = ['tiktok', 'shopee', 'shopify'].map((c) => row[c]?.qty).filter((q) => Number.isFinite(q));
    if (quantities.length === 0) continue;
    out.set(row.sku, Math.min(...quantities));
    source.set(row.sku, `katalog:${quantities.length} kanal`);
  }
  return { onHand: out, source };
}

/**
 * @param {{orders?: array, ledger?: object, catalog?: object, policy?: object, now?: number}} input
 */
export async function buildForecast({ orders = null, ledger = null, catalog = null, policy = DEFAULT_POLICY, now = Date.now() } = {}) {
  const loaded = orders ? { orders, perChannel: null } : await loadAllOrders();
  const { series, meta } = buildSeries(loaded.orders, { until: Math.floor(now / 1000) });
  const { onHand, source } = onHandFrom({ ledger, catalog });

  // Every component we could make, plus anything that has actually sold - a SKU missing
  // from the master still needs to be visible, not silently dropped.
  const components = new Set([
    ...PRODUCTS.filter((p) => !isBundle(p)).map((p) => p.sku),
    ...series.keys(),
  ]);

  const rows = [];
  for (const sku of components) {
    const entry = series.get(sku);
    const values = entry?.values ?? [];
    const product = findProduct(sku);
    const name = product ? (product.variant ? `${product.name} - ${product.variant}` : product.name) : sku;
    const stock = onHand.get(sku) ?? null;

    const base = {
      sku,
      name,
      known: Boolean(product),
      historyDays: values.length,
      sold90: values.slice(-90).reduce((a, b) => a + b, 0),
      sold30: values.slice(-30).reduce((a, b) => a + b, 0),
      onHand: stock,
      onHandSource: source.get(sku) ?? null,
    };

    if (values.length < MIN_HISTORY_DAYS) {
      rows.push({ ...base, status: 'belum cukup data', forecasts: {}, accuracy: {}, stock: null, urgency: 'idle' });
      continue;
    }

    const forecasts = {};
    const accuracy = {};
    for (const horizon of HORIZONS) {
      const selection = selectModel(values, horizon);
      if (!selection) continue;
      accuracy[horizon] = selection;
      forecasts[horizon] = forecastWith(values, selection);
    }

    if (Object.keys(forecasts).length === 0) {
      rows.push({ ...base, status: 'belum cukup data', forecasts: {}, accuracy: {}, stock: null, urgency: 'idle' });
      continue;
    }

    const stockPlan = stock === null ? null : stockPolicy({ forecasts, onHand: stock, policy });
    rows.push({
      ...base,
      status: 'ok',
      forecasts,
      accuracy,
      stock: stockPlan,
      urgency: stockPlan?.urgency ?? 'idle',
      // The weekly shape, for the sparkline. Twelve weeks is one screen's worth.
      weekly: weeklyTotals(values).slice(-12),
    });
  }

  rows.sort((a, b) => {
    const byUrgency = URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency);
    return byUrgency !== 0 ? byUrgency : b.sold90 - a.sold90;
  });

  return {
    version: 1,
    generated_at: new Date(now).toISOString(),
    policy: { ...DEFAULT_POLICY, ...policy },
    history: {
      from: meta.from,
      to: meta.to,
      orders: meta.orders,
      excluded: meta.excluded,
      channels: loaded.perChannel,
      unknownSkus: meta.unknownSkus.slice(0, 10),
    },
    counts: Object.fromEntries(URGENCY_ORDER.map((u) => [u, rows.filter((r) => r.urgency === u).length])),
    rows,
  };
}

/** Sum each calendar week (7-day blocks from the end), oldest first. */
export function weeklyTotals(values) {
  const weeks = [];
  for (let end = values.length; end > 0; end -= 7) {
    weeks.unshift(values.slice(Math.max(0, end - 7), end).reduce((a, b) => a + b, 0));
  }
  return weeks;
}

export async function runForecast(options = {}) {
  const forecast = await buildForecast(options);
  await writeDoc(FORECAST_PATHNAME, forecast);
  return forecast;
}
