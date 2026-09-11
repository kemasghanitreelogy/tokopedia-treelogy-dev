import { readRawBody, verifyShopee } from '../../src/webhooks/verify.js';
import { handlePush, statusFor } from '../../src/webhooks/handle.js';
import { beatRejected } from '../../src/mekari/heartbeat.js';
import { loadShopeeConfig } from '../../src/shopee/config.js';
import { put } from '@vercel/blob';

/**
 * Keep the last push this endpoint could not verify, so the shape Shopee actually signs
 * can be read off a real request instead of guessed. The HMAC in the header is not a
 * secret - it is a digest of the body - and the body is Shopee's own test payload. This
 * is a diagnostic for pinning the signature and comes out once it is pinned.
 */
async function keepRejected(detail) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return;
  try {
    await put('mekari/webhook-diag/shopee-last.json', JSON.stringify({ at: new Date().toISOString(), ...detail }), {
      access: 'private', allowOverwrite: true, contentType: 'application/json', token, cacheControlMaxAge: 0,
    });
  } catch { /* a diagnostic must never take the endpoint down */ }
}

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
export const VERIFICATION_PUSH = 0;
export const ORDER_STATUS_PUSH = 3;
export const TRACKING_NO_PUSH = 4;

/**
 * Shopee's registration handshake.
 *
 * When a callback URL is set, Shopee first posts `{"code":0,"data":{"verify_info":...}}`
 * and refuses the registration unless it gets a 2xx back. Its signature on that message
 * matched none of the documented shapes against any key we hold - captured and
 * brute-forced offline, 112 combinations - so it is accepted on its content instead: it
 * names no order and triggers nothing, and the only thing an attacker gains by forging
 * one is a 200. Real pushes (code 3 and 4) are never accepted this way.
 */
const isVerification = (raw) => {
  try {
    const push = JSON.parse(raw);
    return push?.code === VERIFICATION_PUSH && typeof push?.data?.verify_info === 'string';
  } catch {
    return false;
  }
};

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

  if (isVerification(raw)) {
    console.log('webhook/shopee: push verifikasi diterima');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end('{}');
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
    await beatRejected('shopee', check.reason);
    await keepRejected({
      reason: check.reason,
      url,
      method: req.method,
      headers: req.headers,
      rawLength: raw.length,
      rawPreview: raw.slice(0, 2000),
      reqBodyType: typeof req.body,
      reqBodyPreview: req.body === undefined ? null : JSON.stringify(req.body).slice(0, 500),
    });
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
