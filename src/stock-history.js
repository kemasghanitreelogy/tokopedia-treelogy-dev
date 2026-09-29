import { updateDoc, readDoc } from './store/index.js';
import { numberOrNull } from './numbers.js';

/**
 * What every listing held, every half hour, so a drop can be pinned to a time.
 *
 * Eight listings went from 172 to 71 between one day's top-up and the next, across two
 * marketplaces, while exactly one unit of those SKUs sold. Shopee accepted the write
 * cleanly - success_list populated, failure_list empty - and the value held for hours
 * when read back. So the writes land, and something takes them away again, and nothing
 * we keep could say when.
 *
 * A number that is only ever read when somebody complains is a number with no history.
 * This is the history: one row per catalogue read, every SKU and channel in it, kept for
 * a few days. The top-up already reads the catalogue every half hour, so the samples cost
 * no marketplace calls at all - they are what that read already knew, written down.
 *
 * Deliberately recorded twice around a write: once from the figures the plan was built
 * from, once from the figures after. Without both, our own top-up looks exactly like the
 * thing we are hunting.
 */

export const HISTORY_DOC = 'inventory/history.json';

/** A few days at half-hourly, which is longer than any hunt should need. */
export const MAX_SAMPLES = 240;

const EMPTY = { version: 1, samples: [] };

/** One flat map, because a sample is a lookup and never a document to read by eye. */
export function snapshot(catalog) {
  const qty = {};
  for (const entry of catalog?.skus ?? []) {
    for (const channel of ['tiktok', 'shopee', 'shopify']) {
      const bucket = entry[channel];
      if (!bucket) continue;
      const n = numberOrNull(bucket.qty);
      if (n !== null) qty[`${entry.sku}|${channel}`] = n;
    }
  }
  return qty;
}

/**
 * @param {object} catalog from readCatalog()
 * @param {{note?: string, now?: number}} options `note` says what the reading is next to -
 *   "sebelum tulis", "sesudah tulis", "sapuan" - because a drop recorded either side of
 *   our own write means two different things.
 */
export async function recordSample(catalog, { note = '', now = Date.now() } = {}) {
  const qty = snapshot(catalog);
  if (Object.keys(qty).length === 0) return null;

  const sample = { at: now, note, qty };
  await updateDoc(HISTORY_DOC, (current) => {
    const samples = [...(current?.samples ?? []), sample].slice(-MAX_SAMPLES);
    return { ...EMPTY, ...current, samples };
  }, structuredClone(EMPTY)).catch((error) => {
    // A missing sample is a gap in a hunt, never a reason to stop topping listings up.
    console.warn(`stok: sampel riwayat tidak tersimpan - ${error.message}`);
  });
  return sample;
}

export async function loadHistory() {
  try {
    return { ...EMPTY, ...((await readDoc(HISTORY_DOC)) ?? {}) };
  } catch {
    return structuredClone(EMPTY);
  }
}

/**
 * Every fall between one sample and the next.
 *
 * Rises are not listed. A rise is either our own top-up, which the note beside it names,
 * or somebody restocking by hand - neither is what anybody is looking for. A fall is the
 * thing to explain, and the only honest explanation is a sale.
 */
export function drops(history, { minDrop = 1 } = {}) {
  const samples = history?.samples ?? [];
  const found = [];

  for (let i = 1; i < samples.length; i += 1) {
    const before = samples[i - 1];
    const after = samples[i];
    for (const [key, was] of Object.entries(before.qty ?? {})) {
      const now = after.qty?.[key];
      if (now === undefined) continue;
      const fell = was - now;
      if (fell < minDrop) continue;
      const [sku, channel] = key.split('|');
      found.push({
        sku, channel, from: was, to: now, fell,
        at: after.at, since: before.at,
        note: after.note || '',
      });
    }
  }
  return found.sort((a, b) => b.at - a.at || b.fell - a.fell);
}
