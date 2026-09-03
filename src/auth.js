import { AUTHORIZE_URL, TOKOPEDIA_AUTHORIZE_URL } from './config.js';
import { updateEnv } from './env-file.js';

const TOKEN_GET_PATH = '/api/v2/token/get';
const TOKEN_REFRESH_PATH = '/api/v2/token/refresh';

/**
 * The seller-facing authorization URL. The seller approves here and TikTok redirects
 * to the app's registered redirect_url with `?code=<auth_code>&state=<state>`.
 */
export function buildAuthorizeUrl({ serviceId, state }) {
  const global = new URL(AUTHORIZE_URL);
  global.searchParams.set('service_id', serviceId);
  global.searchParams.set('state', state);

  const tokopedia = new URL(`${TOKOPEDIA_AUTHORIZE_URL}/${serviceId}`);
  tokopedia.searchParams.set('state', state);

  return { url: global.toString(), tokopediaUrl: tokopedia.toString(), state };
}

/** Pull the auth_code out of a pasted redirect URL, or accept a bare code. */
export function extractAuthCode(input) {
  const trimmed = String(input).trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.searchParams.get('code') || url.searchParams.get('auth_code') || '';
  } catch {
    return '';
  }
}

async function callAuth(baseUrl, path, params) {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${path} (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (payload.code !== 0) {
    const detail = payload.message || 'unknown error';
    const requestId = payload.request_id ? ` [request_id ${payload.request_id}]` : '';
    throw new Error(`${path} failed: ${detail} (code ${payload.code})${requestId}`);
  }
  return payload.data ?? {};
}

/**
 * Normalize the token payload. The API returns absolute epoch seconds in
 * `access_token_expire_in` / `refresh_token_expire_in`; older docs describe a relative
 * TTL, so anything that looks like a duration is converted to an absolute timestamp.
 */
function normalizeExpiry(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  // A plausible absolute timestamp is already far in the future; anything smaller is a TTL.
  return seconds > nowSeconds ? seconds : nowSeconds + seconds;
}

export function normalizeTokenPayload(data) {
  return {
    accessToken: data.access_token ?? '',
    refreshToken: data.refresh_token ?? '',
    accessTokenExpireAt: normalizeExpiry(data.access_token_expire_in),
    refreshTokenExpireAt: normalizeExpiry(data.refresh_token_expire_in),
    openId: data.open_id ?? '',
    sellerName: data.seller_name ?? data.seller_base_region ?? '',
    raw: data,
  };
}

export async function exchangeAuthCode({ config, authCode }) {
  const data = await callAuth(config.authBaseUrl, TOKEN_GET_PATH, {
    app_key: config.appKey,
    app_secret: config.appSecret,
    auth_code: authCode,
    grant_type: 'authorized_code',
  });
  return normalizeTokenPayload(data);
}

export async function refreshAccessToken({ config }) {
  if (!config.refreshToken) throw new Error('No REFRESH_TOKEN in .env — run `npm run exchange` first');
  const data = await callAuth(config.authBaseUrl, TOKEN_REFRESH_PATH, {
    app_key: config.appKey,
    app_secret: config.appSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });
  return normalizeTokenPayload(data);
}

/** Persist a token payload into .env and mirror it onto the in-memory config. */
export function persistTokens(config, tokens) {
  const updates = {
    ACCESS_TOKEN: tokens.accessToken,
    REFRESH_TOKEN: tokens.refreshToken,
    ACCESS_TOKEN_EXPIRE_AT: tokens.accessTokenExpireAt || '',
    REFRESH_TOKEN_EXPIRE_AT: tokens.refreshTokenExpireAt || '',
  };
  if (tokens.openId) updates.OPEN_ID = tokens.openId;
  if (tokens.sellerName) updates.SELLER_NAME = tokens.sellerName;

  updateEnv(config.envPath, updates);

  config.accessToken = tokens.accessToken;
  config.refreshToken = tokens.refreshToken;
  config.accessTokenExpireAt = tokens.accessTokenExpireAt;
  config.refreshTokenExpireAt = tokens.refreshTokenExpireAt;
  if (tokens.openId) config.openId = tokens.openId;
  if (tokens.sellerName) config.sellerName = tokens.sellerName;
}
