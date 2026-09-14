import { rpc, selectAll, request, isSupabaseConfigured } from './client.js';
import { findProduct } from '../master.js';

/**
 * Orders in Postgres: the one place the rest of the system asks for a sale.
 *
 * Before this, every page view fanned out to three marketplaces and waited for the
 * slowest. That is a lot of latency and a lot of quota for data that does not change
 * between two refreshes, and it made the dashboard only as available as the least
 * available platform. Now a push writes the order once and every reader after that is a
 * single indexed query.
 *
 * What is stored is the normalised order exactly as collectOrders produced it, so a row
 * read back is indistinguishable from a live read. That is deliberate: the moment the
 * database holds a *different* shape, every consumer needs to know which source it is
 * talking to, and the seam stops being a seam.
 */

/** Where the operational record begins. Older sales live in the forecasting corpus. */
export const DB_HISTORY_START = '2026-08-01';

/** Epoch seconds of 1 August 2026, 00:00 WIB. */
export const DB_HISTORY_START_EPOCH = Math.floor(Date.parse(`${DB_HISTORY_START}T00:00:00+07:00`) / 1000);

/**
 * Orders per round trip.
 *
 * Each carries its whole payload - line items, addresses, finance - so a hundred of them
 * is a request of a few hundred kilobytes. Large enough that 30,000 orders is 300 calls
 * rather than 30,000, small enough that one failure re-sends something small.
 */
const BATCH = 100;

const iso = (epochSeconds) => new Date(epochSeconds * 1000).toISOString();

/**
 * Resolve each line onto the master catalogue before it is stored.
 *
 * The resolution has to happen here rather than in SQL, because the master catalogue is
 * where the knowledge lives that GFT-POUCH-001 and Travel-Pouch are one product, and
 * duplicating that table into Postgres would mean two versions of it to keep in step.
 * An unresolved SKU is written as null, not as a guess - a null is a question somebody
 * can answer, an invented code is a wrong answer nobody will notice.
 */
function enrich(order, fetchedAt) {
  const lines = order.finance?.lines ?? [];
  return {
    ...order,
    fetchedAt,
    finance: order.finance
      ? {
          ...order.finance,
          lines: lines.map((line) => ({ ...line, masterSku: findProduct(line.sku)?.sku ?? null })),
        }
      : order.finance,
  };
}

/**
 * Write orders, newest read wins.
 *
 * Safe to call with the same orders repeatedly - that is the point. A webhook, the
 * 15-minute sweep and a manual backfill all post the same order sooner or later, and the
 * function in Postgres keeps whichever was read from the platform most recently rather
 * than whichever arrived last.
 *
 * @returns {Promise<{written: number, batches: number, rejected: Array<{channel: string, id: string, error: string}>}>}
 */
export async function saveOrders(orders, { source = 'unknown', fetchedAt = Date.now() / 1000 } = {}) {
  if (!Array.isArray(orders) || orders.length === 0) return { written: 0, batches: 0, rejected: [] };

  let written = 0;
  let batches = 0;
  const rejected = [];

  for (let i = 0; i < orders.length; i += BATCH) {
    const slice = orders.slice(i, i + BATCH).map((order) => enrich(order, fetchedAt));
    batches += 1;
    try {
      written += Number(await rpc('ingest_orders', { p_orders: slice, p_source: source })) || 0;
    } catch (error) {
      // One unusable order must not cost the ninety-nine it travelled with.
      //
      // This is not hypothetical: a Shopify total arrived as "1073252.09", Postgres
      // refused to read it as a whole number of rupiah, and the entire batch rolled back.
      // A hundred orders disappeared because of one sen. Retrying one at a time turns
      // that into one named order to look at, and costs an extra round trip only on the
      // batch that actually had something wrong with it.
      if (error?.retryable || slice.length === 1) throw error;
      for (const one of slice) {
        try {
          written += Number(await rpc('ingest_orders', { p_orders: [one], p_source: source })) || 0;
        } catch (single) {
          if (single?.retryable) throw single;
          rejected.push({ channel: one.channel, id: one.id, error: single.message });
        }
      }
    }
  }
  return { written, batches, rejected };
}

/**
 * Every order whose creation falls inside the window, newest first.
 *
 * Returns the stored payloads untouched, which is what makes this a drop-in for a live
 * read. `until` is inclusive, matching how the range helper describes a day.
 */
export async function ordersInRange({ since, until, channels = null } = {}) {
  const params = {
    select: 'payload',
    // Both bounds go in one `and` group: two filters on the same column cannot be two
    // keys of one object, and PostgREST reads this form identically.
    and: `(created_at.gte.${iso(since)},created_at.lte.${iso(until)})`,
    order: 'created_at.desc',
  };
  if (Array.isArray(channels) && channels.length > 0) {
    params.channel = `in.(${channels.map((c) => `"${c}"`).join(',')})`;
  }
  const rows = await selectAll('orders', params);
  return rows.map((row) => row.payload).filter(Boolean);
}

/** A single order by its platform id, or null. */
export async function orderById(channel, id) {
  const rows = await selectAll('orders', {
    select: 'payload',
    channel: `eq.${channel}`,
    id: `eq.${id}`,
    limit: 1,
  });
  return rows[0]?.payload ?? null;
}

/**
 * How far each source has actually been read.
 *
 * Keyed by source, not by channel: one TikTok Shop pull answers for both the tokopedia
 * and tiktok_shop channels, so a week with no Tokopedia sales would otherwise never be
 * marked as read and the dashboard would consider itself blind there forever.
 *
 * A window nobody has ingested returns zero rows, and so does a quiet week. Only this
 * table tells the two apart, which is the difference between a dashboard that is fast and
 * one that is confidently wrong.
 *
 * @returns {Promise<Record<string, {from: number, through: number, at: string}>>}
 */
export async function readCoverage(options = {}) {
  const rows = await selectAll('ingest_coverage', { select: '*' }, options);
  const out = {};
  for (const row of rows) {
    out[row.source] = {
      from: Math.floor(Date.parse(row.covered_from) / 1000),
      through: Math.floor(Date.parse(row.covered_through) / 1000),
      at: row.last_run_at,
      note: row.note ?? '',
    };
  }
  return out;
}

/**
 * Record that a source is read through a point in time.
 *
 * Only ever widens: a sweep covering the last seven days must not shrink the window a
 * full backfill established, and a backfill re-run for one month must not erase the rest.
 */
export async function recordCoverage(source, { from, through, note = '' }) {
  const existing = (await readCoverage())[source];
  const nextFrom = existing ? Math.min(existing.from, from) : from;
  const nextThrough = existing ? Math.max(existing.through, through) : through;
  await request('ingest_coverage', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: [{
      source,
      covered_from: iso(nextFrom),
      covered_through: iso(nextThrough),
      last_run_at: new Date().toISOString(),
      note,
    }],
  });
  return { from: nextFrom, through: nextThrough };
}

/**
 * Can the database answer for this window on its own?
 *
 * Every source that is meant to be there has to cover the whole window. One source behind
 * is enough to make the answer wrong in a way nobody can see - the page would look normal
 * and simply be missing Shopee - so the rule is all or nothing, and the caller falls back
 * to reading the platforms.
 */
export function coversRange(coverage, { since, until }, sources) {
  if (!coverage || !Array.isArray(sources) || sources.length === 0) return false;
  return sources.every((source) => {
    const window = coverage[source];
    return Boolean(window) && window.from <= since && window.through >= until;
  });
}

/** How many orders and lines are held, for the status page. */
export async function dbStats(options = {}) {
  if (!isSupabaseConfigured()) return null;
  const { contentRange } = await request('orders', {
    ...options,
    params: { select: 'channel' },
    range: '0-0',
    prefer: 'count=exact',
  });
  const total = Number(String(contentRange ?? '').split('/')[1]);
  return { orders: Number.isFinite(total) ? total : null };
}
