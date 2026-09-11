import { fetchOrdersByIds } from '../omni.js';
import { fetchOrderByGid } from '../shopify/shop.js';
import { runSync, loadSyncLedger, POSTABLE_STAGES } from '../mekari/sync.js';
import { customIdFor } from '../mekari/invoice.js';
import { ensureReady } from '../mekari/setup.js';
import { isMekariConfigured } from '../mekari/client.js';
import { invalidate } from '../cache.js';
import { beatWebhook } from '../mekari/heartbeat.js';
import { notifySyncFailures } from '../notify/telegram.js';

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
export const depositAccount = () => process.env.MEKARI_DEPOSIT_ACCOUNT || null;

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
  if (!isMekariConfigured()) return { status: 'ignored', reason: 'kredensial Mekari belum diisi' };

  const ledger = await loadSyncLedger();

  // The cheapest possible answer, when the push carries an id we can name the invoice
  // from: already booked, no platform call at all. Only Shopee qualifies - a Shopify push
  // carries a numeric id rather than the order name, and a TikTok push does not say which
  // of the two storefronts the order belongs to.
  if (channel === 'shopee') {
    const known = ledger.orders?.[customIdFor({ channel, id })];
    if (known) return { status: 'exists', customId: customIdFor({ channel, id }), invoiceId: known.invoice_id ?? null };
  }

  const order = await readOrder({ channel, id, gid });
  if (!order) return { status: 'ignored', reason: 'pesanan tidak ditemukan di platform' };

  const customId = customIdFor(order);
  const known = ledger.orders?.[customId];
  if (known) return { status: 'exists', customId, invoiceId: known.invoice_id ?? null };

  // An order that is not paid yet is not an error, it is simply early. The platform will
  // push again when it moves, so this is a success, not something to retry.
  if (!POSTABLE_STAGES.has(order.stage)) {
    return { status: 'skipped', customId, stage: order.stage, reason: 'belum dibayar atau dibatalkan' };
  }
  if (!liveEnabled()) {
    return { status: 'held', customId, stage: order.stage, reason: 'MEKARI_SYNC_LIVE belum disetel' };
  }

  if (!customersReady) {
    await ensureReady({ dryRun: false });
    customersReady = true;
  }

  // No lock here. Locking would serialise unrelated pushes for the sake of a race the
  // custom_id probe already closes; the worst a lost race costs is a ledger entry that
  // has to be re-learned from Jurnal.
  const result = await runSync({ orders: [order], depositTo: depositAccount(), dryRun: false, limit: 1, lock: false });
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
