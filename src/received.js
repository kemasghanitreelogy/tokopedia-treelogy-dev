import { readDoc, updateDoc } from './store/index.js';
import { ordersInRange } from './db/orders.js';
import { tiktokConfig, isMarketplace } from './omni.js';
import { callApi } from './client.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi } from './shopee/client.js';

/**
 * The money a marketplace sale actually leaves us with, after commission, service fees and
 * tax. It is neither `order.total` (what the buyer paid) nor saleValue (the gross price the
 * invoice books), and it never replaces them: one Shopee order on 4 Nov 2026 read 488,750
 * paid, 565,000 gross, 481,825 received, and the books stay on the gross figure.
 *
 * No order read carries this number, so a job collects it and the order readers attach it
 * as `order.received`, the way Shopee's recipient names are put back.
 *
 *   Shopee   get_escrow_detail answers from the moment an order exists. It stays an
 *            estimate until the order completes.
 *   TikTok   Tokopedia included. statement_transactions answers zero until the order
 *            settles; before that only the unsettled list has an estimate, and an order
 *            leaves that list when it settles.
 */

/** A month per document, so a page reads only the months its orders fall in. */
const monthOf = (order) => new Date(Number(order.createdAt) * 1000).toISOString().slice(0, 7);
export const receivedDoc = (month) => `finance/received/${month}.json`;

const SHOPEE_BATCH = 50;
const SHOPEE_FINAL = new Set(['completed', 'cancelled', 'returned']);
const NEVER_PAID = new Set(['unpaid', 'cancelled']);
const UNSETTLED_MAX_PAGES = 60;
/**
 * One at a time, on purpose. Four in parallel tripped TikTok's rate limit within seconds, and
 * that limit is shared by the whole app: the order reads live behind the same one.
 */
const LOOKUP_PAUSE_MS = 400;
/** An order with no answer yet is asked again after this, not on every run. */
const RETRY_SECONDS = 6 * 3600;
const DEFAULT_LOOKBACK_DAYS = 60;

const amount = (value) => Math.round(Number(value) || 0);

export async function loadReceived(orders) {
  const months = [...new Set(orders.filter(isMarketplace).map(monthOf))];
  const docs = await Promise.all(months.map((month) => readDoc(receivedDoc(month)).catch(() => null)));
  return Object.assign({}, ...docs.map((doc) => doc?.orders ?? {}));
}

export function applyReceived(orders, received) {
  if (!received) return orders;
  for (const order of orders) {
    const entry = isMarketplace(order) ? received[order.id] : null;
    if (Number.isFinite(entry?.a)) order.received = { amount: entry.a, estimate: Boolean(entry.e) };
  }
  return orders;
}

async function readShopeeEscrow(ids) {
  const { config, auth } = await resolveShopeeSession();
  const found = new Map();
  for (let i = 0; i < ids.length; i += SHOPEE_BATCH) {
    const { response } = await callShopApi(config, '/api/v2/payment/get_escrow_detail_batch', auth, {}, {
      order_sn_list: ids.slice(i, i + SHOPEE_BATCH),
    });
    for (const { escrow_detail: detail } of response ?? []) {
      const income = detail?.order_income;
      if (!income) continue;
      // The adjusted figure is the one that lands once a partial refund has been taken off.
      found.set(detail.order_sn, amount(income.escrow_amount_after_adjustment ?? income.escrow_amount));
    }
  }
  return found;
}

async function readTikTokUnsettled() {
  const config = await tiktokConfig();
  const found = new Map();
  let pageToken = '';
  for (let page = 0; page < UNSETTLED_MAX_PAGES; page += 1) {
    const query = { sort_field: 'order_create_time', sort_order: 'DESC', page_size: '100' };
    if (pageToken) query.page_token = pageToken;
    const { data } = await callApi({ config, path: '/finance/202507/orders/unsettled', query });
    for (const row of data?.transactions ?? []) {
      if (row.type === 'ORDER' && row.order_id) found.set(row.order_id, amount(row.est_settlement_amount));
    }
    pageToken = data?.next_page_token ?? '';
    if (!pageToken) break;
  }
  return found;
}

/** Null until the order has settled: the endpoint answers zero rows rather than an error. */
async function readTikTokSettled(id) {
  const config = await tiktokConfig();
  const { data } = await callApi({ config, path: `/finance/202501/orders/${id}/statement_transactions` });
  return Number(data?.total_count) > 0 ? amount(data.settlement_amount) : null;
}

/**
 * One pass over every marketplace order that has no final figure yet.
 *
 * Each platform is its own attempt: Shopee being down must not cost TikTok's run. A failed
 * TikTok lookup ends that platform's pass, because the next one would only press on a limit
 * the app shares; what was read so far is still stored. Only reads the platforms, and
 * `dryRun` leaves the store alone too.
 */
export async function syncReceived({
  now = Math.floor(Date.now() / 1000),
  since = now - DEFAULT_LOOKBACK_DAYS * 86400,
  maxLookups = 100,
  pauseMs = LOOKUP_PAUSE_MS,
  dryRun = false,
  readOrders = ordersInRange,
  readShopee = readShopeeEscrow,
  readUnsettled = readTikTokUnsettled,
  readSettled = readTikTokSettled,
} = {}) {
  const orders = (await readOrders({ since, until: now, channels: ['tokopedia', 'tiktok_shop', 'shopee'] }))
    .filter(isMarketplace);
  const known = await loadReceived(orders);
  const open = orders.filter((order) => !(Number.isFinite(known[order.id]?.a) && !known[order.id].e));

  const entries = new Map();
  const tally = { open: open.length, final: 0, estimate: 0, waiting: 0, skipped: 0, errors: {} };
  const put = (order, value, estimate) => {
    entries.set(order, estimate ? { a: value, e: 1 } : { a: value });
    tally[estimate ? 'estimate' : 'final'] += 1;
  };

  const shopee = open.filter((order) => order.channel === 'shopee');
  if (shopee.length > 0) {
    try {
      const found = await readShopee(shopee.map((order) => order.id));
      for (const order of shopee) {
        if (found.has(order.id)) put(order, found.get(order.id), !SHOPEE_FINAL.has(order.stage));
      }
    } catch (error) { tally.errors.shopee = error.message; }
  }

  const tiktok = open.filter((order) => order.channel !== 'shopee');
  if (tiktok.length > 0) {
    try {
      const unsettled = await readUnsettled();
      const lookups = [];
      for (const order of tiktok) {
        if (unsettled.has(order.id)) put(order, unsettled.get(order.id), true);
        else if (!NEVER_PAID.has(order.stage) && now - (known[order.id]?.t ?? 0) >= RETRY_SECONDS) lookups.push(order);
      }
      // Longest-waiting first, so a backfill bigger than one run still gets through all of it.
      lookups.sort((a, b) => (known[a.id]?.t ?? 0) - (known[b.id]?.t ?? 0) || a.createdAt - b.createdAt);
      tally.skipped = Math.max(0, lookups.length - maxLookups);
      for (const order of lookups.slice(0, maxLookups)) {
        const settled = await readSettled(order.id);
        if (settled !== null) put(order, settled, false);
        else {
          // Keep an estimate already held: "not settled yet" says nothing against it.
          entries.set(order, { ...known[order.id], t: now });
          tally.waiting += 1;
        }
        if (pauseMs) await new Promise((done) => setTimeout(done, pauseMs));
      }
    } catch (error) { tally.errors.tiktok = error.message; }
  }

  if (!dryRun) {
    const byMonth = new Map();
    for (const [order, entry] of entries) {
      const month = monthOf(order);
      if (!byMonth.has(month)) byMonth.set(month, {});
      byMonth.get(month)[order.id] = entry;
    }
    for (const [month, rows] of byMonth) {
      await updateDoc(receivedDoc(month), (current) => {
        const next = current ?? { orders: {} };
        Object.assign(next.orders, rows);
        return next;
      });
    }
  }
  return { ...tally, entries };
}
