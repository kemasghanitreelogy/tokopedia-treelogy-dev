import { ordersForPrinting } from '../src/orders-by-id.js';
import { buildFaktur } from '../src/faktur.js';
import { dashboardError } from '../src/dashboard-page.js';
import { COOKIE_NAME, isConfigured, parseCookies, authenticate, callerIp } from '../src/dashboard-auth.js';
import { recordActivity } from '../src/audit.js';
import { orderCode } from '../src/mekari/prefix.js';

/**
 * One order's sales invoice, as a PDF.
 *
 * A GET, because printing an invoice changes nothing - the document is drawn from the
 * order and thrown away. The order itself is read back from its platform rather than
 * taken from the request: the page that opens this already holds every figure, and a
 * form that carried them would be a form that could be edited into a false invoice.
 */

const SELECTION = /^(tokopedia|tiktok_shop|shopee|shopify|manual)$/;

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const fail = (status, heading, detail) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(dashboardError(heading, detail));
  };

  if (req.method !== 'GET') return fail(405, 'Metode tidak didukung', 'Halaman ini hanya menerima GET.');
  if (!isConfigured()) return fail(500, 'Dashboard belum dikonfigurasi', 'Kredensial login belum disetel.');

  const user = await authenticate(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  if (!user) return fail(401, 'Sesi berakhir', 'Masuk kembali lewat dashboard, lalu ulangi pencetakan.');

  const channel = String(url.searchParams.get('channel') ?? '');
  const id = String(url.searchParams.get('id') ?? '').trim();
  if (!SELECTION.test(channel) || !id || id.length > 64) {
    return fail(400, 'Pesanan tidak dikenal', 'Kanal atau nomor pesanan tidak valid.');
  }

  try {
    const started = Date.now();
    const { orders, errors, fromDb } = await ordersForPrinting([{ channel, id }]);
    const order = orders.find((o) => o.id === id && o.channel === channel);
    if (!order) {
      const reason = Object.values(errors ?? {})[0];
      return fail(404, 'Pesanan tidak ditemukan', reason ?? `${id} tidak ada di ${channel}.`);
    }

    const bytes = await buildFaktur(order);
    await recordActivity({
      actor: user, ip: callerIp(req), menu: 'orders', action: 'print_invoice', verb: 'print',
      target: `${channel} ${id}`,
      summary: `Mencetak faktur ${orderCode(order)} untuk ${order.buyer || order.customer || 'pembeli'}`,
      changes: [{ field: 'nilai', to: order.total }],
    });
    console.log(`invoice: ${channel}/${id} dicetak oleh ${user.email} dalam ${Date.now() - started}ms (${fromDb ? 'database' : 'platform'})`);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    // Inline, so the click lands in the browser's own print preview rather than in a
    // download the operator then has to find.
    res.setHeader('Content-Disposition', `inline; filename="faktur-${orderCode(order).replace(/[^A-Za-z0-9-]/g, '')}.pdf"`);
    res.end(Buffer.from(bytes));
  } catch (error) {
    console.error(`invoice: ${channel}/${id} gagal - ${error.message}`);
    fail(502, 'Faktur tidak bisa dibuat', error.message);
  }
}
