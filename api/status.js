import { loadConfig, redirectUri } from '../src/config.js';
import { loadTokenBundle } from '../src/token-store.js';

/**
 * Deployment health check. Reports whether the environment is wired up and whether a
 * token bundle exists - never the tokens themselves.
 */
export default async function handler(req, res) {
  const config = loadConfig();

  let tokenState = 'absent';
  let savedAt = null;
  let shopName = null;

  try {
    const bundle = await loadTokenBundle();
    if (bundle) {
      tokenState = 'present';
      savedAt = bundle.saved_at ?? null;
      shopName = bundle.shop?.name ?? bundle.shop?.shop_name ?? null;
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
        redirect_url: redirectUri(config),
        env: {
          APP_KEY: Boolean(config.appKey),
          APP_SECRET: Boolean(config.appSecret),
          SERVICE_ID: Boolean(config.serviceId),
          BLOB_READ_WRITE_TOKEN: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
        },
        tokens: { state: tokenState, saved_at: savedAt, shop: shopName },
      },
      null,
      2,
    ),
  );
}
