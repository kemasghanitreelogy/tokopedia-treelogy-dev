import { raiseAlert } from './alerts.js';
import { expressService, TIER_TEXT } from './express.js';
import { channelDate, zoneForChannel, BENCH_CHANNEL } from './clock.js';

/**
 * Turn an express order into the thing that appears on a screen.
 *
 * Separate from both the classifier and the feed, because it is the only part that has
 * an opinion about wording, and wording is the part that changes. The classifier answers
 * a question about a courier; the feed carries whatever it is given; this decides what a
 * person at a bench needs to read in the two seconds they will give it.
 *
 * What they need is: which channel, which order, which courier, who it is for, and how
 * much - in that order, because the first three decide what to pick up and the last two
 * confirm they picked up the right thing.
 */

const CHANNEL_NAMES = {
  shopee: 'Shopee', tokopedia: 'Tokopedia', tiktok_shop: 'TikTok Shop',
  shopify: 'Website', manual: 'Manual',
};

const rupiah = (value) => `Rp${Math.round(Number(value) || 0).toLocaleString('id-ID')}`;

/** The clock the bench reads, so "16.26" means what the person standing there thinks. */
const benchTime = (epochSeconds) => new Date(Number(epochSeconds) * 1000).toLocaleString('id-ID', {
  hour: '2-digit', minute: '2-digit', timeZone: zoneForChannel(BENCH_CHANNEL).name,
});

export function expressAlert(order) {
  const service = expressService(order);
  if (!service) return null;
  const text = TIER_TEXT[service.tier];
  const items = (order.lines ?? []).reduce((n, line) => n + (Number(line.qty) || 0), 0);

  return {
    key: `express:${order.channel}:${order.id}`,
    kind: 'express',
    tone: text.tone,
    title: text.title,
    body: `${CHANNEL_NAMES[order.channel] ?? order.channel} · ${order.id}`,
    href: '/api/dashboard?view=labels',
    data: {
      channel: order.channel,
      channelName: CHANNEL_NAMES[order.channel] ?? order.channel,
      id: order.id,
      tier: service.tier,
      courier: service.courier,
      buyer: order.buyer || order.customer || '',
      total: Number.isFinite(Number(order.total)) ? rupiah(order.total) : '',
      items,
      placedAt: order.createdAt ? benchTime(order.createdAt) : '',
      placedDay: order.createdAt ? channelDate(order.createdAt, order.channel) : '',
    },
  };
}

/** Ring the doorbell for this order, if it is one worth ringing for. */
export async function announceExpress(order) {
  const alert = expressAlert(order);
  if (!alert) return null;
  const raised = await raiseAlert(alert);
  if (raised) {
    console.log(`alert/express: ${alert.data.channel} ${alert.data.id} ${alert.data.courier}`);
  }
  return raised;
}
