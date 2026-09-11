import { CHANNELS } from './omni.js';

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
        byChannel: Object.fromEntries(Object.keys(CHANNELS).map((id) => [id, 0])),
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
