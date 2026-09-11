import { collectOrders } from '../src/omni.js';
import { runSync } from '../src/mekari/sync.js';
import { ensureReady } from '../src/mekari/setup.js';
import { isMekariConfigured } from '../src/mekari/client.js';
import { isReadOnly } from '../src/stock-sync.js';
import { parseCookies, sessionValid, tokenMatches, COOKIE_NAME } from '../src/dashboard-auth.js';

/**
 * Near-real-time order sync into Mekari Jurnal.
 *
 * Marketplaces do not push us an event when an order is paid, so "real time" here means
 * a short poll over a rolling window rather than a webhook. The window is deliberately
 * wider than the poll interval - a few days - because an order can change stage long
 * after it was created, and re-seeing one already in the ledger costs nothing.
 *
 * Writing is off unless MEKARI_SYNC_LIVE=1. Until that is set the endpoint reports
 * exactly what it would post and touches nothing, which is also what makes it safe to
 * leave the cron running while the mapping is still being reviewed.
 */

const DEFAULT_WINDOW_DAYS = 3;
const MAX_PER_RUN = 40;
// The function is allowed 120s; stop posting well before that so a run ends on a written
// ledger rather than on a kill signal mid-request.
const POST_BUDGET_MS = 85_000;

/** Cron calls carry CRON_SECRET; a person calls it with their dashboard session. */
function authorized(req) {
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (process.env.CRON_SECRET && bearer && bearer === process.env.CRON_SECRET) return 'cron';

  const url = new URL(req.url, 'http://localhost');
  const provided = url.searchParams.get('token') ?? bearer;
  if (provided && tokenMatches(provided)) return 'token';

  const cookies = parseCookies(req.headers.cookie);
  if (sessionValid(cookies[COOKIE_NAME])) return 'session';

  return null;
}

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body, null, 2));
};

export default async function handler(req, res) {
  const caller = authorized(req);
  if (!caller) return json(res, 401, { ok: false, error: 'tidak berwenang' });

  if (!isMekariConfigured()) {
    return json(res, 503, { ok: false, error: 'kredensial Mekari belum diisi' });
  }

  const url = new URL(req.url, 'http://localhost');
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || DEFAULT_WINDOW_DAYS, 1), 30);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || MAX_PER_RUN, 1), 200);
  const depositTo = url.searchParams.get('deposit_to') ?? process.env.MEKARI_DEPOSIT_ACCOUNT ?? null;

  // Live posting needs the flag AND the absence of the read-only brake. Asking for
  // `dry=0` without the flag is answered with a dry run, never with a surprise write.
  const liveAllowed = process.env.MEKARI_SYNC_LIVE === '1' && !isReadOnly();
  const wantsLive = url.searchParams.get('dry') === '0';
  const dryRun = !(liveAllowed && wantsLive);

  const startedAt = Date.now();
  try {
    // An explicit window rather than a preset: the poll interval is measured in minutes,
    // so the range has to be expressible in arbitrary days, not just the dashboard's set.
    const until = Math.floor(Date.now() / 1000);
    const range = { since: until - days * 24 * 3600, until, preset: null };

    const { orders, errors } = await collectOrders({ range, maxPerPlatform: 400, tracking: true });

    // A channel that failed to answer simply has no orders in this run; posting is
    // additive and idempotent, so the next tick picks up whatever was missed. What must
    // not happen is treating "no data" as "nothing to post" in the report.
    const prepared = dryRun ? null : await ensureReady({ dryRun: false });

    const result = await runSync({ orders, depositTo, dryRun, limit, deadlineMs: POST_BUDGET_MS });

    return json(res, 200, {
      ok: true,
      caller,
      live: !dryRun,
      live_allowed: liveAllowed,
      window_days: days,
      orders_seen: orders.length,
      channel_errors: errors,
      prepared,
      took_ms: Date.now() - startedAt,
      ...result,
      // The per-order payloads are large and only useful when debugging a mapping.
      results: url.searchParams.get('verbose') === '1'
        ? result.results
        : result.results.filter((r) => r.status === 'failed'),
    });
  } catch (error) {
    return json(res, 500, { ok: false, error: error.message, took_ms: Date.now() - startedAt });
  }
}
