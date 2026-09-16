import { invoiceCatalogue, ours } from './catalogue.js';
import { ordersInRange } from '../db/orders.js';
import { customIdFor, saleValue } from './invoice.js';
import { channelDate } from '../clock.js';
import { POSTABLE_STAGES } from './sync.js';
import { wibDayStart, wibDate } from '../range.js';

/**
 * The daily recap, computed from both sides at once.
 *
 * Finance reconciles a day by opening the marketplace back office beside Jurnal, and for
 * weeks the two totals differed by amounts nobody could account for - first Rp56 million,
 * then Rp49 million, then Rp5.5 million as each cause was found and fixed. Every one of
 * those investigations was done by hand against screenshots.
 *
 * This does it properly: orders per day from Postgres, invoices per day from Jurnal, side
 * by side, with the difference named. A day that does not tie out says so, and says by how
 * much and in which direction, which is the whole of what an operator needs to know.
 *
 * Both sides are bucketed by the *platform's own* calendar day - the same rule the invoice
 * date follows - so a Shopify order near midnight lands on the day Shopify shows it, not
 * the day Jakarta would. Bucketing them differently is its own source of phantom gaps.
 */

/** @param {{from: string, until?: number}} options */
export async function dailyRecap({ from, until = Math.floor(Date.now() / 1000) } = {}) {
  const since = wibDayStart(from);
  if (since === null) throw new Error(`tanggal tidak valid: ${from}`);

  const [orders, catalogue] = await Promise.all([
    ordersInRange({ since, until }),
    invoiceCatalogue({ since: from }),
  ]);
  const inJurnal = ours(catalogue.invoices);

  const days = new Map();
  const day = (key) => {
    if (!days.has(key)) days.set(key, { day: key, orders: 0, orderValue: 0, invoices: 0, invoiceValue: 0, missing: 0, missingValue: 0 });
    return days.get(key);
  };

  // What the shop sold, and whether the books have it.
  for (const order of orders) {
    if (!POSTABLE_STAGES.has(order.stage)) continue;
    const key = channelDate(order.createdAt, order.channel);
    const row = day(key);
    const value = saleValue(order) ?? Math.round(Number(order.total) || 0);
    row.orders += 1;
    row.orderValue += value;
    if (!inJurnal.has(customIdFor(order))) {
      row.missing += 1;
      row.missingValue += value;
    }
  }

  // What the books hold, counted on the invoice's own date - which is what Jurnal reports
  // and therefore what finance will be comparing against.
  for (const invoice of inJurnal.values()) {
    if (!invoice.date) continue;
    const row = day(invoice.date);
    row.invoices += 1;
    row.invoiceValue += invoice.total;
  }

  const rows = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  for (const row of rows) row.difference = row.invoiceValue - row.orderValue;

  const matched = rows.filter((r) => r.difference === 0 && r.orders === r.invoices);
  return {
    from,
    to: wibDate(until),
    rows,
    matched: matched.length,
    // The two numbers a person actually acts on: what is not in the books at all, and
    // what the books hold that the orders do not explain.
    missing: rows.reduce((n, r) => n + r.missing, 0),
    missingValue: rows.reduce((n, r) => n + r.missingValue, 0),
    orderValue: rows.reduce((n, r) => n + r.orderValue, 0),
    invoiceValue: rows.reduce((n, r) => n + r.invoiceValue, 0),
    requests: catalogue.requests,
    cached: catalogue.cached,
  };
}
