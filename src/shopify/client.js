import { loadShopifyConfig, requireShopify } from './config.js';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

/**
 * Admin GraphQL client.
 *
 * Shopify meters by query cost rather than request count, and answers a burst with
 * THROTTLED in `errors` rather than an HTTP error. Retrying on that signal is the
 * documented way to stay inside the leaky bucket.
 */

const RETRY_DELAYS_MS = [500, 1200, 2500, 4000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ShopifyError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'ShopifyError';
    this.code = code;
    this.status = status;
  }
}

const isThrottled = (errors) =>
  errors?.some((e) => e.extensions?.code === 'THROTTLED' || /throttl/i.test(e.message ?? ''));

export async function shopifyGraphql(query, variables = {}, config = loadShopifyConfig()) {
  requireShopify(config);
  const url = `https://${config.domain}/admin/api/${config.apiVersion}/graphql.json`;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    let response;
    try {
      response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': config.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (cause) {
      if (attempt === RETRY_DELAYS_MS.length) throw new ShopifyError(`tidak terjangkau: ${cause.message}`);
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    // 429 and 5xx are transient; anything else is a real answer.
    if (response.status === 429 || response.status >= 500) {
      if (attempt === RETRY_DELAYS_MS.length) {
        throw new ShopifyError(`HTTP ${response.status}`, { status: response.status });
      }
      const retryAfter = Number(response.headers.get('retry-after')) * 1000;
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : RETRY_DELAYS_MS[attempt]);
      continue;
    }

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ShopifyError(`respons bukan JSON (HTTP ${response.status}): ${text.slice(0, 160)}`, {
        status: response.status,
      });
    }

    if (response.status === 401 || response.status === 403) {
      throw new ShopifyError('token ditolak - periksa SHOPIFY_ADMIN_API dan scope-nya', {
        status: response.status,
      });
    }

    if (isThrottled(payload.errors)) {
      if (attempt === RETRY_DELAYS_MS.length) throw new ShopifyError('THROTTLED', { code: 'THROTTLED' });
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }

    if (payload.errors?.length > 0) {
      throw new ShopifyError(payload.errors.map((e) => e.message).join('; '), {
        code: payload.errors[0]?.extensions?.code,
        status: response.status,
      });
    }
    if (!payload.data) throw new ShopifyError('respons tanpa data');
    return payload.data;
  }

  throw new ShopifyError('gagal setelah beberapa percobaan');
}

/** Walk a Relay connection to the end, with a hard stop so a runaway query cannot hang. */
export async function paginate(query, variables, pick, { max = 1000, config } = {}) {
  const collected = [];
  let cursor = null;

  do {
    const data = await shopifyGraphql(query, { ...variables, cursor }, config);
    const connection = pick(data);
    collected.push(...(connection.nodes ?? []));
    cursor = connection.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor && collected.length < max);

  return collected;
}
