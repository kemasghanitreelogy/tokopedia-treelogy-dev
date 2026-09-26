import { readDoc, updateDoc } from '../store/index.js';

/**
 * What is left of the month's package, counted here because Jurnal will not say.
 *
 * The per-minute limiter next door solves a different problem: it stops a burst from
 * earning a 429. It has never known how much of the month is gone, so nothing stopped a
 * run of scans from spending a fortnight's worth of allowance in an afternoon - which is
 * how the account reached 10,886 of 12,000 with fifteen days still to go.
 *
 * `GET /public/jurnal/sales_invoices/quota` answers 404; the figure exists only in the
 * Mekari console. So the operator types it in and this counts down from it. A number
 * entered by hand and decremented honestly is worth more than a number nobody has.
 *
 * Two ideas make it useful rather than merely accurate:
 *
 *   A reserve. Posting today's sales is the one thing that must not stop, so everything
 *   else - a corpus scan, a dedupe, an audit - refuses once the remainder falls to the
 *   reserve. The books keep being written after the tools have stopped.
 *
 *   A daily ration. Fifteen days of allowance spent in one is the failure this exists to
 *   prevent, so a caller can ask whether today's share is gone rather than only whether
 *   the month's is.
 */

export const BUDGET_DOC = 'mekari/budget.json';

/** Below this, only posting invoices may spend. */
export const RESERVE = 150;

const EMPTY = { version: 1, remaining: null, at: null, renewsOn: null, spent: {} };

const day = (now) => new Date(now).toISOString().slice(0, 10);

/**
 * The remainder, or null when nobody has entered one.
 *
 * Written out rather than left to `Number()`, which turns null into 0 - and 0 is exactly
 * the reading that stops the books being written. An unset budget blocked every invoice
 * the first time this shipped, which is the failure the comment above it warned against.
 */
function known(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function loadBudget() {
  try {
    return { ...EMPTY, ...((await readDoc(BUDGET_DOC)) ?? {}) };
  } catch {
    return structuredClone(EMPTY);
  }
}

/**
 * Tell the counter what the console says. Everything else is derived from this.
 *
 * @param {{remaining: number, renewsOn?: string|null}} reading
 */
export async function setBudget({ remaining, renewsOn = null }, { now = Date.now() } = {}) {
  return updateDoc(BUDGET_DOC, (current) => ({
    ...EMPTY, ...(current ?? {}),
    remaining: Math.max(0, Math.floor(Number(remaining) || 0)),
    renewsOn: renewsOn ?? current?.renewsOn ?? null,
    at: new Date(now).toISOString(),
  }), structuredClone(EMPTY));
}

/**
 * How many requests a day may have, if the rest of the month is to be survivable.
 *
 * Null when nobody has told us the remainder or when the package has no known renewal -
 * an unknown budget must read as unknown rather than as zero, or a missing setting would
 * stop the books being written.
 */
export function dailyRation(budget, { now = Date.now() } = {}) {
  const remaining = known(budget?.remaining);
  if (remaining === null) return null;
  const renews = Date.parse(`${budget?.renewsOn ?? ''}T00:00:00Z`);
  if (!Number.isFinite(renews)) return null;
  const daysLeft = Math.max(1, Math.ceil((renews - now) / 86_400_000));
  return Math.floor(remaining / daysLeft);
}

/**
 * Take one request's worth, or refuse.
 *
 * `essential` is what may dip into the reserve: writing an invoice for a sale that has
 * already happened. A scan is never essential, however much somebody wants the answer.
 *
 * Refusing is reported, never thrown from here - the caller decides whether a refusal
 * means "stop the run" or "skip this one", and those are different for a sweep and for a
 * dedupe.
 *
 * @returns {Promise<{allowed: boolean, remaining: number|null, reason?: string}>}
 */
export async function spend(count = 1, { essential = false, now = Date.now() } = {}) {
  let outcome = { allowed: true, remaining: null };
  try {
    await updateDoc(BUDGET_DOC, (current) => {
      const doc = { ...EMPTY, ...(current ?? {}) };
      const remaining = known(doc.remaining);

      // Nobody has entered a figure. Counting spend is still useful - it is what tells
      // an operator what a day actually costs - but it must not gate anything.
      if (remaining === null) {
        outcome = { allowed: true, remaining: null };
        return { ...doc, spent: bump(doc.spent, now, count) };
      }

      const floor = essential ? 0 : RESERVE;
      if (remaining - count < floor) {
        outcome = {
          allowed: false,
          remaining,
          reason: essential
            ? `kuota bulanan Jurnal habis (${remaining} tersisa)`
            : `sisa kuota ${remaining} di bawah cadangan ${RESERVE} - hanya posting faktur yang boleh jalan`,
        };
        return doc;
      }

      outcome = { allowed: true, remaining: remaining - count };
      return { ...doc, remaining: remaining - count, spent: bump(doc.spent, now, count) };
    }, structuredClone(EMPTY));
  } catch {
    // A counter that cannot be read must never stop the books being written. The
    // per-minute limiter still applies, and the console still has the real figure.
    return { allowed: true, remaining: null };
  }
  return outcome;
}

/** Kept per day, and only the last fortnight of them: this is a gauge, not a ledger. */
function bump(spent, now, count) {
  const key = day(now);
  const next = { ...(spent ?? {}), [key]: (spent?.[key] ?? 0) + count };
  const keys = Object.keys(next).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - 14))) delete next[old];
  return next;
}
