import { collectOrders, summarize } from '../src/omni.js';
import { renderDashboard, renderPicklist, renderProducts, renderLabels, renderProcess, renderStock, renderJurnal, renderManual, renderLogin, dashboardError, VIEWS } from '../src/dashboard-page.js';
import { runAction, massArrange } from '../src/fulfillment.js';
import { fetchOrdersByIds } from '../src/omni.js';
import { LABEL_SIZES, DEFAULT_SIZE } from '../src/labels.js';
import { buildPicklist } from '../src/picklist.js';
import { readCatalog } from '../src/inventory.js';
import { loadLedger, saveLedger, setSku, emptyLedger } from '../src/ledger.js';
import { planSync, applySync, applyPrice, writeAudit } from '../src/stock-sync.js';
import { resolveRange } from '../src/range.js';
import { cached, invalidate } from '../src/cache.js';
import { runSync, loadSyncLedger, syncOverview, postManual, manualCodes } from '../src/mekari/sync.js';
import { buildManualOrder, suggestCode } from '../src/mekari/manual.js';
import { buildInvoice, verifyInvoice } from '../src/mekari/invoice.js';
import { listContacts } from '../src/mekari/setup.js';
import { wibDate } from '../src/range.js';
import { loadHeartbeat } from '../src/mekari/heartbeat.js';
import { notifySyncFailures } from '../src/notify/telegram.js';
import { ensureReady } from '../src/mekari/setup.js';
import { isMekariConfigured } from '../src/mekari/client.js';
import { withFallback } from '../src/snapshot.js';
import {
  COOKIE_NAME, isConfigured, credentialsMatch, tokenMatches, parseCookies,
  issueSession, sessionValid, sessionCookie, clearedCookie, safeRedirect, readFormBody,
  callerIp, attemptState, isLockedOut, recordFailure, clearFailures, csrfValid, csrfToken,
} from '../src/dashboard-auth.js';

/**
 * Hosted omnichannel dashboard: https://<deployment>/api/dashboard
 *
 * Access is a login form backed by an auto-generated, HMAC-signed session cookie, so the
 * access key is typed once instead of living in every URL and in browser history. A
 * ?key= link still works for bookmarks: it logs in and immediately redirects to a clean
 * URL so the key does not linger in the address bar.
 *
 * The page renders real order data - buyer names, totals, tracking numbers - so it
 * refuses to serve at all when DASHBOARD_TOKEN is unset. A missing secret must never
 * mean "open to the internet".
 */

const PATH = '/api/dashboard';

// Orders churn fastest, the catalogue slower, the ledger only when we write it.
const ORDERS_TTL_MS = 45_000;
const CATALOG_TTL_MS = 60_000;
const LEDGER_TTL_MS = 60_000;

const catalogComplete = (catalog) => Object.keys(catalog.errors ?? {}).length === 0;
const readCatalogSafely = () =>
  withFallback('catalog', readCatalog, { isComplete: catalogComplete });

/**
 * The three write actions.
 *
 * `ledger` only touches our own master record - it never reaches a marketplace, so an
 * operator can correct a number and see the resulting plan before anything is pushed.
 * `apply` and `price` do write to the shops, and both go through the same guarded paths
 * the CLI uses, including the audit trail.
 */
async function handleWrite(form, ip) {
  const action = form.get('action');

  if (action === 'ledger') {
    const sku = String(form.get('sku') ?? '').trim();
    const qty = Number(form.get('qty'));
    if (!sku) throw new Error('SKU kosong');
    if (!Number.isInteger(qty) || qty < 0) throw new Error('jumlah harus bilangan bulat >= 0');

    const ledger = (await loadLedger().catch(() => null)) ?? emptyLedger();
    const updated = setSku(ledger, sku, { qty, needs_review: false, source: `manual:${ip}` });
    await saveLedger(updated);
    // The stock view must show the number that was just saved, not a cached one.
    invalidate('catalog');
    invalidate('ledger');
    console.log(`dashboard: ledger ${sku} -> ${qty}`);
    return { view: 'products', message: `Ledger ${sku} disetel ke ${qty}` };
  }

  if (action === 'apply') {
    const [catalog, ledger] = await Promise.all([readCatalog(), loadLedger()]);
    if (!ledger) throw new Error('ledger belum ada');
    if (Object.keys(catalog.errors).length > 0) {
      // Half a catalogue means half the picture; writing from it could zero live SKUs.
      throw new Error('katalog tidak lengkap, sinkronisasi dibatalkan');
    }
    const plan = planSync({ ledger, catalog });
    if (plan.changes.length === 0) return { view: 'products', message: 'Tidak ada yang perlu ditulis' };

    const result = await applySync(plan, { dryRun: false });
    invalidate('catalog');
    console.log(`dashboard: applied ${result.succeeded}/${result.attempted} stock writes`);
    return {
      view: 'products',
      message: `${result.succeeded} berhasil, ${result.failed} gagal dari ${result.attempted} penulisan stok`,
    };
  }

  if (action === 'ledger_batch') {
    // One submit can carry every edited SKU; untouched fields are simply absent from
    // the form, so nothing is written that the operator did not change.
    // A vouch re-writes a seeded row as manually set without changing its number - the
    // guardrail holds increases from a seed, and this is how a human releases one.
    const vouched = new Set();
    for (const [key] of form.entries()) {
      if (key.startsWith('vouch:')) vouched.add(key.slice(6).trim());
    }

    const edits = [];
    for (const [key, value] of form.entries()) {
      if (!key.startsWith('qty:')) continue;
      const sku = key.slice(4).trim();
      const raw = String(value).trim();
      if (!sku || raw === '') continue;
      const qty = Number(raw);
      if (!Number.isInteger(qty) || qty < 0) throw new Error(`${sku}: jumlah harus bilangan bulat >= 0`);
      edits.push({ sku, qty });
    }
    if (edits.length === 0 && vouched.size === 0) throw new Error('tidak ada perubahan untuk disimpan');
    if (edits.length > 200) throw new Error('terlalu banyak perubahan sekaligus');

    let ledger = (await loadLedger().catch(() => null)) ?? emptyLedger();
    let written = 0;
    for (const { sku, qty } of edits) {
      // Only write what actually moved - unless the operator vouched for it, which is
      // itself the change: the row stops being a seed and becomes a deliberate number.
      if (ledger.skus[sku]?.qty === qty && !vouched.has(sku)) continue;
      ledger = setSku(ledger, sku, { qty, needs_review: false, source: `manual:${ip}` });
      written += 1;
    }
    if (written === 0) return { view: 'stock', message: 'Tidak ada nilai yang berubah' };

    await saveLedger(ledger);
    invalidate('ledger');
    invalidate('catalog');
    console.log(`dashboard: ledger_batch ${written} skus`);
    return { view: 'stock', message: `${written} stok disimpan ke ledger` };
  }

  if (action === 'mass_arrange') {
    const SELECTION = /^(tokopedia|tiktok_shop|shopee):([A-Za-z0-9_-]{1,64})$/;
    const wanted = [];
    for (const value of form.getAll('order')) {
      const match = SELECTION.exec(String(value));
      if (match) wanted.push({ channel: match[1], id: match[2] });
    }
    if (wanted.length === 0) throw new Error('tidak ada pesanan yang dipilih');
    if (wanted.length > 100) throw new Error('maksimal 100 pesanan sekali atur');

    // Orders are re-read from the platforms: the form carries ids, never package numbers,
    // so a tampered field cannot ship a parcel that is not the seller's.
    const { orders } = await fetchOrdersByIds(wanted);
    const eligible = orders.filter((o) => wanted.some((w) => w.id === o.id && w.channel === o.channel));
    if (eligible.length === 0) throw new Error('pesanan yang dipilih tidak ditemukan');

    const result = await massArrange(eligible);
    invalidate('orders');
    console.log(`dashboard: mass_arrange ${result.succeeded} ok, ${result.failed} failed`);

    const failed = result.results.filter((r) => r.status === 'failed');
    return {
      view: 'process',
      message: failed.length === 0
        ? `${result.succeeded} pesanan berhasil diatur pengirimannya`
        : `${result.succeeded} berhasil, ${failed.length} gagal - ${failed[0].id}: ${failed[0].error}`,
    };
  }

  if (action === 'fulfil') {
    const op = String(form.get('op') ?? '');
    const channel = String(form.get('channel') ?? '');
    const id = String(form.get('order') ?? '').trim();
    if (!id || !channel) throw new Error('pesanan tidak lengkap');

    // The order is re-read from the platform rather than trusted from the form: a
    // tampered field must not be able to ship someone else's parcel.
    const { orders } = await fetchOrdersByIds([{ channel, id }]);
    const order = orders.find((o) => o.id === id && o.channel === channel);
    if (!order) throw new Error(`pesanan ${id} tidak ditemukan`);

    const result = await runAction({
      action: op,
      order,
      trackingNumber: String(form.get('tracking') ?? '').trim(),
      company: String(form.get('company') ?? '').trim(),
    });
    invalidate('orders');

    if (result.status === 'failed') throw new Error(`${id}: ${result.error}`);
    console.log(`dashboard: ${op} ${channel}/${id} ok`);
    return { view: 'process', message: `${id} berhasil diproses` };
  }

  if (action === 'price') {
    const sku = String(form.get('sku') ?? '').trim();
    const price = Number(form.get('price'));
    if (!sku) throw new Error('SKU kosong');
    if (!Number.isInteger(price) || price <= 0) throw new Error('harga harus bilangan bulat positif');

    const catalog = await readCatalog();
    const results = await applyPrice({ catalog, sku, price });
    invalidate('catalog');
    const ok = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'failed');
    await writeAudit({ results }, { guards: { action: 'price' } }).catch(() => {});
    console.log(`dashboard: price ${sku} -> ${price} (${ok} ok, ${failed.length} failed)`);
    return {
      view: 'products',
      message: failed.length
        ? `Harga ${sku}: ${ok} berhasil, ${failed.length} gagal - ${failed[0].error}`
        : `Harga ${sku} disetel ke ${price} di ${ok} listing`,
    };
  }

  if (action === 'mekari_sync') {
    if (!isMekariConfigured()) throw new Error('kredensial Mekari belum diisi');
    if (process.env.MEKARI_SYNC_LIVE !== '1') {
      throw new Error('sinkronisasi masih dikunci - setel MEKARI_SYNC_LIVE=1 dulu');
    }

    // Orders are re-read rather than trusted from the form: the page only ever carries a
    // count, so nothing a browser sends can decide what gets booked.
    const range = resolveRange({ preset: '7d' });
    const { orders } = await collectOrders({ range, tracking: false });
    const depositTo = process.env.MEKARI_DEPOSIT_ACCOUNT || null;

    const ledgerNow = await loadSyncLedger();
    await ensureReady({ dryRun: false, readyAt: ledgerNow.ready_at ?? null });
    // Sized to Jurnal's quota, like the sweep; whatever does not fit is picked up by the
    // next scheduled sweep, and the message says so rather than implying it was all sent.
    const result = await runSync({ orders, depositTo, dryRun: false, limit: 15, deadlineMs: 80_000 });
    invalidate('jurnal');

    if (result.skipped) return { view: 'jurnal', message: 'Sinkronisasi lain sedang berjalan' };
    const failed = result.results.filter((r) => r.status === 'failed' || r.status === 'mismatch');
    await notifySyncFailures({ source: 'tombol Kirim di dashboard', results: result.results });
    console.log(`dashboard: mekari_sync ${result.created} created, ${result.exists} existing, ${result.failed} failed, ${result.deferred} deferred`);
    const later = result.remaining + result.deferred;
    return {
      view: 'jurnal',
      message: failed.length === 0
        ? `${result.created} faktur dibuat di Jurnal${result.exists ? `, ${result.exists} sudah ada` : ''}` +
          (result.voided ? `, ${result.voided} dibatalkan dihapus` : '') +
          (later > 0 ? `, ${later} sisanya dikirim sapuan otomatis berikutnya` : '')
        : `${result.created} berhasil, ${failed.length} bermasalah - ${failed[0].customId}: ${failed[0].error}`,
    };
  }

  if (action === 'manual_invoice') {
    if (!isMekariConfigured()) throw new Error('kredensial Mekari belum diisi');

    // Rebuilt from the submitted fields and checked from scratch. The running total the
    // browser showed is a courtesy; nothing it sent is trusted as arithmetic.
    const lines = form.getAll('sku').map((sku, index) => ({
      sku,
      qty: Number(form.getAll('qty')[index]),
      unitPrice: Number(form.getAll('unitPrice')[index]),
      unitDiscount: Number(form.getAll('unitDiscount')[index]),
    }));

    const order = buildManualOrder({
      source: form.get('source'),
      code: form.get('code'),
      date: form.get('date'),
      customer: form.get('customer'),
      note: form.get('note'),
      shipping: form.get('shipping'),
      lines,
    });

    const depositTo = process.env.MEKARI_DEPOSIT_ACCOUNT || null;
    const built = buildInvoice({ order, depositTo });
    verifyInvoice(built, built.expectedTotal);

    // A disagreement between what the operator saw and what is about to be booked is a
    // stop, not a rounding note - they approved a number, and that is the number.
    const claimed = Number(form.get('total'));
    if (Number.isFinite(claimed) && claimed !== built.expectedTotal) {
      throw new Error(`total di layar (${claimed}) tidak sama dengan hasil hitung ulang (${built.expectedTotal})`);
    }

    if (process.env.MEKARI_SYNC_LIVE !== '1') {
      throw new Error(`${order.id} valid senilai ${built.expectedTotal}, tapi MEKARI_SYNC_LIVE belum disetel`);
    }

    const result = await postManual({ order, depositTo, dryRun: false });
    if (result.status === 'failed') {
      await notifySyncFailures({ source: 'transaksi manual', results: [result] });
      throw new Error(`${order.id}: ${result.error}`);
    }
    invalidate('jurnal');
    console.log(`dashboard: manual_invoice ${order.id} -> ${result.status}`);

    return {
      view: 'jurnal',
      message: result.status === 'exists'
        ? `${order.id} sudah ada di Jurnal, tidak dibuat dua kali`
        : `${order.id} tersimpan di Jurnal senilai ${built.expectedTotal.toLocaleString('id-ID')}`,
    };
  }

  throw new Error(`aksi tidak dikenal: ${action}`);
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const send = (status, html, headers = {}) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.end(html);
  };
  const redirect = (location, headers = {}) => {
    res.statusCode = 303;
    res.setHeader('Location', location);
    res.setHeader('Cache-Control', 'no-store');
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.end();
  };

  if (!isConfigured()) {
    console.error('dashboard: DASHBOARD_EMAIL / DASHBOARD_PASSWORD / DASHBOARD_TOKEN missing');
    send(500, dashboardError('Dashboard not configured', 'Login credentials are not set, so this page refuses to serve order data.'));
    return;
  }

  // resolveRange validates every input and falls back rather than throwing, so a
  // hand-edited URL still renders a dashboard instead of an error page.
  const range = resolveRange({
    preset: url.searchParams.get('preset') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });
  const here = safeRedirect(PATH, range);

  if (url.searchParams.has('logout')) {
    redirect(PATH, { 'Set-Cookie': clearedCookie() });
    return;
  }

  const ip = callerIp(req);
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies[COOKIE_NAME];

  // An authenticated POST is a write action, not a login attempt.
  if (req.method === 'POST' && sessionValid(session)) {
    let form;
    try {
      form = await readFormBody(req);
    } catch {
      send(400, dashboardError('Permintaan tidak valid', 'Data formulir terlalu besar.'));
      return;
    }

    if (!csrfValid(session, form.get('csrf'))) {
      console.warn('dashboard: rejected write with a bad CSRF token');
      send(403, dashboardError('Permintaan ditolak', 'Token formulir tidak cocok. Muat ulang halaman dan coba lagi.'));
      return;
    }

    try {
      const outcome = await handleWrite(form, ip);
      redirect(`${PATH}?view=${outcome.view}&done=${encodeURIComponent(outcome.message)}`);
    } catch (error) {
      console.error(`dashboard: write failed - ${error.message}`);
      redirect(`${PATH}?view=${form.get('view') || 'products'}&error=${encodeURIComponent(error.message)}`);
    }
    return;
  }

  if (req.method === 'POST') {
    // A short password is only safe while guessing stays expensive, so the lockout is
    // checked before the credentials are even looked at.
    const attempts = await attemptState(ip);
    if (isLockedOut(attempts)) {
      const retryIn = attempts.lockedUntil - Math.floor(Date.now() / 1000);
      console.warn(`dashboard: login locked out for ${ip}`);
      send(429, renderLogin({ lockedFor: retryIn, redirectTo: here }), { 'Retry-After': String(retryIn) });
      return;
    }

    let form;
    try {
      form = await readFormBody(req);
    } catch {
      send(400, renderLogin({ failed: true, redirectTo: here }));
      return;
    }

    const email = form.get('email') ?? '';
    if (!credentialsMatch(email, form.get('password'))) {
      const next = await recordFailure(ip);
      const remaining = Math.max(0, 5 - next.count);
      console.warn(`dashboard: failed login (${remaining} attempts left before lockout)`);
      send(401, renderLogin({
        failed: true,
        email,
        lockedFor: next.lockedUntil ? next.lockedUntil - Math.floor(Date.now() / 1000) : 0,
        redirectTo: here,
      }));
      return;
    }

    await clearFailures(ip);
    redirect(here, { 'Set-Cookie': sessionCookie(issueSession()) });
    return;
  }

  // The long random token still works as a bookmark key; it is stronger than the
  // password and is exchanged for a session so it never lingers in the address bar.
  const urlKey = url.searchParams.get('key');
  if (urlKey !== null) {
    if (!tokenMatches(urlKey)) {
      send(401, renderLogin({ failed: true, redirectTo: here }));
      return;
    }
    redirect(here, { 'Set-Cookie': sessionCookie(issueSession()) });
    return;
  }

  if (!sessionValid(session)) {
    send(401, renderLogin({ redirectTo: here }));
    return;
  }

  // The reload button carries ?retry=<timestamp>; honour it by dropping the cached copy
  // so the click actually reaches the marketplace instead of replaying the same failure.
  if (url.searchParams.has('retry')) invalidate();

  const requestedView = url.searchParams.get('view') ?? 'orders';
  // The stock tab was folded into products; old links and bookmarks still land somewhere useful.
  const view = Object.hasOwn(VIEWS, requestedView) ? requestedView : 'orders';

  const flash = url.searchParams.get('done')
    ? { kind: 'ok', text: url.searchParams.get('done') }
    : url.searchParams.get('error')
      ? { kind: 'error', text: url.searchParams.get('error') }
      : null;
  const csrf = csrfToken(session);

  try {
    if (view === 'stock') {
      const [catalog, ledger] = await Promise.all([
        cached('catalog', CATALOG_TTL_MS, readCatalogSafely),
        cached('ledger', LEDGER_TTL_MS, () => loadLedger().catch(() => null)),
      ]);
      const plan = ledger && Object.keys(catalog.errors ?? {}).length === 0
        ? planSync({ ledger, catalog })
        : null;
      console.log(`dashboard/stock: ${catalog.skus.length} skus`);
      send(200, renderStock({
        catalog, ledger, plan, errors: catalog.errors, range, shopeeShop: null,
        generatedAt: Date.now(), csrf, flash,
        filter: url.searchParams.get('filter') ?? 'all',
      }));
      return;
    }

    if (view === 'products') {
      const [catalog, ledger] = await Promise.all([
        cached('catalog', CATALOG_TTL_MS, readCatalogSafely),
        cached('ledger', LEDGER_TTL_MS, () => loadLedger().catch(() => null)),
      ]);
      // A plan built from a partial catalogue could zero live SKUs, so it is only
      // computed when both channels answered.
      const plan = ledger && Object.keys(catalog.errors ?? {}).length === 0
        ? planSync({ ledger, catalog })
        : null;
      console.log(`dashboard/products: ${catalog.skus.length} skus${catalog.stale ? ' (stale)' : ''}`);
      send(200, renderProducts({
        catalog, ledger, plan, errors: catalog.errors, range, shopeeShop: null,
        generatedAt: Date.now(), csrf, flash,
        selected: url.searchParams.get('sku') ?? null,
      }));
      return;
    }

    if (view === 'jurnal' && url.searchParams.get('add') === '1') {
      const ledger = await cached('jurnal', LEDGER_TTL_MS, () => loadSyncLedger().catch(() => ({ orders: {} })));
      const used = manualCodes(ledger);
      const source = url.searchParams.get('source') ?? 'CS';
      // The contact list is a convenience, not a requirement: a Jurnal that will not
      // answer must not stop someone entering a sale they have in their hand.
      const contacts = await listContacts().then((m) => [...m.keys()].sort()).catch(() => []);

      send(200, renderManual({
        range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash,
        source, code: suggestCode(source, used), today: wibDate(Math.floor(Date.now() / 1000)),
        contacts, existingCodes: used,
        live: process.env.MEKARI_SYNC_LIVE === '1',
        depositTo: process.env.MEKARI_DEPOSIT_ACCOUNT || null,
      }));
      return;
    }

    const wantsTracking = view !== 'picklist' && view !== 'jurnal';
    // Keyed by the range's identity, not its computed bounds: a rolling preset recomputes
    // `since`/`until` from Date.now() on every request, so timestamps would make the key
    // unique each time and the cache would never hit.
    const rangeKey = range.preset ?? `${range.from}:${range.to}`;
    const data = await cached(
      `orders:${rangeKey}:${wantsTracking}`,
      ORDERS_TTL_MS,
      () => collectOrders({ range, tracking: wantsTracking }),
    );

    if (view === 'labels') {
      console.log(`dashboard/labels: ${data.orders.length} orders in range`);
      send(200, renderLabels({
        ...data, csrf, flash, sizes: LABEL_SIZES, defaultSize: DEFAULT_SIZE,
        showReprints: url.searchParams.get('reprint') === '1',
      }));
      return;
    }

    if (view === 'process') {
      console.log(`dashboard/process: ${data.orders.length} orders in range`);
      send(200, renderProcess({ ...data, csrf, flash }));
      return;
    }

    if (view === 'jurnal') {
      const [ledger, heartbeat] = await Promise.all([
        cached('jurnal', LEDGER_TTL_MS, () => loadSyncLedger().catch(() => ({ orders: {} }))),
        // Not cached: its whole point is to say what happened in the last few minutes.
        loadHeartbeat(),
      ]);
      const depositTo = process.env.MEKARI_DEPOSIT_ACCOUNT || null;
      const overview = syncOverview({ orders: data.orders, ledger, depositTo });
      console.log(`dashboard/jurnal: ${overview.synced} synced, ${overview.queued} queued, ${overview.broken} broken`);
      send(200, renderJurnal({
        ...data, overview, csrf, flash, depositTo, heartbeat,
        live: process.env.MEKARI_SYNC_LIVE === '1',
        configured: isMekariConfigured(),
      }));
      return;
    }

    if (view === 'picklist') {
      const picklist = buildPicklist(data.orders);
      console.log(`dashboard/picklist: ${picklist.unitCount} units across ${picklist.skuCount} skus`);
      send(200, renderPicklist({ ...data, picklist }));
      return;
    }

    const summary = summarize(data.orders);
    console.log(`dashboard: ${data.orders.length} orders for ${range.label}, errors=${Object.keys(data.errors).join(',') || 'none'}`);
    send(200, renderDashboard({ ...data, summary }));
  } catch (error) {
    console.error(`dashboard: render failed - ${error.message}`);
    send(502, dashboardError('Could not load orders', error.message));
  }
}
