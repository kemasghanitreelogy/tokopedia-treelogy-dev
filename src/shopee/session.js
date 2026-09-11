import { loadShopeeConfig } from './config.js';
import { refreshAccessToken } from './auth.js';
import { loadTokenBundle, saveTokenBundle, SHOPEE_TOKENS_PATHNAME } from '../token-store.js';

/**
 * A ready-to-use Shopee auth context, refreshed on demand.
 *
 * Shopee access tokens last only 4 hours, so anything long-lived (the dashboard, a cron)
 * cannot rely on whatever is sitting in .env. This reads the bundle from Blob, refreshes
 * it when it is close to expiry, and writes the new pair back - the refresh token rotates
 * on every call, so persisting immediately is what keeps the chain alive.
 */

const EXPIRY_SKEW_SECONDS = 120;

export function shopeeTokenExpired(tokens) {
  if (!tokens?.accessTokenExpireAt) return true;
  return Math.floor(Date.now() / 1000) >= tokens.accessTokenExpireAt - EXPIRY_SKEW_SECONDS;
}

/**
 * One in-flight resolution per process.
 *
 * Every caller was paying its own Blob round trip, and two callers racing could each
 * refresh - rotating the refresh token twice and invalidating the first result. Sharing
 * the promise makes the refresh happen once and the read nearly free after that.
 */
let inflight = null;
let cached = null;

export function invalidateShopeeSession() {
  inflight = null;
  cached = null;
}

export async function resolveShopeeSession(options = {}) {
  if (cached && !shopeeTokenExpired({ accessTokenExpireAt: cached.expiresAt })) return cached;
  if (!inflight) {
    inflight = resolveShopeeSessionUncached(options)
      .then((session) => {
        cached = session;
        return session;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

async function resolveShopeeSessionUncached({ config = loadShopeeConfig() } = {}) {
  const bundle = await loadTokenBundle({ pathname: SHOPEE_TOKENS_PATHNAME, token: config.blobToken });
  if (!bundle?.tokens?.refreshToken) {
    throw new Error('Shopee is not authorized yet - run `npm run shopee:url` and approve');
  }

  let { tokens } = bundle;
  let refreshed = false;

  if (shopeeTokenExpired(tokens)) {
    tokens = await refreshAccessToken(config, {
      refreshToken: tokens.refreshToken,
      shopId: tokens.shopId,
    });
    refreshed = true;
    await saveTokenBundle({
      tokens,
      nonce: `shopee-${tokens.shopId}`,
      shop: bundle.shop,
      pathname: SHOPEE_TOKENS_PATHNAME,
      token: config.blobToken,
    });
  }

  return {
    config,
    auth: { accessToken: tokens.accessToken, shopId: tokens.shopId },
    shop: bundle.shop,
    refreshed,
    expiresAt: tokens.accessTokenExpireAt,
  };
}
