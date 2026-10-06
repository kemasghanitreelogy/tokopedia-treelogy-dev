import { readDoc, updateDoc } from './store/index.js';
import { applyMasterOverlay, findProduct, isBaseProduct, CATEGORIES } from './master.js';

/**
 * The dashboard's changes to the product catalogue, kept in the state store.
 *
 * src/master.js holds the base list in code; this is what has been added, changed or
 * removed since, from the products page. It is read when a process starts and every
 * minute after in the long-running one, so the web server, the half-hourly jobs and the
 * webhooks all see one catalogue.
 */

export const MASTER_DOC = 'catalog/master.json';
const EMPTY = { version: 1, products: {}, removed: [], updated_at: null };

const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+&._-]{1,49}$/;

/** Read the stored changes and apply them. Never throws: a store that cannot be read leaves the base list. */
export async function loadMasterOverlay() {
  try {
    const doc = await readDoc(MASTER_DOC);
    applyMasterOverlay(doc ?? null);
    return doc ?? structuredClone(EMPTY);
  } catch (error) {
    console.warn(`master: perubahan katalog tidak terbaca - ${error.message}`);
    return null;
  }
}

/** Keep the long-running process current; the edit that changes it applies at once anyway. */
export function watchMasterOverlay(intervalMs = 60_000) {
  const timer = setInterval(() => { void loadMasterOverlay(); }, intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * Check one product as the form sent it. Returns the clean entry or throws in Indonesian,
 * because the message goes straight to the operator.
 */
export function cleanProduct(input, { isNew }) {
  const sku = String(input.sku ?? '').trim();
  if (!SKU_PATTERN.test(sku)) throw new Error('SKU 2-50 karakter: huruf, angka, - _ . + &');
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 120) throw new Error('nama produk wajib, maksimal 120 karakter');
  const category = String(input.category ?? '');
  if (!Object.hasOwn(CATEGORIES, category)) throw new Error('kategori tidak dikenal');

  if (isNew) {
    const taken = findProduct(sku);
    if (taken) throw new Error(`SKU ${sku} sudah dipakai ${taken.name}${taken.sku !== sku ? ` (sebagai alias ${taken.sku})` : ''}`);
  }

  const aliases = String(input.aliases ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  for (const alias of aliases) {
    if (alias === sku) continue;
    const owner = findProduct(alias);
    if (owner && owner.sku !== sku) throw new Error(`alias ${alias} sudah dipakai ${owner.sku}`);
  }

  const components = (input.components ?? [])
    .map((c) => ({ sku: String(c.sku ?? '').trim(), qty: Number(c.qty) }))
    .filter((c) => c.sku);
  for (const c of components) {
    const part = findProduct(c.sku);
    if (!part) throw new Error(`isi bundle ${c.sku} tidak ada di master`);
    if (part.sku === sku) throw new Error('bundle tidak bisa berisi dirinya sendiri');
    if (!Number.isInteger(c.qty) || c.qty < 1 || c.qty > 99) throw new Error(`jumlah ${c.sku} harus 1-99`);
    c.sku = part.sku;
  }

  const entry = { name, category };
  const variant = String(input.variant ?? '').trim();
  const family = String(input.family ?? '').trim();
  entry.variant = variant || undefined;
  entry.family = family || undefined;
  entry.aliases = [...new Set(aliases.filter((a) => a !== sku))];
  entry.components = components.length ? components : undefined;
  entry.gift = input.gift ? true : undefined;
  return { sku, entry };
}

/** Add or change one product. Applies at once in this process. */
export async function saveMasterProduct({ sku, entry }) {
  const doc = await updateDoc(MASTER_DOC, (current) => {
    const next = { ...EMPTY, ...(current ?? {}), products: { ...(current?.products ?? {}) } };
    next.products[sku] = entry;
    next.removed = (next.removed ?? []).filter((s) => s !== sku);
    next.updated_at = new Date().toISOString();
    return next;
  }, structuredClone(EMPTY));
  applyMasterOverlay(doc);
  return doc;
}

/**
 * Take a product out of the catalogue the screens offer, or put it back.
 *
 * A product added from the dashboard that has never been restored is still kept, only
 * removed: an order may already name it, and its spelling has to keep resolving.
 */
export async function setMasterRemoved(sku, removed) {
  if (!findProduct(sku) || findProduct(sku).sku !== sku) throw new Error(`${sku} tidak ada di master`);
  const doc = await updateDoc(MASTER_DOC, (current) => {
    const next = { ...EMPTY, ...(current ?? {}), products: { ...(current?.products ?? {}) } };
    const set = new Set(next.removed ?? []);
    if (removed) set.add(sku); else set.delete(sku);
    next.removed = [...set];
    next.updated_at = new Date().toISOString();
    return next;
  }, structuredClone(EMPTY));
  applyMasterOverlay(doc);
  return doc;
}

/** Forget a product the dashboard added, entirely - only for one nothing has sold under. */
export async function dropAddedProduct(sku) {
  if (isBaseProduct(sku)) throw new Error(`${sku} bagian dari katalog dasar`);
  const doc = await updateDoc(MASTER_DOC, (current) => {
    const next = { ...EMPTY, ...(current ?? {}), products: { ...(current?.products ?? {}) } };
    delete next.products[sku];
    next.removed = (next.removed ?? []).filter((s) => s !== sku);
    next.updated_at = new Date().toISOString();
    return next;
  }, structuredClone(EMPTY));
  applyMasterOverlay(doc);
  return doc;
}
