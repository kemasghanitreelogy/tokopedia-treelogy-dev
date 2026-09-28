import { raiseAlert } from './alerts.js';
import { expressService, isInstant, INSTANT } from './express.js';
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
  if (service?.tier !== INSTANT) return null;

  /*
   * Paid and waiting to be packed, or no chime.
   *
   * A platform pushes for every state an order passes through, including all the ones
   * after it stops being anybody's work. The guard used to live in the sweep alone and
   * the webhook path had none - so Shopee's status change for 260926279MHKMD at 14.07 on
   * 28 September rang the bench for an order created on the 26th that was COMPLETED and
   * long delivered. The card read "Masuk 07.02 WITA", the operator went looking for it in
   * Shopee, and quite rightly found nothing.
   *
   * Whether the packers should stop what they are doing is a property of the order rather
   * than of which code path noticed it, so it is decided here and both paths inherit it.
   */
  if (!AWAITING_PACKING.has(order?.stage)) return null;

  const items = (order.lines ?? []).reduce((n, line) => n + (Number(line.qty) || 0), 0);

  return {
    key: `express:${order.channel}:${order.id}`,
    kind: 'express',
    tone: 'act',
    title: 'Instant — driver segera dijemput',
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

/**
 * How fresh a parcel has to be for its arrival to still be news.
 *
 * Six hours covers a working day's worth of a missed push without ringing about a parcel
 * from last Tuesday. The point of the sweep is to catch a webhook that never came, not
 * to re-announce history.
 */
export const FRESH_MS = 6 * 60 * 60_000;

/** A burst cannot become a wall: nobody reads the seventh popup anyway. */
const MAX_PER_SWEEP = 5;

/**
 * Only the instant tier rings.
 *
 * Same day - Paxel - is a pickup too, and the classifier still says so, but a driver
 * coming at some point today is not something to drop a box for. It was ringing at first
 * and the operator asked for it to stop, which is the right call: 60 of the 134 pickups
 * in the database are Paxel, so it was close to half the noise for the least of the
 * urgency. An alert channel that carries the merely interesting is one people mute.
 */

/**
 * Paid, and still waiting to be packed. That is the whole of it.
 *
 * The point of the chime, in the operator's words, is so the packing team can get the
 * product ready - so the moment worth interrupting them for is a paid instant order
 * newly arrived, and nothing else. Not an unpaid one, where no driver has been asked
 * for; not one already on its way; and not one that was delivered two days ago.
 *
 * `to_ship` is exactly that moment on every channel: Shopee's READY_TO_SHIP, Tokopedia
 * and TikTok's AWAITING_SHIPMENT. It started as this plus `shipping`, which was too wide
 * by one stage - `shipping` means the parcel has gone.
 */
export const AWAITING_PACKING = new Set(['to_ship']);

/**
 * The safety net behind the webhook.
 *
 * Shopee's pushes cannot be verified by signature and are rate limited per shop, so a
 * missed one is entirely ordinary - and a missed push for an instant order is the exact
 * case this whole feature exists for. The web service already re-reads the outstanding
 * worklist every four minutes to keep the dashboard warm; this looks at what it found.
 *
 * It rings nothing the webhook already rang, because the feed refuses a repeated key.
 */
export async function ringExpressBacklog(orders = [], { now = Date.now() } = {}) {
  const wanted = orders
    // The stage is checked by expressAlert now, for both paths at once; this keeps only
    // what the sweep adds on top of it.
    .filter((o) => isInstant(o))
    .filter((o) => Number(o.createdAt) * 1000 > now - FRESH_MS)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
    .slice(0, MAX_PER_SWEEP);

  const rung = [];
  for (const order of wanted) {
    const raised = await announceExpress(order);
    if (raised) rung.push(raised);
  }
  return rung;
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
