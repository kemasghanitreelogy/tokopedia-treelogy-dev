import { readDoc, updateDoc } from '../store/index.js';
import { mekari, isMekariConfigured, MekariError, QuotaExhaustedError } from './client.js';
import { buildInvoice, verifyInvoice, customIdFor, customerFor, normaliseCustomId, CUSTOMER_NAMES } from './invoice.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { ensureContact, rememberContacts, knownContactNames } from './setup.js';
import { accountMap } from './accounts.js';
import { receivableFor } from './sources.js';
/**
 * The Jurnal account id this order's buyer should be created against.
 *
 * Resolved from the account number, which is cached for a day, so this costs nothing per
 * order. Returns null rather than throwing when the chart cannot be read: a contact
 * created without an explicit receivable falls back to Jurnal's company default, which is
 * recoverable, whereas refusing to create the contact loses the sale entirely.
 */
async function receivableIdFor(order) {
  try {
    const accounts = await accountMap();
    return accounts[receivableFor(order)]?.id ?? null;
  } catch {
    return null;
  }
}


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

/**
 * Codes a connection that never got an answer arrives with, wherever Node attached them:
 * on the error itself, or on the `cause` fetch wraps around the socket failure.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Whether a failure is worth waking anyone for.
 *
 * A 429, a 5xx, a dropped connection or a deadline that ran out before a retry could
 * start all mean "not now": the order stays out of the ledger and the next sweep picks
 * it up. A 4xx is Jurnal saying "not like this", and no amount of retrying changes it -
 * that one needs a person. The first chained sweep reported eleven of the former as
 * failures, turned the job red and rang the phone for problems that had fixed
 * themselves by the next round.
 */
export function isTransient(error) {
  if (error?.monthly) return true; // deferred until the quota returns; the run itself stops
  const status = error?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  // Jurnal answered, and its answer settles it. Reading the message after a status is
  // what made "HTTP 422: alamat ETIMEDOUT tidak valid" - a validation refusal quoting a
  // buyer's address back at us - look like a network blip worth retrying forever.
  if (status !== undefined) return false;
  if (error?.name === 'MekariError') return true; // unreachable / timed out
  // Nothing reached Jurnal: the socket died, DNS did not answer, the deadline fired.
  // These are facts carried on the error - a code, a flag - rather than a sentence, and
  // that matters because the sentence is the one thing anybody is free to reword. The
  // text test below is what classified ECONNREFUSED and EAI_AGAIN as permanent refusals
  // for as long as it was the only test there was.
  if (TRANSIENT_CODES.has(error?.code) || TRANSIENT_CODES.has(error?.cause?.code)) return true;
  if (error?.timeout || error?.name === 'TimeoutError' || error?.name === 'AbortError') return true;
  // Last resort, for a message that carries nothing structured at all. Anything reaching
  // here that turns out to be transient belongs in one of the tests above, not in this
  // pattern - a longer regex only moves the next silent misclassification further out.
  return /tenggat habis|tidak terjangkau|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(error?.message ?? ''));
}

const failureOf = (error) => (isTransient(error) ? 'deferred' : 'failed');

/** Stages that represent money actually earned. */
export const POSTABLE_STAGES = new Set(['to_ship', 'shipping', 'delivered', 'completed']);

export async function loadSyncLedger() {
  try {
    const stored = (await readDoc(LEDGER_PATHNAME)) ?? { version: 1, orders: {} };
    // Shopify entries written before the '#' was dropped from custom_id are keyed the old
    // way. Read under the key we would generate today, or every historical Shopify order
    // reads as unposted and gets a second invoice - which is the exact failure dropping
    // the hash was meant to end.
    const orders = {};
    for (const [key, value] of Object.entries(stored.orders ?? {})) {
      orders[normaliseCustomId(key)] = value;
    }
    return { ...stored, orders };
  } catch {
    // A missing or unreadable ledger must not become a licence to re-post everything;
    // Jurnal's own 409 on a repeated custom_id is what actually protects the books.
    return { version: 1, orders: {} };
  }
}

/**
 * Save the ledger without erasing what somebody else wrote meanwhile.
 *
 * Blob has no compare-and-set, so two writers - a webhook and a sweep, or two webhooks -
 * each load, add their own order and save, and the later save silently drops the earlier
 * order. That happened once; the custom_id 409 made it harmless, but every lost entry
 * costs a request to re-learn. Re-reading just before writing and taking the union
 * shrinks the window from the whole run to the few milliseconds between read and write.
 */
export async function saveSyncLedger(ledger) {
  // One transaction: read what is stored, take the union, write. On SQLite that is
  // genuinely atomic; on Blob it is the narrowest window the platform allows.
  const merged = await updateDoc(LEDGER_PATHNAME, (current) => ({
    ...(current ?? {}),
    ...ledger,
    version: 1,
    orders: { ...(current?.orders ?? {}), ...(ledger.orders ?? {}) },
    contacts: [...new Set([...(current?.contacts ?? []), ...(ledger.contacts ?? [])])],
    updated_at: new Date().toISOString(),
  }), { version: 1, orders: {} });
  // Keep the caller's copy in step so a later save in the same run does not regress it.
  ledger.orders = merged.orders;
  ledger.contacts = merged.contacts;
}

/**
 * Forget entries, which saveSyncLedger cannot do and must not learn to.
 *
 * That function takes the union of what is stored and what the caller holds, on purpose:
 * two writers each adding their own order must not erase each other, and that is the
 * common case by far. The cost is that a removal written through it does not survive -
 * the merge puts the entry straight back.
 *
 * Which is exactly what happened during a restatement: 75 invoices deleted from Jurnal,
 * 75 entries removed locally, and the stored count never moved. The end state came out
 * right only because the rewrite overwrote each entry with its new invoice id a few
 * minutes later. Interrupted in between, the ledger would have pointed at invoices that
 * no longer existed, and the sweep - which trusts it - would have considered those orders
 * booked and never posted them again. Silently missing sales.
 *
 * So removal is its own operation, transactional, and says what it means.
 */
export async function forgetSyncLedgerEntries(customIds) {
  const doomed = new Set(customIds ?? []);
  if (doomed.size === 0) return 0;
  let removed = 0;
  await updateDoc(LEDGER_PATHNAME, (current) => {
    const orders = { ...(current?.orders ?? {}) };
    for (const id of doomed) {
      if (id in orders) { delete orders[id]; removed += 1; }
    }
    return { ...(current ?? {}), version: 1, orders, updated_at: new Date().toISOString() };
  }, { version: 1, orders: {} });
  return removed;
}

export const LOCK_PATHNAME = 'mekari/sync.lock';
const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Mutual exclusion between overlapping runs, through the state store.
 *
 * It used to be written straight to Blob, and when state moved behind the store the Blob
 * helpers went with it - leaving this function calling a `blobToken()` that no longer
 * existed in its scope. Nothing caught it because the webhook path passes lock:false, so
 * only `mekari:sync --yes` ever reached the broken line, and it failed with a bare
 * "blobToken is not defined" that says nothing about locking.
 *
 * Now it is one transactional update on the store, which on Redis is a genuine
 * compare-and-set rather than the read-then-write it was before. A run that crashes
 * mid-batch would otherwise hold the lock for good, so the holder expires; and the thing
 * that actually protects the books is still the custom_id probe before every create, not
 * this.
 */
export async function acquireLock(owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`) {
  try {
    const now = Date.now();
    let outcome = { acquired: false, owner: null, since: null, held: false };
    await updateDoc(LOCK_PATHNAME, (current) => {
      const heldBy = current?.owner ?? null;
      const since = Number(current?.at ?? 0);
      const fresh = heldBy && now - since < LOCK_TTL_MS;
      if (fresh) {
        outcome = { acquired: false, owner: heldBy, since, held: true };
        return current;
      }
      outcome = { acquired: true, owner, held: true };
      return { owner, at: now };
    }, { owner: null, at: 0 });
    return outcome;
  } catch {
    // A store we cannot reach must not stop the books being written. Two runs racing is
    // survivable - the custom_id probe makes the loser a no-op - and not posting is not.
    return { acquired: true, owner, held: false };
  }
}

/**
 * Release the lock, and only ever our own.
 *
 * It used to write {owner: null} whatever it found there, which is fine right up until a
 * run overruns the five-minute TTL: the next sweep sees an expired holder, takes the lock
 * legitimately, and then the first run finishes and clears it - leaving a third run free
 * to post the same orders the second one is halfway through. Comparing the owner inside
 * the same transaction that clears it makes a late finisher a no-op instead.
 */
export async function releaseLock(owner) {
  try {
    await updateDoc(LOCK_PATHNAME, (current) => (
      // No owner named, or somebody else's: leave it alone and let the TTL do the work.
      owner && (current?.owner ?? null) === owner ? { owner: null, at: 0 } : (current ?? { owner: null, at: 0 })
    ), { owner: null, at: 0 });
  } catch {
    // Failing to release only costs us the TTL.
  }
}


/**
 * Does this error mean Jurnal does not have that invoice?
 *
 * It answers 422 "Data not found" where most APIs answer 404. findExisting knew that from
 * the first live run; voidInvoice did not, so an invoice somebody had already deleted came
 * back as a hard failure, the ledger entry was never marked voided, and every sweep from
 * then on retried the same void forever - two requests a time out of ninety a minute, and
 * a cancelled sale never reconciled.
 */
export function isMissingInvoice(error) {
  if (error?.status === 404) return true;
  return error?.status === 422 && /not found/i.test(JSON.stringify(error?.body ?? error?.message ?? ''));
}

/** Does Jurnal already hold this order? Asked by custom_id, which it accepts as an id. */
export async function findExisting(order, { deadlineAt = null } = {}) {
  try {
    const found = await mekari({ path: `/public/jurnal/api/v1/sales_invoices/${encodeURIComponent(customIdFor(order))}`, deadlineAt });
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

/**
 * How many of a run's results actually left the backlog.
 *
 * Only an order now in the ledger has - created, already there, or stored with a number we
 * did not send, which is recorded so it is not posted again. A failure and a deferral both
 * leave the order exactly where it was, waiting for the next sweep. A dry run writes
 * nothing at all, so what it drains is simply what it managed to price.
 */
const SETTLED = new Set(['created', 'exists', 'mismatch']);
export function drained(results, { dryRun = false } = {}) {
  return results.filter((r) => (dryRun ? r.status === 'dry-run' : SETTLED.has(r.status))).length;
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

    if (recorded?.mismatch) {
      return { order, customId, state: 'broken', total: recorded.total ?? 0, invoiceId: recorded.invoice_id ?? null,
        reason: `Jurnal menyimpan Rp${Number(recorded.stored ?? 0).toLocaleString('id-ID')} - periksa faktur` };
    }
    if (recorded?.needs_review) {
      return { order, customId, state: 'broken', total: recorded.total ?? 0, invoiceId: recorded.invoice_id ?? null, reason: recorded.needs_review };
    }
    if (recorded?.voided) {
      return { order, customId, state: 'skipped', total: 0, reason: 'dibatalkan - faktur dihapus' };
    }
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
 * Post the invoice, and never let an optional field keep a sale out of the books.
 *
 * Jurnal validates the buyer's email more strictly than the standard does. It rejected
 * fitriana__adhisti@yahoo.com - a perfectly legal address, refused for its double
 * underscore - with a 422, and that one order sat outside the books through five
 * consecutive recovery runs because of a field nobody needs to file accounts.
 *
 * The email is a convenience. The invoice is the record. So when Jurnal objects to the
 * email specifically, it is dropped and the invoice is posted without it, and the fact is
 * returned so the caller can say so rather than quietly losing the buyer's address.
 * Anything else it objects to still fails, loudly, as it should.
 */
async function postInvoice(payload, { deadlineAt = null } = {}) {
  const path = '/public/jurnal/api/v1/sales_invoices';
  try {
    return await mekari({ method: 'POST', path, body: payload, deadlineAt, retryCreate: true });
  } catch (error) {
    const complainsAboutEmail = error?.status === 422
      && /email/i.test(JSON.stringify(error?.body ?? ''))
      && payload.sales_invoice.email;
    if (!complainsAboutEmail) throw error;

    const without = { sales_invoice: { ...payload.sales_invoice } };
    delete without.sales_invoice.email;
    const result = await mekari({ method: 'POST', path, body: without, deadlineAt, retryCreate: true });
    console.warn(`mekari: email ${payload.sales_invoice.email} ditolak Jurnal - faktur dibuat tanpa email`);
    return result;
  }
}

/**
 * Post one order. Returns what happened rather than throwing, so a single bad order
 * cannot stop the rest of the run.
 */
export async function postOrder(order, { depositTo = null, dryRun = true, deadlineAt = null } = {}) {
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

  // No read-before-write. Jurnal refuses a second invoice with the same custom_id with a
  // 409, which is a stronger duplicate check than any probe we could make - it is done by
  // the server, atomically, at the moment of writing - and it costs nothing extra, where
  // the probe cost one request per order out of a budget of forty a minute. The probe was
  // also blind to every Shopify order: the '#' in their ids breaks Jurnal's routing and
  // the lookup answered "not found" for invoices that plainly existed.
  //
  // Jurnal refuses an invoice naming a contact it does not hold, and every invoice now
  // names its own buyer, so the contact is made to exist first.
  try {
    await ensureContact(customerFor(order), { deadlineAt, receivableId: await receivableIdFor(order) });
  } catch (error) {
    return { customId, id: order.id, channel: order.channel, status: failureOf(error), error: `kontak gagal: ${error.message}`, monthly: Boolean(error.monthly) };
  }

  try {
    // Safe to retry, unlike batch_create: the single-invoice endpoint rejects a repeated
    // custom_id with 409 and hands back the existing id, so a retry after a timeout finds
    // the first attempt rather than making a second copy.
    const created = await postInvoice(payload, { deadlineAt });
    const invoice = created?.sales_invoice ?? created;
    // Jurnal has silently stored a different number than it was sent before - shipping
    // dropped to zero without is_shipped - and the only way to know is to read back what
    // it kept. A mismatch is recorded so the order is not re-posted into the same trap,
    // and reported so a person decides what to do with the invoice that now exists.
    const stored = Math.round(Number(invoice?.original_amount));
    if (Number.isFinite(stored) && stored !== expectedTotal) {
      return {
        customId, id: order.id, channel: order.channel, status: 'mismatch',
        invoiceId: invoice?.id, transactionNo: invoice?.transaction_no, total: expectedTotal, stored,
        error: `Jurnal menyimpan Rp${stored.toLocaleString('id-ID')}, seharusnya Rp${expectedTotal.toLocaleString('id-ID')} (faktur ${invoice?.transaction_no ?? invoice?.id})`,
      };
    }
    return {
      customId, id: order.id, channel: order.channel, status: 'created',
      invoiceId: invoice?.id, transactionNo: invoice?.transaction_no, total: expectedTotal,
    };
  } catch (error) {
    // Already in the books - a concurrent webhook or an earlier run got there first. That
    // is the idempotency working, not a failure; record it and move on.
    if (error.status === 409) {
      // Jurnal's 409 body carries the id of the invoice that already exists, but it is
      // the only error body in this API shaped that way - every other one is
      // {message}/{errors}. Recording null when it is not there looked harmless and was
      // not: an entry with no invoice_id can never be voided when the order is cancelled
      // (undoneCandidates requires one), can never be restated, and reports as cleanly
      // synced. A cancelled sale would stay in the books for good.
      //
      // So when the body does not name it, we ask - one request, against the custom_id,
      // which is what that probe is for.
      const known = error.body?.id ?? (await findExisting(order, { deadlineAt }).catch(() => null))?.id ?? null;
      if (!known) {
        return {
          customId, id: order.id, channel: order.channel, status: 'failed', total: expectedTotal,
          error: 'Jurnal bilang faktur sudah ada tapi tidak menyebut nomornya - tidak dicatat agar tidak jadi entri tanpa faktur',
        };
      }
      return { customId, id: order.id, channel: order.channel, status: 'exists', invoiceId: known, total: expectedTotal };
    }
    return { customId, id: order.id, channel: order.channel, status: failureOf(error), error: error.message, monthly: Boolean(error.monthly) };
  }
}

/**
 * Final states that undo a sale. IN_CANCEL is only a request the seller can still refuse,
 * and TO_RETURN is a dispute in progress; neither is acted on automatically.
 */
export const VOID_STATUSES = new Set(['CANCELLED']);

/** Undone, or in the middle of being undone - either way not something to leave silent. */
export const UNDONE_STAGES = new Set(['cancelled', 'returned']);

/**
 * An order that was invoiced and has since been undone.
 *
 * Without this, a buyer who cancels after paying leaves a sale in the books forever.
 * If Jurnal still lets the invoice go - nothing paid against it - it is deleted and the
 * ledger remembers that it was, so the order is never posted again. If money has been
 * received against it, deleting would hide a real payment; that one is handed to a
 * person, once, with the invoice number.
 */
export function undoneCandidates(orders, ledger) {
  return orders.filter((o) => {
    const entry = ledger.orders?.[customIdFor(o)];
    return entry && entry.invoice_id && !entry.voided && !entry.needs_review && UNDONE_STAGES.has(o.stage);
  });
}

export async function voidInvoice(order, entry, { dryRun = true, deadlineAt = null } = {}) {
  const customId = customIdFor(order);
  const base = { customId, id: order.id, channel: order.channel, invoiceId: entry.invoice_id, stage: order.stage, status: order.status };

  const final = VOID_STATUSES.has(order.status) || (order.channel === 'shopify' && order.stage === 'cancelled');
  if (!final) {
    return { ...base, outcome: 'needs_review', reason: `${order.status}: pembatalan/retur belum final, faktur dibiarkan` };
  }
  if (dryRun) return { ...base, outcome: 'dry-run' };
  if (isReadOnly()) throw new ReadOnlyError(`hapus faktur ${customId}`);

  let invoice;
  try {
    const found = await mekari({ path: `/public/jurnal/api/v1/sales_invoices/${entry.invoice_id}`, deadlineAt });
    invoice = found?.sales_invoice ?? found;
  } catch (error) {
    if (isMissingInvoice(error)) return { ...base, outcome: 'gone', reason: 'faktur sudah tidak ada di Jurnal' };
    return { ...base, outcome: failureOf(error), reason: error.message };
  }

  if (invoice.has_payments || Number(invoice.payment_received_amount) > 0 || invoice.deletable === false) {
    return {
      ...base, outcome: 'needs_review',
      reason: `pesanan ${order.status} tapi faktur ${invoice.transaction_no} sudah menerima pembayaran Rp${Math.round(Number(invoice.payment_received_amount || 0)).toLocaleString('id-ID')} - perlu retur/kredit nota manual`,
    };
  }

  try {
    await mekari({ method: 'DELETE', path: `/public/jurnal/api/v1/sales_invoices/${entry.invoice_id}`, deadlineAt });
    return { ...base, outcome: 'voided', transactionNo: invoice.transaction_no, total: Math.round(Number(invoice.original_amount)) };
  } catch (error) {
    return { ...base, outcome: failureOf(error), reason: error.message };
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
    if (held.held) await releaseLock(held.owner);
  }
}

async function runBatch({ orders, depositTo, dryRun, limit, deadlineMs = null }) {
  const ledger = await loadSyncLedger();
  // Contacts already settled with Jurnal, so a repeat buyer costs no request at all.
  rememberContacts(ledger.contacts);
  const backlog = postable(orders, ledger);
  const queue = backlog.slice(0, limit);
  const results = [];
  const stopAt = deadlineMs ? Date.now() + deadlineMs : Infinity;
  const deadlineAt = Number.isFinite(stopAt) ? stopAt : null;
  let ranOutOfTime = false;
  let quotaExhausted = false;

  for (const order of queue) {
    // Stopping early is free: the ledger already holds everything posted so far, and the
    // next run picks up exactly where this one left off. Being killed mid-POST is not
    // free, so leave room rather than racing the platform timeout.
    if (Date.now() > stopAt) { ranOutOfTime = true; break; }
    const result = await postOrder(order, { depositTo, dryRun, deadlineAt });
    results.push(result);
    if (result.monthly) {
      // Every further order would fail the same way and spend nothing but time.
      quotaExhausted = true;
      break;
    }

    if (!dryRun && (result.status === 'created' || result.status === 'exists' || result.status === 'mismatch')) {
      ledger.contacts = knownContactNames();
      ledger.orders[result.customId] = {
        invoice_id: result.invoiceId ?? null,
        channel: order.channel,
        order_id: order.id,
        total: result.total,
        at: new Date().toISOString(),
        // A wrong number in the books is recorded so it is not re-posted into the same
        // trap, and flagged so it stays visible until a person has dealt with it.
        ...(result.status === 'mismatch' ? { mismatch: true, stored: result.stored } : {}),
      };
      await saveSyncLedger(ledger);
    }
  }

  // Undone sales, with whatever budget is left. Each costs one read and, if it goes, one
  // delete; skipping them when time is short is fine because the next run sees the same
  // orders in the same state.
  const undone = [];
  for (const order of undoneCandidates(orders, ledger)) {
    if (Date.now() > stopAt || quotaExhausted) break;
    const entry = ledger.orders[customIdFor(order)];
    const outcome = await voidInvoice(order, entry, { dryRun, deadlineAt });
    undone.push(outcome);
    if (!dryRun && (outcome.outcome === 'voided' || outcome.outcome === 'gone' || outcome.outcome === 'needs_review')) {
      ledger.orders[outcome.customId] = {
        ...entry,
        ...(outcome.outcome === 'needs_review' ? { needs_review: outcome.reason } : { voided: true, voided_at: new Date().toISOString() }),
      };
      await saveSyncLedger(ledger);
    }
  }
  if (!dryRun) {
    ledger.ready_at = new Date().toISOString();
    await saveSyncLedger(ledger);
  }

  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    dryRun,
    considered: queue.length,
    posted: results.length,
    // Counted against the whole backlog, not this run's cap: the caller uses it to decide
    // whether to call again, and "nothing left of the twelve I asked for" is not "nothing
    // left". The first chained sweep stopped after one round on exactly that misreading.
    //
    // And counted from what was settled rather than from what was attempted, for the same
    // reason: eleven orders deferred by a rate limit are eleven orders still waiting, and
    // subtracting them here reported an empty backlog to a caller whose whole job was to
    // come back for them.
    remaining: backlog.length - drained(results, { dryRun }),
    ranOutOfTime,
    quotaExhausted,
    created: count('created'),
    exists: count('exists'),
    failed: count('failed'),
    // Stored in Jurnal with a number we did not send; recorded, flagged, not retried.
    mismatch: count('mismatch'),
    // Left out of the ledger on purpose; the next run takes them again.
    deferred: count('deferred'),
    results,
    undone,
    voided: undone.filter((u) => u.outcome === 'voided').length,
    needsReview: undone.filter((u) => u.outcome === 'needs_review').length,
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
  if (!dryRun && order.customer) await ensureContact(order.customer, { receivableId: await receivableIdFor(order) });
  const result = await runSync({ orders: [order], depositTo, dryRun, limit: 1, lock: false });
  return result.results[0] ?? { status: 'failed', error: 'tidak ada yang diproses' };
}

/** Codes already used by typed-in transactions, so a suggested one cannot collide. */
export function manualCodes(ledger) {
  return Object.keys(ledger.orders ?? {})
    .filter((customId) => customId.startsWith('TRL-manual-'))
    .map((customId) => customId.slice('TRL-manual-'.length));
}
