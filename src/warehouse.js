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
 *   an order confirmed on the picklist - only then do its lines come off, by the
 *   product's recipe (a Ritual Set is a bowl, a whisk, a scoop and a wooden box), once;
 *   nothing leaves on an order arriving, a label printing or a parcel shipping;
 *   the same order cancelled, returned or refunded after that - nothing moves yet: it
 *   waits on the Stok page until a person says whether the goods came back to the shelf
 *   (they go back on, once) or not (the buyer kept them, the parcel was lost);
 *   a person - goods received, goods out for another reason, or a count (stock opname).
 */

export const WAREHOUSE_DOC = 'warehouse/stock.json';

/**
 * The sheet's Current Stock at its last update, 06/10/2026 17:16:20 WIB. The sheet took
 * an order off when its label was printed, so an order printed before this was the
 * sheet's to count and one printed after is ours. An order never printed here falls back
 * to when it was created.
 */
export const OPENING_AT = Math.floor(Date.parse('2026-10-06T17:16:20+07:00') / 1000);

/**
 * When an order left the shelf, for the opening cutoff: its first label print, else when
 * it was created. The picklist and the warehouse both read it, so they agree on which
 * orders belong to the sheet's era and which are ours.
 */
export function leftAtOf(order) {
  const printedAt = Number(order?.printedAt);
  return printedAt > 0 ? printedAt : Number(order?.createdAt);
}

/** Whether an order belongs after the migration (not counted by the sheet). */
export const afterOpening = (order) => leftAtOf(order) >= OPENING_AT;

/** What the picklist shows of an order long after the order list has forgotten it. */
const about = (order) => ({ buyer: String(order.buyer ?? '').slice(0, 80), created: Number(order.createdAt) || null });

/**
 * Picklist batches close at 15:00 WITA (UTC+8), the courier cut-off: an order placed
 * after 15:00 belongs to the next day's batch - by when it was ordered, not when its
 * label came out. A batch is named by the WITA date it closes on.
 */
export const BATCH_CLOSE_HOUR_WITA = 15;
const WITA = 8 * 3600;
export const batchOf = (at) => new Date((Number(at) - 1 + WITA + (24 - BATCH_CLOSE_HOUR_WITA) * 3600) * 1000).toISOString().slice(0, 10);
/** The batch's window, epoch seconds: (previous day 15:00 WITA, this day 15:00 WITA]. */
export function batchWindow(date) {
  const to = Math.floor(Date.parse(`${date}T${String(BATCH_CLOSE_HOUR_WITA).padStart(2, '0')}:00:00+08:00`) / 1000);
  return { from: to - 86400, to };
}

/** Shelf groups, in the order the page shows them. */
export const GROUPS = {
  goods: 'Barang jadi',
  set: 'Set & aksesori',
};

/**
 * Packaging the sheet also counted - mailerboxes, magazines, paper bags, honeycomb, cards,
 * twine. Not tracked here at all (operator, 7 Oct 2026): a document that still holds them
 * from before has them, their movements and any recipe mention of them removed on open.
 */
export const UNTRACKED = new Set(['M-049', 'M-050', 'M-053', 'M-054', 'M-055', 'M-056', 'M-057', 'M-058', 'M-088', 'M-089', 'M-095']);

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
  if (edited && Object.hasOwn(edited, product.sku)) {
    // An empty recipe set on the page means "takes nothing from the shelf".
    const own = edited[product.sku];
    return own && Object.keys(own).length ? { ...own } : null;
  }
  if (RECIPES[product.sku]) return { ...RECIPES[product.sku] };
  if (!isBundle(product)) return null;
  const out = {};
  for (const part of product.components) {
    // A part whose recipe was removed on the page adds nothing; the rest still leave.
    const partSku = findProduct(part.sku)?.sku;
    if (partSku && edited && Object.hasOwn(edited, partSku) && !Object.keys(edited[partSku] ?? {}).length) continue;
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

const UNDONE = new Set(['cancelled', 'returned']);
/** Kept this long; a cancellation later than this is not put back. */
export const REMEMBER_DAYS = 45;
const MAX_MOVES = 5000;

export const emptyWarehouse = () => ({ version: 1, items: {}, moves: [], orders: {}, folded: {}, tokens: {}, recipes: {}, refunds: {}, opened_at: null });

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
  forgetUntracked(next);
  if (!Array.isArray(next.picks)) next.picks = picksFromOrders(next.orders);
  return next;
}

/**
 * Drop untracked items whole: the item, every movement of it and its folded balance go
 * together, so each remaining item still equals the sum of its own movements. Recipes and
 * counted orders forget them too, so nothing ever tries to move one again.
 */
function forgetUntracked(doc) {
  if (![...Object.keys(doc.items), ...Object.keys(doc.folded)].some((c) => UNTRACKED.has(c))
    && !doc.moves.some((m) => UNTRACKED.has(m.code))
    && !Object.values(doc.recipes ?? {}).some((r) => Object.keys(r ?? {}).some((c) => UNTRACKED.has(c)))) return;
  for (const code of UNTRACKED) { delete doc.items[code]; delete doc.folded[code]; }
  doc.moves = doc.moves.filter((m) => !UNTRACKED.has(m.code));
  const strip = (map) => Object.fromEntries(Object.entries(map ?? {}).filter(([c]) => !UNTRACKED.has(c)));
  const recipes = {};
  for (const [sku, recipe] of Object.entries(doc.recipes ?? {})) {
    const kept = strip(recipe);
    const hadParts = Object.keys(recipe ?? {}).length > 0;
    // A recipe that was only packaging, or that is now the built-in one, is no edit at all.
    if (hadParts && !Object.keys(kept).length) continue;
    const rest = { ...doc.recipes }; delete rest[sku];
    const builtIn = recipeOf(sku, rest);
    if (hadParts && builtIn && sameItems(builtIn, kept)) continue;
    recipes[sku] = kept;
  }
  doc.recipes = recipes;
  doc.orders = Object.fromEntries(Object.entries(doc.orders ?? {}).map(([k, o]) => [k, { ...o, items: strip(o.items) }]));
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
 * Read orders against the shelf. Pure. With `admit` (a picklist confirmation) a new
 * order is taken off; without it only orders already taken move - a cancel puts back
 * what was taken, an edit moves the difference.
 *
 * @returns {{doc, moved: Array}}
 */
export function applyOrders(doc, orders, { now = Date.now(), admit = false, by = '' } = {}) {
  // `admit` is true, false, or a test of each order: the run decides which new orders
  // have reached the picklist and so leave the shelf now.
  const admits = typeof admit === 'function' ? admit : () => Boolean(admit);
  const next = { ...doc, items: { ...doc.items }, moves: [...doc.moves], orders: { ...(doc.orders ?? {}) }, folded: { ...(doc.folded ?? {}) }, refunds: { ...(doc.refunds ?? {}) } };
  const at = Math.floor(now / 1000);
  const moved = [];
  // Each order's movements carry a revision, so an order that moves more than once (an
  // edit, a cancel and a re-send) never reuses an id.
  const post = (key, rev, code, delta, kind, note) => {
    if (!delta) return;
    const r = move(next, { id: `${key}|${rev}|${code}`, at, code, kind, delta, ref: key, note, ...(by ? { by } : {}) });
    if (r) moved.push(r);
  };
  const apply = (key, rev, items, sign, kind, note) => {
    for (const [code, qty] of Object.entries(items)) post(key, rev, code, sign * qty, kind, note);
  };

  for (const order of orders ?? []) {
    if (!order?.id || !order.channel) continue;
    const key = `${order.channel}|${order.id}`;
    let seen = next.orders[key];
    const label = `${order.channel === 'manual' ? '' : `${order.channel} `}${order.id}`;
    const undone = UNDONE.has(order.stage);
    const lines = linesOf(order);
    const read = itemsForLines(lines, next.recipes);
    // A read that came back without any lines says nothing about the order's contents -
    // a platform hiccup is not an instruction to put everything back.
    const known = Object.keys(read.items).length > 0 || read.unknown.length > 0;

    if (!seen) {
      // Only a picklist confirmation (`admit`) takes a new order off the shelf, and only
      // one from after the migration; anything else is just read.
      if (undone || !known || !afterOpening(order) || !admits(order)) continue;
      next.orders[key] = { at, rev: 1, lines, items: read.items, unknown: read.unknown, picked: at, ...(by ? { by } : {}), ...about(order) };
      apply(key, 1, read.items, -1, 'order', `Picklist ${label}`);
      continue;
    }
    // Counted before the order's own time was kept: remember it now, nothing moves. The
    // picklist batch an order belongs to is decided by when it was ordered.
    if (!seen.created && Number(order.createdAt) > 0) next.orders[key] = { ...seen, ...about(order), buyer: seen.buyer || about(order).buyer };
    const rev = (seen.rev ?? 1) + 1;
    if (undone && !seen.undone) {
      // Whether the goods come back is not something a status can say: a refunded parcel
      // may be on its way home or lost for good. It waits for a person on the Stok page.
      Object.assign(next, holdRefund(next, key, { at, rev, reason: order.stage, label }));
      continue;
    }
    // A refund from the dashboard or a deleted sale is final whatever the platform still
    // says: the order there may well read "shipping" for days.
    if (!undone && seen.undone && !FINAL_REASONS.has(seen.reason) && known && admits(order)) {
      // Cancelled and confirmed on the picklist again. Goods that were put back leave
      // again; goods that never came back (still undecided, or kept by the buyer) are
      // still out, and leave nothing.
      if (putBack(seen)) {
        apply(key, rev, read.items, -1, 'order', `Picklist ulang ${label}`);
        next.orders[key] = { at, rev, lines, items: read.items, unknown: read.unknown, picked: at, ...(by ? { by } : {}), ...about(order) };
        continue;
      }
      // Revived with its goods still out: it is simply live again, and a change to its
      // lines since it left is read below like any other edit.
      const { undone: _u, back: _b, reason: _r, decided: _d, decidedBy: _db, ...still } = seen;
      seen = { ...still, rev };
      next.orders[key] = seen;
      delete next.refunds[key];
    }
    if (!undone && !seen.undone && known && seen.lines && !sameItems(seen.lines, lines)) {
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
 * Whether an undone order's goods are back on the shelf. Before refund rows existed a
 * cancel put them back by itself, and those orders carry no reason.
 */
export const putBack = (row) => Boolean(row?.undone) && (row.back ?? !row.reason);

/** What a refund row says the order was. */
export const REFUND_REASONS = { cancelled: 'Batal', returned: 'Retur', refund: 'Refund', deleted: 'Dihapus' };
/** Undone by a person here, not by the platform: no status read later revives them. */
const FINAL_REASONS = new Set(['refund', 'deleted']);

/**
 * An order that left the shelf is undone - cancelled, returned, refunded from the
 * dashboard, or a typed-in sale deleted. Nothing moves: it is held as a refund row until
 * someone says whether its goods came back. Pure; returns the parts of the document it
 * changed. An order never taken, or already undone, holds nothing.
 */
export function holdRefund(doc, key, { at, rev, reason, label }) {
  const seen = doc.orders?.[key];
  if (!seen || seen.undone) return {};
  const orders = { ...doc.orders, [key]: { ...seen, rev: rev ?? (seen.rev ?? 1) + 1, undone: at, reason } };
  const refunds = { ...(doc.refunds ?? {}), [key]: { at, reason, label: label ?? key.replace('|', ' '), items: { ...(seen.items ?? {}) }, lines: { ...(seen.lines ?? {}) } } };
  return { orders, refunds };
}

/**
 * The answer to a refund row: the goods came back (`back`, its items go on the shelf,
 * once) or they did not (nothing moves). Either way the row is gone. Pure.
 */
export function resolveRefund(doc, { key, back, by = '', token = '' }, { now = Date.now() } = {}) {
  if (token && doc.tokens?.[token]) return { doc, records: [], duplicate: true };
  const row = doc.refunds?.[key];
  if (!row) throw new Error('refund ini sudah diputuskan');
  const at = Math.floor(now / 1000);
  const next = { ...doc, items: { ...doc.items }, moves: [...doc.moves], folded: { ...(doc.folded ?? {}) }, refunds: { ...doc.refunds }, orders: { ...doc.orders }, tokens: { ...(doc.tokens ?? {}) } };
  if (token) next.tokens[token] = at;
  delete next.refunds[key];
  const seen = next.orders[key];
  const rev = (seen?.rev ?? 1) + 1;
  const records = [];
  if (back) {
    for (const [code, qty] of Object.entries(row.items ?? {})) {
      const r = move(next, { id: `${key}|${rev}|${code}`, at, code, kind: 'return', delta: qty, ref: key, note: `${REFUND_REASONS[row.reason] ?? 'Batal'} ${row.label}: kembali ke rak`, ...(by ? { by } : {}) });
      if (r) records.push(r);
    }
  }
  if (seen) next.orders[key] = { ...seen, rev, back: Boolean(back), decided: at, ...(by ? { decidedBy: by } : {}) };
  next.refundLog = [...(doc.refundLog ?? []), { at, key, label: row.label, reason: row.reason, back: Boolean(back), items: row.items, by }].slice(-500);
  trim(next);
  return { doc: next, records };
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

/** Most lines one delivery may carry, and most units of one line. */
export const RECEIPT_LIMITS = { lines: 20, qty: 100000 };

/**
 * A supplier delivery: several items in at once, all or none. Pure. The same item twice
 * is added together; one token covers the whole delivery, so a resubmit records nothing.
 *
 * @param {{lines: Array<{code: string, qty: number}>, note?: string, by: string, token?: string}} input
 * @returns {{doc, records: Array, duplicate?: boolean}}
 */
export function receiveGoods(doc, { lines, note = '', by, token = '' }, { now = Date.now() } = {}) {
  if (token && doc.tokens?.[token]) return { doc, records: [], duplicate: true };
  if (!Array.isArray(lines) || !lines.length) throw new Error('pilih minimal satu barang');
  if (lines.length > RECEIPT_LIMITS.lines) throw new Error(`paling banyak ${RECEIPT_LIMITS.lines} barang sekali catat`);
  const total = {};
  for (const line of lines) {
    const code = String(line?.code ?? '').trim();
    const qty = Number(line?.qty);
    if (!doc.items?.[code]) throw new Error(`barang ${code || '(kosong)'} tidak ada di gudang`);
    if (!Number.isInteger(qty) || qty < 1 || qty > RECEIPT_LIMITS.qty) throw new Error(`jumlah ${code} harus bilangan bulat 1-${RECEIPT_LIMITS.qty}`);
    total[code] = (total[code] ?? 0) + qty;
  }
  const at = Math.floor(now / 1000);
  const tokens = { ...(doc.tokens ?? {}) };
  if (token) {
    tokens[token] = at;
    const keys = Object.keys(tokens);
    if (keys.length > MAX_TOKENS) for (const k of keys.sort((x, y) => tokens[x] - tokens[y]).slice(0, keys.length - MAX_TOKENS)) delete tokens[k];
  }
  const next = { ...doc, items: { ...doc.items }, moves: [...doc.moves], folded: { ...(doc.folded ?? {}) }, tokens };
  const suffix = token || Math.random().toString(36).slice(2, 9);
  const records = Object.entries(total).map(([code, qty]) => move(next, { id: `in-${code}-${at}-${suffix}`, at, code, kind: 'in', delta: qty, note: String(note).slice(0, 200), by }));
  trim(next);
  return { doc: next, records };
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
 * Set what one unit of a product takes off the shelf from now on, put back the built-in
 * recipe (`parts` null), or remove it (`remove`) so the product takes nothing. Pure. Orders already counted keep what they took: their
 * cancel returns exactly that, and only a change to their lines moves anything again.
 *
 * @param {{sku: string, parts: Array<{code: string, qty: number}>|null, by?: string}} input
 * @returns {{doc, recipe: object|null, changed: boolean}}
 */
export function setRecipe(doc, { sku, parts, remove = false, by = '' }, { now = Date.now() } = {}) {
  const product = findProduct(String(sku ?? '').trim());
  if (!product) throw new Error(`produk ${sku} tidak dikenal`);
  const next = { ...doc, recipes: { ...(doc.recipes ?? {}) } };
  const before = recipeOf(product.sku, doc.recipes ?? {});
  const withoutEdit = () => { const r = { ...next.recipes }; delete r[product.sku]; return r; };
  if (remove) {
    // Nothing built in either: forgetting the edit already means "takes nothing".
    if (recipeOf(product.sku, withoutEdit())) next.recipes[product.sku] = {};
    else delete next.recipes[product.sku];
  } else if (parts == null) {
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
    const builtIn = recipeOf(product.sku, withoutEdit());
    if (builtIn && sameItems(builtIn, recipe)) delete next.recipes[product.sku];
  }
  const after = recipeOf(product.sku, next.recipes);
  const changed = !sameItems(before ?? {}, after ?? {}) || Boolean(before) !== Boolean(after);
  if (changed) {
    next.recipeLog = [...(doc.recipeLog ?? []), { at: Math.floor(now / 1000), sku: product.sku, from: before, to: after, by }].slice(-200);
  }
  return { doc: changed ? next : doc, recipe: after, changed };
}

/**
 * Whether an order is still waiting for its picklist confirmation: from after the
 * migration, not cancelled, and not already taken (or taken, undone and its goods put
 * back on the shelf).
 */
export function awaitingPick(doc, order) {
  if (!order?.id || !order.channel || UNDONE.has(order.stage) || !afterOpening(order)) return false;
  const seen = doc?.orders?.[`${order.channel}|${order.id}`];
  return !seen || putBack(seen);
}

/** Picklist confirmations kept for the history; older ones fall off the front. */
const MAX_PICKS = 3000;

/**
 * The picklist history from the orders themselves, for a document confirmed before the
 * history was kept: one run per moment and person, which is what a confirmation is.
 */
function picksFromOrders(orders = {}) {
  const runs = new Map();
  for (const [key, o] of Object.entries(orders)) {
    if (!o?.picked) continue;
    const id = `${o.picked}-${o.by ?? ''}`;
    const run = runs.get(id) ?? { id, at: o.picked, by: o.by ?? '', orders: [] };
    run.orders.push({ key, lines: o.lines ?? {}, units: Object.values(o.items ?? {}).reduce((n, q) => n + q, 0) });
    runs.set(id, run);
  }
  return [...runs.values()].sort((a, b) => a.at - b.at);
}

/**
 * One picklist confirmation, written into the history: when, who, and each order taken
 * with its lines. Pure; called inside the same transaction as the shelf movement, so the
 * history and the stock never disagree about what was picked.
 */
export function recordPick(doc, { at, by = '', taken = [] }) {
  if (!taken.length) return doc;
  const orders = taken.map((key) => {
    const o = doc.orders?.[key] ?? {};
    return { key, lines: o.lines ?? {}, units: Object.values(o.items ?? {}).reduce((n, q) => n + q, 0) };
  });
  const run = { id: `${at}-${by}-${taken.length}-${taken[0]}`, at, by, orders };
  return { ...doc, picks: [...(doc.picks ?? []), run].slice(-MAX_PICKS) };
}
