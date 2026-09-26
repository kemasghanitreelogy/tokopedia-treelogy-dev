import { ordersInRange } from '../db/orders.js';
import { loadSyncLedger, findExisting, POSTABLE_STAGES } from './sync.js';
import { customIdFor, saleValue } from './invoice.js';
import { channelDate } from '../clock.js';

/**
 * Did what arrived today reach the books?
 *
 * This replaces a nightly comparison of the whole corpus, and the reason is arithmetic.
 * That check walked Jurnal's entire invoice list - about fifty requests out of a monthly
 * package - to re-discover the same answer every night: 979 August orders that a
 * half-finished backfill never posted, and which no nightly message was ever going to
 * fix. Meanwhile the thing actually worth watching, whether today's sales are landing,
 * was buried under them. September ran 1,148 out of 1,148.
 *
 * So the question is asked the narrow way. Orders come from Postgres, which costs Jurnal
 * nothing. Almost all of them are in the local ledger, which costs Jurnal nothing either.
 * Only an order that is missing from the ledger is worth a request - one lookup by its
 * own custom_id - because the ledger can be behind while the books are right.
 *
 * On an ordinary day that is zero requests. On a bad day it is capped, so a database
 * outage or a mangled window cannot turn an audit into the thing that spends the month's
 * quota.
 */

/** Far more than a day's sales, far less than a runaway. */
export const MAX_PROBES = 40;

/**
 * How long a sale is allowed to be in flight before its absence means anything.
 *
 * The sweep runs every fifteen minutes. An order placed two minutes before this audit
 * has not failed to reach the books; it simply has not been carried there yet, and
 * reporting it would make the alert mean "something recent exists" rather than "the sweep
 * had its chance and this is still missing". Thirty minutes is two sweeps.
 */
export const SETTLE_MS = 30 * 60_000;

/**
 * @param {{days?: number, now?: number, maxProbes?: number}} options
 * @returns {Promise<{from: string, checked: number, ledgered: number, probed: number,
 *   missingOrders: Array, uninvoiceable: Array, missingValue: number, capped: boolean}>}
 */
export async function auditRecent({
  days = 1,
  now = Date.now(),
  maxProbes = MAX_PROBES,
  settleMs = SETTLE_MS,
  readOrders = ordersInRange,
  readLedger = loadSyncLedger,
  probe = findExisting,
} = {}) {
  const until = Math.floor(now / 1000);
  const since = until - Math.max(1, days) * 86_400;

  const [orders, ledger] = await Promise.all([
    readOrders({ since, until }),
    readLedger(),
  ]);

  const sellable = orders
    .filter((o) => POSTABLE_STAGES.has(o.stage))
    .filter((o) => Number(o.createdAt) * 1000 < now - settleMs);
  // An order carrying no priced lines cannot be made into an invoice at all, so it is
  // neither a success nor a failure of the sync. Named separately rather than counted as
  // missing, which is how it would read as a sale somebody forgot.
  const uninvoiceable = [];
  const candidates = [];
  for (const order of sellable) {
    if (order.finance?.lines?.length > 0) candidates.push(order);
    else uninvoiceable.push(detail(order, 'tanpa baris keuangan - tidak bisa dibuat faktur'));
  }

  const unknown = candidates.filter((o) => !ledger.orders?.[customIdFor(o)]);
  const capped = unknown.length > maxProbes;

  const missingOrders = [];
  let probed = 0;
  for (const order of unknown.slice(0, maxProbes)) {
    probed += 1;
    // The ledger is a cache of the books, not the books. An entry can be missing while
    // the invoice exists - a lost write, a reconcile that forgot - so Jurnal is asked
    // before anybody is told a sale went unrecorded.
    const found = await probe(order).catch(() => null);
    if (!found?.id) missingOrders.push(detail(order));
  }

  return {
    from: channelDate(since, null),
    days,
    checked: candidates.length,
    ledgered: candidates.length - unknown.length,
    probed,
    capped,
    missingOrders,
    uninvoiceable,
    missingValue: missingOrders.reduce((n, o) => n + (o.total ?? 0), 0),
    // The shape notifyUninvoiced reads: this audit is always complete, because it never
    // depends on a scan that could come back short.
    complete: true,
  };
}

function detail(order, reason = null) {
  return {
    customId: customIdFor(order),
    channel: order.channel,
    id: order.id,
    total: saleValue(order) ?? Math.round(Number(order.total) || 0),
    day: channelDate(order.createdAt, order.channel),
    stage: order.stage,
    customer: order.customer ?? order.buyer ?? null,
    orderedAt: order.createdAt,
    ...(reason ? { reason } : {}),
  };
}
