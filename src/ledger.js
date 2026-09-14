import { readDoc, writeDoc } from './store/index.js';
import { loadConfig } from './config.js';

/**
 * The master stock ledger: one number per SKU that both marketplaces are made to follow.
 *
 * Keeping the truth here rather than on a channel means no marketplace can overwrite
 * another by accident, and every change is attributable. It lives in the same private
 * Blob store as the tokens.
 */

export const LEDGER_PATHNAME = 'inventory/ledger.json';
export const LEDGER_VERSION = 1;

function resolveToken(explicit) {
  // On Vercel the token is injected; locally it lives in .env.local, which loadConfig
  // already merges. Reading only process.env made every CLI call fail.
  const token = explicit || process.env.BLOB_READ_WRITE_TOKEN || loadConfig().blobToken;
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is not set - link the blob store to this project');
  return token;
}

export const emptyLedger = () => ({
  version: LEDGER_VERSION,
  updated_at: null,
  skus: {},
});

export async function loadLedger() {
  return readDoc(LEDGER_PATHNAME);
}

export async function saveLedger(ledger, { token } = {}) {
  const payload = { ...ledger, version: 1, updated_at: new Date().toISOString() };
  await writeDoc(LEDGER_PATHNAME, payload);
  return payload;
}

/**
 * Seed the ledger from what the channels currently hold.
 *
 * Where the two channels disagree the LOWER number wins and the row is flagged for
 * review. Seeding high would push phantom stock onto the other channel and oversell
 * real customers; seeding low can only under-sell, which is recoverable.
 */
export function seedLedger(catalog, existing = emptyLedger()) {
  const ledger = { ...emptyLedger(), ...existing, skus: { ...existing.skus } };
  const seeded = [];
  const conflicts = [];

  for (const entry of catalog.skus) {
    if (ledger.skus[entry.sku]) continue;

    const values = [entry.tiktok?.qty, entry.shopee?.qty].filter((v) => typeof v === 'number');
    if (values.length === 0) continue;

    const qty = Math.min(...values);
    const disagree = values.length > 1 && new Set(values).size > 1;

    ledger.skus[entry.sku] = {
      qty,
      title: entry.title,
      needs_review: disagree,
      updated_at: new Date().toISOString(),
      source: disagree ? 'seed:lowest-of-channels' : 'seed',
    };

    seeded.push(entry.sku);
    if (disagree) conflicts.push({ sku: entry.sku, tiktok: entry.tiktok?.qty, shopee: entry.shopee?.qty, chosen: qty });
  }

  return { ledger, seeded, conflicts };
}

/** Follow alias_of so several channel SKUs can share one physical pool. */
export function masterQty(ledger, sku, seen = new Set()) {
  const row = ledger.skus[sku];
  if (!row) return null;
  if (!row.alias_of) return row.qty;
  if (seen.has(sku)) return null; // a cycle is a config error, not a stock level
  seen.add(sku);
  return masterQty(ledger, row.alias_of, seen);
}

export function setSku(ledger, sku, patch) {
  return {
    ...ledger,
    skus: {
      ...ledger.skus,
      [sku]: { ...ledger.skus[sku], ...patch, updated_at: new Date().toISOString() },
    },
  };
}

/**
 * SKUs that look like two names for one physical pool: identical stock on the same
 * channel and a shared prefix. Reported, never linked automatically - guessing here
 * would silently halve or double someone's real inventory.
 */
export function aliasCandidates(catalog) {
  const candidates = [];
  const rows = catalog.skus.filter((s) => s.tiktok && !s.shopee);

  for (const row of rows) {
    for (const other of catalog.skus) {
      if (other.sku === row.sku || !other.tiktok || !other.shopee) continue;
      const sharesPrefix = other.sku.startsWith(row.sku) || row.sku.startsWith(other.sku);
      if (sharesPrefix && other.tiktok.qty === row.tiktok.qty) {
        candidates.push({ sku: row.sku, looksLike: other.sku, qty: row.tiktok.qty });
      }
    }
  }
  return candidates;
}
