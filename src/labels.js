import { PDFDocument } from 'pdf-lib';
import { buildShopifyLabels, reservePickNumbers } from './shopify/label.js';
import { loadConfig } from './config.js';
import { callApi } from './client.js';
import { resolveShopeeSession } from './shopee/session.js';
import { callShopApi } from './shopee/client.js';
import { buildShopUrl } from './shopee/sign.js';

/**
 * Official carrier waybills, fetched from each platform and merged into one print job.
 *
 * The labels themselves are never generated here: a courier only accepts the barcode the
 * platform issued, so this module fetches the real documents and does nothing to their
 * content. What it does own is the packaging - batching, failure isolation, and resizing
 * every page to the exact media the thermal printer expects.
 */

/** Thermal label stock, in PDF points (1pt = 1/72"). */
export const LABEL_SIZES = {
  '100x150': { label: '100 × 150 mm', width: 283.46, height: 425.20 },
  '100x100': { label: '100 × 100 mm', width: 283.46, height: 283.46 },
  a6: { label: 'A6 (105 × 148 mm)', width: 297.64, height: 419.53 },
};
export const DEFAULT_SIZE = '100x150';

const mm = (value) => (value / 72) * 25.4;

/* --------------------------------------------------------------- concurrency */

/**
 * Bounded parallelism that never rejects.
 *
 * A print run of fifty labels must not be lost because one order 404s, so every task
 * resolves to an outcome and the caller decides what to do with the failures.
 */
async function settleLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try {
          results[index] = { ok: true, value: await worker(items[index]) };
        } catch (error) {
          results[index] = { ok: false, error, item: items[index] };
        }
      }
    }),
  );
  return results;
}

const FETCH_CONCURRENCY = 6;
const DOWNLOAD_TIMEOUT_MS = 20000;

async function fetchBytes(url, init = {}) {
  // A hung CDN must not hold the whole request open until the platform times us out.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} saat mengunduh dokumen`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') {
      // The platforms answer errors with JSON at the same URL shape as a PDF.
      throw new Error(`bukan PDF: ${Buffer.from(bytes.slice(0, 120)).toString()}`);
    }
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------- TikTok */

/**
 * One document per package. `document_size` A6 is the thermal-friendly form; the API
 * refuses outright until shipping has been arranged, which is a real state, not an error
 * to retry.
 */
async function fetchTikTokLabels(orders, resolvePackages) {
  if (orders.length === 0) return { pages: [], failures: [] };
  const config = loadConfig();

  // Package ids are resolved inside this branch so the Shopee branch does not wait for
  // an order-detail round trip it has no use for.
  let resolved = orders;
  if (resolvePackages) {
    try {
      resolved = await resolvePackages(orders);
    } catch (error) {
      return { pages: [], failures: orders.map((o) => ({ id: o.id, channel: o.channel, reason: error.message })) };
    }
  }

  const outcomes = await settleLimit(resolved, FETCH_CONCURRENCY, async (order) => {
    if (!order.packageId) throw new Error('pesanan belum punya paket');
    const { data } = await callApi({
      config,
      method: 'GET',
      path: `/fulfillment/202309/packages/${order.packageId}/shipping_documents`,
      query: { document_type: 'SHIPPING_LABEL', document_size: 'A6' },
    });
    if (!data.doc_url) throw new Error('API tidak mengembalikan doc_url');
    return { order, bytes: await fetchBytes(data.doc_url) };
  });

  const pages = [];
  const failures = [];
  for (const outcome of outcomes) {
    if (outcome.ok) pages.push(outcome.value);
    else failures.push({ id: outcome.item.id, channel: outcome.item.channel, reason: outcome.error.message });
  }
  return { pages, failures };
}

/* ------------------------------------------------------------------- Shopee */

const READY_POLL_ATTEMPTS = 8;
// Backoff rather than a fixed wait: most documents are already generated, and the ones
// that are not benefit from a couple of quick retries before we start waiting properly.
const POLL_BACKOFF_MS = [250, 500, 900, 1400, 1800, 1800, 1800];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shopee is a three-step, asynchronous flow, and the final download is all-or-nothing:
 * a single not-yet-ready order makes the whole PDF request fail. So the result is polled
 * and filtered down to READY orders before anything is downloaded - otherwise one bad
 * order silently costs the operator the entire print run.
 */
async function fetchShopeeLabels(orders, documentType = 'THERMAL_AIR_WAYBILL') {
  if (orders.length === 0) return { pages: [], failures: [] };

  const { config, auth } = await resolveShopeeSession();
  const failures = [];
  const note = (sn, reason) => failures.push({ id: sn, channel: 'shopee', reason });

  const wanted = orders.map((o) => o.id);

  const askStatus = async (sns) => {
    try {
      const result = await callShopApi(config, '/api/v2/logistics/get_shipping_document_result', auth, {}, {
        order_list: sns.map((order_sn) => ({ order_sn })),
      });
      return result.response?.result_list ?? [];
    } catch (error) {
      return error.response?.result_list ?? [];
    }
  };

  const ready = new Set();
  const pending = new Set();

  // Ask before creating. A reprint - the common case - is then a single call, and only
  // the documents that genuinely do not exist yet pay for a create.
  const initial = await askStatus(wanted);
  const unknown = [];
  for (const sn of wanted) {
    const row = initial.find((r) => r.order_sn === sn);
    if (row?.status === 'READY') ready.add(sn);
    else unknown.push(sn);
  }

  if (unknown.length > 0 && process.env.TREELOGY_READONLY === '1') {
    // Creating a document commits a waybill at the courier, so read-only mode prints
    // only what already exists rather than bringing new documents into being.
    for (const sn of unknown) note(sn, 'READ-ONLY: dokumen belum dibuat, tidak dibuatkan');
  } else if (unknown.length > 0) {
    const orderList = unknown.map((order_sn) => ({ order_sn, shipping_document_type: documentType }));
    try {
      const created = await callShopApi(config, '/api/v2/logistics/create_shipping_document', auth, {}, { order_list: orderList });
      for (const row of created.response?.result_list ?? []) {
        if (row.fail_error) note(row.order_sn, row.fail_message || row.fail_error);
      }
    } catch (error) {
      for (const row of error.response?.result_list ?? []) {
        if (row.fail_error) note(row.order_sn, row.fail_message || row.fail_error);
      }
      if (!error.response?.result_list) {
        for (const sn of unknown) note(sn, error.message);
      }
    }
    for (const sn of unknown) {
      if (!failures.some((f) => f.id === sn)) pending.add(sn);
    }
  }

  for (let attempt = 0; attempt < READY_POLL_ATTEMPTS && pending.size > 0; attempt++) {
    const statuses = await askStatus([...pending]);
    if (statuses.length === 0) break;

    for (const row of statuses) {
      if (row.status === 'READY') {
        ready.add(row.order_sn);
        pending.delete(row.order_sn);
      } else if (row.fail_error) {
        note(row.order_sn, row.fail_message || row.fail_error);
        pending.delete(row.order_sn);
      }
    }
    if (pending.size > 0 && attempt < READY_POLL_ATTEMPTS - 1) {
      await sleep(POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)]);
    }
  }

  for (const sn of pending) note(sn, 'dokumen belum siap di kurir setelah menunggu');
  if (ready.size === 0) return { pages: [], failures };

  const readyList = [...ready];
  const downloaded = await downloadShopeeBatch(config, auth, readyList, documentType);
  return { pages: downloaded.pages, failures: [...failures, ...downloaded.failures] };
}

/** Shopee refuses to combine some packages in one document, and only says so on download. */
const CANNOT_COMBINE = 'packages_can_not_download_together';

/**
 * Download a group of waybills, splitting only as far as the platform forces.
 *
 * One request for the whole group is by far the fastest path and usually works. When
 * Shopee refuses the combination, the group is bisected and each half retried, so an
 * incompatible pair costs O(log n) extra requests instead of falling back to one call
 * per label. A group of one that still fails is a real per-order failure.
 */
async function downloadShopeeBatch(config, auth, orderSns, documentType, depth = 0) {
  if (orderSns.length === 0) return { pages: [], failures: [] };

  const url = buildShopUrl(config, '/api/v2/logistics/download_shipping_document', auth);
  const attempt = async (group) =>
    fetchBytes(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shipping_document_type: documentType,
        order_list: group.map((order_sn) => ({ order_sn })),
      }),
    });

  try {
    const bytes = await attempt(orderSns);
    return {
      pages: [{ order: { channel: 'shopee', id: orderSns.join(',') }, bytes, count: orderSns.length }],
      failures: [],
    };
  } catch (error) {
    const combinable = !error.message.includes(CANNOT_COMBINE);
    // Any other error on a single order is that order's own problem, not a grouping one.
    if (orderSns.length === 1 || (combinable && depth > 0)) {
      return { pages: [], failures: orderSns.map((id) => ({ id, channel: 'shopee', reason: error.message })) };
    }

    const middle = Math.ceil(orderSns.length / 2);
    const [left, right] = await Promise.all([
      downloadShopeeBatch(config, auth, orderSns.slice(0, middle), documentType, depth + 1),
      downloadShopeeBatch(config, auth, orderSns.slice(middle), documentType, depth + 1),
    ]);
    return { pages: [...left.pages, ...right.pages], failures: [...left.failures, ...right.failures] };
  }
}

/* -------------------------------------------------------------------- merge */

/**
 * Merge every fetched document into one PDF, each page scaled to fill the label stock.
 *
 * Thermal printers do not reflow content: a page even slightly larger than the media is
 * cropped or shifted. Normalising here means the print dialog can be left at 100% and
 * the barcode still lands inside the printable area.
 */
export async function mergeLabels(documents, sizeKey = DEFAULT_SIZE) {
  const size = LABEL_SIZES[sizeKey] ?? LABEL_SIZES[DEFAULT_SIZE];
  const merged = await PDFDocument.create();
  merged.setTitle('Label pengiriman');
  merged.setProducer('Treelogy omnichannel');

  let pageCount = 0;
  const failures = [];

  for (const doc of documents) {
    // Parsing AND embedding are both guarded: a page carrying no content stream throws
    // inside embedPages, which would otherwise abort the whole merge and lose every
    // label in the run, not just the damaged one.
    try {
      // Some carrier PDFs are generated with malformed xref tables; the platforms still
      // consider them valid, so parsing has to be tolerant rather than strict.
      const source = await PDFDocument.load(doc.bytes, { ignoreEncryption: true, throwOnInvalidObject: false });
      // pdf-lib defers the real embedding to save(), so a page that cannot be embedded
      // throws long after this try block has exited and takes the entire merge with it.
      // Pages without a content stream are therefore rejected up front, where the
      // failure can still be attributed to one document.
      const sourcePages = source.getPages().filter((page) => Boolean(page.node.Contents()));
      if (sourcePages.length === 0) throw new Error('dokumen tidak punya halaman yang bisa dicetak');

      const embedded = await merged.embedPages(sourcePages);
      for (const page of embedded) {
        const target = merged.addPage([size.width, size.height]);
        // Fit, never fill: cropping a waybill can cut the barcode and make it unscannable.
        const scale = Math.min(size.width / page.width, size.height / page.height);
        const width = page.width * scale;
        const height = page.height * scale;
        target.drawPage(page, {
          width,
          height,
          x: (size.width - width) / 2,
          y: (size.height - height) / 2,
        });
        pageCount += 1;
      }
    } catch (error) {
      failures.push({ id: doc.order.id, channel: doc.order.channel, reason: `PDF tidak terbaca: ${error.message}` });
    }
  }

  return { bytes: await merged.save(), pageCount, failures, size: sizeKey };
}

/* ------------------------------------------------------------------ public */

/** Orders whose label can meaningfully exist yet. */
export const PRINTABLE_STAGES = new Set(['to_ship', 'shipping']);

/**
 * What, if anything, this order needs from the label printer right now.
 *
 * Both platforms only issue a waybill inside a window, and the windows sit at opposite
 * ends of the journey - verified against the live shop by actually printing, status by
 * status, rather than inferred from names:
 *
 *   needsPrint   the document exists and the parcel is still ours to hand over. This is
 *                today's batch: TikTok AWAITING_COLLECTION, Shopee PROCESSED.
 *   reprint      the document still downloads but the courier already took the parcel.
 *                Reachable on purpose, never part of the default list.
 *   waiting      the order will need a label, but the courier has not issued one yet.
 *   arrange      shipping has not been arranged, so no document can exist at all.
 *   none         nothing to print, now or later.
 */
export function labelReadiness(order, printed = {}) {
  // Shopify issues no waybill - Shopify Shipping does not serve this shop, and the
  // courier is booked outside it - so the label is the packing sheet we draw ourselves.
  // Nothing on Shopify's side records that it was printed, so `printed` does.
  if (order.channel === 'shopify') {
    if (printed[order.id]) return { state: 'reprint', note: 'sudah dicetak' };
    if (order.stage === 'to_ship') return { state: 'needsPrint', note: 'siap dicetak' };
    return { state: 'none', note: 'sudah selesai, tidak perlu label' };
  }

  if (order.channel === 'shopee') {
    if (order.status === 'PROCESSED') return { state: 'needsPrint', note: 'siap dicetak' };
    if (['SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED'].includes(order.status)) {
      return { state: 'reprint', note: 'sudah diambil kurir' };
    }
    if (['READY_TO_SHIP', 'RETRY_SHIP'].includes(order.status)) {
      return { state: 'waiting', note: 'menunggu dokumen terbit di kurir' };
    }
    return { state: 'none', note: `status ${order.status} tidak bisa dicetak` };
  }

  if (order.status === 'AWAITING_COLLECTION') return { state: 'needsPrint', note: 'siap dicetak' };
  if (order.status === 'AWAITING_SHIPMENT') {
    return { state: 'arrange', note: 'atur pengiriman dulu di Seller Center' };
  }
  if (['IN_TRANSIT', 'DELIVERED', 'COMPLETED'].includes(order.status)) {
    return { state: 'reprint', note: 'sudah diambil kurir', unavailable: true };
  }
  return { state: 'none', note: `status ${order.status} tidak bisa dicetak` };
}

/** States whose document can actually be fetched. TikTok stops issuing after pickup. */
export const FETCHABLE = new Set(['needsPrint', 'reprint']);

/**
 * Fetch and merge labels for the given orders.
 *
 * Returns the PDF plus a per-order account of anything that could not be printed, so the
 * operator is never left guessing which parcel is missing a label.
 */
export async function buildLabelSheet({ orders, size = DEFAULT_SIZE, resolvePackages = null, resolveShopify = null }) {
  // An order with no stage has not been pre-checked; the platform decides, and it gives
  // a more precise reason than we could guess anyway.
  const printable = orders.filter((o) => !o.stage || PRINTABLE_STAGES.has(o.stage));
  const skipped = orders
    .filter((o) => o.stage && !PRINTABLE_STAGES.has(o.stage))
    .map((o) => ({ id: o.id, channel: o.channel, reason: `status ${o.status} tidak bisa dicetak` }));

  const tiktok = printable.filter((o) => o.channel !== 'shopee' && o.channel !== 'shopify');
  const shopee = printable.filter((o) => o.channel === 'shopee');
  const shopify = printable.filter((o) => o.channel === 'shopify');

  const [tiktokResult, shopeeResult, shopifyResult] = await Promise.all([
    fetchTikTokLabels(tiktok, resolvePackages).catch((error) => ({
      pages: [], failures: tiktok.map((o) => ({ id: o.id, channel: o.channel, reason: error.message })),
    })),
    fetchShopeeLabels(shopee).catch((error) => ({
      pages: [], failures: shopee.map((o) => ({ id: o.id, channel: o.channel, reason: error.message })),
    })),
    drawShopifyLabels(shopify, resolveShopify).catch((error) => ({
      pages: [], printed: [], failures: shopify.map((o) => ({ id: o.id, channel: o.channel, reason: error.message })),
    })),
  ]);

  const documents = [...tiktokResult.pages, ...shopeeResult.pages, ...shopifyResult.pages];
  if (documents.length === 0) {
    return {
      bytes: null,
      pageCount: 0,
      requested: orders.length,
      printed: [],
      failures: [...skipped, ...tiktokResult.failures, ...shopeeResult.failures, ...shopifyResult.failures],
      size,
    };
  }

  const merged = await mergeLabels(documents, size);
  return {
    bytes: merged.bytes,
    pageCount: merged.pageCount,
    requested: orders.length,
    // Which Shopify orders actually came out of the printer, for the print ledger.
    printed: shopifyResult.printed,
    failures: [...skipped, ...tiktokResult.failures, ...shopeeResult.failures, ...shopifyResult.failures, ...merged.failures],
    size,
  };
}

/**
 * Shopify labels are drawn from the order itself, so the only way to fail is to not have
 * the order. The selection carries ids; `resolveShopify` turns them into real orders, and
 * anything it cannot find is reported rather than silently dropped.
 */
async function drawShopifyLabels(selection, resolveShopify) {
  if (selection.length === 0) return { pages: [], printed: [], failures: [] };
  if (!resolveShopify) {
    return { pages: [], printed: [], failures: selection.map((o) => ({ id: o.id, channel: 'shopify', reason: 'data pesanan tidak tersedia' })) };
  }

  const full = await resolveShopify(selection);
  const byId = new Map(full.map((o) => [o.id, o]));
  const found = selection.filter((o) => byId.has(o.id));
  const failures = selection
    .filter((o) => !byId.has(o.id))
    .map((o) => ({ id: o.id, channel: 'shopify', reason: 'pesanan tidak ditemukan di Shopify' }));

  // Reserved together so a batch of ten gets ten consecutive numbers, and an abandoned
  // print leaves a gap rather than handing the next print the same number.
  const picks = await reservePickNumbers(found.length);
  try {
    // One document for the whole run: the fonts and the Shopify mark are embedded once
    // rather than once per parcel, which is most of what a hundred labels used to cost.
    const bytes = await buildShopifyLabels(found.map((row, index) => ({ order: byId.get(row.id), pick: picks[index] })));
    return {
      pages: [{ bytes, order: { id: found[0].id, channel: 'shopify' } }],
      printed: found.map((row) => row.id),
      failures,
    };
  } catch (error) {
    // Drawing is arithmetic on data we already hold, so a failure here is a bug rather
    // than a bad parcel - it is reported against all of them because it stopped all of them.
    return {
      pages: [],
      printed: [],
      failures: [...failures, ...found.map((row) => ({ id: row.id, channel: 'shopify', reason: error.message }))],
    };
  }
}

export const labelSizeMm = (sizeKey) => {
  const size = LABEL_SIZES[sizeKey] ?? LABEL_SIZES[DEFAULT_SIZE];
  return { width: Math.round(mm(size.width)), height: Math.round(mm(size.height)) };
};
