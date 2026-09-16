import { mekari } from './client.js';
import { invoiceCatalogue, ours, forgetCatalogue } from './catalogue.js';
import { ordersInRange } from '../db/orders.js';
import { buildInvoice, customIdFor, jurnalDate } from './invoice.js';
import { postingAccounts } from './accounts.js';
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
 * The date is corrected in place, so no invoice is deleted and no number changes. That
 * matters, because deleting and rewriting is what produced 891 invoices from 472 earlier
 * in this integration's life.
 *
 * But Jurnal's PATCH is a REPLACE, not a patch. Sending `{transaction_date}` alone does
 * not move the date - it empties the invoice and is then refused for being empty:
 *
 *     transaction_lines  must not be blank / is invalid
 *     due_date           must not be blank / is invalid
 *     remaining          (Value must be greater than 0.)
 *     deposit            can't be added if transaction amount is empty
 *
 * All twenty-two attempts failed that way before this was understood. So the whole invoice
 * is rebuilt from the order and sent, with the corrected date falling out of buildInvoice
 * on its own - the same payload the invoice was created from, which is exactly what makes
 * a replace safe. The deposit rides along and is restated rather than duplicated: the
 * payment keeps its id and moves onto the new date with the invoice.
 *
 * Two things are refused rather than sent, because a date correction must never move
 * money:
 *   - a rebuild whose total disagrees with what is posted (the order changed since, or a
 *     SKU no longer maps) - the date is not worth rewriting the amount for;
 *   - a settled invoice whose rebuild carries no deposit (a manual source paid by hand in
 *     Jurnal) - replacing it would erase a payment this code never knew about.
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
    // A calendar date, not the epoch: the catalogue filters its cached rows by comparing
    // this against each invoice's own 'YYYY-MM-DD'. Handing it a number made every
    // comparison NaN, which is false, so a cached scan of two thousand invoices came back
    // as none - and the correction reported "0 tanggalnya salah" over a list it had just
    // thrown away.
    invoiceCatalogue({ since: from }),
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
      // Settled here means Jurnal says nothing is outstanding - which is true both for an
      // invoice this code marked paid on deposit and for one somebody received by hand.
      settled: invoice.total > 0 && invoice.remaining === 0,
      order,
    });
  }

  wrong.sort((a, b) => a.should.localeCompare(b.should));
  return { from, checked: held.size, wrong, complete: catalogue.complete };
}

/**
 * Rebuild one invoice at its corrected date, or say why it must not be sent.
 *
 * Separated so the refusals are testable without a live account.
 *
 * @returns {{payload: object}|{refuse: string}}
 */
export function redatePayload(item, { accounts = null } = {}) {
  let built;
  try {
    built = buildInvoice({ order: item.order, accounts });
  } catch (error) {
    return { refuse: `tidak bisa dibangun ulang: ${error.message}` };
  }

  if (built.expectedTotal !== item.total) {
    return { refuse: `nilai berubah (${item.total} -> ${built.expectedTotal}) - tanggal tidak sebanding dengan menulis ulang jumlahnya` };
  }
  if (item.settled && !built.sales_invoice.deposit) {
    return { refuse: 'sudah lunas tapi pembayarannya dicatat manual - mengganti faktur akan menghapusnya' };
  }
  if (built.sales_invoice.transaction_date !== item.should) {
    return { refuse: `tanggal hasil bangun ulang tidak sesuai rencana (${built.sales_invoice.transaction_date} != ${item.should})` };
  }
  return { payload: { sales_invoice: built.sales_invoice } };
}

/**
 * @param {{from: string, dryRun?: boolean, accounts?: object|null, onProgress?: Function}} options
 */
export async function redateInvoices({ from, dryRun = true, accounts = null, onProgress = () => {} } = {}) {
  const plan = await planRedate({ from });
  // A scan that came back short would make correct invoices look absent rather than wrong,
  // which is harmless here - but it would also hide the ones that need moving, and a
  // correction that silently skips half the work is worse than one that refuses.
  if (plan.complete === false) throw new Error('pindai faktur tidak lengkap - jangan perbaiki tanggal dari daftar yang kurang');
  if (dryRun) return { ...plan, dryRun: true, moved: 0, failures: [] };
  if (isReadOnly()) throw new ReadOnlyError('perbaiki tanggal faktur');
  // A rebuild without the chart of accounts would carry no deposit, and a paid invoice
  // whose replacement has none is refused by redatePayload - so the whole run would report
  // every marketplace invoice as unfixable. Read it once, here.
  const chart = accounts ?? await postingAccounts();

  let moved = 0;
  const failures = [];
  for (const item of plan.wrong) {
    const attempt = redatePayload(item, { accounts: chart });
    if (attempt.refuse) {
      failures.push({ no: item.no, customId: item.customId, error: attempt.refuse });
      continue;
    }
    try {
      await mekari({ method: 'PATCH', path: `${INVOICES_PATH}/${item.id}`, body: attempt.payload });
      moved += 1;
      onProgress({ moved, of: plan.wrong.length, no: item.no, was: item.was, should: item.should });
    } catch (error) {
      failures.push({ no: item.no, customId: item.customId, error: error.message });
    }
  }
  // The cached scan still holds the dates these invoices had a moment ago, and catalogue.js
  // is explicit that anything changing what Jurnal holds must drop it - a date is as much a
  // change as a delete or a payment. Without this the next five minutes of reconciling,
  // recapping and deduplicating all read the dates this run just corrected away.
  if (moved > 0) await forgetCatalogue();
  return { ...plan, dryRun: false, moved, failures };
}
