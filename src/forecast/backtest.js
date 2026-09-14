import { MODELS, ensemble, quantile, median, zeroShare } from './models.js';

/**
 * Choosing a model by making it prove itself on data it has not seen.
 *
 * Rolling-origin evaluation: stand at a point in the past, forecast forward, compare
 * against what actually happened, step forward, repeat. A model is only allowed to be
 * used if it beat the seasonal naive - "same as last week" - on this shop's own data.
 * Nothing here is chosen because it is sophisticated.
 *
 * The error measure is MASE: the model's absolute error divided by the naive's. Below 1
 * means better than naive; above 1 means worse. It is scale-free, so a SKU selling 200 a
 * week and one selling 2 are comparable, and unlike MAPE it does not break on the zeros
 * that intermittent products are full of.
 *
 * Intervals come from the residuals this backtest produced, not from assuming a normal
 * distribution - demand is not symmetric and a normal interval would promise a coverage
 * it does not have. The coverage actually achieved is measured and reported alongside.
 */

export const HORIZONS = [7, 14, 30];
const MIN_TRAIN_DAYS = 28;
const MIN_ORIGINS = 6;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mae = (errors) => (errors.length ? sum(errors.map(Math.abs)) / errors.length : 0);

/**
 * Origins to evaluate from: evenly spaced, ending far enough back that the longest
 * horizon still has real data to be judged against.
 */
export function originsFor(length, horizon, wanted = 10) {
  const last = length - horizon;
  const first = MIN_TRAIN_DAYS;
  if (last <= first) return [];
  const span = last - first;
  const count = Math.min(wanted, span);
  if (count <= 1) return [last];
  const step = span / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(first + i * step));
}

/**
 * Run one model across every origin for one horizon.
 * @returns {{errors: number[], actuals: number[], predictions: number[]}} per-step results
 */
export function evaluate(series, fn, horizon, origins) {
  const errors = [];
  const actuals = [];
  const predictions = [];
  for (const origin of origins) {
    const train = series.slice(0, origin);
    const truth = series.slice(origin, origin + horizon);
    if (truth.length < horizon) continue;
    let forecast;
    try {
      forecast = fn(train, horizon);
    } catch {
      continue;
    }
    // Judged on the total over the horizon, not day by day: what a buyer needs to know is
    // how much will go in the next two weeks, not which Tuesday it goes.
    const predicted = sum(forecast.slice(0, horizon));
    const actual = sum(truth);
    errors.push(predicted - actual);
    actuals.push(actual);
    predictions.push(predicted);
  }
  return { errors, actuals, predictions };
}

/**
 * Pick the best model for one series at one horizon, and measure how well it does.
 * @returns {object|null} null when there is not enough history to judge anything.
 */
export function selectModel(series, horizon) {
  const origins = originsFor(series.length, horizon);
  if (origins.length < MIN_ORIGINS) return null;

  const naive = evaluate(series, MODELS.snaive.fn, horizon, origins);
  const naiveMae = mae(naive.errors);

  const candidates = [];
  for (const [key, model] of Object.entries(MODELS)) {
    const result = evaluate(series, model.fn, horizon, origins);
    if (result.errors.length < MIN_ORIGINS) continue;
    // A naive that never misses (a dead SKU, all zeros) makes MASE undefined; treat a
    // model that also never misses as equal to it rather than infinitely worse.
    const modelMae = mae(result.errors);
    const mase = naiveMae === 0 ? (modelMae === 0 ? 1 : Infinity) : modelMae / naiveMae;
    candidates.push({ key, name: model.name, mase, mae: modelMae, result });
  }
  if (candidates.length === 0) return null;

  // The ensemble of everything that beat naive, evaluated the same way.
  const beaters = candidates.filter((c) => c.mase <= 1 && c.key !== 'snaive');
  if (beaters.length >= 2) {
    const fns = beaters.map((c) => MODELS[c.key].fn);
    const result = evaluate(series, (train, h) => ensemble(fns.map((f) => f(train, h)), h), horizon, origins);
    const modelMae = mae(result.errors);
    candidates.push({
      key: 'ensemble',
      name: `Ensemble (${beaters.map((b) => b.key).join('+')})`,
      mase: naiveMae === 0 ? 1 : modelMae / naiveMae,
      mae: modelMae,
      result,
      members: beaters.map((b) => b.key),
    });
  }

  candidates.sort((a, b) => a.mase - b.mase);
  const best = candidates[0];

  // Residual quantiles, as a ratio to the prediction where possible, so the interval
  // scales with the size of the forecast instead of being a fixed number of units.
  const ratios = best.result.predictions.map((p, i) => (p > 0 ? best.result.actuals[i] / p : null)).filter((r) => r !== null);
  const lo = ratios.length >= MIN_ORIGINS ? quantile(ratios, 0.1) : 0.5;
  const hi = ratios.length >= MIN_ORIGINS ? quantile(ratios, 0.9) : 1.8;

  const inside = best.result.predictions.filter((p, i) => {
    const a = best.result.actuals[i];
    return a >= p * lo && a <= p * hi;
  }).length;

  return {
    horizon,
    model: best.key,
    modelName: best.name,
    members: best.members ?? null,
    mase: Number(best.mase.toFixed(3)),
    naiveMase: 1,
    beatsNaive: best.mase < 1,
    // Positive means the model runs high - it would have us hold too much stock.
    bias: Number((sum(best.result.errors) / Math.max(1, sum(best.result.actuals))).toFixed(3)),
    origins: origins.length,
    lo: Number(lo.toFixed(3)),
    hi: Number(hi.toFixed(3)),
    coverage80: Number((inside / Math.max(1, best.result.predictions.length)).toFixed(2)),
    zeroShare: Number(zeroShare(series).toFixed(2)),
    medianActual: median(best.result.actuals),
  };
}

/** Forecast one horizon with the model the backtest chose, plus its interval. */
export function forecastWith(series, selection) {
  if (!selection) return null;
  const fn = selection.model === 'ensemble'
    ? (train, h) => ensemble(selection.members.map((k) => MODELS[k].fn(train, h)), h)
    : MODELS[selection.model].fn;
  const total = sum(fn(series, selection.horizon).slice(0, selection.horizon));
  return {
    horizon: selection.horizon,
    p50: Math.round(total),
    p10: Math.round(total * selection.lo),
    p90: Math.round(total * selection.hi),
  };
}
