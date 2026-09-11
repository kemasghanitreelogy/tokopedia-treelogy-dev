import { readRawBody, verifyShopee } from '../../src/webhooks/verify.js';
import { handlePush, statusFor } from '../../src/webhooks/handle.js';
import { loadShopeeConfig } from '../../src/shopee/config.js';

/**
 * Shopee push receiver.
 *
 * Registered as the app's callback_url with push code 3 (order status). Shopee expects a
 * 2xx within a few seconds and suspends the whole push channel for an endpoint that keeps
 * failing, so anything that is not a retryable error answers 200.
 *
 * Shopee keeps three days of undelivered pushes, which is the recovery path when this
 * endpoint was down - see src/webhooks/recover.js.
 */

/** Shopee's push codes; only the order ones are acted on. */
export const ORDER_STATUS_PUSH = 3;
export const TRACKING_NO_PUSH = 4;

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

  const config = loadShopeeConfig();
  // The signed URL is the callback as Shopee knows it, which is the public deployment
  // URL - not whatever host header reached this function behind the proxy.
  const url = `${(process.env.PUBLIC_BASE_URL || `https://${req.headers.host}`).replace(/\/$/, '')}/api/webhook/shopee`;
  const check = verifyShopee({
    rawBody: raw, header: req.headers.authorization, url, partnerKey: config.partnerKey,
  });

  if (!check.ok) {
    console.warn(`webhook/shopee: tanda tangan ditolak - ${check.reason}`);
    res.statusCode = 401;
    return res.end('invalid signature');
  }
  // Which base string Shopee actually signs is not something the documentation would
  // confirm, so the first genuine push says it out loud and it can be pinned.
  console.log(`webhook/shopee: tanda tangan sah (bentuk: ${check.shape})`);

  let push;
  try {
    push = JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    return res.end('bad json');
  }

  if (push.code !== ORDER_STATUS_PUSH && push.code !== TRACKING_NO_PUSH) {
    console.log(`webhook/shopee: kode ${push.code} diabaikan`);
    res.statusCode = 200;
    return res.end('ok');
  }

  // Shopee has spelled this field both ways across versions; take whichever arrived
  // rather than dropping a real order over a naming detail.
  const id = push.data?.ordersn ?? push.data?.order_sn ?? '';
  const outcome = await handlePush({ channel: 'shopee', id, reason: `code ${push.code}` });

  res.statusCode = statusFor(outcome);
  res.end(outcome.status);
}
