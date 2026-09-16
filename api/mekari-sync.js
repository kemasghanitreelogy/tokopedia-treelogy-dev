import { collectOrders } from '../src/omni.js';
import { rememberOrders } from '../src/orders-source.js';
import { runSync, loadSyncLedger } from '../src/mekari/sync.js';
import { postingAccounts } from '../src/mekari/accounts.js';
import { ensureReady } from '../src/mekari/setup.js';
import { isMekariConfigured } from '../src/mekari/client.js';
import { isReadOnly } from '../src/stock-sync.js';
import { recoverShopee } from '../src/webhooks/recover.js';
import { beatSweep } from '../src/mekari/heartbeat.js';
import { notifySyncFailures, notifyCrash, sendTelegram } from '../src/notify/telegram.js';
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

// Seven days, not two: a COD or bank-transfer order is created long before it is paid,
// and the platforms filter by creation time. A window shorter than the longest plausible
// gap between the two would never see that order become an invoice.
const DEFAULT_WINDOW_DAYS = 7;
// Each posted order is now three paced writes - its buyer's contact, the duplicate
// probe, the invoice - which is about 2.6 seconds. Twenty of those is under a minute;
// forty overran the function's 120 seconds on the first live run and was killed with the
// last few invoices unrecorded. A sweep every fifteen minutes clears twenty at a time
// faster than a busy day produces them.
/**
 * Sized to Jurnal's quota, not to Vercel's clock.
 *
 * Jurnal allows about forty requests a minute in total. A round spends roughly six on
 * setup and then, with the probe gone, one per invoice plus one per buyer not seen
 * before - so fifteen invoices is a round that fits inside the window with room for the
 * webhooks that share the same quota from other instances. The time budget below is the
 * other ceiling; whichever is hit first ends the round cleanly.
 */
const MAX_PER_RUN = 15;
const TOTAL_BUDGET_MS = 85_000;
const RECOVERY_NEEDS_MS = 12_000;

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
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || MAX_PER_RUN, 1), MAX_PER_RUN);
  // From the source table only. Which account a sale is booked as paid into is an
  // accounting decision - one pooling account per channel - not something a caller with a
  // token gets to change per request. The chart is read to turn those numbers into names.
  const accounts = await postingAccounts();

  // Live posting needs the flag AND the absence of the read-only brake. Asking for
  // `dry=0` without the flag is answered with a dry run, never with a surprise write.
  const liveAllowed = process.env.MEKARI_SYNC_LIVE === '1' && !isReadOnly();
  const wantsLive = url.searchParams.get('dry') === '0';
  const dryRun = !(liveAllowed && wantsLive);

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const remaining = () => TOTAL_BUDGET_MS - elapsed();
  const timings = {};
  try {
    // An explicit window rather than a preset: the poll interval is measured in minutes,
    // so the range has to be expressible in arbitrary days, not just the dashboard's set.
    const until = Math.floor(Date.now() / 1000);
    const range = { since: until - days * 24 * 3600, until, preset: null };

    // No tracking numbers here: the Shopee tracking lookups were the single biggest cost
    // in the collect, and the code-4 push adds the waybill to the order the moment it is
    // assigned - the sweep's job is to make sure the invoice exists, not to decorate it.
    const live = await collectOrders({ range, maxPerPlatform: 300, tracking: false });
    const { orders, errors } = live;
    timings.collect_ms = elapsed();
    // The dashboard reads orders from the database, and this is a live, complete read of
    // the same window - so it carries the covered window forward rather than being thrown
    // away once the invoices are posted.
    await rememberOrders(live, range);

    // A channel that failed to answer simply has no orders in this run; posting is
    // additive and idempotent, so the next tick picks up whatever was missed. What must
    // not happen is treating "no data" as "nothing to post" in the report.
    const ledgerBefore = await loadSyncLedger();
    const prepared = dryRun ? null : await ensureReady({ dryRun: false, readyAt: ledgerBefore.ready_at ?? null });
    timings.prepare_ms = elapsed() - timings.collect_ms;

    const postBudget = Math.max(0, remaining() - RECOVERY_NEEDS_MS);
    const result = await runSync({ orders, accounts, dryRun, limit, deadlineMs: postBudget });
    timings.post_ms = elapsed() - timings.collect_ms - timings.prepare_ms;

    // Shopee is the one platform that keeps a queue of pushes it could not deliver, and
    // three days is how long it keeps them. Draining it here means a Shopee outage on our
    // side heals on the next sweep without anyone noticing there was one. Its failure is
    // reported, not fatal - the sweep above has already done the important work.
    let shopeeRecovery = null;
    if (remaining() > RECOVERY_NEEDS_MS / 2) {
      try {
        shopeeRecovery = await recoverShopee({ dryRun, maxBatches: 2 });
      } catch (error) {
        shopeeRecovery = { error: error.message };
      }
    } else {
      shopeeRecovery = { skipped: 'tenggat habis' };
    }
    timings.recover_ms = elapsed() - timings.collect_ms - timings.prepare_ms - timings.post_ms;

    if (!dryRun && result.quotaExhausted) {
      // Once, not once per sweep: keyed on the month, so it fires again only when a new
      // month's quota has also run out.
      await sendTelegram(
        '<b>⛔ Kuota API bulanan Mekari Jurnal habis</b>\nSinkronisasi berhenti sampai kuota kembali (awal bulan) atau paket API Mekari di-upgrade. Pesanan tidak hilang: sapuan akan menyusul semuanya begitu kuota ada.',
        { key: `mekari-monthly-quota-${new Date().toISOString().slice(0, 7)}` },
      );
    }
    if (!dryRun) {
      // A failed order or an unreadable channel reaches a person; a clean run stays quiet.
      // A mismatch is a wrong number already in the books; an undone sale whose invoice
      // has money against it needs a person. Both are reported as failures are.
      const reportable = [
        ...result.results.map((r) => (r.status === 'mismatch' ? { ...r, status: 'failed' } : r)),
        ...(result.undone ?? [])
          .filter((u) => u.outcome === 'needs_review' || u.outcome === 'failed')
          .map((u) => ({ status: 'failed', customId: u.customId, error: u.reason })),
      ];
      await notifySyncFailures({ source: 'sapuan otomatis', results: reportable, channelErrors: errors });
      await beatSweep({
        considered: result.considered, created: result.created, exists: result.exists, failed: result.failed,
        mismatch: result.mismatch, voided: result.voided, needs_review: result.needsReview,
        orders_seen: orders.length, channel_errors: Object.keys(errors),
        shopee_recovered: shopeeRecovery?.created ?? 0,
      });
    }

    return json(res, 200, {
      ok: true,
      caller,
      live: !dryRun,
      live_allowed: liveAllowed,
      window_days: days,
      orders_seen: orders.length,
      channel_errors: errors,
      prepared,
      shopee_recovery: shopeeRecovery,
      timings,
      took_ms: Date.now() - startedAt,
      ...result,
      // The per-order payloads are large and only useful when debugging a mapping.
      results: url.searchParams.get('verbose') === '1'
        ? result.results
        : result.results.filter((r) => r.status === 'failed' || r.status === 'deferred' || r.status === 'mismatch'),
      undone: (result.undone ?? []).filter((u) => u.outcome !== 'dry-run'),
    });
  } catch (error) {
    if (!dryRun) await notifyCrash({ source: 'sapuan otomatis', error });
    return json(res, 500, { ok: false, error: error.message, took_ms: Date.now() - startedAt });
  }
}
