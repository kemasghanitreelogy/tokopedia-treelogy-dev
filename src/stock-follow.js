import { findProduct } from './master.js';
import { numberOrNull } from './numbers.js';
import { masterQty } from './ledger.js';
import { TOPUP_CHANNELS, FLOOR, ADD } from './stock-topup.js';

/**
 * Every channel shows one number per product, and an order anywhere moves it everywhere.
 *
 * Jubelio did this until 5 Oct 2026, keeping its own count and pushing it onto TikTok and
 * Shopee after each sale. It was unlinked because it fought the top-up, and with it went
 * the only thing keeping the channels in step: a sale on Shopee lowered Shopee and nothing
 * else, and the products page filled with "stok beda". This is that job, done here.
 *
 * The number is the master ledger's (inventory/ledger.json) - the same "stok induk" the
 * Stok tab already shows and edits. Three things move it, and nothing else:
 *
 *   An order, once, the first time it is seen in any stage that holds stock. Its lines
 *   come off the master by their canonical SKU, so OMC90 on TikTok and OMC-90-001 on
 *   Shopee are one jar. The order is remembered, so the second, fifth and twentieth push
 *   about it change nothing.
 *
 *   The same order cancelled or returned, which puts its lines back - once.
 *
 *   The top-up: a master under a hundred gets a hundred added, as the operator's rule
 *   always was. It acts on the master now rather than on each listing, so the hundred
 *   lands on every channel at once instead of on whichever one happened to run low.
 *
 * After any of those, every live listing of an affected SKU on every channel is written to
 * the master figure - including the channel the order came from, which usually already
 * agrees, and every Shopify variant carrying the SKU.
 *
 * Only orders created after the master was first seeded count. The seed is read off the
 * channels, which already reflect everything sold before it; counting those orders again
 * would take them off twice.
 */

const UNDONE = new Set(['cancelled', 'returned']);

/** Orders are remembered this long; a cancellation later than this is not put back. */
export const REMEMBER_DAYS = 30;

const keyOf = (order) => `${order.channel}|${order.id}`;

/** What an order takes off the shelf, by master SKU. A SKU the master does not know is left out. */
export function linesOf(order) {
  const out = {};
  for (const line of order?.lines ?? []) {
    const product = findProduct(String(line.sku ?? '').trim());
    const qty = numberOrNull(line.qty);
    if (!product || !qty || qty <= 0) continue;
    out[product.sku] = (out[product.sku] ?? 0) + qty;
  }
  return out;
}

/**
 * Seed the master for any SKU it does not hold yet, from the lowest live figure.
 *
 * Lowest, as the ledger always said: seeding high puts stock on a channel that does not
 * have it and oversells real buyers; seeding low can only under-sell, and the top-up
 * lifts it the same minute anyway.
 *
 * @returns {{ledger: object, seeded: string[]}}
 */
export function seedMissing(ledger, catalog, { now = Date.now() } = {}) {
  const next = { ...ledger, skus: { ...(ledger.skus ?? {}) } };
  const seeded = [];
  for (const entry of catalog?.skus ?? []) {
    if (next.skus[entry.sku]?.qty !== undefined && next.skus[entry.sku]?.qty !== null) continue;
    const values = TOPUP_CHANNELS.flatMap((channel) => (entry[channel]?.rows ?? []).map((r) => numberOrNull(r.qty)))
      .filter((v) => v !== null);
    if (values.length === 0) continue;
    next.skus[entry.sku] = {
      ...(next.skus[entry.sku] ?? {}),
      qty: Math.max(0, Math.min(...values)),
      title: entry.title,
      needs_review: false,
      source: 'seed:lowest-of-channels',
      updated_at: new Date(now).toISOString(),
    };
    seeded.push(entry.sku);
  }
  if (!next.follow_started_at) next.follow_started_at = Math.floor(now / 1000);
  return { ledger: next, seeded };
}

/**
 * Take the orders into the master. Pure: the ledger in, a new ledger and what moved out.
 *
 * @returns {{ledger: object, touched: Set<string>, applied: Array}}
 */
export function applyOrders(ledger, orders, { now = Date.now() } = {}) {
  const next = { ...ledger, skus: { ...(ledger.skus ?? {}) }, applied: { ...(ledger.applied ?? {}) } };
  const touched = new Set();
  const applied = [];
  const since = Number(next.follow_started_at) || Infinity;

  for (const order of orders ?? []) {
    if (!order?.id || !order.channel) continue;
    const key = keyOf(order);
    const seen = next.applied[key];
    const undone = UNDONE.has(order.stage);

    if (!seen) {
      // Never counted, and either from before the seed or already undone when first seen:
      // nothing was taken, so there is nothing to put back either.
      if (undone || !(Number(order.createdAt) >= since)) continue;
      const lines = linesOf(order);
      if (Object.keys(lines).length === 0) continue;
      for (const [sku, qty] of Object.entries(lines)) {
        if (!next.skus[sku]) continue; // unseeded SKUs are seeded from the channels next run
        next.skus[sku] = { ...next.skus[sku], qty: Math.max(0, next.skus[sku].qty - qty), updated_at: new Date(now).toISOString(), source: `order:${key}` };
        touched.add(sku);
      }
      next.applied[key] = { at: Math.floor(now / 1000), lines };
      applied.push({ key, lines, sign: -1 });
      continue;
    }

    if (undone && !seen.undone) {
      for (const [sku, qty] of Object.entries(seen.lines ?? {})) {
        if (!next.skus[sku]) continue;
        next.skus[sku] = { ...next.skus[sku], qty: next.skus[sku].qty + qty, updated_at: new Date(now).toISOString(), source: `batal:${key}` };
        touched.add(sku);
      }
      next.applied[key] = { ...seen, undone: Math.floor(now / 1000) };
      applied.push({ key, lines: seen.lines, sign: +1 });
    }
  }

  // Remembered for a month: long enough for any cancellation worth putting back.
  const cutoff = Math.floor(now / 1000) - REMEMBER_DAYS * 86400;
  for (const [key, row] of Object.entries(next.applied)) if (row.at < cutoff) delete next.applied[key];
  return { ledger: next, touched, applied };
}

/** The operator's rule, on the master: under a hundred, add a hundred. */
export function topUpMaster(ledger, { floor = FLOOR, add = ADD, now = Date.now() } = {}) {
  const next = { ...ledger, skus: { ...(ledger.skus ?? {}) } };
  const raised = [];
  for (const [sku, row] of Object.entries(next.skus)) {
    if (row?.alias_of || typeof row?.qty !== 'number' || row.qty >= floor) continue;
    next.skus[sku] = { ...row, qty: row.qty + add, updated_at: new Date(now).toISOString(), source: 'topup' };
    raised.push({ sku, from: row.qty, to: row.qty + add });
  }
  return { ledger: next, raised };
}

const refFor = (channel, row) => {
  if (channel === 'tiktok') return { productId: row.productId, skuId: row.skuId, warehouseId: row.warehouseId };
  if (channel === 'shopify') return { variantId: row.variantId };
  return { itemId: row.itemId, modelId: row.modelId };
};

/**
 * Every live listing whose figure is not the master's, as writes applySync understands.
 *
 * Every row is its own write, Shopify variants included: a SKU that sits on two Shopify
 * products is two inventory items, and both should read the same.
 *
 * @param {{only?: Set<string>|null}} options  limit to these SKUs (an order's), or all
 */
export function planFollow(catalog, ledger, { only = null } = {}) {
  const changes = [];
  for (const entry of catalog?.skus ?? []) {
    if (only && !only.has(entry.sku)) continue;
    const target = ledger?.skus ? numberOrNull(masterQty(ledger, entry.sku)) : null;
    if (target === null || target < 0) continue;
    for (const channel of TOPUP_CHANNELS) {
      for (const row of entry[channel]?.rows ?? []) {
        const from = numberOrNull(row.qty);
        // "Unknown" is not a number to correct. A channel that answered without one is
        // left alone rather than written over on the strength of nothing.
        if (from === null || from === target) continue;
        changes.push({
          sku: entry.sku, title: entry.title, channel, from, to: target, delta: target - from,
          target: true, ref: refFor(channel, row), reason: 'ikut stok induk',
        });
      }
    }
  }
  return { changes, plannedAt: Date.now() };
}
