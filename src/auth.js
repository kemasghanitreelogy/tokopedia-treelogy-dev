import { AUTHORIZE_URL, TOKOPEDIA_AUTHORIZE_URL } from './config.js';
import { updateEnv } from './env-file.js';
import { saveTokenBundle, loadTokenBundle } from './token-store.js';
import { fetchWithTimeout, TIMEOUTS } from './http.js';

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
  const response = await fetchWithTimeout(url, { headers: { 'Content-Type': 'application/json' } });
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
/**
 * Remember a new token pair everywhere it is read from.
 *
 * The shared Blob bundle is the source of truth: it is what the deployment reads, and it
 * is the only copy that survives a redeploy. The local .env is a convenience for the CLI
 * and is written when it can be - on Vercel the filesystem is read-only and there is no
 * .env to update, which must not fail the refresh that just succeeded.
 *
 * TikTok rotates the refresh token on every refresh, so whichever copy is not written
 * here is dead the moment this returns. That is how production came to hold a token
 * TikTok had already invalidated: the CLI refreshed into .env, the deployment kept a
 * frozen copy of an older .env, and the two chains diverged.
 */
/**
 * Copy a token pair onto one in-memory config.
 *
 * Separate from persisting because `loadConfig()` hands every caller its own object, so
 * a refresh that only updated the requester's copy would leave everybody else holding an
 * access token TikTok had already replaced.
 */
export function applyTokens(config, tokens) {
  config.accessToken = tokens.accessToken;
  config.refreshToken = tokens.refreshToken;
  config.accessTokenExpireAt = tokens.accessTokenExpireAt;
  config.refreshTokenExpireAt = tokens.refreshTokenExpireAt;
  if (tokens.openId) config.openId = tokens.openId;
  if (tokens.sellerName) config.sellerName = tokens.sellerName;
  return config;
}

export async function persistTokens(config, tokens, { saveBundle = true } = {}) {
  const updates = {
    ACCESS_TOKEN: tokens.accessToken,
    REFRESH_TOKEN: tokens.refreshToken,
    ACCESS_TOKEN_EXPIRE_AT: tokens.accessTokenExpireAt || '',
    REFRESH_TOKEN_EXPIRE_AT: tokens.refreshTokenExpireAt || '',
  };
  if (tokens.openId) updates.OPEN_ID = tokens.openId;
  if (tokens.sellerName) updates.SELLER_NAME = tokens.sellerName;

  applyTokens(config, tokens);

  try {
    if (config.envPath) updateEnv(config.envPath, updates);
  } catch {
    // Read-only filesystem, or no .env: the deployment does not keep one.
  }

  if (saveBundle) {
    await saveTokenBundle({
      tokens: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpireAt: tokens.accessTokenExpireAt,
        refreshTokenExpireAt: tokens.refreshTokenExpireAt,
        openId: tokens.openId ?? config.openId ?? '',
        sellerName: tokens.sellerName ?? config.sellerName ?? '',
      },
      nonce: 'refresh',
      shop: config.shopCipher ? { id: config.shopId, cipher: config.shopCipher, name: config.shopName } : null,
    });
  }
}

/**
 * Bring a config up to date with the shared bundle.
 *
 * Blob wins over whatever .env holds, because Blob is where every refresh - from the CLI,
 * the dashboard or a webhook - lands. A bundle that has none of the tokens is ignored so
 * a fresh checkout with a .env can still work before anything was ever saved.
 */
export async function hydrateFromBundle(config) {
  let bundle;
  try {
    bundle = await loadTokenBundle();
  } catch {
    return config;
  }
  const tokens = bundle?.tokens;
  if (!tokens?.refreshToken) return config;

  config.accessToken = tokens.accessToken ?? '';
  config.refreshToken = tokens.refreshToken;
  config.accessTokenExpireAt = Number(tokens.accessTokenExpireAt) || 0;
  config.refreshTokenExpireAt = Number(tokens.refreshTokenExpireAt) || 0;
  if (tokens.openId) config.openId = tokens.openId;
  if (tokens.sellerName) config.sellerName = tokens.sellerName;
  if (bundle.shop?.cipher) {
    config.shopId = String(bundle.shop.id ?? config.shopId ?? '');
    config.shopCipher = bundle.shop.cipher;
    config.shopName = bundle.shop.name ?? config.shopName;
  }
  return config;
}


/* --------------------------------------------------- one refresh at a time */

/**
 * The refresh, shared by every caller that arrives while it is running.
 *
 * TikTok rotates the refresh token on every refresh, so a second refresh started before
 * the first has finished rotates it again and kills the pair the first one just stored.
 * That is not a theoretical race: order detail is fetched eight at a time and shipments
 * six at a time, and an expired token means every one of those workers reaches this at
 * the same instant. Losing the rotation means re-authorising through Partner Center by
 * hand, which is an outage, not an inconvenience.
 *
 * Shopee solved the same problem in src/shopee/session.js and the reasoning is identical;
 * this is that guard for the other platform.
 *
 * `loadConfig()` returns a fresh object per call, so the waiters are handed the new pair
 * to apply to their own copy - otherwise they would queue politely and then go on to use
 * the token that was just replaced.
 */
let refreshing = null;

export async function refreshTokensOnce(config, { refresh = refreshAccessToken, persist = persistTokens } = {}) {
  if (!refreshing) {
    refreshing = (async () => {
      const tokens = await refresh({ config });
      await persist(config, tokens);
      return tokens;
    })().finally(() => { refreshing = null; });
  }
  const tokens = await refreshing;
  return applyTokens(config, tokens);
}

/** Only for tests: forget any refresh believed to be in flight. */
export const resetRefreshGuard = () => { refreshing = null; };
