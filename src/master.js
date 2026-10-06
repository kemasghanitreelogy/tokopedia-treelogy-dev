/**
 * The seller's own product catalogue: the names, groupings and bundle recipes that the
 * marketplaces do not know about.
 *
 * A channel listing only knows its own SKU. This file is what turns twenty-odd unrelated
 * listings back into "Moringa Powder, three sizes" and, crucially, records what a bundle
 * is made of - without which a bundle's real availability cannot be known.
 */

export const CATEGORIES = {
  powder: 'Moringa Powder',
  capsules: 'Moringa Capsules',
  oil: 'Moringa Seed Oil',
  set: 'Set & Aksesori',
  bundle: 'Bundle & Protocol',
  gift: 'Free Gift / Merchandise',
};

/**
 * @typedef {object} MasterProduct
 * @property {string} sku          the SKU as listed on the channels
 * @property {string} name
 * @property {keyof CATEGORIES} category
 * @property {string} [variant]    the size or count that distinguishes it in its group
 * @property {string[]} [aliases]  other SKUs the seller uses for the same product
 * @property {{sku: string, qty: number}[]} [components]  what a bundle is assembled from
 * @property {boolean} [gift]      given away, never sold on its own
 * @property {string} [family]     the product a card is grouped under on the products page,
 *   when its own name says more than that (the three Inside Out protocols); defaults to name
 */

/** @type {MasterProduct[]} */
/**
 * SKU aliases: the same product, spelled differently by each channel.
 *
 * TikTok Shop drops the -001 suffix (OMC90), sometimes the dashes too, and for orders
 * placed before a seller SKU was set it reports the numeric sku_id instead. Shopify
 * occasionally carries the listing title where a SKU should be. Every one of those is the
 * same jar, and without these 8,980 units - 35% of everything ever sold - counted as
 * products nobody has heard of and vanished from the forecast.
 *
 * The numeric ids were resolved by looking each one up in the live TikTok catalogue, not
 * inferred. FREE-OMC-* map to the ordinary capsules because a free one consumes the same
 * stock as a sold one. What stays unmapped is what genuinely cannot be decided from the
 * data - GIFT-OMC90/OMC180 is either one, and 'Inside Out  Moringa Protocol' does not say
 * which protocol - and those remain visible as unknown rather than guessed.
 */
const BASE_PRODUCTS = [
  // --- Moringa Powder
  { sku: 'OMP-45-001', name: 'Moringa Powder', variant: '45 gram', category: 'powder', aliases: ['OMP45', '1731010082174765019'] },
  { sku: 'OMP-90-001', name: 'Moringa Powder', variant: '90 gram', category: 'powder', aliases: ['OMP90', '1729838939428915163'] },
  { sku: 'OMP-180-001', name: 'Moringa Powder', variant: '180 gram', category: 'powder', aliases: ['OMP180', '1729838939428849627'] },

  // --- Moringa Capsules
  { sku: 'OMC-90-001', name: 'Moringa Capsules', variant: '90 caps', category: 'capsules', aliases: ['OMC90', 'OMC-90', 'FREE-OMC-90-001', '1731010208236603355'] },
  { sku: 'OMC-180-001', name: 'Moringa Capsules', variant: '180 caps', category: 'capsules', aliases: ['OMC180', 'OMC-180', 'FREE-OMC-180-001', '1731010208236668891'] },
  { sku: 'OMC-270-001', name: 'Moringa Capsules', variant: '270 caps', category: 'capsules' },

  // --- Moringa Seed Oil
  { sku: 'OMO-30-001', name: 'Moringa Seed Oil', variant: '30 ml', category: 'oil', aliases: ['OMO30', '1731010063360821211'] },
  { sku: 'OMO-60-001', name: 'Moringa Seed Oil', variant: '60 ml', category: 'oil', aliases: ['OMO60', '1731010063360886747'] },

  // --- Set & aksesori
  // 1736924837905663963 is TikTok's sku_id for the scoop it gives away: the same scoop off
  // the same shelf, so like FREE-OMC-* it is this product, not a product of its own.
  { sku: 'Bamboo-Scoop', name: 'Bamboo Scoop', category: 'set', aliases: ['Bamboo Scoop', '47115609438', '1736924837905663963'] },
  { sku: 'Bamboo-Whisk', name: 'Bamboo Whisk', variant: '120 prongs', category: 'set', aliases: ['Bamboo Whisk - 120 prongs'] },
  // Named from its SKU: it sold 33 times in the last 30 days but is no longer listed on
  // any channel, so the only description of it left is the code itself. Its orders carried
  // the parent listing's title ("Inside Out Moringa Protocol"), which would make it
  // indistinguishable from the 30- and 60-day entries above.
  { sku: 'The-Movement-&-Relief', name: 'The Movement & Relief', category: 'set', aliases: ['The Movement & Relief', 'The-Movement-Relief'] },

  // --- Free gift
  { sku: 'Travel-Pouch', name: 'Travel Pouch', category: 'gift', gift: true, aliases: ['GFT-POUCH-001', 'Travel Pouch'] },
  // The 3 ml seed oil given with an order. Shopify sells it as GFT-MYST-001 "Moringa Seed
  // Oil 3ml"; Shopee lists it as Oil-3ml, "(FREE GIFT - DO NOT ORDER) Treelogy Gift with
  // Purchase / Seed Oil 3ml", priced at Rp1.000.000 and discounted by exactly that, so it
  // costs the buyer nothing (ten Shopee invoices from 18 to 25 September were refused for
  // want of that line). One bottle, one card: Tokopedia's Mystery Gift and Shopee's
  // Oil-3ml carried the same 195 in stock.
  // Named for what it is. "Mystery Gift" is kept as an alias for the listings and old
  // orders that still say it; one name, no variant, so the stock tab does not fold the
  // free 3 ml into the 30 and 60 ml it sells.
  { sku: 'Mystery-Gift', name: 'Moringa Seed Oil 3 ml', category: 'gift', gift: true, aliases: ['GFT-MYST-001', 'Mystery Gift', 'Oil-3ml'] },

  // --- Bundle: a recipe, so availability can be derived from the parts
  /*
   * Three cards that were one product each, folded onto it.
   *
   * The-Inside-&-Out30 and -60 are Shopee's spelling of the two protocols, read off the
   * listings themselves: "Bundling Paket 30 Hari: 90 capsules + 30 ml Oil" and "60 Hari:
   * 180 capsules + 30 ml Oil" - the same contents as Inside-Out-Protocol and
   * Inside-Out-60-Protocol180+30, which TikTok (The-IO30/IO60) and Shopify already sell,
   * with the same stock on both. The-Discovery-Pack was a Shopee listing of the Discovery
   * Pack and is live nowhere now. Kept apart, each sat on the products page as a card
   * with no picture and a stock figure for one channel only, and its sales counted as a
   * product of their own. Jurnal already holds the master codes these now post under.
   */
  {
    sku: 'Discovery-Pack', name: 'The Discovery Pack', category: 'bundle',
    aliases: ['The-Discovery-Pack', 'The Discovery Pack'],
    components: [
      { sku: 'OMP-45-001', qty: 1 },
      { sku: 'OMO-30-001', qty: 1 },
      { sku: 'OMC-90-001', qty: 1 },
    ],
  },
  // Shopify spells these three MRS-002+45gr, MRS-003+90gr and MRS-004+180gr - variants of
  // its "Moringa Ritual Set" product - and until they were aliased here they matched
  // nothing, so the Ritual Set bundles showed no Shopify stock and were never synced to it.
  // The set on its own sits with the three that add powder to it: one Shopify product with
  // four variants, so one family on the products and stock pages.
  { sku: 'MRS-001', name: 'Moringa Ritual Set', variant: 'tanpa powder', family: 'Moringa Ritual Set', category: 'bundle', aliases: ['MRS', 'Ritual-Set'] },
  {
    sku: 'MRS-002', name: 'Moringa Ritual Set + Powder', variant: '45 gram · Starter', family: 'Moringa Ritual Set', category: 'bundle',
    aliases: ['MRS45', 'MRS-002+45', 'MRS-002+45gr'],
    components: [{ sku: 'MRS-001', qty: 1 }, { sku: 'OMP-45-001', qty: 1 }],
  },
  {
    sku: 'MRS-003', name: 'Moringa Ritual Set + Powder', variant: '90 gram · Daily Wellness', family: 'Moringa Ritual Set', category: 'bundle',
    aliases: ['MRS90', 'MRS-003+90', 'MRS-003+90gr'],
    components: [{ sku: 'MRS-001', qty: 1 }, { sku: 'OMP-90-001', qty: 1 }],
  },
  {
    sku: 'MRS-004', name: 'Moringa Ritual Set + Powder', variant: '180 gram · Complete', family: 'Moringa Ritual Set', category: 'bundle',
    aliases: ['MRS180', 'MRS-004+180', 'MRS-004+180gr'],
    components: [{ sku: 'MRS-001', qty: 1 }, { sku: 'OMP-180-001', qty: 1 }],
  },
  {
    sku: 'Inside-Out-Protocol', aliases: ['The-IO30-Protocol90+30', 'The-Inside-&-Out30'], name: 'Inside Out Protocol', family: 'Inside Out Protocol', category: 'bundle',
    components: [{ sku: 'OMC-90-001', qty: 1 }, { sku: 'OMO-30-001', qty: 1 }],
  },
  {
    sku: 'Inside-Out-60-Protocol180+30', aliases: ['The-IO60-Protocol180+30', 'The-Inside-&-Out60'], name: 'Inside Out Protocol 60 Days',
    family: 'Inside Out Protocol', variant: 'Caps 180 + Oil 30ml', category: 'bundle',
    components: [{ sku: 'OMC-180-001', qty: 1 }, { sku: 'OMO-30-001', qty: 1 }],
  },
  {
    sku: 'The-Inside-&-Out180+30', name: 'Inside Out Protocol 60 Days',
    family: 'Inside Out Protocol', variant: 'Oil 60ml + Caps 180', category: 'bundle',
    components: [{ sku: 'OMO-60-001', qty: 1 }, { sku: 'OMC-180-001', qty: 1 }],
  },
];

/*
 * The list above is the base; the dashboard keeps changes to it in the state store
 * (src/master-store.js) and they are laid over it here.
 *
 * An entry for a SKU above replaces the fields it names; an entry for a new SKU adds a
 * product; a SKU listed as removed leaves the catalogue the screens offer - the products
 * page, the manual form, the export, the forecast - but is still found by its spelling.
 * Old orders still name it, and an invoice for one must still find its Jurnal code.
 *
 * PRODUCTS is a live binding: reassigned when the overlay changes, so every module that
 * imports it reads the current list. Anything that builds its own copy at load time
 * subscribes with onMasterChange and rebuilds.
 */
export let PRODUCTS = BASE_PRODUCTS;
let BY_SKU = new Map();
let REMOVED = new Set();
const listeners = new Set();

function index(products) {
  const map = new Map();
  for (const product of products) {
    map.set(product.sku, product);
    for (const alias of product.aliases ?? []) map.set(alias, product);
  }
  return map;
}

/**
 * Lay the stored changes over the base list.
 *
 * @param {{products?: Record<string, object>, removed?: string[]}|null} overlay
 */
export function applyMasterOverlay(overlay) {
  const changes = overlay?.products ?? {};
  const removed = new Set(overlay?.removed ?? []);
  const merged = BASE_PRODUCTS.map((p) => (changes[p.sku] ? { ...p, ...changes[p.sku], sku: p.sku, custom: true } : p));
  for (const [sku, entry] of Object.entries(changes)) {
    if (!BASE_PRODUCTS.some((p) => p.sku === sku)) merged.push({ ...entry, sku, custom: true, added: true });
  }
  // Removed products still resolve: the index is built from everything.
  BY_SKU = index(merged);
  REMOVED = removed;
  PRODUCTS = merged.filter((p) => !removed.has(p.sku));
  for (const fn of listeners) fn(PRODUCTS);
}

/** Call fn whenever the catalogue changes. Returns the unsubscribe. */
export function onMasterChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Every product, removed ones included - for the page that lets one be restored. */
export const allProducts = () => [...new Set(BY_SKU.values())];
export const isRemoved = (sku) => REMOVED.has(sku);
export const isBaseProduct = (sku) => BASE_PRODUCTS.some((p) => p.sku === sku);

applyMasterOverlay(null);

export const findProduct = (sku) => BY_SKU.get(sku) ?? null;
/** What a product is grouped under for display: its family, or its own name. */
export const familyOf = (product) => product?.family ?? product?.name ?? '';
export const isBundle = (product) => Array.isArray(product?.components) && product.components.length > 0;

/**
 * How many of a bundle the components can actually make.
 *
 * A bundle's own listing quantity is a number someone typed; this is what the shelf can
 * really produce. Where the two disagree, the listing is overselling.
 */
export function buildableFrom(product, stockOf) {
  if (!isBundle(product)) return null;

  let limit = Infinity;
  const parts = product.components.map((component) => {
    const available = stockOf(component.sku);
    const possible = available === null ? null : Math.floor(available / component.qty);
    if (possible !== null) limit = Math.min(limit, possible);
    return { ...component, available, possible };
  });

  // A component we cannot see makes the whole answer a guess, so say so rather than
  // quietly reporting a number derived from the parts we happen to know.
  const unknown = parts.some((p) => p.available === null);
  return { parts, buildable: unknown || limit === Infinity ? null : limit, unknown };
}

/** Master products grouped for display, in the order the categories are declared. */
export function groupProducts(products = PRODUCTS) {
  return Object.keys(CATEGORIES)
    .map((key) => ({ key, label: CATEGORIES[key], items: products.filter((p) => p.category === key) }))
    .filter((group) => group.items.length > 0);
}

/** Channel SKUs with no master entry - drift the operator should know about. */
export function unmapped(catalogSkus) {
  return catalogSkus.filter((entry) => !BY_SKU.has(entry.sku));
}
