import crypto from 'node:crypto';

/**
 * Shopee Open API v2 request signature - HMAC-SHA256 keyed with partner_key, hex.
 *
 * Two base strings exist and using the wrong one is the most common cause of
 * `error_sign`:
 *   public API : partner_id + api_path + timestamp
 *   shop API   : partner_id + api_path + timestamp + access_token + shop_id
 *
 * `timestamp` is epoch seconds and must be within 5 minutes of Shopee's clock.
 */

export const nowSeconds = () => Math.floor(Date.now() / 1000);

function hmac(partnerKey, base) {
  return crypto.createHmac('sha256', partnerKey).update(base, 'utf8').digest('hex');
}

export function signPublic({ partnerId, partnerKey, path, timestamp }) {
  return hmac(partnerKey, `${partnerId}${path}${timestamp}`);
}

export function signShop({ partnerId, partnerKey, path, timestamp, accessToken, shopId }) {
  return hmac(partnerKey, `${partnerId}${path}${timestamp}${accessToken}${shopId}`);
}

/** URL for an endpoint that needs no shop context (auth_partner, token/get, refresh). */
export function buildPublicUrl(config, path, extra = {}) {
  const timestamp = nowSeconds();
  const url = new URL(path, config.host);
  url.searchParams.set('partner_id', String(config.partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', signPublic({ ...config, path, timestamp }));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** URL for a shop-scoped endpoint (shop info, orders, products). */
export function buildShopUrl(config, path, { accessToken, shopId }, extra = {}) {
  const timestamp = nowSeconds();
  const url = new URL(path, config.host);
  url.searchParams.set('partner_id', String(config.partnerId));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('shop_id', String(shopId));
  url.searchParams.set('sign', signShop({ ...config, path, timestamp, accessToken, shopId }));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}
