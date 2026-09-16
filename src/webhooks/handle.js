import { fetchOrdersByIds } from '../omni.js';
import { fetchOrderByGid } from '../shopify/shop.js';
import { runSync, loadSyncLedger, saveSyncLedger, POSTABLE_STAGES, UNDONE_STAGES, voidInvoice } from '../mekari/sync.js';
import { accountMap } from '../mekari/accounts.js';
import { customIdFor } from '../mekari/invoice.js';
import { ensureReady } from '../mekari/setup.js';
import { isMekariConfigured } from '../mekari/client.js';
import { invalidate } from '../cache.js';
import { beatWebhook } from '../mekari/heartbeat.js';
import { notifySyncFailures } from '../notify/telegram.js';
import { rememberOrder } from '../orders-source.js';

/**
 * What happens between a push arriving and an invoice existing.
 *
 * The push is treated as a rumour, never as data: all we take from it is which order
 * changed. The order is then re-read from the platform over our own signed connection,
 * so a forged or replayed push can at worst make us look up an order we already own.
 *
 * Whether the channel customers exist is remembered for the life of the instance. Fluid
 * Compute reuses instances, so asking Jurnal on every push would double the work for an
 * answer that only changes once.
 */

let customersReady = false;

export const liveEnabled = () => process.env.MEKARI_SYNC_LIVE === '1';
/**
 * The chart of accounts, which decides where a marketplace settlement is deposited.
 *
 * Read through accountMap's own day-long cache in the state store, so a push costs no
 * extra request for a fact that changes twice a year.
 */
export const chartOfAccounts = () => accountMap().catch(() => null);

/**
 * Re-read the one order the push named.
 *
 * Shopify is addressed by GID rather than searched, because its orders have no batch
 * read by id and scanning sixty days of history per push would spend hundreds of orders'
 * worth of API budget to find one.
 */
async function readOrder({ channel, id, gid }) {
  if (channel === 'shopify') return gid ? fetchOrderByGid(gid) : null;

  const { orders } = await fetchOrdersByIds([{ channel, id }]);
  // Matched on id alone for the TikTok account, because one push covers two storefronts:
  // an order pushed as TikTok Shop is very often a Tokopedia order, and insisting the
  // channel match would silently drop every Tokopedia sale.
  if (channel === 'shopee') return orders.find((o) => o.id === id && o.channel === 'shopee') ?? null;
  return orders.find((o) => o.id === id && o.channel !== 'shopee' && o.channel !== 'shopify') ?? null;
}

export async function handlePush(push) {
  let outcome;
  try {
    outcome = await handleVerifiedPush(push);
    // A push accepted without a matching signature is still acted on - the order is
    // re-read either way - but it is never allowed to look like a verified one.
    if (push.unverified) outcome = { ...outcome, status: `${outcome.status} · tak-terverifikasi` };
  } catch (error) {
    // A crash here would answer the platform with a 500 and nothing else; say so.
    await notifySyncFailures({ source: `webhook ${push.channel}`, results: [{ status: 'failed', customId: push.id ?? push.gid, error: error.message }] });
    throw error;
  }
  // Recorded on every verified push, whatever it led to: a "skipped" because the order is
  // not paid yet is as much proof the channel is alive as a "created".
  await beatWebhook(push.channel, { ...outcome, id: push.id ?? push.gid ?? null });
  if (outcome.status === 'failed') {
    await notifySyncFailures({ source: `webhook ${push.channel}`, results: [outcome] });
  }
  return outcome;
}

async function handleVerifiedPush({ channel, id, gid = null, reason = 'push' }) {
  if (!id && !gid) return { status: 'ignored', reason: 'tanpa nomor pesanan' };

  // The order is read first and kept first, before anything is decided about accounting.
  //
  // It used to be the other way round: an unconfigured Jurnal, or a Shopee order already
  // in the ledger, returned before the platform was ever called. That was the right trade
  // when the books were the only consumer - it saved a request for an answer we already
  // had. They are not any more. The dashboard reads orders from the database now, so a
  // push is the moment a stage changes from "to_ship" to "shipping", and skipping the
  // read to save a call would mean the screen shows yesterday's state until the next
  // sweep. One call per push is what realtime costs.
  const order = await readOrder({ channel, id, gid });
  if (!order) return { status: 'ignored', reason: 'pesanan tidak ditemukan di platform' };
  await rememberOrder(order, { source: `webhook:${channel}` });

  if (!isMekariConfigured()) return { status: 'ignored', reason: 'kredensial Mekari belum diisi' };

  const ledger = await loadSyncLedger();
  const customId = customIdFor(order);
  const known = ledger.orders?.[customId];
  if (known) {
    // Invoiced earlier and now undone: the push is exactly the moment to act on it.
    if (known.invoice_id && !known.voided && !known.needs_review && UNDONE_STAGES.has(order.stage) && liveEnabled()) {
      const outcome = await voidInvoice(order, known, { dryRun: false });
      if (outcome.outcome === 'voided' || outcome.outcome === 'gone' || outcome.outcome === 'needs_review') {
        ledger.orders[customId] = {
          ...known,
          ...(outcome.outcome === 'needs_review' ? { needs_review: outcome.reason } : { voided: true, voided_at: new Date().toISOString() }),
        };
        await saveSyncLedger(ledger);
        if (outcome.outcome === 'needs_review') {
          await notifySyncFailures({ source: `webhook ${channel}`, results: [{ status: 'failed', customId, error: outcome.reason }] });
        }
      }
      return { status: outcome.outcome === 'voided' ? 'voided' : outcome.outcome, customId, invoiceId: known.invoice_id };
    }
    return { status: 'exists', customId, invoiceId: known.invoice_id ?? null };
  }

  // An order that is not paid yet is not an error, it is simply early. The platform will
  // push again when it moves, so this is a success, not something to retry.
  if (!POSTABLE_STAGES.has(order.stage)) {
    return { status: 'skipped', customId, stage: order.stage, reason: 'belum dibayar atau dibatalkan' };
  }
  if (!liveEnabled()) {
    return { status: 'held', customId, stage: order.stage, reason: 'MEKARI_SYNC_LIVE belum disetel' };
  }

  if (!customersReady) {
    await ensureReady({ dryRun: false, readyAt: ledger.ready_at ?? null });
    customersReady = true;
  }

  // No lock here. Locking would serialise unrelated pushes for the sake of a race the
  // custom_id probe already closes; the worst a lost race costs is a ledger entry that
  // has to be re-learned from Jurnal.
  const result = await runSync({ orders: [order], accounts: await chartOfAccounts(), dryRun: false, limit: 1, lock: false });
  const outcome = result.results[0] ?? { status: 'ignored', reason: 'tidak ada yang diproses' };

  if (outcome.status === 'created') invalidate('jurnal');
  console.log(`webhook/${channel}: ${order.id} ${reason} -> ${outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`);
  return { ...outcome, customId };
}

/**
 * Which HTTP status a push gets back.
 *
 * Only a genuine, retryable failure returns 5xx. Everything else is a 200 even when no
 * invoice was written, because the platforms read a non-2xx as "deliver it again" and a
 * stream of them gets the whole push channel suspended - which would cost us far more
 * orders than the one we could not book.
 */
export const statusFor = (outcome) => (outcome.status === 'failed' ? 500 : 200);
