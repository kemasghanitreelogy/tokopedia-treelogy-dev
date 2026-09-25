import { updateDoc } from '../store/index.js';

/**
 * One writer per order, across every process that writes to the books.
 *
 * The in-flight promise in sync.js only covers the process holding it, and there are two:
 * the web service answers webhooks, and a systemd timer runs `mekari:sync` as its own
 * process every quarter of an hour. Those two can reach the same order at the same
 * moment, and until now nothing stopped them - the sweep takes a lock for its whole run,
 * the webhook path deliberately does not take one at all.
 *
 * What made that survivable in theory was Jurnal refusing a repeated custom_id. It does
 * not: Shopee order 260924UVXBBSDM has invoices 13728 and 13729 and both carry
 * "TRL-shopee-260924UVXBBSDM". Two more pairs in the same week, all of them from pushes
 * one to three seconds apart, none of them from anything further apart. That is a check
 * that is made but not atomic, and it cannot be the thing a ledger rests on.
 *
 * So the claim is ours and it is taken before the create. `updateDoc` is a
 * compare-and-set, so exactly one caller wins it however many arrive together.
 *
 * A claim expires, because a process that dies holding one must not lock an order out of
 * the books for good. Five minutes is far longer than a post takes and far shorter than
 * the quarter hour before the next sweep, so a crash costs one sweep at most.
 */

export const CLAIMS_DOC = 'mekari/invoice-claims.json';

/** Long enough that no honest post outlives it, short enough that a crash is forgotten. */
export const CLAIM_TTL_MS = 5 * 60_000;

const EMPTY = { version: 1, claims: {} };

const fresh = (entry, now) => entry && now - Number(entry.at ?? 0) < CLAIM_TTL_MS;

/**
 * Take the right to post this invoice, or report who already has it.
 *
 * @returns {Promise<{claimed: boolean, owner?: string, since?: number, enforced: boolean}>}
 *   `enforced` is false when the store could not be reached, which is the one case where
 *   the caller proceeds unclaimed - not writing the books because a cache is down would
 *   be a worse failure than the duplicate this guards against, and the Jurnal probe
 *   behind it still catches almost all of that.
 */
export async function claimInvoice(customId, { owner = `${process.pid}-${Date.now()}`, now = Date.now() } = {}) {
  if (!customId) return { claimed: true, enforced: false };
  try {
    let outcome = { claimed: false, enforced: true };
    await updateDoc(CLAIMS_DOC, (current) => {
      const claims = { ...(current?.claims ?? {}) };
      // Expired claims are swept on the way past, so the document cannot grow without
      // bound from every order that ever crashed mid-post.
      for (const [key, entry] of Object.entries(claims)) {
        if (!fresh(entry, now)) delete claims[key];
      }

      const held = claims[customId];
      if (fresh(held, now)) {
        outcome = { claimed: false, owner: held.owner, since: held.at, enforced: true };
        return { ...EMPTY, ...current, claims };
      }

      claims[customId] = { owner, at: now };
      outcome = { claimed: true, owner, enforced: true };
      return { ...EMPTY, ...current, claims };
    }, structuredClone(EMPTY));
    return outcome;
  } catch {
    return { claimed: true, enforced: false };
  }
}

/** Give it back, and only ever our own: a claim that has since expired belongs to whoever took it next. */
export async function releaseInvoice(customId, { owner = null } = {}) {
  if (!customId) return;
  try {
    await updateDoc(CLAIMS_DOC, (current) => {
      const claims = { ...(current?.claims ?? {}) };
      const held = claims[customId];
      if (!held) return current ?? structuredClone(EMPTY);
      if (owner && held.owner !== owner) return current;
      delete claims[customId];
      return { ...EMPTY, ...current, claims };
    }, structuredClone(EMPTY));
  } catch {
    // It expires on its own. A release that could not be written costs one order a
    // five-minute wait, which is not worth failing a post that already succeeded.
  }
}

/** Only for tests and for looking: what is held right now. */
export async function heldClaims({ now = Date.now() } = {}) {
  try {
    const doc = await updateDoc(CLAIMS_DOC, (current) => current ?? structuredClone(EMPTY), structuredClone(EMPTY));
    return Object.entries(doc?.claims ?? {})
      .filter(([, entry]) => fresh(entry, now))
      .map(([customId, entry]) => ({ customId, ...entry }));
  } catch {
    return [];
  }
}
