import { businessDate, offsetSeconds } from '../clock.js';
import { findProduct, isBundle } from '../master.js';
import { loadManifest, loadChannelHistory, monthOf } from '../history/store.js';
import { DEMAND_STAGES } from '../history/ingest.js';

/**
 * Turning a pile of orders into one demand series per thing we actually make.
 *
 * Two decisions matter more than any model that comes after.
 *
 * Bundles are exploded. A sale of MRS-002 is a sale of MRS-001 and OMP-45-001, because
 * those are what get produced and run out; forecasting the bundle would tell us nothing
 * about the jar of powder inside it. The explosion is recursive - a bundle of a bundle
 * resolves all the way down - and guarded against a component list that loops.
 *
 * Cancelled and returned orders are excluded, not zeroed. The demand was real, but the
 * stock came back; counting it would have us produce for sales that unwound. They are
 * counted separately so the size of what is being excluded stays visible.
 */

const DAY = 86_400;
/** WIB calendar day of an instant, as YYYY-MM-DD. */
export const wibDay = businessDate;
const dayNumber = (epochSeconds) => Math.floor((epochSeconds + offsetSeconds()) / DAY);
const dayFromNumber = (n) => new Date(n * DAY * 1000).toISOString().slice(0, 10);

/**
 * Every component a sale of `sku` consumes, as {sku: qty}.
 * Depth-limited: a component list that referred to itself would otherwise never return.
 */
export function explode(sku, qty = 1, depth = 0, out = {}) {
  const product = findProduct(sku);
  if (!product || depth > 5) {
    out[sku] = (out[sku] ?? 0) + qty;
    return out;
  }
  if (!isBundle(product)) {
    out[product.sku] = (out[product.sku] ?? 0) + qty;
    return out;
  }
  for (const part of product.components) {
    explode(part.sku, qty * (Number(part.qty) || 1), depth + 1, out);
  }
  return out;
}

/**
 * Daily demand per component SKU across every channel.
 *
 * @returns {{series: Map<string, {days: string[], values: number[]}>, meta: object}}
 *   `values` has one entry per day from the first sale to `until`, with zeros for days
 *   that had none - a gap is not missing data, it is a day nobody bought.
 */
export function buildSeries(orders, { until = Math.floor(Date.now() / 1000) } = {}) {
  const byDay = new Map(); // sku -> Map(dayNumber -> qty)
  const meta = { orders: 0, excluded: 0, unknownSkus: new Map(), firstDay: null, lastDay: null };

  for (const order of orders) {
    if (!DEMAND_STAGES.has(order.stage)) { meta.excluded += 1; continue; }
    const day = dayNumber(order.at);
    if (day * DAY > until + DAY) continue;
    meta.orders += 1;
    meta.firstDay = meta.firstDay === null ? day : Math.min(meta.firstDay, day);
    meta.lastDay = meta.lastDay === null ? day : Math.max(meta.lastDay, day);

    for (const line of order.lines ?? []) {
      if (!line.sku || line.qty <= 0) continue;
      if (!findProduct(line.sku)) meta.unknownSkus.set(line.sku, (meta.unknownSkus.get(line.sku) ?? 0) + line.qty);
      for (const [component, qty] of Object.entries(explode(line.sku, line.qty))) {
        if (!byDay.has(component)) byDay.set(component, new Map());
        const days = byDay.get(component);
        days.set(day, (days.get(day) ?? 0) + qty);
      }
    }
  }

  const lastDay = Math.floor((until + offsetSeconds()) / DAY);
  const series = new Map();
  for (const [sku, days] of byDay) {
    const first = Math.min(...days.keys());
    const values = [];
    const labels = [];
    for (let d = first; d <= lastDay; d++) {
      values.push(days.get(d) ?? 0);
      labels.push(dayFromNumber(d));
    }
    series.set(sku, { days: labels, values });
  }

  return {
    series,
    meta: {
      ...meta,
      unknownSkus: [...meta.unknownSkus.entries()].map(([sku, qty]) => ({ sku, qty })).sort((a, b) => b.qty - a.qty),
      from: meta.firstDay === null ? null : dayFromNumber(meta.firstDay),
      to: meta.lastDay === null ? null : dayFromNumber(meta.lastDay),
    },
  };
}

/** Every stored order across every channel, oldest first. */
export async function loadAllOrders(channels = ['shopify', 'tiktok', 'shopee']) {
  const manifest = await loadManifest();
  const orders = [];
  const perChannel = {};
  for (const channel of channels) {
    const files = await loadChannelHistory(channel, manifest);
    let n = 0;
    for (const file of files) {
      orders.push(...file.orders.map((o) => ({ ...o, channel })));
      n += file.orders.length;
    }
    perChannel[channel] = { orders: n, months: files.length };
  }
  orders.sort((a, b) => a.at - b.at);
  return { orders, perChannel, months: Object.keys(manifest.channels ?? {}).length };
}

export { monthOf };
