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
 *   TikTok   Tokopedia included. Until an order settles only the unsettled list has a
 *            figure, an estimate. After that it is in a daily statement.
 */

/** A month per document, so a page reads only the months its orders fall in. */
const monthOf = (order) => new Date(Number(order.createdAt) * 1000).toISOString().slice(0, 7);
export const receivedDoc = (month) => `finance/received/${month}.json`;

const SHOPEE_BATCH = 50;
const SHOPEE_FINAL = new Set(['completed', 'cancelled', 'returned']);
const UNSETTLED_MAX_PAGES = 60;
const DEFAULT_LOOKBACK_DAYS = 60;
/** Statements re-read on every run; wider than any outage the timer should sleep through. */
const STATEMENT_LOOKBACK_DAYS = 7;
/**
 * TikTok's limit is shared across the app group, order reads included, and it is tight:
 * asking per order tripped it after 23 sequential calls. A statement carries a whole day of
 * orders, which is why settled figures come from there, and it is still paced.
 */
const TIKTOK_PAUSE_MS = 1000;
const TIKTOK_RETRY_MS = 60_000;
const TIKTOK_ATTEMPTS = 3;

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

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** One paced call, with room for the limit to clear before giving up. */
async function askTikTok(config, path, query, { pauseMs = TIKTOK_PAUSE_MS, retryMs = TIKTOK_RETRY_MS, call = callApi } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { data } = await call({ config, path, query });
      await wait(pauseMs);
      return data ?? {};
    } catch (error) {
      if (attempt >= TIKTOK_ATTEMPTS) throw error;
      await wait(retryMs);
    }
  }
}

/**
 * Every order settled in statements since `since`. `error` rather than a throw, so a run cut
 * short still stores the statements it did read: a long backfill must not lose them.
 */
export async function readTikTokStatements({ since, now, ask = askTikTok, config = null }) {
  const session = config ?? await tiktokConfig();
  const found = new Map();
  try {
    let pageToken = '';
    do {
      const query = {
        sort_field: 'statement_time', sort_order: 'DESC', page_size: '100',
        statement_time_ge: String(since), statement_time_lt: String(now),
      };
      if (pageToken) query.page_token = pageToken;
      const page = await ask(session, '/finance/202309/statements', query);
      for (const statement of page.statements ?? []) {
        // A statement of adjustments alone has no order in it worth a call.
        if (amount(statement.revenue_amount) === 0) continue;
        let rowToken = '';
        do {
          const rowQuery = { sort_field: 'order_create_time', page_size: '100' };
          if (rowToken) rowQuery.page_token = rowToken;
          const rows = await ask(session, `/finance/202501/statements/${statement.id}/statement_transactions`, rowQuery);
          for (const row of rows.transactions ?? []) {
            if (row.type === 'ORDER' && row.order_id) {
              found.set(row.order_id, (found.get(row.order_id) ?? 0) + amount(row.settlement_amount));
            }
          }
          rowToken = rows.next_page_token ?? '';
        } while (rowToken);
      }
      pageToken = page.next_page_token ?? '';
    } while (pageToken);
    return { found };
  } catch (error) {
    return { found, error: error.message };
  }
}

/**
 * One pass over every marketplace order that has no final figure yet.
 *
 * Each platform is its own attempt: Shopee being down must not cost TikTok's run. Only
 * reads the platforms, and `dryRun` leaves the store alone too.
 */
export async function syncReceived({
  now = Math.floor(Date.now() / 1000),
  since = now - DEFAULT_LOOKBACK_DAYS * 86400,
  statementsSince = now - STATEMENT_LOOKBACK_DAYS * 86400,
  dryRun = false,
  readOrders = ordersInRange,
  readShopee = readShopeeEscrow,
  readUnsettled = readTikTokUnsettled,
  readSettled = readTikTokStatements,
} = {}) {
  const orders = (await readOrders({ since, until: now, channels: ['tokopedia', 'tiktok_shop', 'shopee'] }))
    .filter(isMarketplace);
  const known = await loadReceived(orders);
  const open = orders.filter((order) => !(Number.isFinite(known[order.id]?.a) && !known[order.id].e));

  const entries = new Map();
  const tally = { open: open.length, final: 0, estimate: 0, errors: {} };
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
      const { found: settled, error } = await readSettled({ since: statementsSince, now });
      if (error) tally.errors.tiktok = error;
      for (const order of tiktok) {
        if (settled.has(order.id)) put(order, settled.get(order.id), false);
        else if (unsettled.has(order.id)) put(order, unsettled.get(order.id), true);
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
