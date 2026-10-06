import { randomUUID } from 'node:crypto';
import { shopifyGraphql } from './client.js';
import { loadShopifyConfig } from './config.js';

/**
 * Adding stock to a Shopify variant.
 *
 * Shopify keeps stock per inventory item per location rather than as a number on the
 * variant, so a write needs both ids. They are looked up at write time instead of being
 * carried in the catalogue: the catalogue query only needs read_products, and asking it
 * for inventory levels would make the whole stock page fail on a token without
 * read_inventory. Validated against the Admin GraphQL schema before being written here.
 */

export const VARIANT_LEVELS_QUERY = `
query TreelogyVariantLevels($id: ID!) {
  productVariant(id: $id) {
    inventoryItem {
      id
      tracked
      inventoryLevels(first: 5) {
        nodes {
          location { id }
          quantities(names: ["available"]) { name quantity }
        }
      }
    }
  }
}`;

export const ADJUST_MUTATION = `
mutation TreelogyTopupShopify($input: InventoryAdjustQuantitiesInput!, $key: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
    inventoryAdjustmentGroup {
      changes { name delta quantityAfterChange }
    }
    userErrors { field message code }
  }
}`;

/**
 * Add `delta` to the variant's available stock at its one location, or bring it to `target`.
 *
 * More than one stocked location is refused rather than guessed at: which shelf the
 * extra hundred belongs on is not something this can know. `changeFromQuantity` makes
 * Shopify reject the write if the number moved between our read and our write, so a sale
 * landing in that second cannot turn one top-up into a wrong figure.
 */
export async function adjustVariantStock({ variantId, delta = null, target = null }, config = loadShopifyConfig()) {
  const data = await shopifyGraphql(VARIANT_LEVELS_QUERY, { id: variantId }, config);
  const item = data.productVariant?.inventoryItem;
  if (!item) throw new Error(`varian ${variantId} tidak ditemukan`);
  if (!item.tracked) throw new Error('stok varian ini tidak dilacak Shopify');

  const levels = item.inventoryLevels?.nodes ?? [];
  if (levels.length !== 1) throw new Error(`varian ada di ${levels.length} lokasi - tidak menebak lokasi mana`);

  const level = levels[0];
  const available = level.quantities.find((q) => q.name === 'available')?.quantity;
  if (typeof available !== 'number') throw new Error('jumlah available tidak terbaca');
  // A target becomes a delta against the figure just read. changeFromQuantity then makes
  // Shopify refuse it if a sale moves that figure between this read and the write.
  if (target !== null) delta = target - available;
  if (!delta) return { from: available, to: available };

  const result = await shopifyGraphql(ADJUST_MUTATION, {
    key: randomUUID(),
    input: {
      name: 'available',
      reason: 'correction',
      referenceDocumentUri: 'gid://treelogy/StockTopup/auto',
      changes: [{ inventoryItemId: item.id, locationId: level.location.id, delta, changeFromQuantity: available }],
    },
  }, config);

  const errors = result.inventoryAdjustQuantities?.userErrors ?? [];
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '));
  return { from: available, to: available + delta };
}
