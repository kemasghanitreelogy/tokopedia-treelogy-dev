import { readEnv } from './env-file.js';
import { ENV_PATH, ENV_LOCAL_PATH } from './config.js';

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

/** process.env wins, then .env.local, then .env - the order the rest of the code uses. */
function readSetting(key) {
  if (process.env[key]) return process.env[key];
  try {
    return readEnv(ENV_LOCAL_PATH)[key] || readEnv(ENV_PATH)[key] || '';
  } catch {
    return '';
  }
}

/**
 * @returns {string} the IANA zone this deployment books by.
 *
 * Resolved the way every other setting in this codebase is - process.env, then .env.local,
 * then .env - because it was the one variable that read process.env only, in the module
 * whose entire argument is that the timezone should be one setting. Put BUSINESS_TZ in
 * .env, where everything else lives, and it was silently ignored; the fallback to Jakarta
 * made that indistinguishable from a typo.
 */
export function zoneName() {
  const wanted = readSetting('BUSINESS_TZ') || DEFAULT_ZONE;
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

/**
 * The clock each platform keeps its own books by.
 *
 * Finance recaps a day by opening each platform's back office and comparing it to Jurnal,
 * so an invoice's date has to be the date that platform shows - not one house clock
 * applied to everybody. Those are not the same thing here, and the difference is real:
 *
 *   - Shopee's shop region is ID and Tokopedia and TikTok Shop ID are Indonesian, so all
 *     three report WIB.
 *   - The Shopify store is configured Asia/Singapore, UTC+8, with a Singapore address.
 *     Read from the live shop on 2026-09-15 via shop { ianaTimezone } rather than assumed.
 *
 * So a sale at 23:30 Jakarta is the 14th to Shopee and the 15th to Shopify, and both are
 * right from where finance is looking. Seventeen of September's 719 orders sit in that
 * hour - about one a day, which is small enough to be invisible and large enough that a
 * recap never quite ties out.
 *
 * A channel with no entry books by the house clock, which is what a typed-in transaction
 * should do: it has no platform of its own.
 */
export const CHANNEL_ZONES = {
  shopee: 'Asia/Jakarta',
  tokopedia: 'Asia/Jakarta',
  tiktok_shop: 'Asia/Jakarta',
  shopify: 'Asia/Singapore',
};

/** @returns {{name: string, label: string, offsetHours: number}} */
export function zoneForChannel(channel) {
  const name = CHANNEL_ZONES[channel];
  return name && ZONES[name] ? { name, ...ZONES[name] } : zone();
}

/** The calendar date an instant belongs to, on the clock of the platform it came from. */
export const channelDate = (epochSeconds, channel) =>
  new Date((epochSeconds + zoneForChannel(channel).offsetHours * 3600) * 1000).toISOString().slice(0, 10);

/**
 * The widest the zones we book in are apart, in seconds.
 *
 * WIB is +7 and the Shopify store is +8, so a single calendar day spans 25 hours once both
 * clocks are allowed to name it. Anything fetching by epoch and then filtering by each
 * platform's own day has to reach an hour past both ends, or it drops the orders that sit
 * in the overlap - which is precisely the four Shopify sales that made a month's dashboard
 * and a month's invoices disagree.
 */
export const ZONE_SPREAD_SECONDS = (() => {
  const offsets = Object.values(ZONES).map((z) => z.offsetHours);
  return (Math.max(...offsets) - Math.min(...offsets)) * 3600;
})();

/**
 * Does this order fall inside a range of calendar days, on its own platform's clock?
 *
 * The dashboard filtered by a single WIB window while the invoice date follows the
 * platform. So a Shopify order at 23:30 Jakarta on 31 August - already 1 September to
 * Shopify, and invoiced as such - was counted in August by one screen and September by the
 * other. Four of them in a single month, and the two sides could never be reconciled by
 * anybody comparing them.
 */
export function withinDays(order, { from, to }) {
  if (!from || !to) return true;
  const day = channelDate(order.createdAt ?? order.at, order.channel);
  return day >= from && day <= to;
}
