import { mekari } from './client.js';
import { loadSyncLedger, saveSyncLedger, forgetSyncLedgerEntries } from './sync.js';
import { customIdFor } from './invoice.js';
import { jurnalDateToIso } from './rebuild.js';
import { ordersInRange } from '../db/orders.js';
import { wibDayStart } from '../range.js';

/**
 * Make the ledger describe Jurnal, exactly, for one window.
 *
 * rebuildLedgerFromJurnal cannot do this: it merges with the stored ledger winning every
 * collision, so an entry pointing at an invoice that no longer exists is precisely the
 * thing it can never repair - and that entry then tells the sweep the order is booked, so
 * it is never posted again. After a restatement went wrong, the ledger claimed 546
 * invoices while Jurnal held 516, and every sweep dutifully wrote nothing.
 *
 * Here Jurnal wins. It is the books; the ledger is a cache of them. An order in the window
 * that Jurnal has gets Jurnal's id, and one it does not have is forgotten - which is what
 * lets the sweep see it as unposted and write it again.
 *
 * Scoped by the orders in the window, taken from Postgres, so entries for orders outside
 * it are never touched on the strength of not having been read.
 */

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';
const PAGE_SIZE = 50;

/** Every TRL invoice Jurnal holds on or after a date, by custom_id. */
export async function invoicesSince(since, { deadlineAt = null } = {}) {
  const byCustomId = new Map();
  for (let page = 1; ; page += 1) {
    const result = await mekari({
      path: `${INVOICES_PATH}?page=${page}&page_size=${PAGE_SIZE}&sort_key=transaction_date&sort_order=desc`,
      deadlineAt,
    });
    const rows = result?.sales_invoices ?? [];
    let reached = false;
    for (const invoice of rows) {
      const day = jurnalDateToIso(invoice.transaction_date);
      if (day && day < since) { reached = true; continue; }
      const customId = String(invoice.custom_id ?? '');
      if (!/^TRL-/.test(customId)) continue;
      // Lowest id wins if a duplicate survives, so this agrees with the deduplicator
      // about which copy is the real one.
      const held = byCustomId.get(customId);
      if (!held || invoice.id < held.id) {
        byCustomId.set(customId, { id: invoice.id, no: invoice.transaction_no, total: Math.round(Number(invoice.original_amount) || 0) });
      }
    }
    const pages = Number(result?.total_pages) || 1;
    if (reached || page >= pages || rows.length === 0) return byCustomId;
  }
}

/**
 * @param {{from: string, dryRun?: boolean}} options
 * @returns {Promise<object>} what the ledger said, what Jurnal says, and what changed
 */
export async function reconcileLedger({ from, dryRun = true } = {}) {
  const since = wibDayStart(from);
  if (since === null) throw new Error(`tanggal tidak valid: ${from}`);
  const until = Math.floor(Date.now() / 1000);

  const [orders, inJurnal, ledger] = await Promise.all([
    ordersInRange({ since, until }),
    invoicesSince(from),
    loadSyncLedger(),
  ]);

  const windowed = new Map(orders.map((order) => [customIdFor(order), order]));
  const corrected = [];
  const forgotten = [];

  for (const [customId] of windowed) {
    const held = ledger.orders?.[customId];
    const real = inJurnal.get(customId);

    if (real) {
      // Jurnal has it. Whatever the ledger thought, this is the id.
      if (!held || held.invoice_id !== real.id) corrected.push({ customId, from: held?.invoice_id ?? null, to: real.id, total: real.total });
      continue;
    }
    // Jurnal does not have it. An entry saying otherwise is what stops it being written.
    if (held) forgotten.push({ customId, was: held.invoice_id ?? null });
  }

  if (dryRun) {
    return { from, dryRun: true, ordersInWindow: windowed.size, inJurnal: inJurnal.size, inLedger: Object.keys(ledger.orders ?? {}).length, corrected, forgotten };
  }

  if (forgotten.length > 0) await forgetSyncLedgerEntries(forgotten.map((f) => f.customId));
  if (corrected.length > 0) {
    const patch = { version: 1, orders: {} };
    for (const row of corrected) {
      const order = windowed.get(row.customId);
      patch.orders[row.customId] = {
        invoice_id: row.to,
        channel: order.channel,
        order_id: order.id,
        total: row.total,
        at: new Date().toISOString(),
        reconciled: true,
      };
    }
    await saveSyncLedger(patch);
  }

  return { from, dryRun: false, ordersInWindow: windowed.size, inJurnal: inJurnal.size, inLedger: Object.keys(ledger.orders ?? {}).length, corrected, forgotten };
}
