import { readCatalog } from './inventory.js';
import { LISTING_CHANNELS } from './listing.js';

/**
 * Whether a write to a channel really landed, from the channel's own answer.
 *
 * A write that returns no error is only a channel that did not object: Shopee's ship_order
 * did exactly that ten times on 261105GEVT7Q6C and changed nothing. So what the dashboard
 * tells a person comes from reading the thing back. A figure that matches stays `ok`; one
 * that does not, or cannot be read, is `unconfirmed`, with what was actually seen.
 */

/** Channels show a write a moment later, so it is read more than once before anything is said. */
export const CONFIRM_WAITS_MS = [2000, 4000];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Prices and stock, read back from the catalogue.
 *
 * @param {Array<{sku: string, channel: string, field: 'price'|'qty', to: number, status: string}>} rows
 * @returns {Promise<Array>} the same rows, with their verdicts
 */
export async function confirmCatalog(rows, { read = readCatalog, waits = CONFIRM_WAITS_MS, wait = sleep } = {}) {
  let open = rows.filter((row) => row.status === 'ok');
  const seen = new Map();
  for (let round = 0; round <= waits.length && open.length > 0; round++) {
    if (round > 0) await wait(waits[round - 1]);
    const catalog = await read().catch((error) => ({ skus: [], unread: error.message }));
    open = open.filter((row) => {
      const trouble = catalog.unread ?? catalog.errors?.[row.channel];
      if (trouble) { seen.set(row, `tidak terbaca (${String(trouble.message ?? trouble)})`); return true; }
      const listed = catalog.skus.find((e) => e.sku === row.sku)?.[row.channel]?.rows ?? [];
      if (listed.length === 0) { seen.set(row, 'tidak terbaca (listing tidak ditemukan)'); return true; }
      const wrong = listed.map((r) => Number(r[row.field])).filter((value) => value !== Number(row.to));
      if (wrong.length === 0) return false;
      seen.set(row, `masih terbaca ${wrong[0]}, seharusnya ${row.to}`);
      return true;
    });
  }
  const left = new Set(open);
  return rows.map((row) => (left.has(row)
    ? { ...row, status: 'unconfirmed', error: `channel tidak menolak, tapi ${row.field === 'price' ? 'harga' : 'stok'} ${seen.get(row)}` }
    : row));
}

const LIVE = { tiktok: 'ACTIVATE', shopee: 'NORMAL', shopify: 'ACTIVE' };
const flat = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const sameDims = (a, b) => ['l', 'w', 'h'].every((k) => Number(a?.[k]) === Number(b?.[k]));

function differences(listing, { patch = {}, active, images } = {}, channel) {
  const out = [];
  if (patch.title !== undefined && flat(listing.title) !== flat(patch.title)) out.push('judul');
  if (patch.description !== undefined && flat(listing.description) !== flat(patch.description)) out.push('deskripsi');
  if (patch.weightGram !== undefined && Number(listing.weightGram) !== Number(patch.weightGram)) out.push('berat');
  if (patch.dims !== undefined && !sameDims(listing.dims, patch.dims)) out.push('dimensi');
  if (active !== undefined && (listing.status === LIVE[channel]) !== active) out.push(`status ${listing.status || 'kosong'}`);
  if (images) {
    const now = listing.images ?? [];
    const unchanged = images.before && JSON.stringify(now) === JSON.stringify(images.before);
    if (now.length !== images.count || unchanged) out.push('foto');
  }
  return out;
}

/**
 * One listing's content or on/off state, read back from its channel.
 *
 * @param {string} channel
 * @param {object} ref
 * @param {{patch?: object, active?: boolean, images?: {count: number, before?: string[]}}} expected
 * @returns {Promise<{status: 'ok'|'unconfirmed', error?: string}>}
 */
export async function confirmListing(channel, ref, expected, { read = LISTING_CHANNELS[channel]?.read, waits = CONFIRM_WAITS_MS, wait = sleep } = {}) {
  let trouble = '';
  for (let round = 0; round <= waits.length; round++) {
    if (round > 0) await wait(waits[round - 1]);
    try {
      const wrong = differences(await read(ref), expected, channel);
      if (wrong.length === 0) return { status: 'ok' };
      trouble = `${wrong.join(', ')} belum sesuai`;
    } catch (error) {
      trouble = `listing tidak terbaca (${error.message})`;
    }
  }
  return { status: 'unconfirmed', error: `channel tidak menolak, tapi ${trouble}` };
}

/**
 * Change a listing and read it back. Pictures are compared against what the listing showed
 * before the write, so that is read first; a read that fails then only leaves the count.
 *
 * @returns {Promise<{status: 'ok'|'unconfirmed', error?: string, changed: string[]}>}
 */
export async function editAndConfirm(channel, ref, patch, images, { channels = LISTING_CHANNELS, ...timing } = {}) {
  const { edit, read } = channels[channel];
  const before = images.length ? (await read(ref).catch(() => null))?.images : undefined;
  const out = await edit(ref, patch, images);
  const expected = { patch, ...(images.length ? { images: { count: images.length, before } } : {}) };
  const seen = await confirmListing(channel, ref, expected, { read, ...timing });
  return { ...seen, changed: out.changed };
}

/** A listing just created: there, and in the state it was asked to be in. */
export function confirmPublished(channel, id, { draft = false } = {}, options = {}) {
  const ref = channel === 'shopee' ? { itemId: id } : { productId: id };
  return confirmListing(channel, ref, { active: !draft }, options);
}
