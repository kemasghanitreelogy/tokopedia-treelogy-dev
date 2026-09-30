import { fetchOrdersByIds } from './omni.js';
import { saveOrders, ordersByIds } from './db/orders.js';
import { fetchOrderByGid } from './shopify/shop.js';
import { isSupabaseConfigured } from './db/client.js';
import { invalidate } from './cache.js';

/**
 * Bringing our copy of an order back in line with the platform, after we changed it.
 *
 * Every screen here is drawn from our own table rather than from the marketplaces, which
 * is what makes the dashboard fast and what makes it survive a platform being down. The
 * price of that is a rule with no exceptions: anything that changes an order on a
 * platform has to tell the table, or the screen keeps describing the moment before.
 *
 * It was not a rule, and it cost exactly what you would expect. Two Shopee parcels were
 * arranged at 10:28 and Shopee had them PROCESSED one second later; our row still said
 * READY_TO_SHIP from a read at 10:05, nothing updated it, and they sat in "perlu diatur"
 * while the operator pressed the button ten times in ninety seconds. The webhook is the
 * usual messenger, and Shopee's pushes are not dependable here.
 *
 * So this lives next to the writes rather than next to the callers: `runAction` and
 * `massArrange` finish by calling it, and a future write path that forgets is a write
 * path that never gets to forget, because the function that performs the write is the
 * one that reconciles.
 */

/** Re-read these orders from their platforms and store what comes back. */
export async function refreshOrders(selection, { read = fetchOrdersByIds, save = saveOrders, hasDatabase = isSupabaseConfigured } = {}) {
  const wanted = (selection ?? [])
    .map(({ channel, id }) => ({ channel: String(channel ?? ''), id: String(id ?? '') }))
    .filter((row) => row.channel && row.id);
  if (wanted.length === 0) return { refreshed: 0, orders: [] };

  // The cache goes either way. It is keyed by range and the rows behind it have just
  // changed, so serving the old answer is wrong whether or not the re-read worked.
  try {
    // A typed-in sale has no platform to ask; it only ever lived in our table.
    const askable = wanted.filter((row) => row.channel !== 'manual');
    if (askable.length === 0 || !hasDatabase()) return { refreshed: 0, orders: [] };

    const { orders } = await read(askable);
    if (orders.length > 0) await save(orders, { source: 'refresh' });
    // Handed back as well as stored, so a caller refreshing rows it is about to draw can
    // use them without a second trip through the database and its cache.
    return { refreshed: orders.length, missing: askable.length - orders.length, orders };
  } catch (error) {
    // The platform write already happened and must not be reported as failed because the
    // read after it did not. The sweep picks these up within the quarter hour.
    console.warn(`orders: gagal menyegarkan ${wanted.length} pesanan - ${error.message}`);
    return { refreshed: 0, orders: [], error: error.message };
  } finally {
    invalidate('orders');
  }
}

/* --------------------------------------------------- one order, on request */

/**
 * The fields a person would notice had changed, in the words they would use.
 *
 * Not every field: `fetchedAt` moves on every read and a diff that mentions it is a diff
 * nobody finishes reading. These are the ones a packer or an accountant would act on.
 */
const WATCHED = [
  ['status', 'status platform'],
  ['stage', 'tahap'],
  ['total', 'total'],
  ['buyer', 'pembeli'],
  ['buyerPhone', 'telepon'],
  ['buyerEmail', 'email'],
  ['shipTo', 'alamat'],
  ['carrier', 'kurir'],
  ['tracking', 'resi'],
  ['note', 'catatan'],
];

/** Lines as one comparable sentence: what, how many, order-independent. */
const lineSummary = (lines) => (lines ?? [])
  .map((line) => `${line.sku || line.name || '?'}×${Number(line.qty) || 0}`)
  .sort()
  .join(', ');

/**
 * What changed between the copy we held and the copy the platform just gave us.
 *
 * The point of the button is the answer to "did somebody change this order?", so the
 * answer is what comes back - not a silent success that leaves the operator comparing two
 * screens by eye.
 */
export function diffOrder(before, after) {
  const changes = [];
  if (!before) return changes;

  for (const [key, label] of WATCHED) {
    const from = String(before[key] ?? '');
    const to = String(after?.[key] ?? '');
    if (from !== to) changes.push({ field: label, from, to });
  }

  const was = lineSummary(before.lines);
  const now = lineSummary(after?.lines);
  if (was !== now) changes.push({ field: 'produk', from: was, to: now });

  return changes;
}

/** Changes that make a label already on paper wrong, rather than merely out of date. */
export const RESHIPS = new Set(['produk', 'alamat', 'pembeli']);

/**
 * Re-read one order from its platform, right now, because somebody asked.
 *
 * The sweep and the webhooks keep the table in line on their own, and they are enough
 * until a person edits an order in the Shopify admin - swapping a product, fixing an
 * address - because that is a change our copy has no reason to expect. The bench is then
 * looking at the moment before, with no way to tell.
 *
 * For Shopify it costs one request. The stored row carries the order's GID, so the order
 * is read by id rather than by scanning sixty days of history looking for it - which is
 * what the by-id path does when it has nothing better, and what a button pressed a dozen
 * times a day must not do. Any other channel falls back to that path, which for those is
 * a keyed read anyway.
 *
 * @returns {{before: object|null, after: object, changes: {field: string, from: string, to: string}[]}}
 */
export async function refreshOneOrder({ channel, id }, {
  readStored = ordersByIds,
  readShopify = fetchOrderByGid,
  readAny = fetchOrdersByIds,
  save = saveOrders,
} = {}) {
  const want = { channel: String(channel ?? ''), id: String(id ?? '') };
  if (!want.channel || !want.id) throw new Error('pesanan tidak lengkap');
  if (want.channel === 'manual') throw new Error('transaksi manual tidak punya platform untuk dibaca ulang');

  const before = (await readStored([want]).catch(() => []))[0] ?? null;

  let after = null;
  if (want.channel === 'shopify' && before?.gid) {
    after = await readShopify(before.gid);
  } else {
    const { orders } = await readAny([want]);
    after = orders.find((o) => o.id === want.id && o.channel === want.channel) ?? null;
  }
  if (!after) throw new Error(`${want.id} tidak ditemukan di platform`);

  try {
    await save([after], { source: 'refresh' });
  } finally {
    // Every screen is drawn from the table through this cache, so the write is only half
    // the job: without this the operator presses the button and sees the same figures.
    invalidate('orders');
  }

  return { before, after, changes: diffOrder(before, after) };
}
