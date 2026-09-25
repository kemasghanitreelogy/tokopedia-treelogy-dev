import { readDoc, updateDoc } from '../store/index.js';
import { mekari, isMekariConfigured, MekariError, QuotaExhaustedError } from './client.js';
import { claimInvoice, releaseInvoice } from './claim.js';
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
export function syncOverview({ orders, ledger, accounts = null }) {
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
      const built = buildInvoice({ order, accounts });
      verifyInvoice({ sales_invoice: built.sales_invoice }, built.expectedTotal, order);
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
    return await mekari({ method: 'POST', path, body: payload, deadlineAt });
  } catch (error) {
    const complainsAboutEmail = error?.status === 422
      && /email/i.test(JSON.stringify(error?.body ?? ''))
      && payload.sales_invoice.email;
    if (!complainsAboutEmail) throw error;

    const without = { sales_invoice: { ...payload.sales_invoice } };
    delete without.sales_invoice.email;
    const result = await mekari({ method: 'POST', path, body: without, deadlineAt });
    console.warn(`mekari: email ${payload.sales_invoice.email} ditolak Jurnal - faktur dibuat tanpa email`);
    return result;
  }
}

/**
 * One post at a time per order, for the whole process.
 *
 * Shopee sent two pushes for order 260924UVXBBSDM a second apart. Both read the ledger
 * before either had written to it, both posted, and Jurnal made invoices 13728 and 13729
 * - same customer, same Rp395.000, same day, and the same custom_id on both. The second
 * one should have been refused; see the note in postOrder about why it was not.
 *
 * Sharing the promise makes the second caller wait for the first and then see the ledger
 * entry it wrote, which is the same guard the Shopee session and the TikTok token refresh
 * already use for the same reason.
 */
const posting = new Map();

/** Only for tests: forget any post believed to be in flight. */
export const resetPostGuard = () => posting.clear();

/**
 * Post one order. Returns what happened rather than throwing, so a single bad order
 * cannot stop the rest of the run.
 */
export async function postOrder(order, options = {}) {
  const key = customIdFor(order);
  const running = posting.get(key);
  if (running) return running;

  const attempt = postWithClaim(order, key, options).finally(() => posting.delete(key));
  posting.set(key, attempt);
  return attempt;
}

/**
 * The same exclusion again, one level out, because there is more than one process.
 *
 * The map above covers the web service answering webhooks. A systemd timer runs the sweep
 * as its own process every quarter of an hour, and those two can reach one order at the
 * same moment - the sweep takes a lock for its whole run, the webhook path takes none.
 * The claim is held in the store, so whichever gets there first is the only one posting.
 *
 * Losing the claim is not a failure. The order is not going anywhere: either the holder
 * is writing the invoice this second, or its claim expires and the next sweep picks the
 * order up. Saying "busy" and moving on is the honest answer, and it keeps the loser from
 * reporting a create that was somebody else's.
 */
async function postWithClaim(order, customId, options) {
  if (options.dryRun) return postOrderUncoordinated(order, options);

  const claim = await claimInvoice(customId);
  if (!claim.claimed) {
    // It may already be written. Asking costs one request and turns a "come back later"
    // into a settled answer whenever the other process has finished.
    const already = await findExisting(order, { deadlineAt: options.deadlineAt ?? null }).catch(() => null);
    if (already?.id) {
      return { customId, id: order.id, channel: order.channel, status: 'exists', invoiceId: already.id };
    }
    return {
      customId, id: order.id, channel: order.channel, status: 'busy',
      error: 'sedang diposting proses lain - dilewati, bukan gagal',
    };
  }

  try {
    return await postOrderUncoordinated(order, options);
  } finally {
    if (claim.enforced) await releaseInvoice(customId, { owner: claim.owner });
  }
}

async function postOrderUncoordinated(order, { accounts = null, dryRun = true, deadlineAt = null } = {}) {
  const customId = customIdFor(order);
  let payload;
  let expectedTotal;

  try {
    const built = buildInvoice({ order, accounts });
    payload = { sales_invoice: built.sales_invoice };
    expectedTotal = built.expectedTotal;
    // Checked against the order before sending: a mapping slip must never reach the books.
    verifyInvoice(payload, expectedTotal, order);
  } catch (error) {
    return { customId, id: order.id, channel: order.channel, status: 'failed', error: error.message };
  }

  if (dryRun) {
    return { customId, id: order.id, channel: order.channel, status: 'dry-run', total: expectedTotal, payload };
  }
  if (isReadOnly()) throw new ReadOnlyError(`faktur ${customId}`);

  // Read before write, because Jurnal's 409 does not actually guard this.
  //
  // This used to say the opposite: that a repeated custom_id is refused by the server,
  // atomically, and that a probe was a wasted request. Shopee order 260924UVXBBSDM
  // disproved it - invoices 13728 and 13729, same customer, same Rp395.000, same day, and
  // both carrying custom_id "TRL-shopee-260924UVXBBSDM". Jurnal took both. The one time
  // the constraint was seen to fail before this, the '#' in a Shopify id was blamed and
  // the id was normalised; there is no '#' here, so the constraint simply is not one.
  //
  // The old objection to probing was cost, one request per order out of forty a minute.
  // It only runs on the create path, which is a few dozen orders a day, and the other
  // objection - that the lookup was blind to Shopify ids - went away with the '#'.
  const already = await findExisting(order, { deadlineAt }).catch(() => null);
  if (already?.id) {
    return { customId, id: order.id, channel: order.channel, status: 'exists', invoiceId: already.id, total: expectedTotal };
  }

  // Jurnal refuses an invoice naming a contact it does not hold, and every invoice now
  // names its own buyer, so the contact is made to exist first.
  try {
    await ensureContact(customerFor(order), { deadlineAt, receivableId: await receivableIdFor(order) });
  } catch (error) {
    return { customId, id: order.id, channel: order.channel, status: failureOf(error), error: `kontak gagal: ${error.message}`, monthly: Boolean(error.monthly) };
  }

  try {
    // Not retried on a timeout, and this is a correction.
    //
    // The retry here used to be opted into, on the grounds that the single-invoice
    // endpoint rejects a repeated custom_id with 409 and so a retry would find the first
    // attempt rather than make a second copy. That is not true. Invoices 13728 and 13729
    // both carry "TRL-shopee-260924UVXBBSDM"; the constraint is checked but not atomic,
    // and a timeout after Jurnal has already stored the invoice would have retried
    // straight into a duplicate - the same way 472 invoices once became 891.
    //
    // So a create that gets no answer raises UncertainWriteError, and the branch below
    // resolves the uncertainty by asking Jurnal instead of guessing.
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
    // No answer came back. The invoice may well be in Jurnal - what went missing is the
    // response, not the work - so we ask, and if it is not there yet we leave the order
    // exactly where it was. The next sweep probes again before it writes anything, which
    // turns "we do not know" into a settled answer without ever risking a second copy.
    if (error?.uncertain) {
      const landed = await findExisting(order, { deadlineAt }).catch(() => null);
      if (landed?.id) {
        return { customId, id: order.id, channel: order.channel, status: 'exists', invoiceId: landed.id, total: expectedTotal };
      }
      return {
        customId, id: order.id, channel: order.channel, status: 'deferred', total: expectedTotal,
        error: `${error.message} - belum ketemu di Jurnal, dicoba lagi di sweep berikutnya`,
      };
    }

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

/**
 * Outcomes that are written into the ledger entry, and the ones deliberately absent.
 *
 * 'pending' is not here: a cancellation the seller can still refuse must leave no trace,
 * because undoneCandidates skips any entry carrying needs_review and flagging one latched
 * the order out of every later sweep - the invoice stayed in the books after the
 * cancellation went final, and the dashboard called the order broken for good. 'failed'
 * and 'deferred' are absent for the older reason: the next run sees the same order in the
 * same state and tries again.
 */
export const RECORDED_UNDONE = new Set(['voided', 'gone', 'needs_review']);

export async function voidInvoice(order, entry, { dryRun = true, deadlineAt = null, call = mekari } = {}) {
  const customId = customIdFor(order);
  const base = { customId, id: order.id, channel: order.channel, invoiceId: entry.invoice_id, stage: order.stage, status: order.status };

  const final = VOID_STATUSES.has(order.status) || (order.channel === 'shopify' && order.stage === 'cancelled');
  if (!final) {
    // 'pending', not 'needs_review', and the difference is the whole point.
    //
    // A needs_review is written into the ledger entry, and undoneCandidates skips anything
    // carrying one - so flagging an IN_CANCEL this way latched the order out of every
    // later sweep. When the buyer's request went through a day later and the status became
    // CANCELLED, nothing looked at it again: the invoice stayed in the books for a sale
    // that no longer existed, and the dashboard showed the order as "broken" for good on
    // the strength of a cancellation request that had long since resolved itself.
    //
    // Nothing is written for a pending one. It is simply not final yet, and the next sweep
    // reads the same order and decides again.
    return { ...base, outcome: 'pending', reason: `${order.status}: pembatalan/retur belum final, faktur dibiarkan` };
  }
  if (dryRun) return { ...base, outcome: 'dry-run' };
  if (isReadOnly()) throw new ReadOnlyError(`hapus faktur ${customId}`);

  let invoice;
  try {
    const found = await call({ path: `/public/jurnal/api/v1/sales_invoices/${entry.invoice_id}`, deadlineAt });
    invoice = found?.sales_invoice ?? found;
  } catch (error) {
    if (isMissingInvoice(error)) return { ...base, outcome: 'gone', reason: 'faktur sudah tidak ada di Jurnal' };
    return { ...base, outcome: failureOf(error), reason: error.message };
  }

  // Whether money has been received against this invoice - and, separately, whether Jurnal
  // said anything about it at all.
  //
  // This used to be one expression: `invoice.has_payments ||
  // Number(invoice.payment_received_amount) > 0 || invoice.deletable === false`. On a
  // response carrying none of the three that reads `undefined || NaN > 0 || undefined ===
  // false`, which is false, and the invoice is deleted - absence of evidence taken for
  // evidence of absence, on the single check standing between a received payment and its
  // erasure. A field renamed on Jurnal's side, or a leaner body on this endpoint than on
  // the list, and a real payment vanishes with nothing to say it ever existed; a bank
  // reconciliation months later is what would find it. postOrder was hardened the same way
  // when it started asking Number.isFinite before believing a figure Jurnal sent back.
  // Absent is not zero. `payment_received_amount || 0` made a response that never
  // mentioned payments look like one reporting none, which is the same mistake in a
  // different place: absence of evidence read as evidence of absence.
  const stated = invoice.payment_received_amount;
  const received = stated === undefined || stated === null || stated === ''
    ? null
    : Math.round(Number(stated));
  // has_payments is true on every invoice this system writes, so it cannot mean anything.
  //
  // A marketplace order is settled by the platform before it ships, so its invoice is
  // created with a deposit - and Jurnal records that deposit as a payment. Reading
  // has_payments as "somebody has paid, do not touch this" therefore blocked the
  // cancellation of every marketplace sale there has ever been, which is the normal path
  // and not an edge case. Two cancelled TikTok orders sat in the books as revenue for a
  // day with a needs_review reading "sudah menerima pembayaran Rp0" - a sentence that
  // states its own contradiction.
  //
  // What actually has to be protected is a payment somebody recorded separately, which has
  // a counterpart in the bank and would be erased with the invoice. That is
  // payment_received_amount, and it is zero here. Jurnal's own `deletable` is the second
  // authority: when it says false, something it knows about is in the way.
  const settled = (received ?? 0) > 0 || invoice.deletable === false;
  // Evidence that Jurnal answered the question rather than omitting the fields. Any one of
  // the three is enough; none of them is not permission.
  const answered = invoice.has_payments === false
    || Number.isFinite(received)
    || typeof invoice.deletable === 'boolean';
  if (settled || !answered) {
    return {
      ...base, outcome: 'needs_review',
      reason: settled
        ? `pesanan ${order.status} tapi faktur ${invoice.transaction_no} sudah menerima pembayaran Rp${Math.round(Number(invoice.payment_received_amount || 0)).toLocaleString('id-ID')} - perlu retur/kredit nota manual`
        : `faktur ${invoice.transaction_no ?? entry.invoice_id} tidak menyebut status pembayaran - tidak dihapus tanpa bukti bahwa belum ada pembayaran`,
    };
  }

  try {
    await call({ method: 'DELETE', path: `/public/jurnal/api/v1/sales_invoices/${entry.invoice_id}`, deadlineAt });
    // An amount Jurnal did not send as a number must not become one: Math.round(NaN) is
    // NaN, NaN serialises to null, and a voided sale worth "nothing" is indistinguishable
    // from a real zero in every report that adds these up. Null says unknown out loud.
    const amount = Math.round(Number(invoice.original_amount));
    return { ...base, outcome: 'voided', transactionNo: invoice.transaction_no ?? null, total: Number.isFinite(amount) ? amount : null };
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
export async function runSync({ orders, accounts = null, dryRun = true, limit = 50, lock = !dryRun, deadlineMs = null } = {}) {
  if (!isMekariConfigured()) throw new MekariError('kredensial Mekari belum diisi');

  // A dry run reads only, so it never queues behind a live one.
  const held = lock ? await acquireLock() : { acquired: true, held: false };
  if (!held.acquired) {
    return { dryRun, skipped: 'terkunci', lockedSince: held.since, considered: 0, created: 0, exists: 0, failed: 0, results: [] };
  }

  try {
    return await runBatch({ orders, accounts, dryRun, limit, deadlineMs });
  } finally {
    if (held.held) await releaseLock(held.owner);
  }
}

async function runBatch({ orders, accounts, dryRun, limit, deadlineMs = null }) {
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
    const result = await postOrder(order, { accounts, dryRun, deadlineAt });
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
    if (!dryRun && RECORDED_UNDONE.has(outcome.outcome)) {
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
    // Cancellations and returns still in progress. Counted, never recorded: the next sweep
    // takes the same orders again and they stay visible until the platform makes up its
    // mind, which is the opposite of what flagging them in the ledger used to do.
    pending: undone.filter((u) => u.outcome === 'pending').length,
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
export async function postManual({ order, accounts = null, dryRun = true }) {
  if (!dryRun && order.customer) {
    await ensureContact(order.customer, {
      receivableId: await receivableIdFor(order),
      details: { phone: order.buyerPhone, email: order.buyerEmail, address: order.shipTo },
    });
  }
  const result = await runSync({ orders: [order], accounts, dryRun, limit: 1, lock: false });
  return result.results[0] ?? { status: 'failed', error: 'tidak ada yang diproses' };
}

/** Codes already used by typed-in transactions, so a suggested one cannot collide. */
export function manualCodes(ledger) {
  return Object.keys(ledger.orders ?? {})
    .filter((customId) => customId.startsWith('TRL-manual-'))
    .map((customId) => customId.slice('TRL-manual-'.length));
}
