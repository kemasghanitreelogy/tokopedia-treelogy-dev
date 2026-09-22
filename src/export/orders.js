import { CHANNELS, MANUAL_CHANNEL, STAGE_META, channelMeta } from '../omni.js';
import { findProduct, PRODUCTS } from '../master.js';
import { PREFIXES } from '../mekari/prefix.js';
import { zoneForChannel } from '../clock.js';
import { excelSerial, toCsv, toXlsx } from './sheet.js';

/**
 * Turning a range of orders into a file somebody can actually work in.
 *
 * Three shapes, because "export the orders" means three different questions depending on
 * who is asking. What sold is a product question and wants one row per SKU. What happened
 * is an order question and wants one row per sale. Reconciling either against a platform
 * report needs the line under the order, so that is the third.
 *
 * Money always comes from `finance.lines`, never from the order total divided up: the
 * total already has delivery and platform adjustments in it, and splitting it across
 * lines invents numbers that will not tie out against anything.
 */

/** Every channel a row can carry, in the order the dashboard shows them. */
export const EXPORT_CHANNELS = [...Object.values(CHANNELS), MANUAL_CHANNEL];
const CHANNEL_IDS = new Set(EXPORT_CHANNELS.map((c) => c.id));

/**
 * The catalogue as the dialog offers it.
 *
 * Grouped the way somebody thinks about the shelf rather than in catalogue order, and
 * labelled with the variant, because "Moringa Capsules" on its own is three products.
 */
export const EXPORT_PRODUCTS = PRODUCTS.map((product) => ({
  sku: product.sku,
  name: product.name,
  // One variant is written with an HTML entity in the master list; a checkbox label is
  // text, not markup, so it is spelled out here.
  variant: String(product.variant ?? '').replaceAll('&middot;', '\u00B7'),
  category: product.category,
}));
const PRODUCT_SKUS = new Set(EXPORT_PRODUCTS.map((p) => p.sku));

/** What each group of the shelf is called. */
export const PRODUCT_GROUPS = {
  powder: 'Powder', capsules: 'Capsules', oil: 'Seed Oil', set: 'Set', bundle: 'Bundle', gift: 'Gift',
};

export const DATASETS = {
  product: {
    id: 'product',
    label: 'Ringkasan produk',
    hint: 'Satu baris per produk: berapa terjual, dari berapa pesanan, berapa omzetnya.',
    sheet: 'Produk',
  },
  order: {
    id: 'order',
    label: 'Per pesanan',
    hint: 'Satu baris per pesanan, lengkap dengan pembeli, status, kurir dan resi.',
    sheet: 'Pesanan',
  },
  item: {
    id: 'item',
    label: 'Per item pesanan',
    hint: 'Satu baris per produk di tiap pesanan. Paling rinci, untuk rekonsiliasi.',
    sheet: 'Item',
  },
};
export const DEFAULT_DATASET = 'product';
export const FORMATS = { xlsx: 'xlsx', csv: 'csv' };

/** How a channel is named in the file. A typed-in sale says where it came from. */
export function channelLabel(order) {
  if (order.channel === MANUAL_CHANNEL.id) return PREFIXES[order.source]?.label ?? MANUAL_CHANNEL.label;
  return channelMeta(order.channel).label;
}

const stageLabel = (stage) => STAGE_META[stage]?.label ?? String(stage ?? '');

/**
 * The order's own clock, as a spreadsheet date.
 *
 * Shopee books in WIB and Shopify in Singapore time, and the dashboard shows each on its
 * own clock. A file that silently moved every Shopify sale an hour would be a file that
 * disagrees with the screen it was exported from.
 */
function stamp(order) {
  const zone = zoneForChannel(order.channel);
  const local = Number(order.createdAt || 0) + zone.offsetHours * 3600;
  const iso = new Date(local * 1000).toISOString();
  return { n: Number(excelSerial(local).toFixed(6)), s: `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}` };
}

/** Goods only, after the seller's own discounts - the same number the ledger books. */
const lineRevenue = (line) =>
  ((Number(line.unitPrice) || 0) - (Number(line.unitDiscount) || 0)) * (Number(line.qty) || 0);

/**
 * The priced lines of an order, falling back to the unpriced ones.
 *
 * `finance.lines` is the richer of the two and carries the money; `lines` is what the
 * packing bench sees. An order that somehow has only the latter still belongs in a
 * product count - it just contributes quantity and no revenue, which is honest.
 */
function linesOf(order) {
  const priced = order.finance?.lines;
  if (Array.isArray(priced) && priced.length > 0) return priced;
  return (order.lines ?? []).map((line) => ({ ...line, unitPrice: null, unitDiscount: 0 }));
}

/** The catalogue's name for a SKU, so the same product from three channels folds into one row. */
function identify(line) {
  const raw = String(line.sku ?? '').trim();
  const product = findProduct(raw);
  return {
    sku: product?.sku ?? raw ?? '',
    name: product?.name ?? String(line.name ?? ''),
    variant: product?.variant ?? String(line.variant ?? ''),
    category: product?.category ?? '',
    listed: raw,
  };
}

/* ----------------------------------------------------------------- datasets */

function productSheet(orders, channels, wanted = null) {
  // A column per channel only when there is more than one to compare; on a single-channel
  // export it would be the quantity column again under a different heading.
  const spread = channels.length > 1;
  const byProduct = new Map();

  for (const order of orders) {
    for (const line of linesOf(order)) {
      if (wanted && !wanted(line)) continue;
      const id = identify(line);
      const key = id.sku || id.name || '(tanpa sku)';
      const row = byProduct.get(key) ?? {
        sku: key, name: id.name, variant: id.variant, category: id.category,
        qty: 0, orders: new Set(), revenue: 0, discount: 0, priced: false, byChannel: {},
      };
      const qty = Number(line.qty) || 0;
      row.qty += qty;
      row.orders.add(`${order.channel}:${order.id}`);
      if (Number.isFinite(Number(line.unitPrice)) && line.unitPrice !== null) {
        row.priced = true;
        row.revenue += lineRevenue(line);
        row.discount += (Number(line.unitDiscount) || 0) * qty;
      }
      row.byChannel[order.channel] = (row.byChannel[order.channel] ?? 0) + qty;
      byProduct.set(key, row);
    }
  }

  const rows = [...byProduct.values()]
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty || a.sku.localeCompare(b.sku))
    .map((row) => ({
      sku: row.sku,
      name: row.name,
      variant: row.variant,
      category: row.category,
      qty: row.qty,
      orders: row.orders.size,
      revenue: row.priced ? Math.round(row.revenue) : null,
      discount: row.priced ? Math.round(row.discount) : null,
      perUnit: row.priced && row.qty > 0 ? Math.round(row.revenue / row.qty) : null,
      ...Object.fromEntries(channels.map((id) => [`ch_${id}`, row.byChannel[id] ?? 0])),
    }));

  const columns = [
    { key: 'sku', label: 'SKU', width: 22 },
    { key: 'name', label: 'Produk', width: 30 },
    { key: 'variant', label: 'Varian', width: 16 },
    { key: 'category', label: 'Kategori', width: 14 },
    { key: 'qty', label: 'Qty terjual', type: 'int', width: 13 },
    { key: 'orders', label: 'Jumlah pesanan', type: 'int', width: 15 },
    { key: 'revenue', label: 'Omzet', type: 'money', width: 16 },
    { key: 'discount', label: 'Diskon', type: 'money', width: 14 },
    { key: 'perUnit', label: 'Rata-rata / unit', type: 'money', width: 16 },
    ...(spread ? channels.map((id) => ({ key: `ch_${id}`, label: `Qty ${channelMeta(id).label}`, type: 'int', width: 15 })) : []),
  ];

  return { columns, rows };
}

function orderSheet(orders) {
  const rows = orders
    .slice()
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((order) => {
      const lines = linesOf(order);
      const goods = lines.reduce((n, line) => n + lineRevenue(line), 0);
      return {
        at: stamp(order),
        channel: channelLabel(order),
        id: String(order.id ?? ''),
        buyer: String(order.buyer ?? ''),
        phone: String(order.buyerPhone ?? ''),
        stage: stageLabel(order.stage),
        status: String(order.status ?? ''),
        carrier: String(order.carrier ?? ''),
        tracking: String(order.tracking ?? ''),
        units: lines.reduce((n, line) => n + (Number(line.qty) || 0), 0),
        skus: lines.length,
        goods: Math.round(goods),
        shipping: Math.round(Number(order.finance?.shipping) || 0),
        total: Math.round(Number(order.total) || 0),
        shipTo: String(order.shipTo ?? ''),
      };
    });

  const columns = [
    { key: 'at', label: 'Waktu', type: 'date', width: 18 },
    { key: 'channel', label: 'Kanal', width: 20 },
    { key: 'id', label: 'Order ID', width: 24 },
    { key: 'buyer', label: 'Pembeli', width: 24 },
    { key: 'phone', label: 'Telepon', width: 16 },
    { key: 'stage', label: 'Status', width: 14 },
    { key: 'status', label: 'Status platform', width: 20 },
    { key: 'carrier', label: 'Kurir', width: 20 },
    { key: 'tracking', label: 'Resi', width: 22 },
    { key: 'units', label: 'Unit', type: 'int', width: 9 },
    { key: 'skus', label: 'Jenis produk', type: 'int', width: 13 },
    { key: 'goods', label: 'Nilai barang', type: 'money', width: 16 },
    { key: 'shipping', label: 'Ongkir', type: 'money', width: 13 },
    { key: 'total', label: 'Total', type: 'money', width: 16 },
    { key: 'shipTo', label: 'Alamat', width: 44 },
  ];

  return { columns, rows };
}

function itemSheet(orders, wanted = null) {
  const rows = [];
  for (const order of orders.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))) {
    const at = stamp(order);
    const channel = channelLabel(order);
    for (const line of linesOf(order)) {
      if (wanted && !wanted(line)) continue;
      const id = identify(line);
      const qty = Number(line.qty) || 0;
      const priced = line.unitPrice !== null && Number.isFinite(Number(line.unitPrice));
      rows.push({
        at,
        channel,
        id: String(order.id ?? ''),
        stage: stageLabel(order.stage),
        sku: id.sku,
        listed: id.listed !== id.sku ? id.listed : '',
        name: id.name,
        variant: id.variant,
        qty,
        unitPrice: priced ? Math.round(Number(line.unitPrice)) : null,
        unitDiscount: priced ? Math.round(Number(line.unitDiscount) || 0) : null,
        revenue: priced ? Math.round(lineRevenue(line)) : null,
        buyer: String(order.buyer ?? ''),
      });
    }
  }

  const columns = [
    { key: 'at', label: 'Waktu', type: 'date', width: 18 },
    { key: 'channel', label: 'Kanal', width: 20 },
    { key: 'id', label: 'Order ID', width: 24 },
    { key: 'stage', label: 'Status', width: 14 },
    { key: 'sku', label: 'SKU', width: 22 },
    { key: 'listed', label: 'SKU di listing', width: 22 },
    { key: 'name', label: 'Produk', width: 30 },
    { key: 'variant', label: 'Varian', width: 16 },
    { key: 'qty', label: 'Qty', type: 'int', width: 9 },
    { key: 'unitPrice', label: 'Harga satuan', type: 'money', width: 16 },
    { key: 'unitDiscount', label: 'Diskon satuan', type: 'money', width: 16 },
    { key: 'revenue', label: 'Nilai baris', type: 'money', width: 16 },
    { key: 'buyer', label: 'Pembeli', width: 24 },
  ];

  return { columns, rows };
}

/* -------------------------------------------------------------------- build */

/** Only the channels that were asked for, and only ones that exist. */
export function resolveChannels(wanted) {
  const asked = (Array.isArray(wanted) ? wanted : [wanted])
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim())
    .filter((value) => CHANNEL_IDS.has(value));
  // Nothing chosen means everything, which is what an operator who just wants the file
  // expects - not an empty spreadsheet.
  return asked.length > 0 ? EXPORT_CHANNELS.map((c) => c.id).filter((id) => asked.includes(id)) : EXPORT_CHANNELS.map((c) => c.id);
}

/**
 * Which products were asked for, or null for all of them.
 *
 * Null rather than "every SKU in the catalogue" on purpose: a product nobody has listed
 * yet still sells, and a filter built from the catalogue would silently drop it. Asking
 * for everything has to mean everything, including what the catalogue has not heard of.
 */
export function resolveProducts(wanted) {
  const asked = (Array.isArray(wanted) ? wanted : [wanted])
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim())
    .filter((value) => PRODUCT_SKUS.has(value));
  if (asked.length === 0 || asked.length === PRODUCT_SKUS.size) return null;
  return new Set(asked);
}

/**
 * The sheet for one request. `orders` is already the range's worth; this only decides
 * shape, and which channels and products survive.
 *
 * A product filter selects which orders appear, never what an order is worth: a row in
 * the per-order sheet is the sale, and quietly reporting part of one as the whole would
 * be a number that reconciles against nothing.
 */
export function buildExport({ orders, dataset = DEFAULT_DATASET, channels, products, range }) {
  const chosen = resolveChannels(channels);
  const set = new Set(chosen);
  const keep = resolveProducts(products);
  const wanted = keep ? (line) => keep.has(identify(line).sku) : null;

  let rows = (orders ?? []).filter((order) => set.has(order.channel));
  if (wanted) rows = rows.filter((order) => linesOf(order).some(wanted));
  const spec = DATASETS[dataset] ?? DATASETS[DEFAULT_DATASET];

  const built = spec.id === 'order' ? orderSheet(rows)
    : spec.id === 'item' ? itemSheet(rows, wanted)
      : productSheet(rows, chosen, wanted);

  return {
    name: spec.sheet,
    dataset: spec.id,
    channels: chosen,
    products: keep ? [...keep] : null,
    orderCount: rows.length,
    range: range ?? null,
    ...built,
  };
}

/** A name that says what is inside without being opened. */
export function exportFilename(sheet, format, range) {
  const span = range?.from && range?.to
    ? (range.from === range.to ? range.from : `${range.from}_${range.to}`)
    : new Date().toISOString().slice(0, 10);
  return `treelogy-${sheet.dataset}-${span}.${format === 'csv' ? 'csv' : 'xlsx'}`;
}

export function renderExport(sheet, format) {
  if (format === 'csv') {
    return { body: Buffer.from(toCsv(sheet), 'utf8'), type: 'text/csv; charset=utf-8' };
  }
  return {
    body: toXlsx(sheet),
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}
