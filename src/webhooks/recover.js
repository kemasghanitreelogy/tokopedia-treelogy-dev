import { buildPublicUrl } from '../shopee/sign.js';
import { loadShopeeConfig } from '../shopee/config.js';
import { handlePush } from './handle.js';
import { isReadOnly } from '../stock-sync.js';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

/**
 * The safety net for pushes that never arrived.
 *
 * Webhooks are fast but not guaranteed: a deploy, a cold start that timed out, a minute
 * of Vercel trouble, and the push is gone. Shopee is the only one of the three that
 * keeps a queue we can drain - it holds undelivered messages for three days - so that
 * queue is drained on demand rather than polled on a schedule.
 *
 * TikTok Shop and Shopify have no equivalent, and both retry deliveries themselves. What
 * covers them instead is the Jurnal tab: it compares the live order list against the
 * ledger, so anything a push missed shows up there as "antre" and one button posts it.
 */

const PUSH_CODES = { 3: 'order status', 4: 'tracking no' };

async function shopeePush(path, { method = 'GET', body } = {}) {
  const config = loadShopeeConfig();
  const response = await fetchWithTimeout(buildPublicUrl(config, path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${payload.error}: ${payload.message}`);
  return payload.response ?? payload;
}

/**
 * Drain Shopee's queue of undelivered pushes.
 *
 * Messages are only confirmed as consumed after they have actually been handled, and
 * confirmation is by the id of the last one in the batch - so a failure part-way through
 * leaves the whole batch to be re-delivered rather than silently dropping the tail.
 */
export async function recoverShopee({ dryRun = true, maxBatches = 10 } = {}) {
  const seen = [];
  let batches = 0;

  for (;;) {
    const page = await shopeePush('/api/v2/push/get_lost_push_message');
    const messages = page.push_message_list ?? [];
    if (messages.length === 0) break;

    for (const message of messages) {
      if (!PUSH_CODES[message.code]) continue;
      let data = {};
      try {
        data = typeof message.data === 'string' ? JSON.parse(message.data) : (message.data ?? {});
      } catch {
        data = {};
      }
      const id = data.ordersn ?? data.order_sn ?? '';
      if (!id) continue;

      const outcome = dryRun
        ? { status: 'dry-run' }
        : await handlePush({ channel: 'shopee', id, reason: `lost push ${message.code}` });
      seen.push({ id, code: message.code, status: outcome.status });
    }

    // Confirming is itself a write; a dry run reads the queue and leaves it intact. A
    // page with a deferred order in it is left unconfirmed too: "not now" means Shopee
    // should hand it to us again, and its queue is the mechanism for exactly that. A real
    // failure is confirmed - re-delivering a 422 for three days changes nothing.
    const deferred = seen.some((s) => String(s.status).startsWith('deferred'));
    if (!dryRun && page.last_message_id && !deferred) {
      if (isReadOnly()) break;
      await shopeePush('/api/v2/push/confirm_consumed_lost_push_message', {
        method: 'POST', body: { last_message_id: page.last_message_id },
      });
    }

    batches += 1;
    if (!page.has_next_page || batches >= maxBatches || dryRun) break;
  }

  const count = (status) => seen.filter((s) => s.status === status).length;
  return { dryRun, messages: seen.length, created: count('created'), exists: count('exists'), failed: count('failed'), deferred: count('deferred'), seen };
}
