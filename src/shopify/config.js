import { readEnv } from '../env-file.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';

/**
 * Shopify Admin API configuration.
 *
 * The token is a store-scoped Admin access token (shpat_...), but the Admin API is
 * addressed per store, so the myshopify domain is required too - a token alone cannot
 * find its own shop.
 */

// Current stable version, confirmed against shopify.dev while writing these queries.
export const API_VERSION = '2026-07';

export function loadShopifyConfig() {
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';

  const raw = get('SHOPIFY_SHOP_DOMAIN') || get('SHOPIFY_SHOP') || get('STORE_NAME');
  // Accept "treelogy", "treelogy.myshopify.com" or a full URL, and normalise.
  const domain = raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.myshopify\.com$/, '');

  return {
    domain: domain ? `${domain}.myshopify.com` : '',
    token: get('SHOPIFY_ADMIN_API') || get('SHOPIFY_ADMIN_TOKEN'),
    clientId: get('SHOPIFY_APP_CLIENT_ID'),
    clientSecret: get('SHOPIFY_APP_CLIENT_SECRET'),
    apiVersion: get('SHOPIFY_API_VERSION') || API_VERSION,
  };
}

export const isShopifyConfigured = (config = loadShopifyConfig()) =>
  Boolean(config.domain && config.token);

export function requireShopify(config = loadShopifyConfig()) {
  if (!config.token) throw new Error('SHOPIFY_ADMIN_API belum diisi di .env');
  if (!config.domain) {
    throw new Error('SHOPIFY_SHOP_DOMAIN belum diisi - contoh: SHOPIFY_SHOP_DOMAIN=namatoko');
  }
  return config;
}
