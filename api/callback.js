import { loadConfig } from '../src/config.js';
import { exchangeAuthCode } from '../src/auth.js';
import { verifyState } from '../src/state.js';
import { saveTokenBundle } from '../src/token-store.js';
import { fetchAuthorizedShops } from '../src/shops.js';
import { page } from '../src/page.js';

/**
 * OAuth redirect target: https://<deployment>/api/callback
 *
 * Registered as the app's redirect_url in Partner Center. TikTok sends the seller here
 * with ?code=&state= after they approve. This handler verifies the signed state,
 * exchanges the code, discovers the authorized shop, and writes the whole bundle to a
 * private blob. Nothing sensitive is ever rendered into the response.
 */
export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const send = (status, html) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
  };

  const config = loadConfig();
  if (!config.appKey || !config.appSecret) {
    console.error('callback: APP_KEY / APP_SECRET missing from the environment');
    send(500, page.error('Server not configured', 'APP_KEY and APP_SECRET are not set for this environment.'));
    return;
  }

  const providerError = url.searchParams.get('error') || url.searchParams.get('error_description');
  if (providerError) {
    send(400, page.error('Authorization declined', `TikTok returned: ${page.escape(providerError)}`));
    return;
  }

  const stateCheck = verifyState(config.appSecret, url.searchParams.get('state') ?? '');
  if (!stateCheck.valid) {
    console.warn(`callback: rejected state (${stateCheck.reason})`);
    send(400, page.error('Invalid state', `This callback could not be verified (${stateCheck.reason}). Start again from your terminal.`));
    return;
  }

  const authCode = url.searchParams.get('code') || url.searchParams.get('auth_code');
  if (!authCode) {
    send(400, page.error('Missing code', 'The callback did not carry an authorization code.'));
    return;
  }

  let tokens;
  try {
    tokens = await exchangeAuthCode({ config, authCode });
  } catch (error) {
    console.error(`callback: token exchange failed - ${error.message}`);
    send(502, page.error('Token exchange failed', 'TikTok rejected the authorization code. It may have already been used or expired.'));
    return;
  }

  // Discover the shop straight away so the stored bundle is immediately usable.
  let shop = null;
  try {
    const authorized = { ...config, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    const { shops } = await fetchAuthorizedShops(authorized);
    shop = shops[0] ?? null;
  } catch (error) {
    console.warn(`callback: shop discovery failed - ${error.message}`);
  }

  try {
    await saveTokenBundle({ tokens, nonce: stateCheck.nonce, shop });
  } catch (error) {
    console.error(`callback: could not persist tokens - ${error.message}`);
    send(500, page.error('Could not save tokens', 'The tokens were issued but could not be stored. Check that the blob store is linked to this project.'));
    return;
  }

  console.log(`callback: authorized shop=${shop?.name ?? 'unknown'} nonce=${stateCheck.nonce.slice(0, 6)}`);
  send(200, page.success(shop));
}
