import { put, get } from '@vercel/blob';
import { mekari, isMekariConfigured, MekariError } from './client.js';
import { buildInvoice, verifyInvoice, customIdFor, customerFor, CUSTOMER_NAMES } from './invoice.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { ensureContact } from './setup.js';
import { loadConfig } from '../config.js';

/**
 * Posting orders into Jurnal, exactly once.
 *
 * Duplicate invoices are the defining risk of an automatic accounting feed, and Jurnal
 * offers no way to search by our own reference - the list endpoint takes only page and
 * sort. So idempotency is owned on both sides:
 *
 *   1. a local ledger in Blob, which makes a repeat run cheap and leaves an audit trail
 *   2. `custom_id` on the invoice itself, which Jurnal accepts in place of an id, so a
 *      lost ledger can still be reconciled against the books rather than duplicating them
 *
 * Only paid orders are posted, and only ones that are not cancelled: an invoice for a
 * sale that never happened is worse than a late one.
 */

export const LEDGER_PATHNAME = 'mekari/synced.json';

/** Stages that represent money actually earned. */
export const POSTABLE_STAGES = new Set(['to_ship', 'shipping', 'delivered', 'completed']);

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || loadConfig().blobToken || '';
}

export async function loadSyncLedger() {
  const token = blobToken();
  if (!token) return { version: 1, orders: {} };
  try {
    const result = await get(LEDGER_PATHNAME, { access: 'private', useCache: false, token });
    if (!result) return { version: 1, orders: {} };
    return JSON.parse(await new Response(result.stream).text());
  } catch {
    // A missing or unreadable ledger must not become a licence to re-post everything;
    // the custom_id probe below is what actually protects the books.
    return { version: 1, orders: {} };
  }
}

export async function saveSyncLedger(ledger) {
  const token = blobToken();
  if (!token) return;
  await put(LEDGER_PATHNAME, JSON.stringify({ ...ledger, version: 1, updated_at: new Date().toISOString() }), {
    access: 'private', allowOverwrite: true, contentType: 'application/json',
    token, cacheControlMaxAge: 0,
  });
}

export const LOCK_PATHNAME = 'mekari/sync.lock';
const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Best-effort mutual exclusion between overlapping runs.
 *
 * Blob has no compare-and-set, so this cannot be a real lock - two runs that start in
 * the same instant will both take it. It exists to stop the common case, a cron tick
 * firing while the previous one is still working through a backlog. The guarantee that
 * actually protects the books is the custom_id probe before every create.
 */
export async function acquireLock(owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`) {
  const token = blobToken();
  if (!token) return { acquired: true, owner, held: false };

  try {
    const existing = await get(LOCK_PATHNAME, { access: 'private', useCache: false, token });
    if (existing) {
      const held = JSON.parse(await new Response(existing.stream).text());
      // A run that crashed mid-batch would otherwise hold the lock forever.
      if (Date.now() - Number(held.at ?? 0) < LOCK_TTL_MS) {
        return { acquired: false, owner: held.owner ?? null, since: held.at ?? null, held: true };
      }
    }
  } catch {
    // An unreadable lock is treated as absent; worst case two runs race and the
    // custom_id probe makes the second one a no-op.
  }

  await put(LOCK_PATHNAME, JSON.stringify({ owner, at: Date.now() }), {
    access: 'private', allowOverwrite: true, contentType: 'application/json', token, cacheControlMaxAge: 0,
  });
  return { acquired: true, owner, held: true };
}

export async function releaseLock() {
  const token = blobToken();
  if (!token) return;
  try {
    await put(LOCK_PATHNAME, JSON.stringify({ owner: null, at: 0 }), {
      access: 'private', allowOverwrite: true, contentType: 'application/json', token, cacheControlMaxAge: 0,
    });
  } catch {
    // Failing to release only costs us the TTL.
  }
}

/** Does Jurnal already hold this order? Asked by custom_id, which it accepts as an id. */
export async function findExisting(order) {
  try {
    const found = await mekari({ path: `/public/jurnal/api/v1/sales_invoices/${encodeURIComponent(customIdFor(order))}` });
    const invoice = found?.sales_invoice ?? found;
    return invoice?.id ? invoice : null;
  } catch (error) {
    // Jurnal answers "no such invoice" with 422 and a message, not with 404. Reading that
    // as a real error was what made every duplicate check fail on the first live run.
    if (error.status === 404) return null;
    if (error.status === 422 && /not found/i.test(JSON.stringify(error.body ?? ''))) return null;
    throw error;
  }
}

/** Orders worth posting, oldest first so the books read in the order things happened. */
export function postable(orders, ledger) {
  return orders
    .filter((o) => POSTABLE_STAGES.has(o.stage))
    .filter((o) => o.finance?.lines?.length > 0)
    .filter((o) => !ledger.orders[customIdFor(o)])
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * What the books would look like for a window, computed without calling Jurnal.
 *
 * The dashboard needs to answer "is this order in the accounts yet?" for every row on
 * screen. Asking Jurnal once per order would be hundreds of calls per page load, so the
 * question is answered from the ledger and the mapper alone - both of which are the same
 * code the real run uses, so what is shown is what would be posted.
 */
export function syncOverview({ orders, ledger, depositTo = null }) {
  const rows = orders.map((order) => {
    const customId = customIdFor(order);
    const recorded = ledger.orders?.[customId] ?? null;

    if (recorded) {
      return { order, customId, state: 'synced', total: recorded.total ?? 0, invoiceId: recorded.invoice_id ?? null, at: recorded.at ?? null };
    }
    if (!POSTABLE_STAGES.has(order.stage)) {
      return { order, customId, state: 'skipped', total: 0, reason: 'belum dibayar atau dibatalkan' };
    }
    try {
      const built = buildInvoice({ order, depositTo });
      verifyInvoice({ sales_invoice: built.sales_invoice }, built.expectedTotal);
      return { order, customId, state: 'queued', total: built.expectedTotal };
    } catch (error) {
      return { order, customId, state: 'broken', total: 0, reason: error.message };
    }
  });

  const sum = (state) => rows.filter((r) => r.state === state).reduce((n, r) => n + r.total, 0);
  const count = (state) => rows.filter((r) => r.state === state).length;

  return {
    rows,
    synced: count('synced'), syncedValue: sum('synced'),
    queued: count('queued'), queuedValue: sum('queued'),
    skipped: count('skipped'), broken: count('broken'),
    ledgerTotal: Object.keys(ledger.orders ?? {}).length,
    customers: CUSTOMER_NAMES,
  };
}

/**
 * Post one order. Returns what happened rather than throwing, so a single bad order
 * cannot stop the rest of the run.
 */
export async function postOrder(order, { depositTo = null, dryRun = true } = {}) {
  const customId = customIdFor(order);
  let payload;
  let expectedTotal;

  try {
    const built = buildInvoice({ order, depositTo });
    payload = { sales_invoice: built.sales_invoice };
    expectedTotal = built.expectedTotal;
    // Recompute before sending: a mapping slip must never reach the books.
    verifyInvoice(payload, expectedTotal);
  } catch (error) {
    return { customId, id: order.id, channel: order.channel, status: 'failed', error: error.message };
  }

  if (dryRun) {
    return { customId, id: order.id, channel: order.channel, status: 'dry-run', total: expectedTotal, payload };
  }
  if (isReadOnly()) throw new ReadOnlyError(`faktur ${customId}`);

  // Ask before writing: cheaper than a duplicate, and the only protection if the local
  // ledger was lost.
  try {
    const existing = await findExisting(order);
    if (existing) {
      return { customId, id: order.id, channel: order.channel, status: 'exists', invoiceId: existing.id, total: expectedTotal };
    }
  } catch (error) {
    return { customId, id: order.id, channel: order.channel, status: 'failed', error: `cek duplikat gagal: ${error.message}` };
  }

  // Jurnal refuses an invoice naming a contact it does not hold, and every invoice now
  // names its own buyer, so the contact is made to exist first.
  try {
    await ensureContact(customerFor(order));
  } catch (error) {
    return { customId, id: order.id, channel: order.channel, status: 'failed', error: `kontak gagal: ${error.message}` };
  }

  try {
    const created = await mekari({ method: 'POST', path: '/public/jurnal/api/v1/sales_invoices', body: payload });
    const invoice = created?.sales_invoice ?? created;
    return {
      customId, id: order.id, channel: order.channel, status: 'created',
      invoiceId: invoice?.id, transactionNo: invoice?.transaction_no, total: expectedTotal,
    };
  } catch (error) {
    return { customId, id: order.id, channel: order.channel, status: 'failed', error: error.message };
  }
}

/**
 * Run a batch.
 *
 * The ledger is written after every success rather than at the end: a crash halfway
 * through must not make the next run repost what already landed.
 */
export async function runSync({ orders, depositTo = null, dryRun = true, limit = 50, lock = !dryRun, deadlineMs = null } = {}) {
  if (!isMekariConfigured()) throw new MekariError('kredensial Mekari belum diisi');

  // A dry run reads only, so it never queues behind a live one.
  const held = lock ? await acquireLock() : { acquired: true, held: false };
  if (!held.acquired) {
    return { dryRun, skipped: 'terkunci', lockedSince: held.since, considered: 0, created: 0, exists: 0, failed: 0, results: [] };
  }

  try {
    return await runBatch({ orders, depositTo, dryRun, limit, deadlineMs });
  } finally {
    if (held.held) await releaseLock();
  }
}

async function runBatch({ orders, depositTo, dryRun, limit, deadlineMs = null }) {
  const ledger = await loadSyncLedger();
  const queue = postable(orders, ledger).slice(0, limit);
  const results = [];
  const stopAt = deadlineMs ? Date.now() + deadlineMs : Infinity;
  let ranOutOfTime = false;

  for (const order of queue) {
    // Stopping early is free: the ledger already holds everything posted so far, and the
    // next run picks up exactly where this one left off. Being killed mid-POST is not
    // free, so leave room rather than racing the platform timeout.
    if (Date.now() > stopAt) { ranOutOfTime = true; break; }
    const result = await postOrder(order, { depositTo, dryRun });
    results.push(result);

    if (!dryRun && (result.status === 'created' || result.status === 'exists')) {
      ledger.orders[result.customId] = {
        invoice_id: result.invoiceId ?? null,
        channel: order.channel,
        order_id: order.id,
        total: result.total,
        at: new Date().toISOString(),
      };
      await saveSyncLedger(ledger);
    }
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    dryRun,
    considered: queue.length,
    posted: results.length,
    remaining: queue.length - results.length,
    ranOutOfTime,
    created: count('created'),
    exists: count('exists'),
    failed: count('failed'),
    results,
    syncedTotal: Object.keys(ledger.orders).length,
  };
}

/**
 * Post one typed-in transaction.
 *
 * The customer is made to exist first: Jurnal rejects an invoice naming a contact it does
 * not hold, and a consignment shop or a wholesale buyer is not one of the four channel
 * contacts created at setup. Everything after that is the ordinary path - same mapper,
 * same total check, same idempotency key - because a manual sale is a sale.
 */
export async function postManual({ order, depositTo = null, dryRun = true }) {
  if (!dryRun && order.customer) await ensureContact(order.customer);
  const result = await runSync({ orders: [order], depositTo, dryRun, limit: 1, lock: false });
  return result.results[0] ?? { status: 'failed', error: 'tidak ada yang diproses' };
}

/** Codes already used by typed-in transactions, so a suggested one cannot collide. */
export function manualCodes(ledger) {
  return Object.keys(ledger.orders ?? {})
    .filter((customId) => customId.startsWith('TRL-manual-'))
    .map((customId) => customId.slice('TRL-manual-'.length));
}
