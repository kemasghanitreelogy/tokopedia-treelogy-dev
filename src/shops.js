import { callApi } from './client.js';
import { updateEnv } from './env-file.js';

const SHOPS_PATH = '/authorization/202309/shops';

/**
 * List the shops that have authorized this app. This endpoint must be called WITHOUT
 * shop_cipher - it is the call that discovers the cipher in the first place.
 */
export async function fetchAuthorizedShops(config) {
  const { data, requestId } = await callApi({
    config,
    method: 'GET',
    path: SHOPS_PATH,
    shopCipher: false,
  });
  return { shops: data.shops ?? data.shop_list ?? [], requestId };
}

/** Persist the selected shop's identifiers so later calls can inject shop_cipher. */
export function persistShop(config, shop) {
  const shopId = shop.id ?? shop.shop_id ?? '';
  const cipher = shop.cipher ?? shop.shop_cipher ?? '';
  const name = shop.name ?? shop.shop_name ?? '';

  updateEnv(config.envPath, { SHOP_ID: shopId, SHOP_CIPHER: cipher, SHOP_NAME: name });

  config.shopId = shopId;
  config.shopCipher = cipher;
  config.shopName = name;
  return { shopId, cipher, name };
}
