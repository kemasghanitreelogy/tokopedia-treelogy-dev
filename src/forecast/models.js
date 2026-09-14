/**
 * Forecasting models, all pure, all deterministic, no dependencies.
 *
 * Each takes a series of non-negative numbers (one per period, oldest first) and a
 * horizon, and returns point forecasts for the next `h` periods. They are deliberately
 * simple: at the level of one SKU in one small business, the M5 competition's lesson holds
 * - a well-chosen simple model, or a median of several, beats a clever one, and can be
 * explained to the person who has to act on it.
 *
 * Every model is checked against the seasonal naive; one that cannot beat "same as last
 * week" has no business in the ensemble.
 */

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
const clampNonNeg = (x) => (x < 0 ? 0 : x);

/** Repeat the last full season. The bar every other model has to clear. */
export function seasonalNaive(series, h, season = 7) {
  const n = series.length;
  if (n === 0) return Array(h).fill(0);
  if (n < season) return Array(h).fill(series[n - 1]);
  return Array.from({ length: h }, (_, i) => series[n - season + (i % season)]);
}

/** Mean of the last `window` periods. Honest, dull, hard to beat on noisy small series. */
export function movingAverage(series, h, window = 28) {
  const tail = series.slice(-window);
  return Array(h).fill(mean(tail));
}

/** Simple exponential smoothing: a level that forgets slowly. */
export function ses(series, h, alpha = 0.3) {
  if (!series.length) return Array(h).fill(0);
  let level = series[0];
  for (let t = 1; t < series.length; t++) level = alpha * series[t] + (1 - alpha) * level;
  return Array(h).fill(clampNonNeg(level));
}

/** Holt: level and a damped trend, so a recent surge does not extrapolate to the moon. */
export function holt(series, h, alpha = 0.3, beta = 0.05, phi = 0.9) {
  if (series.length < 2) return ses(series, h, alpha);
  let level = series[0];
  let trend = series[1] - series[0];
  for (let t = 1; t < series.length; t++) {
    const prevLevel = level;
    level = alpha * series[t] + (1 - alpha) * (prevLevel + phi * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }
  const out = [];
  let damp = 0;
  for (let i = 1; i <= h; i++) {
    damp += phi ** i;
    out.push(clampNonNeg(level + damp * trend));
  }
  return out;
}

/**
 * Holt-Winters, additive weekly seasonality, damped trend.
 * Needs at least two seasons; below that it hands over to Holt.
 */
export function holtWinters(series, h, { season = 7, alpha = 0.25, beta = 0.03, gamma = 0.15, phi = 0.9 } = {}) {
  const n = series.length;
  if (n < 2 * season) return holt(series, h, alpha, beta, phi);

  // Initial seasonals from the first two seasons, level from their mean.
  const seasonal = Array(season).fill(0);
  const firstMean = mean(series.slice(0, season));
  const secondMean = mean(series.slice(season, 2 * season));
  for (let i = 0; i < season; i++) seasonal[i] = (series[i] - firstMean + series[season + i] - secondMean) / 2;
  let level = firstMean;
  let trend = (secondMean - firstMean) / season;

  for (let t = 0; t < n; t++) {
    const s = seasonal[t % season];
    const prevLevel = level;
    level = alpha * (series[t] - s) + (1 - alpha) * (prevLevel + phi * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
    seasonal[t % season] = gamma * (series[t] - level) + (1 - gamma) * s;
  }
  const out = [];
  let damp = 0;
  for (let i = 1; i <= h; i++) {
    damp += phi ** i;
    out.push(clampNonNeg(level + damp * trend + seasonal[(n + i - 1) % season]));
  }
  return out;
}

/**
 * TSB (Teunter-Syntetos-Babai): Croston done right for intermittent demand.
 *
 * Tracks the probability that a period has any demand and the size when it does, and -
 * unlike Croston - updates the probability on zero periods too, so a product that quietly
 * stopped selling forecasts down instead of freezing at its last size.
 */
export function tsb(series, h, alpha = 0.1, beta = 0.1) {
  if (!series.length) return Array(h).fill(0);
  const nonzero = series.filter((x) => x > 0);
  let p = nonzero.length / series.length;
  let z = nonzero.length ? mean(nonzero) : 0;
  for (const x of series) {
    if (x > 0) {
      p = p + beta * (1 - p);
      z = z + alpha * (x - z);
    } else {
      p = p + beta * (0 - p);
    }
  }
  return Array(h).fill(clampNonNeg(p * z));
}

/** How intermittent a series is: share of zero periods. */
export const zeroShare = (series) => (series.length ? series.filter((x) => x === 0).length / series.length : 1);

export const MODELS = {
  snaive: { name: 'Seasonal naive', fn: (s, h) => seasonalNaive(s, h, 7) },
  ma28: { name: 'Rata-rata 28 hari', fn: (s, h) => movingAverage(s, h, 28) },
  ses: { name: 'Exp. smoothing', fn: (s, h) => ses(s, h) },
  holt: { name: 'Holt (tren teredam)', fn: (s, h) => holt(s, h) },
  hw7: { name: 'Holt-Winters mingguan', fn: (s, h) => holtWinters(s, h) },
  tsb: { name: 'TSB (jarang terjual)', fn: (s, h) => tsb(s, h) },
};

/** Median across models, per horizon step. Robust to one model going wrong. */
export function ensemble(forecasts, h) {
  return Array.from({ length: h }, (_, i) => median(forecasts.map((f) => f[i] ?? 0)));
}
