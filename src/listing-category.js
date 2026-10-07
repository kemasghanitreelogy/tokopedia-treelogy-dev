import { callApi } from './client.js';
import { loadConfig } from './config.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi } from './shopee/client.js';

/**
 * Category and attributes for a new listing, chosen from the product itself.
 *
 * Both marketplaces recommend a category from a title, and publish the attributes each
 * leaf category takes with their allowed values. Read-only calls, checked against the
 * official schemas and the live shops on 7 Oct 2026:
 *   Shopee  v2.product.category_recommend (item_name) -> category_id[]
 *           v2.product.get_category (the tree, for names)
 *           v2.product.get_attribute_tree (category_id_list - the sample's
 *             `category_ids` is refused with "CategoryIdList is required")
 *   TikTok  POST /product/202309/categories/recommend (product_title, category_version v2)
 *           GET  /product/202309/categories/{id}/attributes
 *
 * Attributes come back in one shape for the form, whichever channel:
 *   { id, name, required, multiple, custom, input: 'select'|'text', values: [{id, name}], units }
 */

const HOUR = 3600_000;
const memo = new Map();
async function remember(key, ttl, read) {
  const hit = memo.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await read();
  memo.set(key, { value, until: Date.now() + ttl });
  return value;
}

/* ------------------------------------------------------------------------------ Shopee */

async function shopeeTree() {
  return remember('shopee:tree', 24 * HOUR, async () => {
    const { config, auth } = await resolveShopeeSession();
    const r = await callShopApi(config, '/api/v2/product/get_category', auth, { language: 'id' });
    return new Map((r.response?.category_list ?? []).map((c) => [c.category_id, c]));
  });
}

const shopeePath = (tree, id) => {
  const names = [];
  for (let c = tree.get(id), guard = 0; c && guard < 10; c = tree.get(c.parent_category_id), guard++) {
    names.unshift(c.display_category_name || c.original_category_name);
  }
  return names.join(' > ');
};

async function shopeeSuggest(title) {
  const { config, auth } = await resolveShopeeSession();
  const r = await callShopApi(config, '/api/v2/product/category_recommend', auth, { item_name: title.slice(0, 120) });
  const tree = await shopeeTree();
  return (r.response?.category_id ?? [])
    .filter((id) => tree.get(id) && !tree.get(id).has_children)
    .map((id) => ({ id: String(id), path: shopeePath(tree, id) }));
}

// Shopee names a value in several languages; Indonesian first, the default name otherwise.
const shopeeName = (node) => (node?.multi_lang ?? []).find((m) => /^id/i.test(m.language))?.value || node?.name || '';
const SHOPEE_INPUT = { 1: 'select', 2: 'select', 3: 'text', 4: 'select', 5: 'select' };

async function shopeeAttributes(categoryId) {
  return remember(`shopee:attr:${categoryId}`, 6 * HOUR, async () => {
    const { config, auth } = await resolveShopeeSession();
    const r = await callShopApi(config, '/api/v2/product/get_attribute_tree', auth, { category_id_list: String(categoryId), language: 'id' });
    const tree = r.response?.list?.[0]?.attribute_tree ?? [];
    return tree.map((a) => {
      const type = a.attribute_info?.input_type;
      return {
        id: String(a.attribute_id),
        name: shopeeName(a),
        required: Boolean(a.mandatory),
        multiple: type === 4 || type === 5,
        // A combo box takes a value of the seller's own beside the listed ones.
        custom: type === 2 || type === 3 || type === 5,
        input: SHOPEE_INPUT[type] ?? 'select',
        numeric: [1, 3].includes(a.attribute_info?.input_validation_type),
        units: a.attribute_info?.attribute_unit_list ?? [],
        max: a.attribute_info?.max_value_count ?? 0,
        values: (a.attribute_value_list ?? []).map((v) => ({ id: String(v.value_id), name: shopeeName(v) })),
      };
    });
  });
}

/* ---------------------------------------------------------------------- TikTok / Tokopedia */

async function tiktokSuggest(title) {
  const { data } = await callApi({ config: loadConfig(), method: 'POST', path: '/product/202309/categories/recommend', body: { product_title: title, category_version: 'v2' } });
  const chain = (data?.categories ?? []).slice().sort((a, b) => a.level - b.level);
  const leaf = data?.leaf_category_id;
  if (!leaf) return [];
  const usable = chain.find((c) => c.id === leaf)?.permission_statuses?.includes('AVAILABLE') ?? true;
  return usable ? [{ id: String(leaf), path: chain.map((c) => c.name).join(' > ') }] : [];
}

async function tiktokAttributes(categoryId) {
  return remember(`tiktok:attr:${categoryId}`, 6 * HOUR, async () => {
    const { data } = await callApi({ config: loadConfig(), path: `/product/202309/categories/${categoryId}/attributes`, query: { category_version: 'v2', locale: 'id-ID' } });
    // Only product properties: a sales property (colour, size) makes variants, and a new
    // listing here is always one SKU.
    return (data?.attributes ?? []).filter((a) => a.type === 'PRODUCT_PROPERTY').map((a) => ({
      id: String(a.id),
      name: a.name,
      // The schema spells it is_requried.
      required: Boolean(a.is_requried ?? a.is_required),
      multiple: Boolean(a.is_multiple_selection),
      custom: Boolean(a.is_customizable),
      input: (a.values ?? []).length ? 'select' : 'text',
      numeric: false,
      units: [],
      max: 0,
      values: (a.values ?? []).map((v) => ({ id: String(v.id), name: v.name })),
    }));
  });
}

/* -------------------------------------------------------------------------- one surface */

export async function suggestCategories(channel, title) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length < 3) return [];
  if (channel === 'shopee') return shopeeSuggest(clean);
  if (channel === 'tiktok') return tiktokSuggest(clean);
  throw new Error('kanal tidak didukung');
}

export async function categoryAttributes(channel, categoryId) {
  if (!/^\d{1,12}$/.test(String(categoryId ?? ''))) throw new Error('kategori tidak valid');
  if (channel === 'shopee') return shopeeAttributes(categoryId);
  if (channel === 'tiktok') return tiktokAttributes(categoryId);
  throw new Error('kanal tidak didukung');
}

/**
 * The attribute values a form sent, in the channel's own shape. Pure, so it is tested
 * without a shop. Fields: `attr:<id>` holds value ids (repeated for a multi-select) and
 * `attrtext:<id>` a value typed in; a value id of "0" or empty is ignored.
 *
 * Each value is checked against the attribute's published list: an id it does not list is
 * refused rather than sent, and a typed value only where the attribute takes one.
 */
export function attributesFromForm(channel, schema, read) {
  const out = [];
  const missing = [];
  for (const a of schema) {
    const ids = read(`attr:${a.id}`).map(String).filter((v) => v && v !== '0');
    const text = String(read(`attrtext:${a.id}`)[0] ?? '').trim().slice(0, 200);
    const unit = String(read(`attrunit:${a.id}`)[0] ?? '').trim();
    if (unit && !a.units.includes(unit)) throw new Error(`satuan ${a.name} tidak dikenal`);
    if (text && a.numeric && !/^\d+([.,]\d+)?$/.test(text)) throw new Error(`${a.name} harus angka`);
    const known = new Set(a.values.map((v) => v.id));
    for (const id of ids) if (!known.has(id)) throw new Error(`nilai atribut ${a.name} tidak dikenal`);
    if (text && !a.custom && a.input !== 'text') throw new Error(`atribut ${a.name} tidak menerima isian bebas`);
    const chosen = a.multiple ? ids : ids.slice(0, 1);
    if (!chosen.length && !text) { if (a.required) missing.push(a.name); continue; }
    if (channel === 'tiktok') {
      out.push({ id: a.id, values: [...chosen.map((id) => ({ id })), ...(text ? [{ name: text }] : [])] });
    } else {
      out.push({
        attribute_id: Number(a.id),
        attribute_value_list: [...chosen.map((id) => ({ value_id: Number(id) })), ...(text ? [{ value_id: 0, original_value_name: text.replace(',', '.'), ...(unit ? { value_unit: unit } : {}) }] : [])],
      });
    }
  }
  if (missing.length) throw new Error(`atribut wajib belum diisi: ${missing.join(', ')}`);
  return out;
}

/**
 * What a Treelogy listing says to the questions every category asks the same way, when
 * neither the example nor the operator has said: made in Indonesia, not imported. Matched
 * on the value names the channel publishes, never invented.
 */
export function houseDefaults(schema) {
  const out = {};
  for (const a of schema) {
    const pick = (re) => a.values.find((v) => re.test(v.name));
    let v = null;
    if (/asal|origin/i.test(a.name)) v = pick(/^indonesia$/i);
    else if (/impor|imported/i.test(a.name)) v = pick(/^(tidak|no|bukan)/i);
    if (v) out[a.id] = { ids: [v.id], text: '', unit: '' };
  }
  return out;
}
