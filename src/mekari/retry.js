import { readDoc, updateDoc } from '../store/index.js';

/**
 * The orders that did not make it into the books, and what is being done about them.
 *
 * Until now a failure left no trace anywhere. The order simply stayed out of the ledger,
 * the next sweep found it again, tried again and failed again - which is a retry, but a
 * blind one. Three things were wrong with it:
 *
 *   1. It never gave up and never slowed down. Ten Shopee orders whose SKU was missing
 *      from the master data were retried every quarter of an hour for seven days. Each
 *      attempt costs a contact check, a probe and a create, and Jurnal's binding limit is
 *      a monthly package, not a per-minute rate. That is thousands of requests spent
 *      re-learning one fact.
 *   2. It was bounded by the sweep's window. The unit runs `--7d`, so an order that keeps
 *      failing for a week falls out of the window and is never attempted again - silently,
 *      permanently, with the sale missing from the accounts and nobody told.
 *   3. Nothing said how long a failure had been going on. Every sweep reported it as if it
 *      were new, so an outage that fixes itself in ten minutes and a mapping bug that has
 *      been losing sales since Tuesday read exactly the same.
 *
 * So failures are written down. Each entry carries how many times it has been tried, when
 * it first failed, what the error was, and when it is next due. The sweep reads this book
 * as well as its window, so nothing ages out; it honours the backoff, so a hopeless order
 * stops burning quota; and it escalates to Telegram once an order has been tried enough
 * times to know the problem is not going to clear on its own.
 *
 * An entry is removed the moment the order reaches the books, whether this sweep put it
 * there or the last one did.
 */

export const RETRY_DOC = 'mekari/retry.json';

/**
 * How long to wait before trying again, by the number of attempts already made.
 *
 * The first retry is immediate - the next sweep, a quarter of an hour later - because
 * most failures are a moment's bad weather and waiting on those helps nobody. It widens
 * from there, and stops widening at two hours.
 *
 * Two hours, and not a day, because the far end of this schedule is where an operator is
 * waiting. Somebody who has just added the missing SKU should not have to wait until
 * tomorrow to find out whether it worked, and twelve attempts a day is not a load worth
 * optimising away.
 */
export const BACKOFF_MINUTES = [0, 15, 30, 60, 120];

/** After this many failed attempts, a person is told. Roughly an hour of trying. */
export const ALERT_AFTER_ATTEMPTS = 3;

const EMPTY = { version: 1, orders: {} };

/** A settled order is one the books now hold; it leaves the book however it got there. */
const SETTLED = new Set(['created', 'exists', 'mismatch']);

export function backoffMs(attempts) {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[index] * 60_000;
}

export async function loadRetryBook() {
  try {
    const stored = await readDoc(RETRY_DOC);
    return { ...EMPTY, ...(stored ?? {}), orders: { ...(stored?.orders ?? {}) } };
  } catch {
    // A book that cannot be read must never stop the sweep. Without it the sweep behaves
    // exactly as it did before this module existed, which is the right thing to fall back
    // to: it tries everything in its window, every run.
    return structuredClone(EMPTY);
  }
}

/** Whether this order may be attempted now, or is serving its backoff. */
export function isDue(entry, now = Date.now()) {
  if (!entry) return true;
  return Number(entry.next_at ?? 0) <= now;
}

/**
 * Update the book from a run's results.
 *
 * Takes the orders too, so an entry can carry enough of the sale to be actionable in a
 * Telegram message without anybody having to go and look the order up.
 */
export async function recordOutcomes(results = [], { orders = [], now = Date.now() } = {}) {
  const byCustomId = new Map();
  for (const order of orders) byCustomId.set(`${order.channel}:${order.id}`, order);

  const failures = results.filter((r) => r.status === 'failed');
  const settled = results.filter((r) => SETTLED.has(r.status));
  if (failures.length === 0 && settled.length === 0) return { failing: 0, cleared: 0 };

  let cleared = 0;
  const book = await updateDoc(RETRY_DOC, (current) => {
    const entries = { ...(current?.orders ?? {}) };

    for (const done of settled) {
      if (entries[done.customId]) { delete entries[done.customId]; cleared += 1; }
    }

    for (const fail of failures) {
      const held = entries[fail.customId];
      const order = byCustomId.get(`${fail.channel}:${fail.id}`) ?? null;
      const attempts = Number(held?.attempts ?? 0) + 1;
      entries[fail.customId] = {
        channel: fail.channel ?? held?.channel ?? null,
        order_id: fail.id ?? held?.order_id ?? null,
        attempts,
        first_failed_at: held?.first_failed_at ?? new Date(now).toISOString(),
        last_at: new Date(now).toISOString(),
        next_at: now + backoffMs(attempts),
        error: String(fail.error ?? 'tanpa alasan').slice(0, 400),
        // Kept so the alert can say what is at stake without a second read of anything.
        total: order?.total ?? held?.total ?? null,
        customer: order?.customer ?? order?.buyer ?? held?.customer ?? null,
        ordered_at: order?.createdAt ?? held?.ordered_at ?? null,
        // Preserved: an alert already sent must not be sent again for the same attempt.
        alerted_attempts: held?.alerted_attempts ?? 0,
        alerted_at: held?.alerted_at ?? null,
      };
    }

    return { ...EMPTY, ...current, orders: entries, updated_at: new Date(now).toISOString() };
  }, structuredClone(EMPTY)).catch(() => null);

  return { failing: Object.keys(book?.orders ?? {}).length, cleared };
}

/**
 * Orders the sweep must take even though its window has moved past them.
 *
 * This is what closes the seam. The unit runs `--7d`; an order that keeps failing for
 * eight days is outside it and, without this, gone for good.
 */
export function overdue(book, { now = Date.now() } = {}) {
  return Object.entries(book?.orders ?? {})
    .filter(([, entry]) => isDue(entry, now))
    .map(([customId, entry]) => ({ customId, channel: entry.channel, id: entry.order_id, ...entry }));
}

/**
 * Failures that have been tried enough times to be worth waking somebody for.
 *
 * Alerted once per attempt, not once per sweep: a sweep that skips an order because its
 * backoff has not elapsed has learned nothing new, and a message that repeats what the
 * last one said is how an alert channel gets muted.
 */
export function escalations(book, { now = Date.now(), minAttempts = ALERT_AFTER_ATTEMPTS } = {}) {
  return Object.entries(book?.orders ?? {})
    .filter(([, entry]) => Number(entry.attempts ?? 0) >= minAttempts)
    .filter(([, entry]) => Number(entry.attempts ?? 0) > Number(entry.alerted_attempts ?? 0))
    .map(([customId, entry]) => ({ customId, ...entry }))
    .sort((a, b) => String(a.first_failed_at).localeCompare(String(b.first_failed_at)));
}

/** Remember that these were reported, at the attempt count they were reported at. */
export async function markAlerted(customIds = [], { now = Date.now() } = {}) {
  if (customIds.length === 0) return;
  const wanted = new Set(customIds);
  await updateDoc(RETRY_DOC, (current) => {
    const entries = { ...(current?.orders ?? {}) };
    for (const customId of wanted) {
      if (!entries[customId]) continue;
      entries[customId] = {
        ...entries[customId],
        alerted_attempts: entries[customId].attempts ?? 0,
        alerted_at: new Date(now).toISOString(),
      };
    }
    return { ...EMPTY, ...current, orders: entries };
  }, structuredClone(EMPTY)).catch(() => {});
}

/**
 * Let everything be tried again at once, ignoring the backoff.
 *
 * For the operator who has just fixed the cause - added the missing SKU, corrected the
 * address - and does not want to wait out a schedule that was designed for an outage
 * nobody is attending to.
 */
export async function retryNow() {
  const book = await updateDoc(RETRY_DOC, (current) => {
    const entries = {};
    for (const [customId, entry] of Object.entries(current?.orders ?? {})) {
      entries[customId] = { ...entry, next_at: 0 };
    }
    return { ...EMPTY, ...current, orders: entries };
  }, structuredClone(EMPTY)).catch(() => null);
  return Object.keys(book?.orders ?? {}).length;
}

/** Drop an entry by hand, for a sale that is never going to be invoiced. */
export async function forgetRetry(customId) {
  await updateDoc(RETRY_DOC, (current) => {
    const entries = { ...(current?.orders ?? {}) };
    delete entries[customId];
    return { ...EMPTY, ...current, orders: entries };
  }, structuredClone(EMPTY)).catch(() => {});
}
