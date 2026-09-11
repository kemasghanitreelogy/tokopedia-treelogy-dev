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

/** Payment terms per source, in days. Consignment settles a week earlier than the rest. */
export const DEFAULT_TERM_DAYS = 14;

export const PREFIXES = {
  SP: { label: 'Shopee', channel: 'shopee', termDays: 14 },
  SHF: { label: 'Shopify', channel: 'shopify', termDays: 14 },
  TP: { label: 'Tokopedia', channel: 'tokopedia', termDays: 14 },
  TT: { label: 'TikTok Shop', channel: 'tiktok_shop', termDays: 14 },
  // Sources that never reach this system automatically. They are listed so the one table
  // describes the whole convention, and so a manual invoice can be looked up here.
  CS: { label: 'Consignment', channel: null, termDays: 7 },
  LB: { label: 'La Brisa', channel: null, termDays: 14 },
  DP: { label: 'WhatsApp / direct sales', channel: null, termDays: 14 },
  DW: { label: 'Walk-in', channel: null, termDays: 14 },
  WS: { label: 'Wholesale', channel: null, termDays: 14 },
  // Shopify splits by how the buyer paid.
  WA: { label: 'Shopify via Xendit', channel: 'shopify', termDays: 14 },
  WX: { label: 'Shopify Payments', channel: 'shopify', termDays: 14 },
};

const BY_CHANNEL = { shopee: 'SP', tokopedia: 'TP', tiktok_shop: 'TT', shopify: 'SHF' };

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
  const bare = String(order.id ?? '').replace(/^#/, '');
  return `${orderPrefix(order)}-${bare}`;
}

/** Payment term in days for an order's source. */
export const termDaysFor = (order) => PREFIXES[orderPrefix(order)]?.termDays ?? DEFAULT_TERM_DAYS;
