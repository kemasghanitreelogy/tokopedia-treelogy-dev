import { buildShopUrl } from './sign.js';
import { ShopeeError } from './auth.js';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

/**
 * Errors worth retrying: the shop is fine, the call simply arrived too fast or the
 * gateway hiccuped. Anything else is a real answer and must not be papered over.
 */
const RETRYABLE = new Set([
  'error_rate_limit',   // too many requests
  'error_service',      // "Service Error. Please have a try." - Shopee's own advice
  'error_server',
  'error_network',
  'error_busy',
  'error_inner',
]);
const RETRY_DELAYS_MS = [400, 1000, 2200, 4000];

/** A transport failure or a 5xx is transient by definition; the request never completed. */
const isTransport = (error) =>
  error.name === 'TypeError' || error.name === 'AbortError' || error.httpStatus >= 500 || error.httpStatus === 429;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call any shop-scoped v2 endpoint with a correctly signed URL.
 *
 * Rate limits are retried with backoff and jitter rather than surfaced: a burst of
 * catalogue reads can trip Shopee's limiter, and failing the whole page for it would
 * report an empty Shopee catalogue - which reads as "not listed on Shopee" and is worse
 * than waiting a second.
 */
export async function callShopApi(config, path, auth, params = {}, body) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await callShopApiOnce(config, path, auth, params, body);
    } catch (error) {
      lastError = error;
      const retryable = RETRYABLE.has(error.code) || isTransport(error);
      if (!retryable || attempt === RETRY_DELAYS_MS.length) throw error;
      // Jitter keeps parallel callers from retrying in lockstep and tripping the limit again.
      await sleep(RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 250));
    }
  }
  throw lastError;
}

async function callShopApiOnce(config, path, { accessToken, shopId }, params = {}, body) {
  const url = buildShopUrl(config, path, { accessToken, shopId }, params);
  let response;
  try {
    response = await fetchWithTimeout(url, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {});
  } catch (cause) {
    // A DNS blip or a dropped connection is worth another go, not a failed page.
    const error = new Error(`${path} tidak terjangkau: ${cause.message}`);
    error.name = 'TypeError';
    throw error;
  }
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const error = new Error(`Non-JSON response from ${path} (HTTP ${response.status}): ${text.slice(0, 200)}`);
    error.httpStatus = response.status;
    throw error;
  }
  if (payload.error) {
    // Batch endpoints report per-item reasons in response.result_list even when the
    // envelope carries an error. Throwing without them loses the only explanation of
    // which order failed and why.
    const error = new ShopeeError(path, payload);
    error.response = payload.response ?? null;
    error.httpStatus = response.status;
    throw error;
  }
  return payload;
}

export function getShopInfo(config, auth) {
  return callShopApi(config, '/api/v2/shop/get_shop_info', auth);
}

/**
 * Shopee rejects any window wider than 15 days
 * ("Start time must be earlier than end time and diff in 15days"), so callers wanting
 * more have to walk `chunkRange` windows.
 */
export function getOrderList(config, auth, { from, to, days = 14, pageSize = 50, cursor = '' } = {}) {
  const timeTo = to ?? Math.floor(Date.now() / 1000);
  const timeFrom = from ?? timeTo - days * 24 * 3600;
  return callShopApi(config, '/api/v2/order/get_order_list', auth, {
    time_range_field: 'create_time',
    time_from: timeFrom,
    time_to: timeTo,
    page_size: pageSize,
    cursor,
    response_optional_fields: 'order_status',
  });
}

export function getItemList(config, auth, { offset = 0, pageSize = 50 } = {}) {
  return callShopApi(config, '/api/v2/product/get_item_list', auth, {
    offset,
    page_size: pageSize,
    item_status: 'NORMAL',
  });
}
