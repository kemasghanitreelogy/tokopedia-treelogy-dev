import { businessDate, businessDayStart, offsetSeconds } from './clock.js';
/**
 * Date ranges in the seller's own timezone.
 *
 * Every order timestamp from both platforms is epoch seconds in UTC, but a seller asking
 * for "hari ini" means today in Jakarta. WIB is a fixed UTC+7 with no daylight saving, so
 * the conversion is a constant offset rather than a timezone database lookup.
 */

/**
 * Kept under their old names because half the codebase calls them, but the offset itself
 * is no longer decided here - it is one environment variable in src/clock.js. Whether
 * this deployment books by WIB or WITA is a business answer, and it was written out as
 * `7 * 3600` in six files before it had one.
 */
/**
 * A getter, not a frozen value.
 *
 * It was evaluated once at import, while wibDate read the offset on every call - so
 * changing the zone after load desynchronised the day boundary from the day label. The
 * two must never be able to disagree.
 */
export const WIB_OFFSET_SECONDS = offsetSeconds();
/** Read it through this when it matters, because the constant above is a snapshot. */
export const offsetNow = offsetSeconds;
export const MAX_SPAN_DAYS = 90;

const DAY = 24 * 3600;

export const PRESETS = {
  today: { label: 'Hari ini' },
  '7d': { label: '7 hari', days: 7 },
  '14d': { label: '14 hari', days: 14 },
  '30d': { label: '30 hari', days: 30 },
};

/**
 * Midnight of a calendar date in the business's clock, as epoch seconds.
 *
 * Delegates rather than doing the arithmetic itself, and that is the whole point: it used
 * to subtract WIB_OFFSET_SECONDS, a constant frozen when this module was first imported,
 * while wibDate read the offset on every call. Change the zone after load and the day
 * boundary and the day label disagreed - the boundary at 17:00 UTC, the label computed
 * from 16:00. A window whose start and end are on different clocks is a window that
 * cannot be reconciled with anything.
 */
export const wibDayStart = businessDayStart;

/** The WIB calendar date containing an instant, as YYYY-MM-DD. */
export const wibDate = businessDate;

/**
 * Resolve whatever the query string carried into a concrete window.
 *
 * A custom from/to always wins over a preset. Anything unparseable falls back to the
 * default preset rather than erroring - a bad URL should still render a dashboard.
 */
export function resolveRange({ preset, from, to, now = Date.now(), fallback = '7d' } = {}) {
  const nowSeconds = Math.floor(now / 1000);

  const fromStart = from ? wibDayStart(from) : null;
  const toStart = to ? wibDayStart(to) : null;

  if (fromStart !== null && toStart !== null) {
    // Tolerate a reversed range instead of rejecting it.
    const [lo, hi] = fromStart <= toStart ? [fromStart, toStart] : [toStart, fromStart];
    const until = Math.min(hi + DAY - 1, nowSeconds);
    // Clamped against `until` as well as against the span.
    //
    // Only `until` was clamped to now, so a range entirely in the future produced
    // since > until: a label reading "2026-09-20 s/d 2026-09-15", zero rows, and - worse -
    // a coverage row written with covered_from after covered_through, after which that
    // source never answered from the database again.
    const since = Math.min(Math.max(lo, until - MAX_SPAN_DAYS * DAY), until);
    return {
      since,
      until,
      preset: null,
      from: wibDate(since),
      to: wibDate(until),
      label: `${wibDate(since)} s/d ${wibDate(until)}`,
      clamped: lo < since,
    };
  }

  const key = PRESETS[preset] ? preset : fallback;
  const chosen = PRESETS[key];
  const since = key === 'today' ? wibDayStart(wibDate(nowSeconds)) : nowSeconds - chosen.days * DAY;

  return {
    since,
    until: nowSeconds,
    preset: key,
    from: wibDate(since),
    to: wibDate(nowSeconds),
    label: chosen.label,
    clamped: false,
  };
}

/**
 * Split a window into chunks no longer than `maxDays`.
 *
 * Shopee's get_order_list rejects any window wider than 15 days
 * ("diff in 15days"), so a 30-day view has to be assembled from several calls.
 */
export function chunkRange(since, until, maxDays = 15) {
  const span = maxDays * DAY;
  const chunks = [];
  let end = until;
  while (end > since) {
    const start = Math.max(since, end - span + 1);
    chunks.push({ from: start, to: end });
    end = start - 1;
  }
  return chunks.length > 0 ? chunks : [{ from: since, to: until }];
}
