/**
 * The clock the business keeps its books by.
 *
 * Every platform timestamps an order in UTC epoch seconds. Which calendar day that order
 * belongs to is a business decision, not a technical one, and getting it wrong is the
 * quietest kind of wrong: the totals are right, the orders are all there, and the daily
 * recap simply refuses to tie out by one or two orders a day - the ones placed near
 * midnight.
 *
 * It lived as `7 * 3600` written out in six files and 'Asia/Jakarta' in three more, which
 * meant the question "what timezone is this system on" had no single answer and changing
 * it meant finding all nine. Now it is one environment variable.
 *
 * Measured on this account, September 2026: 17 of 719 orders - 2.4%, about one a day -
 * fall on a different calendar day under WIB than under WITA. That is the size of the
 * mistake, and the reason this is configuration rather than a constant somebody guessed.
 */

/**
 * Indonesia's three zones. Fixed offsets, because none of them observes daylight saving -
 * so the arithmetic is a constant rather than a timezone-database lookup, which is both
 * faster and immune to a host with a stale tzdata.
 */
export const ZONES = {
  'Asia/Jakarta': { label: 'WIB', offsetHours: 7 },
  'Asia/Makassar': { label: 'WITA', offsetHours: 8 },
  'Asia/Jayapura': { label: 'WIT', offsetHours: 9 },
  // Same offset as WITA. Named separately because the Shopify store is configured this
  // way, and a report that says "Singapore" when the seller means Bali is confusing.
  'Asia/Singapore': { label: 'SGT', offsetHours: 8 },
};

export const DEFAULT_ZONE = 'Asia/Jakarta';

/** @returns {string} the IANA zone this deployment books by. */
export function zoneName() {
  const wanted = process.env.BUSINESS_TZ || DEFAULT_ZONE;
  return ZONES[wanted] ? wanted : DEFAULT_ZONE;
}

/** @returns {{label: string, offsetHours: number, name: string}} */
export function zone() {
  const name = zoneName();
  return { name, ...ZONES[name] };
}

/** Seconds to add to a UTC instant to read it as a local wall clock. */
export const offsetSeconds = () => zone().offsetHours * 3600;

/** The short name a person recognises: WIB, WITA, WIT. */
export const zoneLabel = () => zone().label;

/**
 * The calendar date an instant belongs to, in the business's own clock.
 *
 * Shifting then formatting as UTC is deliberate: it gives the same answer on any host
 * regardless of the machine's timezone, which the production box has set to UTC precisely
 * so that nothing can depend on it by accident.
 */
export const businessDate = (epochSeconds) =>
  new Date((epochSeconds + offsetSeconds()) * 1000).toISOString().slice(0, 10);

/** The YYYY-MM the instant falls in, same clock. */
export const businessMonth = (epochSeconds) =>
  new Date((epochSeconds + offsetSeconds()) * 1000).toISOString().slice(0, 7);

/** Midnight of a calendar date in the business's clock, as epoch seconds. */
export function businessDayStart(dateString) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString ?? ''));
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const utcMidnight = Date.UTC(y, mo - 1, d) / 1000;
  // Round-trip guards against overflow like 2026-02-31 silently becoming March.
  if (new Date(utcMidnight * 1000).toISOString().slice(0, 10) !== dateString) return null;
  return utcMidnight - offsetSeconds();
}

/** Today, in the business's clock. */
export const businessToday = () => businessDate(Math.floor(Date.now() / 1000));
