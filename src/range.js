/**
 * Date ranges in the seller's own timezone.
 *
 * Every order timestamp from both platforms is epoch seconds in UTC, but a seller asking
 * for "hari ini" means today in Jakarta. WIB is a fixed UTC+7 with no daylight saving, so
 * the conversion is a constant offset rather than a timezone database lookup.
 */

export const WIB_OFFSET_SECONDS = 7 * 3600;
export const MAX_SPAN_DAYS = 90;

const DAY = 24 * 3600;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const PRESETS = {
  today: { label: 'Hari ini' },
  '7d': { label: '7 hari', days: 7 },
  '14d': { label: '14 hari', days: 14 },
  '30d': { label: '30 hari', days: 30 },
};

/** Midnight of a WIB calendar date, as epoch seconds. */
export function wibDayStart(dateString) {
  if (!DATE_PATTERN.test(dateString)) return null;
  const [year, month, day] = dateString.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utcMidnight = Date.UTC(year, month - 1, day) / 1000;
  // Round-trip guards against overflow like 2026-02-31 silently becoming March.
  const roundTrip = new Date(utcMidnight * 1000).toISOString().slice(0, 10);
  if (roundTrip !== dateString) return null;
  return utcMidnight - WIB_OFFSET_SECONDS;
}

/** The WIB calendar date containing an instant, as YYYY-MM-DD. */
export function wibDate(epochSeconds) {
  return new Date((epochSeconds + WIB_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

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
    const since = Math.max(lo, until - MAX_SPAN_DAYS * DAY);
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
