import { readRawBody, verifyShopify } from '../../src/webhooks/verify.js';
import { handlePush, statusFor } from '../../src/webhooks/handle.js';
import { beatRejected } from '../../src/mekari/heartbeat.js';
import { loadShopifyConfig } from '../../src/shopify/config.js';

/**
 * Shopify webhook receiver for orders/paid and orders/create.
 *
 * Shopify posts the whole order, but only its id is used: the order is re-read through
 * the Admin API so the numbers that reach the books come from a call we signed. Shopify
 * retries a failed delivery on its own schedule for up to 48 hours, which is the safety
 * net for a deploy that happened mid-push.
 */

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

  const config = loadShopifyConfig();
  const check = verifyShopify({
    rawBody: raw,
    header: req.headers['x-shopify-hmac-sha256'],
    secret: config.clientSecret,
  });
  if (!check.ok) {
    console.warn('webhook/shopify: tanda tangan ditolak');
    await beatRejected('shopify', 'tanda tangan tidak cocok');
    res.statusCode = 401;
    return res.end('invalid signature');
  }

  let order;
  try {
    order = JSON.parse(raw);
  } catch {
    res.statusCode = 400;
    return res.end('bad json');
  }

  // The webhook body is REST-shaped; `admin_graphql_api_id` is the GID the Admin API
  // wants, and the numeric id only becomes one by string surgery, so prefer the former.
  const gid = order.admin_graphql_api_id || (order.id ? `gid://shopify/Order/${order.id}` : null);
  const outcome = await handlePush({
    channel: 'shopify', id: order.name ?? '', gid,
    reason: req.headers['x-shopify-topic'] ?? 'order',
  });

  res.statusCode = statusFor(outcome);
  res.end(outcome.status);
}
