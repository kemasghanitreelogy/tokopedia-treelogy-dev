import { collectOrders, summarize } from '../src/omni.js';
import { loadOrders, loadOutstanding, rememberOrders } from '../src/orders-source.js';
import { isSupabaseConfigured } from '../src/db/client.js';
import { saveOrders } from '../src/db/orders.js';
import { renderDashboard, renderPicklist, renderProducts, renderLabels, renderLabelLookup, renderProcess, renderStock, renderJurnal, renderManual, renderForecast, renderReviews, renderExpressLog, renderLogin, dashboardError, renderOrderPicks, VALID_VIEWS } from '../src/dashboard-page.js';
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
import { runAction, massArrange, planArrangement, needsSettling, settleable, oldestRead } from '../src/fulfillment.js';
import { needsPickupTime } from '../src/shopee/pickup.js';
import { fetchOrdersByIds } from '../src/omni.js';
import { LABEL_SIZES, DEFAULT_SIZE, printedEntry } from '../src/labels.js';
import { printedLabels, markPrinted, markLabelStale, arrangedOrders } from '../src/shopify/label.js';
import { ringExpressBacklog } from '../src/alerts-express.js';
import { refreshOrders, refreshOneOrder, RESHIPS, diffOrder } from '../src/orders-refresh.js';
import { discardManual } from '../src/mekari/discard.js';
import { amendManualInvoice } from '../src/mekari/amend.js';
import { orderById, ordersByIds, ordersMatchingId, ID_SEARCH_MIN } from '../src/db/orders.js';

/**
 * Which typed-in sources can be corrected in place rather than deleted and re-entered.
 *
 * WhatsApp alone, by decision. It is the one whose order is agreed in a conversation that
 * keeps going - a jar added, an address corrected - while a consignment slip or a walk-in
 * is written down after the fact from something that already happened. Widening this is
 * one entry; it is deliberately not wide.
 */
const EDITABLE_SOURCES = new Set(['DP']);

/** One Shopee detail call takes fifty ids; a worklist never needs more than a handful. */
const SETTLE_MAX = 20;
/**
 * A floor between settlings, so reloading a page twice does not read twice.
 *
 * Shared by every worklist because they are drawn from one set of rows: settling for the
 * process view settles the picklist and the labels with it.
 */
const SETTLE_COOLDOWN_MS = 45_000;
let settledAt = 0;

/**
 * Bring the rows somebody is about to act on back in line with their platforms.
 *
 * Every screen here is drawn from our own table, which is what makes it fast and what
 * lets it survive a marketplace being down. The price is that a row describes the moment
 * it was read - and Shopee's pushes, which cannot be verified and are rate limited per
 * shop, are missed often enough for that moment to be hours ago.
 *
 * 2609287GUBMJ7N is what that costs. Stored as arrangeable with no courier; Shopee had
 * it CANCELLED with GrabExpress Instant and a dead package. It sat at the top of the
 * worklist, pre-ticked, counted in "Atur pengiriman 54 pesanan" - one click from being
 * arranged, and it no longer existed.
 *
 * Bounded three ways: only rows that are actionable, only the oldest of those, and at
 * most once every forty-five seconds however many times the page is opened. Marketplace
 * budget, never Jurnal's.
 */
async function settleWorklist(data, arranged, { now = Date.now() } = {}) {
  /*
   * The age reported is the age of the rows this page acts on, not of everything it
   * loaded. The first cut took the oldest of all 216 outstanding orders and announced
   * "baris tertua dibaca 5 jam lalu" on a page whose every actionable row was minutes
   * old - a warning about parcels already in transit, which are as stale as they like.
   * A banner that cries wolf is a banner that gets ignored, which is the failure mode
   * this whole change exists to avoid.
   */
  const done = (orders) => oldestRead(settleable(orders, arranged));

  const due = now - settledAt > SETTLE_COOLDOWN_MS;
  const wanted = due ? needsSettling(data.orders, arranged, { now, max: SETTLE_MAX }) : [];
  if (wanted.length === 0) return { data, settled: 0, failed: false, readAt: done(data.orders) };

  settledAt = now;
  const result = await refreshOrders(wanted.map((o) => ({ channel: o.channel, id: o.id })));
  if (result.orders.length === 0) {
    // Nothing came back. The page is still drawn from what we have; it simply stays as
    // stale as it was, and says so rather than looking freshly read.
    return { data, settled: 0, failed: Boolean(result.error), readAt: done(data.orders) };
  }

  const byKey = new Map(result.orders.map((o) => [`${o.channel}:${o.id}`, o]));
  const orders = data.orders.map((o) => byKey.get(`${o.channel}:${o.id}`) ?? o);
  console.log(`dashboard: ${result.orders.length} dari ${wanted.length} baris kerja dibaca ulang dari platform`);
  return {
    data: { ...data, orders },
    settled: result.orders.length,
    failed: result.orders.length < wanted.length,
    readAt: done(orders),
  };
}
import { priceBySku } from '../src/shopify/prices.js';
import { buildPicklist } from '../src/picklist.js';
import { readCatalog } from '../src/inventory.js';
import { LISTING_CHANNELS, refOf, diffPatch, isManaged, UNMANAGED_MESSAGE } from '../src/listing.js';
import { findProduct, isBaseProduct } from '../src/master.js';
import { loadShopifyConfig } from '../src/shopify/config.js';
import { cleanProduct, saveMasterProduct, setMasterRemoved } from '../src/master-store.js';
import { CREATORS } from '../src/listing-create.js';
import { loadLedger, setSku, emptyLedger, LEDGER_PATHNAME } from '../src/ledger.js';
import { updateDoc } from '../src/store/index.js';
import { planSync, applySync, applyPrice, writeAudit, CHANNEL_LABEL } from '../src/stock-sync.js';
import { followAfterOrder, followStock } from '../src/stock-watch.js';
import { warehouseAfterOrder, loadWarehouse, recordMove } from '../src/warehouse-run.js';
import { renderWarehouse } from '../src/pages/warehouse.js';
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
import { buildManualOrder, buildResend, formatManualCode, encodeSequence, manualOutcome } from '../src/mekari/manual.js';
import { reserveManualSequence } from '../src/mekari/sequence.js';
import { buildInvoice, verifyInvoice } from '../src/mekari/invoice.js';
import { listContacts } from '../src/mekari/setup.js';
import { wibDate } from '../src/range.js';
import { channelToday, channelDate } from '../src/clock.js';
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
/**
 * Put an existing product on a channel that does not sell it yet, from what it already
 * says elsewhere: the live listing's content and pictures, the master stock, the price it
 * sells for. The example listing is the one given, or one of the same kind.
 */
async function publishProduct(catalog, sku, channel, { templateId = null, draft = false, dims = null, weightGram = null } = {}) {
  const product = findProduct(sku);
  if (!product || !Object.hasOwn(CREATORS, channel)) throw new Error('SKU atau kanal tidak valid');
  if (!isManaged(channel)) throw new Error(UNMANAGED_MESSAGE);
  const entry = catalog.skus.find((e) => e.sku === product.sku);
  if (entry?.[channel]?.rows?.length) throw new Error(`sudah tayang di ${LISTING_CHANNELS[channel].label}`);
  const content = await listingContent(catalog, product.sku);
  if (!content?.data) throw new Error('belum tayang di kanal mana pun - buat lewat Tambah produk');
  // What the operator typed in for a box or weight the source does not have wins.
  const L = { ...content.data, ...(dims ? { dims } : {}), ...(weightGram ? { weightGram } : {}) };
  if (!L.weightGram) throw new Error('berat listing sumber tidak terbaca - isi beratnya di form publikasi');
  if (channel !== 'shopify' && !L.dims) throw new Error('dimensi paket belum ada - isi dimensinya di form publikasi');
  let template = /^\d+$/.test(String(templateId ?? '')) ? String(templateId) : null;
  if (channel !== 'shopify' && !template) {
    // One of the same kind if there is one; the first live listing otherwise.
    const pool = [];
    for (const e of catalog.skus) for (const row of e[channel]?.rows ?? []) pool.push({ id: channel === 'tiktok' ? row.productId : row.itemId, category: findProduct(e.sku)?.category });
    template = (pool.find((x) => x.category === product.category) ?? pool[0])?.id;
    if (!template) throw new Error(`belum ada listing contoh di ${LISTING_CHANNELS[channel].label}`);
  }
  const ledger = await loadLedger().catch(() => null);
  const price = Math.round(Number(entry?.tiktok?.price || entry?.shopee?.price || entry?.shopify?.price || 0));
  if (!(price >= 100)) throw new Error('harga sumber tidak terbaca');
  const stock = Math.max(1, Math.min(99999, Number(ledger?.skus?.[product.sku]?.qty) || entry?.tiktok?.qty || entry?.shopee?.qty || entry?.shopify?.qty || 1));
  const images = await downloadImages(L.images);
  if (images.length === 0) throw new Error('foto listing sumber tidak bisa diambil');
  const out = await CREATORS[channel]({
    sku: product.sku, title: L.title, description: L.description, price, stock, weightGram: L.weightGram, dims: L.dims ?? { l: 1, w: 1, h: 1 },
  }, images, { templateId: template, draft });
  return { ...out, price, stock };
}

/** Pictures sent with a form, checked the same way everywhere. */
async function imagesFrom(form) {
  const files = form.getAll('images').filter((f) => f && typeof f === 'object' && f.size > 0);
  if (files.length > 9) throw new Error('maksimal 9 foto');
  const out = [];
  for (const f of files) {
    if (!/^image\/(jpeg|png)$/i.test(f.type)) throw new Error(`${f.name}: hanya JPG atau PNG`);
    if (f.size > 10 * 1024 * 1024) throw new Error(`${f.name}: lebih dari 10 MB`);
    out.push({ buffer: Buffer.from(await f.arrayBuffer()), name: f.name, type: f.type });
  }
  return out;
}

/**
 * A live listing's pictures, fetched so another channel can be given the same ones.
 * Only JPEG and PNG are kept - what every channel's upload takes - and at most nine.
 */
async function downloadImages(urls = []) {
  const out = [];
  for (const [i, url] of urls.slice(0, 9).entries()) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      let type = String(res.headers.get('content-type') ?? '').split(';')[0];
      const buffer = Buffer.from(await res.arrayBuffer());
      // CDNs answer webp to a client that did not ask for it; sniff rather than trust.
      if (buffer[0] === 0xff && buffer[1] === 0xd8) type = 'image/jpeg';
      else if (buffer[0] === 0x89 && buffer[1] === 0x50) type = 'image/png';
      if (!/^image\/(jpeg|png)$/.test(type) || buffer.length > 10 * 1024 * 1024) continue;
      out.push({ buffer, name: `foto-${i + 1}.${type === 'image/png' ? 'png' : 'jpg'}`, type });
    } catch { /* one picture that will not come is not a reason to stop */ }
  }
  return out;
}

/**
 * What a listing says now, to fill the edit form: read from the first channel that sells
 * the SKU live, a minute at a time. Never fatal - a page that cannot read the listing
 * still shows everything else, and says the form could not be filled.
 */
async function listingContent(catalog, sku) {
  const master = findProduct(sku)?.sku ?? sku;
  const entry = catalog.skus.find((e) => e.sku === master);
  const source = ['tiktok', 'shopee', 'shopify'].find((c) => entry?.[c]?.rows?.length);
  if (!source) return null;
  try {
    const data = await cached(`listing:${master}`, 60_000, () => LISTING_CHANNELS[source].read(refOf(source, entry[source].rows[0])));
    return { source, data };
  } catch (error) {
    return { source, error: error.message };
  }
}

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
  const work = await outstandingOrders().catch((error) => {
    console.warn(`dashboard: pemanasan daftar pekerjaan gagal - ${error.message}`);
    return null;
  });

  // The safety net behind the webhook. Shopee's pushes cannot be verified and are rate
  // limited per shop, so a missed one is ordinary - and a missed push for an instant
  // order is the exact case the doorbell exists for. Nothing the webhook already rang is
  // rung again; the feed refuses a repeated key.
  if (work?.orders?.length) {
    await ringExpressBacklog(work.orders).catch((error) => console.warn(`alerts: sapuan express gagal - ${error.message}`));
  }
}

const catalogComplete = (catalog) => Object.keys(catalog.errors ?? {}).length === 0;
const readCatalogSafely = () =>
  withFallback('catalog', readCatalog, { isComplete: catalogComplete });

/** Which menu each action belongs to, for the activity log and the redirect after a failure. */
const ACTION_MENU = {
  ledger: 'products', apply: 'products', price: 'products', ledger_batch: 'stock',
  listing_edit: 'products', listing_active: 'products', product_create: 'products',
  product_save: 'products', product_publish: 'products',
  wh_move: 'stock',
  bulk_price: 'products', bulk_stock: 'products', bulk_active: 'products', bulk_publish: 'products', bulk_remove: 'products',
  product_master: 'products', product_remove: 'products',
  mass_arrange: 'process', fulfil: 'process', mekari_sync: 'jurnal', manual_invoice: 'jurnal',
  label_printed: 'labels', reviews_sync: 'reviews', refresh_order: 'orders', discard_manual: 'jurnal',
  manual_update: 'jurnal',
  user_invite: 'users', user_resend: 'users', user_role: 'users', user_status: 'users', user_delete: 'users',
};
const USER_ACTIONS = new Set(['user_invite', 'user_resend', 'user_role', 'user_status', 'user_delete']);

/**
 * Where a write sends the operator back to.
 *
 * A form may carry `back`, the query string the page was showing when it was submitted,
 * and then the answer lands on that same filter, range and search rather than on a bare
 * view. Parsed rather than concatenated: `view` and `done` have to win over whatever the
 * old string said, and a duplicated `view=` is read as the first one, which would be the
 * stale one. Anything the form sends is only ever read as query parameters, so it cannot
 * redirect anybody off this host.
 */
export function afterWrite(outcome, form) {
  // An outcome may name where it should land (a product just created has its own page);
  // otherwise the form says where it came from.
  const params = new URLSearchParams(String(outcome.back ?? form?.get('back') ?? '').replace(/^\?/, '').slice(0, 400));
  params.delete('done');
  params.delete('error');
  params.delete('yay');
  params.set('view', outcome.view);
  params.set(outcome.kind === 'error' ? 'error' : 'done', outcome.message);
  if (outcome.celebrate) params.set('yay', outcome.celebrate);
  return `${PATH}?${params.toString()}`;
}

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

export async function handleWrite(form, ip, user, csrf) {
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

    // A transaction on the one document the stock follower also writes: rewriting it whole
    // from a copy read a moment ago could drop an order the follower had just counted.
    let before = null;
    await updateDoc(LEDGER_PATHNAME, (current) => {
      const ledger = current ?? emptyLedger();
      before = ledger.skus?.[sku]?.qty ?? null;
      return setSku(ledger, sku, { qty, needs_review: false, source: `manual:${user.email}` });
    }, emptyLedger());
    // The stock view must show the number that was just saved, not a cached one.
    invalidate('catalog');
    invalidate('ledger');
    // And every channel follows it now rather than at the next order or half hour.
    void followStock({ only: 'all' }).catch((error) => console.warn(`stok: ikut stok induk gagal - ${error.message}`));
    console.log(`dashboard: ledger ${sku} -> ${qty}`);
    return {
      view: 'products', back: `?view=products&sku=${encodeURIComponent(sku)}`, message: `Stok induk ${sku} disetel ke ${qty}, semua kanal mengikuti`,
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

    // One transaction, for the same reason as a single edit: the stock follower writes
    // this document too, and a whole-document rewrite could drop an order it had counted.
    let written = 0;
    let changes = [];
    await updateDoc(LEDGER_PATHNAME, (current) => {
      let ledger = current ?? emptyLedger();
      written = 0;
      changes = [];
      for (const { sku, qty } of edits) {
        // Only write what actually moved - unless the operator vouched for it, which is
        // itself the change: the row stops being a seed and becomes a deliberate number.
        const before = ledger.skus?.[sku]?.qty ?? null;
        if (before === qty && !vouched.has(sku)) continue;
        ledger = setSku(ledger, sku, { qty, needs_review: false, source: `manual:${user.email}` });
        changes.push({ field: sku, from: before, to: qty, note: before === qty ? 'dikonfirmasi manual' : '' });
        written += 1;
      }
      return ledger;
    }, emptyLedger());
    if (written === 0) return { view: 'stock', message: 'Tidak ada nilai yang berubah' };

    invalidate('ledger');
    invalidate('catalog');
    void followStock({ only: 'all' }).catch((error) => console.warn(`stok: ikut stok induk gagal - ${error.message}`));
    console.log(`dashboard: ledger_batch ${written} skus`);
    return {
      view: 'stock', message: `${written} stok induk disimpan, semua kanal mengikuti`,
      audit: { menu: 'stock', verb: 'edit', target: `${written} SKU`, summary: `Mengubah stok ledger ${written} SKU: ${changes.slice(0, 3).map((c) => `${c.field} ${c.from ?? '—'}→${c.to}`).join(', ')}${changes.length > 3 ? ', …' : ''}`, changes },
    };
  }

  if (action === 'mass_arrange') {
    // `manual` belongs here too: a WhatsApp parcel and a resend are arranged from this
    // page like any other, and leaving the channel out of the pattern dropped their
    // checkboxes silently - ticked, submitted, and never seen again.
    const SELECTION = /^(tokopedia|tiktok_shop|shopee|shopify|manual):([A-Za-z0-9_#-]{1,64})$/;
    const wanted = [];
    for (const value of form.getAll('order')) {
      const match = SELECTION.exec(String(value));
      if (match) wanted.push({ channel: match[1], id: match[2] });
    }
    if (wanted.length === 0) throw new Error('tidak ada pesanan yang dipilih');
    // High enough to be no limit in practice - a day's queue is tens, not hundreds - and
    // low enough that a malformed post cannot ask for ten thousand round trips.
    if (wanted.length > 1000) throw new Error('maksimal 1000 pesanan sekali atur');

    /*
     * Orders are re-read before anything is booked: the form carries ids, never package
     * numbers, so a tampered field cannot ship a parcel that is not the seller's.
     *
     * From the platform for the four that have one, and from our own table for the typed-in
     * ones, which have none - asking TikTok about a code we invented returns nothing, and
     * "nothing" would have read as "not the seller's". The guard is the same either way:
     * an id that is not ours is simply not found.
     */
    const typed = wanted.filter((w) => w.channel === 'manual');
    const online = wanted.filter((w) => w.channel !== 'manual');
    const [fromPlatform, fromTable] = await Promise.all([
      online.length > 0 ? fetchOrdersByIds(online) : Promise.resolve({ orders: [], errors: {} }),
      typed.length > 0 ? ordersByIds(typed).catch(() => []) : Promise.resolve([]),
    ]);
    const { errors: readErrors = {} } = fromPlatform;
    const orders = [...fromPlatform.orders, ...fromTable];
    const eligible = orders.filter((o) => wanted.some((w) => w.id === o.id && w.channel === o.channel));

    // A selection the platform would not hand back used to be dropped here without a
    // word: the batch reported on the smaller number as though that had been the whole
    // job, and the orders sat in the queue with nothing said about them. Whatever cannot
    // be read is carried through as a failure so the count and the message agree with
    // what was actually ticked.
    const found = new Set(eligible.map((o) => `${o.channel}:${o.id}`));
    const unreadable = wanted
      .filter((w) => !found.has(`${w.channel}:${w.id}`))
      .map((w) => ({
        channel: w.channel,
        id: w.id,
        status: 'failed',
        error: readErrors[w.channel] ?? readErrors.all ?? 'pesanan tidak bisa dibaca dari platform',
      }));
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

    // massArrange reconciles our copy itself and invalidates the cache on the way out;
    // the router does not have to remember, which is the point of it living there.
    // massArrange reconciles our copy itself and invalidates the cache on the way out;
    // the router does not have to remember, which is the point of it living there.
    const result = await massArrange(eligible, { pickupTimes: chosen, methods: plans });
    const results = [...result.results, ...unreadable];
    const succeeded = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'failed');
    console.log(`dashboard: mass_arrange ${succeeded} ok, ${failed.length} failed of ${wanted.length} selected`);

    return {
      view: 'process',
      message: failed.length === 0
        ? `${succeeded} pesanan berhasil diatur pengirimannya`
        : `${succeeded} berhasil, ${failed.length} gagal - ${failed[0].id}: ${failed[0].error}`,
      audit: {
        menu: 'process', verb: 'send', target: `${wanted.length} pesanan`,
        summary: `Mengatur pengiriman ${wanted.length} pesanan: ${succeeded} berhasil${failed.length ? `, ${failed.length} gagal` : ''}`,
        changes: results.map((r) => ({ field: `${r.channel} ${r.id}`, to: r.status === 'ok' ? 'diatur pengirimannya' : 'gagal', note: r.error ?? '' })),
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

  if (action === 'refresh_order') {
    const channel = String(form.get('channel') ?? '').trim();
    const id = String(form.get('order') ?? '').trim();
    if (!channel || !id) throw new Error('pesanan tidak lengkap');

    const { changes } = await refreshOneOrder({ channel, id });

    /*
     * A label already on paper is not brought back into line by a re-read.
     *
     * The picklist, the order list and the invoice are all drawn from the stored row, so
     * they are correct the moment it is saved. A sheet that came out of the printer
     * before the edit is the one thing that cannot be, and the operator is the only one
     * who can fix it - so they are told, rather than left to find out at the bench.
     */
    const stale = changes.some((c) => RESHIPS.has(c.field))
      && Boolean(printedEntry(await printedLabels().catch(() => ({})), { channel, id }));

    const what = changes.map((c) => c.field).join(', ');
    const message = changes.length === 0
      ? `${id} sudah yang terbaru, tidak ada perubahan`
      : `${id}: ${changes.length} perubahan (${what})${stale ? ' - label sudah dicetak sebelum ini, perlu cetak ulang' : ''}`;

    console.log(`dashboard: refresh_order ${channel}/${id} - ${changes.length} changed`);
    return {
      view: 'orders', message,
      audit: {
        menu: 'orders', verb: 'edit', target: `${channel} ${id}`,
        summary: changes.length === 0
          ? `Membaca ulang ${id} dari platform, tidak ada perubahan`
          : `Membaca ulang ${id} dari platform: ${what}`,
        changes,
      },
    };
  }

  if (action === 'manual_update') {
    if (!isMekariConfigured()) throw new Error('kredensial Mekari belum diisi');

    const code = String(form.get('code') ?? '').trim();
    const before = await orderById('manual', code);
    if (!before) throw new Error(`transaksi ${code} tidak ada di daftar`);
    if (!EDITABLE_SOURCES.has(String(before.source ?? '').toUpperCase())) {
      throw new Error(`${code} bukan pesanan WhatsApp, tidak bisa diubah di sini`);
    }

    const lines = form.getAll('sku').map((sku, index) => ({
      sku,
      qty: Number(form.getAll('qty')[index]),
      unitPrice: Number(form.getAll('unitPrice')[index]),
      unitDiscount: Number(form.getAll('unitDiscount')[index]),
      discountMode: form.getAll('discountMode')[index],
    }));

    // Rebuilt from scratch and checked from scratch, exactly as a new one is. The code
    // and the source come from the stored order rather than the form: both are fixed, and
    // a form that sent different ones would be pointing the edit at another sale.
    const order = buildManualOrder({
      source: before.source,
      code: before.id,
      date: form.get('date'),
      note: form.get('note'),
      addedBy: user.name || user.email,
      shipping: form.get('shipping'),
      buyer: form.get('buyer'),
      buyerPhone: form.get('buyerPhone'),
      buyerEmail: form.get('buyerEmail'),
      shipTo: form.get('shipTo'),
      carrier: form.get('carrier'),
      lines,
    });

    /*
     * The sale happened when it happened.
     *
     * An edit is not a new sale, so leaving the date alone must leave the moment alone -
     * otherwise correcting an address at three o'clock moves a two o'clock order down the
     * list for no reason anybody could explain. A date that was actually changed does
     * move it, because that is what changing it means.
     */
    if (channelDate(before.createdAt, 'manual') === String(form.get('date') ?? '')) {
      order.createdAt = before.createdAt;
    }

    const claimed = Number(form.get('total'));
    if (Number.isFinite(claimed) && claimed !== order.total) {
      throw new Error(`total di layar (${claimed}) tidak sama dengan hasil hitung ulang (${order.total})`);
    }
    if (process.env.MEKARI_SYNC_LIVE !== '1') {
      throw new Error(`${code} valid senilai ${order.total}, tapi MEKARI_SYNC_LIVE belum disetel`);
    }

    // Jurnal first. If the books refuse the change - a payment has been recorded against
    // the invoice - our own row must not quietly move away from them.
    const amended = await amendManualInvoice(order);

    // Who changed it, kept on the order itself so the popup can say so without anybody
    // having to open the activity log.
    const edited = {
      ...order,
      editedAt: Math.floor(Date.now() / 1000),
      editedBy: user.name || user.email,
      editedTimes: Number(before.editedTimes ?? 0) + 1,
    };
    const saved = await saveOrders([edited], { source: 'manual-edit' });
    if (saved.rejected.length > 0) throw new Error(`faktur sudah diperbarui tapi daftar pesanan menolak: ${saved.rejected[0].error}`);

    const changes = diffOrder(before, edited);

    /*
     * A label already on paper no longer describes this parcel.
     *
     * Only when something that is printed on it moved - the products, the address, the
     * name. A phone number or a note does not send anybody back to the printer, and
     * putting the parcel back in the queue for one would cost a second sheet for nothing.
     */
    let reprint = false;
    if (changes.some((c) => RESHIPS.has(c.field))) {
      reprint = (await markLabelStale([`manual:${code}`], {
        by: user.email, reason: `diubah oleh ${user.name || user.email}`,
      }).catch(() => 0)) > 0;
    }

    invalidate('orders');
    invalidate('jurnal');

    const what = changes.map((c) => c.field).join(', ') || 'tidak ada yang berubah';
    console.log(`dashboard: manual_update ${code} - ${what}${reprint ? ' (label perlu cetak ulang)' : ''}`);
    return {
      view: 'orders',
      message: `${code} diubah (${what})${amended.amended ? '' : ' - belum ada faktur di Jurnal untuk diperbarui'}${reprint ? ' - label ditandai perlu cetak ulang' : ''}`,
      audit: {
        menu: 'jurnal', verb: 'edit', target: `manual ${code}`,
        summary: `Mengubah ${code} menjadi Rp${order.total.toLocaleString('id-ID')} - ${what}`,
        changes: [
          ...changes,
          ...(amended.amended ? [{ field: 'faktur Jurnal', from: String(amended.transactionNo ?? amended.invoiceId), to: 'diperbarui' }] : []),
          ...(reprint ? [{ field: 'label', from: 'sudah dicetak', to: 'perlu cetak ulang' }] : []),
        ],
      },
    };
  }

  if (action === 'discard_manual') {
    const id = String(form.get('order') ?? '').trim();
    if (!id) throw new Error('tidak ada transaksi yang disebut');

    const out = await discardManual(id);

    const where = [
      out.wasInvoiced ? `faktur ${out.transactionNo ?? out.invoiceId} dihapus di Jurnal` : 'belum pernah masuk Jurnal',
      out.removedFromList ? 'baris pesanan dihapus' : 'tidak ada baris pesanan untuk dihapus',
    ].join(', ');

    console.log(`dashboard: discard_manual ${id} - ${where}`);
    return {
      view: 'orders', message: `${id} dihapus (${where})`,
      audit: {
        menu: 'jurnal', verb: 'delete', target: `manual ${id}`,
        summary: `Menghapus transaksi manual ${id} senilai Rp${out.total.toLocaleString('id-ID')} - ${where}`,
        changes: [
          { field: 'nilai', from: String(out.total), to: null },
          ...(out.wasInvoiced ? [{ field: 'faktur Jurnal', from: String(out.transactionNo ?? out.invoiceId), to: null }] : []),
        ],
      },
    };
  }

  if (action === 'label_printed') {
    // Clearing a backlog, not printing one: a parcel whose label came out of the printer
    // before this ledger held its channel has to be able to say so, or it asks for a
    // label forever. Stored exactly as the print path stores it, channel and all.
    const LABEL_SELECTION = /^(tokopedia|tiktok_shop|shopee|shopify|manual):([A-Za-z0-9_#-]{1,64})$/;
    const keys = form.getAll('order').map(String).filter((value) => LABEL_SELECTION.test(value));
    if (keys.length === 0) throw new Error('tidak ada pesanan yang dipilih');
    if (keys.length > 200) throw new Error('terlalu banyak sekaligus');

    await markPrinted(keys, { by: user.email });
    console.log(`dashboard: label_printed ${keys.length} pesanan ditandai tanpa dicetak`);
    return {
      view: 'labels', message: `${keys.length} pesanan ditandai sudah dicetak`,
      audit: {
        menu: 'labels', verb: 'edit', target: `${keys.length} pesanan`,
        summary: `Menandai ${keys.length} label sebagai sudah dicetak tanpa mencetak`,
        changes: keys.map((key) => ({ field: key, to: 'sudah dicetak' })),
      },
    };
  }

  if (action === 'price') {
    const sku = String(form.get('sku') ?? '').trim();
    const price = Number(form.get('price'));
    if (!sku) throw new Error('SKU kosong');
    if (!Number.isInteger(price) || price <= 0) throw new Error('harga harus bilangan bulat positif');

    // The channels named on the form, and nothing else. There used to be a fallback to
    // both marketplaces when none was named; a request naming only Shopify was filtered to
    // none and fell through to it, and rewrote two live prices nobody had asked to change.
    // A write that names no channel it may touch is refused.
    const picked = form.getAll('channel').map(String).filter((c) => Object.hasOwn(LISTING_CHANNELS, c) && isManaged(c));
    if (picked.length === 0) {
      throw new Error(form.getAll('channel').some((c) => String(c) === 'shopify') ? UNMANAGED_MESSAGE : 'pilih minimal satu kanal');
    }
    const catalog = await readCatalog();
    const results = await applyPrice({ catalog, sku, price, channels: picked });
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

  /*
   * A listing's own content - title, description, pictures, weight, box - on the channels
   * the operator ticked.
   *
   * Only what changed is sent: the form remembers what it was filled from, and a field
   * left as it was stays out of every request. A SKU can sit on more than one listing on a
   * channel (Shopify carries OMC-90-001 on two products); each distinct listing is written.
   */
  if (action === 'listing_edit') {
    const sku = String(form.get('sku') ?? '').trim();
    const picked = form.getAll('channel').map(String).filter((c) => Object.hasOwn(LISTING_CHANNELS, c) && isManaged(c));
    if (!sku) throw new Error('SKU kosong');
    if (picked.length === 0) throw new Error(form.getAll('channel').some((c) => String(c) === 'shopify') ? UNMANAGED_MESSAGE : 'pilih minimal satu kanal');

    let before = {};
    try { before = JSON.parse(String(form.get('before') ?? '{}')); } catch { before = {}; }
    const patch = diffPatch(before, {
      title: form.get('title') ?? undefined,
      description: form.get('description') ?? undefined,
      weightGram: form.get('weightGram') ?? '',
      dims: { l: form.get('dimL'), w: form.get('dimW'), h: form.get('dimH') },
    });

    const files = form.getAll('images').filter((f) => f && typeof f === 'object' && f.size > 0);
    if (files.length > 9) throw new Error('maksimal 9 foto');
    const images = [];
    for (const f of files) {
      if (!/^image\/(jpeg|png)$/i.test(f.type)) throw new Error(`${f.name}: hanya JPG atau PNG`);
      if (f.size > 10 * 1024 * 1024) throw new Error(`${f.name}: lebih dari 10 MB`);
      images.push({ buffer: Buffer.from(await f.arrayBuffer()), name: f.name, type: f.type });
    }
    if (Object.keys(patch).length === 0 && images.length === 0) throw new Error('tidak ada yang diubah');

    const catalog = await readCatalog();
    const entry = catalog.skus.find((e) => e.sku === sku);
    if (!entry) throw new Error(`${sku} tidak ada di katalog`);

    const results = [];
    for (const channel of picked) {
      const rows = entry[channel]?.rows ?? [];
      if (rows.length === 0) { results.push({ channel, status: 'skipped', error: 'tidak tayang di kanal ini' }); continue; }
      // One write per listing, not per row: the variants of one listing share its title.
      // Shopify is the exception for weight, which belongs to the variant - so there each
      // row is its own write.
      const seen = new Set();
      for (const row of rows) {
        const ref = refOf(channel, row);
        const key = channel === 'shopee' ? ref?.itemId : channel === 'shopify' ? `${ref?.productId}|${ref?.variantId}` : ref?.productId;
        if (!ref || seen.has(key)) continue;
        seen.add(key);
        try {
          const out = await LISTING_CHANNELS[channel].edit(ref, patch, images);
          results.push({ channel, status: 'ok', changed: out.changed, title: row.title });
        } catch (error) {
          results.push({ channel, status: 'failed', error: error.message, title: row.title });
        }
      }
    }
    invalidate('catalog');
    invalidate('listing:');
    const ok = results.filter((r) => r.status === 'ok').length;
    const failed = results.filter((r) => r.status === 'failed');
    const fields = [...Object.keys(patch), ...(images.length ? [`${images.length} foto`] : [])];
    console.log(`dashboard: listing_edit ${sku} [${picked.join(',')}] ${fields.join(',')} - ${ok} ok, ${failed.length} gagal`);
    return {
      view: 'products',
      kind: failed.length && !ok ? 'error' : 'ok',
      message: failed.length
        ? `${sku}: ${ok} listing diperbarui, ${failed.length} gagal - ${LISTING_CHANNELS[failed[0].channel].label}: ${failed[0].error}`
        : `${sku}: ${fields.join(', ')} diperbarui di ${ok} listing`,
      audit: {
        menu: 'products', verb: 'edit', target: sku,
        status: failed.length && !ok ? 'failed' : 'ok',
        summary: `Mengubah listing ${sku} (${fields.join(', ')}) di ${picked.map((c) => LISTING_CHANNELS[c].label).join(', ')}`,
        changes: [
          ...Object.entries(patch).map(([field, to]) => ({ field, from: field === 'dims' ? JSON.stringify(before.dims ?? null) : before[field] ?? null, to: typeof to === 'object' ? JSON.stringify(to) : to })),
          ...(images.length ? [{ field: 'foto', to: images.map((i) => i.name).join(', ') }] : []),
          ...results.filter((r) => r.status !== 'ok').map((r) => ({ field: LISTING_CHANNELS[r.channel].label, to: r.status, note: r.error })),
        ],
      },
    };
  }

  /*
   * Switching a listing off or back on. Off is never a delete: TikTok deactivates (both
   * Tokopedia and TikTok Shop), Shopee unlists, Shopify archives - each reversible, with
   * the listing's orders and reviews kept.
   */
  if (action === 'listing_active') {
    const sku = String(form.get('sku') ?? '').trim();
    const channel = String(form.get('channel') ?? '');
    const active = String(form.get('active') ?? '') === '1';
    if (!sku || !Object.hasOwn(LISTING_CHANNELS, channel)) throw new Error('SKU atau kanal tidak valid');
    if (!isManaged(channel)) throw new Error(UNMANAGED_MESSAGE);
    const catalog = await readCatalog();
    const entry = catalog.skus.find((e) => e.sku === sku);
    if (!entry) throw new Error(`${sku} tidak ada di katalog`);
    // Off acts on the live listings; on acts on the ones switched off - never on a TikTok
    // listing that was deleted, which cannot come back.
    // And only when nothing is live there: a channel already selling the SKU may still hold
    // an old switched-off duplicate (TikTok's Discovery Pack does), and "on" must not bring
    // that back beside the live one.
    if (active && (entry[channel]?.rows?.length ?? 0) > 0) throw new Error(`${sku} sudah aktif di ${LISTING_CHANNELS[channel].label}`);
    const rows = active
      ? (entry[`${channel}_ignored`] ?? entry[channel]?.ignored ?? []).filter((r) => r.status !== 'DELETED')
      : entry[channel]?.rows ?? [];
    if (rows.length === 0) throw new Error(`${sku} tidak punya listing ${active ? 'nonaktif' : 'aktif'} di ${LISTING_CHANNELS[channel].label}`);
    const seen = new Set();
    let done = 0;
    for (const row of rows) {
      const ref = refOf(channel, row);
      const key = channel === 'shopee' ? ref?.itemId : ref?.productId;
      if (!ref || seen.has(key)) continue;
      seen.add(key);
      await LISTING_CHANNELS[channel].setActive(ref, active);
      done += 1;
    }
    invalidate('catalog');
    console.log(`dashboard: listing_active ${sku} ${channel} -> ${active ? 'aktif' : 'nonaktif'} (${done})`);
    return {
      view: 'products',
      message: `${sku} ${active ? 'diaktifkan lagi' : 'dinonaktifkan'} di ${LISTING_CHANNELS[channel].label} (${done} listing)`,
      audit: {
        menu: 'products', verb: 'edit', target: sku,
        summary: `${active ? 'Mengaktifkan' : 'Menonaktifkan'} ${sku} di ${LISTING_CHANNELS[channel].label}`,
        changes: [{ field: `status @ ${LISTING_CHANNELS[channel].label}`, to: active ? 'aktif' : 'nonaktif' }],
      },
    };
  }

  /*
   * A new product: into the master catalogue, and onto the channels ticked.
   *
   * Each marketplace takes its category, mandatory attributes, brand, logistics and (on
   * TikTok) certificates from a listing the operator picks as the example; the product's
   * own facts come from the form. Nothing is half-made out of sight: the master entry is
   * written only once at least one channel accepted the listing, or when no channel was
   * ticked at all - and the results say channel by channel what happened.
   */
  /*
   * One save for everything on a product's page, the way an omnichannel tool works: the
   * master facts, the listing content, the price and the master stock, each sent only when
   * it changed and only where it belongs. The page carries what it was filled with, so
   * "changed" is decided here, against that, and nothing untouched is rewritten.
   */
  /** A person's movement on the real shelf. Touches warehouse/stock.json and nothing else. */
  if (action === 'wh_move') {
    const code = String(form.get('code') ?? '').trim();
    const kind = String(form.get('kind') ?? '');
    const qty = Number(form.get('qty'));
    const note = String(form.get('note') ?? '').trim();
    const token = String(form.get('token') ?? '').slice(0, 64);
    if (!/^[a-z0-9-]{16,64}$/.test(token)) throw new Error('formulir kedaluwarsa, muat ulang halaman');
    const { record, duplicate } = await recordMove({ code, kind, qty, note, by: user.name || user.email, token });
    const label = { in: 'masuk', out: 'keluar', count: 'opname' }[kind];
    if (duplicate) return { view: 'stock', message: `${code}: sudah tercatat, tidak dicatat dua kali` };
    if (!record) return { view: 'stock', message: `${code}: jumlah di rak sudah ${qty}, tidak ada yang berubah` };
    return {
      view: 'stock',
      message: `${code} ${label} ${record.delta > 0 ? '+' : ''}${record.delta} → ${record.after}`,
      audit: { menu: 'stock', verb: 'edit', target: code, summary: `Gudang ${code}: ${label} ${record.delta > 0 ? '+' : ''}${record.delta} (sekarang ${record.after})${note ? ` - ${note}` : ''}`, changes: [{ field: code, from: record.after - record.delta, to: record.after, note }] },
    };
  }

  if (action === 'product_save') {
    const sku = String(form.get('sku') ?? '').trim();
    const current = findProduct(sku);
    if (!current || current.sku !== sku) throw new Error(`${sku} tidak ada di master`);
    let before = {};
    try { before = JSON.parse(String(form.get('before') ?? '{}')); } catch { before = {}; }
    const picked = form.getAll('channel').map(String).filter((c) => Object.hasOwn(LISTING_CHANNELS, c) && isManaged(c));
    if (picked.length === 0 && form.getAll('channel').some((c) => String(c) === 'shopify')) throw new Error(UNMANAGED_MESSAGE);
    const done = [];
    const problems = [];
    const changes = [];

    // 1. The master's own facts.
    const { entry } = cleanProduct({
      sku, name: form.get('name'), variant: form.get('variant'), category: form.get('category'),
      family: form.get('family'), aliases: form.get('aliases'), gift: form.get('gift') === '1',
      components: form.getAll('part_sku').map((partSku, i) => ({ sku: partSku, qty: form.getAll('part_qty')[i] })),
    }, { isNew: false });
    const masterChanged = ['name', 'variant', 'category', 'family', 'aliases', 'components', 'gift']
      .filter((k) => JSON.stringify(current[k] ?? (k === 'aliases' ? [] : null)) !== JSON.stringify(entry[k] ?? (k === 'aliases' ? [] : null)));
    if (masterChanged.length) {
      await saveMasterProduct({ sku, entry });
      done.push('data master');
      for (const k of masterChanged) changes.push({ field: k, from: JSON.stringify(current[k] ?? null), to: JSON.stringify(entry[k] ?? null) });
    }

    // 2. The master stock: one transaction, then every channel follows.
    const qtyRaw = String(form.get('qty') ?? '').trim();
    if (qtyRaw !== '') {
      const qty = Number(qtyRaw);
      if (!Number.isInteger(qty) || qty < 0) throw new Error('stok induk harus bilangan bulat >= 0');
      if (qty !== Number(before.qty)) {
        let was = null;
        await updateDoc(LEDGER_PATHNAME, (doc) => {
          const ledger = doc ?? emptyLedger();
          was = ledger.skus?.[sku]?.qty ?? null;
          return setSku(ledger, sku, { qty, needs_review: false, source: `manual:${user.email}` });
        }, emptyLedger());
        invalidate('ledger');
        void followStock({ only: 'all' }).catch((error) => console.warn(`stok: ikut stok induk gagal - ${error.message}`));
        done.push('stok induk');
        changes.push({ field: 'stok induk', from: was, to: qty });
      }
    }

    const catalog = picked.length ? await readCatalog() : null;

    // 3. The price, on the channels ticked.
    const priceRaw = String(form.get('price') ?? '').trim();
    if (priceRaw !== '' && picked.length && Number(priceRaw) !== Number(before.price)) {
      const price = Number(priceRaw);
      if (!Number.isInteger(price) || price < 100) throw new Error('harga minimal Rp100, bilangan bulat');
      const results = await applyPrice({ catalog, sku, price, channels: picked });
      const failed = results.filter((r) => r.status === 'failed');
      if (results.length - failed.length) done.push(`harga di ${results.length - failed.length} listing`);
      for (const f of failed) problems.push(`harga ${LISTING_CHANNELS[f.channel]?.label ?? f.channel}: ${f.error}`);
      changes.push({ field: 'harga', from: before.price ?? null, to: price });
    }

    // 4. The listing content, on the channels ticked.
    const patch = diffPatch(before.listing ?? {}, {
      title: form.get('title') ?? undefined,
      description: form.get('description') ?? undefined,
      weightGram: form.get('weightGram') ?? '',
      dims: { l: form.get('dimL'), w: form.get('dimW'), h: form.get('dimH') },
    });
    const images = await imagesFrom(form);
    if ((Object.keys(patch).length || images.length) && picked.length) {
      const entryLive = catalog.skus.find((e) => e.sku === sku);
      let ok = 0;
      for (const channel of picked) {
        const seen = new Set();
        for (const row of entryLive?.[channel]?.rows ?? []) {
          const ref = refOf(channel, row);
          const key = channel === 'shopee' ? ref?.itemId : channel === 'shopify' ? `${ref?.productId}|${ref?.variantId}` : ref?.productId;
          if (!ref || seen.has(key)) continue;
          seen.add(key);
          try { await LISTING_CHANNELS[channel].edit(ref, patch, images); ok += 1; }
          catch (error) { problems.push(`${LISTING_CHANNELS[channel].label}: ${error.message}`); }
        }
      }
      if (ok) done.push(`${[...Object.keys(patch).map((k) => ({ title: 'judul', description: 'deskripsi', weightGram: 'berat', dims: 'dimensi' }[k])), ...(images.length ? ['foto'] : [])].join(', ')} di ${ok} listing`);
      for (const [k, v] of Object.entries(patch)) changes.push({ field: k, from: k === 'dims' ? JSON.stringify(before.listing?.dims ?? null) : before.listing?.[k] ?? null, to: typeof v === 'object' ? JSON.stringify(v) : v });
      if (images.length) changes.push({ field: 'foto', to: images.map((i) => i.name).join(', ') });
      invalidate('listing:');
    }

    invalidate('catalog');
    if (done.length === 0 && problems.length === 0) {
      return { view: 'products', back: `?view=products&sku=${encodeURIComponent(sku)}`, message: 'Tidak ada yang berubah' };
    }
    console.log(`dashboard: product_save ${sku} - ${done.join('; ')}${problems.length ? ` | gagal: ${problems.join('; ')}` : ''}`);
    return {
      view: 'products', back: `?view=products&sku=${encodeURIComponent(sku)}`,
      kind: problems.length && !done.length ? 'error' : 'ok',
      message: `${sku}: ${done.length ? `disimpan - ${done.join(', ')}` : 'tidak ada yang tersimpan'}${problems.length ? `. Gagal: ${problems.join('; ')}` : ''}`,
      celebrate: done.length && !problems.length ? 'Tersimpan & tersinkron' : null,
      audit: {
        menu: 'products', verb: 'edit', target: sku, status: problems.length && !done.length ? 'failed' : 'ok',
        summary: `Menyimpan ${sku}: ${done.join(', ') || '-'}${problems.length ? ` (gagal: ${problems.length})` : ''}`,
        changes: [...changes, ...problems.map((p) => ({ field: 'gagal', to: p }))],
      },
    };
  }

  /*
   * Put an existing product on a channel that does not sell it yet, from what it already
   * says elsewhere: the live listing's title, description, box and pictures, the master
   * stock, the price it sells for. Only the example listing is chosen here.
   */
  if (action === 'product_publish') {
    const sku = String(form.get('sku') ?? '').trim();
    const channel = String(form.get('channel') ?? '');
    const draft = String(form.get('mode') ?? 'live') === 'draft';
    const n = (k) => Number(form.get(k));
    const dims = ['dimL', 'dimW', 'dimH'].every((k) => Number.isInteger(n(k)) && n(k) > 0) ? { l: n('dimL'), w: n('dimW'), h: n('dimH') } : null;
    const out = await publishProduct(await readCatalog(), sku, channel, {
      templateId: String(form.get('template') ?? '').trim(), draft,
      dims, weightGram: Number.isInteger(n('weightGram')) && n('weightGram') > 0 ? n('weightGram') : null,
    });
    invalidate('catalog');
    console.log(`dashboard: product_publish ${sku} -> ${channel} ${out.id}`);
    return {
      view: 'products', back: `?view=products&sku=${encodeURIComponent(sku)}`,
      message: `${sku} dipublikasikan${draft ? ' sebagai draft' : ''} di ${LISTING_CHANNELS[channel].label}`,
      celebrate: 'Dipublikasikan',
      audit: {
        menu: 'products', verb: 'add', target: sku,
        summary: `Mempublikasikan ${sku} ke ${LISTING_CHANNELS[channel].label}${draft ? ' sebagai draft' : ''}`,
        changes: [{ field: LISTING_CHANNELS[channel].label, to: String(out.id) }, { field: 'harga', to: out.price }, { field: 'stok', to: out.stock }],
      },
    };
  }

  /*
   * The same actions, for a selection. Each SKU is its own attempt: one that fails is
   * named in the answer and the rest still go. Capped at fifty a press, so a slip of the
   * thumb cannot spend a channel's hourly quota.
   */
  if (action.startsWith('bulk_')) {
    const skus = [...new Set(form.getAll('sku').map((v) => String(v).trim()).filter(Boolean))];
    if (skus.length === 0) throw new Error('belum ada produk yang dipilih');
    if (skus.length > 50) throw new Error('maksimal 50 produk sekali kirim');
    for (const sku of skus) if (!findProduct(sku)) throw new Error(`${sku} tidak ada di master`);
    const results = [];
    let summary = '';

    if (action === 'bulk_stock') {
      const qty = Number(form.get('qty'));
      if (!Number.isInteger(qty) || qty < 0) throw new Error('stok induk harus bilangan bulat >= 0');
      await updateDoc(LEDGER_PATHNAME, (doc) => {
        let ledger = doc ?? emptyLedger();
        for (const sku of skus) ledger = setSku(ledger, sku, { qty, needs_review: false, source: `manual:${user.email}` });
        return ledger;
      }, emptyLedger());
      invalidate('ledger');
      void followStock({ only: 'all' }).catch((error) => console.warn(`stok: ikut stok induk gagal - ${error.message}`));
      for (const sku of skus) results.push({ sku, ok: true });
      summary = `stok induk ${qty}`;
    } else if (action === 'bulk_remove') {
      for (const sku of skus) {
        try { await setMasterRemoved(sku, true); results.push({ sku, ok: true }); }
        catch (error) { results.push({ sku, ok: false, error: error.message }); }
      }
      summary = 'dihapus dari daftar';
    } else {
      const catalog = await readCatalog();
      if (action === 'bulk_price') {
        const price = Number(form.get('price'));
        if (!Number.isInteger(price) || price < 100) throw new Error('harga minimal Rp100, bilangan bulat');
        const picked = form.getAll('channel').map(String).filter((c) => Object.hasOwn(LISTING_CHANNELS, c) && isManaged(c));
        if (picked.length === 0) throw new Error(form.getAll('channel').some((c) => String(c) === 'shopify') ? UNMANAGED_MESSAGE : 'pilih minimal satu kanal');
        for (const sku of skus) {
          const r = await applyPrice({ catalog, sku, price, channels: picked }).catch((error) => [{ status: 'failed', error: error.message }]);
          const failed = r.filter((x) => x.status === 'failed');
          results.push({ sku, ok: failed.length === 0 && r.length > 0, error: failed[0]?.error ?? (r.length ? '' : 'tidak tayang di kanal terpilih') });
        }
        summary = `harga Rp${price.toLocaleString('id-ID')}`;
      } else if (action === 'bulk_active') {
        const channel = String(form.get('channel') ?? '');
        const active = String(form.get('active') ?? '') === '1';
        if (!Object.hasOwn(LISTING_CHANNELS, channel)) throw new Error('kanal tidak valid');
        if (!isManaged(channel)) throw new Error(UNMANAGED_MESSAGE);
        for (const sku of skus) {
          const entry = catalog.skus.find((e) => e.sku === sku);
          const rows = active
            ? ((entry?.[channel]?.rows?.length ? [] : (entry?.[`${channel}_ignored`] ?? entry?.[channel]?.ignored ?? []).filter((r) => r.status !== 'DELETED')))
            : entry?.[channel]?.rows ?? [];
          if (rows.length === 0) { results.push({ sku, ok: false, error: active ? 'tidak ada listing nonaktif' : 'tidak tayang' }); continue; }
          try {
            const seen = new Set();
            for (const row of rows) {
              const ref = refOf(channel, row);
              const key = channel === 'shopee' ? ref?.itemId : ref?.productId;
              if (!ref || seen.has(key)) continue;
              seen.add(key);
              await LISTING_CHANNELS[channel].setActive(ref, active);
            }
            results.push({ sku, ok: true });
          } catch (error) { results.push({ sku, ok: false, error: error.message }); }
        }
        summary = `${active ? 'diaktifkan' : 'dinonaktifkan'} di ${LISTING_CHANNELS[channel].label}`;
      } else if (action === 'bulk_publish') {
        const channel = String(form.get('channel') ?? '');
        const draft = String(form.get('mode') ?? 'live') === 'draft';
        if (!Object.hasOwn(CREATORS, channel)) throw new Error('kanal tidak valid');
        if (!isManaged(channel)) throw new Error(UNMANAGED_MESSAGE);
        for (const sku of skus) {
          try { await publishProduct(catalog, sku, channel, { templateId: null, draft }); results.push({ sku, ok: true }); }
          catch (error) { results.push({ sku, ok: false, error: error.message }); }
        }
        summary = `dipublikasikan${draft ? ' sebagai draft' : ''} di ${LISTING_CHANNELS[channel].label}`;
      } else {
        throw new Error('aksi tidak dikenal');
      }
    }
    invalidate('catalog');
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    console.log(`dashboard: ${action} ${skus.length} sku - ${ok.length} ok, ${failed.length} gagal`);
    return {
      view: 'products',
      kind: failed.length && !ok.length ? 'error' : 'ok',
      message: `${ok.length} produk ${summary}${failed.length ? `; ${failed.length} gagal: ${failed.slice(0, 3).map((f) => `${f.sku} (${f.error})`).join(', ')}${failed.length > 3 ? ', …' : ''}` : ''}`,
      audit: {
        menu: 'products', verb: 'edit', target: `${skus.length} produk`, status: failed.length && !ok.length ? 'failed' : 'ok',
        summary: `Aksi massal: ${skus.length} produk ${summary}`,
        changes: results.map((r) => ({ field: r.sku, to: r.ok ? 'ok' : 'gagal', note: r.error ?? '' })),
      },
    };
  }

  if (action === 'product_create') {
    const { sku, entry } = cleanProduct({
      sku: form.get('sku'), name: form.get('name'), variant: form.get('variant'), category: form.get('category'),
      family: form.get('family'), aliases: form.get('aliases'), gift: form.get('gift') === '1',
      components: form.getAll('part_sku').map((partSku, i) => ({ sku: partSku, qty: form.getAll('part_qty')[i] })),
    }, { isNew: true });
    const picked = form.getAll('channel').map(String).filter((c) => Object.hasOwn(CREATORS, c) && isManaged(c));
    if (picked.length === 0 && form.getAll('channel').some((c) => String(c) === 'shopify')) throw new Error(UNMANAGED_MESSAGE);
    const draft = String(form.get('mode') ?? 'live') === 'draft';

    const input = {
      sku,
      title: String(form.get('title') ?? '').trim(),
      description: String(form.get('description') ?? '').replace(/\r\n/g, '\n').trim(),
      price: Number(form.get('price')),
      stock: Number(form.get('stock')),
      weightGram: Number(form.get('weightGram')),
      dims: { l: Number(form.get('dimL')), w: Number(form.get('dimW')), h: Number(form.get('dimH')) },
    };
    const files = form.getAll('images').filter((f) => f && typeof f === 'object' && f.size > 0);
    // A duplicate may reuse the pictures of the product it was copied from.
    const photosFrom = String(form.get('photos_from') ?? '').trim();
    let borrowed = [];
    if (files.length === 0 && photosFrom && picked.length > 0) {
      const source = await listingContent(await readCatalog(), photosFrom);
      borrowed = await downloadImages(source?.data?.images ?? []);
    }
    if (picked.length > 0) {
      if (input.title.length < 5 || input.title.length > 255) throw new Error('judul listing 5-255 karakter');
      if (input.description.length < 20) throw new Error('deskripsi minimal 20 karakter');
      if (!Number.isInteger(input.price) || input.price < 100) throw new Error('harga minimal Rp100, bilangan bulat');
      if (!Number.isInteger(input.stock) || input.stock < 1 || input.stock > 99999) throw new Error('stok awal 1-99.999');
      if (!Number.isInteger(input.weightGram) || input.weightGram < 1) throw new Error('berat wajib diisi (gram)');
      if (picked.some((c) => c !== 'shopify') && !['l', 'w', 'h'].every((k) => Number.isInteger(input.dims[k]) && input.dims[k] > 0)) {
        throw new Error('dimensi paket wajib untuk Tokopedia/TikTok dan Shopee');
      }
      if (files.length + borrowed.length < 1) throw new Error('minimal 1 foto');
      if (files.length > 9) throw new Error('maksimal 9 foto');
    }
    const images = files.length ? await imagesFrom(form) : borrowed;

    const results = [];
    for (const channel of picked) {
      const templateId = channel === 'shopify' ? null : String(form.get(`template_${channel}`) ?? '').trim();
      if (channel !== 'shopify' && !/^\d+$/.test(templateId)) { results.push({ channel, status: 'failed', error: 'pilih listing contoh' }); continue; }
      try {
        const out = await CREATORS[channel](input, images, { templateId, draft });
        results.push({ channel, status: 'ok', id: out.id, warnings: out.warnings });
      } catch (error) {
        results.push({ channel, status: 'failed', error: error.message });
      }
    }
    const ok = results.filter((r) => r.status === 'ok');
    const failed = results.filter((r) => r.status === 'failed');
    if (picked.length > 0 && ok.length === 0) {
      throw new Error(`tidak ada listing yang dibuat - ${failed.map((r) => `${LISTING_CHANNELS[r.channel].label}: ${r.error}`).join(' · ')}`);
    }

    await saveMasterProduct({ sku, entry });
    // The opening stock is the master figure from the start, so the stock follower writes
    // it rather than seeding from whichever channel read lowest.
    if (picked.length > 0) {
      await updateDoc(LEDGER_PATHNAME, (current) => setSku(current ?? emptyLedger(), sku, { qty: input.stock, needs_review: false, source: `baru:${user.email}` }), emptyLedger());
      invalidate('ledger');
    }
    invalidate('catalog');
    const label = (c) => LISTING_CHANNELS[c].label;
    console.log(`dashboard: product_create ${sku} [${picked.join(',')}] ${ok.length} ok, ${failed.length} gagal`);
    return {
      view: 'products',
      back: `?view=products&sku=${encodeURIComponent(sku)}`,
      kind: failed.length ? 'error' : 'ok',
      message: picked.length === 0
        ? `${sku} ditambahkan ke master`
        : `${sku} dibuat${draft ? ' sebagai draft' : ''} di ${ok.map((r) => label(r.channel)).join(', ')}${failed.length ? `; gagal di ${failed.map((r) => `${label(r.channel)} (${r.error})`).join(', ')}` : ''}`,
      celebrate: failed.length ? null : 'Produk dibuat',
      audit: {
        menu: 'products', verb: 'add', target: sku,
        summary: `Membuat produk ${sku} (${entry.name}${entry.variant ? ` ${entry.variant}` : ''})${picked.length ? ` di ${picked.map(label).join(', ')}${draft ? ' sebagai draft' : ''}` : ' di master'}`,
        changes: [
          { field: 'nama', to: entry.name }, { field: 'kategori', to: entry.category },
          ...(picked.length ? [{ field: 'harga', to: input.price }, { field: 'stok awal', to: input.stock }] : []),
          ...results.map((r) => ({ field: label(r.channel), to: r.status === 'ok' ? String(r.id) : 'gagal', note: r.error ?? (r.warnings ?? []).join('; ') })),
        ],
      },
    };
  }

  /** The master's own facts about a product: name, grouping, aliases, bundle recipe. */
  if (action === 'product_master') {
    const sku = String(form.get('sku') ?? '').trim();
    const current = findProduct(sku);
    if (!current || current.sku !== sku) throw new Error(`${sku} tidak ada di master`);
    const { entry } = cleanProduct({
      sku, name: form.get('name'), variant: form.get('variant'), category: form.get('category'),
      family: form.get('family'), aliases: form.get('aliases'), gift: form.get('gift') === '1',
      components: form.getAll('part_sku').map((partSku, i) => ({ sku: partSku, qty: form.getAll('part_qty')[i] })),
    }, { isNew: false });
    await saveMasterProduct({ sku, entry });
    invalidate('catalog');
    const changes = ['name', 'variant', 'category', 'family', 'aliases', 'components', 'gift']
      .filter((k) => JSON.stringify(current[k] ?? null) !== JSON.stringify(entry[k] ?? null))
      .map((k) => ({ field: k, from: JSON.stringify(current[k] ?? null), to: JSON.stringify(entry[k] ?? null) }));
    return {
      view: 'products', back: `?view=products&sku=${encodeURIComponent(sku)}`,
      message: changes.length ? `Data master ${sku} disimpan` : `Data master ${sku} tidak berubah`,
      audit: { menu: 'products', verb: 'edit', target: sku, summary: `Mengubah data master ${sku}`, changes },
    };
  }

  /** Out of the catalogue the screens offer, or back into it. Never deleted. */
  if (action === 'product_remove') {
    const sku = String(form.get('sku') ?? '').trim();
    const removed = String(form.get('removed') ?? '1') === '1';
    await setMasterRemoved(sku, removed);
    invalidate('catalog');
    return {
      view: 'products', back: removed ? '?view=products' : `?view=products&sku=${encodeURIComponent(sku)}`,
      message: removed ? `${sku} dihapus dari daftar produk (bisa dikembalikan)` : `${sku} dikembalikan ke daftar produk`,
      audit: { menu: 'products', verb: 'edit', target: sku, summary: `${removed ? 'Menghapus' : 'Mengembalikan'} ${sku} ${removed ? 'dari' : 'ke'} daftar produk master` },
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

  if (action === 'manual_invoice' && String(form.get('source') ?? '').toUpperCase() === 'RS') {
    /*
     * A resend. It never reaches Mekari Jurnal at all, by decision.
     *
     * Not a sale: the customer paid once, on the order this is attached to, and that
     * invoice already records it. Not a correction either - that invoice says exactly what
     * was ordered and exactly what was paid; the mistake happened in the warehouse, where
     * no document was looking. So the books have nothing to change, and a resend that
     * wrote to them would only be adding a document that says nothing.
     *
     * What it is, is a parcel. It gets a label, it goes out, and it is counted at zero so
     * a month of mistakes never looks like a month of trade.
     */
    const fragment = String(form.get('resendFor') ?? '').trim();
    // The picker fills this in when an order was chosen from the list, which makes the
    // lookup exact. Typed by hand it is empty, and then the fragment is searched - a
    // resend must still be enterable by somebody who only has the number on a slip.
    const pickedChannel = String(form.get('resendChannel') ?? '').trim();
    const matches = pickedChannel
      ? await ordersByIds([{ channel: pickedChannel, id: fragment }]).catch(() => [])
      : await ordersMatchingId(fragment).catch(() => []);
    const exact = matches.filter((o) => String(o.id).toLowerCase() === fragment.toLowerCase());
    const found = exact.length > 0 ? exact : matches;
    if (found.length === 0) throw new Error(`pesanan "${fragment}" tidak ditemukan - periksa order ID-nya`);
    // Two orders sharing an id across channels is possible and rare; guessing which one a
    // mistake belongs to is not something to do silently.
    if (found.length > 1) {
      throw new Error(`"${fragment}" cocok dengan ${found.length} pesanan (${found.map((o) => `${o.channel} ${o.id}`).join(', ')}) - tulis order ID lengkapnya`);
    }
    const wrongOrder = found[0];

    const order = buildResend({
      source: 'RS',
      code: form.get('code'),
      date: form.get('date'),
      note: form.get('note'),
      addedBy: user.name || user.email,
      buyer: form.get('buyer') || wrongOrder.buyer,
      buyerPhone: form.get('buyerPhone') || wrongOrder.buyerPhone,
      buyerEmail: form.get('buyerEmail') || wrongOrder.buyerEmail,
      shipTo: form.get('shipTo') || wrongOrder.shipTo,
      carrier: form.get('carrier'),
      resendFor: { channel: wrongOrder.channel, id: wrongOrder.id },
      lines: form.getAll('sku').map((sku, index) => ({ sku, qty: Number(form.getAll('qty')[index]) })),
      wrongLines: form.getAll('wsku').map((sku, index) => ({
        sku,
        qty: Number(form.getAll('wqty')[index]),
        unitPrice: Number(form.getAll('wunitPrice')[index]),
      })),
    });

    const existing = await ordersByIds([{ channel: 'manual', id: order.id }]).catch(() => []);
    if (existing.length > 0) {
      throw new Error(`kode ${order.id} sudah dipakai transaksi lain; buka formulir lagi untuk kode baru`);
    }

    const saved = await saveOrders([order], { source: 'resend' });
    if (saved.rejected.length > 0) throw new Error(`daftar pesanan menolak ${order.id}: ${saved.rejected[0].error}`);

    invalidate('orders');
    const value = order.finance.wrongGoods.value;
    console.log(`dashboard: resend ${order.id} for ${wrongOrder.channel}/${wrongOrder.id} - goods lost ${value}`);
    return {
      view: 'orders',
      message: `${order.id} dibuat untuk ${wrongOrder.id} - siap dipak dan dicetak labelnya`,
      celebrate: 'Kirim ulang tercatat',
      audit: {
        menu: 'orders', verb: 'add', target: `manual ${order.id}`,
        summary: `Kirim ulang ${order.id} untuk ${wrongOrder.channel} ${wrongOrder.id} - barang hilang senilai Rp${value.toLocaleString('id-ID')}`,
        changes: [
          { field: 'pesanan salah kirim', to: `${wrongOrder.channel} ${wrongOrder.id}` },
          ...order.finance.wrongGoods.lines.map((l) => ({ field: `hilang ${l.sku}`, to: `${l.qty} × Rp${l.unitPrice.toLocaleString('id-ID')}` })),
          ...order.finance.lines.map((l) => ({ field: `dikirim ulang ${l.sku}`, to: String(l.qty) })),
        ],
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
    // A sale typed in here is goods off the same shelf as a marketplace order, so it comes
    // off every channel the same way. Not awaited: the operator is waiting for the page.
    void followAfterOrder(order);
    void warehouseAfterOrder(order);

    // The order list and the invoice printer both read the orders table, and nothing else
    // will ever put a typed-in sale there. The sale is in Jurnal either way - that is the
    // record - but a table that refused it is something the operator has to be told, not
    // a line in a log nobody reads. It is what "sudah tersimpan" but "tidak ada di daftar"
    // looks like from the counter.
    let listed = true;
    let listError = '';
    if (isSupabaseConfigured()) {
      try {
        const saved = await saveOrders([order], { source: 'manual' });
        if (saved.rejected.length > 0) {
          listed = false;
          listError = saved.rejected[0].error;
        }
        invalidate('orders:');
      } catch (error) {
        listed = false;
        listError = error.message;
      }
    }
    if (!listed) console.warn(`dashboard: manual_invoice ${order.id} tidak masuk tabel pesanan - ${listError}`);

    const outcome = manualOutcome({
      status: result.status, error: result.error, id: order.id,
      total: built.expectedTotal, listed, listError,
    });

    return {
      view: 'orders',
      kind: outcome.kind,
      message: outcome.message,
      // A sale typed in by hand is the one write on this dashboard that is entirely the
      // operator's own work, so a clean one gets the one moment of celebration.
      celebrate: outcome.celebrate ?? null,
      audit: {
        menu: 'jurnal', verb: 'add', target: order.id,
        // The trail says the same thing the screen says. A mismatch logged as "ok" is how
        // an invoice holding the wrong number stops being anybody's problem.
        status: outcome.kind === 'error' ? 'failed' : 'ok',
        ...(outcome.kind === 'error' ? { error: outcome.message } : {}),
        summary: `Menambah transaksi manual ${order.id} (${order.source}) untuk ${order.customer} senilai Rp${built.expectedTotal.toLocaleString('id-ID')}${
          result.status === 'created' && listed ? '' : ` — ${outcome.message}`}`,
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
      // Sixty-four kilobytes, not four. A selection travels as one `order` field per
      // parcel at roughly thirty bytes each, and the pickup step adds a slot field
      // beside it - four kilobytes ran out at around a hundred parcels, and ran out as
      // "Data formulir terlalu besar" rather than as anything an operator could act on.
      // Product pictures arrive as multipart and get forty megabytes: nine pictures at the
      // channels' own limits. nginx carries the same cap (deploy/nginx-api.conf).
      form = await readFormBody(req, 64 * 1024, { multipartLimitBytes: 40 * 1024 * 1024 });
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
      // `status: 'ok'` is the default, not the verdict: an outcome that knows it went
      // badly says so, and the trail agrees with the message the operator was shown.
      if (outcome.audit) await recordActivity({ actor: user, ip, action, status: 'ok', ...outcome.audit });
      redirect(afterWrite(outcome, form));
    } catch (error) {
      console.error(`dashboard: write failed - ${error.message}`);
      await recordActivity({
        actor: user, ip, action, status: 'failed', error: error.message,
        menu: ACTION_MENU[action] ?? (form.get('view') || 'products'), verb: 'edit', target: failureTarget(form),
        summary: `Aksi ${action || '?'} ditolak`,
      });
      redirect(afterWrite(
        { view: form.get('view') || ACTION_MENU[action] || 'products', kind: 'error', message: error.message },
        form,
      ));
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
      // A name clicked on the Pengguna tab lands here; whoever may manage users also sees
      // the account itself above the history. Nobody else gets more than the log showed.
      const profile = filter.actor && can(user, 'users')
        ? (await listUsers().catch(() => [])).find((u) => u.id === filter.actor) ?? null
        : null;
      send(200, renderActivity({
        entries, actors: actorsIn(all), filter, profile, paging, baseQuery, user,
        range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash,
      }));
      return;
    }

    // The Stok tab is the real warehouse now - item by item, migrated from the sheet.
    // It never reads or writes a marketplace; the master stock the channels follow is
    // edited on the products page.
    if (view === 'stock') {
      const warehouse = await cached('warehouse', 15_000, () => loadWarehouse(), SWR);
      const item = String(url.searchParams.get('item') ?? '').slice(0, 20);
      const kind = String(url.searchParams.get('kind') ?? '').slice(0, 10);
      console.log(`dashboard/stock: gudang ${Object.keys(warehouse.items ?? {}).length} barang`);
      send(200, renderWarehouse({ user, warehouse, item, kind, range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash }));
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
      const selected = url.searchParams.get('sku') ?? null;
      send(200, renderProducts({ user,
        catalog, ledger, plan, errors: catalog.errors, range, shopeeShop: null,
        generatedAt: Date.now(), csrf, flash,
        selected,
        images: await imagesByKey(),
        listing: selected ? await listingContent(catalog, selected) : null,
        creating: url.searchParams.get('new') === '1',
        // Shopify is edited in Shopify; its tile links straight to the product there.
        shopifyAdmin: loadShopifyConfig().domain ? `https://${loadShopifyConfig().domain}/admin/products/` : null,
        // Duplicate: the new-product form filled from an existing product and its listing.
        duplicateOf: url.searchParams.get('new') === '1' && url.searchParams.get('from')
          ? { sku: url.searchParams.get('from'), listing: await listingContent(catalog, url.searchParams.get('from')) }
          : null,
      }));
      return;
    }

    /*
     * Correcting a typed-in sale, in the same form it was typed in.
     *
     * A WhatsApp order is agreed in a conversation, and the conversation carries on after
     * it is written down: a jar added, an address corrected. Until now the only way to
     * reflect that was to delete the whole thing and type it again, which loses the
     * invoice number and the sequence position with it.
     */
    if (view === 'jurnal' && url.searchParams.get('edit')) {
      const code = String(url.searchParams.get('edit')).slice(0, 64);
      const order = await orderById('manual', code).catch(() => null);
      if (!order) {
        send(404, dashboardError('Transaksi tidak ditemukan', `${code} tidak ada di daftar pesanan.`));
        return;
      }
      if (!EDITABLE_SOURCES.has(String(order.source ?? '').toUpperCase())) {
        send(403, dashboardError('Tidak bisa diubah', `${code} bukan pesanan WhatsApp. Hapus lalu masukkan ulang kalau datanya salah.`));
        return;
      }
      const ledger = await cached('jurnal', LEDGER_TTL_MS, () => loadSyncLedger().catch(() => ({ orders: {} })), SWR);
      send(200, renderManual({ user,
        range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf, flash,
        editing: order,
        source: String(order.source ?? '').toUpperCase(),
        code: order.id,
        today: channelToday('manual'),
        contacts: [...(ledger.contacts ?? [])].sort(),
        existingCodes: [], images: await imagesByKey(),
        prices: await cached('shopify-prices', 5 * 60_000, () => priceBySku().catch(() => ({})), SWR),
        live: process.env.MEKARI_SYNC_LIVE === '1',
      }));
      return;
    }

    /*
     * The order picker behind a resend, asked of every order rather than a window.
     *
     * Same shape as the label lookup: markup from the same server that drew the page, so
     * the browser only inserts it and no second escaping routine ends up living inside a
     * template literal. A mistake recorded against the wrong order is worse than the one
     * being recorded, which is why the rows carry the buyer and the contents.
     */
    if (view === 'jurnal' && url.searchParams.has('lookup')) {
      const fragment = String(url.searchParams.get('lookup') ?? '').slice(0, 64);
      const json = (status, body) => send(status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' });
      if (fragment.replace(/[^A-Za-z0-9-]/g, '').length < ID_SEARCH_MIN) {
        json(200, { rows: '', count: 0, min: ID_SEARCH_MIN });
        return;
      }
      try {
        const found = (await ordersMatchingId(fragment, { limit: 8 }))
          // A resend cannot be put right by another resend, so they are not offered.
          .filter((o) => !(o.channel === 'manual' && String(o.id).startsWith('RS-')));
        console.log(`dashboard/jurnal lookup: ${found.length} match(es)`);
        json(200, { rows: renderOrderPicks({ orders: found }), count: found.length });
      } catch (error) {
        console.error('dashboard/jurnal lookup failed:', error.message);
        json(502, { error: 'Pencarian ke database gagal, coba lagi sebentar.' });
      }
      return;
    }

    if (view === 'jurnal' && url.searchParams.get('add') === '1') {
      const ledger = await cached('jurnal', LEDGER_TTL_MS, () => loadSyncLedger().catch(() => ({ orders: {} })), SWR);
      const used = manualCodes(ledger);
      const source = url.searchParams.get('source') ?? 'CS';
      /*
       * The names come from the ledger, not from Jurnal.
       *
       * This used to call listContacts(), which pages through the whole contact book at
       * a hundred a request: 2,089 contacts is twenty-one requests, spent every single
       * time somebody opened this form, for a datalist that only autocompletes a name.
       * The monthly package is the binding limit on this integration and the account
       * reached 10,886 of 12,000 with a fortnight to go - a convenience cannot cost that.
       *
       * The ledger holds the same names: rememberContacts writes every buyer it has ever
       * settled with Jurnal, and it is a store read, so it is free. Jurnal is asked only
       * if that list is empty, which is a fresh install and nothing else.
       */
      const contacts = (ledger.contacts ?? []).length > 0
        ? [...ledger.contacts].sort()
        : await listContacts().then((m) => [...m.keys()].sort()).catch(() => []);
      // Reserved now, inside a store transaction, so this form and any other open at the
      // same moment hold different numbers. An abandoned form leaves a gap, never a repeat.
      const sequence = await reserveManualSequence();
      // The form's default date and its ceiling are WITA, because that is the clock the
      // person filling it in is looking at. Just before midnight in Bali the house clock
      // still reads yesterday, and the form would open on a date already gone.
      const today = channelToday('manual');

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
    /*
     * The label search, asked of every order rather than the worklist.
     *
     * Answered before the worklist is read: it needs none of it, and somebody typing an
     * order number should not wait on three platforms to be told about one row. Rows come
     * back as markup from the same function the list uses, so the page only inserts them.
     */
    if (view === 'labels' && url.searchParams.has('lookup')) {
      const fragment = String(url.searchParams.get('lookup') ?? '').slice(0, 64);
      const json = (status, body) => send(status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' });
      if (fragment.replace(/[^A-Za-z0-9-]/g, '').length < ID_SEARCH_MIN) {
        json(200, { rows: '', count: 0, min: ID_SEARCH_MIN });
        return;
      }
      try {
        const [found, printed, arrangedNow, roster] = await Promise.all([
          ordersMatchingId(fragment),
          printedLabels().catch(() => ({})),
          arrangedOrders().catch(() => ({})),
          listUsers().catch(() => []),
        ]);
        const people = Object.fromEntries(roster.map((u) => [u.email, u.name]));
        console.log(`dashboard/labels lookup: ${found.length} match(es)`);
        json(200, { rows: renderLabelLookup({ orders: found, printed, arranged: arrangedNow, people }), count: found.length });
      } catch (error) {
        console.error('dashboard/labels lookup failed:', error.message);
        json(502, { error: 'Pencarian ke database gagal, coba lagi sebentar.' });
      }
      return;
    }

    const started = Date.now();
    let data = OUTSTANDING_VIEWS.has(view) ? await outstandingOrders() : await ordersFor(range);
    const took = () => `${Date.now() - started}ms`;

    if (view === 'labels') {
      // Shopify prints are remembered here, not there; the page cannot tell what still
      // needs a label without it.
      const printed = await printedLabels().catch(() => ({}));
      // Shopify has no platform status that says "arranged", so this ledger is what the
      // label waits on - the same thing the process page marks when the operator books
      // the courier outside Shopify.
      const arrangedNow = await arrangedOrders().catch(() => ({}));
      // A waybill printed for an order the platform has cancelled is a parcel that goes
      // out and comes back. Same settling, same shared cooldown.
      const labelling = await settleWorklist(data, arrangedNow);
      data = labelling.data;
      const showReprints = url.searchParams.get('reprint') === '1';
      // Only the reprint list names who printed, so the roster is only read for it. An
      // email is a fine identifier and a poor label; the batch header says "Vanya".
      const people = showReprints
        ? Object.fromEntries((await listUsers().catch(() => [])).map((u) => [u.email, u.name]))
        : {};
      // Read off the query string and sanitised here rather than trusted in the page: a
      // date that is not a date filters nothing and is dropped, which is the same result
      // as not asking for one.
      const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? value : '');
      const reprintFilter = {
        from: day(url.searchParams.get('pfrom')),
        to: day(url.searchParams.get('pto')),
        by: String(url.searchParams.get('pby') ?? '').slice(0, 120),
      };
      console.log(`dashboard/labels: ${data.orders.length} orders outstanding (${took()})`);
      send(200, renderLabels({ user,
        ...data, range, csrf, flash, sizes: LABEL_SIZES, defaultSize: DEFAULT_SIZE, printed, arranged: arrangedNow, people,
        showReprints, reprintFilter, now: Math.floor(Date.now() / 1000),
        readAt: labelling.readAt, settleFailed: labelling.failed,
      }));
      return;
    }

    if (view === 'process') {
      // Arranging a Shopify order calls nothing, so only this says it has been done.
      const arranged = await arrangedOrders().catch(() => ({}));

      const settling = await settleWorklist(data, arranged);
      data = settling.data;

      console.log(`dashboard/process: ${data.orders.length} orders outstanding (${took()})`);
      send(200, renderProcess({ user,
        ...data, range, csrf, flash, arranged,
        readAt: settling.readAt, settleFailed: settling.failed,
      }));
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

    if (view === 'express') {
      // From the orders, not from the alert feed: the feed is a doorbell, capped and
      // expiring after two hours, and a doorbell is not a record.
      console.log(`dashboard/express: ${data.orders.length} orders in range (${took()})`);
      send(200, renderExpressLog({ user, ...data, range, csrf, flash }));
      return;
    }

    if (view === 'picklist') {
      // The same settling as the process view, sharing its cooldown: these three pages
      // are drawn from one set of rows, so whichever is opened first pays for all of
      // them. A picker sent after a parcel that was cancelled an hour ago has walked the
      // shelves for nothing.
      const picking = await settleWorklist(data, await arrangedOrders().catch(() => ({})));
      data = picking.data;
      const picklist = buildPicklist(data.orders);
      console.log(`dashboard/picklist: ${picklist.unitCount} units across ${picklist.skuCount} skus (${took()})`);
      send(200, renderPicklist({ user,
        ...data, range, picklist,
        readAt: picking.readAt, settleFailed: picking.failed,
      }));
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
    send(200, renderDashboard({ user, ...data, orders, summary, filter, paging, baseQuery, flash, csrf }));
  } catch (error) {
    console.error(`dashboard: render failed - ${error.message}`);
    send(502, dashboardError('Could not load orders', error.message));
  }
}
