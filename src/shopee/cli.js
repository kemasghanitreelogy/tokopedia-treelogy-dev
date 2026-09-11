import { loadShopeeConfig, requirePartnerCredentials, shopeeRedirectUri, TEST_HOST } from './config.js';
import { buildAuthorizeUrl, refreshAccessToken, persistShopeeTokens } from './auth.js';
import { buildPublicUrl } from './sign.js';
import { getShopInfo, getOrderList, getItemList } from './client.js';
import { loadTokenBundle, saveTokenBundle, SHOPEE_TOKENS_PATHNAME, BlobNotConfiguredError } from '../token-store.js';
import { openBrowser } from '../open-browser.js';
import { ok, fail, warn, info, mask, humanTime } from '../format.js';

const USAGE = `shopee - Shopee Open API v2 client

Usage:
  npm run shopee:doctor       Check the partner_id / partner_key pair against Shopee
  npm run shopee:url          Print (and open) the seller authorization link
  npm run shopee:pull         Pull the bundle written by the callback into .env
  npm run shopee:refresh      Refresh the access token (valid 4 hours, rotates)
  npm run shopee:shop         Shop info - proves the shop-scoped signature works
  npm run shopee:orders       Orders created in the last 14 days
  npm run shopee:items        Active listings
`;

function requireAuth(config) {
  requirePartnerCredentials(config);
  if (!config.accessToken || !config.shopId) {
    throw new Error('No SHOPEE_ACCESS_TOKEN / SHOPEE_SHOP_ID in .env - run `npm run shopee:pull` after authorizing');
  }
  return { accessToken: config.accessToken, shopId: config.shopId };
}

/**
 * Answers one question: does this partner_id / partner_key pair actually work?
 *
 * Shopee's replies are diagnostic on their own, so the classification is exact:
 *   invalid_partner_id -> the id does not exist on this host (wrong environment)
 *   error_sign         -> the id exists but Shopee holds a different key for it
 *   anything else      -> the signature was accepted
 */
async function cmdDoctor(config) {
  requirePartnerCredentials(config);
  const path = '/api/v2/shop/auth_partner';

  console.log(`\n${info(`host       : ${config.host} (${config.host === TEST_HOST ? 'TEST' : 'LIVE'})`)}`);
  console.log(info(`partner_id : ${config.partnerId}`));
  console.log(info(`partner_key: ${mask(config.partnerKey, 8)}`));

  const probe = await fetch(config.host + path, { redirect: 'manual' });
  const skew = Math.floor(Date.now() / 1000) - Math.floor(new Date(probe.headers.get('date')).getTime() / 1000);
  console.log(Math.abs(skew) < 60
    ? ok(`clock in sync with Shopee (${skew}s)`)
    : fail(`clock is ${skew}s off Shopee - signatures expire outside a 5 minute window`));

  const response = await fetch(buildPublicUrl(config, path, { redirect: shopeeRedirectUri(config) }), {
    redirect: 'manual',
  });
  const body = await response.text();
  const error = (body.match(/"error":"([^"]*)"/) ?? [])[1];

  if (!error) {
    console.log(ok(`signature accepted - ${config.live ? 'live' : 'test'} credentials are good`));
    if (config.live) console.log(info('live partner keys expire - check the expiry date in the console'));
    return 0;
  }
  if (error === 'invalid_partner_id') {
    console.log(fail(`partner_id ${config.partnerId} does not exist on this host`));
    console.log(`        A test partner_id only works on ${TEST_HOST}.`);
    return 1;
  }
  if (error === 'error_sign') {
    console.log(fail(`partner_id ${config.partnerId} exists here, but Shopee holds a different key for it`));
    console.log('        The app is provisioned on this cluster; only the key is wrong.');
    console.log('        Shopee runs two separate consoles and they do not share keys:');
    console.log('          live    open.shopee.com            -> partner.shopeemobile.com');
    console.log('          sandbox open.test-stable.shopee.com -> ' + TEST_HOST.replace('https://', ''));
    console.log('        A key copied from the live console is rejected here even though it');
    console.log('        is labelled "Test API Partner Key". Take the key from the sandbox');
    console.log('        console instead.');
    return 1;
  }
  console.log(fail(`Shopee returned ${error}`));
  return 1;
}

async function cmdUrl(config) {
  requirePartnerCredentials(config);
  const { url, redirect } = buildAuthorizeUrl(config);

  console.log(`\n${info(`environment: ${config.host === TEST_HOST ? 'TEST' : 'LIVE'} (${config.host})`)}`);
  console.log(`${info(`partner_id : ${config.partnerId}`)}\n`);
  console.log('Register this exact string as the app Callback URL in the Shopee console:');
  console.log(`  ${redirect}\n`);
  console.log('Then open this link and approve with a test seller account:');
  console.log(`  ${url}\n`);
  console.log(warn('the link is signed with a timestamp - it stops working after ~5 minutes'));
  await openBrowser(url);
  return 0;
}

async function cmdPull(config) {
  if (!config.blobToken) throw new BlobNotConfiguredError();
  const bundle = await loadTokenBundle({ pathname: SHOPEE_TOKENS_PATHNAME, token: config.blobToken });
  if (!bundle) {
    console.log(fail('no Shopee bundle stored yet - authorize first (`npm run shopee:url`)'));
    return 1;
  }
  persistShopeeTokens(config, bundle.tokens, bundle.shop);
  console.log(ok('Shopee token bundle written to .env'));
  console.log(`        shop          : ${config.shopName || '(unnamed)'} (id ${config.shopId})`);
  console.log(`        access expires: ${humanTime(config.accessTokenExpireAt)}`);
  console.log(`        refresh token : ${mask(config.refreshToken, 6)}`);
  return 0;
}

async function cmdRefresh(config) {
  requirePartnerCredentials(config);
  if (!config.refreshToken || !config.shopId) {
    throw new Error('No SHOPEE_REFRESH_TOKEN / SHOPEE_SHOP_ID in .env - authorize first');
  }
  const tokens = await refreshAccessToken(config, {
    refreshToken: config.refreshToken,
    shopId: config.shopId,
  });
  persistShopeeTokens(config, tokens);
  // Keep the blob in step: the old refresh token is dead the moment this succeeds.
  if (config.blobToken) {
    await saveTokenBundle({
      tokens,
      nonce: `shopee-${config.shopId}`,
      shop: config.shopName ? { shop_id: config.shopId, shop_name: config.shopName } : null,
      pathname: SHOPEE_TOKENS_PATHNAME,
      token: config.blobToken,
    });
  }
  console.log(ok(`access token refreshed - expires ${humanTime(config.accessTokenExpireAt)}`));
  return 0;
}

const show = (payload) => console.log(JSON.stringify(payload.response ?? payload, null, 2));

const COMMANDS = {
  doctor: cmdDoctor,
  url: cmdUrl,
  pull: cmdPull,
  refresh: cmdRefresh,
  shop: async (config) => show(await getShopInfo(config, requireAuth(config))),
  orders: async (config) => show(await getOrderList(config, requireAuth(config))),
  items: async (config) => show(await getItemList(config, requireAuth(config))),
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

  const config = loadShopeeConfig();
  try {
    return (await handler(config, args)) ?? 0;
  } catch (error) {
    console.error(`\n${fail(error.message)}\n`);
    return 1;
  }
}
