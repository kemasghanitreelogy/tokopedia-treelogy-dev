import { fetchOrdersByIds } from '../src/omni.js';
import { ordersForPrinting } from '../src/orders-by-id.js';
import { markPrinted } from '../src/shopify/label.js';
import { buildLabelSheet, LABEL_SIZES, DEFAULT_SIZE } from '../src/labels.js';
import { dashboardError, renderLabelReport } from '../src/dashboard-page.js';
import {
  COOKIE_NAME, isConfigured, parseCookies, authenticate, csrfValid, readFormBody, callerIp,
} from '../src/dashboard-auth.js';
import { recordActivity } from '../src/audit.js';

/**
 * Streams a merged, print-ready PDF of official carrier waybills.
 *
 * Kept separate from /api/dashboard because it answers with a binary body rather than a
 * page, and because label fetching is the slowest thing here - it deserves its own
 * timeout budget instead of sharing one with the dashboard render.
 */

// Selections are posted as "channel:id" pairs; anything else is ignored rather than trusted.
// Shopify names an order "#10926", so the id charset carries the hash it prints with.
const SELECTION = /^(tokopedia|tiktok_shop|shopee|shopify|manual):([A-Za-z0-9_#-]{1,64})$/;
const MAX_LABELS = 100;

export default async function handler(req, res) {
  const fail = (status, heading, detail) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(dashboardError(heading, detail));
  };

  if (req.method !== 'POST') {
    fail(405, 'Metode tidak didukung', 'Halaman ini hanya menerima POST dari formulir cetak.');
    return;
  }
  if (!isConfigured()) {
    fail(500, 'Dashboard belum dikonfigurasi', 'Kredensial login belum disetel.');
    return;
  }

  const session = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const user = await authenticate(session);
  if (!user) {
    fail(401, 'Sesi berakhir', 'Masuk kembali lewat dashboard, lalu ulangi pencetakan.');
    return;
  }

  let form;
  try {
    // A hundred selections of ~30 bytes each still fits comfortably.
    form = await readFormBody(req, 16384);
  } catch {
    fail(400, 'Permintaan terlalu besar', 'Pilih lebih sedikit pesanan sekaligus.');
    return;
  }
  if (!csrfValid(session, form.get('csrf'))) {
    fail(403, 'Permintaan ditolak', 'Token formulir tidak cocok. Muat ulang halaman dan coba lagi.');
    return;
  }

  const selected = new Map();
  for (const value of form.getAll('order')) {
    const match = SELECTION.exec(String(value));
    if (match) selected.set(match[2], match[1]);
  }
  if (selected.size === 0) {
    fail(400, 'Tidak ada yang dipilih', 'Centang minimal satu pesanan sebelum mencetak.');
    return;
  }
  if (selected.size > MAX_LABELS) {
    fail(400, 'Terlalu banyak label', `Maksimal ${MAX_LABELS} label sekali cetak. Bagi menjadi beberapa batch.`);
    return;
  }

  const size = Object.hasOwn(LABEL_SIZES, form.get('size')) ? form.get('size') : DEFAULT_SIZE;

  try {
    // The selection carries ids only. TikTok labels are addressed by package id, which
    // has to be read from the order, so those are resolved server-side and a tampered
    // form cannot smuggle in a package that is not the seller's. Shopee needs no such
    // lookup: its API is scoped to this shop, so an id that is not ours simply fails.
    const chosen = [...selected].map(([id, channel]) => ({ id, channel }));

    const sheet = await buildLabelSheet({
      orders: chosen,
      size,
      resolvePackages: async (tiktokOrders) => {
        const { orders, errors } = await fetchOrdersByIds(tiktokOrders);
        if (orders.length === 0 && Object.keys(errors).length > 0) {
          throw new Error(Object.values(errors)[0]);
        }
        return orders;
      },
      // A Shopify label is drawn from the order, so the whole order has to be read back -
      // the form carries ids, and an address typed into a form is not an address. It is
      // read from our own database first: a hundred keyed rows cost one round trip, while
      // asking Shopify for them means scanning sixty days of history.
      resolveShopify: async (rows) => {
        const { orders, errors } = await ordersForPrinting(rows);
        if (orders.length === 0 && Object.keys(errors).length > 0) {
          throw new Error(Object.values(errors)[0]);
        }
        return orders.filter((o) => o.channel === 'shopify' || o.channel === 'manual');
      },
    });

    if (!sheet.bytes) {
      const lines = sheet.failures
        .slice(0, 12)
        .map((f) => `${f.channel} ${f.id}: ${f.reason}`)
        .join(' | ');
      fail(409, 'Tidak ada label yang bisa dicetak', lines || 'Semua pesanan yang dipilih belum siap.');
      return;
    }

    // Shopify has no idea a label exists, so the fact that one came out is recorded here
    // or the order would ask to be printed again tomorrow.
    if (sheet.printed?.length) {
      await markPrinted(sheet.printed, { by: user.email }).catch((error) => {
        console.warn(`labels: gagal mencatat cetakan Shopify - ${error.message}`);
      });
    }

    console.log(`labels: ${sheet.pageCount} pages for ${chosen.length} orders at ${size}, ${sheet.failures.length} failed`);
    // Printing is not a write to any marketplace, but "who printed the labels for these
    // parcels, and when" is exactly the question asked when a parcel goes missing.
    await recordActivity({
      actor: user, ip: callerIp(req), menu: 'labels', action: 'print_labels', verb: 'print',
      target: `${chosen.length} pesanan`,
      summary: `Mencetak ${sheet.pageCount} label (${size}) untuk ${chosen.length} pesanan${sheet.failures.length ? `, ${sheet.failures.length} gagal` : ''}`,
      changes: [
        ...chosen.map((o) => ({ field: `${o.channel} ${o.id}`, to: 'dicetak' })).filter((c) => !sheet.failures.some((f) => c.field.endsWith(f.id))),
        ...sheet.failures.map((f) => ({ field: `${f.channel} ${f.id}`, to: 'gagal', note: f.reason })),
      ],
    });

    // A partial run must never look complete. Streaming the PDF alone would leave the
    // operator counting labels at the printer to discover what is missing, so anything
    // short of a full run answers with a page that names every parcel that failed.
    if (sheet.failures.length > 0) {
      console.warn(`labels: ${sheet.failures.map((f) => `${f.id}:${f.reason}`).join('; ')}`);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(renderLabelReport({
        pageCount: sheet.pageCount,
        requested: chosen.length,
        failures: sheet.failures,
        pdfBase64: Buffer.from(sheet.bytes).toString('base64'),
        size,
      }));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="label-${size}-${sheet.pageCount}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Label-Pages', String(sheet.pageCount));
    res.end(Buffer.from(sheet.bytes));
  } catch (error) {
    console.error(`labels: ${error.message}`);
    fail(502, 'Gagal menyiapkan label', error.message);
  }
}
