import { readEnv } from '../env-file.js';
import { DEFAULT_PUBLIC_BASE_URL } from '../config.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';

/**
 * Shopee Open API v2 configuration.
 *
 * Each environment has its own partner_id/key pair and they are NOT interchangeable:
 * LIVE_* only works against the live host, TEST_* only against the test host. Live is
 * preferred whenever it is present; set SHOPEE_ENV=test to force the test pair.
 *
 * Note: the test pair issued for this app is rejected by the test host with
 * `error_sign` even though it is byte-identical to what the console displays, so the
 * live pair is the working path. `npm run shopee:doctor` tells the two cases apart.
 */

export const TEST_HOST = 'https://partner.test-stable.shopeemobile.com';
export const LIVE_HOST = 'https://partner.shopeemobile.com';

export const SHOPEE_CALLBACK_PATH = '/api/shopee/callback';

/** The exact string to register as the app's Callback URL in the Shopee console. */
export function shopeeRedirectUri(config) {
  return `${config.publicBaseUrl.replace(/\/$/, '')}${SHOPEE_CALLBACK_PATH}`;
}

export function loadShopeeConfig() {
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';

  const livePair = {
    partnerId: get('SHOPEE_PARTNER_ID') || get('LIVE_PARTNER_ID'),
    partnerKey: get('SHOPEE_PARTNER_KEY') || get('LIVE_API_PARTNER_KEY'),
  };
  const testPair = { partnerId: get('TEST_PARTNER_ID'), partnerKey: get('TEST_API_PARTNER_KEY') };

  const forced = get('SHOPEE_ENV').toLowerCase();
  const live = forced === 'test' ? false : Boolean(livePair.partnerId && livePair.partnerKey);
  const { partnerId, partnerKey } = live ? livePair : testPair;

  return {
    envPath: ENV_PATH,
    partnerId: Number(partnerId) || 0,
    partnerKey,
    live,
    host: get('SHOPEE_HOST') || (live ? LIVE_HOST : TEST_HOST),
    publicBaseUrl: get('PUBLIC_BASE_URL') || DEFAULT_PUBLIC_BASE_URL,
    // When set, the callback refuses any shop_id other than this one.
    shopId: get('SHOPEE_SHOP_ID'),
    shopName: get('SHOPEE_SHOP_NAME'),
    accessToken: get('SHOPEE_ACCESS_TOKEN'),
    refreshToken: get('SHOPEE_REFRESH_TOKEN'),
    accessTokenExpireAt: Number(get('SHOPEE_ACCESS_TOKEN_EXPIRE_AT')) || 0,
    blobToken: get('BLOB_READ_WRITE_TOKEN'),
  };
}

export function requirePartnerCredentials(config) {
  const [idVar, keyVar] = config.live
    ? ['LIVE_PARTNER_ID', 'LIVE_API_PARTNER_KEY']
    : ['TEST_PARTNER_ID', 'TEST_API_PARTNER_KEY'];
  const missing = [];
  if (!config.partnerId) missing.push(idVar);
  if (!config.partnerKey) missing.push(keyVar);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')} in ${config.envPath}`);
  }
}
