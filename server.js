import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The same handlers Vercel ran, on a machine we own.
 *
 * Each file under api/ exports a `(req, res)` handler in Node's own shape, which is why
 * moving off Vercel is a router and not a rewrite. What Vercel used to provide - the
 * route table, static files, a process that stays up - is here. What it used to impose -
 * a 120-second ceiling, a function per request, a state store with a quota - is not.
 */

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(process.cwd(), 'public');

/** Route → module, resolved lazily so a broken handler does not stop the others booting. */
const ROUTES = {
  '/api/dashboard': './api/dashboard.js',
  '/api/activate': './api/activate.js',
  '/api/invoice': './api/invoice.js',
  '/api/labels': './api/labels.js',
  '/api/export': './api/export.js',
  '/api/status': './api/status.js',
  '/api/events': './api/events.js',
  '/api/callback': './api/callback.js',
  '/api/mekari-sync': './api/mekari-sync.js',
  '/api/shopee/callback': './api/shopee/callback.js',
  '/api/shopee/status': './api/shopee/status.js',
  '/api/tokopedia/reviews': './api/tokopedia/reviews.js',
  '/api/tokopedia/media': './api/tokopedia/media.js',
  '/api/webhook/shopee': './api/webhook/shopee.js',
  '/api/webhook/tiktok': './api/webhook/tiktok.js',
  '/api/webhook/shopify': './api/webhook/shopify.js',
  '/api/deploy': './api/deploy.js',
};

const handlers = new Map();
async function handlerFor(pathname) {
  const file = ROUTES[pathname];
  if (!file) return null;
  if (!handlers.has(file)) handlers.set(file, import(file).then((m) => m.default));
  return handlers.get(file);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain' };

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // The same headers vercel.json set on every API response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (url.pathname.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  // The event stream is held open on purpose and sets its own timeout; the ten-minute
  // ceiling meant for a label print would cut the doorbell off mid-afternoon.
  if (url.pathname === '/api/events') req.setTimeout(0);

  try {
    const handler = await handlerFor(url.pathname);
    if (handler) {
      await handler(req, res);
      if (!res.writableEnded) res.end();
      return;
    }
    if (req.method === 'GET' && serveStatic(url.pathname, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (error) {
    console.error(`${req.method} ${url.pathname} gagal: ${error.stack ?? error.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    if (!res.writableEnded) res.end('internal error');
  }
});

// Generous, but finite: a label print can take a minute; nothing should take ten.
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 65 * 1000;

server.listen(PORT, HOST, () => {
  console.log(`treelogy siap di http://${HOST}:${PORT} (state: ${process.env.STATE_BACKEND || 'auto'})`);
  warmDashboard();
});

/**
 * The two order ranges everybody opens are kept warm behind the scenes, so the first
 * click after a quiet spell is as quick as any other. Every four minutes is inside the
 * cache's stale window, which means a reader is never the one who pays for the refresh.
 */
function warmDashboard() {
  if (process.env.DASHBOARD_WARM === '0') return;
  import('./api/dashboard.js').then((m) => {
    const run = () => m.warmOrders().catch((error) => console.warn(`dashboard: pemanasan gagal - ${error.message}`));
    setTimeout(run, 2_000).unref();
    setInterval(run, 4 * 60_000).unref();
  }).catch((error) => console.warn(`dashboard: pemanasan tidak jalan - ${error.message}`));
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal}: berhenti setelah request berjalan selesai`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 15_000).unref();
  });
}
