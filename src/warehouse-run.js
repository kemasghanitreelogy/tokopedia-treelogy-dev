import { updateDoc, readDoc } from './store/index.js';
import { WAREHOUSE_DOC, emptyWarehouse, openWarehouse, applyOrders, manualMove, setRecipe, verifyWarehouse } from './warehouse.js';
export { verifyWarehouse };
import { invalidate } from './cache.js';

/**
 * The warehouse, run. Only ever touches warehouse/stock.json - never a marketplace and
 * never the master stock the channels follow.
 */

export async function loadWarehouse() {
  const doc = await readDoc(WAREHOUSE_DOC).catch(() => null);
  return openWarehouse(doc ?? emptyWarehouse());
}

/** Count these orders against the shelf. Idempotent: an order already counted is skipped. */
export async function syncWarehouse(orders, { now = Date.now(), update = updateDoc } = {}) {
  let moved = [];
  await update(WAREHOUSE_DOC, (current) => {
    const opened = openWarehouse(current ?? emptyWarehouse(), { now });
    const out = applyOrders(opened, orders, { now });
    moved = out.moved;
    return out.doc;
  }, emptyWarehouse());
  if (moved.length) invalidate('warehouse');
  return { moved };
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
