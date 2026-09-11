import { loadShopeeConfig } from '../../src/shopee/config.js';
import { exchangeCode } from '../../src/shopee/auth.js';
import { getShopInfo } from '../../src/shopee/client.js';
import { saveTokenBundle, SHOPEE_TOKENS_PATHNAME } from '../../src/token-store.js';
import { page } from '../../src/page.js';

/**
 * Shopee OAuth redirect target: https://<deployment>/api/shopee/callback
 *
 * Register this exact string as the app's Callback URL in the Shopee Open Platform
 * console. After the seller approves, Shopee redirects here with ?code=&shop_id=.
 * This handler exchanges the code, reads the shop name back, and writes the bundle to
 * the private blob store. No secret is ever rendered into the response.
 *
 * Shopee does not echo a `state` parameter, so the callback cannot be bound to a
 * request we started. Instead: the code exchange itself is the proof (a forged code is
 * rejected by Shopee), and when SHOPEE_SHOP_ID is set only that shop is accepted, so a
 * stray callback cannot overwrite the stored bundle with another seller's tokens.
 */
export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const send = (status, html) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
  };

  const config = loadShopeeConfig();
  if (!config.partnerId || !config.partnerKey) {
    console.error('shopee callback: partner id / key missing from the environment');
    send(500, page.error('Server not configured', 'TEST_PARTNER_ID and TEST_API_PARTNER_KEY are not set for this environment.'));
    return;
  }

  const providerError = url.searchParams.get('error') || url.searchParams.get('message');
  if (providerError) {
    send(400, page.error('Authorization declined', `Shopee returned: ${page.escape(providerError)}`));
    return;
  }

  const code = url.searchParams.get('code');
  const shopId = url.searchParams.get('shop_id');
  if (!code || !shopId) {
    // main_account_id arrives instead of shop_id when a merchant (not a shop) authorizes.
    const merchantId = url.searchParams.get('main_account_id');
    const detail = merchantId
      ? 'This looks like a merchant-level authorization; this app expects a shop-level one.'
      : 'The callback did not carry both a code and a shop_id.';
    send(400, page.error('Missing code or shop_id', detail));
    return;
  }

  if (config.shopId && config.shopId !== shopId) {
    console.warn(`shopee callback: unexpected shop_id ${shopId} (pinned to ${config.shopId})`);
    send(400, page.error('Wrong shop', 'This callback was issued for a shop this deployment is not bound to.'));
    return;
  }

  let tokens;
  try {
    tokens = await exchangeCode(config, { code, shopId });
  } catch (error) {
    console.error(`shopee callback: token exchange failed - ${error.message}`);
    send(502, page.error('Token exchange failed', 'Shopee rejected the authorization code. It may have already been used or expired - codes last about 10 minutes.'));
    return;
  }

  // Read the shop back straight away so the stored bundle is immediately usable and the
  // signature path for shop-scoped calls is proven end to end.
  let shop = null;
  try {
    const info = await getShopInfo(config, { accessToken: tokens.accessToken, shopId });
    shop = { shop_id: shopId, shop_name: info.shop_name, region: info.region, status: info.status };
  } catch (error) {
    console.warn(`shopee callback: get_shop_info failed - ${error.message}`);
  }

  try {
    await saveTokenBundle({
      tokens,
      nonce: `shopee-${shopId}`,
      shop,
      pathname: SHOPEE_TOKENS_PATHNAME,
    });
  } catch (error) {
    console.error(`shopee callback: could not persist tokens - ${error.message}`);
    send(500, page.error('Could not save tokens', 'The tokens were issued but could not be stored. Check that the blob store is linked to this project.'));
    return;
  }

  console.log(`shopee callback: authorized shop=${shop?.shop_name ?? 'unknown'} id=${shopId}`);
  send(200, page.success(shop ? { name: shop.shop_name, id: shopId, region: shop.region } : null));
}
