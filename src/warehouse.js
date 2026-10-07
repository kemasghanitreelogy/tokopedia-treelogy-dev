import { findProduct, isBundle } from './master.js';
import { numberOrNull } from './numbers.js';

/**
 * The real warehouse: what is physically on the shelf, item by item.
 *
 * Migrated on 7 Oct 2026 from the "Inventory Movement App - GO LIVE" sheet, which stops
 * being used. Kept entirely apart from the marketplace figures: the master stock in
 * inventory/ledger.json is a display number the channels show, this is jars, bowls and
 * boxes. Nothing in this module reads or writes a marketplace, and nothing that writes a
 * marketplace reads this.
 *
 * Three things move it:
 *   an order leaving - when it first reaches a shipped stage, its lines come off by the
 *   product's recipe (a Ritual Set is a bowl, a whisk, a scoop and a wooden box), once;
 *   the same order cancelled or returned after that - the recipe goes back on, once;
 *   a person - goods received, goods out for another reason, or a count (stock opname).
 */

export const WAREHOUSE_DOC = 'warehouse/stock.json';

/**
 * The sheet's Current Stock at its last update, 06/10/2026 17:16:20 WIB. Orders created
 * before this were the sheet's to count; only later ones come off here.
 */
export const OPENING_AT = Math.floor(Date.parse('2026-10-06T17:16:20+07:00') / 1000);

/** Shelf groups, in the order the page shows them. */
export const GROUPS = {
  goods: 'Barang jadi',
  set: 'Set & aksesori',
  pack: 'Kemasan & pendukung',
};

/** The sheet's Stock tab as it stood: code, name, unit, group, current stock. */
export const OPENING_ITEMS = [
  ['M-033', 'Organic Moringa Powder 180 g', 'PCS', 'goods', 9],
  ['M-034', 'Organic Moringa Powder 90 g', 'PCS', 'goods', 2],
  ['M-035', 'Organic Moringa Powder 45 g', 'PCS', 'goods', 42],
  ['M-036', 'Organic Moringa Capsules 90', 'PCS', 'goods', 248],
  ['M-037', 'Organic Moringa Capsules 180', 'PCS', 'goods', 126],
  ['M-038', 'Organic Moringa Oil 30 mL', 'PCS', 'goods', 58],
  ['M-039', 'Organic Moringa Oil 60 mL', 'PCS', 'goods', 104],
  ['M-087', 'Sample Organic Moringa Oil 3 mL', 'PCS', 'goods', 148],
  ['M-091', 'Bamboo Scoop', 'PCS', 'set', 114],
  ['M-092', 'Whisk', 'PCS', 'set', 220],
  ['M-093', 'Bowl', 'PCS', 'set', 218],
  ['M-094', 'Wooden Box', 'PCS', 'set', 198],
  ['M-051', 'Pouch Treelogy', 'PCS', 'set', 263],
  ['M-052', 'Pouch tanpa logo', 'PCS', 'set', 32],
  ['M-049', 'Mailerbox Printed', 'PCS', 'pack', 7473],
  ['M-050', 'Mailerbox Plain', 'PCS', 'pack', 788],
  ['M-053', 'Magazine Kecil', 'PCS', 'pack', 735],
  ['M-054', 'Magazine Besar', 'PCS', 'pack', 376],
  ['M-055', 'Paper Bag Kecil (Print)', 'PCS', 'pack', 370],
  ['M-056', 'Paper Bag Sedang (Print)', 'PCS', 'pack', 543],
  ['M-057', 'Paper Bag Besar (Print)', 'PCS', 'pack', 807],
  ['M-058', 'Honeycomb', 'ROL', 'pack', 22],
  ['M-088', 'Card Oil 3 mL - Alternative', 'PCS', 'pack', 132],
  ['M-095', 'Card Oil 3 mL - Green', 'PCS', 'pack', 824],
  ['M-089', 'Tali Goni 3 ply 50 m', 'PCS', 'pack', 15],
];

/**
 * What one unit of a master product takes off the shelf.
 *
 * Only products that are not themselves a bundle of other master products are written
 * here; a master bundle (Discovery Pack, the protocols, Ritual Set + Powder) is resolved
 * through its own components, so a recipe changed in one place changes everywhere.
 * 270 caps is three 90-cap jars and The Movement & Relief is capsules 90 with oil 30 mL,
 * both as the operator said on 7 Oct.
 */
export const RECIPES = {
  'OMP-45-001': { 'M-035': 1 },
  'OMP-90-001': { 'M-034': 1 },
  'OMP-180-001': { 'M-033': 1 },
  'OMC-90-001': { 'M-036': 1 },
  'OMC-180-001': { 'M-037': 1 },
  'OMC-270-001': { 'M-036': 3 },
  'OMO-30-001': { 'M-038': 1 },
  'OMO-60-001': { 'M-039': 1 },
  'MRS-001': { 'M-093': 1, 'M-092': 1, 'M-091': 1, 'M-094': 1 },
  'Bamboo-Scoop': { 'M-091': 1 },
  'Bamboo-Whisk': { 'M-092': 1 },
  'The-Movement-&-Relief': { 'M-036': 1, 'M-038': 1 },
  'Travel-Pouch': { 'M-051': 1 },
  'Mystery-Gift': { 'M-087': 1 },
};

/**
 * One unit of a product as warehouse items, resolving master bundles to their parts.
 * Null when the product has no recipe and is not a bundle of products that do.
 */
export function recipeOf(sku, edited = {}, seen = new Set()) {
  const product = findProduct(sku);
  if (!product || seen.has(product.sku)) return null;
  // A recipe set on the page wins over the one written here, and a bundle made of a
  // product whose recipe was set there follows it.
  if (edited?.[product.sku]) return { ...edited[product.sku] };
  if (RECIPES[product.sku]) return { ...RECIPES[product.sku] };
  if (!isBundle(product)) return null;
  const out = {};
  for (const part of product.components) {
    const inner = recipeOf(part.sku, edited, new Set([...seen, product.sku]));
    if (!inner) return null;
    for (const [code, qty] of Object.entries(inner)) out[code] = (out[code] ?? 0) + qty * part.qty;
  }
  return out;
}

/** What an order takes off the shelf, by warehouse item; and the lines it could not place. */
export function itemsForOrder(order, edited = {}) {
  return itemsForLines(linesOf(order), edited);
}

/** An order's lines as {sku: qty}, the same whatever order the platform lists them in. */
export function linesOf(order) {
  const lines = {};
  for (const line of order?.lines ?? []) {
    const qty = numberOrNull(line.qty);
    if (!qty || qty <= 0) continue;
    const sku = String(line.sku ?? '').trim() || '?';
    lines[sku] = (lines[sku] ?? 0) + qty;
  }
  return lines;
}

function itemsForLines(lines, edited = {}) {
  const items = {};
  const unknown = [];
  for (const [sku, qty] of Object.entries(lines ?? {})) {
    const recipe = recipeOf(sku, edited);
    if (!recipe) { unknown.push(sku); continue; }
    for (const [code, n] of Object.entries(recipe)) items[code] = (items[code] ?? 0) + n * qty;
  }
  return { items, unknown };
}

const SHIPPED = new Set(['shipping', 'delivered', 'completed']);
const UNDONE = new Set(['cancelled', 'returned']);
/** Kept this long; a cancellation later than this is not put back. */
export const REMEMBER_DAYS = 45;
const MAX_MOVES = 5000;

export const emptyWarehouse = () => ({ version: 1, items: {}, moves: [], orders: {}, folded: {}, tokens: {}, recipes: {}, opened_at: null });

/*
 * The invariant every write keeps, and verifyWarehouse proves:
 *
 *     items[code].qty  ===  folded[code] + Σ moves[code].delta
 *
 * The movement log is the truth and the quantity is its running total. When the log is
 * trimmed, the deltas taken off are folded into `folded`, so the sum still balances to
 * the unit forever - nothing is ever summarised away.
 */
const MAX_TOKENS = 500;

function trim(doc) {
  if (doc.moves.length <= MAX_MOVES) return;
  const cut = doc.moves.length - MAX_MOVES;
  const folded = { ...(doc.folded ?? {}) };
  for (const m of doc.moves.slice(0, cut)) folded[m.code] = (folded[m.code] ?? 0) + m.delta;
  doc.folded = folded;
  doc.moves = doc.moves.slice(cut);
}

/** Every item whose quantity is not exactly the sum of its movements. Empty when consistent. */
export function verifyWarehouse(doc) {
  const sums = { ...(doc?.folded ?? {}) };
  for (const m of doc?.moves ?? []) sums[m.code] = (sums[m.code] ?? 0) + m.delta;
  const bad = [];
  for (const [code, item] of Object.entries(doc?.items ?? {})) {
    if ((sums[code] ?? 0) !== item.qty) bad.push({ code, qty: item.qty, expected: sums[code] ?? 0 });
  }
  return bad;
}

const sameItems = (a = {}, b = {}) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
};

/** The sheet's figures as the starting point - only for items not held yet. */
export function openWarehouse(doc, { now = Date.now(), by = 'migrasi sheet' } = {}) {
  const next = { ...emptyWarehouse(), ...(doc ?? {}), items: { ...(doc?.items ?? {}) }, moves: [...(doc?.moves ?? [])], folded: { ...(doc?.folded ?? {}) }, tokens: { ...(doc?.tokens ?? {}) }, recipes: { ...(doc?.recipes ?? {}) } };
  for (const [code, name, uom, group, qty] of OPENING_ITEMS) {
    if (next.items[code]) continue;
    next.items[code] = { name, uom, group, qty, updated_at: OPENING_AT };
    next.moves.push({ id: `open-${code}`, at: OPENING_AT, code, kind: 'opening', delta: qty, after: qty, note: 'Current Stock dari sheet (06/10/2026 17:16)', by });
  }
  if (!next.opened_at) next.opened_at = Math.floor(now / 1000);
  return next;
}

const move = (doc, entry) => {
  const item = doc.items[entry.code];
  if (!item) return null;
  const after = item.qty + entry.delta;
  doc.items[entry.code] = { ...item, qty: after, updated_at: entry.at };
  const record = { ...entry, after };
  doc.moves.push(record);
  return record;
};

/**
 * Take shipped orders off the shelf and put undone ones back. Pure.
 *
 * @returns {{doc, moved: Array}}
 */
export function applyOrders(doc, orders, { now = Date.now() } = {}) {
  const next = { ...doc, items: { ...doc.items }, moves: [...doc.moves], orders: { ...(doc.orders ?? {}) }, folded: { ...(doc.folded ?? {}) } };
  const at = Math.floor(now / 1000);
  const moved = [];
  // Each order's movements carry a revision, so an order that moves more than once (an
  // edit, a cancel and a re-send) never reuses an id.
  const post = (key, rev, code, delta, kind, note) => {
    if (!delta) return;
    const r = move(next, { id: `${key}|${rev}|${code}`, at, code, kind, delta, ref: key, note });
    if (r) moved.push(r);
  };
  const apply = (key, rev, items, sign, kind, note) => {
    for (const [code, qty] of Object.entries(items)) post(key, rev, code, sign * qty, kind, note);
  };

  for (const order of orders ?? []) {
    if (!order?.id || !order.channel) continue;
    const key = `${order.channel}|${order.id}`;
    const seen = next.orders[key];
    const label = `${order.channel === 'manual' ? '' : `${order.channel} `}${order.id}`;
    const shipped = SHIPPED.has(order.stage);
    const undone = UNDONE.has(order.stage);
    const lines = linesOf(order);
    const read = itemsForLines(lines, next.recipes);
    // A read that came back without any lines says nothing about the order's contents -
    // a platform hiccup is not an instruction to put everything back.
    const known = Object.keys(read.items).length > 0 || read.unknown.length > 0;

    if (!seen) {
      if (!shipped || !known || !(Number(order.createdAt) >= OPENING_AT)) continue;
      next.orders[key] = { at, rev: 1, lines, items: read.items, unknown: read.unknown };
      apply(key, 1, read.items, -1, 'order', `Pesanan ${label}`);
      continue;
    }
    const rev = (seen.rev ?? 1) + 1;
    if (undone && !seen.undone) {
      apply(key, rev, seen.items ?? {}, +1, 'return', `${order.stage === 'returned' ? 'Retur' : 'Batal'} ${label}`);
      next.orders[key] = { ...seen, rev, undone: at };
      continue;
    }
    if (shipped && seen.undone && known) {
      // Cancelled and then sent after all: it leaves the shelf again.
      apply(key, rev, read.items, -1, 'order', `Dikirim ulang ${label}`);
      next.orders[key] = { at, rev, lines, items: read.items, unknown: read.unknown };
      continue;
    }
    if (shipped && !seen.undone && known && seen.lines && !sameItems(seen.lines, lines)) {
      // The order's lines changed after it was counted - a typed-in sale edited, a line
      // cancelled on the platform. Only the change in lines moves, priced by today's
      // recipes on both sides, so a recipe edited since never re-counts what already left;
      // the order keeps a record of exactly what it took, which is what a cancel returns.
      const before = itemsForLines(seen.lines, next.recipes).items;
      const diff = {};
      for (const code of new Set([...Object.keys(before), ...Object.keys(read.items)])) {
        const d = (read.items[code] ?? 0) - (before[code] ?? 0);
        if (d) diff[code] = d;
      }
      apply(key, rev, diff, -1, 'order', `Pesanan ${label} diubah`);
      const took = { ...(seen.items ?? {}) };
      for (const [code, d] of Object.entries(diff)) {
        took[code] = (took[code] ?? 0) + d;
        if (!took[code]) delete took[code];
      }
      next.orders[key] = { ...seen, at, rev, lines, items: took, unknown: read.unknown };
    } else if (!seen.lines && known) {
      // Counted before lines were kept: remember them from now on, move nothing.
      next.orders[key] = { ...seen, lines };
    }
  }
  const cutoff = at - REMEMBER_DAYS * 86400;
  for (const [key, row] of Object.entries(next.orders)) if (row.at < cutoff) delete next.orders[key];
  trim(next);
  return { doc: next, moved };
}

/**
 * A person's movement: goods in, goods out, or a count that sets the figure outright.
 *
 * @param {{code: string, kind: 'in'|'out'|'count', qty: number, note?: string, by: string}} input
 */
export function manualMove(doc, { code, kind, qty, note = '', by, token = '' }, { now = Date.now() } = {}) {
  // A form carries a one-time token. The same token twice is the same press - a double
  // click, a resubmitted page, a retry after a timeout - and is recorded once.
  if (token && doc.tokens?.[token]) return { doc, record: null, duplicate: true };
  const item = doc.items?.[code];
  if (!item) throw new Error(`barang ${code} tidak ada`);
  if (!Number.isInteger(qty) || qty < 0 || (kind !== 'count' && qty === 0)) throw new Error('jumlah harus bilangan bulat positif');
  if (!['in', 'out', 'count'].includes(kind)) throw new Error('jenis gerakan tidak dikenal');
  const delta = kind === 'in' ? qty : kind === 'out' ? -qty : qty - item.qty;
  const at = Math.floor(now / 1000);
  const tokens = { ...(doc.tokens ?? {}) };
  if (token) {
    tokens[token] = at;
    const keys = Object.keys(tokens);
    if (keys.length > MAX_TOKENS) for (const k of keys.sort((x, y) => tokens[x] - tokens[y]).slice(0, keys.length - MAX_TOKENS)) delete tokens[k];
  }
  if (kind === 'count' && delta === 0) return { doc: { ...doc, tokens }, record: null };
  const next = { ...doc, items: { ...doc.items }, moves: [...doc.moves], folded: { ...(doc.folded ?? {}) }, tokens };
  const record = move(next, { id: `${kind}-${code}-${at}-${token || Math.random().toString(36).slice(2, 9)}`, at, code, kind, delta, note: String(note).slice(0, 200), by });
  trim(next);
  return { doc: next, record };
}

/**
 * How many of a product the shelf can make now, and which item decides it.
 * This is the real figure - unlike the channels', it is a count of things that exist.
 */
export function makeable(sku, items, edited = {}) {
  const recipe = recipeOf(sku, edited);
  if (!recipe) return null;
  let can = Infinity;
  let limit = null;
  const parts = Object.entries(recipe).map(([code, per]) => {
    const have = items?.[code]?.qty ?? 0;
    const n = Math.floor(Math.max(0, have) / per);
    if (n < can) { can = n; limit = code; }
    return { code, per, have, n };
  });
  return { can: can === Infinity ? 0 : can, limit, parts };
}

/** Most parts one product may list, and most of one part per product. */
export const RECIPE_LIMITS = { parts: 12, per: 99 };

/**
 * Set what one unit of a product takes off the shelf from now on, or put back the
 * built-in recipe (`parts` null). Pure. Orders already counted keep what they took: their
 * cancel returns exactly that, and only a change to their lines moves anything again.
 *
 * @param {{sku: string, parts: Array<{code: string, qty: number}>|null, by?: string}} input
 * @returns {{doc, recipe: object|null, changed: boolean}}
 */
export function setRecipe(doc, { sku, parts, by = '' }, { now = Date.now() } = {}) {
  const product = findProduct(String(sku ?? '').trim());
  if (!product) throw new Error(`produk ${sku} tidak dikenal`);
  const next = { ...doc, recipes: { ...(doc.recipes ?? {}) } };
  const before = recipeOf(product.sku, doc.recipes ?? {});
  if (parts == null) {
    delete next.recipes[product.sku];
  } else {
    if (!Array.isArray(parts) || !parts.length) throw new Error('isi produk minimal satu barang');
    if (parts.length > RECIPE_LIMITS.parts) throw new Error(`paling banyak ${RECIPE_LIMITS.parts} barang`);
    const recipe = {};
    for (const part of parts) {
      const code = String(part?.code ?? '').trim();
      const qty = Number(part?.qty);
      if (!doc.items?.[code]) throw new Error(`barang ${code || '(kosong)'} tidak ada di gudang`);
      if (!Number.isInteger(qty) || qty < 1 || qty > RECIPE_LIMITS.per) throw new Error(`jumlah ${code} harus 1-${RECIPE_LIMITS.per}`);
      recipe[code] = (recipe[code] ?? 0) + qty;
      if (recipe[code] > RECIPE_LIMITS.per) throw new Error(`jumlah ${code} harus 1-${RECIPE_LIMITS.per}`);
    }
    next.recipes[product.sku] = recipe;
    // Saving exactly the built-in recipe is the same as not having edited it.
    const builtIn = recipeOf(product.sku, { ...next.recipes, [product.sku]: undefined });
    if (builtIn && sameItems(builtIn, recipe)) delete next.recipes[product.sku];
  }
  const after = recipeOf(product.sku, next.recipes);
  const changed = !sameItems(before ?? {}, after ?? {}) || Boolean(before) !== Boolean(after);
  if (changed) {
    next.recipeLog = [...(doc.recipeLog ?? []), { at: Math.floor(now / 1000), sku: product.sku, from: before, to: after, by }].slice(-200);
  }
  return { doc: changed ? next : doc, recipe: after, changed };
}
