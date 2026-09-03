import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from './env-file.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_PATH = resolve(ROOT, '.env');
/** Written by `vercel env pull` / `vercel blob create-store`; holds BLOB_READ_WRITE_TOKEN. */
export const ENV_LOCAL_PATH = resolve(ROOT, '.env.local');

export const DEFAULT_API_BASE_URL = 'https://open-api.tiktokglobalshop.com';
export const DEFAULT_AUTH_BASE_URL = 'https://auth.tiktok-shops.com';
export const AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize';
// ID/Tokopedia sellers authorize through Tokopedia Seller Center instead of the
// global services.tiktokshop.com link reported by partner-service-detail.
export const TOKOPEDIA_AUTHORIZE_URL =
  'https://seller-id.tokopedia.com/services/market/custom-authorize';

export const DEFAULT_PUBLIC_BASE_URL = 'https://tokopedia-treelogy-dev.vercel.app';
export const CALLBACK_PATH = '/api/callback';

/** The exact string registered as redirect_url in Partner Center. */
export function redirectUri(config) {
  return `${config.publicBaseUrl.replace(/\/$/, '')}${CALLBACK_PATH}`;
}

/**
 * Environment resolution order: process.env (what Vercel injects at runtime) wins,
 * then .env.local (Vercel-managed local values), then .env (the committed-shape file).
 */
export function loadConfig() {
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';

  return {
    envPath: ENV_PATH,
    appKey: get('APP_KEY'),
    appSecret: get('APP_SECRET'),
    serviceId: get('SERVICE_ID'),
    accessToken: get('ACCESS_TOKEN'),
    refreshToken: get('REFRESH_TOKEN'),
    accessTokenExpireAt: Number(get('ACCESS_TOKEN_EXPIRE_AT')) || 0,
    refreshTokenExpireAt: Number(get('REFRESH_TOKEN_EXPIRE_AT')) || 0,
    openId: get('OPEN_ID'),
    sellerName: get('SELLER_NAME'),
    shopId: get('SHOP_ID'),
    shopCipher: get('SHOP_CIPHER'),
    shopName: get('SHOP_NAME'),
    publicBaseUrl: get('PUBLIC_BASE_URL') || DEFAULT_PUBLIC_BASE_URL,
    blobToken: get('BLOB_READ_WRITE_TOKEN'),
    apiBaseUrl: get('API_BASE_URL') || DEFAULT_API_BASE_URL,
    authBaseUrl: get('AUTH_BASE_URL') || DEFAULT_AUTH_BASE_URL,
  };
}

export function requireAppCredentials(config) {
  const missing = [];
  if (!config.appKey) missing.push('APP_KEY');
  if (!config.appSecret) missing.push('APP_SECRET');
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')} in ${config.envPath}`);
  }
}
