/**
 * Which parcels have a driver coming for them.
 *
 * An ordinary order is dropped off: it can be packed this afternoon, or this evening, and
 * nothing outside the building is waiting. An instant order is the opposite - the channel
 * dispatches a driver the moment it is arranged, and a driver at an unpacked bench is the
 * failure this exists to prevent. So these are worth interrupting somebody for, and
 * nothing else is.
 *
 * The rules are read off the live database rather than guessed: 3,802 orders since
 * August, grouped by channel and courier. Every string below appears in that count, and
 * the ones deliberately excluded appear in it too.
 *
 *   GrabExpress Instant        shopee        38
 *   GoSend Instant Prioritas   shopee        11
 *   Gosend Instant             shopee         1
 *   Grab Express Instant       manual         2
 *   Grab                       tokopedia 18, tiktok_shop 2
 *   Gojek                      tokopedia  1, tiktok_shop 1
 *   Paxel                      tokopedia     60
 *
 * The bare "Grab" and "Gojek" are Tokopedia's instant couriers under their short names -
 * confirmed against the live fulfilment API, where Instant/Grab and Instant/Gojek come
 * back as PICKUP while J&T and JNE come back as DROP_OFF. Paxel is Same day, also PICKUP:
 * a driver comes, but today rather than now, so it is its own tier.
 *
 * What is NOT express, and why it has to be said: "DHL Express" (shopify, 1) carries the
 * word and is an international air service, not a motorbike. Matching on "express" alone
 * would have alerted on it, which is exactly the kind of false alarm that teaches people
 * to dismiss the popup without reading it.
 */

/** A driver is dispatched now; this parcel is the next thing anyone should touch. */
export const INSTANT = 'instant';
/** A driver comes today. Worth knowing about, not worth dropping a box for. */
export const SAME_DAY = 'sameday';

const RULES = [
  // Order matters only in that the first match wins; these do not overlap.
  { tier: INSTANT, label: 'Instant', test: (c) => /\binstant\b/i.test(c) },
  // Whole word, so a future "Grabmart" or "Gojek Kilat" is not swept in silently.
  { tier: INSTANT, label: 'Instant', test: (c) => /^(grab|gojek|gosend|grabexpress)$/i.test(c.trim()) },
  { tier: SAME_DAY, label: 'Same day', test: (c) => /^paxel$/i.test(c.trim()) },
];

/**
 * @param {{carrier?: string}} order
 * @returns {{tier: string, label: string, courier: string}|null} null for a drop-off
 */
export function expressService(order) {
  const courier = String(order?.carrier ?? '').trim();
  if (!courier) return null;
  const rule = RULES.find((r) => r.test(courier));
  return rule ? { tier: rule.tier, label: rule.label, courier } : null;
}

export const isExpress = (order) => Boolean(expressService(order));
export const isInstant = (order) => expressService(order)?.tier === INSTANT;

/*
 * No screen wording lives here any more.
 *
 * This file answers one question - what kind of handover is this courier - and the
 * answer is the same whether anybody is told about it. Which of those answers is worth
 * interrupting a person for is a separate decision, and it changed once already: same
 * day used to raise a popup and no longer does. Keeping the two apart means that change
 * touched the alert and not the classifier.
 */
