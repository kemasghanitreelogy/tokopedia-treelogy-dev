/**
 * Treelogy's own order-code prefixes.
 *
 * Every order already carries a source prefix in the way the business talks about it -
 * SP-260911QF5PA82R, not 260911QF5PA82R - so the invoices in Jurnal use the same
 * convention. Without it an accountant reading the books has to know by heart that a
 * code starting with 25 is Shopee and one starting with # is Shopify.
 *
 * Shopify is the only source whose prefix is not decided by the channel alone: it
 * depends on how the buyer paid, so it is detected from the order and falls back to the
 * neutral SHF when detection cannot tell.
 */

/**
 * The prefixes themselves, and only what a prefix is.
 *
 * Payment terms used to live here too, alongside a copy of the same fact in the source
 * table - two places to change and one of them always forgotten. Terms, tags, receivables
 * and whether the platform already took the money are all properties of the *source*, and
 * they live together in sources.js. This file answers one question: what does an order
 * code start with.
 */
export const PREFIXES = {
  SP: { label: 'Shopee', channel: 'shopee' },
  SHF: { label: 'Shopify', channel: 'shopify' },
  TP: { label: 'Tokopedia', channel: 'tokopedia' },
  TT: { label: 'TikTok Shop', channel: 'tiktok_shop' },
  // Sources that never reach this system automatically. They are listed so the one table
  // describes the whole convention, and so a manual invoice can be looked up here.
  CS: { label: 'Consignment', channel: null },
  LB: { label: 'La Brisa', channel: null },
  DP: { label: 'WhatsApp / direct sales', channel: null },
  DW: { label: 'Walk-in', channel: null },
  WS: { label: 'Wholesale', channel: null },
  // Shopify splits by how the buyer paid.
  WA: { label: 'Shopify via Xendit', channel: 'shopify' },
  WX: { label: 'Shopify Payments', channel: 'shopify' },
};

const BY_CHANNEL = { shopee: 'SP', tokopedia: 'TP', tiktok_shop: 'TT', shopify: 'SHF' };

/**
 * The sources that never arrive over an API.
 *
 * A consignment shop, a walk-in, a WhatsApp order - none of these has a marketplace to
 * push them, so they are typed in. They still become the same kind of invoice as an
 * online sale, which is the whole point: one set of books, not two.
 */
export const MANUAL_SOURCES = ['CS', 'LB', 'DP', 'DW', 'WS'];

export const isManualSource = (prefix) => MANUAL_SOURCES.includes(prefix);

/**
 * Which gateway paid for a Shopify order.
 *
 * Matched on a pattern rather than an exact string because Shopify reports the gateway
 * by its display name, which the merchant can rename - the live shop currently says
 * "Xendit Payment Gateway (New)", and the "(New)" is exactly the kind of thing that
 * changes without warning. An order can also list several gateways; the first one we
 * recognise wins, and an unrecognised list is not a guess, it is SHF.
 */
export const GATEWAY_PREFIXES = [
  [/xendit/i, 'WA'],
  [/shopify[\s_-]*payments/i, 'WX'],
];

export function shopifyPrefix(gateways = []) {
  for (const name of gateways) {
    for (const [pattern, prefix] of GATEWAY_PREFIXES) {
      if (pattern.test(String(name))) return prefix;
    }
  }
  return 'SHF';
}

/** The prefix for an order, from its channel and - for Shopify - how it was paid. */
export function orderPrefix(order) {
  // A typed-in transaction already carries its prefix inside its code, chosen by the
  // person entering it. Nothing about it is detected, so nothing about it can drift.
  if (order.channel === 'manual') return String(order.id ?? '').split('-')[0] || 'SHF';
  if (order.channel === 'shopify') return shopifyPrefix(order.gateways ?? []);
  return BY_CHANNEL[order.channel] ?? 'SHF';
}

/**
 * The order code as the business writes it.
 *
 * Shopify's own name already starts with a #, which would read as SHF-#10848; the hash
 * carries no information once the prefix says where the order came from, so it goes.
 */
export function orderCode(order) {
  if (order.channel === 'manual') return String(order.id ?? '');
  const bare = String(order.id ?? '').replace(/^#/, '');
  return `${orderPrefix(order)}-${bare}`;
}
