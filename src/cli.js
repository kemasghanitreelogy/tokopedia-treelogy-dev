import { loadConfig, requireAppCredentials, redirectUri } from './config.js';
import { buildAuthorizeUrl, refreshAccessToken, persistTokens } from './auth.js';
import { callApi, ApiError, accessTokenExpired } from './client.js';
import { fetchAuthorizedShops, persistShop } from './shops.js';
import { createState } from './state.js';
import { loadTokenBundle, saveTokenBundle, BlobNotConfiguredError } from './token-store.js';
import { openBrowser } from './open-browser.js';
import { mask, ok, fail, warn, info, humanTime } from './format.js';
import { signRequest } from './sign.js';

const USAGE = `tts - TikTok Shop Open API client (ID / Tokopedia)

Usage:
  npm run authorize           Open the seller approval page, wait for the hosted callback
  npm run pull                Pull the stored token bundle from Vercel Blob into .env
  npm run url                 Print the authorization URL and the redirect URL to register
  npm run refresh             Refresh the access token (and sync it to Blob)
  npm run shops               List authorized shops and save shop_cipher
  npm run doctor              End-to-end health check
  npm run api -- <METHOD> <path> [key=value ...] [--body '<json>']

Examples:
  npm run api -- GET /seller/202309/shops
  npm run api -- GET /product/202312/products/search page_size=10
`;

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function printShops(shops) {
  shops.forEach((shop, index) => {
    console.log(`  [${index}] ${shop.name ?? shop.shop_name ?? '(unnamed)'}`);
    console.log(`      id      : ${shop.id ?? shop.shop_id ?? '-'}`);
    console.log(`      region  : ${shop.region ?? '-'}   seller_type: ${shop.seller_type ?? '-'}`);
    console.log(`      code    : ${shop.code ?? '-'}`);
    console.log(`      cipher  : ${mask(shop.cipher ?? shop.shop_cipher, 6)}`);
  });
}

/** Write a bundle fetched from Blob into .env and the in-memory config. */
function applyBundle(config, bundle) {
  persistTokens(config, {
    accessToken: bundle.tokens?.accessToken ?? '',
    refreshToken: bundle.tokens?.refreshToken ?? '',
    accessTokenExpireAt: bundle.tokens?.accessTokenExpireAt ?? 0,
    refreshTokenExpireAt: bundle.tokens?.refreshTokenExpireAt ?? 0,
    openId: bundle.tokens?.openId ?? '',
    sellerName: bundle.tokens?.sellerName ?? '',
  });
  if (bundle.shop) persistShop(config, bundle.shop);
}

function reportBundle(config, bundle) {
  console.log(ok('token bundle written to .env'));
  console.log(`        access expires : ${humanTime(config.accessTokenExpireAt)}`);
  console.log(`        refresh expires: ${humanTime(config.refreshTokenExpireAt)}`);
  if (bundle.shop) {
    console.log(`        shop           : ${config.shopName || '(unnamed)'} (id ${config.shopId})`);
    console.log(`        shop_cipher    : ${mask(config.shopCipher, 6)}`);
  } else {
    console.log(warn('the callback stored no shop - run `npm run shops`'));
  }
}

async function cmdAuthorize(config) {
  requireAppCredentials(config);
  if (!config.serviceId) throw new Error('SERVICE_ID missing in .env');
  if (!config.blobToken) throw new BlobNotConfiguredError();

  const { state, nonce } = createState(config.appSecret);
  const { tokopediaUrl } = buildAuthorizeUrl({ serviceId: config.serviceId, state });

  console.log(`\nRedirect URL (must match Partner Center):\n  ${redirectUri(config)}\n`);

  const opened = openBrowser(tokopediaUrl);
  console.log(opened ? info('opening the authorization page...') : warn('open this URL manually:'));
  console.log(`\n  ${tokopediaUrl}\n`);
  console.log(info('waiting for the hosted callback to store the tokens (5 min timeout)...'));

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const bundle = await loadTokenBundle({ token: config.blobToken });
    if (bundle?.nonce === nonce) {
      console.log(`\n${info('callback completed')}`);
      applyBundle(config, bundle);
      reportBundle(config, bundle);
      return 0;
    }
  }

  console.log(fail('timed out waiting for the callback'));
  console.log('        Inspect the function logs with:  vercel logs');
  return 1;
}

async function cmdPull(config) {
  if (!config.blobToken) throw new BlobNotConfiguredError();
  const bundle = await loadTokenBundle({ token: config.blobToken });
  if (!bundle) {
    console.log(warn('no token bundle stored yet - run `npm run authorize`'));
    return 1;
  }
  console.log(`\nBundle saved at ${bundle.saved_at}`);
  applyBundle(config, bundle);
  reportBundle(config, bundle);
  return 0;
}

async function cmdUrl(config) {
  if (!config.serviceId) throw new Error('SERVICE_ID missing in .env');
  const { state } = createState(config.appSecret || 'unset');
  const { url, tokopediaUrl } = buildAuthorizeUrl({ serviceId: config.serviceId, state });

  console.log(`\nRegister this redirect URL in Partner Center:\n  ${redirectUri(config)}\n`);
  console.log('Then open ONE of these and approve as the seller.\n');
  console.log('  ID / Tokopedia seller (use this one):');
  console.log(`    ${tokopediaUrl}\n`);
  console.log('  Global TikTok Shop seller:');
  console.log(`    ${url}\n`);
  console.log('Prefer `npm run authorize` - it does this and collects the tokens for you.\n');
}

async function cmdRefresh(config) {
  requireAppCredentials(config);
  const tokens = await refreshAccessToken({ config });
  persistTokens(config, tokens);

  // Keep the shared bundle in step so the deployment never falls back to a stale token.
  if (config.blobToken) {
    await saveTokenBundle({
      tokens,
      nonce: 'refresh',
      shop: config.shopCipher
        ? { id: config.shopId, cipher: config.shopCipher, name: config.shopName }
        : null,
      token: config.blobToken,
    });
    console.log(ok('refreshed and synced to Vercel Blob'));
  } else {
    console.log(ok('access token refreshed locally'));
  }
  console.log(`        access expires : ${humanTime(tokens.accessTokenExpireAt)}`);
  console.log(`        refresh expires: ${humanTime(tokens.refreshTokenExpireAt)}`);
}

async function cmdShops(config) {
  requireAppCredentials(config);
  if (!config.accessToken) throw new Error('No ACCESS_TOKEN - run `npm run authorize` first');

  const { shops, requestId } = await fetchAuthorizedShops(config);
  console.log(`\nAuthorized shops: ${shops.length}   [request_id ${requestId}]\n`);
  if (shops.length === 0) {
    console.log(warn('No shops returned. The seller may have revoked the app,'));
    console.log('        or this access_token belongs to a different app.\n');
    return;
  }

  printShops(shops);
  const saved = persistShop(config, shops[0]);
  console.log(`\n${ok(`saved SHOP_ID / SHOP_CIPHER / SHOP_NAME for "${saved.name}"`)}\n`);
  if (shops.length > 1) {
    console.log(info('Multiple shops found; the first was saved. Edit .env to pick another.\n'));
  }
}

async function cmdApi(config, args) {
  requireAppCredentials(config);

  const bodyIndex = args.indexOf('--body');
  let body = null;
  if (bodyIndex !== -1) {
    body = JSON.parse(args[bodyIndex + 1]);
    args = [...args.slice(0, bodyIndex), ...args.slice(bodyIndex + 2)];
  }

  const [method, path, ...pairs] = args;
  if (!method || !path) throw new Error('Usage: npm run api -- <METHOD> <path> [key=value ...]');

  const query = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) throw new Error(`Bad query param "${pair}" - expected key=value`);
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  const { data, requestId, httpStatus } = await callApi({
    config,
    method: method.toUpperCase(),
    path,
    query,
    body,
  });
  console.log(`HTTP ${httpStatus}  [request_id ${requestId}]`);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdDoctor(config) {
  console.log('\nTikTok Shop integration doctor\n');
  let failed = 0;
  const step = (label) => console.log(`\n${label}`);

  step('1. App credentials');
  if (config.appKey && config.appSecret) {
    console.log(ok(`APP_KEY ${mask(config.appKey)}  APP_SECRET ${mask(config.appSecret)}`));
  } else {
    console.log(fail('APP_KEY / APP_SECRET missing in .env'));
    failed += 1;
  }

  step('2. Signature algorithm');
  signRequest({ path: '/t', query: { app_key: 'k' }, appSecret: 'secret' });
  console.log(ok('deterministic hex; base excludes sign/access_token'));

  step('3. API reachability (unsigned probe)');
  try {
    const response = await fetch(`${config.apiBaseUrl}/seller/202309/shops`);
    const payload = await response.json();
    if (payload.code === 36009004) {
      console.log(ok(`${config.apiBaseUrl} reachable; rejects unsigned request as expected`));
    } else {
      console.log(warn(`unexpected probe response: code ${payload.code} - ${payload.message}`));
    }
  } catch (error) {
    console.log(fail(`cannot reach ${config.apiBaseUrl}: ${error.message}`));
    failed += 1;
  }

  step('4. Hosted callback');
  console.log(`        register in Partner Center: ${redirectUri(config)}`);
  try {
    const response = await fetch(`${config.publicBaseUrl}/api/status`);
    if (response.ok) {
      const status = await response.json();
      const missing = Object.entries(status.env)
        .filter(([, present]) => !present)
        .map(([key]) => key);
      console.log(ok(`deployment live; stored tokens: ${status.tokens.state}`));
      if (missing.length > 0) {
        console.log(fail(`missing env on the deployment: ${missing.join(', ')}`));
        failed += 1;
      } else {
        console.log(ok('all required env vars present on the deployment'));
      }
    } else {
      console.log(fail(`GET /api/status returned HTTP ${response.status} - deployed yet?`));
      failed += 1;
    }
  } catch (error) {
    console.log(fail(`cannot reach ${config.publicBaseUrl}: ${error.message}`));
    failed += 1;
  }

  step('5. Blob store (local access)');
  if (!config.blobToken) {
    console.log(fail('BLOB_READ_WRITE_TOKEN missing - run `vercel env pull .env.local --yes`'));
    failed += 1;
  } else {
    try {
      const bundle = await loadTokenBundle({ token: config.blobToken });
      console.log(
        bundle
          ? ok(`bundle present, saved ${bundle.saved_at}`)
          : warn('reachable but empty - run `npm run authorize`'),
      );
    } catch (error) {
      console.log(fail(`blob read failed: ${error.message}`));
      failed += 1;
    }
  }

  step('6. Access token');
  if (!config.accessToken) {
    console.log(fail('ACCESS_TOKEN missing - run `npm run authorize`'));
    failed += 1;
  } else if (accessTokenExpired(config)) {
    console.log(warn(`expired at ${humanTime(config.accessTokenExpireAt)} - will auto-refresh`));
  } else {
    console.log(ok(`${mask(config.accessToken)}  expires ${humanTime(config.accessTokenExpireAt)}`));
  }

  step('7. Authorized shops (live call)');
  if (!config.accessToken) {
    console.log(info('skipped - no access token yet'));
  } else {
    try {
      const { shops, requestId } = await fetchAuthorizedShops(config);
      console.log(ok(`${shops.length} shop(s)  [request_id ${requestId}]`));
      printShops(shops);
    } catch (error) {
      console.log(fail(describeApiError(error)));
      failed += 1;
    }
  }

  step('8. Shop context');
  if (config.shopCipher) {
    console.log(
      ok(`${config.shopName || '(unnamed)'}  id ${config.shopId}  cipher ${mask(config.shopCipher, 6)}`),
    );
  } else {
    console.log(warn('SHOP_CIPHER not saved yet - run `npm run shops`'));
  }

  console.log(
    failed === 0 ? `\n${ok('all critical checks passed')}\n` : `\n${fail(`${failed} check(s) failed`)}\n`,
  );
  return failed === 0 ? 0 : 1;
}

function describeApiError(error) {
  if (!(error instanceof ApiError)) return error.message;
  const parts = [error.message];
  if (error.code !== undefined) parts.push(`code ${error.code}`);
  if (error.requestId) parts.push(`request_id ${error.requestId}`);
  return parts.join(' | ');
}

const COMMANDS = {
  authorize: cmdAuthorize,
  pull: cmdPull,
  url: cmdUrl,
  refresh: cmdRefresh,
  shops: cmdShops,
  doctor: cmdDoctor,
  api: cmdApi,
};

export async function run(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command "${command}"\n`);
    console.log(USAGE);
    return 1;
  }

  const config = loadConfig();
  try {
    return (await handler(config, args)) ?? 0;
  } catch (error) {
    console.error(`\n${fail(describeApiError(error))}\n`);
    return 1;
  }
}
