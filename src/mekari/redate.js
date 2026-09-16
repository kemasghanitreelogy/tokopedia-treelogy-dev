import { mekari } from './client.js';
import { invoiceCatalogue, ours } from './catalogue.js';
import { ordersInRange } from '../db/orders.js';
import { customIdFor, jurnalDate } from './invoice.js';
import { termDaysFor } from './sources.js';
import { POSTABLE_STAGES } from './sync.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { wibDayStart } from '../range.js';

/**
 * Move invoices onto the day their platform says the sale happened.
 *
 * Every marketplace here reports UTC+8 and this system assumed UTC+7, so a sale placed
 * between 23:00 and midnight Jakarta was invoiced a day early - for as long as the
 * integration has run. Shopee's own order ids put the number at nine a month on that
 * channel alone.
 *
 * A date is the one thing about a posted invoice that can be corrected in place: Jurnal's
 * PATCH takes transaction_date and due_date, so nothing has to be deleted and no invoice
 * number changes. That matters, because deleting and rewriting is what produced 891
 * invoices from 472 earlier in this integration's life.
 *
 * Only invoices whose date actually disagrees are touched, so a second run costs one scan
 * and no writes.
 */

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';

/** @param {{from: string, until?: number}} options */
export async function planRedate({ from, until = Math.floor(Date.now() / 1000) } = {}) {
  const since = wibDayStart(from);
  if (since === null) throw new Error(`tanggal tidak valid: ${from}`);

  const [orders, catalogue] = await Promise.all([
    // Widened, because an order near midnight can belong to a day outside the epoch window
    // the range describes - which is the whole reason this correction is needed.
    ordersInRange({ since: since - 24 * 3600, until: until + 24 * 3600 }),
    invoiceCatalogue({ since }),
  ]);
  const held = ours(catalogue.invoices);

  const wrong = [];
  for (const order of orders) {
    if (!POSTABLE_STAGES.has(order.stage)) continue;
    const invoice = held.get(customIdFor(order));
    if (!invoice) continue;
    const should = jurnalDate(order.createdAt, order.channel);
    if (invoice.date === should) continue;
    wrong.push({
      id: invoice.id,
      no: invoice.no,
      customId: customIdFor(order),
      channel: order.channel,
      was: invoice.date,
      should,
      dueDate: jurnalDate(order.createdAt + termDaysFor(order) * 24 * 3600, order.channel),
      total: invoice.total,
    });
  }

  wrong.sort((a, b) => a.should.localeCompare(b.should));
  return { from, checked: held.size, wrong, complete: catalogue.complete };
}

/**
 * @param {{from: string, dryRun?: boolean, onProgress?: Function}} options
 */
export async function redateInvoices({ from, dryRun = true, onProgress = () => {} } = {}) {
  const plan = await planRedate({ from });
  // A scan that came back short would make correct invoices look absent rather than wrong,
  // which is harmless here - but it would also hide the ones that need moving, and a
  // correction that silently skips half the work is worse than one that refuses.
  if (plan.complete === false) throw new Error('pindai faktur tidak lengkap - jangan perbaiki tanggal dari daftar yang kurang');
  if (dryRun) return { ...plan, dryRun: true, moved: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('perbaiki tanggal faktur');

  let moved = 0;
  const failures = [];
  for (const item of plan.wrong) {
    try {
      await mekari({
        method: 'PATCH',
        path: `${INVOICES_PATH}/${item.id}`,
        // The due date moves with it, or a Net 14 invoice silently becomes Net 13.
        body: { sales_invoice: { transaction_date: item.should, due_date: item.dueDate } },
      });
      moved += 1;
      onProgress({ moved, of: plan.wrong.length, no: item.no, was: item.was, should: item.should });
    } catch (error) {
      failures.push({ no: item.no, customId: item.customId, error: error.message });
    }
  }
  return { ...plan, dryRun: false, moved, failures };
}
