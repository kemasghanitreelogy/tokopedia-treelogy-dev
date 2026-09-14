import { buildPublicUrl } from './sign.js';
import { updateEnv } from '../env-file.js';
import { shopeeRedirectUri } from './config.js';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

const AUTH_PARTNER_PATH = '/api/v2/shop/auth_partner';
const TOKEN_GET_PATH = '/api/v2/auth/token/get';
const TOKEN_REFRESH_PATH = '/api/v2/auth/access_token/get';

export class ShopeeError extends Error {
  constructor(path, payload) {
    super(`${path} failed: ${payload.message || 'unknown error'} (${payload.error})`);
    this.name = 'ShopeeError';
    this.code = payload.error;
    this.requestId = payload.request_id;
  }
}

/**
 * The seller-facing authorization URL. Shopee appends `?code=<code>&shop_id=<id>` to
 * the `redirect` value, which must match the Callback URL registered on the app.
 */
export function buildAuthorizeUrl(config) {
  const redirect = shopeeRedirectUri(config);
  return { url: buildPublicUrl(config, AUTH_PARTNER_PATH, { redirect }), redirect };
}

async function callAuth(config, path, body) {
  const response = await fetchWithTimeout(buildPublicUrl(config, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${path} (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  // Shopee reports success as an empty `error` string, not a numeric code.
  if (payload.error) throw new ShopeeError(path, payload);
  return payload;
}

/**
 * `expire_in` is a relative TTL in seconds (4 hours for the access token). Stored as an
 * absolute epoch so a stale bundle is recognisable without knowing when it was written.
 */
function normalize(payload, shopId) {
  const ttl = Number(payload.expire_in) || 0;
  return {
    accessToken: payload.access_token ?? '',
    refreshToken: payload.refresh_token ?? '',
    accessTokenExpireAt: ttl > 0 ? Math.floor(Date.now() / 1000) + ttl : 0,
    shopId: String(shopId ?? ''),
    raw: payload,
  };
}

/** One-shot: the code is single-use and expires ~10 minutes after the redirect. */
export async function exchangeCode(config, { code, shopId }) {
  const payload = await callAuth(config, TOKEN_GET_PATH, {
    code,
    shop_id: Number(shopId),
    partner_id: config.partnerId,
  });
  return normalize(payload, shopId);
}

/** The refresh token rotates on every call - the previous one stops working. */
export async function refreshAccessToken(config, { refreshToken, shopId }) {
  const payload = await callAuth(config, TOKEN_REFRESH_PATH, {
    refresh_token: refreshToken,
    shop_id: Number(shopId),
    partner_id: config.partnerId,
  });
  return normalize(payload, shopId);
}

export function persistShopeeTokens(config, tokens, shop = null) {
  const updates = {
    SHOPEE_ACCESS_TOKEN: tokens.accessToken,
    SHOPEE_REFRESH_TOKEN: tokens.refreshToken,
    SHOPEE_ACCESS_TOKEN_EXPIRE_AT: tokens.accessTokenExpireAt || '',
    SHOPEE_SHOP_ID: tokens.shopId,
  };
  if (shop?.shop_name) updates.SHOPEE_SHOP_NAME = shop.shop_name;

  updateEnv(config.envPath, updates);

  config.accessToken = tokens.accessToken;
  config.refreshToken = tokens.refreshToken;
  config.accessTokenExpireAt = tokens.accessTokenExpireAt;
  config.shopId = tokens.shopId;
  if (shop?.shop_name) config.shopName = shop.shop_name;
}
