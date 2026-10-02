import { loadSyncLedger, saveSyncLedger, voidInvoice, UNDONE_STAGES, RECORDED_UNDONE } from './sync.js';
import { customIdFor } from './invoice.js';
import { ordersInRange } from '../db/orders.js';
import { spend } from './budget.js';
import { notifySyncFailures } from '../notify/telegram.js';
import { forgetCatalogue } from './catalogue.js';
import { invalidate } from '../cache.js';

/**
 * The net under the realtime cancellation.
 *
 * A cancellation is supposed to be acted on the moment it is pushed: the webhook reads the
 * order, sees the stage, and deletes the invoice before the operator has finished reading
 * the notification. That path exists and works. Two things slip past it.
 *
 * A cancellation that is not final when it is pushed. Shopee says IN_CANCEL, Tokopedia
 * says CANCEL_REQUEST, and voidInvoice deliberately writes nothing for those - the buyer
 * can still be refused. When it goes final a day later, nothing necessarily pushes again.
 *
 * And a push that never arrives at all, for whatever reason a platform has that day.
 *
 * The sweep was the backstop, and it only ever looked seven days back, because that is the
 * window it posts from. Tokopedia 586104376321148443 was cancelled fifteen days after it
 * was raised and sat in the books at Rp766.800 with nobody left to notice it.
 *
 * This looks further, and costs nothing to do so: which orders are cancelled, and which of
 * those still carry a live invoice, are both answered from our own database and our own
 * ledger. Jurnal is only ever called for an invoice that genuinely has to go - one read and
 * one delete, the same two the realtime path spends.
 */

/** Far enough back to cover a cancellation nobody chased; still one cheap database read. */
export const UNDONE_WINDOW_DAYS = 60;

/**
 * Cancelled orders whose invoice is still standing, decided entirely from local state.
 *
 * @param {object[]} orders
 * @param {{orders: Record<string, object>}} ledger
 */
export function stillBooked(orders, ledger) {
  return orders
    .filter((order) => UNDONE_STAGES.has(order.stage))
    .map((order) => ({ order, entry: ledger.orders?.[customIdFor(order)] ?? null }))
    .filter(({ entry }) => entry?.invoice_id && !entry.voided && !entry.needs_review);
}

/**
 * @param {{days?: number, dryRun?: boolean, max?: number}} options
 * @returns {Promise<{found: number, voided: number, review: number, pending: number, failed: number, results: object[]}>}
 */
export async function sweepUndone({
  days = UNDONE_WINDOW_DAYS, dryRun = true, max = 25, now = Date.now(),
  readOrders = ordersInRange, loadLedger = loadSyncLedger, saveLedger = saveSyncLedger,
  undo = voidInvoice, charge = spend, notify = notifySyncFailures,
} = {}) {
  const until = Math.floor(now / 1000);
  const [orders, ledger] = await Promise.all([
    readOrders({ since: until - days * 86400, until }),
    loadLedger(),
  ]);

  const candidates = stillBooked(orders, ledger);
  const out = { found: candidates.length, voided: 0, review: 0, pending: 0, failed: 0, results: [] };
  if (dryRun || candidates.length === 0) return out;

  for (const { order, entry } of candidates.slice(0, max)) {
    /*
     * Essential, so it can spend below the reserve the posting path has to respect.
     *
     * The reserve exists so a quiet month cannot leave a real sale unbooked. A sale that
     * no longer exists sitting in the books is the same fault pointing the other way, and
     * refusing to remove it to save two requests would be saving the wrong thing.
     */
    const allowed = await charge(2, { essential: true });
    if (!allowed.allowed) {
      out.results.push({ customId: customIdFor(order), status: 'failed', error: allowed.reason });
      out.failed += 1;
      break;
    }

    const outcome = await undo(order, entry, { dryRun: false });
    out.results.push(outcome);
    if (outcome.outcome === 'voided' || outcome.outcome === 'gone') out.voided += 1;
    else if (outcome.outcome === 'needs_review') out.review += 1;
    else if (outcome.outcome === 'pending') out.pending += 1;
    else out.failed += 1;

    if (RECORDED_UNDONE.has(outcome.outcome)) {
      ledger.orders[outcome.customId] = {
        ...entry,
        ...(outcome.outcome === 'needs_review'
          ? { needs_review: outcome.reason }
          : { voided: true, voided_at: new Date().toISOString() }),
      };
      // Saved after every one, not at the end: a crash halfway through must not make the
      // next run try to delete an invoice that is already gone.
      await saveLedger(ledger);
    }
  }

  if (out.voided > 0) {
    await forgetCatalogue().catch(() => {});
    invalidate('jurnal');
  }

  // One message for the ones a person has to deal with - an invoice with money against it
  // cannot be deleted by anybody here, and saying so quietly in a log is saying nothing.
  const human = out.results.filter((r) => r.outcome === 'needs_review' || r.status === 'failed');
  if (human.length > 0) {
    await notify({
      source: 'pembatalan di luar jendela sapuan',
      results: human.map((r) => ({ status: 'failed', customId: r.customId, error: r.reason ?? r.error })),
    }).catch(() => {});
  }

  return out;
}
