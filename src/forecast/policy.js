/**
 * Turning a forecast into a decision.
 *
 * A number of units per fortnight is not actionable; "you have 11 days of cover and the
 * jars take 21 days to arrive, order 240" is. Everything here is arithmetic on the
 * forecast and its interval - no new modelling, no new uncertainty introduced.
 *
 * The safety stock comes from the interval the backtest measured, not from a textbook
 * z-score on an assumed normal distribution. If the p90 of two weeks' demand is 180 and
 * the p50 is 120, then holding 60 above the median is what a 90% service level costs -
 * measured on this shop's own errors.
 */

export const DEFAULT_POLICY = {
  leadTimeDays: 21,
  reviewDays: 7,
  serviceLevel: 0.9,
};

/** Scale a horizon forecast to an arbitrary number of days. Demand is treated as flat within a horizon. */
const perDay = (forecast) => (forecast && forecast.horizon ? forecast.p50 / forecast.horizon : 0);
const spreadPerDay = (forecast) => (forecast && forecast.horizon ? (forecast.p90 - forecast.p50) / forecast.horizon : 0);

/**
 * @param {{forecasts: object, onHand: number, onOrder?: number, policy?: object}} input
 *   `forecasts` is keyed by horizon, as produced by forecastWith.
 */
export function stockPolicy({ forecasts, onHand = 0, onOrder = 0, policy = DEFAULT_POLICY }) {
  const { leadTimeDays, reviewDays } = { ...DEFAULT_POLICY, ...policy };

  // Prefer the horizon closest to the lead time: a 21-day lead time is better served by
  // the 30-day model than by the 7-day one, which was tuned for a different question.
  const horizons = Object.keys(forecasts).map(Number).filter((h) => forecasts[h]).sort((a, b) => a - b);
  if (horizons.length === 0) return null;
  const pick = (days) => forecasts[horizons.reduce((best, h) => (Math.abs(h - days) < Math.abs(best - days) ? h : best), horizons[0])];

  const leadForecast = pick(leadTimeDays);
  const daily = perDay(leadForecast);
  const dailySpread = spreadPerDay(leadForecast);

  const leadDemand = Math.round(daily * leadTimeDays);
  const safety = Math.round(dailySpread * leadTimeDays);
  const reorderPoint = leadDemand + safety;
  const available = onHand + onOrder;

  // Days until the median forecast eats the stock on hand. Infinite when nothing sells.
  const daysOfCover = daily > 0 ? Math.floor(onHand / daily) : null;
  const stockoutOn = (days) => (days === null ? null
    : new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10));
  // The pessimistic case: demand at the top of the interval.
  const fastDaily = daily + dailySpread;
  const daysOfCoverFast = fastDaily > 0 ? Math.floor(onHand / fastDaily) : null;

  const reorderQty = Math.max(0, reorderPoint + Math.round(daily * reviewDays) - available);

  return {
    leadTimeDays,
    reviewDays,
    dailyRate: Number(daily.toFixed(2)),
    leadDemand,
    safetyStock: safety,
    reorderPoint,
    onHand,
    onOrder,
    daysOfCover,
    daysOfCoverFast,
    stockoutDate: stockoutOn(daysOfCover),
    stockoutDateFast: stockoutOn(daysOfCoverFast),
    reorderQty,
    // The one thing a person needs to see first.
    urgency: urgencyOf({ daysOfCover, daysOfCoverFast, leadTimeDays, onHand, daily }),
  };
}

/**
 * How worried to be, in the only terms that matter: will it run out before a new batch
 * could possibly arrive?
 */
export function urgencyOf({ daysOfCover, daysOfCoverFast, leadTimeDays, onHand, daily }) {
  if (daily <= 0) return 'idle';          // nothing is selling; stock is not at risk
  if (onHand <= 0) return 'stockout';     // already out
  if (daysOfCover !== null && daysOfCover < leadTimeDays) return 'critical'; // will run out before a reorder lands
  if (daysOfCoverFast !== null && daysOfCoverFast < leadTimeDays) return 'watch'; // would, if demand runs high
  return 'ok';
}

export const URGENCY_ORDER = ['stockout', 'critical', 'watch', 'ok', 'idle'];
