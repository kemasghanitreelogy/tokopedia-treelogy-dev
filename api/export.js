import { ordersFor } from './dashboard.js';
import { resolveRange } from '../src/range.js';
import { dashboardError } from '../src/dashboard-page.js';
import { buildExport, renderExport, exportFilename, DATASETS, DEFAULT_DATASET } from '../src/export/orders.js';
import { COOKIE_NAME, isConfigured, parseCookies, authenticate, callerIp } from '../src/dashboard-auth.js';
import { recordActivity } from '../src/audit.js';

/**
 * The spreadsheet behind the Export button.
 *
 * Its own route rather than another branch of /api/dashboard, for the same reason the
 * label sheet has one: the body is a file, not a page, and a range somebody asks for on
 * purpose can be far wider than the one they happen to be looking at. It reads orders
 * through the same loader the dashboard uses, so a range already in the cache costs
 * nothing extra and an uncovered one is read once and stored on the way past.
 *
 * GET, not POST: a file you can link to, bookmark and re-fetch is worth more than one
 * that only exists at the end of a form, and nothing here writes.
 */

export default async function handler(req, res) {
  const fail = (status, heading, detail) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(dashboardError(heading, detail));
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(405, 'Metode tidak didukung', 'Ekspor hanya menerima GET.');
    return;
  }
  if (!isConfigured()) {
    fail(500, 'Dashboard belum dikonfigurasi', 'Kredensial login belum disetel.');
    return;
  }

  const session = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const user = await authenticate(session);
  if (!user) {
    fail(401, 'Sesi berakhir', 'Masuk kembali lewat dashboard, lalu ulangi ekspor.');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const dataset = DATASETS[url.searchParams.get('dataset')] ? url.searchParams.get('dataset') : DEFAULT_DATASET;
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
  // The same resolver the dashboard uses, so the file and the screen agree about what
  // "30 hari" means - including its ninety-day ceiling.
  const range = resolveRange({
    preset: url.searchParams.get('preset') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    fallback: '30d',
  });
  const channels = url.searchParams.getAll('channel');

  try {
    const started = Date.now();
    const { orders } = await ordersFor(range);
    const sheet = buildExport({ orders, dataset, channels, range });
    const { body, type } = renderExport(sheet, format);
    const filename = exportFilename(sheet, format, range);

    console.log(`export: ${sheet.dataset} ${format}, ${sheet.rows.length} baris dari ${sheet.orderCount} pesanan, ${range.label} (${Date.now() - started}ms)`);

    // Logged like a print: a file of every buyer and address in a quarter has left the
    // building, and the trail should say who took it and what was in it.
    await recordActivity({
      actor: user, ip: callerIp(req), menu: 'orders', action: 'export', verb: 'print',
      target: `${sheet.rows.length} baris`,
      summary: `Mengekspor ${DATASETS[sheet.dataset].label} sebagai ${format.toUpperCase()}: ${sheet.rows.length} baris dari ${sheet.orderCount} pesanan, ${range.label}`,
      changes: [
        { field: 'Rentang', to: `${range.from} s/d ${range.to}` },
        { field: 'Kanal', to: sheet.channels.join(', ') },
      ],
    }).catch(() => {});

    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error(`export: gagal - ${error.message}`);
    fail(502, 'Ekspor gagal', error.message);
  }
}
