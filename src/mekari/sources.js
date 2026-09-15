import { PREFIXES, orderPrefix } from './prefix.js';

/**
 * Where a sale came from, and everything the books need to know because of it.
 *
 * One table. Before this the same fact was spread across four places - the term lived in
 * prefix.js, the deposit was a single environment variable that applied to every channel
 * alike, the receivable was whatever Jurnal's company default happened to be, and the tag
 * was typed in by hand - so "how is a wholesale order booked" had no single answer and no
 * way to check one.
 *
 * The receivable is named by its account *number*, not its id. Ids are assigned per
 * company, so a table of ids is a table that is silently wrong the moment the books are
 * rebuilt in another Jurnal company; the number is what an accountant reads and what
 * survives.
 */

/**
 * @typedef {object} Source
 * @property {string} label      how the business names it
 * @property {string} tag        the Jurnal tag, written on every invoice from this source
 * @property {string} receivable A/R account number
 * @property {number} termDays   payment term
 * @property {boolean} autoPaid  settled by the platform before it ships, so booked paid
 */

/** @type {Record<string, Source>} */
export const SOURCES = {
  // Marketplaces and the web shop collect the money themselves, so the invoice is raised
  // and settled in the same breath - leaving them open would overstate receivables by the
  // whole of every month's online turnover.
  SP: { label: 'Shopee', tag: 'Shopee', receivable: '1503', termDays: 14, autoPaid: true },
  TP: { label: 'Tokopedia', tag: 'Tokopedia', receivable: '1504', termDays: 14, autoPaid: true },
  // TikTok Shop settles through the same account as Tokopedia: one API, one entity, one
  // receivable. The tag says Tokopedia too, by the same decision.
  TT: { label: 'TikTok Shop', tag: 'Tokopedia', receivable: '1504', termDays: 14, autoPaid: true },
  SHF: { label: 'Website', tag: 'Website', receivable: '1505', termDays: 14, autoPaid: true },
  WA: { label: 'Website', tag: 'Website', receivable: '1505', termDays: 14, autoPaid: true },
  WX: { label: 'Website', tag: 'Website', receivable: '1505', termDays: 14, autoPaid: true },

  // Everything below is invoiced and then chased. The money arrives later, by transfer or
  // in person, so the invoice stays open until somebody records the payment - and the term
  // is a week, not a fortnight, because these are the ones that need chasing.
  CS: { label: 'Consignment', tag: 'Consignment', receivable: '1501', termDays: 7, autoPaid: false },
  // Wholesale shares consignment's receivable by decision, not by accident: both are trade
  // buyers settling on terms, and the business wants one number for them.
  WS: { label: 'Wholesale', tag: 'Wholesale', receivable: '1501', termDays: 7, autoPaid: false },
  LB: { label: 'La Brisa', tag: 'La Brisa', receivable: '1502', termDays: 7, autoPaid: false },
  DP: { label: 'WhatsApp', tag: 'Whatsapp', receivable: '1502', termDays: 7, autoPaid: false },
  DW: { label: 'Walk in', tag: 'Walk in', receivable: '1502', termDays: 7, autoPaid: false },
};

/** Where delivery charged to the buyer belongs. Set once, on the company, not per invoice. */
export const SHIPPING_ACCOUNT_NUMBER = '5030';

/** Every receivable account this system books into, for the one-time setup check. */
export const RECEIVABLE_NUMBERS = [...new Set(Object.values(SOURCES).map((s) => s.receivable))].sort();

/** Every tag this system writes, so they can be created in Jurnal before they are needed. */
export const TAGS = [...new Set(Object.values(SOURCES).map((s) => s.tag))].sort();

/**
 * The source record for an order.
 *
 * Falls back to the website's treatment rather than throwing, because an order that
 * cannot be classified is still a real sale and stopping the whole run over it would be
 * worse than booking it as the most common case - but it is the only place that guesses,
 * and the prefix table is what keeps it from having to.
 */
export function sourceOf(order) {
  const prefix = orderPrefix(order);
  return SOURCES[prefix] ?? SOURCES.SHF;
}

/** @returns {string} the Jurnal tag for an order's source. */
export const tagFor = (order) => sourceOf(order).tag;

/** @returns {number} payment term in days. */
export const termDaysFor = (order) => sourceOf(order).termDays;

/** @returns {boolean} whether the platform already took the money. */
export const isAutoPaid = (order) => sourceOf(order).autoPaid;

/** @returns {string} the A/R account number this order's invoice must land in. */
export const receivableFor = (order) => sourceOf(order).receivable;

/**
 * Every prefix in the code table is covered here, and nothing extra.
 *
 * Exported rather than asserted at import time so the check is a test, not a crash on a
 * production box - but it must never drift: a prefix with no source falls through to the
 * website's receivable, which would put a wholesale sale in the web shop's books.
 */
export const uncoveredPrefixes = () => Object.keys(PREFIXES).filter((p) => !SOURCES[p]);
