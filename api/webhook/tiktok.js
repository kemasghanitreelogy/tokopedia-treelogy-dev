import { readRawBody, verifyTikTok } from '../../src/webhooks/verify.js';
import { handlePush, statusFor } from '../../src/webhooks/handle.js';
import { beatRejected } from '../../src/mekari/heartbeat.js';
import { loadConfig } from '../../src/config.js';

/**
 * TikTok Shop push receiver - which is also the Tokopedia receiver.
 *
 * Both storefronts hang off one TikTok Shop account, so one subscription covers both;
 * which one an order belongs to is decided by the order itself when it is re-read, not
 * by the push.
 */

export const ORDER_STATUS_CHANGE = 1;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('method not allowed');
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (error) {
    res.statusCode = 400;
    return res.end(error.message);
  }

  const config = loadConfig();
  const check = verifyTikTok({
    rawBody: raw, header: req.headers.authorization, appKey: config.appKey, appSecret: config.appSecret,
  });
  if (!check.ok) {
    console.warn('webhook/tiktok: tanda tangan ditolak');
    await beatRejected('tiktok_shop', 'tanda tangan tidak cocok');
    res.statusCode = 401;
    return res.end('invalid signature');
  }

  let push;
  try {
    push = JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    return res.end('bad json');
  }

  if (push.type !== ORDER_STATUS_CHANGE) {
    console.log(`webhook/tiktok: tipe ${push.type} diabaikan`);
    res.statusCode = 200;
    return res.end('ok');
  }

  // The channel is a guess until the order is read; fetchOrdersByIds treats anything that
  // is not shopee or shopify as the TikTok Shop account, which covers Tokopedia too.
  const outcome = await handlePush({
    channel: 'tiktok_shop',
    id: push.data?.order_id ?? '',
    reason: push.data?.order_status ?? 'status change',
  });

  res.statusCode = statusFor(outcome);
  res.end(outcome.status);
}
