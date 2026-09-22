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
      //
      // A failure worth retrying is different: the database is unreachable or ill, the
      // next batch would fail the same way, and the operator has to be told - so that one
      // still stops everything.
      if (error?.retryable) throw error;
      // A slice of one has nothing left to split, but it does not follow that the call
      // should end. That was the one case where throwing cost the most: a batch of exactly
      // one is the *last* slice of 101 orders, so the hundred already written were
      // reported to nobody and a long backfill died on its final batch. It is rejected,
      // named and counted like every other order the database refuses.
      if (slice.length === 1) {
        rejected.push({ channel: slice[0].channel, id: slice[0].id, error: error.message });
        continue;
      }
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
    // A unique tiebreaker, not just the timestamp.
    //
    // Postgres gives no stable order to rows that compare equal, and marketplace orders
    // routinely share a second. Paged by offset, a tie group straddling a page boundary
    // can put one row on both pages and drop its sibling - silently, with no error, on
    // any window past a thousand orders. The primary key settles it.
    order: 'created_at.desc,channel.asc,id.asc',
  };
  if (Array.isArray(channels) && channels.length > 0) {
    params.channel = `in.(${channels.map((c) => `"${c}"`).join(',')})`;
  }
  // A dashboard read that has not answered in eight seconds is not going to; the caller
  // has a cached window or four platforms to fall back on, and thirty seconds of
  // skeleton, three times over, is what "stuck" looked like from the operator's chair.
  const rows = await selectAll('orders', params, { timeout: 8_000, retries: 2 });
  return rows.map((row) => row.payload).filter(Boolean);
}

/** Stages that still owe somebody an action: something to arrange, to pick, to print. */
export const OUTSTANDING_STAGES = ['unpaid', 'to_ship', 'shipping'];
/** Channels whose orders are work whatever their stage says; a typed-in sale is done the moment it is typed. */
export const OUTSTANDING_CHANNELS = ['manual'];
/**
 * How far back a worklist looks. Nothing waiting is older than this; a row that still
 * says "to ship" after four months is a read we never got, not work somebody owes.
 */
export const OUTSTANDING_DAYS = 120;

const quoted = (value) => `"${String(value).replace(/"/g, '')}"`;

/**
 * Everything that still needs doing, whatever day it was placed.
 *
 * The worklists - Proses, Picklist, Label - are not reports: an order placed on Friday
 * that nobody arranged is still work on Monday, and a date window is precisely the thing
 * that hides it. So they ask by stage instead, which the table is indexed for
 * (stage, created_at desc), and which returns the hundred-odd rows that are actually
 * open rather than the six thousand a wide window would carry.
 */
export async function ordersOutstanding({
  stages = OUTSTANDING_STAGES,
  channels = OUTSTANDING_CHANNELS,
  since = Math.floor(Date.now() / 1000) - OUTSTANDING_DAYS * 86400,
  ...options
} = {}) {
  const clauses = [`stage.in.(${stages.map(quoted).join(',')})`];
  if (channels.length > 0) clauses.push(`channel.in.(${channels.map(quoted).join(',')})`);
  const rows = await selectAll('orders', {
    select: 'payload',
    created_at: `gte.${iso(since)}`,
    or: `(${clauses.join(',')})`,
    order: 'created_at.desc,channel.asc,id.asc',
  }, { timeout: 8_000, retries: 2, ...options });
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
 * Many orders by id, in one round trip per channel.
 *
 * Printing a hundred labels used to mean asking the platforms for them, and for Shopify
 * that is a sixty-day scan - eleven seconds before a single page was drawn. Every one of
 * those orders is already here, and Supabase answers a keyed read in a quarter of a
 * second whether it is asked for one row or a hundred.
 *
 * @param {{channel: string, id: string}[]} selection
 * @returns {Promise<object[]>} the orders it holds; anything missing is simply absent,
 *   which is the caller's cue to go and ask the platform for those and only those.
 */
export async function ordersByIds(selection) {
  const byChannel = new Map();
  for (const { channel, id } of selection) {
    if (!channel || !id) continue;
    if (!byChannel.has(channel)) byChannel.set(channel, new Set());
    byChannel.get(channel).add(String(id));
  }
  if (byChannel.size === 0) return [];

  const pages = await Promise.all([...byChannel].map(([channel, ids]) => selectAll('orders', {
    select: 'payload',
    channel: `eq.${channel}`,
    // PostgREST reads a quoted list, and an order name carries characters - "#10926",
    // "260918C0F11PKT" - that must not be read as list syntax.
    id: `in.(${[...ids].map((id) => `"${id.replace(/"/g, '')}"`).join(',')})`,
  })));

  return pages.flat().map((row) => row.payload).filter(Boolean);
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
  // Ordered for the same reason ordersInRange is, one table smaller.
  //
  // Postgres returns rows in no particular order, and selectAll pages by offset, so a read
  // that ever needs a second page can serve one row twice and another not at all. Three
  // sources will not reach a thousand rows this decade - but this is the same select the
  // next table to grow will be read with, and the failure it produces is a source silently
  // missing from the coverage map, which reads as "never ingested" and sends every
  // dashboard back to the platforms with nothing to explain why.
  const rows = await selectAll('ingest_coverage', { select: '*', order: 'source.asc' }, options);
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
 *
 * The widening is read-modify-write and PostgREST has no compare-and-set to do it with, so
 * two writers - the sweep and a dashboard that just read a window live - can read the same
 * row and the later upsert wins. That race is worth naming rather than fixing, because of
 * which way it falls: every writer stores the union of what it read and what it just
 * covered for real, so a lost update can only ever leave the window *narrower* than the
 * truth, never wider. A narrow window is read live again; a wide one is never revisited.
 * The number this returns is therefore what was asked for, not a promise about what is in
 * the table a moment later - no caller treats it as one, and none should start.
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
 * How long a source may go without a completed sweep before it stops being trusted.
 *
 * The sweep runs every fifteen minutes and widens the covered window each time, so a
 * record older than this means the ingest is not running - not that the shop is quiet.
 * Twenty-five minutes leaves room for one missed tick before the dashboard silently goes
 * back to reading the platforms.
 */
export const STALE_AFTER_MS = 25 * 60_000;

/**
 * Can the database answer for this window on its own?
 *
 * Two conditions, and the second one is the subtle half.
 *
 * The first is the obvious one: the stored window has to start at or before the window
 * being asked for. Every source that is meant to be there has to satisfy it - one source
 * behind is enough to make the answer wrong in a way nobody can see, because the page
 * would look entirely normal and simply be missing Shopee.
 *
 * The second is about the other end, and a literal reading of it makes the database
 * useless. A coverage row records how far a sweep got at the moment it ran; a dashboard
 * asking for "today" wants a window ending *now*, which is always later than that. Demand
 * that `through` reach `until` and the answer is always no, for every reader, forever -
 * which is exactly what happened the first time this was measured: every request fell
 * through to the platforms and the database was never once read.
 *
 * What actually keeps the tail correct is not the sweep, it is the webhooks: an order is
 * written seconds after the buyer pays. So the honest test for the recent end is not
 * "has a sweep covered it" but "is the ingest alive", and the coverage row's own
 * timestamp answers that. If the sweep stops, the row goes stale, and the dashboard goes
 * back to reading the platforms on its own - which is the right way round to fail.
 */
export function coversRange(coverage, { since, until }, sources, now = Date.now()) {
  if (!coverage || !Array.isArray(sources) || sources.length === 0) return false;
  return sources.every((source) => {
    const window = coverage[source];
    if (!window) return false;
    // An unreadable bound is not a permissive one. NaN fails every comparison, so a row
    // whose dates could not be parsed slipped past `from > since` and then past
    // `through >= until` and was answered by the freshness clause - reading as "covers
    // everything" on exactly the row we understood least.
    if (!Number.isFinite(window.from) || !Number.isFinite(window.through)) return false;
    if (window.from > since) return false;
    if (window.through >= until) return true;
    const at = Date.parse(window.at ?? '');
    if (!Number.isFinite(at)) return false;
    // Absolute, because the timestamp is written by the database's clock and compared
    // against ours. A server running even slightly ahead made every row look permanently
    // fresh, which is the one direction that serves a tail nobody is maintaining.
    return Math.abs(now - at) <= STALE_AFTER_MS;
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
