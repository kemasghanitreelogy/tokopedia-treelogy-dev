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
export const PRODUCTS = [
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
  { sku: 'MRS-001', name: 'Moringa Ritual Set', variant: 'tanpa powder', category: 'set', aliases: ['MRS'] },
  { sku: 'Bamboo-Scoop', name: 'Bamboo Scoop', category: 'set', aliases: ['Bamboo Scoop'] },
  { sku: 'Bamboo-Whisk', name: 'Bamboo Whisk', variant: '120 prongs', category: 'set', aliases: ['Bamboo Whisk - 120 prongs'] },
  { sku: 'The-Inside-&-Out30', name: 'Inside Out Moringa Protocol', variant: '30 hari', category: 'set' },
  { sku: 'The-Inside-&-Out60', name: 'Inside Out Moringa Protocol', variant: '60 hari', category: 'set' },
  // Named from its SKU: it sold 33 times in the last 30 days but is no longer listed on
  // any channel, so the only description of it left is the code itself. Its orders carried
  // the parent listing's title ("Inside Out Moringa Protocol"), which would make it
  // indistinguishable from the 30- and 60-day entries above.
  { sku: 'The-Movement-&-Relief', name: 'The Movement & Relief', category: 'set', aliases: ['The Movement & Relief', 'The-Movement-Relief'] },
  { sku: 'The-Discovery-Pack', name: 'The Discovery Pack', variant: 'listing Shopee', category: 'set', aliases: ['The Discovery Pack'] },

  // --- Free gift
  { sku: 'Travel-Pouch', name: 'Travel Pouch', category: 'gift', gift: true, aliases: ['GFT-POUCH-001'] },
  { sku: 'Mystery-Gift', name: 'Mystery Gift', category: 'gift', gift: true, aliases: ['GFT-MYST-001'] },
  { sku: '1736924837905663963', name: 'Bamboo Scoop (free gift)', category: 'gift', gift: true },

  // --- Bundle: a recipe, so availability can be derived from the parts
  {
    sku: 'Discovery-Pack', name: 'The Discovery Pack', category: 'bundle',
    components: [
      { sku: 'OMP-45-001', qty: 1 },
      { sku: 'OMO-30-001', qty: 1 },
      { sku: 'OMC-90-001', qty: 1 },
    ],
  },
  {
    sku: 'MRS-002', name: 'Moringa Ritual Set + Powder', variant: '45 gram &middot; Starter', category: 'bundle',
    aliases: ['MRS45'],
    components: [{ sku: 'MRS-001', qty: 1 }, { sku: 'OMP-45-001', qty: 1 }],
  },
  {
    sku: 'MRS-003', name: 'Moringa Ritual Set + Powder', variant: '90 gram &middot; Daily Wellness', category: 'bundle',
    aliases: ['MRS90'],
    components: [{ sku: 'MRS-001', qty: 1 }, { sku: 'OMP-90-001', qty: 1 }],
  },
  {
    sku: 'MRS-004', name: 'Moringa Ritual Set + Powder', variant: '180 gram &middot; Complete', category: 'bundle',
    aliases: ['MRS180'],
    components: [{ sku: 'MRS-001', qty: 1 }, { sku: 'OMP-180-001', qty: 1 }],
  },
  {
    sku: 'Inside-Out-Protocol', aliases: ['The-IO30-Protocol90+30'], name: 'Inside Out Protocol', category: 'bundle',
    components: [{ sku: 'OMC-90-001', qty: 1 }, { sku: 'OMO-30-001', qty: 1 }],
  },
  {
    sku: 'Inside-Out-60-Protocol180+30', aliases: ['The-IO60-Protocol180+30'], name: 'Inside Out Protocol 60 Days',
    variant: 'Caps 180 + Oil 30ml', category: 'bundle',
    components: [{ sku: 'OMC-180-001', qty: 1 }, { sku: 'OMO-30-001', qty: 1 }],
  },
  {
    sku: 'The-Inside-&-Out180+30', name: 'Inside Out Protocol 60 Days',
    variant: 'Oil 60ml + Caps 180', category: 'bundle',
    components: [{ sku: 'OMO-60-001', qty: 1 }, { sku: 'OMC-180-001', qty: 1 }],
  },
];

const BY_SKU = new Map();
for (const product of PRODUCTS) {
  BY_SKU.set(product.sku, product);
  for (const alias of product.aliases ?? []) BY_SKU.set(alias, product);
}

export const findProduct = (sku) => BY_SKU.get(sku) ?? null;
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
