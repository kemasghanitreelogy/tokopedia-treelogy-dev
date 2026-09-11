import { buildSignedUrl } from './sign.js';
import { refreshAccessToken, persistTokens } from './auth.js';

/**
 * Endpoints that reject shop_cipher outright ("not required for this request").
 * /authorization/202309/shops is the call that discovers the cipher; the seller
 * endpoints below are shop-agnostic.
 */
export const NO_SHOP_CIPHER_PATHS = new Set([
  '/authorization/202309/shops',
  '/seller/202309/permissions',
  '/seller/202309/shops',
  '/seller/202508/status',
]);

/** Server-side codes that mean "the access token is no longer usable". */
const TOKEN_INVALID_CODES = new Set([36009005, 105002, 105004]);
const EXPIRY_SKEW_SECONDS = 60;

export class ApiError extends Error {
  constructor(message, { code, requestId, httpStatus, path, body }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
    this.path = path;
    this.body = body;
  }
}

export function accessTokenExpired(config) {
  if (!config.accessTokenExpireAt) return false;
  return Math.floor(Date.now() / 1000) >= config.accessTokenExpireAt - EXPIRY_SKEW_SECONDS;
}

async function sendOnce({ config, method, path, query, bodyText }) {
  const url = buildSignedUrl({
    baseUrl: config.apiBaseUrl,
    path,
    query,
    body: bodyText,
    appSecret: config.appSecret,
  });

  const headers = { 'Content-Type': 'application/json' };
  if (config.accessToken) headers['x-tts-access-token'] = config.accessToken;

  const response = await fetch(url, {
    method,
    headers,
    body: bodyText || undefined,
  });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ApiError(`Non-JSON response from ${path} (HTTP ${response.status})`, {
      httpStatus: response.status,
      path,
      body: text.slice(0, 500),
    });
  }
  return { payload, httpStatus: response.status };
}

/**
 * Call a signed Open API endpoint.
 *
 * `app_key` and `timestamp` are always injected. `shop_cipher` is injected when the
 * config has one, unless `shopCipher: false` is passed for endpoints that reject it
 * (notably /authorization/202309/shops, which is how the cipher is discovered).
 *
 * On a token-invalid response the access token is refreshed once and the call retried.
 */
export async function callApi({
  config,
  method = 'GET',
  path,
  query = {},
  body = null,
  shopCipher = true,
  allowRefresh = true,
}) {
  const bodyText = body ? JSON.stringify(body) : '';

  const buildQuery = () => {
    const merged = {
      ...query,
      app_key: config.appKey,
      timestamp: Math.floor(Date.now() / 1000).toString(),
    };
    if (shopCipher && !NO_SHOP_CIPHER_PATHS.has(path) && config.shopCipher && !('shop_cipher' in query)) {
      merged.shop_cipher = config.shopCipher;
    }
    return merged;
  };

  if (allowRefresh && config.refreshToken && accessTokenExpired(config)) {
    await persistTokens(config, await refreshAccessToken({ config }));
  }

  let { payload, httpStatus } = await sendOnce({
    config,
    method,
    path,
    query: buildQuery(),
    bodyText,
  });

  if (TOKEN_INVALID_CODES.has(payload.code) && allowRefresh && config.refreshToken) {
    await persistTokens(config, await refreshAccessToken({ config }));
    ({ payload, httpStatus } = await sendOnce({
      config,
      method,
      path,
      query: buildQuery(),
      bodyText,
    }));
  }

  if (payload.code !== 0) {
    throw new ApiError(payload.message || `Request to ${path} failed`, {
      code: payload.code,
      requestId: payload.request_id,
      httpStatus,
      path,
      body: payload,
    });
  }

  return { data: payload.data ?? {}, requestId: payload.request_id, httpStatus };
}
