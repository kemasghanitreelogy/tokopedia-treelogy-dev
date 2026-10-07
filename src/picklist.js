import { CHANNELS , MANUAL_CHANNEL } from './omni.js';
import { nextAction } from './fulfillment.js';
import { awaitingPick, batchOf } from './warehouse.js';
import { findProduct } from './master.js';

/**
 * Whether an order belongs on the picklist now: still to be picked from the shelf (after
 * the migration, not yet confirmed) and with nothing left to do on the Proses page. One
 * that needs "Atur pengiriman" joins once it is arranged; one that never needs it joins
 * at once.
 */
export function readyToPick(order, { shelf = null, arranged = {} } = {}) {
  return PICKABLE_STAGES.has(order?.stage) && awaitingPick(shelf, order) && !nextAction(order, arranged);
}

/**
 * What the warehouse actually has to pick.
 *
 * Only orders that are paid and not yet handed to a courier are pickable: anything still
 * unpaid may never be paid, and anything already shipped is gone. Cancelled orders are
 * excluded for the obvious reason - picking one is a real, physical mistake.
 */

export const PICKABLE_STAGES = new Set(['to_ship']);

export function buildPicklist(orders, { stages = PICKABLE_STAGES } = {}) {
  const pickable = orders.filter((o) => stages.has(o.stage));

  const bySku = new Map();
  for (const order of pickable) {
    for (const line of order.lines ?? []) {
      const entry = bySku.get(line.sku) ?? {
        sku: line.sku,
        name: line.name,
        variant: line.variant,
        qty: 0,
        orders: 0,
        // Typed-in parcels pick off the same shelf as every other order, so they get a
        // bucket too. Without one the count went to NaN the first time a resend reached
        // this list - invisible today, because the page only prints three of the columns.
        byChannel: Object.fromEntries([...Object.keys(CHANNELS), MANUAL_CHANNEL.id].map((id) => [id, 0])),
      };
      entry.qty += line.qty;
      entry.orders += 1;
      entry.byChannel[order.channel] += line.qty;
      // Keep the first non-empty description we see; channels title things differently.
      if (!entry.name && line.name) entry.name = line.name;
      bySku.set(line.sku, entry);
    }
  }

  const items = [...bySku.values()].sort((a, b) => b.qty - a.qty || a.sku.localeCompare(b.sku));

  return {
    items,
    orderCount: pickable.length,
    unitCount: items.reduce((n, i) => n + i.qty, 0),
    skuCount: items.length,
  };
}

/** Orders behind one SKU, so a picker can be told which parcels a shortage will hit. */
export function ordersForSku(orders, sku, { stages = PICKABLE_STAGES } = {}) {
  return orders
    .filter((o) => stages.has(o.stage))
    .filter((o) => (o.lines ?? []).some((l) => l.sku === sku))
    .map((o) => ({
      id: o.id,
      channel: o.channel,
      buyer: o.buyer,
      qty: (o.lines ?? []).filter((l) => l.sku === sku).reduce((n, l) => n + l.qty, 0),
      createdAt: o.createdAt,
    }));
}

/**
 * One picklist batch, from the warehouse's own record of what it took: every order that
 * reached the picklist (and so left the shelf) inside the batch's window, minus those
 * cancelled or returned since. `live` lends the current order (buyer, lines as titled on
 * the channel) where it is still at hand; otherwise the lines are named from the master.
 */
export function batchOrders(doc, date, live = []) {
  const byKey = new Map(live.map((o) => [`${o.channel}|${o.id}`, o]));
  const out = [];
  for (const [key, row] of Object.entries(doc?.orders ?? {})) {
    if (!row?.picked || row.undone || batchOf(row.picked) !== date) continue;
    const at = key.indexOf('|');
    const channel = key.slice(0, at);
    const id = key.slice(at + 1);
    const current = byKey.get(key);
    const lines = current?.lines?.length ? current.lines : Object.entries(row.lines ?? {}).map(([sku, qty]) => {
      const p = findProduct(sku);
      return { sku, qty, name: p?.name ?? sku, variant: p?.variant ?? '' };
    });
    out.push({
      channel, id, stage: 'to_ship', lines,
      buyer: current?.buyer ?? row.buyer ?? '',
      createdAt: current?.createdAt ?? row.created ?? row.picked,
      pickedAt: row.picked,
      gateways: current?.gateways,
    });
  }
  return out.sort((a, b) => a.pickedAt - b.pickedAt || a.createdAt - b.createdAt);
}

/** The batches the record holds, newest first, with how many orders each took. */
export function batchesIn(doc) {
  const counts = new Map();
  for (const row of Object.values(doc?.orders ?? {})) {
    if (!row?.picked || row.undone) continue;
    const d = batchOf(row.picked);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}
