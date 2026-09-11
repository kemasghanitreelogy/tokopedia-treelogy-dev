import { loadConfig, DEFAULT_PUBLIC_BASE_URL } from '../config.js';
import { callApi } from '../client.js';
import { tiktokConfig } from '../omni.js';
import { buildPublicUrl } from '../shopee/sign.js';
import { loadShopeeConfig } from '../shopee/config.js';
import { shopifyGraphql } from '../shopify/client.js';
import { isShopifyConfigured } from '../shopify/config.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';

/**
 * Telling each platform where to push.
 *
 * Registration is a one-off, but it is written as code rather than done by hand in three
 * consoles so that a redeploy to a new URL is one command instead of an archaeology
 * expedition. Every call here is idempotent: registering a subscription that already
 * points at the right URL is a no-op on all three platforms.
 */

export const WEBHOOK_PATHS = {
  shopee: '/api/webhook/shopee',
  tiktok: '/api/webhook/tiktok',
  shopify: '/api/webhook/shopify',
};

/** Shopee's push codes. 3 is order status, 4 is the waybill number appearing. */
export const SHOPEE_PUSH_CODES = [3, 4];

/** Confirmed against the live TikTok Shop API: PUT /event/202309/webhooks takes these. */
export const TIKTOK_EVENTS = ['ORDER_STATUS_CHANGE'];

/** Paid is the event that matters; create covers a shop that captures payment up front. */
export const SHOPIFY_TOPICS = ['ORDERS_PAID', 'ORDERS_CREATE'];

export function baseUrl(config = loadConfig()) {
  const explicit = process.env.PUBLIC_BASE_URL || config.publicBaseUrl || DEFAULT_PUBLIC_BASE_URL;
  return explicit.replace(/\/$/, '');
}

export const webhookUrl = (platform, config) => `${baseUrl(config)}${WEBHOOK_PATHS[platform]}`;

/* ------------------------------------------------------------------ reading */

export async function shopeeStatus() {
  const config = loadShopeeConfig();
  const response = await fetch(buildPublicUrl(config, '/api/v2/push/get_push_config'));
  const body = await response.json();
  if (body.error) throw new Error(`${body.error}: ${body.message}`);
  return {
    callbackUrl: body.callback_url ?? '',
    // The live shape is an object of name -> 0/1, not the list the SDK docs describe.
    enabled: Object.entries(body.push_config ?? {}).filter(([, on]) => on).map(([name]) => name),
    blockedShops: body.blocked_shop_id ?? [],
    liveStatus: body.live_push_status ?? null,
  };
}

export async function tiktokStatus() {
  const { data } = await callApi({ config: await tiktokConfig(), method: 'GET', path: '/event/202309/webhooks' });
  return { total: data.total_count ?? 0, webhooks: data.webhooks ?? [] };
}

export async function shopifyStatus() {
  if (!isShopifyConfigured()) return { total: 0, webhooks: [] };
  const data = await shopifyGraphql(
    'query { webhookSubscriptions(first: 25) { nodes { id topic uri createdAt } } }',
  );
  const nodes = data.webhookSubscriptions?.nodes ?? [];
  return { total: nodes.length, webhooks: nodes };
}

export async function webhookStatus() {
  const [shopee, tiktok, shopify] = await Promise.allSettled([shopeeStatus(), tiktokStatus(), shopifyStatus()]);
  const unwrap = (r) => (r.status === 'fulfilled' ? r.value : { error: r.reason.message });
  return { shopee: unwrap(shopee), tiktok: unwrap(tiktok), shopify: unwrap(shopify) };
}

/* ------------------------------------------------------------------ writing */

export async function registerShopee({ url = webhookUrl('shopee') } = {}) {
  if (isReadOnly()) throw new ReadOnlyError('konfigurasi push Shopee');
  const config = loadShopeeConfig();

  const response = await fetch(buildPublicUrl(config, '/api/v2/push/set_app_push_config'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_url: url, set_push_config_on: SHOPEE_PUSH_CODES }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${body.error}: ${body.message}`);
  return { url, codes: SHOPEE_PUSH_CODES };
}

export async function registerTikTok({ url = webhookUrl('tiktok') } = {}) {
  if (isReadOnly()) throw new ReadOnlyError('langganan webhook TikTok Shop');

  const done = [];
  for (const event of TIKTOK_EVENTS) {
    // Field names confirmed by asking the live API with an incomplete body until it named
    // each one: "Address is a required field", then "EventType is a required field".
    await callApi({
      config: await tiktokConfig(), method: 'PUT', path: '/event/202309/webhooks',
      body: { address: url, event_type: event },
    });
    done.push(event);
  }
  return { url, events: done };
}

const WEBHOOK_CREATE = `
mutation TreelogyWebhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`;

export async function registerShopify({ url = webhookUrl('shopify') } = {}) {
  if (isReadOnly()) throw new ReadOnlyError('langganan webhook Shopify');

  const existing = await shopifyStatus();
  const done = [];
  const skipped = [];

  for (const topic of SHOPIFY_TOPICS) {
    // Shopify rejects a duplicate topic+uri with a userError rather than ignoring it,
    // so an already-correct subscription is left alone instead of re-created.
    if (existing.webhooks.some((w) => w.topic === topic && w.uri === url)) {
      skipped.push(topic);
      continue;
    }
    const data = await shopifyGraphql(WEBHOOK_CREATE, {
      topic,
      webhookSubscription: { uri: url, format: 'JSON' },
    });
    const errors = data.webhookSubscriptionCreate?.userErrors ?? [];
    if (errors.length > 0) throw new Error(`${topic}: ${errors.map((e) => e.message).join(', ')}`);
    done.push(topic);
  }
  return { url, created: done, alreadyThere: skipped };
}
