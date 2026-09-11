import { loadShopeeConfig, shopeeRedirectUri, TEST_HOST } from '../../src/shopee/config.js';
import { loadTokenBundle, SHOPEE_TOKENS_PATHNAME } from '../../src/token-store.js';

/** Health check for the Shopee half: is the environment wired up, is a bundle stored. */
export default async function handler(req, res) {
  const config = loadShopeeConfig();

  let tokenState = 'absent';
  let savedAt = null;
  let shopName = null;

  try {
    const bundle = await loadTokenBundle({ pathname: SHOPEE_TOKENS_PATHNAME });
    if (bundle) {
      tokenState = 'present';
      savedAt = bundle.saved_at ?? null;
      shopName = bundle.shop?.shop_name ?? null;
    }
  } catch (error) {
    tokenState = `error: ${error.name}`;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify(
      {
        ok: true,
        callback_url: shopeeRedirectUri(config),
        host: config.host,
        environment: config.host === TEST_HOST ? 'test' : 'live',
        env: {
          PARTNER_ID: Boolean(config.partnerId),
          PARTNER_KEY: Boolean(config.partnerKey),
          BLOB_READ_WRITE_TOKEN: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
        },
        tokens: { state: tokenState, saved_at: savedAt, shop: shopName },
      },
      null,
      2,
    ),
  );
}
