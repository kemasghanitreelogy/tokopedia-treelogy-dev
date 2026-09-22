import { collectOrders, summarize } from '../src/omni.js';
import { loadOrders, loadOutstanding, rememberOrders } from '../src/orders-source.js';
import { isSupabaseConfigured } from '../src/db/client.js';
import { saveOrders } from '../src/db/orders.js';
import { renderDashboard, renderPicklist, renderProducts, renderLabels, renderProcess, renderStock, renderJurnal, renderManual, renderForecast, renderReviews, renderLogin, dashboardError, VALID_VIEWS } from '../src/dashboard-page.js';
import { renderUsers } from '../src/pages/users.js';
import { renderActivity } from '../src/pages/activity.js';
import { can, listUsers, inviteUser, renewInvite, updateUser, removeUser, touchLogin, ROLES, STATUS } from '../src/users.js';
import { recordActivity, readActivity, actorsIn, MENUS } from '../src/audit.js';
import { sendMail, isSmtpConfigured } from '../src/mail/smtp.js';
import { invitationMail } from '../src/mail/invitation.js';
import { publicBaseUrl } from '../src/config.js';
import { selectReviews, reviewStats, syncReviews as syncTokopediaReviews } from '../src/tokopedia/reviews.js';
import { syncShopeeReviews } from '../src/shopee/reviews.js';
import { toKlaviyoCsv, klaviyoSummary } from '../src/klaviyo/reviews.js';
import { loadAllReviews, REVIEW_CHANNELS } from '../src/reviews/combined.js';
import { parsePaging, withoutPaging } from '../src/paging.js';
import { filterOrders } from '../src/omni.js';
import { runAction, massArrange, planArrangement } from '../src/fulfillment.js';
import { needsPickupTime } from '../src/shopee/pickup.js';
import { fetchOrdersByIds } from '../src/omni.js';
import { LABEL_SIZES, DEFAULT_SIZE } from '../src/labels.js';
import { printedLabels, markPrinted, arrangedOrders } from '../src/shopify/label.js';
import { priceBySku } from '../src/shopify/prices.js';
import { buildPicklist } from '../src/picklist.js';
import { readCatalog } from '../src/inventory.js';
import { loadLedger, saveLedger, setSku, emptyLedger } from '../src/ledger.js';
import { planSync, applySync, applyPrice, writeAudit, CHANNEL_LABEL } from '../src/stock-sync.js';
import { resolveRange } from '../src/range.js';
import { cached, invalidate } from '../src/cache.js';
import { runSync, loadSyncLedger, syncOverview, postManual, manualCodes } from '../src/mekari/sync.js';
import { postingAccounts } from '../src/mekari/accounts.js';

/**
 * How the screen describes where a settled marketplace sale lands.
 *
 * Not an account name any more: each channel has its own pooling account, so there is no
 * single one to name. The detail belongs in Jurnal; what the operator needs here is that
 * it is not the bank.
 */
const POOLED_LABEL = 'akun penampung per kanal';
import { buildManualOrder, formatManualCode, encodeSequence } from '../src/mekari/manual.js';
import { reserveManualSequence } from '../src/mekari/sequence.js';
import { buildInvoice, verifyInvoice } from '../src/mekari/invoice.js';
import { listContacts } from '../src/mekari/setup.js';
import { wibDate } from '../src/range.js';
import { loadHeartbeat } from '../src/mekari/heartbeat.js';
import { loadImageManifest } from '../src/mekari/images.js';
import { loadForecast } from '../src/forecast/engine.js';
import { notifySyncFailures } from '../src/notify/telegram.js';
import { ensureReady } from '../src/mekari/setup.js';
import { isMekariConfigured } from '../src/mekari/client.js';
import { withFallback } from '../src/snapshot.js';
import {
  COOKIE_NAME, isConfigured, login, tokenMatches, parseCookies,
  issueSession, authenticate, sessionCookie, clearedCookie, safeRedirect, readFormBody,
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
/**
 * With a database in front, this cache is no longer hiding three marketplace round trips
 * - it is hiding one indexed query. Forty-five seconds of staleness was a fair price for
 * the former and an absurd one for the latter: a webhook writes the new stage within
 * seconds of the buyer paying, and the whole point is that the screen shows it. Five
 * seconds still collapses the burst of requests a single page load makes.
 */
const DB_ORDERS_TTL_MS = 15_000;
const ordersTtl = () => (isSupabaseConfigured() ? DB_ORDERS_TTL_MS : ORDERS_TTL_MS);
/**
 * How long past fresh a value is still handed out while a refresh runs behind it.
 *
 * Fifteen seconds of fresh is the price of a screen that shows a webhook's write
 * promptly. Ten minutes of stale-while-refreshing is what keeps a click from ever
 * waiting on Sydney: the reader gets the last answer at once and the next reader gets
 * the newer one. A write still invalidates outright, so what somebody just changed is
 * read afresh, not served from before the change.
 */
const STALE_MS = 10 * 60_000;
const SWR = { staleMs: STALE_MS };
const CATALOG_TTL_MS = 60_000;
const LEDGER_TTL_MS = 60_000;
// Pictures change when somebody edits a listing, which is rarely; five minutes is plenty.
const IMAGES_TTL_MS = 5 * 60_000;
const imagesByKey = () => cached('images', IMAGES_TTL_MS, () => loadImageManifest().then((m) => m.images ?? {}).catch(() => ({})), SWR);

/**
 * The orders behind one range, from the cache when it has them and refreshed behind the
 * reader when it is time.
 *
 * Exported so the spreadsheet route reads through the same entry rather than a second
 * one beside it: an export of the range somebody is looking at should cost nothing, and
 * two caches of the same window would only disagree.
 */
export const ordersFor = (range) => cached(
  // Keyed by the range's identity, not its computed bounds: a rolling preset recomputes
  // `since`/`until` from Date.now() on every request, so timestamps would make the key
  // unique each time and the cache would never hit.
  `orders:${range.preset ?? `${range.from}:${range.to}`}`,
  ordersTtl(),
  () => loadOrders({ range, tracking: true }),
  SWR,
);

/**
 * The worklists - what is still to arrange, to pick, to print - regardless of the day it
 * was ordered. The three pages that exist to empty a queue must never be filtered by
 * date, or Friday's unarranged order is invisible on Monday.
 */
const OUTSTANDING_VIEWS = new Set(['process', 'picklist', 'labels']);
const outstandingOrders = () => cached('orders:outstanding', ordersTtl(), loadOutstanding, SWR);

/**
 * Keep what everybody opens warm, so the first click of the morning is as quick as the
 * tenth. Called by the server on a timer shorter than the stale window, which means the
 * entries never fall out of it and are refreshed behind the scenes.
 */
export async function warmOrders() {
  for (const preset of ['7d', 'today']) {
    await ordersFor(resolveRange({ preset })).catch((error) => console.warn(`dashboard: pemanasan ${preset} gagal - ${error.message}`));
  }
  await outstandingOrders().catch((error) => console.warn(`dashboard: pemanasan daftar pekerjaan gagal - ${error.message}`));
}

const catalogComplete = (catalog) => Object.keys(catalog.errors ?? {}).length === 0;
const readCatalogSafely = () =>
  withFallback('catalog', readCatalog, { isComplete: catalogComplete });

/** Which menu each action belongs to, for the activity log and the redirect after a failure. */
const ACTION_MENU = {
  ledger: 'products', apply: 'products', price: 'products', ledger_batch: 'stock',
  mass_arrange: 'process', fulfil: 'process', mekari_sync: 'jurnal', manual_invoice: 'jurnal',
  label_printed: 'labels', reviews_sync: 'reviews',
  user_invite: 'users', user_resend: 'users', user_role: 'users', user_status: 'users', user_delete: 'users',
};
const USER_ACTIONS = new Set(['user_invite', 'user_resend', 'user_role', 'user_status', 'user_delete']);

/** The activation link that goes in the email. */
const activationLink = (token) => `${publicBaseUrl()}/api/activate?token=${encodeURIComponent(token)}`;

/**
 * Send the invitation. A failure here does not undo the record: the person exists as
 * "diundang" and the operator gets a "kirim ulang" button next to the error, which is
 * more useful than a form that has to be typed again.
 */
async function deliverInvitation({ user, token, by }) {
  const link = activationLink(token);
  if (!isSmtpConfigured()) {
    // Local development without a mail server: the link goes to the console instead of
    // nowhere. In production SMTP is configured, so no invitation link is ever logged.
    if (process.env.NODE_ENV !== 'production') console.log(`invite: SMTP belum disetel; tautan untuk ${user.email}: ${link}`);
    throw new Error('SMTP belum dikonfigurasi, email undangan tidak terkirim');
  }
  const mail = invitationMail({ name: user.name, role: user.role, link, expiresAt: user.inviteExpiresAt, inviter: by });
  await sendMail({ to: user.email, ...mail });
}

/**
 * The write actions, each returning where to go, what to say - and what to record.
 *
 * `audit` is the activity-log entry: menu, verb, target, a one-line summary and, for
 * anything that had a previous value, the list of before/after pairs. The actor and the
 * address are added by the caller from the session, never from the form.
 *
 * `ledger` only touches our own master record - it never reaches a marketplace, so an
 * operator can correct a number and see the resulting plan before anything is pushed.
 * `apply` and `price` do write to the shops, and both go through the same guarded paths
 * the CLI uses, including the audit trail.
 */
/**
 * The page that asks when the driver should come, for the orders that need it asked.
 *
 * It is the process page with a dialog over it, carrying the whole selection forward in
 * hidden fields, so answering the question arranges the drop-off parcels in the same
 * batch and nothing is half-committed while the operator decides.
 */
async function pickupStep({ user, csrf, eligible, waiting, plans, chosen }) {
  const [data, arranged] = await Promise.all([
    outstandingOrders(),
    arrangedOrders().catch(() => ({})),
  ]);
  return renderProcess({
    user,
    ...data,
    range: resolveRange({ preset: '7d' }),
    csrf,
    flash: null,
    arranged,
    pickup: {
      waiting: waiting.map((order) => ({ order, plan: plans[order.id] })),
      selection: eligible.map((o) => `${o.channel}:${o.id}`),
      chosen,
      total: eligible.length,
    },
  });
}

async function handleWrite(form, ip, user, csrf) {
  const action = form.get('action');

  // Permission first, before any field is read: a viewer's POST is refused whatever it says.
  if (USER_ACTIONS.has(action)) {
    if (!can(user, 'users')) throw new Error('hanya admin yang bisa mengelola pengguna');
  } else if (!can(user, 'write')) {
    throw new Error(`peran ${ROLES[user.role]?.label ?? user.role} hanya bisa melihat, tidak mengubah`);
  }

  if (action === 'ledger') {
    const sku = String(form.get('sku') ?? '').trim();
    const qty = Number(form.get('qty'));
    if (!sku) throw new Error('SKU kosong');
    if (!Number.isInteger(qty) || qty < 0) throw new Error('jumlah harus bilangan bulat >= 0');

    const ledger = (await loadLedger().catch(() => null)) ?? emptyLedger();
    const before = ledger.skus[sku]?.qty ?? null;
    const updated = setSku(ledger, sku, { qty, needs_review: false, source: `manual:${user.email}` });
    await saveLedger(updated);
    // The stock view must show the number that was just saved, not a cached one.
    invalidate('catalog');
    invalidate('ledger');
    console.log(`dashboard: ledger ${sku} -> ${qty}`);
    return {
      view: 'products', message: `Ledger ${sku} disetel ke ${qty}`,
      audit: { menu: 'products', verb: 'edit', target: sku, summary: `Mengubah stok ledger ${sku} dari ${before ?? '—'} menjadi ${qty}`, changes: [{ field: `stok ${sku}`, from: before, to: qty }] },
    };
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
      audit: {
        menu: 'products', verb: 'sync', target: `${result.attempted} listing`,
        summary: `Menulis stok ledger ke marketplace: ${result.succeeded} berhasil, ${result.failed} gagal`,
        changes: result.results.map((r) => ({ field: `${r.sku} @ ${CHANNEL_LABEL[r.channel] ?? r.channel}`, from: r.from, to: r.to, note: r.status === 'failed' ? r.error : '' })),
      },
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
    const changes = [];
    for (const { sku, qty } of edits) {
      // Only write what actually moved - unless the operator vouched for it, which is
      // itself the change: the row stops being a seed and becomes a deliberate number.
      const before = ledger.skus[sku]?.qty ?? null;
      if (before === qty && !vouched.has(sku)) continue;
      ledger = setSku(ledger, sku, { qty, needs_review: false, source: `manual:${user.email}` });
      changes.push({ field: sku, from: before, to: qty, note: before === qty ? 'dikonfirmasi manual' : '' });
      written += 1;
    }
    if (written === 0) return { view: 'stock', message: 'Tidak ada nilai yang berubah' };

    await saveLedger(ledger);
    invalidate('ledger');
    invalidate('catalog');
    console.log(`dashboard: ledger_batch ${written} skus`);
    return {
      view: 'stock', message: `${written} stok disimpan ke ledger`,
      audit: { menu: 'stock', verb: 'edit', target: `${written} SKU`, summary: `Mengubah stok ledger ${written} SKU: ${changes.slice(0, 3).map((c) => `${c.field} ${c.from ?? '—'}→${c.to}`).join(', ')}${changes.length > 3 ? ', …' : ''}`, changes },
    };
  }

  if (action === 'mass_arrange') {
    const SELECTION = /^(tokopedia|tiktok_shop|shopee|shopify):([A-Za-z0-9_#-]{1,64})$/;
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

    // What Shopee needs per parcel, read before anything is booked. An instant courier
    // dispatches a driver, and Shopee will not take the order until it is told when -
    // so the operator is asked, once, for the whole batch.
    const plans = await planArrangement(eligible);
    const chosen = {};
    for (const [key, value] of form) {
      if (key.startsWith('slot:')) chosen[key.slice('slot:'.length)] = String(value).trim();
    }
    const waiting = eligible.filter((o) => needsPickupTime(plans[o.id]) && !chosen[o.id]);
    if (waiting.length > 0) {
      console.log(`dashboard: mass_arrange menunggu waktu jemput untuk ${waiting.length} pesanan`);
      return { view: 'process', html: await pickupStep({ user, csrf, eligible, waiting, plans, chosen }) };
    }

    const result = await massArrange(eligible, { pickupTimes: chosen, methods: plans });
    invalidate('orders');
    console.log(`dashboard: mass_arrange ${result.succeeded} ok, ${result.failed} failed`);

    const failed = result.results.filter((r) => r.status === 'failed');
    return {
      view: 'process',
      message: failed.length === 0
        ? `${result.succeeded} pesanan berhasil diatur pengirimannya`
        : `${result.succeeded} berhasil, ${failed.length} gagal - ${failed[0].id}: ${failed[0].error}`,
      audit: {
        menu: 'process', verb: 'send', target: `${eligible.length} pesanan`,
        summary: `Mengatur pengiriman ${eligible.length} pesanan: ${result.succeeded} berhasil${failed.length ? `, ${failed.length} gagal` : ''}`,
        changes: result.results.map((r) => ({ field: `${r.channel} ${r.id}`, to: r.status === 'ok' ? 'diatur pengirimannya' : 'gagal', note: r.error ?? '' })),
      },
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
    const tracking = String(form.get('tracking') ?? '').trim();
    return {
      view: 'process', message: `${id} berhasil diproses`,
      audit: {
        menu: 'process', verb: 'send', target: `${channel} ${id}`,
        summary: `Memproses pesanan ${id} (${op})${tracking ? ` dengan resi ${tracking}` : ''}`,
        changes: [
          { field: 'tindakan', to: op },
          ...(tracking ? [{ field: 'resi', from: order.tracking || null, to: tracking }] : []),
          ...(form.get('company') ? [{ field: 'kurir', from: order.carrier || null, to: String(form.get('company')).trim() }] : []),
        ],
      },
    };
  }

  if (action === 'label_printed') {
    // Clearing a backlog, not printing one: the orders that were handled before this
    // ledger existed have to be able to say so, or they ask for a label forever.
    const ids = form.getAll('order')
      .map((value) => String(value))
      .filter((value) => value.startsWith('shopify:') || value.startsWith('manual:'))
      .map((value) => value.slice(value.indexOf(':') + 1));
    if (ids.length === 0) throw new Error('tidak ada pesanan Shopify yang dipilih');
    if (ids.length > 200) throw new Error('terlalu banyak sekaligus');

    await markPrinted(ids, { by: user.email });
    console.log(`dashboard: label_printed ${ids.length} shopify orders`);
    return {
      view: 'labels', message: `${ids.length} pesanan Shopify ditandai sudah dicetak`,
      audit: {
        menu: 'labels', verb: 'edit', target: `${ids.length} pesanan`,
        summary: `Menandai ${ids.length} label Shopify sebagai sudah dicetak tanpa mencetak`,
        changes: ids.map((id) => ({ field: id, to: 'sudah dicetak' })),
      },
    };
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
      audit: {
        menu: 'products', verb: 'edit', target: sku,
        summary: `Mengubah harga ${sku} menjadi Rp${price.toLocaleString('id-ID')} di ${ok} listing${failed.length ? `, ${failed.length} gagal` : ''}`,
        changes: results.map((r) => ({ field: `harga @ ${CHANNEL_LABEL[r.channel] ?? r.channel}`, from: r.from, to: r.to, note: r.status === 'failed' ? r.error : '' })),
      },
    };
  }

  if (action === 'reviews_sync') {
    // The same two readers the nightly job runs, in quick mode: each walks newest-first
    // and stops at the first review it already holds, so a fresh pull is a few requests.
    const outcomes = {};
    for (const [channel, run] of [['tokopedia', syncTokopediaReviews], ['shopee', syncShopeeReviews]]) {
      try {
        outcomes[channel] = await run({ quick: true, prefetch: true });
      } catch (error) {
        outcomes[channel] = { error: error.message };
      }
    }
    invalidate('reviews');
    // Both readers hand back the new reviews themselves, not a count.
    const newOf = (r) => (Array.isArray(r.added) ? r.added.length : Number(r.added) || 0);
    const said = Object.entries(outcomes).map(([channel, r]) => (r.error
      ? `${REVIEW_CHANNELS[channel].label} gagal (${r.error})`
      : `${REVIEW_CHANNELS[channel].label} +${newOf(r)} baru`)).join(', ');
    const failed = Object.values(outcomes).filter((r) => r.error).length;
    const added = Object.values(outcomes).reduce((n, r) => n + (r.error ? 0 : newOf(r)), 0);
    if (failed === 2) throw new Error(said);
    return {
      view: 'reviews',
      message: `Ulasan diperbarui: ${said}`,
      kind: failed ? 'error' : 'ok',
      audit: {
        menu: 'reviews', verb: 'sync', target: 'Tokopedia + Shopee',
        summary: `Mengambil ulasan baru: ${said}`,
        changes: Object.entries(outcomes).map(([channel, r]) => ({ field: REVIEW_CHANNELS[channel].label, to: r.error ? `gagal: ${r.error}` : `${r.total ?? 0} tersimpan, ${newOf(r)} baru` })),
      },
      ...(added > 0 ? { celebrate: `${added} ulasan baru` } : {}),
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
    // Read live rather than from the database, even though the database is usually ahead
    // of nothing at all: this writes to the books, and the one place worth paying full
    // price for the freshest possible answer is the one where being a minute stale posts
    // a wrong number. The read is kept afterwards so it is not wasted.
    const live = await collectOrders({ range, tracking: false });
    const { orders } = live;
    await rememberOrders(live, range);
    const accounts = await postingAccounts();

    const ledgerNow = await loadSyncLedger();
    await ensureReady({ dryRun: false, readyAt: ledgerNow.ready_at ?? null });
    // Sized to Jurnal's quota, like the sweep; whatever does not fit is picked up by the
    // next scheduled sweep, and the message says so rather than implying it was all sent.
    const result = await runSync({ orders, accounts, dryRun: false, limit: 15, deadlineMs: 80_000 });
    invalidate('jurnal');

    if (result.skipped) return { view: 'jurnal', message: 'Sinkronisasi lain sedang berjalan' };
    const failed = result.results.filter((r) => r.status === 'failed' || r.status === 'mismatch');
    await notifySyncFailures({ source: 'tombol Kirim di dashboard', results: result.results });
    console.log(`dashboard: mekari_sync ${result.created} created, ${result.exists} existing, ${result.failed} failed, ${result.deferred} deferred`);
    // `remaining` already counts the deferred ones: it is the backlog minus what this run
    // actually got into the ledger, so adding them again told the operator twice as many
    // sales were still waiting as there were.
    const later = result.remaining;
    return {
      view: 'jurnal',
      message: failed.length === 0
        ? `${result.created} faktur dibuat di Jurnal${result.exists ? `, ${result.exists} sudah ada` : ''}` +
          (result.voided ? `, ${result.voided} dibatalkan dihapus` : '') +
          (later > 0 ? `, ${later} sisanya dikirim sapuan otomatis berikutnya` : '')
        : `${result.created} berhasil, ${failed.length} bermasalah - ${failed[0].customId}: ${failed[0].error}`,
      audit: {
        menu: 'jurnal', verb: 'sync', target: `${result.created} faktur`,
        summary: `Mengirim penjualan ke Jurnal: ${result.created} faktur dibuat, ${result.exists ?? 0} sudah ada, ${failed.length} bermasalah${later > 0 ? `, ${later} menunggu sapuan` : ''}`,
        changes: result.results.filter((r) => r.status !== 'exists').map((r) => ({ field: r.customId ?? r.id ?? '?', to: r.status, note: r.error ?? '' })),
      },
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
      // Whether that number meant rupiah or percent. The server does the arithmetic.
      discountMode: form.getAll('discountMode')[index],
    }));

    // The memo Jurnal shows ends with who typed the sale in: the invoice then carries its
    // own provenance, and finance does not have to come back here to ask.
    const order = buildManualOrder({
      source: form.get('source'),
      code: form.get('code'),
      date: form.get('date'),
      note: form.get('note'),
      addedBy: user.name || user.email,
      shipping: form.get('shipping'),
      // Who the parcel goes to and how, which is not always who the invoice bills.
      buyer: form.get('buyer'),
      buyerPhone: form.get('buyerPhone'),
      buyerEmail: form.get('buyerEmail'),
      shipTo: form.get('shipTo'),
      carrier: form.get('carrier'),
      lines,
    });

    // The code must not already be booked. The ledger is read fresh, not from the cache,
    // because the case this guards against is a double submit seconds apart - and the
    // idempotency key in Jurnal is the last line behind this one, not the first.
    const ledger = await loadSyncLedger().catch(() => ({ orders: {} }));
    if (manualCodes(ledger).includes(order.id)) {
      throw new Error(`kode ${order.id} sudah dipakai transaksi lain; buka formulir lagi untuk kode baru`);
    }

    // A typed-in sale is never auto-paid, so the chart only matters for the shape of the
    // payload - but it is read all the same, so manual and marketplace go through one path.
    const accounts = await postingAccounts();
    const built = buildInvoice({ order, accounts });
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

    const result = await postManual({ order, accounts, dryRun: false });
    if (result.status === 'failed') {
      await notifySyncFailures({ source: 'transaksi manual', results: [result] });
      throw new Error(`${order.id}: ${result.error}`);
    }
    invalidate('jurnal');
    console.log(`dashboard: manual_invoice ${order.id} -> ${result.status}`);

    // The order list and the invoice printer both read the orders table, and nothing
    // else will ever put a typed-in sale there. Best effort: the sale is in Jurnal, which
    // is the record; a table that refuses it is a warning, not a failed save.
    if (isSupabaseConfigured()) {
      try {
        const saved = await saveOrders([order], { source: 'manual' });
        if (saved.rejected.length > 0) console.warn(`dashboard: manual_invoice ${order.id} ditolak tabel pesanan - ${saved.rejected[0].error}`);
        invalidate('orders:');
      } catch (error) {
        console.warn(`dashboard: manual_invoice ${order.id} tidak tersimpan ke tabel pesanan - ${error.message}`);
      }
    }

    return {
      view: 'orders',
      message: result.status === 'exists'
        ? `${order.id} sudah ada di Jurnal, tidak dibuat dua kali`
        : `${order.id} tersimpan di Jurnal senilai Rp${built.expectedTotal.toLocaleString('id-ID')}`,
      // A sale typed in by hand is the one write on this dashboard that is entirely the
      // operator's own work, so it gets the one moment of celebration.
      celebrate: result.status === 'exists' ? null : 'Tersimpan di Jurnal',
      audit: {
        menu: 'jurnal', verb: 'add', target: order.id,
        summary: `Menambah transaksi manual ${order.id} (${order.source}) untuk ${order.customer} senilai Rp${built.expectedTotal.toLocaleString('id-ID')}${result.status === 'exists' ? ' (sudah ada di Jurnal)' : ''}`,
        changes: [
          { field: 'pelanggan', to: order.customer },
          ...(order.buyer ? [{ field: 'penerima', to: order.buyer }] : []),
          ...(order.buyerPhone ? [{ field: 'telepon', to: order.buyerPhone }] : []),
          ...(order.buyerEmail ? [{ field: 'email', to: order.buyerEmail }] : []),
          ...(order.shipTo ? [{ field: 'alamat', to: order.shipTo }] : []),
          ...(order.carrier ? [{ field: 'kurir', to: order.carrier }] : []),
          { field: 'tanggal', to: form.get('date') },
          { field: 'keterangan', to: order.note },
          { field: 'ongkir', to: order.finance.shipping },
          ...order.finance.lines.map((l) => ({
            field: l.sku,
            to: `${l.qty} × Rp${Number(l.unitPrice).toLocaleString('id-ID')}${l.unitDiscount
              ? ` − ${l.discountPercent !== undefined ? `${l.discountPercent}% (Rp${Number(l.unitDiscount).toLocaleString('id-ID')})` : `Rp${Number(l.unitDiscount).toLocaleString('id-ID')}`}`
              : ''}`,
          })),
          { field: 'total', to: built.expectedTotal },
        ],
      },
    };
  }

  /* ------------------------------------------------------------- users */

  if (action === 'user_invite') {
    const by = { id: user.id, email: user.email, name: user.name };
    const { user: invited, token } = await inviteUser({ email: form.get('email'), name: form.get('name'), role: form.get('role'), by });
    const audit = {
      menu: 'users', verb: 'invite', target: invited.email,
      summary: `Mengundang ${invited.name} (${invited.email}) sebagai ${ROLES[invited.role].label}`,
      changes: [{ field: 'nama', to: invited.name }, { field: 'email', to: invited.email }, { field: 'peran', to: ROLES[invited.role].label }, { field: 'status', to: STATUS.invited }],
    };
    try {
      await deliverInvitation({ user: invited, token, by });
    } catch (error) {
      console.error(`dashboard: undangan ${invited.email} dibuat tapi email gagal: ${error.message}`);
      return {
        view: 'users', kind: 'error',
        message: `${invited.name} tercatat, tapi email gagal dikirim (${error.message}). Perbaiki SMTP lalu tekan "Kirim ulang".`,
        audit: { ...audit, summary: `${audit.summary} - email gagal dikirim`, changes: [...audit.changes, { field: 'email undangan', to: 'gagal', note: error.message }] },
      };
    }
    console.log(`dashboard: invited ${invited.email} as ${invited.role}`);
    return { view: 'users', message: `Undangan terkirim ke ${invited.email}`, audit };
  }

  if (action === 'user_resend') {
    const by = { id: user.id, email: user.email, name: user.name };
    const { user: invited, token } = await renewInvite(String(form.get('id') ?? ''), by);
    await deliverInvitation({ user: invited, token, by });
    console.log(`dashboard: re-invited ${invited.email}`);
    return {
      view: 'users', message: `Undangan baru terkirim ke ${invited.email}`,
      audit: { menu: 'users', verb: 'send', target: invited.email, summary: `Mengirim ulang undangan ke ${invited.name} (${invited.email})`, changes: [{ field: 'tautan undangan', to: 'diperbarui, berlaku 72 jam' }] },
    };
  }

  if (action === 'user_role') {
    const id = String(form.get('id') ?? '');
    if (id === user.id) throw new Error('peran sendiri tidak bisa diubah');
    const { before, after } = await updateUser(id, { role: String(form.get('role') ?? '') });
    if (before.role === after.role) return { view: 'users', message: `Peran ${after.name} tidak berubah` };
    return {
      view: 'users', message: `${after.name} sekarang ${ROLES[after.role].label}`,
      audit: { menu: 'users', verb: 'edit', target: after.email, summary: `Mengubah peran ${after.name} dari ${ROLES[before.role].label} menjadi ${ROLES[after.role].label}`, changes: [{ field: 'peran', from: ROLES[before.role].label, to: ROLES[after.role].label }] },
    };
  }

  if (action === 'user_status') {
    const id = String(form.get('id') ?? '');
    if (id === user.id) throw new Error('status sendiri tidak bisa diubah');
    const status = String(form.get('status') ?? '');
    const { before, after } = await updateUser(id, { status });
    const verb = after.status === 'disabled' ? 'delete' : 'edit';
    return {
      view: 'users', message: after.status === 'disabled' ? `${after.name} dinonaktifkan; sesinya berakhir` : `${after.name} aktif kembali`,
      audit: { menu: 'users', verb, target: after.email, summary: `${after.status === 'disabled' ? 'Menonaktifkan' : 'Mengaktifkan kembali'} ${after.name} (${after.email})`, changes: [{ field: 'status', from: STATUS[before.status], to: STATUS[after.status] }] },
    };
  }

  if (action === 'user_delete') {
    const id = String(form.get('id') ?? '');
    if (id === user.id) throw new Error('tidak bisa menghapus diri sendiri');
    const removed = await removeUser(id);
    return {
      view: 'users', message: `${removed.name} dihapus`,
      audit: { menu: 'users', verb: 'delete', target: removed.email, summary: `Menghapus pengguna ${removed.name} (${removed.email}, ${ROLES[removed.role]?.label ?? removed.role})`, changes: [{ field: 'status', from: STATUS[removed.status] ?? removed.status, to: 'dihapus' }] },
    };
  }

  throw new Error(`aksi tidak dikenal: ${action}`);
}

/** A failed action still tells the story: who tried what, and why it was refused. */
const failureTarget = (form) =>
  ['sku', 'order', 'code', 'email', 'id'].map((k) => form.get(k)).find((v) => v && String(v).trim()) ?? '';

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

  const ip = callerIp(req);
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies[COOKIE_NAME];

  if (url.searchParams.has('logout')) {
    const leaving = await authenticate(session);
    if (leaving) await recordActivity({ actor: leaving, ip, menu: 'auth', action: 'logout', verb: 'logout', summary: `${leaving.name} keluar` });
    redirect(PATH, { 'Set-Cookie': clearedCookie() });
    return;
  }

  // Who is asking. Null on every path that is not signed in, including a cookie whose
  // user has since been disabled or deleted.
  const user = await authenticate(session);

  // An authenticated POST is a write action, not a login attempt.
  if (req.method === 'POST' && user) {
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

    const action = String(form.get('action') ?? '');
    try {
      const outcome = await handleWrite(form, ip, user, csrfToken(session));
      // A step that only asks a question renders rather than redirects, and writes
      // nothing to the log: nothing has happened yet.
      if (outcome.html) {
        send(200, outcome.html);
        return;
      }
      if (outcome.audit) await recordActivity({ actor: user, ip, action, status: 'ok', ...outcome.audit });
      redirect(`${PATH}?view=${outcome.view}&${outcome.kind === 'error' ? 'error' : 'done'}=${encodeURIComponent(outcome.message)}${
        outcome.celebrate ? `&yay=${encodeURIComponent(outcome.celebrate)}` : ''}`);
    } catch (error) {
      console.error(`dashboard: write failed - ${error.message}`);
      await recordActivity({
        actor: user, ip, action, status: 'failed', error: error.message,
        menu: ACTION_MENU[action] ?? (form.get('view') || 'products'), verb: 'edit', target: failureTarget(form),
        summary: `Aksi ${action || '?'} ditolak`,
      });
      redirect(`${PATH}?view=${form.get('view') || ACTION_MENU[action] || 'products'}&error=${encodeURIComponent(error.message)}`);
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
    const account = await login(email, form.get('password'));
    if (!account) {
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
    await touchLogin(account.id);
    await recordActivity({ actor: account, ip, menu: 'auth', action: 'login', verb: 'login', summary: `${account.name} masuk` });
    redirect(here, { 'Set-Cookie': sessionCookie(issueSession(account)) });
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

  if (!user) {
    send(401, renderLogin({ redirectTo: here }));
    return;
  }

  // The reload button carries ?retry=<timestamp>; honour it by dropping the cached copy
  // so the click actually reaches the marketplace instead of replaying the same failure.
  if (url.searchParams.has('retry')) invalidate();

  const requestedView = url.searchParams.get('view') ?? 'orders';
  // The stock tab was folded into products; old links and bookmarks still land somewhere useful.
  const view = Object.hasOwn(VALID_VIEWS, requestedView) ? requestedView : 'orders';
  // Page and page size come from the URL, and every page link is the current URL with
  // only those two changed - so filters, range and page survive reload and history.
  const paging = parsePaging(url.searchParams);
  const baseQuery = withoutPaging(url.searchParams);

  const flash = url.searchParams.get('done')
    ? { kind: 'ok', text: url.searchParams.get('done'),
        celebrate: url.searchParams.get('yay') ? { title: url.searchParams.get('yay') } : null }
    : url.searchParams.get('error')
      ? { kind: 'error', text: url.searchParams.get('error') }
      : null;
  const csrf = csrfToken(session);

  try {
    if (view === 'users') {
      if (!can(user, 'users')) {
        send(403, dashboardError('Tidak berwenang', 'Hanya admin dan pemilik yang bisa membuka halaman pengguna.'));
        return;
      }
      const users = await listUsers();
      console.log(`dashboard/users: ${users.length} pengguna`);
      send(200, renderUsers({
        users, me: user, smtpReady: isSmtpConfigured(), range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash,
      }));
      return;
    }

    if (view === 'activity') {
      const filter = {
        actor: url.searchParams.get('actor') ?? '',
        menu: Object.hasOwn(MENUS, url.searchParams.get('menu') ?? '') ? url.searchParams.get('menu') : '',
        status: ['ok', 'failed'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '',
        q: url.searchParams.get('q') ?? '',
      };
      // The people list comes from the unfiltered range, so picking one person does not
      // make everyone else vanish from the dropdown.
      const all = await readActivity({ from: range.from, to: range.to });
      const entries = filter.actor || filter.menu || filter.status || filter.q ? await readActivity({ from: range.from, to: range.to, ...filter }) : all;
      console.log(`dashboard/activity: ${entries.length} of ${all.length} entries for ${range.label}`);
      send(200, renderActivity({
        entries, actors: actorsIn(all), filter, paging, baseQuery, user,
        range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash,
      }));
      return;
    }

    if (view === 'stock') {
      const [catalog, ledger] = await Promise.all([
        cached('catalog', CATALOG_TTL_MS, readCatalogSafely, SWR),
        cached('ledger', LEDGER_TTL_MS, () => loadLedger().catch(() => null), SWR),
      ]);
      const plan = ledger && Object.keys(catalog.errors ?? {}).length === 0
        ? planSync({ ledger, catalog })
        : null;
      console.log(`dashboard/stock: ${catalog.skus.length} skus`);
      send(200, renderStock({ user,
        catalog, ledger, plan, errors: catalog.errors, range, shopeeShop: null,
        generatedAt: Date.now(), csrf, flash,
        filter: url.searchParams.get('filter') ?? 'all',
      }));
      return;
    }

    if (view === 'products') {
      const [catalog, ledger] = await Promise.all([
        cached('catalog', CATALOG_TTL_MS, readCatalogSafely, SWR),
        cached('ledger', LEDGER_TTL_MS, () => loadLedger().catch(() => null), SWR),
      ]);
      // A plan built from a partial catalogue could zero live SKUs, so it is only
      // computed when both channels answered.
      const plan = ledger && Object.keys(catalog.errors ?? {}).length === 0
        ? planSync({ ledger, catalog })
        : null;
      console.log(`dashboard/products: ${catalog.skus.length} skus${catalog.stale ? ' (stale)' : ''}`);
      send(200, renderProducts({ user,
        catalog, ledger, plan, errors: catalog.errors, range, shopeeShop: null,
        generatedAt: Date.now(), csrf, flash,
        selected: url.searchParams.get('sku') ?? null,
        images: await imagesByKey(),
      }));
      return;
    }

    if (view === 'jurnal' && url.searchParams.get('add') === '1') {
      const ledger = await cached('jurnal', LEDGER_TTL_MS, () => loadSyncLedger().catch(() => ({ orders: {} })), SWR);
      const used = manualCodes(ledger);
      const source = url.searchParams.get('source') ?? 'CS';
      // The contact list is a convenience, not a requirement: a Jurnal that will not
      // answer must not stop someone entering a sale they have in their hand.
      const contacts = await listContacts().then((m) => [...m.keys()].sort()).catch(() => []);
      // Reserved now, inside a store transaction, so this form and any other open at the
      // same moment hold different numbers. An abandoned form leaves a gap, never a repeat.
      const sequence = await reserveManualSequence();
      const today = wibDate(Math.floor(Date.now() / 1000));

      send(200, renderManual({ user,
        range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash,
        source, code: formatManualCode(source, today, sequence), seqTail: encodeSequence(sequence), today,
        contacts, existingCodes: used, images: await imagesByKey(),
        // Shopify's own prices, read from our store rather than from Shopify: the form
        // must open at the same speed whether or not Shopify is answering today.
        prices: await cached('shopify-prices', 5 * 60_000, () => priceBySku().catch(() => ({})), SWR),
        live: process.env.MEKARI_SYNC_LIVE === '1',
      }));
      return;
    }

    // The forecast is a document written by a nightly job; the page only reads it, so it
    // costs one lookup and never waits on a marketplace.
    if (view === 'forecast') {
      const forecast = await cached('forecast', 60_000, () => loadForecast().catch(() => null), SWR);
      console.log(`dashboard/forecast: ${forecast?.rows?.length ?? 0} sku`);
      send(200, renderForecast({ user,
        forecast, range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash,
      }));
      return;
    }

    // Reviews are documents the nightly syncs wrote; reading them costs two lookups and
    // never touches a marketplace from a web request.
    if (view === 'reviews') {
      const doc = await cached('reviews', 60_000, () => loadAllReviews().catch(() => null), SWR);
      const channelParam = url.searchParams.get('channel') ?? '';
      const filter = {
        channel: REVIEW_CHANNELS[channelParam] ? channelParam : '',
        rating: url.searchParams.get('rating') ?? '',
        days: url.searchParams.get('days') ?? '',
        sku: url.searchParams.get('sku') ?? '',
        text: url.searchParams.get('text') === '1',
      };
      const days = Number(filter.days) || 0;
      const reviews = doc ? selectReviews(doc, {
        channel: filter.channel || undefined,
        ratings: filter.rating ? filter.rating.split(',').map(Number).filter((n) => n >= 1 && n <= 5) : undefined,
        sku: filter.sku || undefined,
        sinceEpoch: days ? Math.floor(Date.now() / 1000) - days * 86400 : undefined,
        withText: filter.text,
      }) : [];
      // The Klaviyo file: whatever the filters left, in the import template. Logged like
      // a print, because a file of two thousand reviews left the building.
      if (url.searchParams.get('export') === 'klaviyo') {
        const perReviewer = url.searchParams.get('email') !== 'shared';
        const csv = toKlaviyoCsv(reviews, { perReviewer });
        const summary = klaviyoSummary(reviews);
        await recordActivity({
          actor: user, ip, menu: 'reviews', action: 'export_klaviyo', verb: 'print', target: `${reviews.length} ulasan`,
          summary: `Mengunduh CSV Klaviyo: ${reviews.length} ulasan, ${summary.unmapped} tanpa produk`,
          changes: Object.entries(summary.byProduct).map(([name, n]) => ({ field: name, to: n })),
        });
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Disposition', `attachment; filename="klaviyo-reviews-${new Date().toISOString().slice(0, 10)}.csv"`);
        res.end(csv);
        return;
      }
      console.log(`dashboard/reviews: ${reviews.length} of ${Object.keys(doc?.reviews ?? {}).length}, page ${paging.page}`);
      send(200, renderReviews({ user,
        doc, stats: doc ? reviewStats(doc) : null, reviews, filter, paging, baseQuery,
        range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash,
      }));
      return;
    }

    // One entry per range for every menu: the picklist and the ledger used to ask for a
    // copy without tracking numbers and paid for a second database read to get it. The
    // worklists ignore the range entirely and read by stage instead.
    const started = Date.now();
    const data = OUTSTANDING_VIEWS.has(view) ? await outstandingOrders() : await ordersFor(range);
    const took = () => `${Date.now() - started}ms`;

    if (view === 'labels') {
      // Shopify prints are remembered here, not there; the page cannot tell what still
      // needs a label without it.
      const printed = await printedLabels().catch(() => ({}));
      console.log(`dashboard/labels: ${data.orders.length} orders outstanding (${took()})`);
      send(200, renderLabels({ user,
        ...data, range, csrf, flash, sizes: LABEL_SIZES, defaultSize: DEFAULT_SIZE, printed,
        showReprints: url.searchParams.get('reprint') === '1',
      }));
      return;
    }

    if (view === 'process') {
      // Arranging a Shopify order calls nothing, so only this says it has been done.
      const arranged = await arrangedOrders().catch(() => ({}));
      console.log(`dashboard/process: ${data.orders.length} orders outstanding (${took()})`);
      send(200, renderProcess({ user, ...data, range, csrf, flash, arranged }));
      return;
    }

    if (view === 'jurnal') {
      const [ledger, heartbeat] = await Promise.all([
        cached('jurnal', LEDGER_TTL_MS, () => loadSyncLedger().catch(() => ({ orders: {} })), SWR),
        // Not cached: its whole point is to say what happened in the last few minutes.
        loadHeartbeat(),
      ]);
      const overview = syncOverview({ orders: data.orders, ledger, accounts: await postingAccounts().catch(() => null) });
      console.log(`dashboard/jurnal: ${overview.synced} synced, ${overview.queued} queued, ${overview.broken} broken`);
      send(200, renderJurnal({ user,
        ...data, overview, csrf, flash, depositTo: POOLED_LABEL, heartbeat, paging, baseQuery,
        live: process.env.MEKARI_SYNC_LIVE === '1',
        configured: isMekariConfigured(),
      }));
      return;
    }

    if (view === 'picklist') {
      const picklist = buildPicklist(data.orders);
      console.log(`dashboard/picklist: ${picklist.unitCount} units across ${picklist.skuCount} skus (${took()})`);
      send(200, renderPicklist({ user, ...data, range, picklist }));
      return;
    }

    const summary = summarize(data.orders);
    const filter = {
      channel: url.searchParams.get('channel') ?? 'all',
      stage: url.searchParams.get('stage') ?? 'all',
      q: url.searchParams.get('q') ?? '',
    };
    const orders = filterOrders(data.orders, filter);
    console.log(`dashboard: ${data.orders.length} orders for ${range.label}, ${orders.length} match, page ${paging.page}, errors=${Object.keys(data.errors).join(',') || 'none'} (${took()})`);
    send(200, renderDashboard({ user, ...data, orders, summary, filter, paging, baseQuery, flash }));
  } catch (error) {
    console.error(`dashboard: render failed - ${error.message}`);
    send(502, dashboardError('Could not load orders', error.message));
  }
}
