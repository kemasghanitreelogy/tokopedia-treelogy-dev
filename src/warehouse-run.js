import { updateDoc, readDoc } from './store/index.js';
import { WAREHOUSE_DOC, emptyWarehouse, openWarehouse, applyOrders, manualMove, setRecipe, verifyWarehouse, recordPick } from './warehouse.js';
export { verifyWarehouse };
import { invalidate } from './cache.js';
import { printedLabels, arrangedOrders } from './shopify/label.js';
import { nextAction } from './fulfillment.js';
import { ordersInRange } from './db/orders.js';

/**
 * The first time each order's label came out of the printer, onto the order. Read from
 * the print ledger; an order with no entry was never printed here.
 */
export async function withPrintTimes(orders, printed) {
  const ledger = printed ?? await printedLabels().catch(() => ({}));
  return (orders ?? []).map((order) => {
    const entry = ledger[`${order.channel}:${order.id}`] ?? ledger[order.id] ?? null;
    // A backlog marked printed without printing says nothing about when it left.
    const at = entry && !entry.marked ? Number(entry.first ?? entry.at) : 0;
    return at > 0 ? { ...order, printedAt: at } : order;
  });
}

/**
 * The warehouse, run. Only ever touches warehouse/stock.json - never a marketplace and
 * never the master stock the channels follow.
 */

export async function loadWarehouse() {
  const doc = await readDoc(WAREHOUSE_DOC).catch(() => null);
  return openWarehouse(doc ?? emptyWarehouse());
}

/** Count these orders against the shelf. Idempotent: an order already counted is skipped. */
/**
 * Whether an order has reached the picklist - and so leaves the shelf now: paid and with
 * nothing left to do on the Proses page (the same nextAction that page reads), or gone
 * further already (packed, shipped, delivered, done) without ever having been counted.
 */
export function onPicklist(arranged = {}) {
  return (order) => (order.stage === 'to_ship' && !nextAction(order, arranged)) || LEFT.has(order.stage);
}
const LEFT = new Set(['shipping', 'delivered', 'completed']);

/**
 * Count these orders against the shelf, in one transaction: an order that has reached
 * the picklist is taken off once, a cancel puts back what was taken, an edit moves the
 * difference. Idempotent - run it as often as orders arrive.
 */
export async function syncWarehouse(orders, { now = Date.now(), update = updateDoc, printed, arranged } = {}) {
  orders = await withPrintTimes(orders, printed);
  const ready = onPicklist(arranged ?? await arrangedOrders().catch(() => ({})));
  let moved = [];
  await update(WAREHOUSE_DOC, (current) => {
    const opened = openWarehouse(current ?? emptyWarehouse(), { now });
    const before = new Set(Object.entries(opened.orders).filter(([, o]) => !o.undone).map(([k]) => k));
    const out = applyOrders(opened, orders, { now, admit: ready, by: 'otomatis' });
    moved = out.moved;
    const taken = Object.entries(out.doc.orders).filter(([k, o]) => !o.undone && !before.has(k) && o.picked === Math.floor(now / 1000)).map(([k]) => k);
    return recordPick(out.doc, { at: Math.floor(now / 1000), by: 'otomatis', taken });
  }, emptyWarehouse());
  if (moved.length) invalidate('warehouse');
  return { moved };
}

/**
 * Something on the Proses page changed (an order arranged): read the week's orders and
 * count whatever reached the picklist. Never throws, never awaited by its caller.
 */
export function warehouseSweep() {
  const now = Math.floor(Date.now() / 1000);
  return ordersInRange({ since: now - 7 * 86400, until: now })
    .then((orders) => syncWarehouse(orders))
    .then(({ moved }) => { if (moved.length) console.log(`gudang: ${moved.length} gerakan setelah atur pengiriman`); })
    .catch((error) => console.warn(`gudang: sapuan gagal - ${error.message}`));
}

/** A person's movement, in one transaction. */
export async function recordMove(input, { now = Date.now(), update = updateDoc } = {}) {
  // Assigned inside the transaction and read after it: a retried commit re-runs the
  // function on the fresh document, and only the run that committed is the one returned.
  let out = { record: null, duplicate: false };
  await update(WAREHOUSE_DOC, (current) => {
    const opened = openWarehouse(current ?? emptyWarehouse(), { now });
    out = manualMove(opened, input, { now });
    return out.doc;
  }, emptyWarehouse());
  invalidate('warehouse');
  return out;
}

/** A product's recipe set (or put back to built-in), in one transaction with the shelf. */
export async function saveRecipe(input, { now = Date.now(), update = updateDoc } = {}) {
  let out = { recipe: null, changed: false };
  await update(WAREHOUSE_DOC, (current) => {
    const opened = openWarehouse(current ?? emptyWarehouse(), { now });
    out = setRecipe(opened, input, { now });
    return out.doc;
  }, emptyWarehouse());
  invalidate('warehouse');
  return out;
}

let running = null;
let queued = [];

/** An order arrived. Never throws, never awaited by the webhook that called it. */
export function warehouseAfterOrder(order, options = {}) {
  if (order) queued.push(order);
  if (running) return running;
  running = (async () => {
    try {
      while (queued.length) {
        const batch = queued;
        queued = [];
        const { moved } = await syncWarehouse(batch, options);
        if (moved.length) console.log(`gudang: ${batch.map((o) => o.id).join(', ')} - ${moved.length} gerakan`);
      }
    } catch (error) {
      console.warn(`gudang: gagal mencatat pesanan - ${error.message}`);
    } finally {
      running = null;
    }
  })();
  return running;
}

export function resetWarehouseRun() { running = null; queued = []; }

