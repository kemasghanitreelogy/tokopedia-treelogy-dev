import { readDoc, updateDoc } from '../store/index.js';
import { reviewKey } from '../reviews/combined.js';

/**
 * Which reviews have already gone to Klaviyo.
 *
 * Klaviyo's import is the only way in, and it has no "skip what you already have": a
 * second file with the same reviews makes a second copy of each. Without a record here
 * the only way to send just the new ones was to guess a date range from memory - on
 * 10 Nov nobody could say whether the last file, from 21 Sep, had stopped at 11.15 or at
 * 13.00. So every download marks what it carried, and "Unduh baru" sends only what no
 * file has carried yet.
 *
 * Kept per review (channel:id) rather than as a date, because a review can arrive late:
 * Shopee hands back a buyer's rating days after the date it carries, and a cut-off date
 * would skip it for ever.
 */

export const EXPORTED_DOC = 'klaviyo/exported.json';
const EMPTY = { keys: {}, batches: [] };
/** Enough history to answer "when did I last download, and how many". */
const BATCHES_KEPT = 50;

export async function loadExported() {
  try {
    const doc = await readDoc(EXPORTED_DOC);
    return { ...EMPTY, ...(doc ?? {}), keys: doc?.keys ?? {}, batches: doc?.batches ?? [] };
  } catch {
    return structuredClone(EMPTY);
  }
}

/** Reviews no file has carried yet. */
export function notExported(reviews, ledger) {
  const keys = ledger?.keys ?? {};
  return reviews.filter((review) => keys[reviewKey(review)] === undefined);
}

/** The last download, for the note beside the buttons. */
export function lastBatch(ledger) {
  const batches = ledger?.batches ?? [];
  return batches.length ? batches[batches.length - 1] : null;
}

/** Remember that these reviews went out in one file. */
export function markExported(ledger, reviews, { at = Math.floor(Date.now() / 1000), actor = null, only = 'all' } = {}) {
  const doc = { ...EMPTY, ...(ledger ?? {}) };
  const keys = { ...(doc.keys ?? {}) };
  for (const review of reviews) keys[reviewKey(review)] ??= at;
  const batches = [...(doc.batches ?? []), { at, count: reviews.length, only, actor }].slice(-BATCHES_KEPT);
  return { ...doc, keys, batches };
}

export async function recordExport(reviews, options = {}) {
  await updateDoc(EXPORTED_DOC, (current) => markExported(current, reviews, options), structuredClone(EMPTY));
}
