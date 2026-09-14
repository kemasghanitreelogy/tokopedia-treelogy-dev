import { masterQty } from './ledger.js';

/**
 * Turn "the ledger says N" into a reviewable list of writes.
 *
 * Nothing here touches a marketplace. planSync is pure so it can be unit-tested against
 * the cases that actually hurt - a zeroing write, a wild jump, a SKU that only exists on
 * one channel - and so the same plan the operator approves is the one that gets applied.
 */

export const DEFAULT_GUARDS = {
  // A change bigger than this share of current stock is held back for a human.
  maxChangeRatio: 0.5,
  // Below this level, ratios are meaningless; allow small absolute moves through.
  smallStockFloor: 10,
  // Writing a zero takes a shop offline for that SKU, so it is never automatic.
  allowZero: false,
};

export const CHANNEL_LABEL = {
  tiktok: 'Tokopedia + TikTok Shop',
  shopee: 'Shopee',
  shopify: 'Shopify',
};

/**
 * Channels the planner may write to.
 *
 * Shopify is read-only for now: its stock lives in inventory levels tied to locations,
 * so writing it needs inventorySetQuantities and a location id rather than a number on
 * the variant. Including it before that is built would produce a plan that silently
 * fails on a third of its rows.
 */
export const WRITABLE_CHANNELS = ['tiktok', 'shopee'];

function classify(from, to, guards, ledgerRow) {
  if (to < 0) return { action: 'blocked', reason: 'stok negatif' };
  if (to === from) return { action: 'unchanged' };
  if (to === 0 && !guards.allowZero) return { action: 'review', reason: 'menulis 0 (SKU jadi habis)' };

  // An increase claims stock that the shop does not currently show, so it must come from
  // a deliberate decision. A seeded ledger row is a photograph of yesterday: sales since
  // then are invisible to it, and pushing it back would put goods on sale that are
  // already gone. Decreases are always allowed - they can only under-sell.
  if (to > from && ledgerRow?.source?.startsWith('seed')) {
    return {
      action: 'review',
      reason: `menaikkan stok +${to - from} dari angka awal - pastikan barangnya memang ada`,
    };
  }

  const delta = Math.abs(to - from);
  const base = Math.max(from, guards.smallStockFloor);
  if (delta / base > guards.maxChangeRatio) {
    return { action: 'review', reason: `perubahan ${delta} unit dari ${from} melebihi ambang` };
  }
  return { action: 'change' };
}

/**
 * @param {{ledger: object, catalog: object, guards?: object}} input
 * @returns a plan whose `changes` are safe to apply and whose `review`/`blocked` are not.
 */
export function planSync({ ledger, catalog, guards = DEFAULT_GUARDS }) {
  const settings = { ...DEFAULT_GUARDS, ...guards };
  const changes = [];
  const review = [];
  const blocked = [];
  const unchanged = [];
  const unmanaged = [];

  for (const entry of catalog.skus) {
    const target = masterQty(ledger, entry.sku);

    if (target === null || target === undefined) {
      // Not in the ledger: the operator has not vouched for this SKU, so leave it alone.
      unmanaged.push({ sku: entry.sku, title: entry.title, tiktok: entry.tiktok?.qty ?? null, shopee: entry.shopee?.qty ?? null });
      continue;
    }

    for (const channel of WRITABLE_CHANNELS) {
      const bucket = entry[channel];
      if (!bucket) continue; // not listed live on this channel - never create a listing

      // One SKU can sit on several live listings; each needs its own write.
      for (const current of bucket.rows) {
        const verdict = classify(current.qty, target, settings, ledger.skus[entry.sku]);
        const row = {
          sku: entry.sku,
          title: entry.title,
          channel,
          from: current.qty,
          to: target,
          delta: target - current.qty,
          ref: channel === 'tiktok'
            ? { productId: current.productId, skuId: current.skuId, warehouseId: current.warehouseId }
            : { itemId: current.itemId, modelId: current.modelId },
          reason: verdict.reason,
        };

        if (verdict.action === 'change') changes.push(row);
        else if (verdict.action === 'review') review.push(row);
        else if (verdict.action === 'blocked') blocked.push(row);
        else unchanged.push(row);
      }
    }
  }

  const missing = Object.keys(ledger.skus).filter(
    (sku) => !catalog.skus.some((entry) => entry.sku === sku),
  );

  return {
    changes,
    review,
    blocked,
    unchanged,
    unmanaged,
    missing,
    guards: settings,
    plannedAt: Date.now(),
  };
}

/** A one-line human summary; the same string is written into the audit record. */
export function describePlan(plan) {
  return [
    `${plan.changes.length} perubahan siap`,
    `${plan.review.length} perlu ditinjau`,
    `${plan.blocked.length} diblokir`,
    `${plan.unchanged.length} sudah sesuai`,
    `${plan.unmanaged.length} di luar ledger`,
  ].join(', ');
}

/* ------------------------------------------------------------------ applying a plan */

import { callApi } from './client.js';
import { loadConfig } from './config.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi } from './shopee/client.js';
import { writeDoc } from './store/index.js';

/**
 * A hard stop for anything that would change a live listing.
 *
 * Set TREELOGY_READONLY=1 and every write throws before a request is built. This exists
 * so testing and QA cannot touch the real shops even by mistake - a guard that lives in
 * the code beats remembering to be careful.
 */
export class ReadOnlyError extends Error {
  constructor(what) {
    super(`READ-ONLY: menolak menulis ${what} (TREELOGY_READONLY aktif)`);
    this.name = 'ReadOnlyError';
  }
}

export const isReadOnly = () => process.env.TREELOGY_READONLY === '1';

function assertWritable(what) {
  if (isReadOnly()) throw new ReadOnlyError(what);
}

const TIKTOK_INVENTORY_PATH = (productId) => `/product/202309/products/${productId}/inventory/update`;
const TIKTOK_PRICE_PATH = (productId) => `/product/202309/products/${productId}/prices/update`;

async function writeTikTok(config, row) {
  assertWritable(`stok ${row.sku} di TikTok`);
  await callApi({
    config,
    method: 'POST',
    path: TIKTOK_INVENTORY_PATH(row.ref.productId),
    body: {
      skus: [{
        id: String(row.ref.skuId),
        inventory: [{ warehouse_id: String(row.ref.warehouseId), quantity: row.to }],
      }],
    },
  });
}

async function writeShopee(config, auth, row) {
  assertWritable(`stok ${row.sku} di Shopee`);
  await callShopApi(config, '/api/v2/product/update_stock', auth, {}, {
    item_id: Number(row.ref.itemId),
    stock_list: [{
      model_id: Number(row.ref.modelId) || 0,
      seller_stock: [{ stock: row.to }],
    }],
  });
}

/* ------------------------------------------------------------------- price writes */

export async function writeTikTokPrice(config, { ref, price }) {
  assertWritable(`harga di TikTok`);
  await callApi({
    config,
    method: 'POST',
    path: TIKTOK_PRICE_PATH(ref.productId),
    body: { skus: [{ id: String(ref.skuId), price: { amount: String(price), currency: 'IDR' } }] },
  });
}

export async function writeShopeePrice(config, auth, { ref, price }) {
  assertWritable(`harga di Shopee`);
  await callShopApi(config, '/api/v2/product/update_price', auth, {}, {
    item_id: Number(ref.itemId),
    price_list: [{ model_id: Number(ref.modelId) || 0, original_price: price }],
  });
}

/**
 * Push one SKU's price to the channels that list it.
 *
 * Prices are edited per SKU from the dashboard rather than driven by a ledger: unlike
 * stock, a price is not a physical quantity that must agree everywhere, so there is
 * nothing to reconcile - only an explicit instruction to carry out.
 */
export async function applyPrice({ catalog, sku, price, channels = ['tiktok', 'shopee'] }) {
  assertWritable(`harga ${sku}`);
  const entry = catalog.skus.find((e) => e.sku === sku);
  if (!entry) throw new Error(`SKU ${sku} tidak ada di katalog`);
  if (!Number.isInteger(price) || price <= 0) throw new Error('harga harus bilangan bulat positif');

  const results = [];
  const tiktokConfig = channels.includes('tiktok') && entry.tiktok ? loadConfig() : null;
  const shopee = channels.includes('shopee') && entry.shopee ? await resolveShopeeSession() : null;

  for (const channel of channels) {
    const bucket = entry[channel];
    if (!bucket) continue;
    for (const row of bucket.rows) {
      const ref = channel === 'tiktok'
        ? { productId: row.productId, skuId: row.skuId }
        : { itemId: row.itemId, modelId: row.modelId };
      try {
        if (channel === 'tiktok') await writeTikTokPrice(tiktokConfig, { ref, price });
        else await writeShopeePrice(shopee.config, shopee.auth, { ref, price });
        results.push({ sku, channel, from: row.price, to: price, status: 'ok' });
      } catch (error) {
        results.push({ sku, channel, from: row.price, to: price, status: 'failed', error: error.message });
      }
    }
  }
  return results;
}

/**
 * Apply an approved plan.
 *
 * Only `plan.changes` are ever written - rows the planner held back for review stay
 * untouched no matter what the caller passes. Writes are sequential on purpose: stock is
 * not worth racing for, and a serial log is far easier to reconcile if something fails
 * halfway. Every attempt lands in the audit record, successes and failures alike.
 */
export async function applySync(plan, { dryRun = true, blobToken } = {}) {
  if (!dryRun) assertWritable(`${plan.changes.length} perubahan stok`);
  const rows = plan.changes;
  const results = [];

  if (dryRun) {
    return {
      dryRun: true,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      results: rows.map((row) => ({ ...row, status: 'dry-run' })),
    };
  }

  const tiktokConfig = rows.some((r) => r.channel === 'tiktok') ? loadConfig() : null;
  const shopee = rows.some((r) => r.channel === 'shopee') ? await resolveShopeeSession() : null;

  for (const row of rows) {
    try {
      if (row.channel === 'tiktok') await writeTikTok(tiktokConfig, row);
      else await writeShopee(shopee.config, shopee.auth, row);
      results.push({ ...row, status: 'ok' });
    } catch (error) {
      // Keep going: one rejected SKU should not strand the rest of the plan.
      results.push({ ...row, status: 'failed', error: error.message });
    }
  }

  const summary = {
    dryRun: false,
    attempted: results.length,
    succeeded: results.filter((r) => r.status === 'ok').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results,
  };

  await writeAudit(summary, plan, blobToken).catch((error) => {
    console.warn(`audit write failed: ${error.message}`);
  });

  return summary;
}

/**
 * An append-only record of what was written, so a bad sync can be traced afterwards.
 *
 * `summary` accepts anything carrying `results`; price edits have no plan, so the
 * description falls back to counting the results rather than assuming a plan shape.
 */
export async function writeAudit(summary, plan = null) {
  const results = summary.results ?? [];
  const pathname = `inventory/audit/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeDoc(pathname, {
    at: new Date().toISOString(),
    summary: plan?.changes
      ? describePlan(plan)
      : `${results.filter((r) => r.status === 'ok').length} berhasil, ${results.filter((r) => r.status === 'failed').length} gagal`,
    guards: plan?.guards ?? null,
    results,
  });
  return pathname;
}
