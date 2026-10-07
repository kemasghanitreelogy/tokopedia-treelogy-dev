import { businessToday, zoneLabel, zoneName, zoneForChannel, channelDate, BENCH_CHANNEL, ZONES } from './clock.js';
import { CHANNELS, STAGES, STAGE_META, MANUAL_CHANNEL, channelMeta } from './omni.js';
import { DATASETS, EXPORT_CHANNELS, EXPORT_PRODUCTS, PRODUCT_GROUPS, DEFAULT_DATASET } from './export/orders.js';
import { PRESETS } from './range.js';
import { CHANNEL_LABEL } from './stock-sync.js';
import { labelReadiness, FETCHABLE, printedEntry, printBatches, filterPrintBatches, printersIn, printDaysIn, reprintPresets, printZoneLabel } from './labels.js';
import { expressService, INSTANT as EXPRESS_INSTANT } from './express.js';
import { AWAITING_PACKING } from './alerts-express.js';
import { PRODUCTS, CATEGORIES, groupProducts, findProduct, familyOf, isBundle, buildableFrom, unmapped, allProducts, isRemoved } from './master.js';
import { pending, nextAction } from './fulfillment.js';
import { orderCode, PREFIXES } from './mekari/prefix.js';
import { defaultSlot } from './shopee/pickup.js';
import { SOURCE_OPTIONS, SELLABLE, MANUAL_CARRIERS, sellableInShopify } from './mekari/manual.js';
import { ageOf } from './mekari/heartbeat.js';
import { REVIEW_CHANNELS } from './reviews/combined.js';
import { paginate, pageHref, pageWindow, PER_PAGE_OPTIONS, DEFAULT_PER_PAGE } from './paging.js';
import { can, ROLES } from './users.js';

/** Server-rendered omnichannel dashboard. No secrets and no user input reach the markup unescaped. */

export const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const rupiah = (n) => 'Rp' + Math.round(n).toLocaleString('id-ID');

const todayWib = businessToday;

const wibStamp = (iso) =>
  new Date(iso).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zoneName(),
  }) + ' WIB';

/**
 * When an order happened, on the clock of the platform it came from.
 *
 * It used the house clock for every row, so a Shopify order Shopify itself prints as
 * "September 12, 2026 at 12:03 am" appeared here as 11 Sep 23:03 - an hour earlier and a
 * day earlier. Somebody checking a single order against the seller centre found a
 * mismatch every time, on every channel, for the last hour of every night.
 *
 * The filter above already buckets by the platform's day. Displaying a different clock
 * from the one the page filters by is worse than either choice alone.
 */
const dateTime = (epochSeconds, channel = null) =>
  new Date(epochSeconds * 1000).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: zoneForChannel(channel).name,
  });

/* Heroicons (24/outline), inlined so the page has no external requests beyond the font. */
const icon = {
  wallet: '<path d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3"/>',
  cube: '<path d="m21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"/>',
  bell: '<path d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"/>',
  truck: '<path d="M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 0 1-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 0 0-3.213-9.193 2.056 2.056 0 0 0-1.58-.86H14.25M16.5 18.75h-6m0 0v-3.675A55.378 55.378 0 0 1 12 5.25h2.25m0 0V2.25h4.5v3M2.25 14.25v-2.625A2.625 2.625 0 0 1 4.875 9H14.25"/>',
  refresh: '<path d="M16.023 9.348h4.992V4.356m0 4.992-3.181-3.183a8.25 8.25 0 0 0-13.803 3.7M4.031 9.865v4.99m0 0h4.99m-4.99 0 3.181 3.183a8.25 8.25 0 0 0 13.804-3.7"/>',
  sun: '<path d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/>',
  moon: '<path d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/>',
  printer: '<path d="M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Z"/>',
  check: '<path d="M4.5 12.75l6 6 9-13.5"/>',
  list: '<path d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/>',
  stack: '<path d="M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125Z"/>',
  logout: '<path d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15M12 9l-3 3m0 0 3 3m-3-3h12.75"/>',
  lock: '<path d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 12.75v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/>',
  warn: '<path d="M12 9v3.75m9.303 3.376c.866 1.5-.217 3.374-1.948 3.374H4.645c-1.73 0-2.813-1.874-1.948-3.374l7.108-12.28c.866-1.5 2.994-1.5 3.86 0l7.107 12.28ZM12 15.75h.007v.008H12v-.008Z"/>',
};

icon.plus = '<path d="M12 4.5v15m7.5-7.5h-15"/>';
icon.chevL = '<path d="m15 5-7 7 7 7"/>';
icon.chevR = '<path d="m9 5 7 7-7 7"/>';
icon.search = '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>';
icon.users = '<path d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"/>';
icon.clock = '<path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>';
icon.mail = '<path d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"/>';
icon.send = '<path d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"/>';
icon.shield = '<path d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"/>';
icon.trash = '<path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/>';
icon.ban = '<path d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636"/>';
icon.key = '<path d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"/>';
icon.eye = '<path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"/><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/>';
icon.eyeOff = '<path d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"/>';
icon.history = '<path d="M12 6v6h4.5M3.75 12a8.25 8.25 0 1 0 2.4-5.82M3 4.5v3.75h3.75"/>';
icon.pencil = '<path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125"/>';
icon.userPlus = '<path d="M19 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM4 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 10.374 21c-2.331 0-4.512-.645-6.374-1.766Z"/>';
icon.check2 = '<path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>';
icon.x = '<path d="M6 18 18 6M6 6l12 12"/>';
icon.ext = '<path d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"/>';
icon.grid = '<path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6Zm0 9.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Zm0 9.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"/>';
icon.list = '<path d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/>';
icon.image = '<path d="m2.25 15.75 5.16-5.16a2.25 2.25 0 0 1 3.18 0l5.16 5.16m-1.5-1.5 1.41-1.41a2.25 2.25 0 0 1 3.18 0l2.91 2.91m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/>';
icon.export = '<path d="M12 15V3m0 0L8.5 6.5M12 3l3.5 3.5M20.25 14.25v4.5a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-4.5"/>';

export const svg = (name, cls = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon[name]}</svg>`;


export const VIEWS = {
  orders: 'Pesanan', process: 'Proses', picklist: 'Picklist', labels: 'Label',
  stock: 'Stok', products: 'Produk', forecast: 'Prakiraan', reviews: 'Ulasan',
  users: 'Pengguna',
};

/**
 * Views that answer to a URL but are not tabs.
 *
 * `jurnal` is the sync ledger: real-time posting means nobody needs to watch it, so it
 * stopped earning a place in the menu. The one thing an operator does reach for - typing
 * in a sale that never went through a marketplace - is a button on the orders page.
 */
export const HIDDEN_VIEWS = { jurnal: 'Jurnal', activity: 'Aktivitas', express: 'Pickup Instant' };
export const VALID_VIEWS = { ...VIEWS, ...HIDDEN_VIEWS };

/** Tabs that need a permission the person may not have are not shown, not merely refused. */
const TAB_PERMISSION = { users: 'users' };
/**
 * Menus whose actions write something, and therefore have a log of their own. The log
 * button sits in the tab row of exactly these; a read-only menu has nothing to show.
 */
export const LOGGED_MENUS = new Set(['process', 'labels', 'stock', 'products', 'jurnal', 'users', 'reviews']);

function viewNav(current, rangeQuery, user = null, { log = false } = {}) {
  const tabs = Object.entries(VIEWS)
    .filter(([id]) => !TAB_PERMISSION[id] || can(user, TAB_PERMISSION[id]))
    .map(([id, label]) => {
      const query = id === 'products' || id === 'users' ? `?view=${id}` : `?view=${id}${rangeQuery}`;
      return `<a class="viewtab ${id === current ? 'is-on' : ''}" href="${escape(query)}">${escape(label)}</a>`;
    })
    .join('');

  const end = [];
  // Typing in an off-marketplace sale is the only reason left to open Jurnal by hand, so
  // the door to it stands on the page the operator is already looking at.
  if (current === 'orders' && can(user, 'write')) {
    end.push(`<a class="viewadd" href="?view=jurnal&amp;add=1">${svg('plus')}<span>Tambah transaksi</span></a>`);
  }
  if (!log && LOGGED_MENUS.has(current)) {
    end.push(`<a class="viewlog" href="${escape(`?view=activity&menu=${current}${rangeQuery}`)}">${svg('history')}<span>Log aktivitas</span></a>`);
  }
  return {
    tabs: `<nav class="views" aria-label="Halaman">${tabs}</nav>`,
    actions: end.join(''),
  };
}

function stageBar(stages, total) {
  if (!total) return '<div class="bar bar--empty"></div>';
  const segments = STAGES.filter((s) => stages[s] > 0)
    .map((s) => `<span class="seg seg--${STAGE_META[s].tone}" style="flex:${stages[s]}" title="${STAGE_META[s].label}: ${stages[s]}"></span>`)
    .join('');
  return `<div class="bar" role="img" aria-label="Sebaran status pesanan">${segments}</div>`;
}

/** A dense inline figure. Four of these fit where one KPI card used to sit. */
function stat(label, value, tone = '') {
  return `<span class="stat">
    <span class="stat__n ${tone}">${escape(value)}</span>
    <span class="stat__l">${escape(label)}</span>
  </span>`;
}

/**
 * The moment after a save lands: a green disc, a check that draws itself, and a burst
 * of confetti that flies out and falls away. Two and a half seconds, then gone.
 *
 * Every particle is a pure function of its index - angle, speed, size, spin and colour
 * all come from one seeded hash - so the burst is the same shape every time and the
 * markup can be written on the server. The flight is two nested transforms: the outer
 * span carries the sideways throw and the fade, the inner one carries the rise, the
 * apex and the fall, so a thrown chip reads as thrown rather than as slid.
 */
const CONFETTI = ['#FF6B7A', '#FFB020', '#6CB8FF', '#B79CFF', '#45D19B'];
const CONFETTI_KINDS = ['dot', 'chip', 'arc', 'dot', 'chip', 'arc', 'dot'];
function confetti(count = 28, { seed = 0, reach = 1, wait = 0 } = {}) {
  const prand = (n) => { const x = Math.sin(n * 127.1 + 311.7 + seed) * 43758.5453; return x - Math.floor(x); };
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + (prand(i * 3 + 1) - 0.5) * 0.7;
    const speed = (105 + prand(i * 3 + 2) * 115) * reach;
    const x = Math.cos(angle) * speed;
    const y = Math.sin(angle) * speed * 0.85 - 30;
    const size = 6 + prand(i * 3 + 3) * 9;
    const spin = (prand(i * 7 + 5) - 0.5) * 900;
    const delay = wait + Math.round(prand(i * 11 + 9) * 110);
    return `<span class="pt pt--${CONFETTI_KINDS[(i + seed) % CONFETTI_KINDS.length]}" style="--x:${x.toFixed(0)}px;--y:${
      y.toFixed(0)}px;--s:${size.toFixed(0)}px;--r:${spin.toFixed(0)}deg;--d:${delay}ms;--c:${CONFETTI[(i + seed) % CONFETTI.length]}"><i></i></span>`;
  }).join('');
}

function celebration(flash) {
  if (!flash?.celebrate) return '';
  return `<div class="yay" id="yay" role="status" aria-live="polite">
  <div class="yay__card">
    <div class="yay__stage" aria-hidden="true">
      <span class="yay__ring"></span><span class="yay__ring yay__ring--2"></span>
      <span class="yay__glow"></span>
      <div class="yay__field">${confetti(30)}${confetti(22, { seed: 3, reach: 1.45, wait: 520 })}</div>
      <div class="yay__disc"><svg viewBox="0 0 48 48" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"><path class="yay__check" d="M13.5 25l8 8 14-17"/></svg></div>
    </div>
    <h2 class="yay__title">${escape(flash.celebrate.title)}</h2>
    <p class="yay__text">${escape(flash.text)}</p>
    <button class="yay__ok" type="button" id="yay-ok">Lanjut</button>
  </div>
</div>`;
}

function kpiCard({ iconName, label, value, tone = '' }) {
  return `<article class="kpi ${tone}">
    <span class="kpi__ico">${svg(iconName)}</span>
    <div class="kpi__body">
      <p class="kpi__label">${escape(label)}</p>
      <p class="kpi__value">${escape(value)}</p>
    </div>
  </article>`;
}

function channelCard(id, bucket) {
  const meta = CHANNELS[id];
  const pills = STAGES.filter((s) => bucket.stages[s] > 0)
    .map((s) => `<span class="mini mini--${STAGE_META[s].tone}">${STAGE_META[s].label} <b>${bucket.stages[s]}</b></span>`)
    .join('');
  return `<article class="ch" style="--accent:${meta.accent}">
    <header class="ch__head">
      <span class="ch__dot" aria-hidden="true"></span>
      <h3>${escape(meta.label)}</h3>
      <span class="ch__count">${bucket.count}</span>
    </header>
    <p class="ch__rev">${escape(rupiah(bucket.revenue))}</p>
    ${stageBar(bucket.stages, bucket.count)}
    <div class="ch__pills">${pills || '<span class="mini mini--muted">Tidak ada pesanan</span>'}</div>
  </article>`;
}

// An order that is moving but has no AWB yet is waiting for pickup - that is different
// from an order where a tracking number will never exist, and the table should say so.
/**
 * The hour the courier's van leaves, in the shop's own clock.
 *
 * Bali runs on WITA, and a parcel handed over after three o'clock goes out tomorrow. So
 * "which of these can still make today" is a real question with a real answer, and the
 * selection button on the process page is that answer rather than a guess made by eye.
 */
export const DISPATCH_HOUR_WITA = 15;
// Taken from the zone table rather than written out, so there is one place that knows
// what WITA is. Every channel here reports UTC+8 too, which is why a card's own clock
// and this cut-off never disagree about which side of three o'clock an order fell.
const WITA_OFFSET_SECONDS = ZONES['Asia/Makassar'].offsetHours * 3600;

/** Today's cut-off, as an instant. Anything before it can still go out today. */
export function dispatchCutoff(nowEpochSeconds) {
  const shifted = nowEpochSeconds + WITA_OFFSET_SECONDS;
  const dayStart = Math.floor(shifted / 86400) * 86400 - WITA_OFFSET_SECONDS;
  return dayStart + DISPATCH_HOUR_WITA * 3600;
}

const AWAITING_AWB = new Set(['to_ship', 'shipping']);
/** Stages whose carrier waybill can exist; mirrors PRINTABLE_STAGES in labels.js. */
const PRINTABLE = new Set(['to_ship', 'shipping']);
/** Mirrors MAX_LABELS in api/labels.js; the button must not offer more than the server takes. */
const MAX_PRESELECT = 100;
/** Mirrors ID_SEARCH_MIN in db/orders.js: shorter than this, the server does not search. */
const ID_SEARCH_MIN = 4;

const idNumber = (n) => Number(n).toLocaleString('id-ID');

/**
 * The paging control: what is shown of how many, the page numbers, and the page size.
 *
 * Everything is a link, so it works without JavaScript, with the keyboard, in a new tab
 * and through history. The current page is marked for assistive tech, and disabled
 * ends are rendered as text rather than dead links.
 *
 * @param {ReturnType<typeof paginate>} paged
 * @param {{baseQuery: string, noun: string}} options
 */
/** "Kemas Ghani" → "KG"; an email → its first letter. */
export const initials = (name) => {
  const words = String(name ?? '').trim().split(/[\s@._-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
};

export function pager(paged, { baseQuery, noun }) {
  const { page, pages, total, from, to, perPage } = paged;
  const href = (p, per = perPage) => escape(pageHref(baseQuery, p, per));
  const summary = total
    ? `<span class="pager__sum">Menampilkan <b>${idNumber(from)}&ndash;${idNumber(to)}</b> dari <b>${idNumber(total)}</b> ${escape(noun)}</span>`
    : `<span class="pager__sum">0 ${escape(noun)}</span>`;

  const numbers = pages > 1
    ? pageWindow(page, pages).map((p) => p === null
      ? '<span class="pager__gap" aria-hidden="true">&hellip;</span>'
      : p === page
        ? `<span class="pager__n is-on" aria-current="page">${idNumber(p)}</span>`
        : `<a class="pager__n" href="${href(p)}" aria-label="Halaman ${p}">${idNumber(p)}</a>`).join('')
    : '';
  const prev = page > 1
    ? `<a class="pager__btn" href="${href(page - 1)}" rel="prev" aria-label="Halaman sebelumnya">${svg('chevL')}</a>`
    : `<span class="pager__btn is-off" aria-disabled="true">${svg('chevL')}</span>`;
  const next = page < pages
    ? `<a class="pager__btn" href="${href(page + 1)}" rel="next" aria-label="Halaman berikutnya">${svg('chevR')}</a>`
    : `<span class="pager__btn is-off" aria-disabled="true">${svg('chevR')}</span>`;

  const sizes = PER_PAGE_OPTIONS.map((n) => n === perPage
    ? `<span class="pager__size is-on" aria-current="true">${n}</span>`
    : `<a class="pager__size" href="${href(1, n)}" aria-label="${n} per halaman">${n}</a>`).join('');

  return `<nav class="pager" aria-label="Halaman ${escape(noun)}">
    ${summary}
    ${pages > 1 ? `<span class="pager__pages">${prev}${numbers}${next}</span>` : ''}
    <span class="pager__sizes"><span class="pager__lbl">Per halaman</span>${sizes}</span>
  </nav>`;
}

/**
 * The tag a row wears: the marketplace, or for a typed-in sale the source it was typed
 * in for. Every list that shows a channel goes through here - orders, the popup, the
 * worklist, the Jurnal ledger, the label queue - because "Manual" tells the operator
 * nothing and "WhatsApp / direct sales" tells them where the parcel came from.
 */
function channelTag(order) {
  const meta = channelMeta(order.channel);
  const source = order.channel === 'manual' ? PREFIXES[order.source]?.label : null;
  return `<span class="tag" style="--accent:${meta.accent}">${escape(source ?? meta.label)}</span>`;
}

function row(order, index) {
  const stage = STAGE_META[order.stage];
  const track = order.tracking
    ? `<span class="mono">${escape(order.tracking)}</span>`
    : AWAITING_AWB.has(order.stage)
      ? '<span class="await">menunggu</span>'
      : '<span class="dim">&mdash;</span>';
  return `<tr class="row" tabindex="0" role="button" aria-label="Rincian pesanan ${escape(order.id)}"
    data-detail="od-${index}" data-channel="${order.channel}" data-stage="${order.stage}">
    <td>${channelTag(order)}</td>
    <td class="mono nowrap">${escape(order.id)}</td>
    <td class="nowrap dim">${escape(dateTime(order.createdAt, order.channel))}</td>
    <td>${escape(order.buyer) || '<span class="dim">&mdash;</span>'}</td>
    <td class="num mono">${escape(rupiah(order.total))}</td>
    <td><span class="pill pill--${stage.tone}">${escape(stage.label)}</span></td>
    <td class="nowrap dim">${escape(order.carrier) || '&mdash;'}</td>
    <td class="nowrap">${track}</td>
  </tr>`;
}

/**
 * Read this one order again, from the platform, now.
 *
 * Shopify only, because Shopify is the only channel whose orders this shop's own staff
 * edit after the fact - a product swapped, an address corrected, a line added. Every
 * screen here is drawn from our stored copy, and a marketplace announces its own changes;
 * an edit made in the Shopify admin announces nothing, so the bench keeps looking at the
 * moment before with no way to tell.
 *
 * `back` is the query string the operator is standing on, so pressing this does not throw
 * away the filter or the page they had open.
 */
function refreshButton(order, { csrf, back }) {
  if (order.channel !== 'shopify' || !csrf) return '';
  return `<form class="od__sync" method="post">
    <input type="hidden" name="csrf" value="${escape(csrf)}">
    <input type="hidden" name="action" value="refresh_order">
    <input type="hidden" name="channel" value="shopify">
    <input type="hidden" name="order" value="${escape(order.id)}">
    <input type="hidden" name="view" value="orders">
    <input type="hidden" name="back" value="${escape(back)}">
    <button class="od__sync__b" type="submit">${svg('refresh')}<span>Ambil data terbaru</span></button>
    <span class="od__sync__n">Baca ulang pesanan ini dari Shopify, lalu samakan label, picklist dan semua daftar lain.</span>
  </form>`;
}

/**
 * Throw away a sale that was typed in by mistake.
 *
 * Only a typed-in one. Every other order on this dashboard describes something that
 * happened on a platform whether or not we like it, and deleting our row would only make
 * it come back on the next sweep. A consignment slip entered twice describes nothing, and
 * until now taking it back meant opening Jurnal, deleting the invoice by hand, and
 * leaving this list still showing it.
 */
/**
 * Correct a WhatsApp order that was agreed in a conversation that carried on.
 *
 * Only WhatsApp. A consignment slip or a walk-in is written down after the fact from
 * something that already happened; a WhatsApp sale is still being negotiated while it
 * sits here, and until now a jar added meant deleting the whole transaction and typing it
 * again - which loses the invoice number in Jurnal along with it.
 */
export const EDITABLE_MANUAL_SOURCES = new Set(['DP']);

function editButton(order, { back }) {
  if (order.channel !== 'manual' || !EDITABLE_MANUAL_SOURCES.has(String(order.source ?? '').toUpperCase())) return '';
  return `<a class="od__sync__b" href="?view=jurnal&amp;edit=${escape(encodeURIComponent(order.id))}&amp;back=${escape(encodeURIComponent(back))}">
    ${svg('list')}<span>Ubah transaksi</span></a>`;
}

function discardButton(order, { csrf, back }) {
  if (order.channel !== 'manual' || !csrf) return '';
  const isResend = String(order.source ?? '').toUpperCase() === 'RS';
  return `<form class="od__sync od__sync--bad" method="post"
      data-confirm="${isResend
        ? `Hapus ${escape(order.id)}? Catatan kirim ulang ini hilang dari dashboard, dan ini tidak bisa dibatalkan.`
        : `Hapus ${escape(order.id)} senilai ${escape(rupiah(order.total))}? Fakturnya di Mekari Jurnal ikut dihapus, dan ini tidak bisa dibatalkan.`}">
    <input type="hidden" name="csrf" value="${escape(csrf)}">
    <input type="hidden" name="action" value="discard_manual">
    <input type="hidden" name="order" value="${escape(order.id)}">
    <input type="hidden" name="view" value="orders">
    <input type="hidden" name="back" value="${escape(back)}">
    <button class="od__sync__b um__act--bad" type="submit">${svg('trash')}<span>Hapus transaksi</span></button>
    ${editButton(order, { back })}
    <span class="od__sync__n">${isResend
      // A resend never reached Jurnal, so saying its invoice goes with it would be
      // describing a document that does not exist.
      ? 'Kirim ulang tidak pernah masuk Mekari Jurnal, jadi menghapusnya hanya menghapus catatan di dashboard ini.'
      : 'Transaksi yang diketik manual. Menghapusnya juga menghapus fakturnya di Jurnal - kecuali faktur itu sudah menerima pembayaran.'}</span>
  </form>`;
}

/**
 * Everything known about one order, as the popup shows it.
 *
 * Rendered with the list rather than fetched on click: the page already holds the whole
 * order, so opening it costs nothing and works with the network off. Escaping happens
 * here, once, which is why the dialog copies markup instead of parsing a data attribute.
 */
function orderDetail(order, index, { csrf = null, back = '' } = {}) {
  const stage = STAGE_META[order.stage];
  const lines = order.finance?.lines?.length ? order.finance.lines : (order.lines ?? []);
  const units = lines.reduce((n, l) => n + (Number(l.qty) || 0), 0);

  const field = (label, value, mono = false) => (value
    ? `<div class="od__f"><dt>${escape(label)}</dt><dd${mono ? ' class="mono"' : ''}>${escape(value)}</dd></div>`
    : '');

  const items = lines.map((l) => `<tr>
    <td>
      <span class="od__n">${escape(l.name || l.sku)}</span>
      ${l.variant ? `<span class="od__v">${escape(l.variant)}</span>` : ''}
      <span class="od__s mono">${escape(l.sku ?? '')}</span>
    </td>
    <td class="num mono">${escape(String(l.qty ?? 0))}</td>
    ${l.unitPrice === undefined ? '' : `<td class="num mono">${escape(rupiah(l.unitPrice))}</td>`}
    ${l.unitPrice === undefined ? '' : `<td class="num mono">${escape(rupiah((l.unitPrice - (l.unitDiscount ?? 0)) * (l.qty ?? 0)))}</td>`}
  </tr>`).join('');

  const priced = lines.some((l) => l.unitPrice !== undefined);

  return `<div id="od-${index}">
    <div class="od__head">
      ${channelTag(order)}
      <span class="pill pill--${stage.tone}">${escape(stage.label)}</span>
      <span class="od__when">${escape(dateTime(order.createdAt, order.channel))}</span>
    </div>
    ${order.editedBy ? `<p class="od__edited">${svg('warn')}<span>Diubah oleh <b>${escape(order.editedBy)}</b> &middot; ${
      escape(dateTime(order.editedAt, order.channel))}${
      Number(order.editedTimes) > 1 ? ` &middot; ${escape(String(order.editedTimes))}&times;` : ''}</span></p>` : ''}

    <p class="od__id mono">${escape(order.id)}</p>
    ${order.resendFor?.id ? `<p class="od__ref">
      <span class="od__ref__l">Kirim ulang untuk</span>
      <a class="od__ref__a mono" href="?view=orders&amp;q=${escape(encodeURIComponent(order.resendFor.id))}">${escape(order.resendFor.id)}</a>
      <span class="dim">${escape(CHANNELS[order.resendFor.channel]?.label ?? order.resendFor.channel)}</span>
      ${order.finance?.wrongGoods?.value
        ? `<span class="od__ref__v">barang hilang ${escape(rupiah(order.finance.wrongGoods.value))}</span>` : ''}
    </p>
    ${order.finance?.wrongGoods?.lines?.length ? `<ul class="od__wrong">${
      order.finance.wrongGoods.lines.map((l) => `<li><span>${escape(l.name || l.sku)}</span><b class="mono">${escape(String(l.qty ?? 0))}</b></li>`).join('')
    }</ul>` : ''}` : ''}

    <dl class="od__grid">
      ${field('Pembeli', order.buyer)}
      ${field('Username Shopee', order.buyerUsername, true)}
      ${field('Telepon', order.buyerPhone, true)}
      ${field('Email', order.buyerEmail)}
      ${field('Kurir', order.carrier)}
      ${field('Resi', order.tracking, true)}
      ${field('Status platform', order.status)}
    </dl>
    ${order.shipTo ? `<dl class="od__grid od__grid--wide">${field('Alamat', order.shipTo)}</dl>` : ''}

    ${items ? `<table class="od__items">
      <thead><tr><th>Produk</th><th class="num">Qty</th>${priced ? '<th class="num">Harga</th><th class="num">Subtotal</th>' : ''}</tr></thead>
      <tbody>${items}</tbody>
    </table>` : ''}

    <dl class="od__sum">
      <div><dt>Unit</dt><dd class="mono">${escape(String(units))}</dd></div>
      ${order.finance?.shipping ? `<div><dt>Ongkir</dt><dd class="mono">${escape(rupiah(order.finance.shipping))}</dd></div>` : ''}
      <div class="od__total"><dt>Total</dt><dd class="mono">${escape(rupiah(order.total))}</dd></div>
    </dl>

    ${refreshButton(order, { csrf, back })}
    ${discardButton(order, { csrf, back })}

    <a class="od__print" target="_blank" rel="noopener"
       href="/api/invoice?channel=${escape(order.channel)}&amp;id=${escape(encodeURIComponent(order.id))}">
      ${svg('printer')}<span>Cetak faktur</span>
    </a>
  </div>`;
}

/**
 * The age of the oldest row behind a page, in words.
 *
 * Silent when everything is recent, because a line that always says "fine" is a line
 * nobody reads. It speaks when the data is older than the rhythm that maintains it - a
 * push, or the fifteen-minute sweep - and louder when a re-read was attempted and failed,
 * since that is the case where the screen is knowingly behind.
 */
export function ageOfData(readAt, generatedAt, settleFailed = false) {
  if (settleFailed) {
    return { tone: 'bad', text: 'platform tidak bisa dibaca ulang - data mungkin tertinggal' };
  }
  if (!readAt) return null;
  const minutes = Math.floor((generatedAt - readAt * 1000) / 60_000);
  if (minutes < 15) return null;
  if (minutes < 120) return { tone: 'flag', text: `baris tertua dibaca ${minutes} menit lalu` };
  const hours = Math.round(minutes / 60);
  return { tone: 'bad', text: `baris tertua dibaca ${hours} jam lalu` };
}

export function shell({
  title, range, errors = {}, truncated = [], maxPerPlatform, shopeeShop, generatedAt,
  view, kpis = '', body = '', hideRangeControls = false, script = '', flash = null, scope = null,
  stale = false, staleSince = null, user = null, style = '', log = false, csrf = null,
  readAt = null, settleFailed = false,
}) {
  /*
   * How old the rows are, said out loud.
   *
   * "diperbarui 08.39" is the clock this page was drawn on, and it was being read as the
   * age of the data. It is not: a worklist is drawn from our table, and a row in it can
   * be hours older than the render. Saying both, separately, is the only honest version -
   * and when a row turns out to be from another era, that is exactly what somebody needs
   * to see before they act on it.
   */
  const dataAge = ageOfData(readAt, generatedAt, settleFailed);
  const who = user
    ? `<a class="who" href="?view=activity&amp;actor=${escape(user.id)}" title="${escape(user.email)} · ${escape(ROLES[user.role]?.label ?? user.role)}">
        <span class="who__av" aria-hidden="true">${escape(initials(user.name || user.email))}</span>
        <span class="who__t"><span class="who__n">${escape(user.name || user.email)}</span><span class="who__r">${escape(ROLES[user.role]?.label ?? user.role)}</span></span>
      </a>`
    : '';
  const nav = viewNav(view, rangeQuery(range), user, { log });
  const presetLink = (id) => `?view=${view}&preset=${id}`;
  const self = range.preset ? presetLink(range.preset) : `?view=${view}&from=${range.from}&to=${range.to}`;

  const windows = Object.entries(PRESETS)
    .map(([id, meta]) => `<a class="win ${id === range.preset ? 'is-on' : ''}" href="${escape(presetLink(id))}">${escape(meta.label)}</a>`)
    .join('');

  const notice = flash
    ? `<div class="alert ${flash.kind === 'error' ? '' : 'alert--ok'}"${flash.kind === 'error' ? '' : ' data-brief'} role="status">${svg(flash.kind === 'error' ? 'warn' : 'check')}<span>${escape(flash.text)}</span></div>`
    : '';

  // Every error the operator can do something about gets the one action that helps:
  // try again. Without it the only recourse is guessing at the browser's reload button.
  const retry = `<a class="alert__btn" href="${escape(self)}${self.includes('?') ? '&' : '?'}retry=${Date.now()}">${svg('refresh')}Muat ulang</a>`;

  const staleNote = stale
    ? `<div class="alert alert--soft">${svg('warn')}<span>Menampilkan data terakhir yang berhasil dimuat${
        staleSince ? ` (${escape(staleSince)})` : ''}. Marketplace sedang tidak merespons.</span>${retry}</div>`
    : '';

  const problems = notice + staleNote + [
    ...Object.entries(errors).map(
      ([k, v]) => `<div class="alert">${svg('warn')}<span><b>${escape(k)}</b> gagal dimuat &mdash; ${escape(v)}</span>${retry}</div>`,
    ),
    ...(truncated.length > 0
      ? [`<div class="alert alert--soft">${svg('warn')}<span>Dipotong di ${maxPerPlatform} pesanan untuk ${escape(truncated.join(' dan '))}. Persempit rentang tanggal untuk melihat semuanya.</span></div>`]
      : []),
    ...(range.clamped
      ? [`<div class="alert alert--soft">${svg('warn')}<span>Rentang dipersingkat ke maksimum 90 hari.</span></div>`]
      : []),
  ].join('');

  const rangeControls = hideRangeControls ? '' : `
      <nav class="wins" aria-label="Rentang cepat">${windows}</nav>
      <form class="daterange" method="get" role="search" aria-label="Rentang tanggal khusus">
        <input type="hidden" name="view" value="${escape(view)}">
        <label class="dr__lbl" for="from">Dari</label>
        <input class="dr__in" id="from" name="from" type="date" value="${escape(range.from)}" max="${escape(todayWib())}">
        <label class="dr__lbl" for="to">s/d</label>
        <input class="dr__in" id="to" name="to" type="date" value="${escape(range.to)}" max="${escape(todayWib())}">
        <button class="dr__go" type="submit">Terapkan</button>
      </form>`;

  return `<!doctype html><html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escape(title)} &mdash; Treelogy</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="mask-icon" href="/favicon.svg" color="#526547">
<meta name="theme-color" content="#1E2A27" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#F3F4EF" media="(prefers-color-scheme: light)">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap">
<style>
/* --- Treelogy palette, taken from the live storefront (treelogy.com) rather than
   invented: #526547 sage is the brand primary, #2b3c35 the deep forest it sits on,
   #f8f8f2 the warm off-white, #108474 the teal accent. Inter is the storefront face.

   The chrome is three surfaces deep: a slate-green backdrop, frosted glass panels on it,
   and one ink slab per page for the numbers that matter. The only warm colour on screen
   is the commit button, so the eye finds the one thing that writes. --- */
:root{
  --bg:#121A18; --bg-2:#1E2A27; --glow:#526547;
  --panel:#1A2320; --panel-2:#222D29; --line:#2C3934;
  --glass:rgba(255,255,255,.045); --glass-2:rgba(255,255,255,.085); --glass-line:rgba(255,255,255,.09);
  --ink:#141B19; --ink-2:#1C2522; --ink-line:rgba(255,255,255,.08);
  --fg:#F1F3EE; --muted:#A7B3A6; --dim:#839187;
  --brand:#8FA97F; --brand-deep:#526547; --accent:#3FB8A4;
  --fill-a:#5E7352; --fill-b:#3C4C36;
  /* White on #C2531C is 4.6:1. The brighter --cta-hi is for orange text on ink only. */
  --cta-a:#C2531C; --cta-b:#9E4216; --cta-hi:#F08A4B;
  --good:#6FBF8B; --info:#5FB3C9; --warn:#E2B252; --act:#F08A4B; --bad:#E08573; --done:#9D8FC4;
  --radius:18px; --radius-s:12px; --blur:18px; --top-offset:4.75rem;
  --shadow:0 1px 2px rgba(0,0,0,.35), 0 18px 44px -26px rgba(0,0,0,.75);
  /* power3.out from the motion doctrine: the house entrance curve. Smooth, never bouncy. */
  --ease-out:cubic-bezier(.25,1,.5,1);
  --ease-soft:cubic-bezier(.37,0,.63,1);
  --t-fast:160ms; --t-base:240ms; --t-slow:420ms;
  color-scheme:dark;
}
@media (prefers-color-scheme:light){
  :root:not([data-theme="dark"]){
    --bg:#E8EBE4; --bg-2:#F3F4EF; --glow:#8FA97F;
    --panel:#FFFFFF; --panel-2:#F3F5EF; --line:#DADFD3;
    --glass:rgba(255,255,255,.66); --glass-2:rgba(255,255,255,.88); --glass-line:rgba(30,42,36,.10);
    --ink:#161E1B; --ink-2:#1F2926; --ink-line:rgba(255,255,255,.09);
    --fg:#1B2621; --muted:#4F5D53; --dim:#66746A;
    --brand:#526547; --brand-deep:#3C4C36; --accent:#0E7A6B;
    --fill-a:#526547; --fill-b:#3C4C36;
    --cta-a:#B9491A; --cta-b:#8F3812; --cta-hi:#D9692F;
    --good:#2F7D4F; --info:#1C6E86; --warn:#8A5A12; --act:#B4471A; --bad:#A8412E; --done:#5B4A93;
    --shadow:0 1px 2px rgba(43,60,53,.06), 0 18px 44px -28px rgba(43,60,53,.4);
    color-scheme:light;
  }
}
:root[data-theme="light"]{
  --bg:#E8EBE4; --bg-2:#F3F4EF; --glow:#8FA97F;
  --panel:#FFFFFF; --panel-2:#F3F5EF; --line:#DADFD3;
  --glass:rgba(255,255,255,.66); --glass-2:rgba(255,255,255,.88); --glass-line:rgba(30,42,36,.10);
  --ink:#161E1B; --ink-2:#1F2926; --ink-line:rgba(255,255,255,.09);
  --fg:#1B2621; --muted:#4F5D53; --dim:#66746A;
  --brand:#526547; --brand-deep:#3C4C36; --accent:#0E7A6B;
  --fill-a:#526547; --fill-b:#3C4C36;
  --cta-a:#B9491A; --cta-b:#8F3812; --cta-hi:#D9692F;
  --good:#2F7D4F; --info:#1C6E86; --warn:#8A5A12; --act:#B4471A; --bad:#A8412E; --done:#5B4A93;
  --shadow:0 1px 2px rgba(43,60,53,.06), 0 18px 44px -28px rgba(43,60,53,.4);
  color-scheme:light;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  color:var(--fg); min-height:100vh; padding:.75rem 1.25rem 1.5rem;
  background-color:var(--bg);
  background-image:
    radial-gradient(70rem 34rem at 8% -12%, color-mix(in srgb,var(--glow) 30%,transparent), transparent 62%),
    radial-gradient(48rem 26rem at 104% 4%, color-mix(in srgb,var(--accent) 12%,transparent), transparent 60%),
    linear-gradient(180deg,var(--bg-2),var(--bg) 46rem);
  background-attachment:fixed;
  font:400 15px/1.6 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1400px; margin:0 auto}
.mono{font-family:"Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86em; font-variant-numeric:tabular-nums}
.dim{color:var(--dim)} .nowrap{white-space:nowrap} .num{text-align:right}
.ico{width:20px;height:20px;flex:none}
/* The ink slab is dark in both themes, so everything inside it takes pinned tokens
   rather than the page's. A chip or a search box dropped into it just works. */
.kpis,.strip{
  --panel:#1F2926; --panel-2:#27322E; --line:rgba(255,255,255,.09);
  --glass:rgba(255,255,255,.06); --glass-2:rgba(255,255,255,.11); --glass-line:rgba(255,255,255,.11);
  --fg:#F1F3EE; --muted:#A3AFA5; --dim:#8C9A90; --brand:#8FA97F; --accent:#3FB8A4;
  --good:#6FBF8B; --info:#5FB3C9; --warn:#E2B252; --act:#F08A4B; --bad:#E08573; --done:#9D8FC4;
  color:var(--fg); color-scheme:dark;
  background:linear-gradient(180deg,var(--ink-2),var(--ink)); border:1px solid var(--ink-line);
  box-shadow:var(--shadow), inset 0 1px 0 rgba(255,255,255,.05)}

/* ---- the pill: brand, the pages and who is here, floating in one piece of glass ---- */
.top{position:sticky; top:.75rem; z-index:40; display:flex; align-items:center; gap:.4rem;
  padding:.4rem .5rem; margin:0 0 1.4rem; border-radius:999px;
  background:color-mix(in srgb,var(--panel) 72%,transparent);
  backdrop-filter:blur(var(--blur)) saturate(1.5); -webkit-backdrop-filter:blur(var(--blur)) saturate(1.5);
  border:1px solid var(--glass-line);
  box-shadow:var(--shadow), inset 0 1px 0 rgba(255,255,255,.06)}
.brandline{display:flex; align-items:center; gap:.55rem; padding:.15rem .7rem .15rem .15rem; flex:none;
  text-decoration:none; color:inherit; border-radius:999px}
.logo{width:36px;height:36px;border-radius:50%;flex:none;display:grid;place-items:center;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b)); color:#fff;
  font-weight:600; font-size:.95rem; letter-spacing:-.01em;
  box-shadow:0 0 0 1px rgba(255,255,255,.08) inset, 0 6px 14px -8px color-mix(in srgb,var(--brand) 70%,transparent)}
.brand__n{font-size:.92rem; font-weight:600; letter-spacing:-.01em; white-space:nowrap}
.tools{display:flex; gap:.25rem; align-items:center; flex:none; margin-left:auto}
.iconbtn{width:38px;height:38px;border-radius:50%;border:1px solid transparent;background:transparent;
  color:var(--muted); display:grid; place-items:center; cursor:pointer;
  transition:color var(--t-fast) var(--ease-out),background var(--t-fast) var(--ease-out)}
.iconbtn:hover{color:var(--fg); background:var(--glass-2)}
.iconbtn.is-on{color:var(--bg); background:var(--fg)}
:where(a,button,input,select,textarea):focus-visible{outline:2px solid var(--brand); outline-offset:2px}

/* The pages sit inside the pill. Under 1280px the row drops beneath the brand and scrolls
   sideways rather than widening the page. */
.views{display:flex; gap:2px; flex:1 1 auto; min-width:0; justify-content:center; padding:0 .25rem;
  overflow-x:auto; scrollbar-width:none; -webkit-overflow-scrolling:touch}
.views::-webkit-scrollbar{display:none}
.viewtab{flex:none; padding:.5rem .95rem; border-radius:999px; font-size:.85rem; font-weight:500; text-decoration:none;
  color:var(--muted); white-space:nowrap;
  transition:background var(--t-fast) var(--ease-out),color var(--t-fast) var(--ease-out)}
.viewtab:hover{color:var(--fg); background:var(--glass-2)}
.viewtab.is-on{color:var(--bg); background:var(--fg); font-weight:600; box-shadow:0 8px 18px -12px rgba(0,0,0,.6)}
@media (max-width:1280px){
  :root{--top-offset:7.6rem}
  .top{flex-wrap:wrap; border-radius:26px}
  .views{order:3; flex-basis:100%; justify-content:flex-start; margin-top:.35rem; padding:.4rem .1rem .1rem;
    border-top:1px solid var(--glass-line)}
}

/* ---- page head: the title at display size, and the controls that shape the page ---- */
.pagehead{display:flex; flex-wrap:wrap; align-items:flex-end; justify-content:space-between; gap:.9rem 1.5rem;
  margin:0 .15rem 1.1rem; animation:rise var(--t-slow) var(--ease-out) both}
.pagehead__t{min-width:0}
h1{margin:0; font-size:clamp(1.55rem,2.6vw,2.1rem); font-weight:600; letter-spacing:-.03em; line-height:1.1}
.sub{margin:.4rem 0 0; font-size:.82rem; color:var(--muted)}
.pagehead__acts{display:flex; gap:.5rem; align-items:center; flex-wrap:wrap}
.wins{display:flex; gap:2px; padding:3px; border-radius:999px; background:var(--glass); border:1px solid var(--glass-line)}
.win{padding:.35rem .8rem; border-radius:999px; font-size:.8rem; color:var(--muted); text-decoration:none;
  min-height:32px; display:flex; align-items:center; cursor:pointer;
  transition:background var(--t-fast) var(--ease-out),color var(--t-fast) var(--ease-out)}
.win:hover{color:var(--fg); background:var(--glass-2)}
.win.is-on{background:var(--fg); color:var(--bg); font-weight:600}

/* ---- alerts ---- */
.alert{display:flex; gap:.6rem; align-items:center; padding:.75rem 1rem; margin-bottom:.75rem;
  border:1px solid color-mix(in srgb,var(--bad) 40%,transparent); border-radius:10px;
  background:color-mix(in srgb,var(--bad) 12%,transparent); color:var(--fg); font-size:.88rem}
.alert .ico{color:var(--bad)}
.alert__btn{margin-left:auto; flex:none; display:inline-flex; align-items:center; gap:.35rem;
  font-size:.82rem; font-weight:500; padding:.35rem .7rem; min-height:34px; border-radius:8px;
  text-decoration:none; color:var(--fg); background:var(--panel-2); border:1px solid var(--line);
  transition:border-color .2s,color .2s}
.alert__btn:hover{border-color:var(--brand)}
.alert__btn .ico{width:16px; height:16px; color:inherit}

.viewadd{flex:none; display:inline-flex; align-items:center; gap:.4rem; padding:.5rem 1rem; min-height:38px; border-radius:999px;
  font-size:.82rem; font-weight:600; color:#fff; text-decoration:none; border:1px solid transparent;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b)); transition:filter var(--t-base) var(--ease-out)}
.viewadd:hover{filter:brightness(1.12)}
.viewadd .ico{width:16px; height:16px}
.viewlog{flex:none; display:inline-flex; align-items:center; gap:.4rem; padding:.5rem .9rem; min-height:38px; border-radius:999px;
  font-size:.82rem; font-weight:500; color:var(--muted); text-decoration:none;
  border:1px solid var(--glass-line); background:var(--glass);
  transition:color var(--t-fast), border-color var(--t-fast), background var(--t-fast)}
.viewlog:hover{color:var(--fg); background:var(--glass-2)}
.viewlog .ico{width:16px; height:16px}
@media (max-width:640px){
  .pagehead__acts{width:100%}
  .viewlog,.viewadd{flex:1; justify-content:center}
  .wins{width:100%; justify-content:space-between} .win{flex:1; justify-content:center; padding:.35rem .4rem}
  .daterange{width:100%; border-radius:20px; padding:.5rem .6rem; gap:.4rem}
  .dr__in{flex:1; min-width:0} .dr__go{flex-basis:100%; min-height:36px}
}
.ok{color:var(--good)} .flag{color:var(--warn)} .stop{color:var(--bad)}
.note{font-size:.75rem; color:var(--muted)}
/* --- the ink slab: this page's numbers at display size, hairlines between them --- */
.strip{display:flex; align-items:center; gap:.5rem 0; flex-wrap:wrap; padding:.25rem 1.1rem; margin-bottom:1rem;
  border-radius:var(--radius)}
.strip__grow{flex:1}
.backbar{margin:0 0 .85rem}
.stat{display:flex; flex-direction:column-reverse; gap:.3rem; white-space:nowrap; padding:1rem 1.6rem 1rem 0; margin-right:1.6rem;
  border-right:1px solid var(--ink-line)}
.stat__n{font-size:clamp(1.45rem,2vw,1.9rem); font-weight:600; letter-spacing:-.03em; line-height:1;
  font-variant-numeric:tabular-nums}
.stat__l{font-size:.66rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted)}
.strip .search{min-width:190px}
@media (max-width:640px){ .stat{padding:.7rem 1rem .7rem 0; margin-right:1rem} .strip{padding:.15rem .9rem} }

/* --- product cards: three across on a desktop, one on a phone --- */
/* 190px, not 300px. The picture is square and spans the card, so the column width sets
   the card height twice over - at 300px a row of five filled the screen and everything
   else was a scroll away. At this width a 1900px screen shows nine across and three rows
   deep, which is most of the catalogue at once. */
.cards{display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:.55rem; padding:1rem}
.grp{grid-column:1/-1; margin:.6rem 0 -.1rem; font-size:.72rem; letter-spacing:.08em;
  text-transform:uppercase; color:var(--muted); font-weight:500}
.grp:first-child{margin-top:0}
.grp__n{margin-left:.5rem; opacity:.55; letter-spacing:0}
.grp--fam{margin:.35rem 0 -.2rem; font-size:.84rem; letter-spacing:0; text-transform:none; font-weight:600; color:var(--fg)}
.grp--fam .grp__n{font-weight:400; font-size:.72rem; letter-spacing:.06em; text-transform:uppercase}
.grp[hidden],.card[hidden]{display:none}

.card{position:relative}
.card__link{display:flex; flex-direction:column; gap:.25rem; color:inherit; text-decoration:none; border-radius:inherit}
.card__link:focus-visible{outline:2px solid var(--brand); outline-offset:3px}
.card__pick{position:absolute; top:.95rem; left:.95rem; z-index:2; display:grid; place-items:center; width:28px; height:28px; border-radius:8px; cursor:pointer;
  background:color-mix(in srgb, var(--panel) 82%, transparent); border:1px solid var(--line); opacity:0; transition:opacity var(--t-fast)}
.card:hover .card__pick, .card__pick:focus-within, .cards.is-picking .card__pick, .card.is-picked .card__pick{opacity:1}
.card__pick input{accent-color:var(--brand); width:16px; height:16px; margin:0; cursor:pointer}
.card.is-picked{border-color:var(--brand); box-shadow:0 0 0 1px var(--brand) inset}
.card__dots{display:inline-flex; gap:.3rem; align-items:center}
.dot{width:8px; height:8px; border-radius:50%; display:inline-block; background:var(--dim)}
.dot--live{background:var(--good, #6fbf73)}
.dot--off{background:transparent; border:1.5px solid var(--muted)}
.dot--none{background:transparent; border:1.5px dashed var(--dim)}
.pl__bar{display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; padding:1rem 1rem 0}
.pl__filters{display:flex; flex-wrap:wrap; gap:.35rem; flex:1}
.pl__view{display:inline-flex; border:1px solid var(--line); border-radius:9px; overflow:hidden}
.pl__vbtn{display:grid; place-items:center; width:40px; height:36px; border:0; background:transparent; color:var(--muted); cursor:pointer}
.pl__vbtn.is-on{background:var(--panel-2); color:var(--fg)}
.pl__vbtn .ico{width:17px; height:17px}
.pl__vbtn:focus-visible{outline:2px solid var(--brand); outline-offset:-2px}
/* Table view: the same cards, laid out as rows - nothing re-rendered, just restyled. */
.cards.is-table{grid-template-columns:minmax(0,1fr); gap:.3rem}
.cards.is-table .card{padding:.4rem .6rem .4rem 3rem}
.cards.is-table .card__pick{top:50%; left:.7rem; transform:translateY(-50%); opacity:1}
.cards.is-table .card__link{display:grid; grid-template-columns:44px minmax(0,2.2fr) minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,1fr); align-items:center; gap:.9rem}
.cards.is-table .card__img{width:44px; height:44px; aspect-ratio:1; font-size:0}
.cards.is-table .card__top{grid-column:2; grid-row:1}
.cards.is-table .card__sku{grid-column:3; grid-row:1}
.cards.is-table .card__stock{grid-column:4; grid-row:1; border:0; padding:0; margin:0}
.cards.is-table .card__foot{grid-column:5; grid-row:1}
.cards.is-table .card:hover{transform:none}
.bk{position:sticky; bottom:0; z-index:20; margin:1rem; padding:.75rem .9rem; border:1px solid color-mix(in srgb, var(--brand) 45%, var(--line)); border-radius:var(--radius);
  background:color-mix(in srgb, var(--panel) 92%, transparent); backdrop-filter:blur(var(--blur)); box-shadow:0 18px 40px -24px rgba(0,0,0,.6)}
.bk__row{display:flex; align-items:center; gap:.45rem; flex-wrap:wrap}
.bk__n{font-size:.86rem; margin-right:.4rem}
.bk__btn{font:inherit; font-size:.8rem; min-height:38px; padding:.35rem .8rem; border-radius:999px; border:1px solid var(--line); background:var(--panel-2); color:var(--fg); cursor:pointer;
  transition:border-color var(--t-fast)}
.bk__btn:hover{border-color:var(--brand)}
.bk__btn.is-on{border-color:var(--brand); color:var(--brand)}
.bk__btn--bad:hover{border-color:var(--bad); color:var(--bad)}
.bk__btn:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.bk[hidden], .bk__f[hidden]{display:none}
.bk__f{display:flex; align-items:flex-end; gap:.6rem; flex-wrap:wrap; margin-top:.75rem; padding-top:.75rem; border-top:1px solid var(--line)}
.bk__in{display:flex; flex-direction:column; gap:.25rem; font-size:.74rem; color:var(--muted)}
.bk__in input, .bk__in select{font:inherit; font-size:.88rem; color:var(--fg); background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding:.45rem .6rem; min-height:40px; min-width:9rem}
.bk__chs{display:flex; gap:.4rem; flex-wrap:wrap}
.bk__chs label, .bk__chk{display:inline-flex; align-items:center; gap:.35rem; font-size:.8rem; padding:.35rem .6rem; min-height:40px; border:1px solid var(--line); border-radius:999px; cursor:pointer}
.bk__chs input, .bk__chk input{accent-color:var(--brand); margin:0}
.bk__note{font-size:.8rem; color:var(--muted); align-self:center}
@media (max-width:760px){.cards.is-table .card__link{grid-template-columns:44px minmax(0,1fr); row-gap:.2rem} .cards.is-table .card__sku,.cards.is-table .card__stock,.cards.is-table .card__foot{grid-column:2; grid-row:auto}}
.card{display:flex; flex-direction:column; gap:.25rem; padding:.55rem .6rem; text-decoration:none;
  color:var(--fg); background:var(--glass-2); border:1px solid var(--glass-line); border-radius:var(--radius-s);
  transition:border-color var(--t-base) var(--ease-out),background var(--t-base) var(--ease-out),transform var(--t-base) var(--ease-out)}
.card:hover{border-color:var(--brand); background:var(--panel); transform:translateY(-2px);
  box-shadow:0 8px 20px -14px color-mix(in srgb,var(--brand) 70%,transparent)}
.card:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.card__top{display:flex; align-items:baseline; gap:.35rem; flex-wrap:wrap}
.card__name{font-size:.82rem; font-weight:500; line-height:1.25}
.card__sku{font-size:.64rem; color:var(--dim)}
/* Label above number rather than beside it. Three channels side by side as "TOKPED 199"
   needs more width than a 190px card has, and wrapping them put the Shopify count on a
   line of its own at random. Stacked, all three fit in one tidy row at any width. */
.card__stock{display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:.25rem;
  padding:.3rem 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); margin-top:.1rem}
.qty{display:flex; flex-direction:column; align-items:center; gap:.05rem; font-size:.82rem; min-width:0}
.qty i{font-style:normal; font-size:.58rem; letter-spacing:.04em; text-transform:uppercase; color:var(--muted);
  font-family:"Inter",sans-serif}
.qty b{font-weight:600; font-variant-numeric:tabular-nums}
.card__foot{display:flex; align-items:center; justify-content:space-between; gap:.35rem;
  flex-wrap:wrap; font-size:.76rem}
.badge{font-size:.63rem; letter-spacing:.04em; text-transform:uppercase;
  padding:.1rem .35rem; border-radius:4px; background:var(--panel); color:var(--muted)}
.badge--b{color:var(--done); background:color-mix(in srgb,var(--done) 16%,transparent)}
.row{cursor:pointer}

/* --- dense tables: two lines of content in the height one used to take --- */
.dense td{padding:.5rem 1rem; vertical-align:middle}
.dense th{padding:.55rem 1rem}
.pick__n{display:block; font-size:.88rem; line-height:1.35}
.pick__s{display:block; font-size:.72rem; color:var(--dim); line-height:1.3; margin-top:.05rem}
.pick__q{font-size:1.25rem; font-weight:600; font-variant-numeric:tabular-nums;
  text-align:right; width:1%; white-space:nowrap; color:var(--fg)}
.pick__c{white-space:nowrap}
.pick__c .mini{border:1px solid color-mix(in srgb,var(--chip,var(--line)) 45%,transparent);
  color:var(--chip,var(--muted)); background:transparent; margin-right:.25rem}
.strip .note{font-size:.76rem}
/* --- worklist --- */
.wl__bar{display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; padding:0 1rem 1rem}
.wl__sep{width:1px; height:22px; background:var(--line); margin:0 .25rem}
/* The commit button follows the list down the page - on a thirty-order day the action
   should never be something you have to scroll back to find. */
.wl__go{position:sticky; bottom:0; padding:1rem; margin-top:.5rem;
  background:linear-gradient(to top,color-mix(in srgb,var(--bg) 94%,transparent) 65%,transparent);
  display:flex; justify-content:center}
.wl__go .wo__go{max-width:24rem}

/* --- the queue, one row per parcel --- */
.wtab__wrap{padding:0 1rem}
.wtab{width:100%; border-collapse:separate; border-spacing:0; font-size:.86rem}
/* Not sticky. The wrapper scrolls sideways on a narrow screen, and a horizontal scroll
   container is a scroll container in both directions - a header pinned to it lands part
   way down the table instead of at the top of the viewport. The commit bar follows the
   page down; the header does not need to. */
.wtab thead th{text-align:left;
  font-size:.68rem; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--dim);
  padding:.55rem .7rem; white-space:nowrap; border-bottom:1px solid var(--line)}
.wtab tbody td{padding:.6rem .7rem; border-bottom:1px solid var(--line); vertical-align:middle}
.wtab tbody tr:last-child td{border-bottom:0}
.wtab .num{text-align:right; font-variant-numeric:tabular-nums}
.wtab__pick{width:1%; padding-right:0}
.wtab__who{max-width:14rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.wtab__car{display:inline-flex; align-items:center; gap:.35rem; color:var(--muted)}
.wtab__sla{width:1%}
.wo{cursor:pointer; transition:background var(--t-fast)}
.wo:hover td{background:var(--glass-2)}
.wo:focus-within td{background:var(--glass-2)}
/* Selected is the resting state here - everything arrives ticked - so the mark is a
   quiet rail down the left rather than a wash of colour across forty rows. */
.wo:has(.wo__pick:checked) td:first-child{box-shadow:inset 3px 0 0 var(--brand)}
.wo:not(:has(.wo__pick:checked)) td{color:var(--dim)}
.wo__pick{width:17px; height:17px; flex:none; cursor:pointer; accent-color:var(--brand)}
/* --- the SLA chip: how long is left, and how loudly to say so --- */
.sla{display:inline-flex; align-items:center; gap:.38rem; align-self:flex-start; white-space:nowrap;
  padding:.24rem .6rem .24rem .45rem; border-radius:999px; font-size:.73rem; font-weight:600;
  border:1px solid color-mix(in srgb,var(--sla) 42%,transparent);
  background:color-mix(in srgb,var(--sla) 13%,transparent); color:var(--sla);
  --sla:var(--muted); transition:color var(--t-base), border-color var(--t-base), background var(--t-base)}
.sla .ico{width:13px; height:13px; flex:none}
.sla__at{font-weight:400; font-size:.69rem; opacity:.72; white-space:nowrap}
.sla[data-tone="calm"]{--sla:var(--muted)}
.sla[data-tone="soon"]{--sla:var(--warn)}
.sla[data-tone="now"]{--sla:var(--cta-hi)}
.sla[data-tone="over"]{--sla:var(--bad)}
/* Only the two that need a decision now pull the eye; a five-day deadline must not. */
.sla[data-tone="now"],.sla[data-tone="over"]{animation:slaPulse 2.4s var(--ease-soft) infinite}
@keyframes slaPulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--sla) 34%,transparent)}
  55%{box-shadow:0 0 0 5px color-mix(in srgb,var(--sla) 0%,transparent)}}
@media (max-width:640px){ .sla__at{display:none} }
@media (prefers-reduced-motion:reduce){ .sla{animation:none !important} }
.wtab__car .ico{width:14px; height:14px; color:var(--muted)}
/* A row outside the chosen courier stays readable but steps back. */
.wo--dim td{opacity:.42}
.wo--dim:hover td{opacity:1}
@media (max-width:820px){ .wtab__who{max-width:9rem} }
.wl__bar .chip b{margin-left:.25rem; font-weight:600; font-variant-numeric:tabular-nums}
.wo__in{display:flex; gap:.35rem}
.wo__in .trk{flex:1; width:auto; min-width:0}
.wo__in .trk--s{flex:0 0 6.5rem}
.wo__go{font:inherit; font-size:.86rem; font-weight:600; padding:.55rem 1rem; min-height:42px;
  width:100%; border-radius:999px; cursor:pointer; color:#fff; border:1px solid transparent;
  background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent);
  transition:filter var(--t-base) var(--ease-out), transform var(--t-fast) var(--ease-out)}
.wo__go:hover{filter:brightness(1.08); transform:translateY(-1px)}
.wo__go:active{transform:none}
.wo__go:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.wo__go:disabled{opacity:.45; cursor:not-allowed; filter:none}
/* Cards arrive as one wave, same cap as the product grid. */
.wl__grid .wo{animation:rise 340ms var(--ease-out) both}
.wl__grid .wo:nth-child(6n+1){animation-delay:120ms}
.wl__grid .wo:nth-child(6n+2){animation-delay:160ms}
.wl__grid .wo:nth-child(6n+3){animation-delay:200ms}
.wl__grid .wo:nth-child(6n+4){animation-delay:240ms}
.wl__grid .wo:nth-child(6n+5){animation-delay:280ms}
.wl__grid .wo:nth-child(6n){animation-delay:320ms}
@media (max-width:640px){ .wl__grid{padding:0 .75rem} }

/* --- stock editing --- */
/* --- stock as a table: every channel under its own heading --- */
.stt__wrap{padding:0 1rem}
.stt{width:100%; border-collapse:separate; border-spacing:0; font-size:.86rem}
.stt thead th{text-align:left; padding:.5rem .6rem; border-bottom:1px solid var(--line);
  font-size:.68rem; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--dim)}
.stt thead th.stt__q{text-align:right}
.stt thead .cm{border:0; background:transparent; padding:0; font-size:.7rem}
.stt tbody td{padding:.45rem .6rem; border-bottom:1px solid var(--line); vertical-align:middle}
.stt tbody tr:last-child td{border-bottom:0}
.st:hover td{background:var(--glass-2)}
/* The state colours the left edge instead of the whole row: forty rows washed in amber
   is a page that reads as one alarm rather than the four that need attention. */
.st td:first-child{box-shadow:inset 3px 0 0 transparent}
.st--new td:first-child{box-shadow:inset 3px 0 0 var(--warn)}
.st--held td:first-child{box-shadow:inset 3px 0 0 var(--act)}
.st--drift td:first-child{box-shadow:inset 3px 0 0 var(--info)}
.st--ready td:first-child{box-shadow:inset 3px 0 0 var(--good)}
.st--blind td:first-child{box-shadow:inset 3px 0 0 var(--bad)}
.st--dirty td{background:color-mix(in srgb,var(--brand) 9%,transparent)}
.stt__pic{width:1%; padding-right:0}
.stt__pic img,.stt__nopic{width:38px; height:38px; border-radius:9px; object-fit:cover; display:block;
  background:var(--panel-2); border:1px solid var(--line)}
.stt__name{min-width:12rem}
.stt__t{display:block; font-weight:600; letter-spacing:-.01em}
.stt__sku{display:block; font-size:.72rem; color:var(--dim)}
.stt__q{width:1%; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap}
/* A number that disagrees with the master is the whole point of the column. */
.stt__q--off{color:var(--act); font-weight:600}
.stt__q--bad{color:var(--bad); font-weight:600}
.stt__edit{width:1%; white-space:nowrap}
/* In a card the field stretched to fill the width. In a row it only has to hold four
   digits, and anything wider pushes the status column off a laptop screen. */
.stt__edit .st__edit{margin:0; display:inline-flex}
.stt__edit .st__in{flex:none; width:5.5rem}
.stt__edit .st__fix{margin-left:.3rem; vertical-align:middle}
.stt__note{font-size:.78rem; min-width:11rem}
.stt__note .st__vouch{margin-top:.2rem}
tr.grp td{padding:.9rem .6rem .35rem; border-bottom:1px solid var(--line);
  font-size:.74rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted)}
tr.grp .grp__t{font-weight:600; color:var(--fg); letter-spacing:.02em; text-transform:none; font-size:.9rem}
tr.grp .grp__n{margin-left:.5rem; font-size:.7rem; color:var(--dim)}
/* A person's name is not a label: the uppercase on tr.grp is right for "KAPSUL 90" and
   wrong for "Vanya". Both of these opt out of it. */
tr.grp .grp__by{margin-left:.55rem; font-size:.8rem; font-weight:500; letter-spacing:0;
  text-transform:none; color:var(--muted)}
tr.grp .grp__n--batch{text-transform:none; letter-spacing:0}
tr.grp .grp__sel{display:inline-flex; align-items:center; gap:.5rem; cursor:pointer}
.rpf{margin-bottom:.35rem}
.rpf__quick{display:inline-flex; gap:.35rem; align-items:center; flex-wrap:wrap;
  padding-right:.6rem; margin-right:.2rem; border-right:1px solid var(--glass-line)}
.rpf__to{color:var(--dim); padding:0 .1rem}
.rpf__n{font-size:.8rem; color:var(--muted); white-space:nowrap}
.lbs__in{min-width:16rem; flex:0 1 22rem}
.rpf__hint{margin:0 .15rem 1rem; font-size:.78rem; color:var(--dim)}
.xp__c{display:inline-block; padding:.12rem .5rem; border-radius:999px; font-size:.78rem;
  color:var(--act); background:color-mix(in srgb,var(--act) 14%,transparent);
  border:1px solid color-mix(in srgb,var(--act) 32%,transparent)}
@media (max-width:900px){ .stt__note{display:none} .stt thead th:last-child{display:none} }

.st{transition:background var(--t-fast)}
.st[hidden]{display:none}
.filters .chip b{margin-left:.3rem; font-weight:600; font-variant-numeric:tabular-nums}
.filters .chip b.ok{color:var(--good)}
.filters .chip b.flag{color:var(--warn)}
.chip.is-on b{color:inherit}
.cm{display:inline-flex; align-items:center; gap:.3rem; font-size:.84rem; padding:.2rem .45rem;
  border-radius:7px; background:var(--panel); border:1px solid var(--line)}
.cm__i{width:13px; height:13px; flex:none; fill:var(--accent)}
/* The combined storefront glyph is a line drawing, not a filled brand logo. */
.cm__i--o{fill:none; stroke:var(--accent); stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round}
.cm i{font-style:normal; font-size:.66rem; letter-spacing:.03em; text-transform:uppercase;
  color:var(--muted); font-family:"Inter",sans-serif}
.cm b{font-family:"Fira Code",ui-monospace,monospace; font-weight:500; font-variant-numeric:tabular-nums}
/* A channel that already disagrees with the master is the thing worth spotting. */
.cm--off{border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.cm--off b{color:var(--warn)}
/* Read-only channels are drawn hollow: sync never writes them, and a card that looked
   identical to the others would quietly imply that it does. */
.cm--ro{border-style:dashed}
.cm--ro .cm__i{fill:none; stroke:var(--accent); stroke-width:1.4}
.cm--ro b{color:var(--muted)}
.cm__l{width:11px; height:11px; flex:none; margin-left:.1rem; fill:none; stroke:var(--muted);
  stroke-width:2; stroke-linecap:round; stroke-linejoin:round}
.st__edit{display:flex; align-items:center; gap:.3rem}
.st__b{width:34px; height:34px; flex:none; font:inherit; font-size:1.05rem; line-height:1; cursor:pointer;
  border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--muted);
  transition:color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out)}
.st__b:hover{color:var(--fg); border-color:var(--brand)}
.st__b:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.st__in{flex:1; min-width:0; font:inherit; font-family:"Fira Code",ui-monospace,monospace;
  font-size:.95rem; text-align:center; padding:.35rem; min-height:34px; border-radius:8px;
  border:1px solid var(--line); background:var(--panel); color:var(--fg); font-variant-numeric:tabular-nums}
.st__in:focus-visible{outline:2px solid var(--brand); outline-offset:1px; border-color:transparent}
.st__fix{font:inherit; font-size:.74rem; padding:.3rem .5rem; min-height:34px; flex:none; cursor:pointer;
  border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--muted); white-space:nowrap;
  transition:color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out)}
.st__fix:hover{color:var(--fg); border-color:var(--brand)}
.st__note{margin:0; font-size:.76rem; line-height:1.4}
.st__vouch{display:flex; align-items:center; gap:.45rem; font-size:.76rem; color:var(--muted);
  cursor:pointer; padding:.35rem .5rem; border-radius:8px; background:var(--panel);
  border:1px solid var(--line); transition:color var(--t-fast) var(--ease-out)}
.st__vouch:hover{color:var(--fg)}
.st__vouch input{width:15px; height:15px; flex:none; cursor:pointer; accent-color:var(--brand)}
.st__bar{gap:.75rem; flex-wrap:wrap}
.st__apply{display:flex; align-items:center; gap:.5rem}
@media (max-width:640px){ .st__grid{padding:.75rem} }

.act{gap:.3rem}
.trk{font:inherit; font-family:"Fira Code",ui-monospace,monospace; font-size:.8rem; width:9rem;
  padding:.3rem .45rem; min-height:34px; border-radius:7px; text-align:left;
  border:1px solid var(--line); background:var(--panel-2); color:var(--fg)}
.trk--s{width:6.5rem; font-family:"Inter",sans-serif}
.trk:focus-visible{outline:2px solid var(--brand); outline-offset:1px}

/* --- sync bar: what the Stok tab used to be, folded into one line --- */
.sync{display:flex; align-items:center; gap:1rem; flex-wrap:wrap; margin:0 1rem 0;
  padding:.75rem 1rem; border:1px solid var(--glass-line); border-radius:14px; background:var(--glass)}
.sync__txt{font-size:.86rem; flex:1; min-width:14rem}
.sync__d{font-size:.8rem}
.sync__d summary{cursor:pointer; color:var(--muted); list-style:none; padding:.3rem .6rem;
  border:1px solid var(--line); border-radius:8px; min-height:32px; display:inline-flex; align-items:center}
.sync__d summary:hover{color:var(--fg); border-color:var(--brand)}
.sync__d[open]{flex-basis:100%; order:9}
.sync__d[open] summary{margin-bottom:.6rem}
.sync__go{font:inherit; font-size:.85rem; font-weight:600; padding:.45rem 1.1rem; min-height:38px;
  border-radius:999px; cursor:pointer; color:#fff; border:1px solid transparent;
  background:linear-gradient(155deg,var(--cta-a),var(--cta-b)); transition:filter var(--t-base) var(--ease-out)}
.sync__go:hover{filter:brightness(1.12)}
.sync__go:disabled{opacity:.4; cursor:not-allowed; filter:none}

@media (max-width:640px){ .cards{grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); padding:.75rem; gap:.5rem} .dense td,.dense th{padding:.45rem .7rem} }
.plink{color:var(--fg); text-decoration:none; border-bottom:1px solid transparent; transition:border-color .2s}
.plink:hover{border-bottom-color:var(--brand)}
.kv{display:grid; grid-template-columns:auto 1fr; gap:.4rem 1rem; margin:0}
.kv dt{color:var(--muted); font-size:.78rem}
.kv dd{margin:0; font-size:.88rem; overflow-wrap:anywhere}
.visually-hidden{position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden;
  clip:rect(0 0 0 0); white-space:nowrap; border:0}
.sec{margin:0; padding:1rem; font-size:.8rem; letter-spacing:.06em; text-transform:uppercase;
  color:var(--muted); border-bottom:1px solid var(--line); background:var(--panel-2)}
.alert--soft{border-color:color-mix(in srgb,var(--warn) 40%,transparent);
  background:color-mix(in srgb,var(--warn) 12%,transparent)}
.alert--soft .ico{color:var(--warn)}
.alert--ok{border-color:color-mix(in srgb,var(--good) 40%,transparent);
  background:color-mix(in srgb,var(--good) 12%,transparent)}
.alert--ok .ico{color:var(--good)}
/* A success note has said its piece after two seconds; an error stays until it is read. */
.alert.is-going{animation:rise 260ms var(--ease-out) reverse both; pointer-events:none}

.edit{display:flex; gap:.3rem; align-items:center; margin:0}
.edit input{font:inherit; font-family:"Fira Code",ui-monospace,monospace; font-size:.82rem;
  width:6.5rem; padding:.3rem .45rem; min-height:34px; text-align:right; border-radius:7px;
  border:1px solid var(--line); background:var(--panel-2); color:var(--fg)}
.edit input:focus-visible{outline:2px solid var(--brand); outline-offset:1px}
.edit button{font:inherit; font-size:.76rem; padding:.3rem .6rem; min-height:34px; border-radius:7px;
  cursor:pointer; border:1px solid var(--line); background:var(--panel-2); color:var(--muted);
  transition:color var(--t-base) var(--ease-out),border-color var(--t-base) var(--ease-out)}
.edit button:hover{color:var(--fg); border-color:var(--brand)}
/* The commit bar follows the list down the page: on a thirty-label day the button is
   never something you have to scroll back for. */
.apply{position:sticky; bottom:0; z-index:5; display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; padding:1rem;
  border-top:1px solid var(--line); background:color-mix(in srgb,var(--panel) 82%,transparent);
  backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px)}
.apply button{font:inherit; font-size:.85rem; font-weight:600; padding:.55rem 1.25rem; min-height:42px;
  border-radius:999px; cursor:pointer; color:#fff; border:1px solid transparent;
  background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent);
  transition:filter var(--t-base) var(--ease-out)}
.apply button:hover{filter:brightness(1.08)}
.apply .chip{color:var(--muted); font-weight:500; background:var(--glass); border:1px solid var(--glass-line); box-shadow:none}
.apply .chip:hover{color:var(--fg); background:var(--glass-2); filter:none}
.apply button:disabled{opacity:.45; cursor:not-allowed; filter:none}
.pick,#head,.grp__pick{width:17px; height:17px; cursor:pointer; accent-color:var(--brand)}
select.dr__in{width:auto; text-align:left; cursor:pointer}

.daterange{display:flex; align-items:center; gap:.4rem; background:var(--glass);
  border:1px solid var(--glass-line); border-radius:999px; padding:3px 3px 3px .8rem; flex-wrap:wrap}
.dr__lbl{font-size:.78rem; color:var(--muted)}
.dr__in{font:inherit; font-size:.8rem; padding:.3rem .5rem; min-height:32px; border-radius:999px;
  border:1px solid transparent; background:var(--glass-2); color:var(--fg); color-scheme:inherit}
.dr__in:hover{border-color:var(--glass-line)}
.dr__go{font:inherit; font-size:.8rem; font-weight:600; padding:.35rem .9rem; min-height:32px;
  border-radius:999px; cursor:pointer; border:1px solid color-mix(in srgb,var(--brand) 55%,transparent);
  background:color-mix(in srgb,var(--brand) 20%,transparent); color:var(--fg);
  transition:background .2s,border-color .2s}
.dr__go:hover{background:color-mix(in srgb,var(--brand) 32%,transparent)}

/* ---- kpi: one ink slab, four figures, hairlines between ---- */
.kpis{display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); margin-bottom:1rem; border-radius:var(--radius); overflow:hidden}
.kpi{position:relative; display:flex; flex-direction:column; gap:.6rem; padding:1.35rem 1.4rem 1.25rem; min-width:0}
.kpi+.kpi{border-left:1px solid var(--ink-line)}
.kpi__ico{position:absolute; top:1.05rem; right:1.05rem; width:32px;height:32px;border-radius:50%;display:grid;place-items:center;
  background:var(--glass); border:1px solid var(--glass-line); color:var(--brand)}
.kpi__ico .ico{width:16px; height:16px}
.kpi.is-act .kpi__ico{color:var(--act); border-color:color-mix(in srgb,var(--act) 40%,transparent)}
.kpi__body{display:flex; flex-direction:column-reverse; gap:.45rem; min-width:0; padding-right:2.4rem}
.kpi__label{margin:0; font-size:.68rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted)}
.kpi__value{margin:0; font-size:clamp(1.6rem,2.3vw,2.3rem); font-weight:600; letter-spacing:-.035em; line-height:1;
  font-variant-numeric:tabular-nums; overflow-wrap:anywhere}
.kpi.is-act .kpi__value{color:var(--act)}
@media (max-width:900px){
  .kpis{grid-template-columns:1fr 1fr}
  .kpi:nth-child(3){border-left:0}
  .kpi:nth-child(n+3){border-top:1px solid var(--ink-line)}
}
@media (max-width:640px){
  .kpi{padding:1rem 1.1rem}
  .kpi__ico{display:none}
  .kpi__body{padding-right:0}
  .kpi__value{font-size:1.35rem; letter-spacing:-.02em; overflow-wrap:normal}
}

/* ---- channels ---- */
.chs{display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:.85rem; margin-bottom:1.5rem}
.ch{padding:1.15rem 1.2rem; background:var(--glass); backdrop-filter:blur(var(--blur)); -webkit-backdrop-filter:blur(var(--blur));
  border:1px solid var(--glass-line); border-radius:var(--radius);
  box-shadow:var(--shadow), inset 0 1px 0 rgba(255,255,255,.04), inset 0 2px 0 var(--accent)}
.ch__head{display:flex; align-items:center; gap:.5rem; margin-bottom:.5rem}
.ch__dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none}
.ch__head h3{margin:0; font-size:.95rem; font-weight:600; flex:1}
.ch__count{font-family:"Fira Code",monospace; font-size:.9rem; color:var(--muted)}
.ch__rev{margin:0 0 .75rem; font-size:1.55rem; font-weight:600; letter-spacing:-.03em; line-height:1.1;
  font-variant-numeric:tabular-nums}
.bar{display:flex; height:7px; border-radius:99px; overflow:hidden; background:var(--panel-2); gap:2px}
.bar--empty{opacity:.5}
.seg{display:block}
.seg--good{background:var(--good)} .seg--info{background:var(--info)} .seg--warn{background:var(--warn)}
.seg--act{background:var(--act)} .seg--bad{background:var(--bad)} .seg--done{background:var(--done)}
.ch__pills{display:flex; flex-wrap:wrap; gap:.35rem; margin-top:.75rem}
.mini{font-size:.72rem; padding:.2rem .5rem; border-radius:6px; background:var(--panel-2); color:var(--muted)}
.mini b{color:var(--fg); font-weight:600}
.mini--good{color:var(--good)} .mini--info{color:var(--info)} .mini--warn{color:var(--warn)}
.mini--act{color:var(--act)} .mini--bad{color:var(--bad)} .mini--done{color:var(--done)}

/* ---- filters + table ---- */
.panel{background:var(--glass); backdrop-filter:blur(var(--blur)) saturate(1.2); -webkit-backdrop-filter:blur(var(--blur)) saturate(1.2);
  border:1px solid var(--glass-line); border-radius:var(--radius);
  box-shadow:var(--shadow), inset 0 1px 0 rgba(255,255,255,.04); overflow:clip}
.filters{display:flex; flex-wrap:wrap; gap:.45rem; padding:1rem; border-bottom:1px solid var(--line); align-items:center}
.chip{font:inherit; font-size:.8rem; padding:.4rem .85rem; min-height:34px; border-radius:999px; cursor:pointer;
  border:1px solid var(--glass-line); background:var(--glass); color:var(--muted); transition:color .2s,border-color .2s,background .2s}
.chip:hover{color:var(--fg); border-color:var(--chip,var(--brand))}
.chip.is-on{background:color-mix(in srgb,var(--chip,var(--brand)) 18%,transparent);
  border-color:color-mix(in srgb,var(--chip,var(--brand)) 55%,transparent); color:var(--fg); font-weight:600}
.chip b{font-weight:600}
.grow{flex:1}
.search{font:inherit; font-size:.85rem; padding:.45rem .9rem; min-height:34px; min-width:200px;
  border-radius:999px; border:1px solid var(--glass-line); background:var(--panel-2); color:var(--fg)}
.search::placeholder{color:var(--dim)}
.scroll{overflow-x:auto}
table{width:100%; border-collapse:collapse; font-size:.88rem}
th{position:sticky; top:0; background:color-mix(in srgb,var(--panel) 90%,transparent); backdrop-filter:blur(10px); text-align:left; font-weight:500; font-size:.74rem;
  letter-spacing:.06em; text-transform:uppercase; color:var(--muted); padding:.7rem 1rem; white-space:nowrap}
th.num{text-align:right}
td{padding:.7rem 1rem; border-top:1px solid var(--line); vertical-align:middle}
tbody tr{transition:background .15s}
tbody tr:hover{background:var(--panel-2)}
.tag{--accent-text:color-mix(in srgb,var(--accent) 85%,#fff); font-size:.72rem; font-weight:600; padding:.2rem .55rem; border-radius:6px; white-space:nowrap;
  color:var(--accent-text); background:color-mix(in srgb,var(--accent) 14%,transparent);
  border:1px solid color-mix(in srgb,var(--accent) 35%,transparent)}
@media (prefers-color-scheme:light){
  :root:not([data-theme="dark"]) .tag{--accent-text:color-mix(in srgb,var(--accent) 62%,#000)}
}
:root[data-theme="light"] .tag{--accent-text:color-mix(in srgb,var(--accent) 62%,#000)}
.pill{font-size:.74rem; padding:.2rem .55rem; border-radius:6px; white-space:nowrap; font-weight:500}
.pill--good{color:var(--good); background:color-mix(in srgb,var(--good) 15%,transparent)}
.pill--info{color:var(--info); background:color-mix(in srgb,var(--info) 15%,transparent)}
.pill--warn{color:var(--warn); background:color-mix(in srgb,var(--warn) 15%,transparent)}
.pill--act{color:var(--act); background:color-mix(in srgb,var(--act) 18%,transparent)}
.pill--bad{color:var(--bad); background:color-mix(in srgb,var(--bad) 15%,transparent)}
.pill--done{color:var(--done); background:color-mix(in srgb,var(--done) 15%,transparent)}
.await{font-size:.78rem; color:var(--warn); font-style:italic}
.empty{padding:3rem 1rem; text-align:center; color:var(--dim); font-size:.9rem}
.foot{padding:.85rem 1rem; border-top:1px solid var(--line); font-size:.78rem; color:var(--dim);
  display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap}

@media (max-width:640px){
  body{padding:.75rem}
  .kpi__value{font-size:1.35rem}
  th,td{padding:.6rem .7rem}
}
/* Sync health: one chip per path, coloured by whether its silence is normal. */
.hbs{display:flex; flex-wrap:wrap; gap:.4rem .6rem; padding:.7rem 1rem; border-bottom:1px solid var(--line); font-size:.76rem}
.hb{display:inline-flex; gap:.35rem; align-items:baseline; padding:.25rem .6rem; border-radius:999px; border:1px solid var(--line); color:var(--muted)}
.hb b{font-weight:600; color:var(--fg)}
.hb--ok{border-color:color-mix(in srgb,var(--good) 45%,transparent)}
.hb--ok b::before{content:''; display:inline-block; width:.45rem; height:.45rem; border-radius:50%; background:var(--good); margin-right:.35rem}
.hb--flag{border-color:color-mix(in srgb,var(--warn) 55%,transparent)}
.hb--flag b::before{content:''; display:inline-block; width:.45rem; height:.45rem; border-radius:50%; background:var(--warn); margin-right:.35rem}
.hb--muted b::before{content:''; display:inline-block; width:.45rem; height:.45rem; border-radius:50%; background:var(--dim); margin-right:.35rem}
.hb--stop{border-color:color-mix(in srgb,var(--bad) 60%,transparent); color:var(--fg)}
.hb--stop b::before{content:''; display:inline-block; width:.45rem; height:.45rem; border-radius:50%; background:var(--bad); margin-right:.35rem}

/* Product pictures. Fixed boxes so a card never reflows when a picture arrives late, and
   object-fit keeps a square product shot square whatever Shopify sent. */
.card__img{display:block; width:100%; aspect-ratio:4/3; border-radius:7px; object-fit:cover;
  background:var(--panel-2); border:1px solid var(--line); margin-bottom:.25rem}
.card__img--none{display:grid; place-items:center; color:var(--dim); font-size:.6rem; letter-spacing:.06em; text-transform:uppercase}
.pd__hero{display:grid; grid-template-columns:200px minmax(0,1fr); gap:1.1rem; align-items:start; padding:1rem 1rem 0}
.pd__cap{display:flex; flex-direction:column; gap:.25rem; font-size:.9rem; padding-top:.2rem}
.pd__img{width:200px; height:200px; border-radius:12px; object-fit:cover; background:var(--panel-2); border:1px solid var(--line)}
.ch__toggle{margin-top:.75rem; display:flex; justify-content:flex-end}
.ch__btn{display:inline-flex; align-items:center; gap:.35rem; font:inherit; font-size:.78rem; padding:.4rem .75rem; min-height:34px; cursor:pointer;
  border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--muted); transition:color var(--t-fast), border-color var(--t-fast)}
.ch__btn:hover{color:var(--fg); border-color:var(--muted)}
.ch__btn--on{color:var(--brand); border-color:color-mix(in srgb, var(--brand) 45%, var(--line))}
.ch__btn .ico{width:14px; height:14px}
.chp{display:flex; flex-wrap:wrap; gap:.4rem; border:0; margin:0; padding:0}
.chp__opt{display:inline-flex; align-items:center; gap:.4rem; font-size:.8rem; padding:.35rem .65rem; min-height:34px; border:1px solid var(--line);
  border-radius:999px; cursor:pointer; background:var(--panel-2)}
.chp__opt:has(input:checked){border-color:color-mix(in srgb, var(--brand) 55%, var(--line)); color:var(--fg)}
.chp__opt.is-off{opacity:.45; cursor:not-allowed}
.chp__opt input, .edit .chp__opt input{accent-color:var(--brand); margin:0; width:15px; height:15px; min-height:0; padding:0; border:0; background:none}
.le__go button{font:inherit; font-size:.85rem; font-weight:600; padding:.55rem 1.25rem; min-height:42px; border-radius:999px; cursor:pointer;
  color:#fff; border:1px solid transparent; background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent); transition:filter var(--t-base) var(--ease-out)}
.le__go button:hover{filter:brightness(1.08)}
.le__go button:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.le__f input[type=file]{font-size:.78rem; color:var(--muted)}
.le{padding:1rem; display:flex; flex-direction:column; gap:1rem}
.le__top{display:flex; flex-wrap:wrap; align-items:center; gap:.6rem 1rem}
.le__grid{display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:.85rem 1rem}
.le__f{display:flex; flex-direction:column; gap:.35rem; font-size:.78rem; color:var(--muted)}
.le__f > span:first-child{font-weight:500}
.le__f--wide{grid-column:1/-1}
.le__f input:not([type=file]), .le__f textarea{font:inherit; font-size:.88rem; color:var(--fg); background:var(--panel-2); border:1px solid var(--line);
  border-radius:10px; padding:.55rem .7rem; min-height:40px}
.le__f textarea{resize:vertical; line-height:1.55; min-height:12rem}
.le__f input:focus-visible, .le__f textarea:focus-visible{outline:2px solid var(--brand); outline-offset:1px}
.le__dims{display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:.5rem}
.le__hint{font-size:.72rem; color:var(--dim)}
.le__pics{display:flex; flex-wrap:wrap; gap:.4rem}
.le__pics img{width:64px; height:64px; object-fit:cover; border-radius:8px; border:1px solid var(--line); background:var(--panel)}
.le__go{display:flex; justify-content:flex-end}
@media (max-width:640px){.le__grid{grid-template-columns:minmax(0,1fr)}}
.pd__hero--bx{grid-template-columns:200px minmax(9rem,.7fr) minmax(0,1.6fr)}
.bx{align-self:stretch; display:flex; flex-direction:column; gap:.55rem; padding:.85rem .9rem; border:1px solid var(--line);
  border-radius:var(--radius-s); background:color-mix(in srgb, var(--panel-2) 70%, transparent)}
.bx__head{display:flex; align-items:baseline; justify-content:space-between; gap:.75rem}
.bx__h{margin:0; font-size:.7rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted)}
.bx__make{font-size:.78rem; color:var(--muted)}
.bx__list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.15rem}
.bx__row{display:grid; grid-template-columns:44px minmax(0,1fr) auto 4.5rem; align-items:center; gap:.75rem; padding:.4rem .45rem;
  border-radius:10px; color:inherit; text-decoration:none; cursor:pointer; transition:background-color var(--t-fast, 160ms)}
.bx__row:hover{background:color-mix(in srgb, var(--fg) 5%, transparent)}
.bx__row:focus-visible{outline:2px solid var(--brand); outline-offset:1px}
.bx__pic{width:44px; height:44px; border-radius:9px; object-fit:cover; background:var(--panel); border:1px solid var(--line)}
.bx__id{display:flex; flex-direction:column; min-width:0; gap:.1rem}
.bx__name{font-size:.86rem; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.bx__var{color:var(--muted); font-weight:400}
.bx__sku{font-size:.7rem; color:var(--dim)}
.bx__qty{font-size:.8rem; color:var(--muted); padding:.15rem .45rem; border:1px solid var(--line); border-radius:6px}
.bx__stock{display:flex; flex-direction:column; align-items:flex-end; line-height:1.15}
.bx__stock b{font-size:.95rem; font-weight:600}
.bx__stock span{font-size:.66rem; letter-spacing:.06em; text-transform:uppercase; color:var(--dim)}
@media (max-width:980px){.pd__hero--bx{grid-template-columns:160px minmax(0,1fr)} .pd__hero--bx .bx{grid-column:1/-1} .pd__hero--bx .pd__img{width:160px; height:160px}}
@media (prefers-reduced-motion:reduce){.bx__row{transition:none}}
@media (max-width:640px){.pd__hero{grid-template-columns:minmax(0,1fr)} .pd__img{width:100%; height:auto; aspect-ratio:1}}
.ln__pic{width:38px; height:38px; border-radius:7px; object-fit:cover; background:var(--panel-2); border:1px solid var(--line); flex:none}
.ln__pic[hidden]{display:none}
.ln__prod{display:flex; gap:.45rem; align-items:center; min-width:0}
.ln__prod select{flex:1; min-width:0}

/* ------------------------------------------------------ prakiraan stok ------ */
/* Built to be scanned in the order the decision is made: how urgent, how long the stock
   lasts, how much to order - and only then how the number was arrived at. */
.fc__u{display:inline-flex; align-items:center; gap:.35rem; font-size:.72rem; font-weight:600;
  padding:.18rem .5rem; border-radius:999px; white-space:nowrap}
.fc__u::before{content:''; width:.4rem; height:.4rem; border-radius:50%; background:currentColor}
.fc__u--stockout{color:var(--bad); background:color-mix(in srgb,var(--bad) 16%,transparent)}
.fc__u--critical{color:var(--bad); background:color-mix(in srgb,var(--bad) 12%,transparent)}
.fc__u--watch{color:var(--warn); background:color-mix(in srgb,var(--warn) 15%,transparent)}
.fc__u--ok{color:var(--good); background:color-mix(in srgb,var(--good) 14%,transparent)}
.fc__u--idle{color:var(--dim); background:var(--panel-2)}

.fc__spark{display:block; width:92px; height:26px; overflow:visible}
.fc__spark path{fill:none; stroke:var(--brand); stroke-width:1.6; stroke-linejoin:round; stroke-linecap:round}
.fc__spark rect{fill:color-mix(in srgb,var(--brand) 14%,transparent)}

.fc__range{font-family:"Fira Code",ui-monospace,monospace; font-size:.74rem; color:var(--dim); white-space:nowrap}
.fc__p50{color:var(--fg); font-size:.84rem}
.fc__qty{font-family:"Fira Code",ui-monospace,monospace; font-weight:600}
.fc__mase{font-family:"Fira Code",ui-monospace,monospace; font-size:.74rem}
.fc__mase--good{color:var(--good)} .fc__mase--poor{color:var(--warn)}
.fc__why{font-size:.7rem; color:var(--dim)}
.fc__note{padding:.9rem 1rem; border-bottom:1px solid var(--line); font-size:.78rem; color:var(--muted); line-height:1.5}
.fc__note b{color:var(--fg)}

/* ------------------------------------------------- cta ---------------------- */
.cta{position:relative; display:inline-flex; align-items:center; gap:.5rem; min-height:42px; padding:.5rem 1.15rem .5rem .95rem; border-radius:999px;
  font-size:.85rem; font-weight:600; color:#fff; text-decoration:none; white-space:nowrap; cursor:pointer; isolation:isolate;
  background:linear-gradient(155deg,var(--cta-a),var(--cta-b)); border:1px solid color-mix(in srgb,var(--cta-b) 70%,#000 30%);
  box-shadow:0 1px 0 rgba(255,255,255,.12) inset, 0 1px 2px rgba(0,0,0,.25), 0 8px 20px -10px color-mix(in srgb,var(--cta-a) 80%,transparent);
  transition:transform var(--t-fast) var(--ease-out), box-shadow var(--t-base) var(--ease-out), filter var(--t-fast) var(--ease-out)}
.cta::after{content:""; position:absolute; inset:0; border-radius:inherit; background:linear-gradient(180deg,rgba(255,255,255,.14),rgba(255,255,255,0) 55%); pointer-events:none; z-index:-1}
.cta .ico{width:1.05rem; height:1.05rem; stroke-width:2}
.cta:hover{filter:brightness(1.08); box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 2px 4px rgba(0,0,0,.25), 0 14px 28px -12px color-mix(in srgb,var(--cta-a) 90%,transparent); transform:translateY(-1px)}
.cta:active{transform:translateY(0); filter:brightness(.98)}
.cta:focus-visible{outline:2px solid var(--accent); outline-offset:3px}
@media (prefers-reduced-motion:reduce){ .cta,.cta:hover{transition:none; transform:none} }

/* ------------------------------------------------- pager -------------------- */
.pager{display:flex; flex-wrap:wrap; align-items:center; gap:.6rem 1.25rem; padding:.7rem 1rem; border-top:1px solid var(--line); font-size:.8rem; color:var(--muted)}
.pager--top{border-top:0; border-bottom:1px solid var(--line); padding:.5rem 1rem}
.pager__sum b{color:var(--fg); font-variant-numeric:tabular-nums}
.pager__pages{display:inline-flex; align-items:center; gap:.2rem; margin-left:auto}
.pager__n,.pager__btn,.pager__size{display:inline-grid; place-items:center; min-width:2.25rem; height:2.25rem; padding:0 .5rem; border-radius:8px; border:1px solid transparent; color:var(--muted); text-decoration:none; font-variant-numeric:tabular-nums; cursor:pointer; transition:background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out)}
a.pager__n:hover,a.pager__btn:hover,a.pager__size:hover{background:var(--panel-2); color:var(--fg); border-color:var(--line)}
.pager__n.is-on,.pager__size.is-on{background:color-mix(in srgb,var(--brand) 18%,transparent); color:var(--fg); font-weight:600; border-color:color-mix(in srgb,var(--brand) 45%,transparent); cursor:default}
.pager__btn.is-off{color:var(--line); cursor:default}
.pager__btn .ico{width:1.05rem; height:1.05rem}
.pager__gap{display:inline-grid; place-items:center; min-width:1.5rem; height:2.25rem; color:var(--dim)}
.pager__sizes{display:inline-flex; align-items:center; gap:.15rem}
.pager__lbl{margin-right:.35rem; color:var(--dim)}
.pager__size{min-width:2.5rem}
a.pager__n:focus-visible,a.pager__btn:focus-visible,a.pager__size:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
@media (max-width:760px){ .pager__pages{margin-left:0} }
.searchform{display:inline-flex; align-items:stretch; gap:.35rem; margin-left:auto}
.searchform .search{min-width:220px}
.searchform button{font:inherit; font-size:.8rem; min-height:34px; padding:0 .8rem; border:1px solid var(--glass-line); border-radius:999px; background:var(--glass); color:var(--fg); cursor:pointer; display:inline-grid; place-items:center; transition:border-color var(--t-fast) var(--ease-out)}
.searchform button:hover{border-color:var(--brand)}
.searchform button .ico{width:1rem; height:1rem}
.filters a.chip{text-decoration:none; display:inline-flex; align-items:center}

/* ------------------------------------------------- ulasan ------------------- */
.rv__top{display:grid; grid-template-columns:minmax(16rem,22rem) 1fr; gap:1rem 2rem; padding:1rem 1.1rem; border-bottom:1px solid var(--line); align-items:center}
@media (max-width:760px){ .rv__top{grid-template-columns:1fr} }
.rv__about{font-size:.8rem; color:var(--muted); line-height:1.55; max-width:60ch}
.rv__about p{margin:0}
.rv__about b{color:var(--fg)}
.rv__about a{color:var(--accent); text-decoration:none; font-weight:500}
.rv__about a:hover{text-decoration:underline}
.rv__dist{display:flex; flex-direction:column; gap:.3rem}
.rv__dist-row{display:grid; grid-template-columns:2.4rem 1fr 7.5rem; gap:.6rem; align-items:center; text-decoration:none; color:inherit; padding:.15rem .35rem; margin:0 -.35rem; border-radius:8px; cursor:pointer; transition:background var(--t-fast) var(--ease-out)}
.rv__dist-row:hover{background:var(--panel-2)}
.rv__dist-row:focus-visible{outline:2px solid var(--accent); outline-offset:1px}
.rv__dist-label{display:inline-flex; align-items:center; gap:.15rem; font-family:"Fira Code",ui-monospace,monospace; font-size:.78rem; color:var(--muted)}
.rv__dist-bar{display:block; height:8px; border-radius:99px; background:var(--panel-2); overflow:hidden}
.rv__dist-fill{display:block; height:100%; border-radius:99px; background:linear-gradient(90deg,var(--brand),var(--accent)); min-width:2px; transition:width var(--t-slow) var(--ease-out)}
.rv__dist-fill.is-low{background:linear-gradient(90deg,var(--warn),var(--bad))}
.rv__dist-n{font-size:.76rem; text-align:right; white-space:nowrap}

.rv__filters{display:flex; flex-wrap:wrap; gap:.6rem .9rem; align-items:center; padding:.75rem 1.1rem; border-bottom:1px solid var(--line); font-size:.8rem;
  position:sticky; top:calc(var(--top-offset) - .75rem); z-index:10; background:color-mix(in srgb,var(--panel) 92%,transparent); backdrop-filter:blur(10px)}
.rv__field{display:inline-flex; align-items:center; gap:.4rem; color:var(--muted)}
.rv__field select,.rv__btn{font:inherit; font-size:.8rem; min-height:2.25rem; padding:.3rem .65rem; border:1px solid var(--line); border-radius:9px; background:var(--panel-2); color:var(--fg); cursor:pointer; transition:border-color var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out)}
.rv__field select:hover,.rv__btn:hover{border-color:var(--brand)}
.rv__field select:focus-visible,.rv__btn:focus-visible,.rv__check input:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.rv__check{display:inline-flex; align-items:center; gap:.4rem; color:var(--muted); cursor:pointer; min-height:2.25rem}
.rv__check input{width:1rem; height:1rem; accent-color:var(--brand); cursor:pointer}
.rv__btn{display:inline-flex; align-items:center; gap:.35rem; font-weight:500}
.rv__btn .ico{width:1rem; height:1rem}
.rv__count{margin-left:auto; color:var(--dim); font-variant-numeric:tabular-nums}
/* The two things to do with reviews sit on the slab, beside when they were last read. */
.rv__acts{display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; padding:.6rem 0}
.rv__sync{margin:0; display:inline-flex}
.rv__csv{display:inline-flex; align-items:center; gap:.4rem; text-decoration:none}
.rv__csv .ico{width:1rem; height:1rem}

.rv__list{display:flex; flex-direction:column}
.rv{position:relative; padding:1rem 1.1rem 1.05rem 1.35rem; border-bottom:1px solid var(--line); transition:background var(--t-fast) var(--ease-out)}
.rv:hover{background:color-mix(in srgb,var(--panel-2) 55%,transparent)}
.rv::before{content:""; position:absolute; left:0; top:.9rem; bottom:.9rem; width:3px; border-radius:0 3px 3px 0; background:transparent}
.rv--low::before{background:var(--bad)}
.rv--open{background:color-mix(in srgb,var(--bad) 6%,transparent)}
.rv__head{display:grid; grid-template-columns:minmax(10rem,14rem) auto 1fr auto; gap:.6rem 1.1rem; align-items:center}
@media (max-width:900px){ .rv__head{grid-template-columns:1fr auto} .rv__sku{grid-column:1 / -1} }
.rv__who{display:flex; align-items:center; gap:.6rem; min-width:0}
.rv__avatar{flex:0 0 auto; width:2.1rem; height:2.1rem; border-radius:50%; display:grid; place-items:center; font-weight:600; font-size:.85rem; color:#fff; background:linear-gradient(135deg,var(--fill-a),var(--fill-b))}
.rv__name{display:block; font-size:.86rem; font-weight:600; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.rv__when{display:block; font-family:"Fira Code",ui-monospace,monospace; font-size:.7rem; color:var(--dim); line-height:1.3}
.rv__approx{color:var(--warn); font-weight:700}
.rv__stars{display:inline-flex; gap:1px}
.rv__star{width:1.05rem; height:1.05rem; fill:var(--panel-2); stroke:var(--line); stroke-width:1.2}
.rv__star.is-on{fill:#D9A400; stroke:#B68900}
.rv__stars--low .rv__star.is-on{fill:var(--bad); stroke:var(--bad)}
.rv__star--sm{width:.8rem; height:.8rem}
.rv__sku{display:flex; align-items:center; gap:.5rem; min-width:0; flex-wrap:wrap}
.rv__chip{font-size:.72rem; padding:.18rem .5rem; border-radius:6px; background:var(--panel-2); border:1px solid var(--line); color:var(--fg); white-space:nowrap}
.rv__chip--none{color:var(--dim); border-style:dashed}
.rv__ch{display:inline-flex; align-items:center; gap:.35rem; font-size:.72rem; font-weight:500; color:var(--muted); white-space:nowrap}
.rv__ch-dot{width:.55rem; height:.55rem; border-radius:50%; background:var(--ch); box-shadow:0 0 0 2px color-mix(in srgb,var(--ch) 22%,transparent)}
.rv__status{display:flex; gap:.35rem; align-items:center; justify-self:end}
.rv__product{display:inline-flex; align-items:center; gap:.25rem; font-size:.78rem; color:var(--muted); text-decoration:none; min-width:0; max-width:28rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; transition:color var(--t-fast) var(--ease-out)}
a.rv__product:hover{color:var(--accent)}
.rv__ext{width:.8rem; height:.8rem; flex:0 0 auto; opacity:.7}
.rv__pill{display:inline-flex; align-items:center; gap:.3rem; font-size:.72rem; font-weight:500; padding:.25rem .6rem; border-radius:99px; white-space:nowrap; background:var(--panel-2); color:var(--muted)}
.rv__pill .ico{width:.85rem; height:.85rem}
.rv__pill--done{color:var(--done); background:color-mix(in srgb,var(--done) 12%,transparent)}
.rv__pill--warn{color:var(--warn); background:color-mix(in srgb,var(--warn) 12%,transparent)}
.rv__pill--bad{color:var(--bad); background:color-mix(in srgb,var(--bad) 12%,transparent)}

.rv__body{margin-top:.6rem; padding-left:2.7rem; display:flex; flex-direction:column; gap:.55rem}
@media (max-width:900px){ .rv__body{padding-left:0} }
.rv__text{margin:0; max-width:68ch; font-size:.92rem; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere}
.rv__text--none{color:var(--dim); font-style:italic}
.rv__reason{margin:0; font-size:.76rem; color:var(--bad)}
.rv__gallery{display:flex; flex-wrap:wrap; gap:.45rem; align-items:center}
.rv__photo{padding:0; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--panel-2); width:84px; height:84px; cursor:zoom-in; display:block;
  transition:border-color var(--t-fast) var(--ease-out), box-shadow var(--t-base) var(--ease-out)}
.rv__photo img{display:block; width:100%; height:100%; object-fit:cover; transition:transform var(--t-base) var(--ease-out)}
.rv__photo:hover{border-color:var(--brand); box-shadow:var(--shadow)}
.rv__photo:hover img{transform:scale(1.05)}
.rv__photo:focus-visible{outline:2px solid var(--accent); outline-offset:2px}
.rv__video{display:inline-flex; align-items:center; gap:.3rem; height:84px; padding:0 .8rem; border:1px dashed var(--line); border-radius:10px; font-size:.76rem; color:var(--muted); text-decoration:none; transition:border-color var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out)}
.rv__video:hover{border-color:var(--brand); color:var(--fg)}
.rv__video .ico{width:1rem; height:1rem}
.rv__likes{display:inline-flex; align-items:center; gap:.3rem; font-size:.72rem; color:var(--dim)}
.rv__likes .ico{width:.85rem; height:.85rem}
.rv__reply{margin:.1rem 0 0; padding:.6rem .8rem; border-left:3px solid var(--brand); border-radius:0 10px 10px 0; background:var(--panel-2); font-size:.8rem; line-height:1.5; color:var(--muted); max-width:68ch; white-space:pre-wrap; overflow-wrap:anywhere}
.rv__reply-tag{display:flex; align-items:center; gap:.3rem; font-size:.7rem; font-weight:600; letter-spacing:.02em; text-transform:uppercase; color:var(--brand); margin-bottom:.25rem}
.rv__reply-tag .ico{width:.85rem; height:.85rem}

.rv__lb{border:0; padding:0; background:transparent; max-width:min(96vw,1100px); max-height:96vh; width:auto; color:#fff}
.rv__lb::backdrop{background:rgba(8,12,10,.82); backdrop-filter:blur(6px)}
.rv__lb[open]{display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:.5rem}
.rv__lb-fig{margin:0; display:flex; flex-direction:column; align-items:center; gap:.6rem; min-width:0}
.rv__lb-fig img{max-width:min(88vw,900px); max-height:80vh; border-radius:12px; box-shadow:0 30px 80px -20px rgba(0,0,0,.8); background:#111}
.rv__lb-fig figcaption{display:flex; gap:1rem; align-items:center; font-size:.8rem; color:rgba(255,255,255,.85)}
.rv__lb-btn{width:2.75rem; height:2.75rem; border-radius:50%; border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.08); color:#fff; display:grid; place-items:center; cursor:pointer; transition:background var(--t-fast) var(--ease-out)}
.rv__lb-btn:hover{background:rgba(255,255,255,.18)}
.rv__lb-btn:focus-visible{outline:2px solid #fff; outline-offset:2px}
.rv__lb-btn .ico{width:1.2rem; height:1.2rem}
.rv__lb-close{position:fixed; top:1rem; right:1rem}
.rv__lb[open]{animation:rvIn var(--t-base) var(--ease-out)}
@keyframes rvIn{from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none}}
@media (prefers-reduced-motion:reduce){
  .rv__lb[open]{animation:none}
  .rv__photo img,.rv__dist-fill,.rv,.rv__photo{transition:none}
  .rv__photo:hover img{transform:none}
}

/* ------------------------------------------------- transaksi manual ---------- */
/* A data-entry form, so it is built for one hand on the keyboard: every field is
   reachable by tab in reading order, the running total never leaves the screen, and the
   money columns are monospaced so a missing zero is visible rather than merely present. */
.mx{display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:1.1rem; align-items:start}
@media (max-width:900px){.mx{grid-template-columns:minmax(0,1fr)}}

.mx__side{position:sticky; top:var(--top-offset); display:flex; flex-direction:column; gap:.7rem}
@media (max-width:900px){.mx__side{position:static}}

.src{display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:.5rem}
.src__o{position:relative; cursor:pointer}
.src__o input{position:absolute; inset:0; opacity:0; margin:0; cursor:pointer}
.src__b{display:flex; flex-direction:column; gap:.2rem; padding:.65rem .75rem; border-radius:10px;
  border:1px solid var(--line); background:var(--panel-2);
  transition:border-color var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out)}
.src__o:hover .src__b{border-color:var(--brand)}
.src__o input:focus-visible + .src__b{outline:2px solid var(--brand); outline-offset:2px}
.src__o input:checked + .src__b{border-color:var(--brand); background:color-mix(in srgb,var(--brand) 16%,var(--panel-2))}
.src__p{font-family:"Fira Code",ui-monospace,monospace; font-weight:600; font-size:.9rem; color:var(--brand)}
.src__o input:checked + .src__b .src__p{color:var(--fg)}
.src__l{font-size:.74rem; color:var(--muted); line-height:1.25}
.src__t{font-size:.68rem; color:var(--dim)}

.fset{padding:1rem; border-top:1px solid var(--line)}
.fset:first-child{border-top:0}
.fset__h{font-size:.72rem; letter-spacing:.08em; text-transform:uppercase; color:var(--dim); margin:0 0 .7rem}

.flds{display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:.7rem}
.flds--one{grid-template-columns:1fr; margin-top:.7rem}
.fld{display:flex; flex-direction:column; gap:.28rem; min-width:0}
.fld label{font-size:.74rem; color:var(--muted)}
.fld input,.fld select,.fld textarea{width:100%; font:inherit; font-size:.86rem; padding:.5rem .65rem;
  min-height:40px; border-radius:9px; border:1px solid var(--line); background:var(--panel-2); color:var(--fg)}
.fld input:focus-visible,.fld select:focus-visible,.fld textarea:focus-visible{
  outline:2px solid var(--brand); outline-offset:1px; border-color:transparent}
.fld--mono input{font-family:"Fira Code",ui-monospace,monospace; letter-spacing:.02em}
.fld__hint{font-size:.68rem; color:var(--dim)}

/* Line rows: product wide, money narrow and monospaced, remove last so tabbing through
   a row never lands on the destructive control on the way to the next field. */
.ln{display:grid; grid-template-columns:minmax(0,1fr) 68px 116px 138px 92px 36px; gap:.4rem; align-items:center;
  padding:.4rem 0; animation:rise 260ms var(--ease-out) both}
.ln + .ln{border-top:1px solid color-mix(in srgb,var(--line) 60%,transparent)}
.ln select,.ln input{width:100%; font:inherit; font-size:.82rem; padding:.42rem .5rem; min-height:38px;
  border-radius:8px; border:1px solid var(--line); background:var(--panel-2); color:var(--fg)}
.ln input[type="number"]{font-family:"Fira Code",ui-monospace,monospace; text-align:right}

/* The discount cell holds two controls: how much, and of what. They read as one field. */
.ln__disc{display:flex; align-items:stretch; gap:.25rem; min-width:0}
.ln__disc input[type="number"]{flex:1; min-width:0}
.seg{display:flex; flex:none; padding:2px; gap:2px; border-radius:8px; border:1px solid var(--line);
  background:var(--panel-2)}
.seg__b{font:inherit; font-size:.72rem; font-weight:600; line-height:1; width:24px; padding:0; cursor:pointer;
  border:0; border-radius:6px; background:transparent; color:var(--dim); transition:color var(--t-fast), background var(--t-fast)}
.seg__b:hover{color:var(--fg)}
.seg__b.is-on{color:#fff; background:linear-gradient(155deg,var(--fill-a),var(--fill-b))}
.seg__b:focus-visible{outline:2px solid var(--brand); outline-offset:1px}
.ln select:focus-visible,.ln input:focus-visible{outline:2px solid var(--brand); outline-offset:1px; border-color:transparent}
.ln__t{font-family:"Fira Code",ui-monospace,monospace; font-size:.82rem; text-align:right; color:var(--muted)}
.ln__x{display:grid; place-items:center; width:32px; height:32px; border-radius:8px; cursor:pointer;
  border:1px solid transparent; background:none; color:var(--dim); font-size:1.1rem; line-height:1;
  transition:color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out)}
.ln__x:hover{color:var(--bad); border-color:var(--bad)}
.ln__x:focus-visible{outline:2px solid var(--brand); outline-offset:1px}
/* One column narrower than a sale line: a wrong parcel has no discount to give. */
.ln--wrong,.lnh--wrong{grid-template-columns:minmax(0,1fr) 68px 116px 92px 36px}
.rs__note{margin:.1rem 0 .9rem; max-width:58rem}

/* ---- picking the order a mistake belongs to ----
   The list sits under the field rather than over the page: it never covers the rows the
   operator is about to fill in, and at z-20 it stays below the sticky nav at z-40. */
.rsf{position:relative}
.pick0s{list-style:none; margin:.35rem 0 0; padding:.25rem; max-height:19rem; overflow-y:auto;
  background:var(--panel-2); border:1px solid var(--line); border-radius:11px; z-index:20;
  box-shadow:var(--shadow)}
.pick0s[hidden]{display:none}
.pick0{display:grid; grid-template-columns:auto 1fr auto; gap:.2rem .6rem; align-items:center;
  padding:.5rem .6rem; min-height:46px; border-radius:8px; cursor:pointer;
  transition:background var(--t-fast) var(--ease-out)}
.pick0:hover,.pick0.is-on{background:var(--glass-2)}
.pick0.is-on{outline:1px solid var(--brand); outline-offset:-1px}
.pick0__head{grid-column:1/-1; display:flex; align-items:center; gap:.45rem; flex-wrap:wrap}
.pick0__id{font-size:.86rem; font-weight:600}
.pick0__when,.pick0__who{font-size:.78rem; color:var(--muted)}
.pick0__what{grid-column:1/-1; font-size:.78rem; color:var(--dim);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.pick0__none{margin:.45rem 0 0; font-size:.82rem; color:var(--muted)}

/* The chosen one, shown in full so a mistake is recorded against the right order.
   A left edge in the brand colour rather than a border all round: it reads as attached to
   the field above it, which is what it is. */
.rsprev{margin:.7rem 0 0; padding:.85rem 1rem; border-radius:12px;
  background:var(--glass); border:1px solid var(--glass-line); border-left:3px solid var(--brand);
  animation:rise var(--t-base) var(--ease-out) both}
.rsprev[hidden]{display:none}
.prev{display:block}
.prev__top{display:flex; align-items:center; gap:.6rem; margin-bottom:.45rem}
.prev__eyebrow{font-size:.68rem; letter-spacing:.07em; text-transform:uppercase; color:var(--brand); font-weight:600}
.prev__swap{margin-left:auto; font:inherit; font-size:.76rem; padding:.3rem .7rem; min-height:32px;
  border-radius:999px; cursor:pointer; color:var(--muted);
  background:transparent; border:1px solid var(--line);
  transition:color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out)}
.prev__swap:hover{color:var(--fg); border-color:var(--brand)}
.prev__h{display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; font-size:.86rem}
.prev__id{font-size:.98rem; font-weight:600}
.prev__t{margin-left:auto; font-weight:600; font-size:.98rem}
.prev__g{display:flex; flex-wrap:wrap; gap:.35rem 1.6rem; margin:.6rem 0 0}
.prev__f dt{font-size:.66rem; letter-spacing:.06em; text-transform:uppercase; color:var(--dim)}
.prev__f dd{margin:0; font-size:.86rem}
.prev__a{margin:.55rem 0 0; font-size:.82rem; color:var(--muted); max-width:52rem; line-height:1.55}
.prev__lh{display:block; margin:.75rem 0 .3rem; font-size:.7rem; letter-spacing:.06em;
  text-transform:uppercase; color:var(--muted)}
.prev__l{list-style:none; margin:0; padding:.45rem 0 0; border-top:1px solid var(--glass-line);
  font-size:.84rem; display:grid; gap:.3rem}
.prev__l li{display:grid; grid-template-columns:1fr auto auto; gap:.3rem .8rem; align-items:baseline}
.prev__sku{font-size:.72rem; color:var(--dim)}
.prev__l b{text-align:right; min-width:2rem}
/* The shortcut that makes the card worth reading: what they ordered is what to send. */
.prev__use{margin:.75rem 0 0; font:inherit; font-size:.82rem; font-weight:500; width:100%;
  padding:.55rem .9rem; min-height:42px; border-radius:9px; cursor:pointer;
  color:var(--fg); background:var(--panel-2); border:1px dashed var(--line);
  transition:border-color var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out)}
.prev__use:hover{border-color:var(--brand); border-style:solid; color:var(--brand)}
.prev__use.is-done{border-style:solid; border-color:var(--good); color:var(--good); cursor:default}
.sum__r--wrong b{color:var(--warn)}
.lnh{display:grid; grid-template-columns:minmax(0,1fr) 68px 116px 116px 92px 36px; gap:.4rem;
  font-size:.68rem; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); padding-bottom:.35rem;
  border-bottom:1px solid var(--line)}
.lnh span:nth-child(n+2){text-align:right}
@media (max-width:720px){
  /* One column narrower than a sale line: a wrong parcel has no discount to give. */
.ln--wrong,.lnh--wrong{grid-template-columns:minmax(0,1fr) 68px 116px 92px 36px}
.rs__note{margin:.1rem 0 .9rem; max-width:58rem}

/* ---- picking the order a mistake belongs to ----
   The list sits under the field rather than over the page: it never covers the rows the
   operator is about to fill in, and at z-20 it stays below the sticky nav at z-40. */
.rsf{position:relative}
.pick0s{list-style:none; margin:.35rem 0 0; padding:.25rem; max-height:19rem; overflow-y:auto;
  background:var(--panel-2); border:1px solid var(--line); border-radius:11px; z-index:20;
  box-shadow:var(--shadow)}
.pick0s[hidden]{display:none}
.pick0{display:grid; grid-template-columns:auto 1fr auto; gap:.2rem .6rem; align-items:center;
  padding:.5rem .6rem; min-height:46px; border-radius:8px; cursor:pointer;
  transition:background var(--t-fast) var(--ease-out)}
.pick0:hover,.pick0.is-on{background:var(--glass-2)}
.pick0.is-on{outline:1px solid var(--brand); outline-offset:-1px}
.pick0__head{grid-column:1/-1; display:flex; align-items:center; gap:.45rem; flex-wrap:wrap}
.pick0__id{font-size:.86rem; font-weight:600}
.pick0__when,.pick0__who{font-size:.78rem; color:var(--muted)}
.pick0__what{grid-column:1/-1; font-size:.78rem; color:var(--dim);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.pick0__none{margin:.45rem 0 0; font-size:.82rem; color:var(--muted)}

/* The chosen one, shown in full so a mistake is recorded against the right order.
   A left edge in the brand colour rather than a border all round: it reads as attached to
   the field above it, which is what it is. */
.rsprev{margin:.7rem 0 0; padding:.85rem 1rem; border-radius:12px;
  background:var(--glass); border:1px solid var(--glass-line); border-left:3px solid var(--brand);
  animation:rise var(--t-base) var(--ease-out) both}
.rsprev[hidden]{display:none}
.prev{display:block}
.prev__top{display:flex; align-items:center; gap:.6rem; margin-bottom:.45rem}
.prev__eyebrow{font-size:.68rem; letter-spacing:.07em; text-transform:uppercase; color:var(--brand); font-weight:600}
.prev__swap{margin-left:auto; font:inherit; font-size:.76rem; padding:.3rem .7rem; min-height:32px;
  border-radius:999px; cursor:pointer; color:var(--muted);
  background:transparent; border:1px solid var(--line);
  transition:color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out)}
.prev__swap:hover{color:var(--fg); border-color:var(--brand)}
.prev__h{display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; font-size:.86rem}
.prev__id{font-size:.98rem; font-weight:600}
.prev__t{margin-left:auto; font-weight:600; font-size:.98rem}
.prev__g{display:flex; flex-wrap:wrap; gap:.35rem 1.6rem; margin:.6rem 0 0}
.prev__f dt{font-size:.66rem; letter-spacing:.06em; text-transform:uppercase; color:var(--dim)}
.prev__f dd{margin:0; font-size:.86rem}
.prev__a{margin:.55rem 0 0; font-size:.82rem; color:var(--muted); max-width:52rem; line-height:1.55}
.prev__lh{display:block; margin:.75rem 0 .3rem; font-size:.7rem; letter-spacing:.06em;
  text-transform:uppercase; color:var(--muted)}
.prev__l{list-style:none; margin:0; padding:.45rem 0 0; border-top:1px solid var(--glass-line);
  font-size:.84rem; display:grid; gap:.3rem}
.prev__l li{display:grid; grid-template-columns:1fr auto auto; gap:.3rem .8rem; align-items:baseline}
.prev__sku{font-size:.72rem; color:var(--dim)}
.prev__l b{text-align:right; min-width:2rem}
/* The shortcut that makes the card worth reading: what they ordered is what to send. */
.prev__use{margin:.75rem 0 0; font:inherit; font-size:.82rem; font-weight:500; width:100%;
  padding:.55rem .9rem; min-height:42px; border-radius:9px; cursor:pointer;
  color:var(--fg); background:var(--panel-2); border:1px dashed var(--line);
  transition:border-color var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out)}
.prev__use:hover{border-color:var(--brand); border-style:solid; color:var(--brand)}
.prev__use.is-done{border-style:solid; border-color:var(--good); color:var(--good); cursor:default}
.sum__r--wrong b{color:var(--warn)}
.lnh{display:none}
  .ln{grid-template-columns:minmax(0,1fr) 36px; grid-auto-rows:auto; gap:.35rem;
    padding:.7rem 0; border-top:1px solid var(--line)}
  .ln select{grid-column:1}
  .ln__x{grid-row:1; grid-column:2}
  .ln input,.ln__t{grid-column:1/-1}
}

.fld__warn{margin:.4rem 0 0; font-size:.74rem; line-height:1.45; color:var(--warn)}
.addln{margin-top:.6rem; font:inherit; font-size:.8rem; font-weight:600; padding:.45rem .8rem; min-height:38px;
  border-radius:9px; cursor:pointer; border:1px dashed var(--line); background:none; color:var(--muted);
  transition:color var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out)}
.addln:hover{color:var(--fg); border-color:var(--brand)}
.addln:focus-visible{outline:2px solid var(--brand); outline-offset:1px}

.sum{padding:1rem}
.sum__r{display:flex; justify-content:space-between; gap:1rem; font-size:.8rem; padding:.3rem 0; color:var(--muted)}
.sum__r b{font-family:"Fira Code",ui-monospace,monospace; font-weight:500; color:var(--fg)}
.sum__t{margin-top:.5rem; padding-top:.6rem; border-top:1px solid var(--line);
  display:flex; justify-content:space-between; align-items:baseline; gap:1rem}
.sum__t span{font-size:.78rem; color:var(--muted)}
.sum__t b{font-family:"Fira Code",ui-monospace,monospace; font-size:1.25rem; font-weight:600; color:var(--fg)}
.sum__go{width:100%; margin-top:.9rem; font:inherit; font-size:.88rem; font-weight:600; padding:.7rem 1rem;
  min-height:46px; border-radius:999px; cursor:pointer; border:1px solid transparent; color:#fff;
  background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent);
  transition:filter var(--t-fast) var(--ease-out)}
.sum__go:hover:not(:disabled){filter:brightness(1.08)}
.sum__go:disabled{opacity:.45; cursor:not-allowed}
.sum__go:focus-visible{outline:2px solid var(--brand); outline-offset:2px}

/* ---------------------------------------------------- motion & loading -------- */
/* Entrances follow the motion doctrine: power3.out, no overshoot, and a stagger whose
   total stays under ~0.5s so an arrival reads as one beat rather than a queue. */
@keyframes rise{from{opacity:0; transform:translateY(10px)}to{opacity:1; transform:none}}
@keyframes pop{from{opacity:0; transform:translateY(12px) scale(.96)}to{opacity:1; transform:none}}
@keyframes veil{from{opacity:0}to{opacity:1}}
@keyframes sheen{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(0)}}
@keyframes dot{0%,80%,100%{transform:translateY(0); opacity:.35}40%{transform:translateY(-4px); opacity:1}}

.kpis,.strip,.chs,.panel,.cards,.scroll,.sync,.alert{animation:rise var(--t-slow) var(--ease-out) both}
.kpis,.strip{animation-delay:40ms}
.chs,.sync{animation-delay:90ms}
.panel,.cards,.scroll{animation-delay:140ms}
/* Cards arrive as one wave: six steps of 40ms is 240ms end to end, inside the cap. */
.cards .card{animation:rise 340ms var(--ease-out) both}
.cards .card:nth-child(6n+1){animation-delay:130ms}
.cards .card:nth-child(6n+2){animation-delay:170ms}
.cards .card:nth-child(6n+3){animation-delay:210ms}
.cards .card:nth-child(6n+4){animation-delay:250ms}
.cards .card:nth-child(6n+5){animation-delay:290ms}
.cards .card:nth-child(6n){animation-delay:330ms}

/* Navigation takes seconds against four marketplaces, so the click has to answer
   immediately: a determinate-looking sweep plus a skeleton of the page being fetched. */
#nav-progress{position:fixed; inset:0 0 auto; height:2px; z-index:60; pointer-events:none;
  background:linear-gradient(90deg,var(--brand),var(--cta-hi)); transform:translateX(-100%);
  opacity:0; transition:opacity var(--t-fast)}
#nav-progress.on{opacity:1; animation:sweep 9s var(--ease-soft) forwards}

#loader{position:fixed; inset:0; z-index:55; display:none; padding:.75rem 1.25rem; overflow:hidden;
  background:color-mix(in srgb,var(--bg) 82%,transparent); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px)}
#loader.on{display:block; animation:veil var(--t-base) var(--ease-out) both}
/* The skeleton is the page's own silhouette - pill, title, ink slab, panels - so the
   wait already looks like where you are going. Each piece lands 40ms after the last. */
.sk{position:relative; overflow:hidden; border-radius:var(--radius); background:var(--glass-2); border:1px solid var(--glass-line);
  animation:rise 320ms var(--ease-out) both}
.sk::after{content:''; position:absolute; inset:0;
  background:linear-gradient(100deg,transparent 20%,color-mix(in srgb,var(--fg) 8%,transparent) 50%,transparent 80%);
  animation:sheen 1.4s var(--ease-soft) infinite}
.sk--pill{height:54px; border-radius:999px; margin-bottom:1.4rem}
.sk--head{display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; margin-bottom:1.1rem}
.sk--title{width:min(18rem,50%); height:40px; border-radius:12px; animation-delay:40ms}
.sk--ctl{width:14rem; height:38px; border-radius:999px; animation-delay:80ms}
.sk--ink{display:grid; grid-template-columns:repeat(4,1fr); height:104px; margin-bottom:1rem; animation-delay:120ms;
  background:linear-gradient(180deg,var(--ink-2),var(--ink)); border-color:var(--ink-line)}
.sk--ink>span{border-left:1px solid var(--ink-line)}
.sk--ink>span:first-child{border-left:0}
.sk--grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:.7rem}
.sk--grid>.sk{height:112px}
.sk--grid>.sk:nth-child(1){animation-delay:160ms}
.sk--grid>.sk:nth-child(2){animation-delay:200ms}
.sk--grid>.sk:nth-child(3){animation-delay:240ms}
.sk--grid>.sk:nth-child(4){animation-delay:280ms}
.sk--grid>.sk:nth-child(5){animation-delay:320ms}
.sk--grid>.sk:nth-child(6){animation-delay:360ms}
.loader__note{display:flex; align-items:center; gap:.6rem; justify-content:center; margin:1.4rem 0 0;
  font-size:.86rem; color:var(--muted); animation:rise 320ms var(--ease-out) 200ms both}
.loader__dots{display:inline-flex; gap:4px}
.loader__dots i{width:6px; height:6px; border-radius:50%; background:var(--cta-hi); animation:dot 1.1s var(--ease-soft) infinite}
.loader__dots i:nth-child(2){animation-delay:150ms}
.loader__dots i:nth-child(3){animation-delay:300ms}
@media (max-width:900px){ .sk--ink{grid-template-columns:1fr 1fr; height:150px} .sk--ctl{display:none} }

/* --- confirmation: the question every irreversible button asks, in the house voice.
   Frosted glass over a dimmed page, lands with a short settle, and the commit is the
   one warm thing on screen. --- */
.cf{width:min(27rem,calc(100vw - 2rem)); padding:0; border:1px solid var(--glass-line); border-radius:22px;
  background:color-mix(in srgb,var(--panel) 90%,transparent);
  backdrop-filter:blur(24px) saturate(1.4); -webkit-backdrop-filter:blur(24px) saturate(1.4); color:var(--fg);
  box-shadow:0 40px 90px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.07)}
.cf::backdrop{background:color-mix(in srgb,#0A0F0D 62%,transparent); backdrop-filter:blur(6px)}
.cf[open]{animation:pop 280ms var(--ease-out) both}
.cf[open]::backdrop{animation:veil 240ms var(--ease-out) both}
.cf__box{padding:1.6rem 1.6rem 1.5rem}
.cf__ico{width:44px; height:44px; border-radius:50%; display:grid; place-items:center; margin-bottom:1rem;
  color:var(--warn); background:color-mix(in srgb,var(--warn) 14%,transparent);
  border:1px solid color-mix(in srgb,var(--warn) 35%,transparent)}
.cf__ico .ico{width:20px; height:20px}
.cf--bad .cf__ico{color:var(--bad); background:color-mix(in srgb,var(--bad) 14%,transparent);
  border-color:color-mix(in srgb,var(--bad) 35%,transparent)}
.cf__title{margin:0; font-size:1.2rem; font-weight:600; letter-spacing:-.02em}
.cf__text{margin:.5rem 0 0; font-size:.9rem; line-height:1.55; color:var(--muted); overflow-wrap:anywhere}
.cf__row{display:flex; gap:.6rem; margin-top:1.5rem}
.cf__no,.cf__yes{flex:1; font:inherit; font-size:.9rem; font-weight:600; padding:.7rem; min-height:46px;
  border-radius:999px; cursor:pointer;
  transition:filter var(--t-base) var(--ease-out), background var(--t-fast), transform var(--t-fast) var(--ease-out)}
.cf__no{border:1px solid var(--glass-line); background:var(--glass); color:var(--fg)}
.cf__no:hover{background:var(--glass-2)}
.cf__yes{border:1px solid transparent; color:#fff; background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent)}
.cf__yes:hover{filter:brightness(1.08); transform:translateY(-1px)}
.cf__yes:active{transform:none}
.cf--bad .cf__yes{background:linear-gradient(155deg,color-mix(in srgb,var(--bad) 80%,#000),color-mix(in srgb,var(--bad) 55%,#000)); box-shadow:none}
.cf__no:focus-visible,.cf__yes:focus-visible{outline:2px solid var(--brand); outline-offset:2px}

/* --- the moment after a save: one beat of celebration, then back to work.
   Choreography on one clock: veil 0ms, disc settles from 80ms, check draws from 380ms,
   confetti leaves at 300ms as the check lands, words rise from 520ms, gone at 3.2s. --- */
@keyframes yay-disc{from{opacity:0; transform:scale(.55)}to{opacity:1; transform:none}}
@keyframes yay-ring{from{opacity:.55; transform:scale(.7)}to{opacity:0; transform:scale(1.7)}}
@keyframes yay-draw{to{stroke-dashoffset:0}}
@keyframes yay-glow{0%{opacity:0; transform:scale(.6)}35%{opacity:.9}100%{opacity:0; transform:scale(1.9)}}
@keyframes yay-x{0%{opacity:0}8%{opacity:1}72%{opacity:1}100%{opacity:0; transform:translateX(var(--x))}}
@keyframes yay-y{0%{transform:translateY(0) scale(0) rotate(0); animation-timing-function:cubic-bezier(.2,.8,.3,1)}
  10%{transform:translateY(calc(var(--y) * .3)) scale(1) rotate(calc(var(--r) * .1))}
  42%{transform:translateY(var(--y)) scale(1) rotate(calc(var(--r) * .45)); animation-timing-function:cubic-bezier(.5,0,.85,.4)}
  100%{transform:translateY(calc(var(--y) + 170px)) scale(.9) rotate(var(--r))}}
.yay{position:fixed; inset:0; z-index:70; display:grid; place-items:center; padding:1rem;
  background:color-mix(in srgb,#0A0F0D 58%,transparent); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
  animation:veil 240ms var(--ease-out) both}
.yay.is-out{animation:veil 260ms var(--ease-out) reverse both; pointer-events:none}
.yay__card{width:min(24rem,calc(100vw - 2rem)); padding:1.6rem 1.6rem 1.5rem; text-align:center; border-radius:26px;
  border:1px solid var(--glass-line); background:color-mix(in srgb,var(--panel) 90%,transparent);
  backdrop-filter:blur(24px) saturate(1.4); -webkit-backdrop-filter:blur(24px) saturate(1.4);
  box-shadow:0 40px 90px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.07);
  animation:pop 320ms var(--ease-out) both}
.yay__stage{position:relative; width:168px; height:168px; margin:.2rem auto .9rem; display:grid; place-items:center}
.yay__disc{position:relative; z-index:2; width:118px; height:118px; border-radius:50%; display:grid; place-items:center;
  background:#45D19B; box-shadow:0 18px 40px -16px rgba(69,209,155,.75), inset 0 1px 0 rgba(255,255,255,.35);
  animation:yay-disc 520ms cubic-bezier(.16,1,.3,1) 80ms both}
.yay__disc svg{width:64px; height:64px}
.yay__check{stroke-dasharray:36; stroke-dashoffset:36; animation:yay-draw 420ms var(--ease-out) 380ms forwards}
.yay__ring{position:absolute; z-index:1; width:118px; height:118px; border-radius:50%; border:2px solid #45D19B;
  animation:yay-ring 900ms var(--ease-out) 320ms both}
.yay__ring--2{animation-delay:480ms}
.yay__glow{position:absolute; z-index:0; width:150px; height:150px; border-radius:50%;
  background:radial-gradient(circle,rgba(69,209,155,.55),rgba(255,176,32,.25) 55%,transparent 72%);
  animation:yay-glow 1100ms var(--ease-out) 300ms both}
.yay__field{position:absolute; z-index:1; left:50%; top:50%; width:0; height:0; pointer-events:none}
.pt{position:absolute; left:0; top:0; display:block; width:var(--s); height:var(--s); margin:calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
  opacity:0; animation:yay-x 1150ms cubic-bezier(.15,.6,.35,1) calc(300ms + var(--d)) both; will-change:transform,opacity}
.pt i{display:block; width:100%; height:100%; animation:yay-y 1150ms calc(300ms + var(--d)) both; will-change:transform}
.pt--dot i{border-radius:50%; background:var(--c)}
.pt--chip i{border-radius:2px; background:var(--c); height:60%}
.pt--arc i{border-radius:50%; border:3px solid transparent; border-top-color:var(--c); border-right-color:var(--c); background:none}
.yay__title{margin:0; font-size:1.35rem; font-weight:600; letter-spacing:-.025em; animation:rise 360ms var(--ease-out) 520ms both}
.yay__text{margin:.4rem 0 0; font-size:.88rem; line-height:1.5; color:var(--muted); overflow-wrap:anywhere; animation:rise 360ms var(--ease-out) 580ms both}
.yay__ok{margin-top:1.25rem; width:100%; font:inherit; font-size:.9rem; font-weight:600; min-height:46px; padding:.7rem; border-radius:999px;
  cursor:pointer; color:#fff; border:1px solid transparent; background:linear-gradient(155deg,var(--fill-a),var(--fill-b));
  animation:rise 360ms var(--ease-out) 640ms both; transition:filter var(--t-fast) var(--ease-out)}
.yay__ok:hover{filter:brightness(1.1)}
.yay__ok:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
@media (prefers-reduced-motion:reduce){ .yay__field{display:none} .yay__check{stroke-dashoffset:0} }

/* --- the pickup step: one question, asked once, for a whole batch --- */
.pu{width:min(40rem,calc(100vw - 2rem)); max-height:min(88vh,50rem); padding:0; border:1px solid var(--glass-line);
  border-radius:22px; background:color-mix(in srgb,var(--panel) 92%,transparent); color:var(--fg);
  backdrop-filter:blur(24px) saturate(1.4); -webkit-backdrop-filter:blur(24px) saturate(1.4);
  box-shadow:0 40px 90px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.07)}
.pu::backdrop{background:color-mix(in srgb,#0A0F0D 62%,transparent); backdrop-filter:blur(6px)}
.pu[open]{animation:pop 280ms var(--ease-out) both}
.pu[open]::backdrop{animation:veil 240ms var(--ease-out) both}
/* Open without JavaScript the dialog is not modal, so it carries its own veil. */
.pu:not(:modal){position:fixed; inset:auto; top:50%; left:50%; transform:translate(-50%,-50%); z-index:70}
.pu__box{display:flex; flex-direction:column; gap:.9rem; padding:1.6rem; max-height:min(88vh,50rem); overflow:auto}
.pu__ico{width:44px; height:44px; border-radius:50%; display:grid; place-items:center; flex:none;
  color:var(--cta-hi); background:color-mix(in srgb,var(--cta-a) 16%,transparent);
  border:1px solid color-mix(in srgb,var(--cta-a) 40%,transparent)}
.pu__ico .ico{width:20px; height:20px}
.pu__title{margin:0; font-size:1.2rem; font-weight:600; letter-spacing:-.02em}
.pu__text{margin:0; font-size:.88rem; line-height:1.55; color:var(--muted)}
.pu__at{display:flex; align-items:center; gap:.45rem; margin:0; font-size:.78rem; color:var(--dim)}
.pu__at .ico{width:15px; height:15px; flex:none}
.pu__all{display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; border-radius:14px;
  background:var(--glass); border:1px solid var(--glass-line); font-size:.82rem; color:var(--muted)}
.pu__all select{margin-left:auto}
.pu__list{border:1px solid var(--glass-line); border-radius:14px; overflow:auto; max-height:22rem}
.pu__list th{background:color-mix(in srgb,var(--panel) 92%,transparent)}
.pu__slot{font:inherit; font-size:.82rem; padding:.4rem .6rem; min-height:38px; border-radius:999px;
  border:1px solid var(--glass-line); background:var(--panel-2); color:var(--fg); cursor:pointer; min-width:11rem}
.pu__slot:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.pu__row{display:flex; gap:.6rem; margin-top:.3rem}
.pu__no,.pu__yes{flex:1; font:inherit; font-size:.9rem; font-weight:600; padding:.7rem; min-height:46px;
  border-radius:999px; cursor:pointer; text-align:center; text-decoration:none;
  transition:filter var(--t-base) var(--ease-out), background var(--t-fast), transform var(--t-fast) var(--ease-out)}
.pu__no{border:1px solid var(--glass-line); background:var(--glass); color:var(--fg); display:grid; place-items:center}
.pu__no:hover{background:var(--glass-2)}
.pu__yes{border:1px solid transparent; color:#fff; background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent)}
.pu__yes:hover{filter:brightness(1.08); transform:translateY(-1px)}
.pu__yes:active{transform:none}
.pu__no:focus-visible,.pu__yes:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
@media (max-width:640px){ .pu__box{padding:1.1rem} .pu__slot{min-width:8rem} }

/* --- who is signed in: a small identity chip that doubles as a link to their own trail --- */
.who{display:inline-flex; align-items:center; gap:.5rem; padding:.2rem .75rem .2rem .2rem; min-height:38px; border-radius:999px;
  border:1px solid transparent; background:transparent; text-decoration:none; color:inherit;
  transition:background var(--t-fast), border-color var(--t-fast)}
.who:hover{background:var(--glass-2); border-color:var(--glass-line)}
.who__av{width:30px; height:30px; border-radius:50%; display:grid; place-items:center; flex:none;
  font-size:.68rem; font-weight:700; letter-spacing:.02em; color:#fff;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b))}
.who__t{display:flex; flex-direction:column; line-height:1.15; min-width:0}
.who__n{font-size:.8rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:11rem}
.who__r{font-size:.62rem; color:var(--muted); letter-spacing:.06em; text-transform:uppercase}
@media (max-width:640px){ .who__t{display:none} .who{padding:.2rem} }
/* ---- the doorbell: an instant order arriving while somebody is looking elsewhere ----
   Fixed, top right, under the pill rather than over it - the navigation must never be
   the thing an alert covers. Not auto-dismissed: a parcel does not stop needing packing
   because nobody watched the screen for eight seconds. */
.alerts{position:fixed; top:calc(var(--top-offset) + .5rem); right:1.25rem; z-index:60;
  display:flex; flex-direction:column; gap:.6rem; width:min(23rem,calc(100vw - 2.5rem));
  pointer-events:none}
.al{pointer-events:auto; padding:.85rem .95rem; border-radius:var(--radius-s);
  background:color-mix(in srgb,var(--panel) 92%,transparent);
  backdrop-filter:blur(var(--blur)) saturate(1.4); -webkit-backdrop-filter:blur(var(--blur)) saturate(1.4);
  border:1px solid var(--glass-line); border-left:3px solid var(--act);
  box-shadow:var(--shadow); animation:alin var(--t-base) var(--ease-out) both}
.al--warn{border-left-color:var(--warn)}
.al.is-out{animation:alout .24s var(--ease-soft) both}
@keyframes alin{from{opacity:0; transform:translate3d(12px,-6px,0) scale(.98)} to{opacity:1; transform:none}}
@keyframes alout{to{opacity:0; transform:translate3d(12px,0,0)}}
@media (prefers-reduced-motion:reduce){ .al,.al.is-out{animation:none} }
.al__top{display:flex; align-items:center; gap:.45rem; margin-bottom:.35rem}
.al__tag{font-size:.68rem; letter-spacing:.06em; text-transform:uppercase; font-weight:600;
  padding:.15rem .45rem; border-radius:999px; color:var(--fg);
  background:color-mix(in srgb,var(--act) 20%,transparent)}
.al--warn .al__tag{background:color-mix(in srgb,var(--warn) 20%,transparent)}
.al__id{font-family:"Fira Code",ui-monospace,monospace; font-size:.76rem; color:var(--muted)}
.al__x{margin-left:auto; width:26px; height:26px; flex:none; border:0; border-radius:50%;
  background:transparent; color:var(--dim); font-size:1.1rem; line-height:1; cursor:pointer}
.al__x:hover{color:var(--fg); background:var(--glass-2)}
.al__h{margin:0 0 .5rem; font-size:.92rem; font-weight:600; letter-spacing:-.01em}
.al__d{display:grid; grid-template-columns:auto 1fr; gap:.15rem .6rem; margin:0; font-size:.8rem}
.al__d dt{color:var(--dim)}
.al__d dd{margin:0; color:var(--fg)}
.al__go{display:inline-block; margin-top:.6rem; font-size:.8rem; font-weight:500;
  text-decoration:none; color:var(--fg); padding:.3rem .7rem; border-radius:999px;
  background:var(--glass); border:1px solid var(--glass-line)}
.al__go:hover{border-color:var(--brand)}
.al__snd{margin:.6rem 0 0 .4rem; font:inherit; font-size:.8rem; font-weight:500; cursor:pointer;
  padding:.3rem .7rem; border-radius:999px; color:var(--fg);
  background:color-mix(in srgb,var(--act) 18%,transparent); border:1px solid color-mix(in srgb,var(--act) 45%,transparent)}
.al__snd:hover{border-color:var(--act)}
@media (max-width:640px){ .alerts{left:1.25rem; right:1.25rem; width:auto} }
${style}
@media (prefers-reduced-motion:reduce){
  *{transition:none !important; animation:none !important}
  #nav-progress.on{opacity:1; transform:translateX(-15%)}
  .sk::after{display:none}
}
</style>
</head><body>
<div id="nav-progress"></div>
${user ? '<div id="alerts" class="alerts" aria-live="assertive" aria-label="Pemberitahuan pesanan instant"></div>' : ''}
<dialog class="cf" id="confirm" aria-labelledby="cf-title">
  <div class="cf__box">
    <span class="cf__ico" id="cf-ico" aria-hidden="true">${svg('warn')}</span>
    <h2 class="cf__title" id="cf-title">Konfirmasi</h2>
    <p class="cf__text" id="cf-text"></p>
    <div class="cf__row">
      <button class="cf__no" type="button" id="cf-no">Batal</button>
      <button class="cf__yes" type="button" id="cf-yes">Lanjutkan</button>
    </div>
  </div>
</dialog>
<div id="loader" aria-hidden="true">
  <div class="wrap">
    <div class="sk sk--pill"></div>
    <div class="sk--head"><div class="sk sk--title"></div><div class="sk sk--ctl"></div></div>
    <div class="sk sk--ink"><span></span><span></span><span></span><span></span></div>
    <div class="sk--grid"><div class="sk"></div><div class="sk"></div><div class="sk"></div>
      <div class="sk"></div><div class="sk"></div><div class="sk"></div></div>
    <p class="loader__note"><span class="loader__dots" aria-hidden="true"><i></i><i></i><i></i></span><span id="loader-text">Memuat…</span></p>
  </div>
</div>
${celebration(flash)}
<div class="wrap">
  <header class="top">
    <a class="brandline" href="?view=orders" aria-label="Treelogy, ke halaman pesanan">
      <span class="logo" aria-hidden="true">T</span>
      <span class="brand__n">Treelogy</span>
    </a>
    ${nav.tabs}
    <div class="tools">
      ${who}
      ${user ? `<a class="iconbtn${view === 'express' ? ' is-on' : ''}" href="?view=express"
        aria-label="Riwayat pickup instant" title="Riwayat pesanan instant &amp; instant prioritas">${svg('bell')}</a>` : ''}
      <button class="iconbtn" id="theme" type="button" aria-label="Ganti tema terang/gelap">${svg('sun')}</button>
      <a class="iconbtn" href="${escape(self)}" aria-label="Muat ulang data">${svg('refresh')}</a>
      <a class="iconbtn" href="?logout=1" aria-label="Keluar">${svg('logout')}</a>
    </div>
  </header>

  <section class="pagehead">
    <div class="pagehead__t">
      <h1>${escape(title)}</h1>
      <p class="sub">${escape(shopeeShop?.shop_name ?? 'Treelogy Moringa')} &middot; ${escape(scope ?? range.label)} &middot; diperbarui ${escape(new Date(generatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: zoneName() }))} ${zoneLabel()}${
      dataAge ? ` &middot; <span class="${dataAge.tone}">${escape(dataAge.text)}</span>` : ''}</p>
    </div>
    ${rangeControls || nav.actions ? `<div class="pagehead__acts">${rangeControls}${nav.actions}</div>` : ''}
  </section>

  ${problems}

  ${kpis}

  ${body}
</div>
<script>
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('omni-theme'); } catch (e) {}
  if (saved) root.setAttribute('data-theme', saved);

  var sun = ${JSON.stringify(svg('sun'))}, moon = ${JSON.stringify(svg('moon'))};
  var btn = document.getElementById('theme');
  function paint() { btn.innerHTML = root.getAttribute('data-theme') !== 'light' ? sun : moon; }
  paint();
  btn.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('omni-theme', next); } catch (e) {}
    paint();
  });

  // Four marketplaces answer in seconds, and a full page navigation shows nothing until
  // they all do. Arming the skeleton on the click itself is what turns that wait from
  // "did it register?" into visible progress.
  var progress = document.getElementById('nav-progress');
  var loader = document.getElementById('loader');
  var loaderText = document.getElementById('loader-text');

  function beginNavigation(label) {
    progress.classList.add('on');
    if (label) loaderText.textContent = label;
    // A fast response should never flash a skeleton; only a wait worth explaining does.
    window.setTimeout(function () {
      if (progress.classList.contains('on')) loader.classList.add('on');
    }, 260);
  }

  function endNavigation() {
    progress.classList.remove('on');
    loader.classList.remove('on');
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest('a[href]');
    if (!link || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || link.target === '_blank') return;
    // A download never leaves this page, so a skeleton armed for it would never be put away.
    if (link.hasAttribute('download')) return;
    var href = link.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    // mailto:, tel: and javascript: hand off to another app or run in place; the page stays
    // and a skeleton armed for them sat over it for good - the Pengguna tab's emails did.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) return;
    beginNavigation(link.classList.contains('viewtab') ? 'Memuat ' + link.textContent.trim() + '…' : 'Memuat…');
  }, true);

  document.addEventListener('submit', function (e) {
    if (e.target.getAttribute('target') === '_blank') return;
    // A form whose answer is a file never navigates, so a skeleton armed here would stay
    // over the page until the next click. Same reason a download link is skipped above.
    if (e.target.hasAttribute('data-download')) return;
    beginNavigation('Menyimpan…');
    // A listener further down the chain can still cancel this submit - every confirmation
    // on this dashboard does exactly that - and a navigation that never starts must not
    // leave a skeleton over the page forever. Checked on the next tick, by which time
    // every other handler has had its say.
    window.setTimeout(function () { if (e.defaultPrevented) endNavigation(); }, 0);
  }, true);

  // One press, one write.
  //
  // Arranging a batch takes seconds and nothing on the button changes while it does, so
  // the operator presses it again - ten times in ninety seconds, in the run that prompted
  // this. Every one of those is a real POST that ships real parcels, and the ones that
  // overlap are two shipments of the same order racing each other at the platform.
  //
  // Bound after the skeleton handler and in the bubble phase, so a confirmation dialog
  // that cancels the submit has already had its say and the button is never left dead on
  // a press that went nowhere.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (e.defaultPrevented || form.hasAttribute('data-download') || form.getAttribute('target') === '_blank') return;
    var buttons = form.querySelectorAll('button[type="submit"], button:not([type])');
    window.setTimeout(function () {
      if (e.defaultPrevented) return;
      Array.prototype.forEach.call(buttons, function (button) {
        button.disabled = true;
        button.dataset.busy = '1';
      });
    }, 0);
  });

  // Coming back through history shows a cached page, and a button disabled by a submit
  // that has since finished would be a page nobody can use.
  window.addEventListener('pageshow', function () {
    progress.classList.remove('on');
    loader.classList.remove('on');
    Array.prototype.forEach.call(document.querySelectorAll('[data-busy]'), function (button) {
      button.disabled = false;
      delete button.dataset.busy;
    });
  });

  // A focused number input changes value on wheel. On a page that writes stock and
  // prices to live listings that is not a quirk, it is a silent data-entry fault: a
  // scroll past the form can turn 999999 into 1000246 with nothing on screen to say so.
  //
  // The guard sits on the input rather than the document because the value change is the
  // input's own default action, and it only engages while the field is focused - scrolling
  // the page with the mouse merely passing over an idle field still works normally.
  document.querySelectorAll('input[type="number"]').forEach(function (input) {
    input.addEventListener('wheel', function (e) {
      if (document.activeElement !== input) return;
      e.preventDefault();
      input.blur();
    }, { passive: false });
  });

  // Arrow keys stay: those are a deliberate keystroke, not a side effect of scrolling.

  /**
   * The house confirmation, in place of the browser's.
   *
   * One dialog for every irreversible button on the dashboard, so the question always
   * looks and behaves the same, and so the wording can carry the number actually about
   * to be written. Escape and the backdrop mean no, which is the safe answer.
   */
  var dialog = document.getElementById('confirm');
  var dialogText = document.getElementById('cf-text');
  var yes = document.getElementById('cf-yes');
  var no = document.getElementById('cf-no');

  function ask(text, danger) {
    if (!dialog || !dialog.showModal) return Promise.resolve(window.confirm(text));
    dialogText.textContent = text;
    dialog.classList.toggle('cf--bad', Boolean(danger));
    yes.textContent = danger ? 'Ya, lanjutkan' : 'Lanjutkan';
    return new Promise(function (resolve) {
      var done = false;
      function finish(answer) {
        if (done) return;
        done = true;
        dialog.removeEventListener('close', onClose);
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        dialog.removeEventListener('click', onBackdrop);
        if (dialog.open) dialog.close();
        resolve(answer);
      }
      function onYes() { finish(true); }
      function onNo() { finish(false); }
      function onClose() { finish(false); }
      function onBackdrop(e) { if (e.target === dialog) finish(false); }

      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
      dialog.addEventListener('close', onClose);
      dialog.addEventListener('click', onBackdrop);
      dialog.showModal();
      // The cautious option takes the focus, so a held Enter cannot answer yes for you.
      no.focus();
    });
  }
  window.treelogyConfirm = ask;

  // A green note is a receipt, not a warning: two seconds on screen, then it leaves, and
  // its query flag goes with it so a reload does not bring it back. Errors stay put.
  Array.prototype.forEach.call(document.querySelectorAll('.alert[data-brief]'), function (note) {
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.setTimeout(function () {
      note.classList.add('is-going');
      window.setTimeout(function () { if (note.parentNode) note.parentNode.removeChild(note); }, calm ? 0 : 260);
    }, 2000);
  });
  try {
    var addr = new URL(window.location.href);
    if (addr.searchParams.has('done')) {
      addr.searchParams.delete('done');
      window.history.replaceState(null, '', addr.pathname + addr.search + addr.hash);
    }
  } catch (e) {}

  // The celebration closes itself, on a click, on Escape or Enter, and takes its own
  // query flag out of the address bar so a reload or the back button cannot replay it.
  var yay = document.getElementById('yay');
  if (yay) {
    var yayOk = document.getElementById('yay-ok');
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var yayGone = false;
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
    try {
      var here = new URL(window.location.href);
      if (here.searchParams.has('yay')) {
        here.searchParams.delete('yay');
        window.history.replaceState(null, '', here.pathname + here.search + here.hash);
      }
    } catch (e) {}
    function yayClose() {
      if (yayGone) return;
      yayGone = true;
      yay.classList.add('is-out');
      window.setTimeout(function () { if (yay.parentNode) yay.parentNode.removeChild(yay); }, calm ? 0 : 280);
    }
    yayOk.addEventListener('click', yayClose);
    yay.addEventListener('click', function (e) { if (e.target === yay) yayClose(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.key === 'Enter') yayClose(); });
    window.setTimeout(yayClose, calm ? 1800 : 3200);
  }

  /*
   * Everything that asks before it writes, asked in one place.
   *
   * The question can sit on the form or on the button that submitted it - "Hapus Dewi?"
   * belongs to the delete button, not to the row - so the submitter is checked first.
   * {v} is replaced with the number the form is about to write, because "save 0" and
   * "save 240" deserve different answers.
   */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.dataset.confirmed === '1') { form.dataset.confirmed = ''; return; }

    var submitter = e.submitter;
    var text = (submitter && submitter.dataset.confirmText) || form.dataset.confirmText || form.dataset.confirm;
    if (!text) return;

    var field = form.querySelector('input[type="number"]');
    e.preventDefault();
    ask(text.replace('{v}', field ? field.value : ''), Boolean(submitter && submitter.classList.contains('um__act--bad')))
      .then(function (ok) {
        if (!ok) return;
        form.dataset.confirmed = '1';
        if (form.requestSubmit) form.requestSubmit(submitter || undefined);
        else form.submit();
      });
  });
})();

/*
 * The doorbell.
 *
 * Everything else on this dashboard is pulled - a page opened, a list read. That is right
 * for almost all of it and wrong for an instant order, where the channel dispatches a
 * driver and the useful window is minutes. So one connection is held open and the server
 * speaks first.
 *
 * EventSource, not a poll and not a websocket: it reconnects by itself, replays the last
 * id it saw so a dropped connection costs nothing, and needs no upstream channel. Only
 * for a signed-in page; the login screen has nothing to be told.
 */
${user ? `(function () {
  if (!window.EventSource) return;
  var box = document.getElementById('alerts');
  if (!box) return;

  var SEEN = 'treelogy.alert.seen';
  function seen() { try { return Number(localStorage.getItem(SEEN)) || 0; } catch (e) { return 0; } }
  function remember(id) { try { localStorage.setItem(SEEN, String(id)); } catch (e) {} }

  function card(a) {
    var d = a.data || {};
    var el = document.createElement('article');
    el.className = 'al al--' + (a.tone || 'act');
    el.setAttribute('role', 'alert');
    /*
     * Escaped where it is built, not where it is used.
     *
     * A buyer's name is typed by a stranger on a marketplace and arrives here verbatim.
     * The first cut of this interpolated the value straight into innerHTML so that the
     * "3 item" separator could be an entity, and a headless-browser check caught
     * "Dewi <b>x</b>" rendering as markup. Every value is escaped as it goes into the
     * row, and only the separator - which this file wrote - is markup.
     */
    var rows = [
      d.courier ? ['Kurir', esc(d.courier)] : null,
      d.buyer ? ['Pembeli', esc(d.buyer)] : null,
      d.total ? ['Nilai', esc(d.total) + (d.items ? ' &middot; ' + esc(d.items) + ' item' : '')] : null,
      d.placedAt ? ['Masuk', esc(d.placedAt) + ' WITA'] : null,
    ].filter(Boolean);

    el.innerHTML =
      '<div class="al__top"><span class="al__tag">' + esc(d.channelName || '') + '</span>' +
      '<span class="al__id">' + esc(d.id || '') + '</span>' +
      '<button type="button" class="al__x" aria-label="Tutup">&times;</button></div>' +
      '<h3 class="al__h">' + esc(a.title || '') + '</h3>' +
      '<dl class="al__d">' + rows.map(function (r) {
        return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>';
      }).join('') + '</dl>' +
      (samePath(a.href) ? '<a class="al__go" href="' + esc(a.href) + '">Buka daftar label</a>' : '') +
      (blockedSound() ? '<button type="button" class="al__snd">🔔 Aktifkan suara</button>' : '');

    el.querySelector('.al__x').addEventListener('click', function () { close(el); });
    var snd = el.querySelector('.al__snd');
    if (snd) snd.addEventListener('click', function () { unlock(); chime(); });
    return el;
  }

  /*
   * A path on this site, and nothing else.
   *
   * Written without a regular expression on purpose: this whole block is emitted from a
   * template literal, which eats backslashes, and a pattern like /^\/[\w-]*$/ arrives in
   * the browser as something that does not parse. That cost an evening once already over
   * an emoji filter; two character checks cannot be mangled. "//evil.com" is rejected
   * too - it starts with a slash and is somebody else's host.
   */
  function samePath(href) {
    var v = String(href == null ? '' : href);
    return v.charAt(0) === '/' && v.charAt(1) !== '/';
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function close(el) {
    stopAlarm(el);
    el.classList.add('is-out');
    // Counted after the removal, not before it: the card is still in the box while it
    // animates out, so a title recounted here would keep showing the one just dismissed.
    setTimeout(function () { el.remove(); retitle(); }, 260);
  }

  /*
   * The sound, and the reason it is not one beep.
   *
   * The problem this exists for is a packer who does not notice, and then a Gojek driver
   * is standing at the bench. A popup only works on somebody who happens to be looking at
   * the screen; a single chime only works on somebody who happens to be in the room at
   * that second. So an instant order chimes on arrival and keeps chiming every eight
   * seconds until the card is dismissed or a minute has passed - a minute being about how
   * long it takes a driver to arrive once the platform has dispatched one.
   */
  var ac = null;
  function audio() {
    if (ac) return ac;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    try { ac = new Ctor(); } catch (e) { ac = null; }
    return ac;
  }

  /*
   * A browser will not make a sound on a page nobody has touched, and a dashboard left
   * open on a bench is exactly such a page. The context is resumed on the first click or
   * key anywhere, which costs the operator nothing and usually happens long before the
   * first parcel. Until it does, the card carries a button that says so, because silence
   * the operator cannot explain is worse than no sound at all.
   */
  function clearSoundButtons() {
    var blocked = document.querySelectorAll('.al__snd');
    for (var i = 0; i < blocked.length; i++) blocked[i].remove();
  }
  function unlock() {
    var a = audio();
    if (!a) return;
    // resume() is a promise, so the context is still 'suspended' for a tick after the
    // click that unlocked it. Clearing only synchronously left "Aktifkan suara" sitting
    // on a card whose sound was already working - which reads as a fault that is not one.
    if (a.state === 'suspended') {
      var resumed = a.resume();
      if (resumed && resumed.then) resumed.then(clearSoundButtons, function () {});
    }
    clearSoundButtons();
  }
  document.addEventListener('pointerdown', unlock, { once: false, passive: true });
  document.addEventListener('keydown', unlock, { once: false, passive: true });

  function blockedSound() {
    var a = audio();
    return !a || a.state !== 'running';
  }

  /** Two notes a fifth apart, twice - deliberately unlike a notification anybody ignores. */
  function chime() {
    var a = audio();
    if (!a || a.state !== 'running') return;
    var now = a.currentTime;
    var notes = [880, 1318.5, 880, 1318.5];
    for (var i = 0; i < notes.length; i++) {
      var at = now + i * 0.18;
      var osc = a.createOscillator();
      var gain = a.createGain();
      osc.type = 'triangle';
      osc.frequency.value = notes[i];
      // An envelope rather than a square start: a click at full volume reads as a fault.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain);
      gain.connect(a.destination);
      osc.start(at);
      osc.stop(at + 0.18);
    }
  }

  var alarms = [];
  // Three chimes and then quiet, at the operator's request: the card stays on screen, the
  // sound does not go on for a minute.
  var MAX_RINGS = 3;
  function startAlarm(el) {
    chime();
    var rings = 1;
    var timer = setInterval(function () {
      rings += 1;
      if (rings > MAX_RINGS || !el.isConnected) { stopAlarm(el); return; }
      chime();
    }, 8000);
    alarms.push({ el: el, timer: timer });
  }
  function stopAlarm(el) {
    for (var i = alarms.length - 1; i >= 0; i--) {
      if (alarms[i].el !== el) continue;
      clearInterval(alarms[i].timer);
      alarms.splice(i, 1);
    }
  }

  /*
   * The tab title, for the packer who is on another tab entirely.
   *
   * The popup and the chime both assume this window is the one in front. Often it is not -
   * the bench has a browser open on the label page and somebody is in Seller Centre. A
   * counted title is the one signal that survives that.
   */
  var plainTitle = document.title;
  function retitle() {
    var n = box.children.length;
    document.title = n > 0 ? '(' + n + ') PICKUP - ' + plainTitle : plainTitle;
  }

  function show(a) {
    // A deploy's own check travels this stream so that the stream is what gets checked.
    // It is proved on the wire, not on a screen, so it never becomes a popup.
    if (a.kind === 'smoke') { if (a.id > 0) remember(a.id); return; }
    // Oldest at the bottom: a burst reads top-down in the order it arrived, and the one
    // that just landed is where the eye already is.
    var el = card(a);
    box.insertBefore(el, box.firstChild);
    // Trimmed rather than stacked forever. Six is more than anyone reads at once.
    while (box.children.length > 6) {
      stopAlarm(box.lastChild);
      box.lastChild.remove();
    }
    if (a.id > 0) remember(a.id);
    startAlarm(el);
    retitle();
    // Deliberately not auto-dismissed. A parcel does not stop needing packing because
    // nobody was looking at the screen for eight seconds.
  }

  /*
   * The bell in the top bar, and why it is not the CLI command it replaces.
   *
   * Whether the popup appears is a question about this codebase. Whether anybody hears it
   * is a question about the machine on the packing bench - its speakers, its volume, and
   * whether the browser has been touched since the tab was opened - and only the person
   * standing at that bench can answer it. Asking them to open a terminal to find out was
   * never going to happen, and the command itself only works where the production store
   * is, which is not their laptop.
   *
   * So the test is entirely local to this page: it draws a card and rings, touching no
   * server and no store. It proves the one thing that was ever in doubt.
   */
  /*
   * The bell tests the pipe, not this page.
   *
   * Drawing a card locally would answer "do the speakers work" and nothing else. The
   * question an operator has is whether an alert *arrives*, and that spans the server,
   * the store, the event stream and nginx - none of which can be tested from inside the
   * page. So the press asks the server to raise a real alert, and what comes back comes
   * back the way a Shopee pickup would: down the same stream, into the same card.
   *
   * If nothing arrives, that is the answer. A local card drawn as a consolation would
   * hide exactly the failure the operator pressed the button to find.
   */
  var test = document.getElementById('alerttest');
  if (test) test.addEventListener('click', function () {
    unlock();
    test.disabled = true;
    var arrived = false;
    var before = box.children.length;

    var body = new URLSearchParams();
    body.set('csrf', test.getAttribute('data-csrf') || '');

    fetch('/api/alert-test', { method: 'POST', body: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); })
      .catch(function (e) { note('Gagal meminta uji: ' + e.message); })
      .then(function () {
        // Five seconds covers the stream's own poll, which is the slow path.
        setTimeout(function () {
          test.disabled = false;
          if (!arrived && box.children.length === before) {
            note('Uji terkirim tapi tidak ada alert yang kembali - jalur pemberitahuan bermasalah.');
          }
        }, 5000);
      });

    var watch = setInterval(function () {
      if (box.children.length > before) { arrived = true; clearInterval(watch); }
    }, 200);
    setTimeout(function () { clearInterval(watch); }, 6000);
  });

  function note(text) {
    show({ id: 0, tone: 'warn', title: text, data: { channelName: 'Uji', id: '-' } });
  }

  var src = new EventSource('/api/events?since=' + seen());
  src.addEventListener('alert', function (e) {
    try { show(JSON.parse(e.data)); } catch (err) {}
  });
})();` : ''}
</script>
${script ? `<script>
${script}
</script>` : ''}
</body></html>`;
}

/**
 * Orders view. `orders` is the filtered list for the range; `summary` is over the whole
 * range, so the cards and the chip counts keep describing the period while the table
 * shows one page of what the filters left. Filters and page live in the URL.
 *
 * @param {{filter?: {channel?: string, stage?: string, q?: string}, paging?: {page: number, perPage: number}, baseQuery?: string}} extra
 */
export function renderDashboard({
  orders, summary, errors, range, truncated = [], maxPerPlatform, shopeeShop, generatedAt,
  filter = {}, paging = { page: 1, perPage: DEFAULT_PER_PAGE }, baseQuery = '', user = null, flash = null, csrf = null }) {
  const { all, byChannel } = summary;
  const inTransit = all.stages.shipping;
  const channel = CHANNELS[filter.channel] || filter.channel === MANUAL_CHANNEL.id ? filter.channel : 'all';
  const stage = STAGES.includes(filter.stage) ? filter.stage : 'all';
  const q = String(filter.q ?? '').trim();

  // A chip is a link to the same view with one filter changed and the page reset.
  const link = (changes) => {
    const params = new URLSearchParams(baseQuery);
    for (const [k, v] of Object.entries(changes)) {
      if (v === 'all' || v === '') params.delete(k);
      else params.set(k, v);
    }
    return `?${params.toString()}`;
  };
  const chip = (label, on, href, accent = '') =>
    `<a class="chip ${on ? 'is-on' : ''}" href="${escape(href)}"${accent ? ` style="--chip:${accent}"` : ''}${on ? ' aria-current="true"' : ''}>${label}</a>`;

  const filters = [
    chip('Semua kanal', channel === 'all', link({ channel: 'all' })),
    ...Object.keys(CHANNELS).map((id) => chip(escape(CHANNELS[id].label), channel === id, link({ channel: id }), CHANNELS[id].accent)),
    // Typed-in sales get a chip but no card: there is nothing to pull or ship for them.
    chip(escape(MANUAL_CHANNEL.label), channel === MANUAL_CHANNEL.id, link({ channel: MANUAL_CHANNEL.id }), MANUAL_CHANNEL.accent),
  ].join('');

  // Stage counts follow the channel chip, so "Siap kirim 11" means eleven on Shopee when
  // Shopee is selected, not eleven across the shop.
  const stages = channel === 'all' ? all.stages : (byChannel[channel]?.stages ?? {});
  const stageChips = [
    chip('Semua status', stage === 'all', link({ stage: 'all' })),
    ...STAGES.filter((s) => stages[s] > 0).map(
      (s) => chip(`${escape(STAGE_META[s].label)} <b>${stages[s]}</b>`, stage === s, link({ stage: s })),
    ),
  ].join('');

  // Everything but the search box travels as hidden fields, so submitting keeps the
  // range and the chips and only changes the query.
  const searchHidden = [...new URLSearchParams(baseQuery)]
    .filter(([k]) => k !== 'q')
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join('');

  const paged = paginate(orders, paging);
  const noun = q || channel !== 'all' || stage !== 'all' ? 'pesanan cocok' : 'pesanan';

  return shell({ user, flash,
    csrf,
    title: 'Omnichannel Orders',
    range, errors, truncated, maxPerPlatform, shopeeShop, generatedAt,
    view: 'orders',
    kpis: `<section class="kpis" aria-label="Ringkasan">
    ${kpiCard({ iconName: 'wallet', label: 'Omzet', value: rupiah(all.revenue) })}
    ${kpiCard({ iconName: 'cube', label: 'Pesanan', value: String(all.count) })}
    ${kpiCard({ iconName: 'bell', label: 'Perlu tindakan', value: String(all.actionable), tone: all.actionable > 0 ? 'is-act' : '' })}
    ${kpiCard({ iconName: 'truck', label: 'Dalam pengiriman', value: String(inTransit) })}
  </section>`,
    body: `<section class="chs" aria-label="Per kanal">
    ${Object.keys(CHANNELS).map((id) => channelCard(id, byChannel[id])).join('')}
  </section>

  <section class="panel" aria-label="Daftar pesanan">
    <div class="filters">
      ${filters}
      <form class="searchform" method="get" role="search">
        ${searchHidden}
        <input class="search" id="q" name="q" type="search" value="${escape(q)}" aria-label="Cari pesanan berdasarkan order ID, pembeli atau nomor resi" placeholder="Cari order ID, pembeli, resi..." autocomplete="off">
        <button type="submit" aria-label="Cari">${svg('search')}</button>
        ${q ? `<a class="chip" href="${escape(link({ q: '' }))}">Hapus pencarian</a>` : ''}
      </form>
    </div>
    <div class="filters">
      ${stageChips}
      <button class="exbtn" type="button" id="ex-open" aria-haspopup="dialog">${svg('export')}Ekspor</button>
    </div>
    ${pager(paged, { baseQuery, noun }).replace('class="pager"', 'class="pager pager--top"')}
    <div class="scroll">
      ${paged.total ? `<table>
        <thead><tr>
          <th>Kanal</th><th>Order ID</th><th>Waktu</th><th>Pembeli</th>
          <th class="num">Total</th><th>Status</th><th>Kurir</th><th>Resi</th>
        </tr></thead>
        <tbody id="rows">${paged.items.map((o, i) => row(o, i)).join('')}</tbody>
      </table>` : '<p class="empty">Tidak ada pesanan yang cocok dengan filter.</p>'}
    </div>
    <div id="od-store" hidden>${paged.items.map((o, i) => orderDetail(o, i, { csrf, back: baseQuery })).join('')}</div>
    <dialog class="od" id="od">
      <button class="od__x" type="button" id="od-close" aria-label="Tutup">${svg('x')}</button>
      <div id="od-body"></div>
    </dialog>
    ${pager(paged, { baseQuery, noun })}
    <div class="foot">
      <span>${idNumber(all.count)} pesanan pada rentang ini</span>
      <span>Waktu mengikuti jam masing-masing platform</span>
    </div>
  </section>

  ${exportDialog(range)}`,
    style: ORDER_DETAIL_STYLE + EXPORT_STYLE,
    script: ORDER_DETAIL_SCRIPT + EXPORT_SCRIPT,
  });
}

/* --- the export sheet: what to take away, over which days, from which channels --- */

/**
 * The one place on this page that produces a file instead of a screen.
 *
 * Three decisions, in the order somebody makes them: what the rows should be, which days
 * to cover, and which channels count. Everything is a real radio or checkbox, so the
 * whole thing works without JavaScript and reads correctly to a screen reader; the script
 * only adds the conveniences - the quick date chips, the "all channels" toggle, and
 * keeping the page's loading skeleton out of the way of a download that never navigates.
 *
 * The dates are the range, always, rather than a preset with dates beside it that quietly
 * override each other. A chip sets the two inputs and that is all it does, so what the
 * form will send is on screen at every moment.
 */
function exportDialog(range) {
  const today = businessToday();
  const from = range?.from ?? today;
  const to = range?.to ?? today;

  const dataset = Object.values(DATASETS).map((spec, index) => `
    <label class="ex__pick">
      <input type="radio" name="dataset" value="${escape(spec.id)}"${spec.id === DEFAULT_DATASET ? ' checked autofocus' : ''}>
      <span class="ex__pickb">
        <span class="ex__pickt">${escape(spec.label)}</span>
        <span class="ex__pickh">${escape(spec.hint)}</span>
      </span>
    </label>`).join('');

  const channels = EXPORT_CHANNELS.map((meta) => `
    <label class="ex__ch" style="--chip:${meta.accent}">
      <input type="checkbox" name="channel" value="${escape(meta.id)}" checked data-ch>
      <span>${escape(meta.label)}</span>
    </label>`).join('');

  // Grouped the way the shelf is, because twenty-five checkboxes in catalogue order is a
  // list nobody reads. Every one starts ticked: the common export is all of them, and a
  // filter you have to switch on is a filter that gets forgotten.
  const byGroup = new Map();
  for (const product of EXPORT_PRODUCTS) {
    if (!byGroup.has(product.category)) byGroup.set(product.category, []);
    byGroup.get(product.category).push(product);
  }
  const products = [...byGroup.entries()].map(([group, items]) => `
    <div class="ex__grp">
      <span class="ex__grpt">${escape(PRODUCT_GROUPS[group] ?? group)}</span>
      <div class="ex__chs">${items.map((product) => `
        <label class="ex__ch ex__ch--p">
          <input type="checkbox" name="product" value="${escape(product.sku)}" checked data-pr>
          <span>${escape(product.name)}${product.variant ? ` <small>${escape(product.variant)}</small>` : ''}</span>
        </label>`).join('')}</div>
    </div>`).join('');

  const quick = [['Hari ini', 0], ['7 hari', 6], ['30 hari', 29], ['90 hari', 89]]
    .map(([label, back]) => `<button class="ex__q" type="button" data-back="${back}">${label}</button>`).join('');

  return `<dialog class="ex" id="export" aria-labelledby="ex-title">
  <form class="ex__box" method="get" action="/api/export" data-download>
    <button class="od__x" type="button" id="ex-x" aria-label="Tutup">${svg('x')}</button>
    <span class="ex__ico" aria-hidden="true">${svg('export')}</span>
    <h2 class="ex__title" id="ex-title">Ekspor data</h2>
    <p class="ex__text">Filter di halaman ini tidak ikut terbawa &mdash; pilih sendiri apa yang mau diambil.</p>

    <fieldset class="ex__set">
      <legend class="ex__leg">Isi filenya</legend>
      <div class="ex__picks">${dataset}</div>
    </fieldset>

    <fieldset class="ex__set">
      <legend class="ex__leg">Rentang tanggal</legend>
      <div class="ex__quick">${quick}</div>
      <div class="ex__dates">
        <label>Dari <input type="date" name="from" id="ex-from" value="${escape(from)}" max="${escape(today)}" required></label>
        <label>s/d <input type="date" name="to" id="ex-to" value="${escape(to)}" max="${escape(today)}" required></label>
      </div>
      <p class="ex__note">Maksimal 90 hari. Rentang yang lebih panjang dipotong dari tanggal akhir.</p>
    </fieldset>

    <fieldset class="ex__set">
      <legend class="ex__leg">Kanal</legend>
      <div class="ex__chs">${channels}</div>
      <label class="ex__all"><input type="checkbox" id="ex-all" checked><span>Semua kanal</span></label>
    </fieldset>

    <fieldset class="ex__set">
      <legend class="ex__leg">Produk</legend>
      <div class="ex__prs scroll">${products}</div>
      <label class="ex__all"><input type="checkbox" id="ex-allp" checked><span>Semua produk</span></label>
    </fieldset>

    <fieldset class="ex__set">
      <legend class="ex__leg">Format</legend>
      <div class="ex__seg">
        <label><input type="radio" name="format" value="xlsx" checked><span>XLSX<small>Excel, siap di-pivot</small></span></label>
        <label><input type="radio" name="format" value="csv"><span>CSV<small>Teks, untuk tool lain</small></span></label>
      </div>
    </fieldset>

    <div class="ex__row">
      <button class="pu__no" type="button" id="ex-no">Batal</button>
      <button class="pu__yes" type="submit">${svg('export')}Unduh</button>
    </div>
  </form>
</dialog>`;
}

const EXPORT_STYLE = `
.ex{width:min(38rem,calc(100vw - 2rem)); max-height:min(88vh,52rem); padding:0; border:1px solid var(--glass-line);
  border-radius:22px; background:color-mix(in srgb,var(--panel) 92%,transparent); color:var(--fg);
  backdrop-filter:blur(24px) saturate(1.4); -webkit-backdrop-filter:blur(24px) saturate(1.4);
  box-shadow:0 40px 90px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.07)}
.ex::backdrop{background:color-mix(in srgb,#0A0F0D 62%,transparent); backdrop-filter:blur(6px)}
.ex[open]{animation:pop 280ms var(--ease-out) both}
.ex[open]::backdrop{animation:veil 240ms var(--ease-out) both}
/* Without showModal there is no top layer and no backdrop, so it centres itself. */
.ex:not(:modal){position:fixed; inset:auto; top:50%; left:50%; transform:translate(-50%,-50%); z-index:70;
  box-shadow:0 40px 90px -30px rgba(0,0,0,.9), 0 0 0 100vmax color-mix(in srgb,#0A0F0D 62%,transparent)}
.ex__box{display:flex; flex-direction:column; gap:1rem; padding:1.6rem; max-height:min(88vh,52rem); overflow:auto; position:relative}
/* It is scrollable, so the browser makes it focusable; a ring around the whole sheet is
   noise, and the controls inside it have rings of their own. */
.ex__box:focus{outline:none}
.ex__ico{width:44px; height:44px; border-radius:50%; display:grid; place-items:center; flex:none;
  color:var(--cta-hi); background:color-mix(in srgb,var(--cta-a) 16%,transparent);
  border:1px solid color-mix(in srgb,var(--cta-a) 40%,transparent)}
.ex__ico .ico{width:20px; height:20px}
.ex__title{margin:0; font-size:1.2rem; font-weight:600; letter-spacing:-.02em}
.ex__text{margin:-.5rem 0 0; font-size:.85rem; line-height:1.55; color:var(--muted)}
.ex__set{margin:0; padding:0; border:0; display:flex; flex-direction:column; gap:.55rem}
.ex__leg{padding:0; font-size:.68rem; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:var(--dim)}
.ex__picks{display:flex; flex-direction:column; gap:.4rem}
.ex__pick{display:block; cursor:pointer}
.ex__pick input{position:absolute; opacity:0; width:0; height:0}
.ex__pickb{display:block; padding:.7rem .9rem; border-radius:14px; border:1px solid var(--glass-line);
  background:var(--glass); transition:border-color var(--t-fast), background var(--t-fast)}
.ex__pick:hover .ex__pickb{background:var(--glass-2)}
.ex__pick input:checked + .ex__pickb{border-color:color-mix(in srgb,var(--cta-a) 65%,transparent);
  background:color-mix(in srgb,var(--cta-a) 13%,transparent)}
.ex__pick input:focus-visible + .ex__pickb{outline:2px solid var(--brand); outline-offset:2px}
.ex__pickt{display:block; font-size:.9rem; font-weight:600}
.ex__pickh{display:block; margin-top:.15rem; font-size:.76rem; line-height:1.45; color:var(--muted)}
.ex__quick{display:flex; flex-wrap:wrap; gap:.4rem}
.ex__q{font:inherit; font-size:.78rem; padding:.42rem .85rem; min-height:36px; border-radius:999px; cursor:pointer;
  border:1px solid var(--glass-line); background:var(--glass); color:var(--muted); transition:background var(--t-fast), color var(--t-fast)}
.ex__q:hover{background:var(--glass-2); color:var(--fg)}
.ex__q:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.ex__dates{display:flex; flex-wrap:wrap; gap:.5rem}
.ex__dates label{flex:1 1 11rem; display:flex; align-items:center; gap:.5rem; font-size:.8rem; color:var(--muted);
  padding:.35rem .5rem .35rem .85rem; border-radius:14px; border:1px solid var(--glass-line); background:var(--glass)}
.ex__dates input{flex:1; min-width:0; min-height:38px; font:inherit; font-size:.84rem; color:var(--fg);
  background:transparent; border:0; color-scheme:dark}
.ex__dates input:focus-visible{outline:2px solid var(--brand); outline-offset:2px; border-radius:8px}
.ex__note{margin:0; font-size:.72rem; color:var(--dim)}
.ex__chs{display:flex; flex-wrap:wrap; gap:.4rem}
.ex__ch{display:inline-flex; align-items:center; gap:.45rem; padding:.42rem .85rem; min-height:38px; cursor:pointer;
  border-radius:999px; border:1px solid var(--glass-line); background:var(--glass); font-size:.8rem; color:var(--muted);
  transition:border-color var(--t-fast), background var(--t-fast), color var(--t-fast)}
.ex__ch input{position:absolute; opacity:0; width:0; height:0}
.ex__ch::before{content:''; width:9px; height:9px; border-radius:50%; background:var(--glass-line); flex:none; transition:background var(--t-fast)}
.ex__ch:has(input:checked){color:var(--fg); border-color:color-mix(in srgb,var(--chip,var(--brand)) 55%,transparent);
  background:color-mix(in srgb,var(--chip,var(--brand)) 14%,transparent)}
.ex__ch:has(input:checked)::before{background:var(--chip,var(--brand))}
.ex__ch:has(input:focus-visible){outline:2px solid var(--brand); outline-offset:2px}
.ex__prs{display:flex; flex-direction:column; gap:.6rem; max-height:13rem; overflow:auto;
  padding:.7rem .8rem; border-radius:14px; border:1px solid var(--glass-line); background:var(--glass)}
.ex__grp{display:flex; flex-direction:column; gap:.35rem}
.ex__grpt{font-size:.64rem; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:var(--dim)}
.ex__ch--p{background:var(--panel-2)}
.ex__ch--p:has(input:checked){border-color:color-mix(in srgb,var(--brand) 50%,transparent);
  background:color-mix(in srgb,var(--brand) 12%,transparent)}
.ex__ch--p:has(input:checked)::before{background:var(--brand)}
.ex__ch--p small{font-size:.72rem; font-weight:400; color:var(--muted); margin-left:.2rem}
.ex__all{display:inline-flex; align-items:center; gap:.5rem; font-size:.78rem; color:var(--muted); cursor:pointer}
.ex__all input{width:17px; height:17px; accent-color:var(--cta-a); cursor:pointer}
.ex__seg{display:flex; gap:.4rem}
.ex__seg label{flex:1; cursor:pointer}
.ex__seg input{position:absolute; opacity:0; width:0; height:0}
.ex__seg span{display:block; padding:.6rem .8rem; border-radius:14px; text-align:center; font-size:.86rem; font-weight:600;
  border:1px solid var(--glass-line); background:var(--glass); transition:border-color var(--t-fast), background var(--t-fast)}
.ex__seg small{display:block; margin-top:.1rem; font-size:.7rem; font-weight:400; color:var(--muted)}
.ex__seg label:hover span{background:var(--glass-2)}
.ex__seg input:checked + span{border-color:color-mix(in srgb,var(--cta-a) 65%,transparent);
  background:color-mix(in srgb,var(--cta-a) 13%,transparent)}
.ex__seg input:focus-visible + span{outline:2px solid var(--brand); outline-offset:2px}
/* The sheet got tall once the catalogue joined it, so the two buttons stay where the
   thumb is instead of at the bottom of a scroll. */
.ex__row{display:flex; gap:.6rem; position:sticky; bottom:0; z-index:2;
  margin:.2rem -1.6rem -1.6rem; padding:.9rem 1.6rem 1.6rem;
  /* Opaque, and blended with the page rather than with black, so it holds in both themes.
     A translucent bar let the product list read straight through the buttons. */
  background:color-mix(in srgb,var(--panel) 92%,var(--bg))}
.ex__row::before{content:''; position:absolute; left:0; right:0; bottom:100%; height:20px; pointer-events:none;
  background:linear-gradient(to top, color-mix(in srgb,var(--panel) 92%,var(--bg)), transparent)}
.ex__row .pu__yes{display:inline-flex; align-items:center; justify-content:center; gap:.45rem}
.ex__row .pu__yes .ico{width:16px; height:16px}
/* The button that opens it, parked in the space to the right of the status chips. */
.exbtn{margin-left:auto; display:inline-flex; align-items:center; gap:.45rem; font:inherit; font-size:.8rem; font-weight:600;
  padding:.45rem 1rem; min-height:38px; border-radius:999px; cursor:pointer; color:var(--fg);
  border:1px solid color-mix(in srgb,var(--cta-a) 45%,transparent);
  background:color-mix(in srgb,var(--cta-a) 12%,transparent);
  transition:background var(--t-fast), border-color var(--t-fast), transform var(--t-fast) var(--ease-out)}
.exbtn:hover{background:color-mix(in srgb,var(--cta-a) 20%,transparent); transform:translateY(-1px)}
.exbtn:active{transform:none}
.exbtn:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.exbtn .ico{width:16px; height:16px; color:var(--cta-hi)}
@media (max-width:640px){ .ex__box{padding:1.1rem} .exbtn{margin-left:0}
  .ex__row{margin:.2rem -1.1rem -1.1rem; padding:.9rem 1.1rem 1.1rem} }
`;

const EXPORT_SCRIPT = `
(function () {
  var dialog = document.getElementById('export');
  var open = document.getElementById('ex-open');
  if (!dialog || !open) return;
  var form = dialog.querySelector('form');

  function show() { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
  function hide() { if (dialog.close) dialog.close(); else dialog.removeAttribute('open'); }
  open.addEventListener('click', show);
  document.getElementById('ex-no').addEventListener('click', hide);
  document.getElementById('ex-x').addEventListener('click', hide);

  // The chips only move the two date inputs. Nothing is hidden from the operator: what
  // the form will send is exactly what the fields show.
  var from = document.getElementById('ex-from');
  var to = document.getElementById('ex-to');
  var day = 86400000;
  form.querySelectorAll('[data-back]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var end = new Date();
      var start = new Date(end.getTime() - Number(chip.dataset.back) * day);
      to.value = end.toISOString().slice(0, 10);
      from.value = start.toISOString().slice(0, 10);
    });
  });

  // One master switch per group of tickboxes. The last one on cannot be turned off:
  // every channel or every product unticked is an empty file, which is never the ask.
  function couple(masterId, selector) {
    var all = document.getElementById(masterId);
    var boxes = Array.prototype.slice.call(form.querySelectorAll(selector));
    if (!all || boxes.length === 0) return;
    all.addEventListener('change', function () {
      boxes.forEach(function (box) { box.checked = all.checked; });
    });
    boxes.forEach(function (box) {
      box.addEventListener('change', function () {
        if (boxes.every(function (b) { return !b.checked; })) box.checked = true;
        all.checked = boxes.every(function (b) { return b.checked; });
      });
    });
  }
  couple('ex-all', '[data-ch]');
  couple('ex-allp', '[data-pr]');

  // The response is a file, so the page never navigates and the skeleton armed on submit
  // would sit over the dashboard forever. It closes instead, which is what "done" looks
  // like here.
  form.addEventListener('submit', function () { window.setTimeout(hide, 120); });
})();
`;

/* --- how long is left, said the way somebody standing at a bench would say it --- */

/**
 * "4 jam 12 mnt", "besok", "lewat 20 mnt".
 *
 * Coarse on purpose past a few hours: a deadline five days out does not want its minutes
 * counted, and a bench reading "2 hari" acts on it exactly as it would on "2 hari 3 jam".
 * Under an hour it goes to the minute, because that is when the number starts deciding
 * what gets packed next. The same function runs on the server and in the browser, so the
 * first paint and every tick after it say the same thing.
 */
export function untilText(deadline, now = Math.floor(Date.now() / 1000)) {
  const left = Math.floor(Number(deadline) || 0) - now;
  const say = (n, unit) => `${n} ${unit}`;
  const shape = (secs) => {
    const mins = Math.floor(secs / 60);
    if (mins < 60) return say(Math.max(mins, 0), 'mnt');
    const hours = Math.floor(mins / 60);
    if (hours < 24) {
      const rest = mins % 60;
      return rest ? `${say(hours, 'jam')} ${say(rest, 'mnt')}` : say(hours, 'jam');
    }
    return say(Math.floor(hours / 24), 'hari');
  };
  if (left <= 0) return `lewat ${shape(-left)}`;
  return `${shape(left)} lagi`;
}

/** How loudly to say it. Past, within the hour, within the day, or plenty. */
export function untilTone(deadline, now = Math.floor(Date.now() / 1000)) {
  const left = Math.floor(Number(deadline) || 0) - now;
  if (left <= 0) return 'over';
  if (left <= 3600) return 'now';
  if (left <= 6 * 3600) return 'soon';
  return 'calm';
}

/* --- the order popup: a row opens what the page already knows about that order --- */

const ORDER_DETAIL_STYLE = `
tbody#rows .row{cursor:pointer; transition:background var(--t-fast)}
tbody#rows .row:hover{background:var(--panel-2)}
tbody#rows .row:focus-visible{outline:2px solid var(--brand); outline-offset:-2px}
.od{width:min(34rem,calc(100vw - 2rem)); max-height:min(85vh,48rem); padding:0; border:1px solid var(--glass-line);
  border-radius:22px; background:color-mix(in srgb,var(--panel) 90%,transparent); color:var(--fg);
  backdrop-filter:blur(24px) saturate(1.4); -webkit-backdrop-filter:blur(24px) saturate(1.4);
  box-shadow:0 40px 90px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.07); overflow:visible}
.od::backdrop{background:color-mix(in srgb,#0A0F0D 62%,transparent); backdrop-filter:blur(6px)}
.od[open]{animation:pop 280ms var(--ease-out) both}
.od[open]::backdrop{animation:veil 240ms var(--ease-out) both}
.od>div{padding:1.5rem; overflow:auto; max-height:min(85vh,48rem); border-radius:inherit}
.od__x{position:absolute; top:.75rem; right:.75rem; width:36px; height:36px; border-radius:50%; cursor:pointer;
  border:1px solid var(--glass-line); background:var(--glass); color:var(--muted); display:grid; place-items:center}
.od__x:hover{color:var(--fg); border-color:var(--brand)}
.od__x:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.od__x .ico{width:16px; height:16px}
.od__head{display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; padding-right:2.4rem}
.od__when{font-size:.78rem; color:var(--dim)}
.od__id{margin:.5rem 0 1rem; font-size:1.05rem; font-weight:600; overflow-wrap:anywhere}
.od__grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(11rem,1fr)); gap:.7rem 1rem; margin:0 0 1rem}
.od__grid--wide{grid-template-columns:1fr}
.od__f dt{font-size:.7rem; letter-spacing:.05em; text-transform:uppercase; color:var(--muted)}
.od__f dd{margin:.1rem 0 0; font-size:.88rem; overflow-wrap:anywhere}
.od__items{width:100%; font-size:.84rem; margin:0 0 1rem}
.od__items th{position:static; background:none; border-bottom:1px solid var(--line); padding:.35rem .5rem}
.od__items td{padding:.5rem; border-top:1px solid var(--line); vertical-align:top}
.od__n{display:block; line-height:1.35}
.od__v{display:block; font-size:.76rem; color:var(--muted)}
.od__s{display:block; font-size:.72rem; color:var(--dim)}
.od__sum{display:flex; gap:1.5rem; flex-wrap:wrap; margin:0; padding-top:.9rem; border-top:1px solid var(--line)}
.od__sum dt{font-size:.7rem; letter-spacing:.05em; text-transform:uppercase; color:var(--muted)}
.od__sum dd{margin:.1rem 0 0; font-size:.95rem; font-weight:600}
.od__print{display:flex; align-items:center; justify-content:center; gap:.5rem; margin-top:1.1rem;
  padding:.7rem 1rem; min-height:46px; border-radius:999px; font-size:.9rem; font-weight:600;
  color:#fff; text-decoration:none; border:1px solid transparent;
  background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent);
  transition:filter var(--t-base) var(--ease-out)}
.od__print:hover{filter:brightness(1.08)}
.od__print:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.od__print .ico{width:18px; height:18px}
.od__sync{margin:1.1rem 0 0; display:flex; flex-wrap:wrap; align-items:center; gap:.5rem .75rem}
.od__sync__b{font:inherit; font-size:.85rem; font-weight:500; display:inline-flex; align-items:center; gap:.45rem;
  padding:.5rem .9rem; min-height:38px; border-radius:9px; cursor:pointer;
  color:var(--fg); background:var(--panel-2); border:1px solid var(--line);
  transition:border-color var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out)}
.od__sync__b:hover{border-color:var(--brand); color:var(--brand)}
.od__sync--bad .od__sync__b:hover{border-color:var(--bad); color:var(--bad)}
.od__sync--bad a.od__sync__b:hover{border-color:var(--brand); color:var(--brand)}
a.od__sync__b{text-decoration:none}
.od__edited{display:flex; align-items:center; gap:.45rem; margin:.1rem 0 .9rem;
  font-size:.82rem; color:var(--warn)}
.od__edited .ico{width:15px; height:15px; flex:none}
/* Which order this one is putting right. Without it a resend is a free parcel with no
   reason on it, and the reason is the only thing that explains the zero. */
.od__ref{display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; margin:.1rem 0 .3rem;
  font-size:.84rem}
.od__ref__l{color:var(--muted)}
.od__ref__a{color:var(--brand); font-weight:600; text-decoration:none; border-bottom:1px dashed currentColor}
.od__ref__a:hover{border-bottom-style:solid}
.od__ref__v{margin-left:auto; font-size:.78rem; color:var(--warn)}
.od__wrong{list-style:none; margin:0 0 .9rem; padding:.45rem .7rem; border-radius:9px;
  background:color-mix(in srgb,var(--warn) 9%,transparent); border:1px solid color-mix(in srgb,var(--warn) 22%,transparent);
  font-size:.8rem; display:grid; gap:.2rem}
.od__wrong li{display:flex; gap:.6rem}
.od__wrong li b{margin-left:auto}
.od__sync__b[disabled]{opacity:.6; cursor:default}
.od__sync__b .ico{width:16px; height:16px}
.od__sync__n{font-size:.78rem; color:var(--dim); flex:1 1 14rem; min-width:0}
.od__total{margin-left:auto; text-align:right}
.od__total dd{font-size:1.15rem}
@media (max-width:640px){ .od{width:calc(100vw - 1rem)} .od>div{padding:1.1rem} }
`;

const ORDER_DETAIL_SCRIPT = `
(function () {
  var dialog = document.getElementById('od');
  var body = document.getElementById('od-body');
  var store = document.getElementById('od-store');
  if (!dialog || !body || !store) return;

  function open(row) {
    var source = store.querySelector('#' + row.dataset.detail);
    if (!source) return;
    body.innerHTML = source.innerHTML;
    // showModal gives focus trapping and Escape for free; a div could do neither.
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  }

  document.querySelectorAll('tbody#rows .row').forEach(function (row) {
    row.addEventListener('click', function () { open(row); });
    row.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open(row);
    });
  });

  // One press is one intention. The read takes a second or two and the dialog stays open
  // over it, which without this reads as nothing having happened.
  body.addEventListener('submit', function (e) {
    var button = e.target.querySelector('.od__sync__b');
    if (!button) return;
    window.setTimeout(function () {
      button.disabled = true;
      button.querySelector('span').textContent = 'Mengambil\u2026';
    }, 0);
  });

  document.getElementById('od-close').addEventListener('click', function () { dialog.close(); });
  // Clicking the backdrop lands on the dialog itself, never on its contents.
  dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
})();
`;




const rangeQuery = (range) =>
  range.preset ? `&preset=${range.preset}` : `&from=${range.from}&to=${range.to}`;


/**
 * The fulfillment queue: what still needs a human, and the one move that advances it.
 *
 * Each channel stalls at a different point, so grouping by the action rather than by
 * channel is what makes the page a worklist instead of a report. Actions run one at a
 * time on purpose - shipping cannot be undone from here.
 */
/**
 * The question an instant courier forces: when should the driver come?
 *
 * Shopee dispatches a rider for GrabExpress and GoSend, and it will not accept the
 * order until it is told which slot. It offers them itself - "Now", or an hour-wide
 * window - minted per order and expiring, so this is asked at the moment of arranging
 * and answered in one place for the whole batch. One control sets every row, because
 * the usual answer is the same for all of them; each row can still differ, because the
 * one parcel that is not packed yet is exactly the one this exists for.
 *
 * Nothing is arranged until this is answered: the form carries the whole selection, so
 * the drop-off parcels in the same batch go out on the same press.
 */
function pickupDialog(pickup, csrf) {
  if (!pickup?.waiting?.length) return '';

  const slotTexts = [...new Set(pickup.waiting.flatMap(({ plan }) => (plan.slots ?? []).map((s) => s.text)))];
  const address = pickup.waiting.map(({ plan }) => plan.address).find(Boolean) ?? '';

  const rows = pickup.waiting.map(({ order, plan }) => {
    const chosen = pickup.chosen?.[order.id] ?? defaultSlot(plan)?.id ?? '';
    const options = (plan.slots ?? []).map((slot) =>
      `<option value="${escape(slot.id)}" data-text="${escape(slot.text)}"${slot.id === chosen ? ' selected' : ''}>${
        escape(slot.text)}${slot.recommended ? ' &middot; disarankan' : ''}</option>`).join('');
    return `<tr>
      <td><span class="mono nowrap">${escape(order.id)}</span><span class="pick__s">${escape(order.buyer) || '&mdash;'}</span></td>
      <td class="nowrap">${escape(order.carrier) || '&mdash;'}</td>
      <td><select class="pu__slot" name="slot:${escape(order.id)}" data-slot required
                  aria-label="Waktu jemput ${escape(order.id)}">${options}</select></td>
    </tr>`;
  }).join('');

  const others = pickup.total - pickup.waiting.length;
  return `<dialog class="pu" id="pickup" open aria-labelledby="pu-title">
  <form class="pu__box" method="post" action="/api/dashboard">
    <input type="hidden" name="csrf" value="${escape(csrf)}">
    <input type="hidden" name="view" value="process">
    <input type="hidden" name="action" value="mass_arrange">
    ${pickup.selection.map((value) => `<input type="hidden" name="order" value="${escape(value)}">`).join('')}
    <span class="pu__ico" aria-hidden="true">${svg('truck')}</span>
    <h2 class="pu__title" id="pu-title">Kapan kurir menjemput?</h2>
    <p class="pu__text">${pickup.waiting.length} pesanan pakai kurir instan, jadi Shopee mengirim driver dan menahan pesanannya sampai waktu jemput dipilih.${
      others > 0 ? ` ${others} pesanan lain tinggal diantar ke agen dan ikut diatur sekaligus.` : ''}</p>
    ${address ? `<p class="pu__at">${svg('truck')}<span>Dijemput di ${escape(address)}</span></p>` : ''}
    ${slotTexts.length > 1 ? `<label class="pu__all">
      <span>Terapkan ke semua</span>
      <select class="pu__slot" id="pu-all" aria-label="Waktu jemput untuk semua pesanan">
        <option value="">Pilih satu per satu</option>
        ${slotTexts.map((text) => `<option value="${escape(text)}">${escape(text)}</option>`).join('')}
      </select>
    </label>` : ''}
    <div class="pu__list scroll"><table class="dense">
      <thead><tr><th>Pesanan</th><th>Kurir</th><th>Waktu jemput</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="pu__row">
      <a class="pu__no" href="?view=process">Batal</a>
      <button class="pu__yes" type="submit">Atur pengiriman ${pickup.total} pesanan</button>
    </div>
  </form>
</dialog>`;
}

export function renderProcess({ orders, range, errors, shopeeShop, generatedAt, csrf, flash, arranged = {}, user = null, pickup = null, readAt = null, settleFailed = false }) {
  const rows = pending(orders, arranged);
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;

  const carriers = new Map();
  for (const { order } of rows) {
    const name = order.carrier || 'Belum ditentukan';
    carriers.set(name, (carriers.get(name) ?? 0) + 1);
  }
  const carrierChips = [...carriers.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `<button class="chip" type="button" data-carrier="${escape(name)}"
      >${escape(name)} <b>${n}</b></button>`)
    .join('');

  // Waiting on the courier, not on us. Shown as a count so the page is not mistaken for
  // the whole picture, but never as a task.
  const waiting = orders.filter((o) => o.stage === 'to_ship' && !nextAction(o, arranged)).length;
  const moving = orders.filter((o) => o.stage === 'shipping').length;

  // A worklist, not a report. Raw platform statuses are dropped: AWAITING_SHIPMENT means
  // nothing to the person packing, and every row here needs the same single move anyway.
  // One form around everything, so the whole day's shipments go out on one click. Both
  // marketplace paths are handled server-side from the same selection - the operator
  // should not have to know that Shopee and TikTok batch differently.
  const cutoff = dispatchCutoff(Math.floor(generatedAt / 1000));
  const early = rows.filter(({ order }) => order.createdAt < cutoff).length;

  /**
   * How long is left, on the platform's own clock.
   *
   * Rendered with a real value so the page is correct before any script runs, and carried
   * as an epoch so the browser can keep counting without asking the server again. The
   * server's answer is only ever right for the instant it was sent; a queue left open on
   * a screen at the packing bench is looked at for hours.
   *
   * Shopify has no marketplace behind it and no deadline to miss, so it gets nothing
   * rather than a blank where a number should be.
   */
  const deadline = (o) => {
    const at = Number(o.shipBy) || 0;
    if (!at) return '';
    const label = o.channel === 'shopee' || o.stage !== 'to_ship' || o.status !== 'AWAITING_SHIPMENT'
      ? 'Batas kirim' : 'Batas atur';
    return `<span class="sla" data-deadline="${at}" data-tone="${untilTone(at)}" title="${escape(label)}: ${escape(dateTime(at, o.channel))}">
      ${svg('clock')}<span class="sla__t">${escape(untilText(at))}</span>
      <span class="sla__at">${escape(label.toLowerCase())} ${escape(dateTime(at, o.channel))}</span>
    </span>`;
  };

  /**
   * One row per parcel, newest first.
   *
   * Cards grouped by channel read well with five orders and stop working at fifty: the
   * same six facts land in a different place on every card, the eye has to re-find them
   * each time, and three headings push the oldest work off the screen. A table puts each
   * fact in a column, so scanning forty rows for the one that is nearly late is one
   * downward glance rather than forty separate reads.
   *
   * The channel moves into a column rather than a heading. It still matters - it decides
   * which stack the label prints on - but it is not what the bench sorts by. Time is.
   *
   * `wo` and `wo__pick` are kept as the class names because the selection, the courier
   * filters and the cut-off filter all find their row with closest('.wo'), and a row is
   * as good a thing to find as a card.
   */
  const row = ({ order: o }) => `<tr class="wo" data-carrier="${escape(o.carrier || 'Belum ditentukan')}"
      data-early="${o.createdAt < cutoff ? '1' : '0'}">
      <td class="wtab__pick">
        <input class="wo__pick" type="checkbox" name="order" value="${escape(o.channel)}:${escape(o.id)}" checked
          aria-label="Pilih ${escape(o.id)}">
      </td>
      <td>${channelTag(o)}</td>
      <td class="mono nowrap">${escape(o.id)}</td>
      <td class="wtab__who">${escape(o.buyer) || '<span class="dim">tanpa nama</span>'}</td>
      <td class="dim nowrap">${escape(dateTime(o.createdAt, o.channel))}</td>
      <td class="num mono nowrap">${escape(rupiah(o.total))}</td>
      <td class="nowrap">${o.carrier
        ? `<span class="wtab__car">${svg('truck')}${escape(o.carrier)}</span>`
        // Shopify books its courier outside Shopify, so an empty one there is the normal
        // case rather than something missing.
        : (o.channel === 'shopify' ? '<span class="dim">&mdash;</span>' : '<span class="dim">belum ditentukan</span>')}</td>
      <td class="wtab__sla">${deadline(o) || '<span class="dim">&mdash;</span>'}</td>
    </tr>`;

  // Newest first, which is the order `pending` already returns them in. Every channel
  // stamps in UTC+8 now, so comparing the epochs across them means what it looks like.
  const table = `<div class="scroll wtab__wrap">
    <table class="wtab">
      <thead><tr>
        <th class="wtab__pick"><span class="vh">Pilih</span></th>
        <th>Kanal</th><th>Pesanan</th><th>Pembeli</th><th>Waktu</th>
        <th class="num">Total</th><th>Kurir</th><th>Batas kirim</th>
      </tr></thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table>
  </div>`;

  return shell({ user,
    csrf,
    title: 'Proses Pesanan',
    range, errors, shopeeShop, generatedAt,
    view: 'process',
    // A worklist, not a report: it shows everything still waiting, so a date filter here
    // would only hide work. See loadOutstanding.
    hideRangeControls: true, scope: 'semua yang belum diatur',
    readAt, settleFailed,
    flash,
    kpis: `<div class="strip">
      ${stat('Perlu diatur', String(rows.length), rows.length > 0 ? 'flag' : 'ok')}
      ${stat('Menunggu kurir', String(waiting))}
      ${stat('Dalam pengiriman', String(moving))}
    </div>`,
    script: `
(function () {
  // The deadline, kept honest while the page is open.
  //
  // The chips are rendered with a real value, so the page is right before this runs and
  // right without it. What this adds is that it stays right: a queue is left open on a
  // screen at the bench for hours, and a number that was true when the page loaded is a
  // number that quietly lies for the rest of the shift.
  //
  // Nothing here invents a deadline. It only re-reads the epoch each chip already
  // carries, which came from the platform's own SLA field. An order without one has no
  // chip at all rather than a guess.
  var chips = Array.prototype.slice.call(document.querySelectorAll('.sla[data-deadline]'));
  if (chips.length > 0) {
    var said = ${untilText.toString()};
    var toned = ${untilTone.toString()};
    var tick = function () {
      var now = Math.floor(Date.now() / 1000);
      chips.forEach(function (chip) {
        var at = Number(chip.getAttribute('data-deadline')) || 0;
        if (!at) return;
        var text = chip.querySelector('.sla__t');
        var next = said(at, now);
        if (text && text.textContent !== next) text.textContent = next;
        var tone = toned(at, now);
        if (chip.getAttribute('data-tone') !== tone) chip.setAttribute('data-tone', tone);
      });
    };
    tick();
    // Every fifteen seconds is enough for a display whose smallest unit is a minute, and
    // cheap enough to leave running all day.
    var timer = window.setInterval(tick, 15000);
    // A laptop lid closed over lunch suspends the timer; the numbers are hours stale when
    // it opens, and the first thing anybody does is look at them.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    window.addEventListener('pageshow', tick);
    window.addEventListener('beforeunload', function () { window.clearInterval(timer); });
  }

  // The pickup step, when Shopee asked for one. Rendered open so it still works with no
  // JavaScript; upgraded to a real modal here for the backdrop, Escape and focus trap.
  var pu = document.getElementById('pickup');
  if (pu) {
    if (pu.showModal) { pu.close(); pu.showModal(); }
    var all = document.getElementById('pu-all');
    var slots = Array.prototype.slice.call(pu.querySelectorAll('select[data-slot]'));
    if (all) {
      all.addEventListener('change', function () {
        if (!all.value) return;
        slots.forEach(function (slot) {
          Array.prototype.forEach.call(slot.options, function (option) {
            if (option.dataset.text === all.value) slot.value = option.value;
          });
        });
      });
    }
  }

  var form = document.getElementById('massform');
  if (!form) return;
  var picks = Array.prototype.slice.call(form.querySelectorAll('.wo__pick'));
  var counter = document.getElementById('n');
  var go = document.getElementById('go');

  var toggle = document.getElementById('pickall');

  function sync() {
    var n = picks.filter(function (p) { return p.checked; }).length;
    counter.textContent = n;
    // Nothing selected means nothing to do; a live button would only produce an error.
    go.disabled = n === 0;
    form.dataset.confirm = 'Atur pengiriman untuk ' + n + ' pesanan sekaligus?';
    // One control, and it says what pressing it will do rather than what is true now.
    var allOn = n > 0 && n === picks.length;
    toggle.textContent = allOn ? 'Kosongkan semua' : 'Pilih semua';
    toggle.setAttribute('aria-pressed', allOn ? 'true' : 'false');
  }
  function setAll(v) {
    // Only what the filter left. Ticking the dimmed rows too would send the whole day out
    // when the operator meant one counter's worth - and picking several couriers at once
    // makes that mistake easier to make, not harder.
    picks.forEach(function (p) {
      if (v && !wanted(p.closest('.wo'))) return;
      p.checked = v;
    });
    sync();
  }

  picks.forEach(function (p) { p.addEventListener('change', sync); });

  // The whole row picks, not just the seventeen pixels of the tickbox. A row is one
  // parcel, so anywhere on it is the same instruction - except the deadline chip, which
  // carries a title worth reading without changing what is selected.
  Array.prototype.forEach.call(form.querySelectorAll('tr.wo'), function (tr) {
    tr.addEventListener('click', function (e) {
      if (e.target.closest('input, a, button, .sla')) return;
      var pick = tr.querySelector('.wo__pick');
      if (!pick) return;
      pick.checked = !pick.checked;
      sync();
    });
  });
  toggle.addEventListener('click', function () {
    setAll(toggle.getAttribute('aria-pressed') !== 'true');
  });

  /*
   * Selecting rather than hiding: a dropoff run covers some couriers but not others, and
   * the rest of the day's orders stay visible so nothing is forgotten.
   *
   * Several couriers at once, because a run is rarely one of them - JNE and J&T go to the
   * same counter. Each chip toggles its own courier in or out of the set, "Semua kurir"
   * empties the set, and an empty set means no courier filter at all rather than none
   * selected.
   *
   * The cut-off chip is a different axis and narrows whatever the couriers left: "JNE and
   * J&T that made today's cut-off" is a real errand, and it is the only reading of two
   * filters at once that is of any use.
   */
  var courierChips = Array.prototype.slice.call(form.querySelectorAll('.wl__bar button[data-carrier]'));
  var earlyChip = form.querySelector('.wl__bar button[data-early]');
  var chosen = [];
  var onlyEarly = false;

  function wanted(card) {
    if (onlyEarly && card.dataset.early !== '1') return false;
    if (chosen.length === 0) return true;
    return chosen.indexOf(card.dataset.carrier) !== -1;
  }

  function paint() {
    var filtering = chosen.length > 0 || onlyEarly;
    picks.forEach(function (p) {
      var card = p.closest('.wo');
      var hit = wanted(card);
      p.checked = hit;
      card.classList.toggle('wo--dim', filtering && !hit);
    });

    courierChips.forEach(function (c) {
      var name = c.dataset.carrier;
      // The "all" chip reads as on precisely when nothing narrows the couriers, which is
      // what it means rather than what it does.
      var on = name === '' ? chosen.length === 0 : chosen.indexOf(name) !== -1;
      c.classList.toggle('is-on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (earlyChip) {
      earlyChip.classList.toggle('is-on', onlyEarly);
      earlyChip.setAttribute('aria-pressed', onlyEarly ? 'true' : 'false');
    }
    sync();
  }

  courierChips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var name = chip.dataset.carrier;
      if (name === '') {
        chosen = [];
      } else {
        var at = chosen.indexOf(name);
        if (at === -1) chosen.push(name); else chosen.splice(at, 1);
      }
      paint();
    });
  });
  if (earlyChip) earlyChip.addEventListener('click', function () { onlyEarly = !onlyEarly; paint(); });

  paint();
})();\n`,
    body: pickupDialog(pickup, csrf) + (rows.length === 0
      ? `<p class="empty">Semua pesanan sudah diatur pengirimannya.${
          waiting > 0 ? ` ${waiting} menunggu dijemput kurir.` : ''}</p>`
      : `<form method="post" id="massform" data-confirm="Atur pengiriman untuk {n} pesanan sekaligus?">
          ${hidden}
          <input type="hidden" name="action" value="mass_arrange">
          <div class="wl__bar">
            <button class="chip is-on" type="button" data-carrier="">Semua kurir <b>${rows.length}</b></button>
            ${carrierChips}
            ${early > 0 && early < rows.length
              ? `<span class="wl__sep" aria-hidden="true"></span>
                 <button class="chip" type="button" data-early>Masuk sebelum ${DISPATCH_HOUR_WITA}.00 WITA <b>${early}</b></button>`
              : ''}
            <span class="strip__grow"></span>
            <button class="chip" type="button" id="pickall" aria-pressed="true">Kosongkan semua</button>
          </div>
          ${table}
          <div class="wl__go">
            <button class="wo__go" type="submit" id="go">Atur pengiriman <span id="n">${rows.length}</span> pesanan</button>
          </div>
        </form>`),
  });
}

/**
 * Every instant pickup that has come in, newest first.
 *
 * The bell used to ring one on purpose to prove the chime worked. That answered a
 * question nobody had twice a day, and left the one they did have unanswered: which
 * instant orders came in, and when. An instant courier means a driver was dispatched, so
 * this is also the list of every time somebody had to drop what they were doing.
 *
 * Read from the orders themselves rather than from the alert feed. The feed is a
 * doorbell - capped, and expiring after two hours - and a doorbell is not a record.
 *
 * The test button lives here now. A button about alerts belongs on the page about
 * alerts, not in the chrome of every other page.
 */
export function renderExpressLog({ orders, range, errors, shopeeShop, generatedAt, csrf, flash, user = null }) {
  const rows = orders
    .map((o) => ({ order: o, service: expressService(o) }))
    .filter((r) => r.service?.tier === EXPRESS_INSTANT)
    .sort((a, b) => b.order.createdAt - a.order.createdAt);

  const waiting = rows.filter((r) => AWAITING_PACKING.has(r.order.stage)).length;
  const today = businessToday();
  const todays = rows.filter((r) => channelDate(r.order.createdAt, r.order.channel) === today).length;

  const byCourier = new Map();
  for (const { service } of rows) byCourier.set(service.courier, (byCourier.get(service.courier) ?? 0) + 1);

  const body = rows.map(({ order: o, service }) => {
    const stage = STAGE_META[o.stage] ?? { label: o.stage ?? '-', tone: 'dim' };
    return `<tr>
      <td class="nowrap">${escape(dateTime(o.createdAt, o.channel))}</td>
      <td>${channelTag(o)}</td>
      <td><span class="mono nowrap">${escape(o.id)}</span></td>
      <td class="nowrap">${escape(o.buyer) || '<span class="dim">&mdash;</span>'}</td>
      <td class="nowrap"><span class="xp__c">${escape(service.courier)}</span></td>
      <td class="num nowrap">${escape(rupiah(o.total))}</td>
      <td class="nowrap"><span class="${stage.tone}">${escape(stage.label)}</span></td>
    </tr>`;
  }).join('');

  return shell({ user,
    title: 'Pickup Instant',
    range, errors, shopeeShop, generatedAt,
    view: 'express',
    scope: 'pesanan instant & instant prioritas',
    flash, csrf,
    kpis: `
      <div class="strip">
        ${stat('Instant hari ini', String(todays))}
        ${stat('Belum dipacking', String(waiting), waiting > 0 ? 'flag' : 'ok')}
        ${stat('Dalam rentang ini', String(rows.length))}
      </div>`,
    body: rows.length === 0
      ? `<p class="empty">Belum ada pesanan instant dalam rentang ini.</p>
         <div class="apply">${testButton(csrf)}</div>`
      : `<div class="filters">
          ${[...byCourier.entries()].sort((a, b) => b[1] - a[1])
            .map(([name, n]) => `<span class="chip">${escape(name)} <b>${n}</b></span>`).join('')}
          <span class="grow"></span>
          ${testButton(csrf)}
        </div>
        <div class="scroll"><table class="dense">
          <thead><tr>
            <th>Masuk</th><th>Kanal</th><th>Pesanan</th><th>Pembeli</th><th>Kurir</th>
            <th class="num">Total</th><th>Status</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table></div>
        <div class="foot"><span>Bel berbunyi hanya untuk yang sudah dibayar dan belum dipacking; yang di sini adalah seluruh riwayatnya.</span></div>`,
  });
}

const testButton = (csrf) => `<button class="chip" type="button" id="alerttest" data-csrf="${escape(csrf ?? '')}"
  title="Bunyikan alert uji lewat server, seperti pesanan sungguhan">&#128276; Tes bunyi alert</button>`;

/** Warehouse view: what to pick, biggest first, with the channel split for packing. */
export function renderPicklist({ picklist, orders = [], images = {}, range, errors, shopeeShop, generatedAt, user = null, csrf = null, flash = null, readAt = null, settleFailed = false }) {
  // A picker reads quantity first and everything else only to confirm, so the number
  // leads and the channel split collapses into one line of small tags.
  const split = (by) => Object.entries({ tokopedia: 'Tokped', tiktok_shop: 'TikTok', shopee: 'Shopee', shopify: 'Shopify', manual: 'Manual' })
    .filter(([key]) => by[key] > 0)
    .map(([key, label]) => `<span class="mini" style="--chip:${CHANNELS[key]?.accent ?? 'var(--muted)'}">${label} ${by[key]}</span>`)
    .join('');

  // The product's photo, by its own SKU or the master SKU a channel alias stands for; a
  // bundle without one shows its first part. The picker matches the jar, not the code.
  const photoOf = (sku) => {
    const product = findProduct(sku);
    const hit = images[sku] ?? (product && images[product.sku])
      ?? (product?.components ?? []).map((c) => images[c.sku] ?? images[findProduct(c.sku)?.sku]).find(Boolean);
    return hit?.thumb || hit?.url || '';
  };
  const thumb = (sku, name, cls = 'pk__img') => {
    const src = photoOf(sku);
    return src
      ? `<img class="${cls}" src="${escape(src)}" alt="${escape(name ?? sku)}" loading="lazy" decoding="async" width="56" height="56">`
      : `<span class="${cls} ${cls}--none" aria-hidden="true">${svg('cube')}</span>`;
  };
  const rows = picklist.items
    .map((i) => `<tr>
      <td class="pick__q mono">${i.qty}</td>
      <td>
        <div class="pk__prod">${thumb(i.sku, i.name)}<div class="pk__pt">
        <span class="pick__n">${escape(i.name)}${i.variant ? ` <span class="note">${escape(i.variant)}</span>` : ''}</span>
        <span class="pick__s mono">${escape(i.sku)}</span></div></div>
      </td>
      <td class="pick__c">${split(i.byChannel)}</td>
      <td class="num dim nowrap">${i.orders} order</td>
    </tr>`)
    .join('');

  // The orders behind these lines, exactly; confirming sends this list, so what is taken
  // off the shelf is what the picker was looking at.
  const pickable = orders.filter((o) => o.stage === 'to_ship');
  const pickKeys = pickable.map((o) => `${o.channel}:${o.id}`);
  // The same parcels, one per transaction, oldest first - the order they are packed in.
  const byOrder = [...pickable].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).map((o) => {
    const units = (o.lines ?? []).reduce((n, l) => n + (Number(l.qty) || 0), 0);
    return `<li class="pk__o">
      <div class="pk__oh">
        ${channelTag(o)}
        <span class="mono pk__code">${escape(orderCode(o))}</span>
        ${o.buyer ? `<span class="pk__buyer">${escape(o.buyer)}</span>` : ''}
        <span class="pk__grow"></span>
        <span class="dim nowrap pk__when">${escape(dateTime(o.createdAt, o.channel))}</span>
        <span class="pk__units mono">${units} unit</span>
      </div>
      <ul class="pk__lines">${(o.lines ?? []).map((l) => `<li>${thumb(l.sku, l.name, 'pk__mini')}<b class="mono">${Number(l.qty) || 0}×</b><span class="pk__ln">${escape(l.name ?? l.sku)}${l.variant ? ` <span class="note">${escape(l.variant)}</span>` : ''}<span class="mono dim pk__sku">${escape(l.sku ?? '')}</span></span></li>`).join('')}</ul>
    </li>`;
  }).join('');
  const tabs = `<div class="pk__tabs" role="tablist" aria-label="Tampilan picklist">
      <button type="button" role="tab" class="pk__tab" data-pane="items" aria-selected="true">Per produk <span>${picklist.skuCount}</span></button>
      <button type="button" role="tab" class="pk__tab" data-pane="orders" aria-selected="false">Per transaksi <span>${pickable.length}</span></button>
    </div>`;
  const confirm = csrf && pickKeys.length ? `<form method="post" class="pick__confirm" data-confirm="Konfirmasi ${picklist.orderCount} pesanan (${picklist.unitCount} unit) sudah dipetik? Stok gudang berkurang sesuai isi produknya.">
      <input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="action" value="wh_pick"><input type="hidden" name="view" value="picklist"><input type="hidden" name="back" value="?view=picklist">
      ${pickKeys.map((k) => `<input type="hidden" name="order" value="${escape(k)}">`).join('')}
      <div class="pick__confirm-t"><b>Sudah dipetik semua?</b><span>Konfirmasi mengurangi stok gudang sesuai isi tiap produk. Pesanan yang sudah dikonfirmasi hilang dari daftar ini.</span></div>
      <button type="submit" class="pick__go">${svg('check2')}<span>Konfirmasi ${picklist.orderCount} pesanan</span></button>
    </form>` : '';

  return shell({ user,
    csrf, flash,
    title: 'Picklist',
    range,
    errors,
    shopeeShop,
    generatedAt,
    view: 'picklist',
    hideRangeControls: true, scope: 'semua yang perlu dipetik sejak 06 Okt 17.16',
    readAt, settleFailed,
    style: PICK_STYLE, script: PICK_SCRIPT,
    kpis: `
      <div class="strip" id="pick-kpis">
        ${stat('Unit dipetik', String(picklist.unitCount))}
        ${stat('SKU', String(picklist.skuCount))}
        ${stat('Pesanan', String(picklist.orderCount))}
        <span class="strip__grow"></span>
        <a class="pk__hist" href="?view=picklist&amp;history=1">${svg('history')}<span>Riwayat picklist</span></a>
      </div>`,
    body: `<div id="pick-live" data-live="${escape(pickKeys.join(','))}">${picklist.items.length === 0
      ? '<p class="empty">Tidak ada pesanan yang menunggu dipetik.</p>'
      : `${confirm}${tabs}<div class="pk__pane" data-pane-body="orders" hidden><ol class="pk__orders">${byOrder}</ol></div><div class="pk__pane scroll" data-pane-body="items"><table class="dense">
          <thead><tr>
            <th class="num">Qty</th><th>Produk</th><th>Kanal</th><th class="num">Pesanan</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div class="foot"><span>${picklist.orderCount} pesanan &middot; ${picklist.skuCount} SKU &middot; ${picklist.unitCount} unit</span><span class="pick__live" aria-live="polite">${svg('refresh')} diperbarui otomatis</span></div>`}</div>`,
  });
}

const PICK_STYLE = `
.pick__confirm{display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin:0 0 1rem; padding:.9rem 1.1rem; border-radius:var(--radius); border:1px solid color-mix(in srgb, var(--brand) 45%, var(--line)); background:color-mix(in srgb, var(--brand) 9%, var(--panel))}
.pick__confirm-t{display:flex; flex-direction:column; gap:.2rem; min-width:0}
.pick__confirm-t b{font-size:.95rem}
.pick__confirm-t span{font-size:.8rem; color:var(--muted)}
.pick__go{display:inline-flex; align-items:center; gap:.45rem; font:inherit; font-size:.9rem; font-weight:600; min-height:46px; padding:.5rem 1.3rem; border-radius:999px; border:1px solid var(--brand); background:var(--brand); color:var(--bg); cursor:pointer; transition:filter .15s}
.pick__go:hover{filter:brightness(1.08)}
.pick__go:focus-visible{outline:2px solid var(--brand); outline-offset:3px}
.pick__go .ico{width:18px; height:18px}
.pick__live{display:inline-flex; align-items:center; gap:.35rem; color:var(--dim); font-size:.74rem}
.pick__live .ico{width:13px; height:13px}
.pick__live.is-new{color:var(--brand)}
.pk__hist{display:inline-flex; align-items:center; gap:.4rem; align-self:center; font-size:.84rem; min-height:42px; padding:.4rem 1rem; border-radius:999px; border:1px solid var(--line); color:var(--fg); text-decoration:none; background:var(--panel); transition:border-color .15s, color .15s}
.pk__hist:hover{border-color:var(--brand); color:var(--brand)}
.pk__hist .ico{width:16px; height:16px}
.pk__tabs{display:inline-flex; gap:.25rem; padding:.25rem; margin:0 0 .9rem; border:1px solid var(--line); border-radius:999px; background:var(--panel)}
.pk__tab{font:inherit; font-size:.84rem; min-height:40px; padding:.35rem 1rem; border-radius:999px; border:0; background:none; color:var(--muted); cursor:pointer; transition:background .15s, color .15s}
.pk__tab span{font-size:.72rem; opacity:.7; margin-left:.2rem}
.pk__tab[aria-selected="true"]{background:var(--brand); color:var(--bg); font-weight:600}
.pk__tab:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.pk__pane[hidden]{display:none}
.pk__orders{list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(24rem, 1fr)); gap:.7rem}
.pk__o{border:1px solid var(--line); border-radius:var(--radius-s); background:var(--panel); padding:.8rem .95rem; display:flex; flex-direction:column; gap:.6rem}
.pk__oh{display:flex; align-items:center; flex-wrap:wrap; gap:.45rem .6rem}
.pk__code{font-size:.84rem; font-weight:600}
.pk__buyer{font-size:.82rem; color:var(--muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:12rem}
.pk__grow{flex:1}
.pk__when{font-size:.74rem}
.pk__units{font-size:.72rem; padding:.12rem .5rem; border-radius:999px; border:1px solid var(--line); color:var(--muted)}
.pk__lines{list-style:none; margin:0; padding:.55rem 0 0; border-top:1px dashed var(--line); display:flex; flex-direction:column; gap:.4rem}
.pk__lines li{display:grid; grid-template-columns:44px 2.2rem minmax(0,1fr); gap:.6rem; align-items:center; font-size:.86rem; line-height:1.35}
.pk__ln{display:flex; flex-direction:column; min-width:0}
.pk__ln .pk__sku{display:block; margin-top:.1rem}
.pk__prod{display:flex; align-items:center; gap:.85rem; min-width:0}
.pk__pt{display:flex; flex-direction:column; min-width:0}
.pk__img, .pk__mini{flex:none; object-fit:cover; border-radius:10px; background:#fff; border:1px solid var(--line)}
.pk__img{width:56px; height:56px}
.pk__mini{width:44px; height:44px; border-radius:8px}
.pk__img--none, .pk__mini--none{display:inline-grid; place-items:center; background:var(--panel-2); color:var(--dim)}
.pk__img--none .ico{width:22px; height:22px} .pk__mini--none .ico{width:18px; height:18px}
.pick__q{font-size:1.5rem}
.pk__lines b{font-size:.95rem; text-align:right}
.pk__sku{font-size:.7rem}
.pk__lines b{font-size:1.05rem}
@media (max-width:700px){.pick__go{width:100%; justify-content:center} .pk__orders{grid-template-columns:minmax(0,1fr)} .pk__lines li{grid-template-columns:40px 2rem minmax(0,1fr)} .pk__mini{width:40px; height:40px} .pk__img{width:48px; height:48px}}
`;

/*
 * New orders reach the picklist without a reload: the page reads itself every 20 seconds
 * and swaps the list in. Never while a confirmation is being asked or sent, so the list a
 * picker confirms is the one they are looking at.
 */
const PICK_SCRIPT = `
(function () {
  // Per produk / per transaksi, remembered for this browser and kept across refreshes.
  var pane = 'items';
  try { pane = localStorage.getItem('pick-pane') || 'items'; } catch (e) {}
  function show(name) {
    pane = name;
    document.querySelectorAll('.pk__tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.pane === name)); });
    document.querySelectorAll('[data-pane-body]').forEach(function (b) { b.hidden = b.dataset.paneBody !== name; });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('.pk__tab'); if (!t) return;
    show(t.dataset.pane);
    try { localStorage.setItem('pick-pane', t.dataset.pane); } catch (err) {}
  });
  show(pane);
  var busy = false;
  // Only the submit that really goes (after the confirmation was answered yes).
  document.addEventListener('submit', function (e) { if (e.target.dataset.confirmed === '1') busy = true; }, true);
  function tick() {
    if (busy || document.hidden || document.querySelector('dialog[open], .ask.is-open')) return;
    fetch(location.pathname + '?view=picklist', { credentials: 'same-origin', headers: { 'x-requested-with': 'picklist' } })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (!html || busy) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var live = doc.getElementById('pick-live'), here = document.getElementById('pick-live');
        var kpis = doc.getElementById('pick-kpis'), hereK = document.getElementById('pick-kpis');
        if (!live || !here || live.dataset.live === here.dataset.live) return;
        here.replaceWith(live);
        show(pane);
        if (kpis && hereK) hereK.replaceWith(kpis);
        var badge = document.querySelector('.pick__live');
        if (badge) { badge.classList.add('is-new'); badge.lastChild.textContent = ' daftar baru saja diperbarui'; }
      })
      .catch(function () {});
  }
  setInterval(tick, 20000);
})();
`;

/** Stock view: the ledger is the master, and every deviation is named. */



const JURNAL_STATE = {
  synced: { label: 'Tersinkron', tone: 'good' },
  queued: { label: 'Antre', tone: 'warn' },
  skipped: { label: 'Dilewati', tone: 'done' },
  broken: { label: 'Perlu ditinjau', tone: 'bad' },
};

/**
 * Jurnal view: what is already in the books, and what is waiting to go in.
 *
 * Accounting is the one place where an optimistic display does real harm, so a row says
 * "tersinkron" only when the ledger holds an invoice id for it. Everything else is
 * explicitly queued, deliberately skipped, or flagged - there is no fourth, quieter
 * state where an order simply disappears.
 */
/**
 * One line per sync path saying when it last did something.
 *
 * Silence is ambiguous: a quiet channel and a dead one look the same until you know when
 * the last push was handled. A webhook that has not spoken in over four hours during the
 * day is worth a look; a sweep that has not run in over an hour means the scheduler
 * stopped, because it is meant to run four times an hour.
 */
function syncHealth(heartbeat, now = Date.now()) {
  const stale = (iso, limitMinutes) => !iso || (now - Date.parse(iso)) / 60_000 > limitMinutes;
  const channels = [
    ['shopee', 'Shopee'], ['tokopedia', 'Tokopedia'], ['tiktok_shop', 'TikTok Shop'], ['shopify', 'Shopify'],
  ];
  const rows = channels.map(([key, label]) => {
    const beat = heartbeat?.webhooks?.[key];
    const rejected = beat?.rejected;
    // A rejection newer than the last accepted push means the platform is talking and we
    // are not listening - that outranks everything else the chip could say.
    const rejecting = rejected && (!beat?.at || rejected.at > beat.at);
    const tone = rejecting ? 'stop' : !beat?.at ? 'muted' : stale(beat.at, 4 * 60) ? 'flag' : 'ok';
    const text = rejecting
      ? `push ditolak ${escape(ageOf(rejected.at, now))} <span class="dim">(${rejected.count}x · ${escape(rejected.reason)})</span>`
      : beat?.at
        ? `${escape(ageOf(beat.at, now))} <span class="dim">(${escape(beat.status)})</span>`
        : 'belum ada push';
    return `<span class="hb hb--${tone}"><b>${escape(label)}</b> ${text}</span>`;
  });
  const sweep = heartbeat?.sweep;
  const sweepTone = !sweep ? 'muted' : stale(sweep.at, 60) ? 'flag' : 'ok';
  rows.push(`<span class="hb hb--${sweepTone}"><b>Sapuan</b> ${
    sweep ? `${escape(ageOf(sweep.at, now))} <span class="dim">(${sweep.created ?? 0} dibuat, ${sweep.failed ?? 0} gagal)</span>` : 'belum pernah jalan'}</span>`);
  return `<div class="hbs" aria-label="Kesehatan sinkronisasi">${rows.join('')}</div>`;
}

export function renderJurnal({
  overview, range, errors, shopeeShop, generatedAt, csrf, flash, live, depositTo, configured, heartbeat = null,
  paging = { page: 1, perPage: DEFAULT_PER_PAGE }, baseQuery = '', user = null,
}) {
  const order = { synced: 0, queued: 1, broken: 2, skipped: 3 };
  const sorted = [...overview.rows]
    .sort((a, b) => (order[a.state] - order[b.state]) || (b.order.createdAt - a.order.createdAt));
  const paged = paginate(sorted, paging);
  const rows = paged.items
    .map((r) => {
      const state = JURNAL_STATE[r.state];
      return `<tr data-state="${r.state}">
        <td>${channelTag(r.order)}</td>
        <td class="mono nowrap">${escape(orderCode(r.order))}</td>
        <td class="nowrap dim">${escape(dateTime(r.order.createdAt, r.order.channel))}</td>
        <td class="num mono">${r.total ? escape(rupiah(r.total)) : '<span class="dim">&mdash;</span>'}</td>
        <td><span class="pill pill--${state.tone}">${escape(state.label)}</span></td>
        <td class="dim">${escape(r.reason ?? (r.invoiceId ? `faktur ${r.invoiceId}` : ''))}</td>
      </tr>`;
    })
    .join('');

  // The button is offered only when pressing it would actually work: the POST refuses
  // while MEKARI_SYNC_LIVE is off, and a control that always errors is worse than none.
  const canPost = configured && live && overview.queued > 0;

  return shell({ user,
    csrf,
    title: 'Mekari Jurnal',
    range,
    errors,
    shopeeShop,
    generatedAt,
    view: 'jurnal',
    flash,
    kpis: `
      <div class="strip">
        ${stat('Tersinkron', String(overview.synced))}
        ${stat('Nilai tersinkron', rupiah(overview.syncedValue))}
        ${stat('Antre', String(overview.queued), overview.queued > 0 ? 'flag' : 'ok')}
        ${stat('Nilai antre', rupiah(overview.queuedValue))}
        ${overview.broken > 0 ? stat('Perlu ditinjau', String(overview.broken), 'stop') : ''}
        <span class="strip__grow"></span>
        <a class="cta" href="?view=jurnal&amp;add=1">${svg('plus')}<span>Tambah transaksi</span></a>
      </div>`,
    body: `
      ${configured ? '' : '<div class="alert">' + svg('warn') + '<span>Kredensial Mekari belum diisi, jadi tidak ada yang bisa dikirim.</span></div>'}
      ${live ? '' : `<div class="alert alert--soft">${svg('warn')}<span>Sinkronisasi belum aktif.</span></div>`}
      ${syncHealth(heartbeat, generatedAt)}
      ${canPost ? `<form method="post" data-confirm="Kirim ${overview.queued} faktur senilai ${escape(rupiah(overview.queuedValue))} ke Mekari Jurnal?">
        <input type="hidden" name="csrf" value="${escape(csrf)}">
        <input type="hidden" name="view" value="jurnal">
        <input type="hidden" name="action" value="mekari_sync">
        <div class="apply">
          <button type="submit">Kirim ${overview.queued} faktur sekarang</button>
        </div>
      </form>` : ''}
      ${rows
        ? `${pager(paged, { baseQuery, noun: 'pesanan' }).replace('class="pager"', 'class="pager pager--top"')}
          <div class="scroll"><table class="dense">
            <thead><tr>
              <th>Kanal</th><th>Kode</th><th>Tanggal</th><th class="num">Nilai</th><th>Status</th><th>Catatan</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          ${pager(paged, { baseQuery, noun: 'pesanan' })}`
        : '<p class="empty">Tidak ada pesanan pada rentang ini.</p>'}`,
  });
}

/**
 * The form for a sale that never went through a marketplace.
 *
 * Built for someone entering a stack of consignment slips, so it optimises for the tenth
 * entry rather than the first: the source is one click, the code is already filled in,
 * the money columns are monospaced and right-aligned so a missing zero is visible, and
 * the running total never scrolls off. Every number is checked again on the server - the
 * live arithmetic here is a courtesy, not the authority.
 */
export function renderManual({
  range, errors, shopeeShop, generatedAt, csrf, flash, source, code, today, contacts = [],
  live, existingCodes = [], images = {}, seqTail = '', prices = {}, user = null, editing = null,
}) {
  /*
   * The same form, filled in, when an order is being corrected rather than entered.
   *
   * Two things are deliberately not editable. The code is the invoice's custom_id in
   * Jurnal - the whole of this system's idempotency - so changing it would orphan the
   * invoice it names and let a second one be created beside it. And the source decides
   * the receivable account, the tag and the term; changing it is not a correction but a
   * different sale, which is what delete-and-re-enter is for.
   */
  const edit = editing ?? null;
  const chosen = SOURCE_OPTIONS.find((o) => o.prefix === (edit ? String(edit.source ?? '').toUpperCase() : source))
    ?? SOURCE_OPTIONS[0];

  const sources = SOURCE_OPTIONS
    .filter((o) => !edit || o.prefix === chosen.prefix)
    .map((o) => `
    <label class="src__o${edit ? ' src__o--fixed' : ''}">
      <input type="radio" name="source" value="${o.prefix}" ${o.prefix === chosen.prefix ? 'checked' : ''}
             ${edit ? 'readonly tabindex="-1"' : ''}
             data-term="${o.termDays}" data-label="${escape(o.label)}">
      <span class="src__b">
        <span class="src__p">${o.prefix}</span>
        <span class="src__l">${escape(o.label)}</span>
        <span class="src__t">Net ${o.termDays}</span>
      </span>
    </label>`).join('');

  /** The author suffix is added again on save, so it must not be edited back in by hand. */
  const noteOf = (order) => String(order?.note ?? '')
    .replace(/\s*-\s*(ditambahkan|diubah) oleh .*$/u, '')
    .trim();

  const editLines = edit ? (edit.finance?.lines?.length ? edit.finance.lines : (edit.lines ?? [])) : [];

  /*
   * Only what the storefront sells.
   *
   * The list used to be the whole master catalogue, which meant somebody entering a
   * consignment slip was offered a Shopee-only listing, two superseded spellings of the
   * protocol, and four free gifts - nine products with no price to write them up at.
   *
   * The fallback is deliberate rather than defensive: if the price sync has never run,
   * an empty dropdown would be a form nobody can use, so the full catalogue comes back
   * and the banner says why the prices are missing.
   */
  const offered = sellableInShopify(prices);
  const fromShopify = offered.length > 0;
  let catalogue = fromShopify
    ? offered
    : SELLABLE.map((p) => ({ ...p, price: 0 }));

  /*
   * A line already on the order keeps its product, whatever the storefront sells today.
   *
   * The list is narrowed to what Shopify prices, and an edited order can carry a gift SKU
   * or a listing that has since been retired. Dropping those options would silently empty
   * the select on a row the operator never touched, and the save would then rebuild the
   * sale without it.
   */
  if (edit) {
    const have = new Set(catalogue.map((p) => p.sku));
    for (const line of editLines) {
      const sku = String(line.sku ?? '').trim();
      if (!sku || have.has(sku)) continue;
      have.add(sku);
      const known = SELLABLE.find((p) => p.sku === sku);
      catalogue = [...catalogue, {
        sku,
        name: known?.name ?? line.name ?? sku,
        category: known?.category ?? 'gift',
        price: Number(line.unitPrice) || 0,
      }];
    }
  }

  // Grouped so a long flat list does not have to be read top to bottom every time.
  const byCategory = new Map();
  for (const product of catalogue) {
    if (!byCategory.has(product.category)) byCategory.set(product.category, []);
    byCategory.get(product.category).push(product);
  }
  // Each option carries the price Shopify sells it at, copied into our own store by the
  // daily job. The field is still editable - a consignment is often discounted - but
  // nobody has to go and look the number up.
  const productOptions = [...byCategory.entries()]
    .map(([category, items]) => `<optgroup label="${escape(CATEGORIES[category] ?? category)}">${
      items.map((p) => `<option value="${escape(p.sku)}" data-price="${p.price}">${escape(p.name)}</option>`).join('')
    }</optgroup>`)
    .join('');

  const lineRow = (index, line = null) => {
    // A discount typed as a percentage is stored as rupiah and remembered as a percent.
    // Restoring it as rupiah would be arithmetically identical and still wrong: the
    // operator gave an instruction, and the form should show the instruction back.
    const percent = line && Number.isFinite(Number(line.discountPercent));
    const discount = percent ? Number(line.discountPercent) : Number(line?.unitDiscount ?? 0);
    const picture = line ? (images[line.sku]?.thumb || images[line.sku]?.url || '') : '';
    return `
    <div class="ln" data-row>
      <span class="ln__prod">
        <img class="ln__pic" alt="" width="38" height="38" ${picture ? `src="${escape(picture)}"` : 'hidden'}>
        <select name="sku" aria-label="Produk baris ${index + 1}">
          <option value="">Pilih produk&hellip;</option>
          ${line ? productOptions.replace(`value="${escape(String(line.sku ?? ''))}"`, `value="${escape(String(line.sku ?? ''))}" selected`) : productOptions}
        </select>
      </span>
      <input type="number" name="qty" value="${escape(String(line?.qty ?? 1))}" min="1" step="1" inputmode="numeric" aria-label="Kuantitas">
      <input type="number" name="unitPrice" value="${line ? escape(String(Number(line.unitPrice) || 0)) : ''}" min="0" step="1" inputmode="numeric" placeholder="Harga" aria-label="Harga satuan">
      <span class="ln__disc">
        <input type="number" name="unitDiscount" value="${escape(String(discount || 0))}" min="0" step="1" inputmode="numeric"
               ${percent ? 'max="100"' : ''} aria-label="Diskon baris ${index + 1}">
        <span class="seg" role="group" aria-label="Satuan diskon baris ${index + 1}">
          <button class="seg__b${percent ? '' : ' is-on'}" type="button" data-mode="rp" aria-pressed="${percent ? 'false' : 'true'}">Rp</button>
          <button class="seg__b${percent ? ' is-on' : ''}" type="button" data-mode="pct" aria-pressed="${percent ? 'true' : 'false'}">%</button>
        </span>
        <input type="hidden" name="discountMode" value="${percent ? 'pct' : 'rp'}">
      </span>
      <span class="ln__t" data-line-total>&mdash;</span>
      <button class="ln__x" type="button" data-remove aria-label="Hapus baris ${index + 1}">&times;</button>
    </div>`;
  };

  /*
   * The half of a resend that no other source has.
   *
   * Rendered always and shown by the source radio, because choosing RS must not cost a
   * page load - the operator is standing in front of a mistake and the whole form is
   * already open.
   *
   * Two things live here. The order being put right, which a resend without is a free
   * parcel with no reason recorded. And the goods that went out wrongly, priced, because
   * they are not coming back and their value is the only thing this transaction owes the
   * books. The replacement above is free whatever is typed into it; the server zeroes it.
   */
  const wrongRow = (index) => `
    <div class="ln ln--wrong" data-wrong>
      <span class="ln__prod">
        <select name="wsku" aria-label="Barang salah kirim baris ${index + 1}">
          <option value="">Pilih produk&hellip;</option>
          ${productOptions}
        </select>
      </span>
      <input type="number" name="wqty" value="1" min="1" step="1" inputmode="numeric" aria-label="Kuantitas salah kirim">
      <input type="number" name="wunitPrice" value="" min="0" step="1" inputmode="numeric" placeholder="Nilai" aria-label="Nilai satuan">
      <span class="ln__t" data-wrong-total>&mdash;</span>
      <button class="ln__x" type="button" data-remove-wrong aria-label="Hapus baris ${index + 1}">&times;</button>
    </div>`;

  /*
   * Which order went wrong comes first, because everything else is read off it.
   *
   * The customer, the address and the replacement goods are all answered by that one
   * question, and two of them fill themselves in the moment it is answered. Asking it
   * after the product rows had the operator typing things the form was about to know.
   */
  const resendRef = edit ? '' : `
    <div class="fset" id="rsref" hidden>
      <h3 class="fset__h">Pesanan yang salah kirim</h3>
      <div class="flds flds--one">
        <div class="fld rsf">
          <label for="resendFor">Order ID yang salah kirim</label>
          <input id="resendFor" name="resendFor" maxlength="64" autocomplete="off" spellcheck="false"
                 role="combobox" aria-expanded="false" aria-controls="rs-picks" aria-autocomplete="list"
                 placeholder="mis. 2609ABCDE atau #11143">
          <input type="hidden" name="resendChannel" id="resendChannel">
          <ul class="pick0s" id="rs-picks" role="listbox" aria-label="Pesanan yang cocok" hidden></ul>
          <span class="fld__hint" id="rs-status" role="status" aria-live="polite">Ketik sebagian order ID &mdash; pilihan muncul sambil mengetik.</span>
          <div class="rsprev" id="rs-preview" hidden></div>
        </div>
      </div>
    </div>`;

  const resendFieldset = edit ? '' : `
    <div class="fset" id="rsfields" hidden>
      <h3 class="fset__h">Barang salah kirim</h3>
      <p class="fld__hint rs__note">Barang di bawah ini yang terlanjur dikirim ke pelanggan. Sesuai SOP tidak ditarik kembali -
        jadi nilainya dibukukan ke Jurnal sebagai beban barang rusak, bukan sebagai penjualan. Yang di bagian Produk di atas
        adalah penggantinya, dan itu gratis.</p>
      <div class="lnh lnh--wrong"><span>Produk</span><span>Qty</span><span>Nilai</span><span>Subtotal</span><span></span></div>
      <div id="wlines">${wrongRow(0)}</div>
      <button class="addln" type="button" id="addwln">+ Tambah baris</button>
    </div>`;

  return shell({ user,
    csrf,
    title: edit ? `Ubah ${edit.id}` : 'Transaksi manual',
    range,
    errors,
    shopeeShop,
    generatedAt,
    view: 'jurnal',
    flash,
    hideRangeControls: true,
    kpis: '<div class="backbar"><a class="chip" href="?view=orders">&larr; Kembali</a></div>',
    body: `
      ${live ? '' : `<div class="alert alert--soft">${svg('warn')}<span>Sinkronisasi belum aktif.</span></div>`}
      ${fromShopify ? '' : `<div class="alert alert--soft">${svg('warn')}<span>Harga Shopify belum tersinkron, jadi daftar produk masih menampilkan seluruh katalog dan harga harus diisi manual.</span></div>`}
      ${edit ? `<div class="alert alert--soft">${svg('warn')}<span>Mengubah transaksi yang sudah tercatat. Fakturnya di Mekari Jurnal ikut diperbarui di tempat - nomor fakturnya tidak berubah - dan kalau labelnya sudah dicetak, tandanya dilepas supaya dicetak ulang.</span></div>` : ''}
      <form method="post" id="mxform" data-confirm="${edit
        ? `Simpan perubahan pada ${escape(edit.id)} dan perbarui fakturnya di Mekari Jurnal?`
        : 'Simpan transaksi ini dan kirim ke Mekari Jurnal?'}">
        <input type="hidden" name="csrf" value="${escape(csrf)}">
        <input type="hidden" name="view" value="jurnal">
        <input type="hidden" name="action" value="${edit ? 'manual_update' : 'manual_invoice'}">
        ${edit ? '' : '<input type="hidden" name="back" value="?view=jurnal&amp;add=1">'}

        <div class="mx">
          <div class="panel">
            <div class="fset">
              <h3 class="fset__h">Sumber</h3>
              <div class="src">${sources}</div>
            </div>

            ${resendRef}

            <div class="fset">
              <h3 class="fset__h">Detail</h3>
              <div class="flds">
                <div class="fld fld--mono">
                  <label for="code">Kode transaksi</label>
                  <!-- The hyphen is escaped: browsers compile pattern with the v flag, where a bare
                       trailing "-" in a class is a syntax error and the whole pattern is silently
                       dropped. Unescaped, this checked nothing, and LB-260921-000011~ got through. -->
                  <input id="code" name="code" value="${escape(edit ? edit.id : code)}" required maxlength="43"
                         pattern="[A-Za-z]{2}-[A-Za-z0-9\\-]{1,40}" ${edit ? 'readonly' : 'data-code'}>
                  ${edit ? '<span class="fld__hint">Kode tidak bisa diubah: ini yang menghubungkan transaksi ini dengan fakturnya di Jurnal.</span>' : ''}
                </div>
                <div class="fld">
                  <label for="date">Tanggal</label>
                  <input id="date" name="date" type="date" value="${escape(edit ? channelDate(edit.createdAt, BENCH_CHANNEL) : today)}" max="${escape(today)}" required>
                </div>
                <div class="fld">
                  <label for="shipping">Ongkir</label>
                  <input id="shipping" name="shipping" type="number" value="${escape(String(edit?.finance?.shipping ?? 0))}" min="0" step="1" inputmode="numeric">
                </div>
              </div>
            </div>

            <div class="fset">
              <h3 class="fset__h">Pelanggan</h3>
              <div class="flds">
                <div class="fld">
                  <label for="buyer">Nama pelanggan</label>
                  <input id="buyer" name="buyer" list="mxcontacts" maxlength="120" autocomplete="off"
                         value="${escape(edit?.buyer ?? '')}" placeholder="Nama orang atau toko" data-customer>
                  <span class="fld__hint" data-customer-hint>Kosong: ditagih atas nama ${escape(chosen.label)}</span>
                </div>
                <div class="fld">
                  <label for="buyerPhone">Nomor telepon</label>
                  <input id="buyerPhone" name="buyerPhone" type="tel" maxlength="40" autocomplete="off" value="${escape(edit?.buyerPhone ?? '')}" placeholder="08...">
                </div>
                <div class="fld">
                  <label for="buyerEmail">Email</label>
                  <!-- The browser calls ika@treelogy a valid address and the server does not, so a typed-in
                       sale was refused after submit and the whole form lost. The pattern is the
                       server's own rule (src/mekari/manual.js), caught before anything is sent. -->
                  <input id="buyerEmail" name="buyerEmail" type="email" maxlength="120" autocomplete="off" value="${escape(edit?.buyerEmail ?? '')}" placeholder="nama@contoh.id"
                         pattern="[^\\s@]+@[^\\s@]+\\.[^\\s@]+" title="Email lengkap dengan domain, mis. nama@treelogy.com">
                </div>
                <div class="fld">
                  <label for="carrier">Kurir</label>
                  <select id="carrier" name="carrier">
                    <option value="">Belum ditentukan</option>
                    ${MANUAL_CARRIERS.map((name) => `<option value="${escape(name)}"${edit?.carrier === name ? ' selected' : ''}>${escape(name)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="flds flds--one">
                <div class="fld">
                  <label for="shipTo">Alamat</label>
                  <textarea id="shipTo" name="shipTo" rows="2" maxlength="400" data-nomoji
                            placeholder="Jalan, kelurahan, kecamatan, kota, provinsi, kode pos">${escape(edit?.shipTo ?? '')}</textarea>
                </div>
              </div>
              <datalist id="mxcontacts">${
                contacts.map((c) => `<option value="${escape(c)}"></option>`).join('')
              }</datalist>
            </div>

            <div class="fset">
              <h3 class="fset__h">Produk</h3>
              <div class="lnh">
                <span>Produk</span><span>Qty</span><span>Harga</span><span>Diskon</span><span>Subtotal</span><span></span>
              </div>
              <div id="lines">${editLines.length > 0 ? editLines.map((line, i) => lineRow(i, line)).join('') : lineRow(0)}</div>
              <button class="addln" type="button" id="addln">+ Tambah baris</button>
            </div>

            ${resendFieldset}

            <div class="fset">
              <h3 class="fset__h">Catatan</h3>
              <div class="fld">
                <label for="note">Keterangan (ikut ke memo faktur)</label>
                <input id="note" name="note" maxlength="200" value="${escape(noteOf(edit))}" placeholder="mis. titip di toko A, tempo 7 hari"
                  data-nomoji aria-describedby="note-warn">
                <p class="fld__warn" id="note-warn" hidden>
                  Jurnal menolak faktur yang memonya berisi emoji, jadi emoji dilepas sebelum dikirim
                  ke buku. Catatan di label dan faktur cetak tetap utuh.
                </p>
              </div>
            </div>
          </div>

          <aside class="mx__side">
            <div class="panel sum">
              <div class="sum__r"><span>Produk</span><b data-sum-goods>Rp0</b></div>
              <div class="sum__r"><span>Ongkir</span><b data-sum-ship>Rp0</b></div>
              <div class="sum__r"><span>Termin</span><b data-sum-term>Net ${chosen.termDays}</b></div>
              <div class="sum__r"><span>Jatuh tempo</span><b data-sum-due>&mdash;</b></div>
              <div class="sum__r sum__r--wrong" data-wrong-row hidden><span>Nilai salah kirim</span><b data-sum-wrong>Rp0</b></div>
              <div class="sum__t"><span data-total-label>Total</span><b data-sum-total>Rp0</b></div>
              <input type="hidden" name="total" data-total-field value="0">
              <button class="sum__go" type="submit" id="mxgo" data-sell="${edit ? 'Simpan perubahan' : 'Simpan &amp; kirim ke Jurnal'}"
                disabled>${edit ? 'Simpan perubahan' : 'Simpan &amp; kirim ke Jurnal'}</button>
            </div>
          </aside>
        </div>
      </form>`,
    script: `
(function () {
  var form = document.getElementById('mxform');
  if (!form) return;

  // Emoji, caught at the keyboard rather than at the books.
  //
  // Jurnal answers 422 "Memo may not contain emoji" and throws the whole invoice away,
  // and because a typed-in sale is only stored once the books have accepted it, the sale
  // went with it - a walk-in entered at 12:01 on 24 Sep was lost that way and had to be
  // typed again from memory.
  //
  // It does not block. A sale at the counter has already happened, and refusing to record
  // it over a character would be the wrong end of the trade. The server takes the emoji
  // out of what it sends to Jurnal and keeps the note whole in our own record, so this
  // only says so - before the press, not after it.
  Array.prototype.forEach.call(form.querySelectorAll('[data-nomoji]'), function (field) {
    var warn = field.getAttribute('aria-describedby') && document.getElementById(field.getAttribute('aria-describedby'));
    // Doubled, because this whole script is a template literal: a single backslash is
    // eaten before it ever reaches the browser, and the class that arrives is a list of
    // the letters in "p{Extended_Pictographic}" - which matches the t, i and p in
    // "titip di toko A". Caught by running it in a browser rather than reading it.
    var pictographs = /[\\p{Extended_Pictographic}\\u{1F3FB}-\\u{1F3FF}\\u{FE0F}\\u{200D}\\u{20E3}]/u;
    var look = function () {
      var found = pictographs.test(field.value || '');
      field.classList.toggle('is-warn', found);
      if (warn) warn.hidden = !found;
    };
    field.addEventListener('input', look);
    look();
  });

  var lines = document.getElementById('lines');
  var template = lines.firstElementChild.cloneNode(true);
  var codeField = form.querySelector('[data-code]');
  // Editing an existing transaction rather than entering a new one. The code is fixed,
  // the source is fixed, and the rows arrive already filled in.
  var editing = form.querySelector('[name="action"]').value === 'manual_update';
  var code = form.querySelector('[name="code"]').value;
  var customerHint = form.querySelector('[data-customer-hint]');
  var dateField = form.querySelector('input[name="date"]');
  var shipField = form.querySelector('input[name="shipping"]');
  var go = document.getElementById('mxgo');
  // Everything a resend adds. Absent while editing, which is why each use is guarded.
  var rsFields = document.getElementById('rsfields');
  var rsRef = document.getElementById('rsref');
  var wlines = document.getElementById('wlines');
  var linked = document.getElementById('resendFor');
  var resending = function () { return source().value === 'RS'; };
  var existing = ${JSON.stringify(existingCodes)};
  // Thumbnails by SKU, so picking a product shows what it looks like - a check against
  // choosing the 90-gram powder when the slip says 180.
  var pictures = ${JSON.stringify(Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v.thumb || v.url || ''])))};
  function showPicture(row) {
    var pic = row.querySelector('.ln__pic'); var sku = row.querySelector('select').value;
    if (pictures[sku]) { pic.src = pictures[sku]; pic.hidden = false; } else { pic.hidden = true; pic.removeAttribute('src'); }
  }
  // The code is only regenerated while it still looks generated. The moment someone
  // types their own, the source and date stop overwriting it.
  var codeIsOurs = true;

  var rupiah = function (n) { return 'Rp' + Math.round(n).toLocaleString('id-ID'); };

  /**
   * What the discount on this row is worth per unit, in rupiah.
   *
   * A percentage is only ever a way of saying an amount, so it is turned into one here
   * and again on the server - which is the side that decides. Over 100% is clamped
   * rather than allowed to make the line negative.
   */
  function discountOf(row, price) {
    var field = row.querySelector('[name="unitDiscount"]');
    var mode = row.querySelector('[name="discountMode"]').value;
    var value = Number(field && field.value);
    if (!isFinite(value) || value <= 0) return 0;
    if (mode !== 'pct') return value;
    return Math.round(price * Math.min(value, 100) / 100);
  }
  var num = function (el) { var v = Number(el && el.value); return isFinite(v) ? v : 0; };

  function source() {
    var picked = form.querySelector('input[name="source"]:checked');
    return picked || form.querySelector('input[name="source"]');
  }

  // The reserved tail is what makes the code unique; source and date only dress it.
  var seqTail = ${JSON.stringify(seqTail)};
  function suggest() {
    var prefix = source().value;
    var d = (dateField.value || '').replace(/-/g, '').slice(2);
    var stem = prefix + '-' + d + '-';
    if (seqTail) return stem + seqTail;
    var used = existing.filter(function (c) { return c.indexOf(stem) === 0; })
      .map(function (c) { return Number(c.slice(stem.length)); })
      .filter(function (n) { return isFinite(n); });
    var next = used.length ? Math.max.apply(null, used) + 1 : 1;
    return stem + String(next).padStart(3, '0');
  }

  function refreshCode() {
    // Absent while editing: the code is the invoice's identity in Jurnal and is shown
    // read-only, so there is nothing here to regenerate.
    if (codeIsOurs && codeField) codeField.value = suggest();
  }

  /** Every wrong-goods row that names a product and a value, in rupiah. */
  function wrongTotal() {
    if (!wlines) return 0;
    var sum = 0;
    Array.prototype.forEach.call(wlines.querySelectorAll('[data-wrong]'), function (row) {
      var sku = row.querySelector('select').value;
      var qty = num(row.querySelector('[name="wqty"]'));
      var field = row.querySelector('[name="wunitPrice"]');
      var rate = num(field);
      var cell = row.querySelector('[data-wrong-total]');
      if (!sku || qty <= 0 || field.value === '' || rate <= 0) { cell.textContent = '\\u2014'; return; }
      cell.textContent = rupiah(rate * qty);
      sum += rate * qty;
    });
    return sum;
  }

  /** At least one line that actually names something to put in the box. */
  function hasReplacement() {
    return Array.prototype.slice.call(lines.querySelectorAll('[data-row]'))
      .some(function (row) { return row.querySelector('select').value && num(row.querySelector('[name="qty"]')) > 0; });
  }

  /*
   * The form changes shape when the source does.
   *
   * A resend charges nobody, so the money rows say nothing useful and the one number worth
   * watching is what the mistake cost. Hiding the price boxes on the replacement lines
   * would be a lie of a different kind - the operator does want to see what they are
   * sending is worth - so they stay, and the server is what makes them free.
   */
  function shape() {
    if (!rsFields) return;
    var on = resending();
    rsFields.hidden = !on;
    if (rsRef) rsRef.hidden = !on;
    form.querySelector('[data-wrong-row]').hidden = !on;
    form.querySelector('[data-total-label]').textContent = on ? 'Ditagih' : 'Total';
    // "kirim ulang" never sends an invoice, and a button that says it does is the kind of
    // small lie somebody eventually repeats to an accountant.
    go.textContent = on ? 'Simpan kirim ulang' : go.dataset.sell;
    if (linked) linked.required = on;
  }

  function total() {
    var goods = 0;
    var complete = 0;
    Array.prototype.forEach.call(lines.querySelectorAll('[data-row]'), function (row) {
      var sku = row.querySelector('select').value;
      var qty = num(row.querySelector('[name="qty"]'));
      var priceField = row.querySelector('[name="unitPrice"]');
      var price = num(priceField);
      var disc = discountOf(row, price);
      var cell = row.querySelector('[data-line-total]');
      /*
       * A row nobody has finished contributes nothing and says so, rather than quietly
       * counting as zero in a total that looks complete.
       *
       * An empty price box is unfinished. A price of zero is not: a free gift is a real
       * line worth nothing, and reading the two the same way is what kept Travel Pouch
       * showing a dash beside a product that had been chosen on purpose.
       */
      if (!sku || qty <= 0 || priceField.value === '' || price < 0) { cell.textContent = '\\u2014'; return; }
      var net = Math.max(0, price - disc) * qty;
      cell.textContent = rupiah(net);
      goods += net;
      complete += 1;
    });

    var ship = Math.max(0, num(shipField));
    var term = Number(source().dataset.term) || 14;

    form.querySelector('[data-sum-goods]').textContent = rupiah(goods);
    form.querySelector('[data-sum-ship]').textContent = rupiah(ship);
    form.querySelector('[data-sum-term]').textContent = 'Net ' + term;
    form.querySelector('[data-sum-total]').textContent = rupiah(goods + ship);
    form.querySelector('[data-total-field]').value = String(goods + ship);

    var due = form.querySelector('[data-sum-due]');
    if (dateField.value) {
      var d = new Date(dateField.value + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + term);
      due.textContent = d.toISOString().slice(0, 10);
    } else {
      due.textContent = '\\u2014';
    }

    /*
     * A resend has no total to be above zero, so it cannot be gated on one.
     *
     * What it needs instead is the three things that make it a resend at all: the order it
     * is putting right, something to send, and something to book. Any one of them missing
     * and the button stays down, because each produces a different kind of wrong record -
     * a free parcel with no reason, an empty parcel, or a mistake nobody ever costed.
     */
    if (resending()) {
      var wrongValue = wrongTotal();
      form.querySelector('[data-sum-wrong]').textContent = rupiah(wrongValue);
      /*
       * Nobody is charged for a resend, and the panel must not say otherwise.
       *
       * The replacement lines carry prices - what is being sent is worth knowing, and the
       * figures arrive by themselves when the contents are copied over - but the server
       * zeroes every one of them on save. Leaving the running total showing Rp1.940.000
       * beside the word "Ditagih" would be the screen disagreeing with the record it is
       * about to write, which is the one thing a form like this cannot do.
       */
      form.querySelector('[data-sum-total]').textContent = rupiah(0);
      form.querySelector('[data-total-field]').value = '0';
      go.disabled = !(hasReplacement() && wrongValue > 0 && linked.value.trim().length > 0);
    } else {
      /*
       * Gated on a finished line, not on a total above zero.
       *
       * A sample or a gift is typed in at full price with a 100% discount, so that the
       * books show what went out and what it was worth; the server and Jurnal both take a
       * Rp0 invoice. Requiring a positive total kept that one honest entry unsaveable.
       */
      go.disabled = complete === 0;
    }
    // The confirmation quotes what is actually about to be written - the house rule for
    // anything that writes - so it is rebuilt whenever the numbers change.
    form.dataset.confirm = editing
      ? 'Simpan perubahan pada ' + code + ' senilai ' + rupiah(goods + ship) + ' dan perbarui fakturnya di Mekari Jurnal?'
      : 'Simpan ' + ((codeField && codeField.value) || 'transaksi') +
        ' senilai ' + rupiah(goods + ship) + ' dan kirim ke Mekari Jurnal?';
    return goods + ship;
  }

  function wire(row) {
    row.querySelectorAll('input[type="number"]').forEach(function (input) {
      // Same rule as everywhere else on this dashboard: a focused number field must not
      // change value because the page scrolled past it.
      input.addEventListener('wheel', function (e) {
        if (document.activeElement !== input) return;
        e.preventDefault();
        input.blur();
      }, { passive: false });
    });
    // Rp or %, one click, and the field's own limits follow: a percentage over a
    // hundred is not a discount, it is a mistake the browser can catch on the spot.
    row.querySelectorAll('.seg__b').forEach(function (button) {
      button.addEventListener('click', function () {
        var hidden = row.querySelector('[name="discountMode"]');
        if (hidden.value === button.dataset.mode) return;
        hidden.value = button.dataset.mode;
        row.querySelectorAll('.seg__b').forEach(function (other) {
          var on = other === button;
          other.classList.toggle('is-on', on);
          other.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        var field = row.querySelector('[name="unitDiscount"]');
        if (button.dataset.mode === 'pct') field.setAttribute('max', '100');
        else field.removeAttribute('max');
        total();
      });
    });

    row.querySelector('[data-remove]').addEventListener('click', function () {
      if (lines.querySelectorAll('[data-row]').length === 1) {
        row.querySelector('select').value = '';
        row.querySelector('[name="unitPrice"]').value = '';
      } else {
        row.remove();
      }
      total();
    });
  }

  // Every row, not just the first: an edited transaction opens with as many rows as it
  // has lines, and the ones past the first had no working remove button or discount
  // toggle at all.
  Array.prototype.forEach.call(lines.querySelectorAll('[data-row]'), wire);

  document.getElementById('addln').addEventListener('click', function () {
    var row = template.cloneNode(true);
    // Emptied field by field, because when editing, the row this was cloned from is a
    // filled one - a new line that arrives carrying somebody else's quantity and
    // discount is worse than no shortcut at all.
    row.querySelector('select').value = '';
    row.querySelector('[name="unitPrice"]').value = '';
    row.querySelector('[name="qty"]').value = '1';
    var discount = row.querySelector('[name="unitDiscount"]');
    discount.value = '0';
    discount.removeAttribute('max');
    row.querySelector('[name="discountMode"]').value = 'rp';
    Array.prototype.forEach.call(row.querySelectorAll('.seg__b'), function (button) {
      var on = button.dataset.mode === 'rp';
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var picture = row.querySelector('.ln__pic');
    picture.hidden = true;
    picture.removeAttribute('src');
    row.querySelector('[data-line-total]').textContent = '\\u2014';
    lines.appendChild(row);
    wire(row);
    row.querySelector('select').focus();
    total();
  });

  form.addEventListener('input', function (e) {
    if (e.target === codeField) codeIsOurs = false;
    total();
  });
  /**
   * Changing the product changes the price with it.
   *
   * It used to fill an empty field only, and leave anything already typed alone. That
   * read as careful and was wrong: switch a row from the 60-day protocol to a 30 ml oil
   * and the line still said Rp1.265.000, because the price belonged to the product that
   * had just been replaced. A price is a fact about one product, so it follows the
   * product; a consignment discount is typed after the choice, not before it.
   *
   * Clearing the product clears the price too, for the same reason.
   */
  function syncPrice(select) {
    var row = select.closest('[data-row]');
    var field = row.querySelector('[name="unitPrice"]');
    var option = select.options[select.selectedIndex];
    var price = option ? Number(option.dataset.price) : 0;
    // Zero is written, not left blank: the storefront gives this away, and an empty box
    // would look like a price nobody had filled in yet.
    field.value = select.value ? String(price) : '';
  }

  form.addEventListener('change', function (e) {
    if (e.target.name === 'sku') { showPicture(e.target.closest('[data-row]')); syncPrice(e.target); }
    if (e.target.name === 'source') {
      // An empty name bills the source itself, and the hint says which.
      if (customerHint) customerHint.textContent = 'Kosong: ditagih atas nama ' + e.target.dataset.label;
      refreshCode();
    }
    if (e.target === dateField) refreshCode();
    if (e.target.name === 'source') shape();
    total();
  });

  if (wlines) {
    var wTemplate = wlines.firstElementChild.cloneNode(true);
    document.getElementById('addwln').addEventListener('click', function () {
      var row = wTemplate.cloneNode(true);
      row.querySelector('select').value = '';
      row.querySelector('[name="wunitPrice"]').value = '';
      row.querySelector('[name="wqty"]').value = '1';
      row.querySelector('[data-wrong-total]').textContent = '\\u2014';
      wlines.appendChild(row);
      wireWrong(row);
      row.querySelector('select').focus();
      total();
    });
    Array.prototype.forEach.call(wlines.querySelectorAll('[data-wrong]'), wireWrong);
  }

  // The value of a wrong parcel is what the storefront sells it for, which the option
  // already carries - so picking the product is enough and nobody has to look it up.
  function wireWrong(row) {
    row.querySelector('select').addEventListener('change', function (e) {
      var option = e.target.options[e.target.selectedIndex];
      var price = option ? Number(option.dataset.price) : 0;
      row.querySelector('[name="wunitPrice"]').value = e.target.value ? String(price) : '';
      total();
    });
    row.querySelector('[data-remove-wrong]').addEventListener('click', function () {
      if (wlines.querySelectorAll('[data-wrong]').length === 1) {
        row.querySelector('select').value = '';
        row.querySelector('[name="wunitPrice"]').value = '';
      } else {
        row.remove();
      }
      total();
    });
    row.querySelectorAll('input[type="number"]').forEach(function (input) {
      input.addEventListener('wheel', function (e) {
        if (document.activeElement !== input) return;
        e.preventDefault();
        input.blur();
      }, { passive: false });
    });
  }

  /*
   * Choosing the order a mistake belongs to, while it is being typed.
   *
   * Recording a resend against the wrong order is a worse mistake than the one being
   * recorded, so this never asks anybody to remember an order number exactly. Four
   * characters is enough to ask the server - fewer matches everything and is a scan of the
   * whole table for nothing - and what comes back is shown with the buyer and the contents,
   * which is what a person actually recognises an order by.
   *
   * Keyboard throughout: a combobox that can only be used with a mouse is one half the
   * bench cannot use at all.
   */
  if (linked) {
    var picks = document.getElementById('rs-picks');
    var status = document.getElementById('rs-status');
    var preview = document.getElementById('rs-preview');
    var channelField = document.getElementById('resendChannel');
    var pickTimer = null;
    var pickSeq = 0;
    var active = -1;

    var options = function () { return Array.prototype.slice.call(picks.querySelectorAll('.pick0')); };

    function closeList() {
      picks.hidden = true;
      linked.setAttribute('aria-expanded', 'false');
      linked.removeAttribute('aria-activedescendant');
      active = -1;
    }

    function highlight(next) {
      var rows = options();
      if (rows.length === 0) return;
      active = (next + rows.length) % rows.length;
      rows.forEach(function (row, i) {
        var on = i === active;
        row.classList.toggle('is-on', on);
        row.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          linked.setAttribute('aria-activedescendant', row.id);
          row.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    /** Whether anybody has named a replacement product yet. */
    function replacementEmpty() {
      return Array.prototype.slice.call(lines.querySelectorAll('[data-row]'))
        .every(function (row) { return !row.querySelector('select').value; });
    }

    /** Back to one blank row, for when the chosen order is swapped for another. */
    function clearReplacement() {
      var rows = Array.prototype.slice.call(lines.querySelectorAll('[data-row]'));
      rows.slice(1).forEach(function (row) { row.remove(); });
      var first = lines.querySelector('[data-row]');
      first.querySelector('select').value = '';
      first.querySelector('select').dispatchEvent(new Event('change', { bubbles: true }));
      first.querySelector('[name="qty"]').value = '1';
    }

    /**
     * Fill a replacement row per line of the chosen order.
     *
     * What the customer ordered is what now has to be sent - that is the whole of a
     * resend - so it is done on choosing rather than offered as a button to press. It
     * never overwrites: a row somebody has already named a product in is a decision, and
     * the only thing that may undo it is the button saying so in as many words.
     */
    function useContents(card, button) {
      var pairs = (card.dataset.fill || '').split(',').filter(Boolean);
      if (pairs.length === 0) return false;
      var rows = Array.prototype.slice.call(lines.querySelectorAll('[data-row]'));
      pairs.forEach(function (pair, i) {
        var bits = pair.split(':');
        // The first line reuses the row already on screen; the rest add their own.
        if (i >= rows.length) document.getElementById('addln').click();
        var row = lines.querySelectorAll('[data-row]')[i];
        row.querySelector('select').value = bits[0];
        row.querySelector('select').dispatchEvent(new Event('change', { bubbles: true }));
        row.querySelector('[name="qty"]').value = bits[1] || '1';
      });
      if (button) {
        button.textContent = pairs.length + ' baris pengganti terisi dari pesanan ini';
        button.classList.add('is-done');
        button.disabled = true;
      }
      total();
      return true;
    }

    function choose(row) {
      linked.value = row.dataset.id;
      channelField.value = row.dataset.channel;
      // A template's children live in a document fragment, so they are cloned out of
      // .content - innerHTML on the element itself hands back markup, not nodes.
      var card0 = row.querySelector('.pick0__prev');
      preview.innerHTML = '';
      preview.appendChild(card0.content.cloneNode(true));
      preview.hidden = false;
      status.textContent = 'Terpilih: ' + row.dataset.channel + ' ' + row.dataset.id;

      var card = preview.querySelector('.prev');
      // The parcel goes to the same person at the same address as the one that went wrong.
      // Filled in rather than left for the server, so the operator can see and correct it.
      [['buyer', 'buyer'], ['buyerPhone', 'phone'], ['buyerEmail', 'email'], ['shipTo', 'shipto']]
        .forEach(function (pair) {
          var field = form.querySelector('[name="' + pair[0] + '"]');
          if (field && !field.value && card.dataset[pair[1]]) field.value = card.dataset[pair[1]];
        });

      var use = preview.querySelector('[data-use]');
      // Done, not offered. The button stays for the case this skipped - rows already
      // filled in by hand, which are a decision and not an empty space to write into.
      var filled = replacementEmpty() && useContents(card, use);

      var swap = preview.querySelector('[data-swap]');
      if (swap) {
        swap.addEventListener('click', function () {
          // Whatever this filled in belongs to the order being swapped away, so it goes
          // with it. Anything typed by hand is left exactly where it is.
          if (filled) clearReplacement();
          preview.hidden = true;
          channelField.value = '';
          linked.value = '';
          linked.focus();
          status.textContent = 'Ketik minimal 4 karakter dari order ID';
          total();
        });
      }
      if (use && !filled) use.addEventListener('click', function () { useContents(card, use); });

      closeList();
      total();
    }

    function lookup(fragment) {
      var mine = ++pickSeq;
      status.textContent = 'Mencari\u2026';
      fetch('?view=jurnal&add=1&lookup=' + encodeURIComponent(fragment), { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          // An answer to a fragment the operator has already typed past is not an answer.
          if (mine !== pickSeq) return;
          picks.innerHTML = data.rows || '';
          picks.hidden = false;
          linked.setAttribute('aria-expanded', 'true');
          active = -1;
          var rows = options();
          rows.forEach(function (row) {
            row.addEventListener('mousedown', function (e) { e.preventDefault(); });
            row.addEventListener('click', function () { choose(row); });
          });
          /*
           * One match is not a choice.
           *
           * Leaving a single row to be clicked is asking somebody to confirm the only
           * possible answer, and the list closes the moment the field loses focus - which
           * is how an operator typed a whole order number, read "1 pesanan cocok", and was
           * shown nothing at all.
           */
          if (data.count === 1) { choose(rows[0]); return; }
          status.textContent = data.count > 0
            ? data.count + ' pesanan cocok - pilih satu'
            : 'Tidak ada pesanan dengan order ID itu';
        })
        .catch(function () {
          if (mine !== pickSeq) return;
          status.textContent = 'Pencarian gagal - coba lagi sebentar';
        });
    }

    linked.addEventListener('input', function () {
      channelField.value = '';
      preview.hidden = true;
      window.clearTimeout(pickTimer);
      var bare = linked.value.replace(/[^A-Za-z0-9-]/g, '');
      if (bare.length < 4) {
        closeList();
        status.textContent = 'Ketik minimal 4 karakter dari order ID';
        total();
        return;
      }
      // Long enough to not chase every keystroke, short enough that it still feels typed.
      pickTimer = window.setTimeout(function () { lookup(bare); }, 250);
      total();
    });

    linked.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeList(); return; }
      if (picks.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
      else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(options()[active]); }
    });

    // Leaving the field closes the list; mousedown on a row is prevented above, so a click
    // on one lands before this ever runs.
    linked.addEventListener('blur', function () { window.setTimeout(closeList, 150); });
    // And coming back to a field with results still in it reopens them, rather than
    // leaving a status line describing a list that is no longer there.
    linked.addEventListener('focus', function () {
      if (preview.hidden && options().length > 0) {
        picks.hidden = false;
        linked.setAttribute('aria-expanded', 'true');
      }
    });
  }

  /*
   * What was typed survives a refusal.
   *
   * A sale the server turns down comes back to this form with the reason on top, and it
   * used to come back empty: the email Ika typed was wrong, and the products, prices and
   * the 100% discount went with it. The draft is kept in this tab only, written on the
   * press and dropped the moment a save goes through; the code is not restored, because
   * a fresh one is reserved for every opening of the form.
   */
  var DRAFT = 'mx-draft';
  var params = new URLSearchParams(location.search);
  if (form.querySelector('[name="action"]').value === 'manual_invoice') {
    if (params.has('error')) {
      var draft = null;
      try { draft = JSON.parse(sessionStorage.getItem(DRAFT) || 'null'); } catch (e) {}
      if (draft && draft.source !== 'RS') {
        var pick = form.querySelector('input[name="source"][value="' + draft.source + '"]');
        if (pick) { pick.checked = true; pick.dispatchEvent(new Event('change', { bubbles: true })); }
        ['date', 'shipping', 'buyer', 'buyerPhone', 'buyerEmail', 'shipTo', 'carrier', 'note'].forEach(function (name) {
          var field = form.querySelector('[name="' + name + '"]:not([type="hidden"])') || form.querySelector('[name="' + name + '"]');
          if (field && draft.fields && draft.fields[name] !== undefined) field.value = draft.fields[name];
        });
        (draft.lines || []).forEach(function (line, index) {
          if (index > 0) document.getElementById('addln').click();
          var row = lines.querySelectorAll('[data-row]')[index];
          if (!row) return;
          var select = row.querySelector('select');
          select.value = line.sku;
          showPicture(row);
          row.querySelector('[name="qty"]').value = line.qty;
          row.querySelector('[name="unitPrice"]').value = line.unitPrice;
          row.querySelector('[name="unitDiscount"]').value = line.unitDiscount;
          var mode = row.querySelector('.seg__b[data-mode="' + (line.discountMode === 'pct' ? 'pct' : 'rp') + '"]');
          if (mode) mode.click();
        });
        if (dateField.value) refreshCode();
      }
    } else {
      try { sessionStorage.removeItem(DRAFT); } catch (e) {}
    }
    form.addEventListener('submit', function () {
      var source = form.querySelector('input[name="source"]:checked');
      var fields = {};
      ['date', 'shipping', 'buyer', 'buyerPhone', 'buyerEmail', 'shipTo', 'carrier', 'note'].forEach(function (name) {
        var field = form.querySelector('[name="' + name + '"]:not([type="hidden"])') || form.querySelector('[name="' + name + '"]');
        if (field) fields[name] = field.value;
      });
      var kept = Array.prototype.map.call(lines.querySelectorAll('[data-row]'), function (row) {
        return {
          sku: row.querySelector('select').value,
          qty: row.querySelector('[name="qty"]').value,
          unitPrice: row.querySelector('[name="unitPrice"]').value,
          unitDiscount: row.querySelector('[name="unitDiscount"]').value,
          discountMode: row.querySelector('[name="discountMode"]').value,
        };
      }).filter(function (l) { return l.sku; });
      try { sessionStorage.setItem(DRAFT, JSON.stringify({ source: source ? source.value : '', fields: fields, lines: kept })); } catch (e) {}
    });
  }

  shape();

  total();
}());`,
  });
}

const URGENCY_META = {
  stockout: { label: 'Habis', tone: 'stockout' },
  critical: { label: 'Kritis', tone: 'critical' },
  watch: { label: 'Awasi', tone: 'watch' },
  ok: { label: 'Aman', tone: 'ok' },
  idle: { label: 'Diam', tone: 'idle' },
};

/**
 * Twelve weeks of demand as a sparkline, drawn inline.
 *
 * No chart library: one path is less code than loading one, and the page has no external
 * requests beyond its font. A flat series draws a flat line rather than dividing by zero.
 */
function sparkline(weekly = []) {
  if (weekly.length < 2) return '<span class="dim">&mdash;</span>';
  const w = 92;
  const h = 26;
  const max = Math.max(...weekly, 1);
  const step = w / (weekly.length - 1);
  const points = weekly.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`);
  return `<svg class="fc__spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="Permintaan 12 minggu terakhir, puncak ${max}">
    <path d="M${points.join(' L')}"/>
  </svg>`;
}

/**
 * Forecast view: what will sell, and what to do about it.
 *
 * Every number carries the accuracy it was measured at. A row whose model never beat
 * "same as last week" says so, because the honest reading of that is "this SKU is not
 * predictable, use judgement" - not a figure to order against.
 */
export function renderForecast({ forecast, range, errors, shopeeShop, generatedAt, csrf, flash, user = null }) {
  if (!forecast) {
    return shell({ user,
      csrf,
      title: 'Prakiraan stok', range, errors, shopeeShop, generatedAt, view: 'forecast', flash,
      hideRangeControls: true,
      body: '<p class="empty">Belum ada prakiraan.</p>',
    });
  }

  const h = forecast.history;
  const counts = forecast.counts ?? {};
  const rows = (forecast.rows ?? []).map((r) => {
    const u = URGENCY_META[r.urgency] ?? URGENCY_META.idle;
    if (r.status !== 'ok') {
      return `<tr>
        <td><span class="pick__n">${escape(r.name)}</span><span class="pick__s mono">${escape(r.sku)}</span></td>
        <td class="num mono">${r.onHand ?? '<span class="dim">&mdash;</span>'}</td>
        <td colspan="5" class="dim">Belum cukup riwayat (${r.historyDays} hari; butuh 42) &mdash; belum ada ramalan yang bisa diperiksa</td>
      </tr>`;
    }
    const f30 = r.forecasts[30] ?? {};
    const a30 = r.accuracy[30] ?? {};
    const stock = r.stock ?? {};
    const maseClass = a30.beatsNaive ? 'fc__mase--good' : 'fc__mase--poor';
    return `<tr>
      <td>
        <span class="pick__n">${escape(r.name)}</span>
        <span class="pick__s mono">${escape(r.sku)}</span>
      </td>
      <td class="num mono">${r.onHand ?? '<span class="dim">&mdash;</span>'}</td>
      <td class="num mono">${stock.daysOfCover ?? '<span class="dim">&mdash;</span>'}
        ${stock.stockoutDate ? `<span class="fc__why">${escape(stock.stockoutDate)}</span>` : ''}</td>
      <td class="num">
        <b class="fc__p50 mono">${f30.p50 ?? '&mdash;'}</b>
        <span class="fc__range">${f30.p10 ?? '?'}&ndash;${f30.p90 ?? '?'}</span>
      </td>
      <td>${sparkline(r.weekly)}</td>
      <td class="num"><b class="fc__qty">${stock.reorderQty > 0 ? stock.reorderQty : '<span class="dim">0</span>'}</b></td>
      <td>
        <span class="fc__u fc__u--${u.tone}">${escape(u.label)}</span>
        <span class="fc__why">${escape(a30.modelName ?? '')} &middot; MASE <span class="${maseClass}">${a30.mase ?? '?'}</span>${
          a30.beatsNaive ? '' : ' &middot; tak lebih baik dari pola minggu lalu'}</span>
      </td>
    </tr>`;
  }).join('');

  return shell({ user,
    csrf,
    title: 'Prakiraan stok',
    range, errors, shopeeShop, generatedAt, view: 'forecast', flash,
    hideRangeControls: true,
    kpis: `
      <div class="strip">
        ${stat('Habis', String(counts.stockout ?? 0), counts.stockout ? 'stop' : '')}
        ${stat('Kritis', String(counts.critical ?? 0), counts.critical ? 'stop' : '')}
        ${stat('Awasi', String(counts.watch ?? 0), counts.watch ? 'flag' : '')}
        ${stat('Aman', String(counts.ok ?? 0), 'ok')}
        <span class="strip__grow"></span>
        <span class="note">Lead time ${forecast.policy.leadTimeDays} hari &middot; review ${forecast.policy.reviewDays} hari</span>
      </div>`,
    body: `
      <div class="fc__note">
        Dihitung dari <b>${Number(h.orders).toLocaleString('id-ID')}</b> pesanan berbayar
        (${escape(h.from ?? '?')} s/d ${escape(h.to ?? '?')}), ${Number(h.excluded).toLocaleString('id-ID')} batal/retur dikeluarkan.
        Bundel dipecah ke komponennya &mdash; yang diramal adalah barang yang benar-benar diproduksi.
        Tiap angka membawa <b>MASE</b>-nya: di bawah 1 berarti lebih baik daripada menebak &ldquo;sama seperti minggu lalu&rdquo;.
        Rentang p10&ndash;p90 berasal dari kesalahan model ini sendiri pada data yang disembunyikan, bukan dari asumsi.
        Terakhir dihitung ${escape(wibStamp(forecast.generated_at))}.
      </div>
      ${rows ? `<div class="scroll"><table class="dense">
        <thead><tr>
          <th>Produk</th><th class="num">Stok</th><th class="num">Hari tersisa</th>
          <th class="num">30 hari (p10&ndash;p90)</th><th>12 minggu</th><th class="num">Pesan</th><th>Status &amp; akurasi</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : '<p class="empty">Tidak ada SKU untuk diramal.</p>'}
      <div class="foot"><span>${(forecast.rows ?? []).length} SKU komponen</span></div>`,
  });
}

const STAR_PATH = 'M12 2.5l2.9 6.1 6.7.8-4.9 4.6 1.3 6.6L12 17.3l-6 3.3 1.3-6.6L2.4 9.4l6.7-.8L12 2.5z';
const rvIcon = {
  camera: '<path d="M6.8 7.5h1.4l1.1-2h5.4l1.1 2h1.4A2.3 2.3 0 0 1 19.5 9.8v7A2.3 2.3 0 0 1 17.2 19H6.8a2.3 2.3 0 0 1-2.3-2.3v-7a2.3 2.3 0 0 1 2.3-2.2Z"/><circle cx="12" cy="13" r="3"/>',
  play: '<path d="M8 6.5v11l9-5.5-9-5.5Z"/>',
  reply: '<path d="M9.5 8 5 12.5l4.5 4.5M5.5 12.5H14a5 5 0 0 1 5 5V19"/>',
  external: '<path d="M14 5h5v5M19 5l-8.5 8.5M17 13.5V17a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3.5"/>',
  chevronL: '<path d="m15 5-7 7 7 7"/>',
  chevronR: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  thumb: '<path d="M7 11v9H4v-9h3Zm3 9h6.6a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 17.8 10H14V6.2A2.2 2.2 0 0 0 11.8 4L10 11v9Z"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
};
const rvSvg = (name, cls = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${rvIcon[name]}</svg>`;

/** Five stars as one accessible figure; the fill colour says low or fine, the label says the number. */
const rvStars = (n, low) =>
  `<span class="rv__stars ${low ? 'rv__stars--low' : ''}" role="img" aria-label="${n} dari 5 bintang">${
    [1, 2, 3, 4, 5].map((i) => `<svg viewBox="0 0 24 24" class="rv__star ${i <= n ? 'is-on' : ''}" aria-hidden="true"><path d="${STAR_PATH}"/></svg>`).join('')
  }</span>`;

const REVIEW_RATING_OPTIONS = [
  ['', 'Semua bintang'], ['1,2,3', '≤ 3 bintang'], ['4', '4 bintang'], ['5', '5 bintang'],
];
const REVIEW_DAYS_OPTIONS = [['', 'Sepanjang waktu'], ['7', '7 hari'], ['30', '30 hari'], ['90', '90 hari'], ['365', '1 tahun']];
const REVIEW_CHANNEL_OPTIONS = [['', 'Semua kanal'], ...Object.entries(REVIEW_CHANNELS).map(([id, m]) => [id, m.label])];

const channelBadge = (channel) => {
  const meta = REVIEW_CHANNELS[channel] ?? REVIEW_CHANNELS.tokopedia;
  return `<span class="rv__ch rv__ch--${escape(channel)}" style="--ch:${meta.accent}"><span class="rv__ch-dot" aria-hidden="true"></span>${escape(meta.label)}</span>`;
};

const initialOf = (name) => {
  const s = String(name ?? '').trim();
  return s ? s[0].toUpperCase() : '?';
};

/** One review card. Photos link to our media cache and open in the lightbox. */
function reviewCard(r, mediaUrl) {
  const low = r.rating <= 3;
  const when = r.createdAt
    ? `<time datetime="${escape(r.createdAt)}">${dateTime(r.createdAtEpoch, r.channel)}</time>${
        r.createdAtPrecision === 'approx' ? ' <span class="rv__approx" title="perkiraan dari teks relatif">~</span>' : ''}`
    : '<span class="dim">&mdash;</span>';
  const name = r.anonymous ? 'Anonim' : r.reviewerName || 'Pembeli';
  const channel = r.channel ?? 'tokopedia';
  const productLabel = r.variantName ? `${r.variantName}` : r.productName;
  const productHref = channel === 'tokopedia' ? `${r.productUrl}/review` : r.productUrl;
  const product = r.productUrl
    ? `<a class="rv__product" href="${escape(productHref)}" target="_blank" rel="noopener" title="${escape(r.productName)}">${escape(productLabel)}${rvSvg('external', 'rv__ext')}</a>`
    : `<span class="rv__product" title="${escape(r.productName)}">${escape(productLabel)}</span>`;

  const photos = (r.images ?? []).map((img, i, all) => `
        <button type="button" class="rv__photo" data-full="${escape(mediaUrl(img.id, 'full'))}" data-caption="${escape(`${name} · ${productLabel} · foto ${i + 1} dari ${all.length}`)}" aria-label="Buka foto ${i + 1} dari ${all.length}">
          <img src="${escape(mediaUrl(img.id, 'thumb'))}" alt="Foto ulasan ${i + 1} dari ${escape(name)}" width="84" height="84" loading="lazy" decoding="async">
        </button>`).join('');
  const videos = (r.videos ?? []).filter((v) => v.url).map((v, i) => `
        <a class="rv__video" href="${escape(v.url)}" target="_blank" rel="noopener">${rvSvg('play')}Video ${i + 1}</a>`).join('');
  const gallery = photos || videos ? `<div class="rv__gallery" role="group" aria-label="Lampiran ulasan">${photos}${videos}</div>` : '';

  const status = r.reply
    ? `<span class="rv__pill rv__pill--done">${rvSvg('reply')}Dibalas</span>`
    : `<span class="rv__pill ${low ? 'rv__pill--bad' : 'rv__pill--warn'}">Belum dibalas</span>`;

  return `<article class="rv ${low ? 'rv--low' : ''} ${low && !r.reply ? 'rv--open' : ''}">
      <header class="rv__head">
        <div class="rv__who">
          <span class="rv__avatar" aria-hidden="true">${escape(initialOf(name))}</span>
          <div>
            <span class="rv__name">${escape(name)}</span>
            <span class="rv__when">${when}</span>
          </div>
        </div>
        ${rvStars(r.rating, low)}
        <div class="rv__sku">
          ${channelBadge(channel)}
          ${r.sku ? `<span class="rv__chip mono">${escape(r.sku)}</span>` : '<span class="rv__chip rv__chip--none">tanpa SKU</span>'}
          ${product}
        </div>
        <div class="rv__status">${r.hidden ? '<span class="rv__pill">Disembunyikan</span>' : ''}${status}</div>
      </header>
      <div class="rv__body">
        ${r.text ? `<p class="rv__text">${escape(r.text)}</p>` : '<p class="rv__text rv__text--none">Tanpa teks, hanya bintang.</p>'}
        ${r.badRatingReason ? `<p class="rv__reason">${escape(r.badRatingReason)}</p>` : ''}
        ${gallery}
        ${r.likes ? `<span class="rv__likes">${rvSvg('thumb')}${r.likes} terbantu</span>` : ''}
        ${r.reply ? `<blockquote class="rv__reply"><span class="rv__reply-tag">${rvSvg('reply')}Balasan toko${r.reply.relative ? ` · ${escape(r.reply.relative)}` : ''}</span>${escape(r.reply.text)}</blockquote>` : ''}
      </div>
    </article>`;
}

const REVIEW_LIGHTBOX_SCRIPT = `
(() => {
  const lb = document.getElementById('rv-lightbox');
  if (!lb || typeof lb.showModal !== 'function') return;
  const img = lb.querySelector('img');
  const cap = lb.querySelector('.rv__lb-cap');
  const count = lb.querySelector('.rv__lb-count');
  const buttons = () => Array.from(document.querySelectorAll('.rv__photo'));
  let set = [], at = 0, opener = null;
  const show = (i) => {
    at = (i + set.length) % set.length;
    const b = set[at];
    img.src = b.dataset.full; img.alt = b.querySelector('img').alt;
    cap.textContent = b.dataset.caption;
    count.textContent = set.length > 1 ? (at + 1) + ' / ' + set.length : '';
    lb.querySelector('.rv__lb-prev').hidden = set.length < 2;
    lb.querySelector('.rv__lb-next').hidden = set.length < 2;
  };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.rv__photo');
    if (!b) return;
    const group = b.closest('.rv__gallery');
    set = Array.from(group.querySelectorAll('.rv__photo'));
    opener = b;
    show(set.indexOf(b));
    lb.showModal();
  });
  lb.querySelector('.rv__lb-prev').addEventListener('click', () => show(at - 1));
  lb.querySelector('.rv__lb-next').addEventListener('click', () => show(at + 1));
  lb.querySelector('.rv__lb-close').addEventListener('click', () => lb.close());
  lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
  lb.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') show(at - 1);
    if (e.key === 'ArrowRight') show(at + 1);
  });
  lb.addEventListener('close', () => { img.removeAttribute('src'); if (opener) opener.focus(); });
})();`;

/**
 * Reviews view: what buyers wrote on Tokopedia and Shopee, newest first, photos included.
 *
 * The page only reads the documents the nightly syncs wrote; a click here never touches
 * a marketplace. Photos come from our own cache (see media.js), so they do not break
 * when Tokopedia's signed URLs expire. Low ratings are the reason the page exists: they
 * are marked on the card, counted in the strip, and one filter click away.
 */
export function renderReviews({
  doc, stats, reviews, filter = {}, range, errors = {}, shopeeShop, generatedAt, csrf, flash, mediaUrl = defaultMediaUrl,
  paging = { page: 1, perPage: DEFAULT_PER_PAGE }, baseQuery = '', user = null,
}) {
  if (!doc?.syncedAt) {
    return shell({ user,
      csrf,
      title: 'Ulasan', range, errors, shopeeShop, generatedAt, view: 'reviews', flash,
      hideRangeControls: true,
      body: '<p class="empty">Belum ada ulasan tersimpan.</p>',
    });
  }

  const channels = doc.channels ?? {};
  // Star counts across both marketplaces: Tokopedia's come from its shop summary (the
  // storefront lists only written reviews), Shopee's from the ratings themselves.
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const c of Object.values(channels)) {
    for (const [star, n] of Object.entries(c.summary?.distribution ?? {})) dist[star] = (dist[star] ?? 0) + (n ?? 0);
  }
  const distTotal = Object.values(dist).reduce((a, b) => a + b, 0);
  const distRows = [5, 4, 3, 2, 1].map((n) => {
    const count = dist[n] ?? 0;
    const pct = distTotal ? Math.round((count / distTotal) * 1000) / 10 : 0;
    return `<a class="rv__dist-row" href="?view=reviews&rating=${n}" title="Lihat ulasan ${n} bintang">
      <span class="rv__dist-label">${n}<svg viewBox="0 0 24 24" class="rv__star is-on rv__star--sm" aria-hidden="true"><path d="${STAR_PATH}"/></svg></span>
      <span class="rv__dist-bar"><span class="rv__dist-fill ${n <= 3 ? 'is-low' : ''}" style="width:${pct}%"></span></span>
      <span class="rv__dist-n mono">${count.toLocaleString('id-ID')}<span class="dim"> · ${pct}%</span></span>
    </a>`;
  }).join('');

  const skuOptions = Object.entries(stats.bySku ?? {})
    .filter(([sku]) => !sku.startsWith('(tanpa SKU)'))
    .map(([sku, b]) => `<option value="${escape(sku)}" ${filter.sku === sku ? 'selected' : ''}>${escape(sku)} (${b.count})</option>`)
    .join('');
  const options = (list, current) =>
    list.map(([v, label]) => `<option value="${v}" ${(current ?? '') === v ? 'selected' : ''}>${escape(label)}</option>`).join('');

  const withPhotos = reviews.filter((r) => r.images?.length).length;
  const paged = paginate(reviews, paging);
  const cards = paged.items.map((r) => reviewCard(r, mediaUrl)).join('');
  const reviewPager = (top) => pager(paged, { baseQuery, noun: 'ulasan' }).replace('class="pager"', top ? 'class="pager pager--top"' : 'class="pager"');

  const skuRows = Object.entries(stats.bySku ?? {}).map(([sku, b]) => `<tr>
      <td>${sku.startsWith('(tanpa SKU)') ? `<span class="dim">${escape(sku)}</span>` : `<a class="mono" href="?view=reviews&sku=${escape(encodeURIComponent(sku))}">${escape(sku)}</a>`}</td>
      <td class="num mono">${b.count}</td>
      <td class="num mono">${b.average ?? '&mdash;'}</td>
      <td class="num mono ${b.low ? 'stop' : ''}">${b.low}</td>
    </tr>`).join('');

  const lightbox = `
    <dialog id="rv-lightbox" class="rv__lb" aria-label="Foto ulasan">
      <button type="button" class="rv__lb-btn rv__lb-close" aria-label="Tutup">${rvSvg('close')}</button>
      <button type="button" class="rv__lb-btn rv__lb-prev" aria-label="Foto sebelumnya">${rvSvg('chevronL')}</button>
      <figure class="rv__lb-fig">
        <img alt="" decoding="async">
        <figcaption><span class="rv__lb-cap"></span><span class="rv__lb-count mono"></span></figcaption>
      </figure>
      <button type="button" class="rv__lb-btn rv__lb-next" aria-label="Foto berikutnya">${rvSvg('chevronR')}</button>
    </dialog>`;

  const channelStats = Object.entries(REVIEW_CHANNELS)
    .filter(([id]) => channels[id]?.syncedAt)
    .map(([id, meta]) => {
      const c = channels[id];
      const score = c.summary?.score ? String(c.summary.score) : '—';
      return stat(meta.label, `${score} · ${(c.summary?.totalRatings ?? 0).toLocaleString('id-ID')}`, 'ok');
    })
    .join('');
  const syncNotes = Object.entries(REVIEW_CHANNELS)
    .map(([id, meta]) => channels[id]?.syncedAt ? `${meta.label} ${wibStamp(channels[id].syncedAt)}` : `${meta.label} belum disinkronkan`)
    .join(' · ');
  const tokopediaLink = `<a href="https://www.tokopedia.com/${escape(loadTokopediaSlug())}/review" target="_blank" rel="noopener">${escape(channels.tokopedia?.shopName || 'Tokopedia')}${rvSvg('external', 'rv__ext')}</a>`;
  const shopeeNote = channels.shopee?.syncedAt
    ? `Shopee lewat Open API resmi, <b>termasuk penilaian tanpa teks</b>.`
    : 'Shopee belum disinkronkan.';

  return shell({ user,
    csrf,
    title: 'Ulasan',
    range, errors, shopeeShop, generatedAt, view: 'reviews', flash,
    hideRangeControls: true,
    script: REVIEW_LIGHTBOX_SCRIPT,
    kpis: `
      <div class="strip">
        ${channelStats}
        ${stat('Ulasan', String(stats.written.count))}
        ${stat('≤ 3 bintang', String(stats.written.low), stats.written.low ? 'flag' : '')}
        ${stat('Belum dibalas', String(stats.unreplied), stats.unreplied ? 'flag' : '')}
        ${stat('30 hari', `${stats.last30Days.count} · ${stats.last30Days.average ?? '—'}`, stats.last30Days.low ? 'stop' : '')}
        <span class="strip__grow"></span>
        <span class="rv__acts">
          <span class="note">Sinkron ${escape(syncNotes)}</span>
          ${csrf ? `<form method="post" action="/api/dashboard" class="rv__sync">
            <input type="hidden" name="csrf" value="${escape(csrf)}">
            <input type="hidden" name="view" value="reviews">
            <button class="cta" type="submit" name="action" value="reviews_sync"
                    data-confirm-text="Ambil ulasan baru dari Tokopedia dan Shopee sekarang? Butuh sekitar satu menit.">${svg('refresh')}<span>Ambil ulasan baru</span></button>
          </form>` : ''}
          <a class="chip rv__csv" href="${escape(`?${baseQuery}${baseQuery ? '&' : 'view=reviews&'}export=klaviyo`)}" download>${rvSvg('download')}Unduh CSV Klaviyo</a>
        </span>
      </div>`,
    body: `
      <section class="rv__top">
        <div class="rv__dist" aria-label="Sebaran bintang">${distRows}</div>
        <div class="rv__about">
          <p>Tokopedia dibaca dari halaman toko ${tokopediaLink}: hanya ulasan yang <b>ditulis</b> yang muncul sebagai kartu, penilaian bintang tanpa teks hanya masuk hitungan${channels.tokopedia?.summary?.aggregatedWithTikTok ? ' (gabungan dengan TikTok Shop)' : ''}.
          ${shopeeNote}
          Foto disimpan di server sendiri, jadi tetap terbuka walau tautan marketplace kedaluwarsa. Tanggal dengan <b>~</b> adalah perkiraan.</p>
        </div>
      </section>
      <form class="rv__filters" method="get" role="search" aria-label="Saring ulasan">
        <input type="hidden" name="view" value="reviews">
        <label class="rv__field"><span>Kanal</span><select name="channel">${options(REVIEW_CHANNEL_OPTIONS, filter.channel)}</select></label>
        <label class="rv__field"><span>Bintang</span><select name="rating">${options(REVIEW_RATING_OPTIONS, filter.rating)}</select></label>
        <label class="rv__field"><span>Rentang</span><select name="days">${options(REVIEW_DAYS_OPTIONS, filter.days)}</select></label>
        <label class="rv__field"><span>SKU</span><select name="sku"><option value="">Semua SKU</option>${skuOptions}</select></label>
        <label class="rv__check"><input type="checkbox" name="text" value="1" ${filter.text ? 'checked' : ''}> hanya yang ada teks</label>
        <button type="submit" class="rv__btn">${rvSvg('search')}Saring</button>
        <span class="rv__count">${idNumber(reviews.length)} ulasan${withPhotos ? ` · ${idNumber(withPhotos)} berfoto` : ''}</span>
      </form>
      ${cards ? `${reviewPager(true)}<div class="rv__list">${cards}</div>${reviewPager(false)}` : '<p class="empty">Tidak ada ulasan yang cocok dengan saringan.</p>'}
      <div class="fc__note"><b>Per SKU</b> &mdash; seluruh ulasan tersimpan, bukan hanya yang disaring. Klik SKU untuk menyaring.</div>
      <div class="scroll"><table class="dense">
        <thead><tr><th>SKU</th><th class="num">Ulasan</th><th class="num">Rata-rata</th><th class="num">≤ 3★</th></tr></thead>
        <tbody>${skuRows}</tbody>
      </table></div>
      <div class="foot"><span>${stats.written.count} ulasan tersimpan${
        Object.entries(stats.byChannel ?? {}).map(([id, b]) => ` &middot; ${escape(REVIEW_CHANNELS[id]?.label ?? id)} ${b.count}`).join('')
      } &middot; ekspor: <span class="mono">npm run reviews:export</span></span></div>
      ${lightbox}`,
  });
}

const loadTokopediaSlug = () => process.env.TOKOPEDIA_SHOP_SLUG || 'treelogy-moringa';
const defaultMediaUrl = (id, size) => `/api/tokopedia/media?id=${encodeURIComponent(id)}&s=${size}`;

const READY_TONE = { needsPrint: 'ok', reprint: 'flag' };

/**
 * One row of the label table.
 *
 * Shared by the list and by the search across every order, so a row found by searching
 * looks, ticks and prints exactly like one that was already on the page. A row with no
 * checkbox (`gone`) is one that cannot be printed, and `extra` says why underneath.
 */
function labelRowHtml({ order: o, readiness, entry = null }, { batchKey = null, out = false, on = true, gone = false, extra = '' } = {}) {
  // The stage pill is redundant here - every row on this page is printable by
  // definition, and the readiness note already says what matters.
  const times = Number(entry?.times ?? 0);
  const why = extra || (readiness.unavailable ? 'label tidak bisa dicetak ulang setelah pickup' : '');
  return `<tr data-id="${escape(String(o.id).toLowerCase())}"${batchKey ? ` data-batch="${escape(batchKey)}"` : ''}${out ? ' data-out="1" hidden' : ''}>
      <td>${gone ? '' : `<input class="pick" type="checkbox" name="order" value="${escape(o.channel)}:${escape(o.id)}"${on ? ' checked' : ''}
        ${batchKey ? `data-batch="${escape(batchKey)}"` : ''}${out ? ' disabled' : ''} aria-label="Cetak label ${escape(o.id)}">`}</td>
      <td>${channelTag(o)}</td>
      <td>
        <span class="mono nowrap">${escape(o.id)}</span>
        <span class="pick__s">${escape(dateTime(o.createdAt, o.channel))} &middot; ${escape(o.carrier) || 'kurir belum ada'}</span>
      </td>
      <td class="nowrap">${escape(o.buyer) || '<span class="dim">&mdash;</span>'}</td>
      <td class="nowrap"><span class="${READY_TONE[readiness.state] ?? 'dim'}">${escape(readiness.note)}</span>${
        times > 1 ? ` <span class="dim">&middot; ${times}&times;</span>` : ''}${
        why ? `<br><span class="dim">${escape(why)}</span>` : ''}</td>
    </tr>`;
}

/**
 * Rows for an order-ID search across every order, not just the worklist.
 *
 * The list on screen is what is worth printing today; a search is somebody holding one
 * parcel, and they want it found whatever state it is in. What can be fetched gets a
 * ticked checkbox, everything else is listed without one and says why - and when it was
 * last printed, by whom, which is usually the question.
 */
/**
 * The orders a typed fragment matched, as a list somebody can choose from.
 *
 * Recording a mistake against the wrong order is a worse mistake than the one being
 * recorded, so each row carries enough to be recognised without opening anything: the
 * channel it came from, when it was placed, who it went to, and what was in it. The
 * preview that appears after choosing is folded into the row, so picking costs no second
 * request and works at the speed of a click.
 *
 * Markup rather than data, answered by the same server that drew the page, because the
 * alternative is a second escaping routine living in a template literal.
 */
export function renderOrderPicks({ orders }) {
  if (orders.length === 0) {
    return '<p class="pick0__none" role="status">Tidak ada pesanan dengan order ID itu.</p>';
  }
  return orders.map((order, index) => {
    const lines = order.finance?.lines?.length ? order.finance.lines : (order.lines ?? []);
    const what = lines.map((l) => `${l.name || l.sku}${Number(l.qty) > 1 ? ` ×${l.qty}` : ''}`).join(', ');
    return `<li class="pick0" role="option" id="pick0-${index}" tabindex="-1"
        data-channel="${escape(order.channel)}" data-id="${escape(order.id)}" aria-selected="false">
      <span class="pick0__head">
        ${channelTag(order)}
        <span class="pick0__id mono">${escape(order.id)}</span>
        <span class="pick0__when">${escape(dateTime(order.createdAt, order.channel))}</span>
      </span>
      <span class="pick0__who">${escape(order.buyer) || '<span class="dim">tanpa nama</span>'}</span>
      <span class="pick0__what">${escape(what) || '<span class="dim">tanpa rincian</span>'}</span>
      <!-- A template, not a hidden span: its contents are inert and invisible to any
           querySelector on the document, so the card's buttons exist exactly once - the
           copy that was chosen. It still travels with the row, so choosing costs no
           second request. -->
      <template class="pick0__prev">${orderPreview(order)}</template>
    </li>`;
  }).join('');
}

/**
 * The order a mistake is being recorded against, once it has been chosen.
 *
 * The one card on this form that exists purely to be read before a decision, so it is
 * written to be read: who the parcel went to, where, and what was supposed to be in it.
 * The last of those is the point - "they ordered capsules" is the fact that makes the row
 * above it obviously wrong, and it is one click away from filling the replacement lines,
 * because what the customer ordered is almost always exactly what now has to be sent.
 *
 * `data-fill` carries the SKU and quantity of each line, so that click needs nothing from
 * the server and nothing parsed back out of the markup.
 */
function orderPreview(order) {
  const lines = order.finance?.lines?.length ? order.finance.lines : (order.lines ?? []);
  const field = (label, value) => (value
    ? `<div class="prev__f"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>` : '');
  const fill = lines
    .map((l) => `${String(l.sku ?? '').trim()}:${Number(l.qty) || 0}`)
    .filter((pair) => !pair.startsWith(':'))
    .join(',');

  return `<span class="prev" data-fill="${escape(fill)}"
      data-buyer="${escape(order.buyer ?? '')}" data-phone="${escape(order.buyerPhone ?? '')}"
      data-email="${escape(order.buyerEmail ?? '')}" data-shipto="${escape(order.shipTo ?? '')}">
    <span class="prev__top">
      <!-- The fieldset above already names this card; repeating it here would be the
           same words twice in two inches. What is worth saying is that it is settled. -->
      <span class="prev__eyebrow">Terpilih</span>
      <button class="prev__swap" type="button" data-swap>Ganti</button>
    </span>
    <span class="prev__h">
      ${channelTag(order)}
      <b class="mono prev__id">${escape(order.id)}</b>
      <span class="dim">${escape(dateTime(order.createdAt, order.channel))}</span>
      <span class="prev__t mono">${escape(rupiah(order.total))}</span>
    </span>
    <dl class="prev__g">
      ${field('Pembeli', order.buyer)}
      ${field('Telepon', order.buyerPhone)}
      ${field('Kurir', order.carrier)}
      ${field('Resi', order.tracking)}
    </dl>
    ${order.shipTo ? `<p class="prev__a">${escape(order.shipTo)}</p>` : ''}
    <span class="prev__lh">Yang dipesan <span class="dim">&mdash; ini yang seharusnya diterima</span></span>
    <ul class="prev__l">${lines.map((l) => `<li>
      <span>${escape(l.name || l.sku)}</span>
      <span class="prev__sku mono">${escape(l.sku ?? '')}</span>
      <b class="mono">${escape(String(l.qty ?? 0))}</b>
    </li>`).join('')}</ul>
    ${fill ? '<button class="prev__use" type="button" data-use>Pakai isi pesanan ini sebagai barang pengganti</button>' : ''}
  </span>`;
}

export function renderLabelLookup({ orders, printed = {}, arranged = {}, people = {} }) {
  const personName = (email) => people[email] || String(email || '').split('@')[0] || 'tidak diketahui';
  return orders.map((o) => {
    const readiness = labelReadiness(o, printed, arranged);
    const entry = printedEntry(printed, o);
    const gone = !FETCHABLE.has(readiness.state) || Boolean(readiness.unavailable);
    const when = entry?.at
      ? `dicetak ${dateTime(entry.at, BENCH_CHANNEL)} ${printZoneLabel()}${entry.by ? ` oleh ${personName(entry.by)}` : ''}`
      : '';
    const why = [gone && readiness.unavailable ? 'label tidak bisa dicetak ulang setelah pickup' : '', when]
      .filter(Boolean).join(' · ');
    return labelRowHtml({ order: o, readiness, entry }, { on: !gone, gone, extra: why });
  }).join('');
}

/**
 * Label view: pick the parcels to print, get one PDF sized for the thermal printer.
 *
 * Orders are pre-selected because printing every waiting label is the normal action;
 * unticking is the exception. The form posts to a separate endpoint that streams the PDF
 * straight into the browser's print preview.
 */
export function renderLabels({ orders, range, errors, shopeeShop, generatedAt, csrf, flash, sizes, defaultSize, showReprints = false, printed = {}, arranged = {}, people = {}, reprintFilter = {}, now = Math.floor(Date.now() / 1000), user = null, readAt = null, settleFailed = false }) {
  // The list shows only what actually needs printing today, so everything on screen is
  // ticked and everything ticked will print. Reprints of parcels the courier already
  // took are a deliberate detour, not clutter in the daily view.
  const assessed = orders.map((o) => ({ order: o, readiness: labelReadiness(o, printed, arranged) }));

  const counts = { needsPrint: 0, waiting: 0, arrange: 0, reprint: 0 };
  for (const { readiness } of assessed) {
    if (counts[readiness.state] !== undefined) counts[readiness.state] += 1;
  }

  const wanted = showReprints ? ['needsPrint', 'reprint'] : ['needsPrint'];
  /*
   * A TikTok or Tokopedia parcel the courier has taken can no longer be printed - the
   * platform refuses the document after pickup. It used to be left off the reprint list
   * altogether, so searching for one printed on Tuesday answered "0 label", which reads as
   * "never printed". It is listed now, in the run that printed it, without a checkbox and
   * saying why. Only when our own ledger printed it: one printed in Seller Center has no
   * run to sit in and nothing to find.
   */
  const printable = assessed
    .filter(({ order, readiness }) => wanted.includes(readiness.state)
      && (!readiness.unavailable || (showReprints && printedEntry(printed, order))));
  /*
   * Printing is capped server-side; ticking past it would hand the operator a button that
   * always errors.
   *
   * The daily list is cut at the cap. The reprint list is not: it is grouped and filtered
   * by when it was printed, and cutting the first hundred orders before that - in
   * whatever order the channels came back in - dropped whole days. Yesterday's filter
   * showed Shopee and nothing else, because Shopee filled the hundred. There the cap is
   * on what starts ticked instead.
   */
  const candidates = showReprints ? printable : printable.slice(0, MAX_PRESELECT);

  let ticked = 0;

  const labelRow = ({ order: o, readiness, entry = null }, batchKey = null, out = false) => {
    // Everything printable starts ticked - except a run the filter left out, which is
    // only on the page so the search can reach it, and anything past what one print run
    // accepts.
    const gone = Boolean(readiness.unavailable);
    const on = !gone && !out && ticked < MAX_PRESELECT;
    if (on) ticked += 1;
    return labelRowHtml({ order: o, readiness, entry }, { batchKey, out, on, gone });
  };

  /*
   * The reprint list is grouped by the run that printed it.
   *
   * Forty parcels printed in one click are one act, by one person, at one moment. Listed
   * flat they read as forty unrelated rows and the operator has to reconstruct the run
   * from timestamps - which is exactly the thing they are looking for when they open this
   * list at all: "the batch Vanya printed at eleven, print it again".
   *
   * The daily list is not grouped, because nothing there has been printed yet.
   */
  const personName = (email) => people[email] || String(email || '').split('@')[0] || 'tidak diketahui';

  /*
   * The filters stack on the grouping rather than replacing it.
   *
   * They narrow which runs are shown; inside a shown run nothing changes. That is only
   * coherent because a run is one moment and one operator, so a date and a person can
   * never keep half of one - which is what lets the two compose without a rule for what
   * happens when they disagree.
   *
   * The choices offered are the days and people that actually printed something, taken
   * from before the filter is applied, so narrowing never removes the option that would
   * widen it again.
   */
  const allBatches = showReprints ? printBatches(candidates, printed) : [];
  const filter = {
    from: reprintFilter.from || '',
    to: reprintFilter.to || '',
    by: reprintFilter.by || '',
  };
  const filtering = Boolean(filter.from || filter.to || filter.by);
  const shownBatches = showReprints ? filterPrintBatches(allBatches, filter) : [];
  const printers = printersIn(allBatches);
  const printDays = printDaysIn(allBatches);
  const shownLabels = shownBatches.reduce((n, b) => n + b.rows.length, 0);

  // A print has no platform behind it, so it is stamped on the clock of the bench it came
  // off - Bali, the same clock a typed-in sale is entered on. Named on screen, because a
  // time sitting next to other times in other zones has to say whose it is.
  const printZone = printZoneLabel();
  /*
   * The runs the filter left out are still sent, hidden and disabled.
   *
   * An order ID is looked for because somebody is holding that parcel, and they rarely
   * know which day its label came off the printer. A search that only sees "kemarin"
   * answers "0 label" for a parcel printed the day before - which reads as "never
   * printed". So the search reaches every run; the filter only decides what shows when
   * nothing is being searched for.
   */
  const shownKeys = new Set(shownBatches.map((b) => b.key));
  const rows = showReprints
    ? allBatches.map((batch) => {
        const out = !shownKeys.has(batch.key);
        const when = batch.at ? `${dateTime(batch.at, BENCH_CHANNEL)} ${printZone}` : 'waktu tidak tercatat';
        const who = batch.by ? escape(personName(batch.by)) : 'pencetak tidak tercatat';
        // A checkbox on the heading, because reprinting one whole run is the reason this
        // list is open: "the batch Vanya printed at eleven, print it again".
        return `<tr class="grp" data-grp="${escape(batch.key)}"${out ? ' data-out="1" hidden' : ''}><td colspan="5">
          <label class="grp__sel">
            <input type="checkbox" class="grp__pick" data-batch="${escape(batch.key)}" checked
              aria-label="Pilih batch ${escape(when)} oleh ${who}">
            <span class="grp__t">${escape(when)}</span>
          </label>
          <span class="grp__by">${who}</span>
          <span class="grp__n grp__n--batch">${batch.rows.length} label</span>${
            out ? ' <span class="dim">&middot; di luar filter</span>' : ''}
        </td></tr>${batch.rows.map((r) => labelRow(r, batch.key, out)).join('')}`;
      }).join('')
    // Wrapped: map's index and array would land in batchKey and out.
    : candidates.map((r) => labelRow(r)).join('');



  const sizeOptions = Object.entries(sizes)
    .map(([id, meta]) => `<option value="${escape(id)}" ${id === defaultSize ? 'selected' : ''}>${escape(meta.label)}</option>`)
    .join('');

  // Its own GET form, above the print form rather than inside it: a form cannot be nested
  // in another, and filtering must never be one slip away from sending a print job.
  const dayHint = printDays.length > 0
    ? `${printDays[printDays.length - 1].day} s/d ${printDays[0].day}` : 'belum ada cetakan';
  /*
   * One click for the two days anybody actually asks for.
   *
   * Reprinting is a same-day job: a parcel is repacked, a label smudges, the printer eats
   * a sheet. Typing two dates into a picker to say "today" is the kind of friction that
   * makes a filter go unused, so today and yesterday are a chip each.
   *
   * They carry the printer through, because the filters stack: narrowing to today must
   * not quietly widen the list back to everyone.
   */
  const presets = reprintPresets(now).map((preset) => {
    const on = filter.from === preset.from && filter.to === preset.to;
    const query = new URLSearchParams({ view: 'labels', reprint: '1', pfrom: preset.from, pto: preset.to });
    if (filter.by) query.set('pby', filter.by);
    return `<a class="chip${on ? ' is-on' : ''}" href="?${escape(query.toString())}">${escape(preset.label)}</a>`;
  }).join('');

  const reprintFilters = !showReprints ? '' : `
    <form class="filters rpf" method="get">
      <input type="hidden" name="view" value="labels">
      <input type="hidden" name="reprint" value="1">
      <span class="rpf__quick">${presets}${
        // Only when a printer is also chosen. With nothing else filtering, clearing the
        // dates and clearing the filter are the same act, and offering it twice makes
        // the operator wonder what the difference is.
        filter.by && (filter.from || filter.to)
          ? `<a class="chip" href="?view=labels&reprint=1&pby=${escape(encodeURIComponent(filter.by))}">Semua tanggal</a>`
          : ''}</span>
      <label class="dr__lbl" for="pfrom">Tanggal cetak</label>
      <input class="dr__in" type="date" id="pfrom" name="pfrom" value="${escape(filter.from)}"
        min="${escape(printDays.length ? printDays[printDays.length - 1].day : '')}"
        max="${escape(printDays.length ? printDays[0].day : '')}" aria-label="Dicetak sejak tanggal">
      <span class="rpf__to">&ndash;</span>
      <input class="dr__in" type="date" id="pto" name="pto" value="${escape(filter.to)}"
        min="${escape(printDays.length ? printDays[printDays.length - 1].day : '')}"
        max="${escape(printDays.length ? printDays[0].day : '')}" aria-label="Dicetak sampai tanggal">
      <label class="dr__lbl" for="pby">Pencetak</label>
      <select class="dr__in" id="pby" name="pby">
        <option value="">Semua (${printers.reduce((n, p2) => n + p2.labels, 0)} label)</option>
        ${printers.map((p2) => `<option value="${escape(p2.email)}"${p2.email === filter.by ? ' selected' : ''}>${
          escape(personName(p2.email))} (${p2.labels})</option>`).join('')}
      </select>
      <button class="chip" type="submit">Terapkan</button>
      ${filtering ? '<a class="chip" href="?view=labels&reprint=1">Hapus filter</a>' : ''}
      <span class="grow"></span>
      <span class="rpf__n">${shownBatches.length} batch &middot; ${shownLabels} label${
        filtering ? ` <span class="dim">dari ${allBatches.length} batch</span>` : ''}</span>
    </form>
    <p class="rpf__hint">Cetakan tercatat ${escape(dayHint)} (jam ${escape(printZone)}). Filter tanggal dan pencetak menumpuk di atas pengelompokan per batch.</p>`;

  /*
   * Finding one parcel in a hundred, without a round trip.
   *
   * Outside both forms on purpose: inside the GET filter form Enter would reload the
   * page, and inside the print form it would send a print job - which is the one
   * keystroke an operator looking for an order must never fire by accident.
   *
   * It filters as it is typed, and it takes the hidden rows out of the print with it:
   * pressing "Cetak" after a search prints what is on screen, not the hundred behind it.
   */
  // Always there, even over an empty list: the order being looked for is usually not one
  // the list holds.
  const search = `<div class="filters lbs">
        <label class="dr__lbl" for="lbq">Cari order ID</label>
        <input class="dr__in lbs__in" type="search" id="lbq" autocomplete="off" spellcheck="false"
               placeholder="mis. 11143 atau 2609..." aria-label="Saring daftar berdasarkan order ID">
        <button class="chip" type="button" id="lbq-clear" hidden>Hapus pencarian</button>
        <span class="grow"></span>
        <span class="rpf__n" id="lbq-n" hidden></span>
      </div>`;
  const empty = showReprints ? shownBatches.length === 0 : candidates.length === 0;

  return shell({ user,
    csrf,
    title: 'Cetak Label',
    range, errors, shopeeShop, generatedAt,
    view: 'labels',
    hideRangeControls: true, scope: 'semua yang perlu dicetak',
    readAt, settleFailed,
    flash,
    kpis: `
      <div class="strip">
        ${stat('Perlu dicetak', String(counts.needsPrint), counts.needsPrint > 0 ? 'ok' : '')}
        ${stat('Menunggu kurir', String(counts.waiting), counts.waiting > 0 ? 'flag' : '')}
        ${stat('Atur pengiriman', String(counts.arrange), counts.arrange > 0 ? 'flag' : '')}
        ${stat('Sudah jalan', String(counts.reprint))}
      </div>`,
    body: `${reprintFilters}
        ${search}
        ${empty ? `<div id="lb-empty"><p class="empty">${!showReprints
          ? 'Semua label sudah dicetak.'
          : filtering
            ? 'Tidak ada batch cetak yang cocok dengan filter ini.'
            : 'Tidak ada label yang bisa dicetak.'}</p>
         <div class="apply">${filtering
           ? '<a class="chip" href="?view=labels&reprint=1">Hapus filter</a>'
           : `<a class="chip" href="?view=labels&reprint=${showReprints ? '0' : '1'}">${
              showReprints ? 'Kembali ke daftar harian' : 'Tampilkan cetak ulang'}</a>`}</div></div>` : ''}
        <form method="post" action="/api/labels" target="_blank" id="lbform"${empty ? ' data-empty hidden' : ''}>
          <input type="hidden" name="csrf" value="${escape(csrf)}">
          <div class="filters">
            <label class="dr__lbl" for="size">Ukuran label</label>
            <select class="dr__in" id="size" name="size">${sizeOptions}</select>
            <span class="grow"></span>
            <a class="chip" href="?view=labels&reprint=${showReprints ? '0' : '1'}">${
              showReprints ? 'Daftar harian' : 'Cetak ulang'}</a>
            <button class="chip" type="button" id="pickall" aria-pressed="true">Kosongkan semua</button>
          </div>
          <div class="scroll"><table class="dense">
            <thead><tr>
              <th><input type="checkbox" id="head" checked aria-label="Pilih semua"></th>
              <th>Kanal</th><th>Pesanan</th><th>Pembeli</th><th>Label</th>
            </tr></thead>
            <tbody id="lb-rows">${rows}</tbody>
            <tbody id="lbq-more"></tbody>
          </table></div>
          <div class="apply">
            <button type="submit" id="go">Cetak <span id="n">${ticked}</span> label</button>
            <span class="dim" id="over" hidden>Maksimal ${MAX_PRESELECT} label sekali cetak &mdash; bagi jadi beberapa batch.</span>
            ${candidates.length > 0 && !showReprints
              ? `<button class="chip" type="submit" formaction="/api/dashboard" formtarget="_self"
                   name="action" value="label_printed"
                   data-confirm-text="Tandai label yang tercentang sebagai sudah dicetak, tanpa mencetak?">Tandai sudah dicetak</button>`
              : ''}
          </div>
          <input type="hidden" name="view" value="labels">
        </form>`,
    script: `
(function () {
  var form = document.getElementById('lbform');
  var counter = document.getElementById('n');
  var head = document.getElementById('head');
  var toggle = document.getElementById('pickall');
  if (!form) return;
  // Read again whenever a search adds rows: the found ones print like any other.
  var picks = [];
  function refresh() { picks = Array.prototype.slice.call(form.querySelectorAll('.pick')); }
  refresh();

  // Only what a search has left on screen counts. A disabled row is not printed, so
  // counting it would promise a sheet that is not coming.
  function visible() { return picks.filter(function (p) { return !p.disabled; }); }

  function sync() {
    var live = visible();
    var n = live.filter(function (p) { return p.checked; }).length;
    counter.textContent = n;
    // The server refuses a run past the cap, so the button says so before it is pressed.
    var go = document.getElementById('go');
    var over = document.getElementById('over');
    if (go) go.disabled = n > ${MAX_PRESELECT} || n === 0;
    if (over) over.hidden = n <= ${MAX_PRESELECT};
    head.checked = live.length > 0 && n === live.length;
    head.indeterminate = n > 0 && n < live.length;
    // One control, and it says what pressing it will do rather than what is true now.
    var allOn = n > 0 && n === live.length;
    toggle.textContent = allOn ? 'Kosongkan semua' : 'Pilih semua';
    toggle.setAttribute('aria-pressed', allOn ? 'true' : 'false');
  }
  function setAll(value) { visible().forEach(function (p) { p.checked = value; }); syncBatches(); sync(); }

  // One checkbox per print run, on its heading. Reprinting a whole batch is the reason
  // this list is open, and ticking forty rows by hand to do it is not a feature.
  var batchPicks = Array.prototype.slice.call(form.querySelectorAll('.grp__pick'));
  function rowsOf(key) {
    return picks.filter(function (p) { return p.getAttribute('data-batch') === key; });
  }
  function syncBatches() {
    batchPicks.forEach(function (b) {
      // A run made only of parcels the courier has taken has nothing left to print.
      b.disabled = rowsOf(b.getAttribute('data-batch')).length === 0;
      var mine = rowsOf(b.getAttribute('data-batch')).filter(function (p) { return !p.disabled; });
      var on = mine.filter(function (p) { return p.checked; }).length;
      b.checked = mine.length > 0 && on === mine.length;
      b.indeterminate = on > 0 && on < mine.length;
    });
  }
  batchPicks.forEach(function (b) {
    b.addEventListener('change', function () {
      rowsOf(b.getAttribute('data-batch'))
        .filter(function (p) { return !p.disabled; })
        .forEach(function (p) { p.checked = b.checked; });
      sync();
    });
  });

  // Delegated, so a row a search brings in later is counted without wiring it up.
  form.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('pick')) { syncBatches(); sync(); }
  });
  head.addEventListener('change', function () { setAll(head.checked); });

  /*
   * The search, applied on every keystroke.
   *
   * A hidden row is not merely out of sight: its checkbox is disabled, and a disabled
   * control is not submitted. So "Cetak" after a search prints exactly what is on screen.
   * Disabling rather than unticking is what lets the whole selection come back untouched
   * when the box is cleared.
   *
   * The rows on the page are only the worklist. So a search of four characters or
   * more also asks the server, which looks through every order whatever its state, and
   * whatever it finds that is not already here is listed below under its own heading -
   * printable ones ticked, the rest saying why not.
   */
  var box = document.getElementById('lbq');
  if (box) {
    var clear = document.getElementById('lbq-clear');
    var tally = document.getElementById('lbq-n');
    var more = document.getElementById('lbq-more');
    var emptyNote = document.getElementById('lb-empty');
    var rows = Array.prototype.slice.call(form.querySelectorAll('#lb-rows tr[data-id]'));
    var groups = Array.prototype.slice.call(form.querySelectorAll('#lb-rows tr.grp'));
    var local = { shown: 0, outside: 0, inFilter: 0 };
    var remote = { state: '', count: 0 };
    var asked = 0;
    var timer = null;

    function report(needle) {
      clear.hidden = !needle;
      tally.hidden = !needle;
      var text = local.shown + ' dari ' + local.inFilter + ' label'
        + (local.outside ? ' · ' + local.outside + ' di luar filter' : '');
      if (remote.state === 'busy') text += ' · mencari di semua pesanan…';
      else if (remote.state === 'done') text += ' · ' + remote.count + ' lagi di semua pesanan';
      else if (remote.state === 'failed') text += ' · pencarian ke semua pesanan gagal';
      tally.textContent = text;
      // A page with nothing to print keeps its table hidden until a search fills it.
      if (form.hasAttribute('data-empty')) {
        var any = Array.prototype.some.call(form.querySelectorAll('tbody tr[data-id]'), function (r) { return !r.hidden; });
        form.hidden = !any;
        if (emptyNote) emptyNote.hidden = Boolean(needle) && any;
      }
    }

    function lookup(needle) {
      var mine = ++asked;
      remote = { state: 'busy', count: 0 };
      report(needle);
      fetch('?view=labels&lookup=' + encodeURIComponent(needle), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || r.status); return body; }); })
        .then(function (body) {
          if (mine !== asked) return;
          var holder = document.createElement('tbody');
          holder.innerHTML = body.rows || '';
          var here = {};
          rows.forEach(function (row) { here[row.getAttribute('data-id')] = true; });
          var found = Array.prototype.filter.call(holder.querySelectorAll('tr[data-id]'), function (row) {
            return !here[row.getAttribute('data-id')];
          });
          more.innerHTML = '';
          if (found.length) {
            var title = document.createElement('tr');
            title.className = 'grp';
            title.innerHTML = '<td colspan="5"><span class="grp__t">Di semua pesanan</span>'
              + '<span class="grp__n grp__n--batch">' + found.length + ' pesanan</span></td>';
            more.appendChild(title);
            found.forEach(function (row) { more.appendChild(row); });
          }
          remote = { state: 'done', count: found.length };
          refresh(); syncBatches(); sync(); report(needle);
        })
        .catch(function () {
          if (mine !== asked) return;
          remote = { state: 'failed', count: 0 };
          report(needle);
        });
    }

    function apply() {
      var needle = box.value.trim().toLowerCase();
      local = { shown: 0, outside: 0, inFilter: 0 };
      rows.forEach(function (row) {
        // A run outside the date or printer filter only shows when the search finds
        // something in it; with the box empty the filter decides, as before.
        var out = row.hasAttribute('data-out');
        var hit = needle ? row.getAttribute('data-id').indexOf(needle) !== -1 : !out;
        row.hidden = !hit;
        var pick = row.querySelector('.pick');
        if (pick) pick.disabled = !hit;
        if (!out) local.inFilter += 1;
        if (hit && out) local.outside += 1;
        else if (hit) local.shown += 1;
      });
      // A batch heading with nothing under it is a heading for nothing - and one that
      // still claims three labels above two rows reads as a list with something missing.
      groups.forEach(function (group) {
        var key = group.getAttribute('data-grp');
        // By the row, not its checkbox: a parcel the courier has taken has no checkbox
        // and still belongs to its run.
        var mine = rows.filter(function (row) { return row.getAttribute('data-batch') === key; });
        var left = mine.filter(function (row) { return !row.hidden; }).length;
        group.hidden = left === 0;
        var count = group.querySelector('.grp__n');
        if (count) {
          if (!count.dataset.full) count.dataset.full = count.textContent;
          count.textContent = needle && left !== mine.length
            ? left + ' dari ' + count.dataset.full
            : count.dataset.full;
        }
      });

      // The search across every order is one request per pause in typing, not per key,
      // and a reply to a search that has since changed is dropped.
      clearTimeout(timer);
      asked += 1;
      more.innerHTML = '';
      remote = { state: '', count: 0 };
      var bare = needle.replace(/[^a-z0-9-]/g, '');
      if (bare.length >= ${ID_SEARCH_MIN}) timer = setTimeout(function () { lookup(bare); }, 350);
      refresh(); syncBatches(); sync(); report(needle);
    }

    // The clear cross inside a search field and a paste fire input and not keyup, and
    // input covers typing too - one listener, so one search per change.
    box.addEventListener('input', apply);
    box.addEventListener('keydown', function (e) { if (e.key === 'Escape') { box.value = ''; apply(); } });
    clear.addEventListener('click', function () { box.value = ''; apply(); box.focus(); });
  }

  syncBatches();
  toggle.addEventListener('click', function () {
    setAll(toggle.getAttribute('aria-pressed') !== 'true');
  });
  sync();
})();`,
  });
}



/**
 * Channel marks.
 *
 * Official glyphs from Simple Icons for Shopee, TikTok and Shopify. Tokopedia has no
 * entry there and needs none: Tokopedia and TikTok Shop are one listing behind one API
 * account, so a single TikTok mark is the accurate representation of that column - two
 * storefronts, one stock number.
 */
const CHANNEL_MARKS = {
  // Tokopedia has no Simple Icons entry, and inventing a brand mark is worse than not
  // using one - so this column gets a neutral storefront glyph in Tokopedia's green and
  // a label that states the truth: one listing, two storefronts, one stock number.
  tiktok: {
    label: 'Tokopedia + TikTok Shop', short: 'Tokped + TikTok', accent: '#42B549',
    path: 'M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.015a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z', outline: true,
  },
  shopee: { label: 'Shopee', short: 'Shopee', accent: '#EE4D2D', path: 'M15.9414 17.9633c.229-1.879-.981-3.077-4.1758-4.0969-1.548-.528-2.277-1.22-2.26-2.1719.065-1.056 1.048-1.825 2.352-1.85a5.2898 5.2898 0 0 1 2.8838.89c.116.072.197.06.263-.039.09-.145.315-.494.39-.62.051-.081.061-.187-.068-.281-.185-.1369-.704-.4149-.983-.5319a6.4697 6.4697 0 0 0-2.5118-.514c-1.909.008-3.4129 1.215-3.5389 2.826-.082 1.1629.494 2.1078 1.73 2.8278.262.152 1.6799.716 2.2438.892 1.774.552 2.695 1.5419 2.478 2.6969-.197 1.047-1.299 1.7239-2.818 1.7439-1.2039-.046-2.2878-.537-3.1278-1.19l-.141-.11c-.104-.08-.218-.075-.287.03-.05.077-.376.547-.458.67-.077.108-.035.168.045.234.35.293.817.613 1.134.775a6.7097 6.7097 0 0 0 2.8289.727 4.9048 4.9048 0 0 0 2.0759-.354c1.095-.465 1.8029-1.394 1.9449-2.554zM11.9986 1.4009c-2.068 0-3.7539 1.95-3.8329 4.3899h7.6657c-.08-2.44-1.765-4.3899-3.8328-4.3899zm7.8516 22.5981-.08.001-15.7843-.002c-1.074-.04-1.863-.91-1.971-1.991l-.01-.195L1.298 6.2858a.459.459 0 0 1 .45-.494h4.9748C6.8448 2.568 9.1607 0 11.9996 0c2.8388 0 5.1537 2.5689 5.2757 5.7898h4.9678a.459.459 0 0 1 .458.483l-.773 15.5883-.007.131c-.094 1.094-.979 1.9769-2.0709 2.0059z' },
  shopify: { label: 'Shopify', short: 'Shopify', accent: '#5E8E3E', path: 'M15.337 23.979l7.216-1.561s-2.604-17.613-2.625-17.73c-.018-.116-.114-.192-.211-.192s-1.929-.136-1.929-.136-1.275-1.274-1.439-1.411c-.045-.037-.075-.057-.121-.074l-.914 21.104h.023zM11.71 11.305s-.81-.424-1.774-.424c-1.447 0-1.504.906-1.504 1.141 0 1.232 3.24 1.715 3.24 4.629 0 2.295-1.44 3.76-3.406 3.76-2.354 0-3.54-1.465-3.54-1.465l.646-2.086s1.245 1.066 2.28 1.066c.675 0 .975-.545.975-.932 0-1.619-2.654-1.694-2.654-4.359-.034-2.237 1.571-4.416 4.827-4.416 1.257 0 1.875.361 1.875.361l-.945 2.715-.02.01zM11.17.83c.136 0 .271.038.405.135-.984.465-2.064 1.639-2.508 3.992-.656.213-1.293.405-1.889.578C7.697 3.75 8.951.84 11.17.84V.83zm1.235 2.949v.135c-.754.232-1.583.484-2.394.736.466-1.777 1.333-2.645 2.085-2.971.193.501.309 1.176.309 2.1zm.539-2.234c.694.074 1.141.867 1.429 1.755-.349.114-.735.231-1.158.366v-.252c0-.752-.096-1.371-.271-1.871v.002zm2.992 1.289c-.02 0-.06.021-.078.021s-.289.075-.714.21c-.423-1.233-1.176-2.37-2.508-2.37h-.115C12.135.209 11.669 0 11.265 0 8.159 0 6.675 3.877 6.21 5.846c-1.194.365-2.063.636-2.16.674-.675.213-.694.232-.772.87-.075.462-1.83 14.063-1.83 14.063L15.009 24l.927-21.166z', readOnly: true },
};

/**
 * One channel's stock, with its mark.
 *
 * `readOnly` is not decoration: Shopify's stock lives in location-scoped inventory levels
 * and is never written by sync, so the card has to say so or an operator will reasonably
 * assume all three move together.
 */
function channelChip(key, qty, { failed = false, off = false, header = false } = {}) {
  const mark = CHANNEL_MARKS[key];
  // As a column heading it is the channel itself being named, not one SKU's number.
  const value = header ? '' : failed ? '<b class="stop">?</b>' : qty === null ? '<b class="dim">&mdash;</b>' : `<b>${qty}</b>`;
  const title = mark.readOnly
    ? `${mark.label} - hanya dibaca, tidak ikut disinkronkan`
    : `${mark.label} - ikut disinkronkan`;

  const lock = mark.readOnly
    ? '<svg class="cm__l" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75A2.25 2.25 0 0 0 4.5 12.75v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>'
    : '';

  return `<span class="cm${off ? ' cm--off' : ''}${mark.readOnly ? ' cm--ro' : ''}"
    style="--accent:${mark.accent}" title="${escape(title)}">
    <svg class="cm__i${mark.outline ? ' cm__i--o' : ''}" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="${mark.path}"/></svg>
    <i>${escape(mark.short)}</i>${value}${lock}
  </span>`;
}

/**
 * Stock editing: one screen where every number can be changed without drilling in.
 *
 * The old flow made you open each product, type a number, go back, and repeat - then
 * discover most edits were held for review anyway. Here the channels are visible beside
 * the field, a stepper handles the common +/- adjustment, and the line under each card
 * says plainly what saving will do. Editing is local to the ledger; pushing to the
 * marketplaces stays a separate, deliberate click.
 */
export function renderStock({ catalog, ledger, plan, errors, range, shopeeShop, generatedAt, csrf, flash, filter = 'all', images = {}, user = null }) {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const listed = catalog.skus.filter((e) => e.tiktok || e.shopee || e.shopify);
  const blind = Object.keys(errors ?? {}).length > 0;

  const planFor = (sku) =>
    plan ? [...plan.changes, ...plan.review, ...plan.blocked].filter((c) => c.sku === sku) : [];

  let needsAttention = 0;
  let managed = 0;
  const counts = {};

  /**
   * Variants of one product belong together.
   *
   * Sorted by SKU they scatter - "Moringa Ritual Set + Powder 45gr" lands nowhere near
   * the 90gr. The master catalogue already knows which SKUs share a product name, so the
   * grid is grouped by it and the card drops the repeated name, showing the variant.
   */
  const groups = new Map();
  for (const entry of listed) {
    const product = findProduct(entry.sku);
    const key = (product && familyOf(product)) || entry.title || entry.sku;
    if (!groups.has(key)) {
      groups.set(key, { name: key, category: product?.category ?? 'zz', items: [] });
    }
    groups.get(key).items.push(entry);
  }

  const categoryOrder = Object.keys(CATEGORIES);
  const ordered = [...groups.values()].sort((a, b) => {
    const ca = categoryOrder.indexOf(a.category);
    const cb = categoryOrder.indexOf(b.category);
    if (ca !== cb) return (ca === -1 ? 99 : ca) - (cb === -1 ? 99 : cb);
    return a.name.localeCompare(b.name);
  });
  for (const group of ordered) {
    group.items.sort((x, y) => {
      const vx = findProduct(x.sku)?.variant ?? '';
      const vy = findProduct(y.sku)?.variant ?? '';
      // Variants read naturally in size order, which is numeric, not alphabetic.
      const nx = Number((vx.match(/\d+/) ?? [])[0]);
      const ny = Number((vy.match(/\d+/) ?? [])[0]);
      if (Number.isFinite(nx) && Number.isFinite(ny) && nx !== ny) return nx - ny;
      return vx.localeCompare(vy) || x.sku.localeCompare(y.sku);
    });
  }

  /**
   * One row per SKU, grouped by product, wide enough to compare across channels.
   *
   * Cards showed three variants across the screen and pushed the fourth product below the
   * fold, so telling the 90 gram powder from the 180 meant scrolling between them. The
   * three channel figures are the thing being compared, and a column each puts them under
   * one another where a difference is a shape rather than something to read twice.
   *
   * The picture is here for the same reason it is on the manual form: it is the check
   * against writing the 90 gram figure onto the 180.
   *
   * `st`, `grp`, `st__in` and the data attributes are kept exactly as they were - the
   * search, the filters, the dirty marking and the steppers all find their row through
   * them, and a row is as good a thing to find as a card.
   */
  const rowFor = (entry, { grouped }) => {
      const product = findProduct(entry.sku);
      const row = ledger?.skus?.[entry.sku];
      const master = row && !row.alias_of ? row.qty : null;
      if (row) managed += 1;

      const channels = [
        ['tiktok', entry.tiktok?.qty ?? null, errors.tiktok],
        ['shopee', entry.shopee?.qty ?? null, errors.shopee],
        ['shopify', entry.shopify?.qty ?? null, errors.shopify],
      ];
      const shown = channels.filter(([, qty, failed]) => qty !== null || failed);

      const values = shown.map(([, q]) => q).filter((q) => typeof q === 'number');
      const spread = values.length > 1 && new Set(values).size > 1;

      // What saving this number would actually do, in one line the operator can act on.
      const mine = planFor(entry.sku);
      // A held row is usually right - it is held because the number came from the seed,
      // not because it is wrong. Without a way to vouch for it, the operator would have
      // to nudge the value up and back down to make the button light up.
      const heldBySeed = mine.some((c) => /angka awal/.test(c.reason ?? ''));

      // One state per row drives its colour, its filter bucket and its count. Deriving
      // all three from the same value is what keeps the chips honest.
      let state;
      let note;
      if (blind) { state = 'blind'; note = '<span class="stop">sebagian kanal tidak terbaca</span>'; }
      else if (!row) { state = 'new'; note = '<span class="flag">belum dikelola</span>'; }
      else if (row.alias_of) { state = 'alias'; note = `<span class="dim">ikut ${escape(row.alias_of)}</span>`; }
      else if (mine.some((c) => c.reason)) {
        state = 'held';
        note = `<span class="flag">${escape(mine.find((c) => c.reason).reason)}</span>`;
      } else if (mine.length > 0) {
        state = 'ready';
        note = `<span class="ok">siap ditulis ke ${mine.length} listing</span>`;
      } else if (spread) { state = 'drift'; note = '<span class="flag">kanal belum seragam</span>'; }
      else { state = 'ok'; note = '<span class="ok">sinkron</span>'; }

      if (state === 'new' || state === 'held' || state === 'drift') needsAttention += 1;
      counts[state] = (counts[state] ?? 0) + 1;

      const suggestion = spread && values.length > 0 ? Math.min(...values) : null;
      const picture = images[entry.sku]?.thumb || images[entry.sku]?.url || '';
      const title = grouped && product?.variant ? product.variant : (product?.name ?? entry.title);

      const cell = ([key, qty, failed]) => {
        if (failed) return `<td class="stt__q stt__q--bad" title="${escape(key)} tidak terbaca">?</td>`;
        if (qty === null) return '<td class="stt__q dim">&mdash;</td>';
        const off = master !== null && qty !== master;
        return `<td class="stt__q${off ? ' stt__q--off' : ''}">${qty}</td>`;
      };

      return `<tr class="st st--${state}" data-state="${state}" data-drift="${spread ? '1' : '0'}"
        data-lowest="${suggestion ?? ''}">
        <td class="stt__pic">${picture
          ? `<img src="${escape(picture)}" alt="" loading="lazy" decoding="async">`
          : '<span class="stt__nopic" aria-hidden="true"></span>'}</td>
        <td class="stt__name">
          <span class="stt__t">${escape(title)}</span>
          <span class="stt__sku mono">${escape(entry.sku)}</span>
        </td>
        ${channels.map(cell).join('')}
        <td class="stt__edit">
          <div class="st__edit">
            <button class="st__b" type="button" data-step="-1" aria-label="Kurangi ${escape(entry.sku)}">&minus;</button>
            <input class="st__in mono" type="number" min="0" step="1" inputmode="numeric"
              name="qty:${escape(entry.sku)}" value="${master ?? ''}" placeholder="&mdash;"
              data-original="${master ?? ''}" aria-label="Stok ${escape(entry.sku)}">
            <button class="st__b" type="button" data-step="1" aria-label="Tambah ${escape(entry.sku)}">+</button>
          </div>
          ${suggestion !== null
            ? `<button class="st__fix" type="button" data-set="${suggestion}" title="Pakai angka terendah antar kanal">= ${suggestion}</button>`
            : ''}
        </td>
        <td class="stt__note">
          ${note}
          ${heldBySeed ? `<label class="st__vouch">
            <input type="checkbox" name="vouch:${escape(entry.sku)}" value="1">
            <span>konfirmasi ${master}</span>
          </label>` : ''}
        </td>
      </tr>`;
  };

  // One table, one tbody: the group headings are rows among the rows, which is what lets
  // the search hide a heading whose whole group went away.
  const cards = `<table class="stt">
    <thead><tr>
      <th class="stt__pic"><span class="vh">Gambar</span></th>
      <th>Produk</th>
      ${['tiktok', 'shopee', 'shopify']
        .map((key) => `<th class="stt__q">${channelChip(key, null, { header: true })}</th>`).join('')}
      <th class="stt__edit">Stok induk</th>
      <th>Status</th>
    </tr></thead>
    <tbody>${ordered.map((group) => {
      const many = group.items.length > 1;
      // A heading over a single row would only repeat that row's own name, which the
      // row already carries in full when it is not part of a group.
      const heading = many
        ? `<tr class="grp"><td colspan="7"><span class="grp__t">${escape(group.name)}</span><span class="grp__n">${group.items.length} varian</span></td></tr>`
        : '';
      return heading + group.items.map((entry) => rowFor(entry, { grouped: many })).join('');
    }).join('')}</tbody>
  </table>`;

  const ready = plan?.changes.length ?? 0;
  const held = (plan?.review.length ?? 0) + (plan?.blocked.length ?? 0);

  // Reviewing means looking at one kind of problem at a time. The chips carry their own
  // counts so the shape of the work is visible before anything is clicked, and the
  // choice lives in the URL so a filtered view survives a reload and can be shared.
  const FILTERS = [
    { id: 'all', label: 'Semua', n: listed.length },
    { id: 'attention', label: 'Perlu perhatian', n: needsAttention, tone: 'flag' },
    { id: 'new', label: 'Belum dikelola', n: counts.new ?? 0 },
    { id: 'drift', label: 'Kanal beda', n: counts.drift ?? 0 },
    { id: 'held', label: 'Ditahan', n: counts.held ?? 0 },
    { id: 'ready', label: 'Siap ditulis', n: counts.ready ?? 0, tone: 'ok' },
    { id: 'ok', label: 'Sinkron', n: counts.ok ?? 0 },
  ].filter((f) => f.n > 0 || f.id === 'all');

  const active = FILTERS.some((f) => f.id === filter) ? filter : 'all';

  const chips = FILTERS.map((f) => `<button class="chip${f.id === active ? ' is-on' : ''}"
    type="button" data-filter="${f.id}">${escape(f.label)}
    <b class="${f.tone ?? ''}">${f.n}</b></button>`).join('');

  return shell({ user,
    csrf,
    title: 'Atur Stok',
    range, errors, shopeeShop, generatedAt,
    view: 'stock',
    hideRangeControls: true,
    flash,
    stale: Boolean(catalog.stale),
    staleSince: catalog.savedAt ? wibStamp(catalog.savedAt) : null,
    kpis: `<div class="strip">
      ${stat('SKU tayang', String(listed.length))}
      ${stat('Dikelola', String(managed))}
      ${stat('Perlu perhatian', String(needsAttention), needsAttention > 0 ? 'flag' : 'ok')}
      ${stat('Siap ditulis', String(ready), ready > 0 ? 'ok' : '')}
      <span class="strip__grow"></span>
      <input class="search" id="q" type="search" aria-label="Cari SKU atau produk" placeholder="Cari produk atau SKU...">
    </div>
    <div class="filters filters--stock" role="group" aria-label="Saring stok">
      ${chips}
      <span class="grow"></span>
      ${(counts.drift ?? 0) > 0
        ? `<button class="chip" type="button" id="fixall">Samakan ${counts.drift} ke terendah</button>`
        : ''}
      ${(counts.held ?? 0) > 0
        ? `<button class="chip" type="button" id="vouchall">Konfirmasi ${counts.held} yang ditahan</button>`
        : ''}
    </div>`,
    body: `<form method="post" id="stockform" data-confirm="Simpan {n} perubahan stok ke ledger?">
        ${hidden}
        <input type="hidden" name="action" value="ledger_batch">
        <div class="scroll stt__wrap" id="rows">${cards}</div>
        <p class="empty" id="empty" hidden></p>
        <div class="wl__go st__bar">
          <button class="wo__go" type="submit" id="save" disabled>Simpan <span id="n">0</span> perubahan</button>
          ${plan ? `<span class="st__apply">
            <button class="chip" type="submit" form="applyform" ${ready === 0 ? 'disabled' : ''}
              >Terapkan ${ready} ke marketplace</button>
            ${held > 0 ? `<span class="note flag">${held} ditahan</span>` : ''}
          </span>` : ''}
        </div>
      </form>
      ${plan ? `<form method="post" id="applyform" data-confirm="Tulis ${ready} perubahan stok ke marketplace?">
        ${hidden}<input type="hidden" name="action" value="apply">
      </form>` : ''}`,
    script: `
(function () {
  var form = document.getElementById('stockform');
  if (!form) return;
  var inputs = Array.prototype.slice.call(form.querySelectorAll('.st__in'));
  var vouches = Array.prototype.slice.call(form.querySelectorAll('[name^="vouch:"]'));
  var cards = Array.prototype.slice.call(form.querySelectorAll('.st'));
  var groups = Array.prototype.slice.call(form.querySelectorAll('.grp'));
  var counter = document.getElementById('n');
  var save = document.getElementById('save');
  var search = document.getElementById('q');
  var empty = document.getElementById('empty');
  var state = { filter: ${JSON.stringify(active)}, q: '' };

  var EMPTY = {
    attention: 'Tidak ada yang perlu perhatian. Semua stok sudah beres.',
    'new': 'Semua SKU sudah dikelola di ledger.',
    drift: 'Semua kanal sudah seragam.',
    held: 'Tidak ada yang ditahan.',
    ready: 'Tidak ada perubahan yang siap ditulis.',
    ok: 'Belum ada SKU yang sepenuhnya sinkron.',
    all: 'Tidak ada SKU yang cocok dengan pencarian.'
  };

  function matches(card) {
    var s = card.dataset.state;
    if (state.filter === 'all') return true;
    if (state.filter === 'attention') return s === 'new' || s === 'held' || s === 'drift';
    return s === state.filter;
  }

  function apply() {
    var shown = 0;
    cards.forEach(function (c) {
      var ok = matches(c) && (state.q === '' || c.textContent.toLowerCase().indexOf(state.q) !== -1);
      c.hidden = !ok;
      if (ok) shown++;
    });
    // A heading with nothing under it is noise, so it hides with its variants.
    groups.forEach(function (g) {
      var any = false;
      for (var el = g.nextElementSibling; el && !el.classList.contains('grp'); el = el.nextElementSibling) {
        if (!el.hidden) { any = true; break; }
      }
      g.hidden = !any;
    });
    empty.hidden = shown !== 0;
    if (shown === 0) empty.textContent = EMPTY[state.filter] || EMPTY.all;
  }

  function changed(i) { return i.value !== i.dataset.original; }

  function sync() {
    // A vouch is a change too: it turns a seeded number into one a human stands behind.
    var n = inputs.filter(changed).length + vouches.filter(function (v) { return v.checked; }).length;
    inputs.forEach(function (i) { i.closest('.st').classList.toggle('st--dirty', changed(i)); });
    vouches.forEach(function (v) { if (v.checked) v.closest('.st').classList.add('st--dirty'); });
    counter.textContent = n;
    save.disabled = n === 0;
    form.dataset.confirm = 'Simpan ' + n + ' perubahan stok ke ledger?';
  }

  inputs.forEach(function (i) { i.addEventListener('input', sync); });
  vouches.forEach(function (v) { v.addEventListener('change', sync); });

  form.addEventListener('click', function (e) {
    var step = e.target.closest('[data-step]');
    var set = e.target.closest('[data-set]');
    var input = (step || set) && (step || set).closest('.st').querySelector('.st__in');
    if (!input) return;
    if (step) {
      input.value = String(Math.max(0, (parseInt(input.value, 10) || 0) + parseInt(step.dataset.step, 10)));
    } else {
      input.value = set.dataset.set;
    }
    sync();
  });

  document.querySelectorAll('[data-filter]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('[data-filter]').forEach(function (c) { c.classList.toggle('is-on', c === chip); });
      state.filter = chip.dataset.filter;
      // Keep the choice in the URL so a reload, the back button and a shared link all
      // land on the same view - without a round trip to do it.
      var url = new URL(window.location.href);
      if (state.filter === 'all') url.searchParams.delete('filter');
      else url.searchParams.set('filter', state.filter);
      window.history.replaceState({}, '', url);
      apply();
    });
  });

  if (search) {
    search.addEventListener('input', function (e) {
      state.q = e.target.value.trim().toLowerCase();
      apply();
    });
  }

  // Bulk moves: the point of filtering to a set is being able to act on all of it.
  var fixall = document.getElementById('fixall');
  if (fixall) fixall.addEventListener('click', function () {
    cards.forEach(function (c) {
      if (c.dataset.drift !== '1' || !c.dataset.lowest) return;
      c.querySelector('.st__in').value = c.dataset.lowest;
    });
    sync();
  });

  var vouchall = document.getElementById('vouchall');
  if (vouchall) vouchall.addEventListener('click', function () {
    vouches.forEach(function (v) { v.checked = true; });
    sync();
  });

  apply();
  sync();
})();`,
  });
}

/**
 * Product view: the seller's own catalogue, with each channel's listing beside it.
 *
 * The marketplaces only know isolated SKUs. Grouping by the master catalogue is what
 * makes "Moringa Powder, three sizes" visible again, and what lets a bundle be shown
 * against the components it is actually assembled from.
 */
export function renderProducts({ catalog, ledger, plan, errors, range, shopeeShop, generatedAt, csrf, flash, selected, images = {}, user = null, listing = null, creating = false, duplicateOf = null, shopifyAdmin = null }) {
  const live = new Map(catalog.skus.map((e) => [e.sku, e]));
  const stockOf = (sku) => {
    const entry = live.get(sku);
    if (!entry) return null;
    const values = [entry.tiktok?.qty, entry.shopee?.qty].filter((v) => typeof v === 'number');
    return values.length > 0 ? Math.min(...values) : null;
  };

  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;

  // The sync plan lived on its own tab that showed the same SKUs twice. It belongs here,
  // as a single bar that only appears when there is something to do.
  // The ledger's old review bar is gone: the stock follower writes the master figure to
  // every channel on its own, so there is no plan waiting here for anybody to approve.
  const syncBar = '';

  if (creating) {
    return shell({ user, csrf, title: 'Tambah produk', range, errors, shopeeShop, generatedAt, view: 'products',
      hideRangeControls: true, flash, body: productForm({ catalog, csrf, duplicateOf }), style: PF_STYLE, script: PF_SCRIPT });
  }

  const detail = selected ? findProduct(selected) : null;
  if (detail) {
    return shell({ user,
      csrf,
      title: detail.name,
      range, errors, shopeeShop, generatedAt,
      view: 'products',
      hideRangeControls: true,
      flash,
      stale: Boolean(catalog.stale),
      staleSince: catalog.savedAt ? wibStamp(catalog.savedAt) : null,
      kpis: '',
      body: productDetail({ product: detail, live, ledger, stockOf, csrf, plan, picture: images[detail.sku] ?? images[selected] ?? null, images, listing, templates: { tiktok: exampleListings(catalog, 'tiktok'), shopee: exampleListings(catalog, 'shopee') }, shopifyAdmin }),
      style: PF_STYLE,
      script: PF_SCRIPT,
    });
  }

  // Which channels could not be read at all. Counts derived from a partial catalogue
  // are not facts, so they are withheld rather than shown as if complete.
  const blindTo = [];
  if (errors.tiktok) blindTo.push('Tokopedia + TikTok');
  if (errors.shopee) blindTo.push('Shopee');
  if (errors.shopify) blindTo.push('Shopify');
  // Hide the Shopify column entirely when the store is not connected, rather than
  // showing an empty one that reads as "no stock there".
  const shopifyOn = catalog.skus.some((e) => e.shopify) || Boolean(errors.shopify);
  const partial = blindTo.length > 0;

  const listedCount = PRODUCTS.filter((p) => live.has(p.sku)).length;
  const missing = PRODUCTS.filter((p) => !live.has(p.sku));
  const drift = partial ? [] : unmapped(catalog.skus).filter((e) => e.tiktok || e.shopee || e.shopify);

  // One table, not one per category: separate tables cannot share column widths, so the
  // numbers drifted out of alignment down the page and the header repeated six times.
  const cell = (product) => {
    const entry = live.get(product.sku);
    const tt = entry?.tiktok?.qty ?? null;
    const sp = entry?.shopee?.qty ?? null;
    const sy = entry?.shopify?.qty ?? null;
    const price = entry?.tiktok?.price ?? entry?.shopee?.price ?? entry?.shopify?.price ?? null;

    return { entry, tt, sp, sy, price };
  };

  // A card grid rather than a table: the table spent most of its width on empty space in
  // the product column, so 23 products needed twice the scrolling they deserve.
  const cards = groupProducts()
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => {
        // Products standing alone lead, families with a heading follow: a lone card after
        // a family reads as one more of its variants (the Discovery Pack looked like a
        // fourth Ritual Set).
        const size = (p) => group.items.filter((q) => familyOf(q) === familyOf(p)).length;
        const grouped = (p) => size(p) > 1 && size(p) < group.items.length;
        if (grouped(a) !== grouped(b)) return grouped(a) ? 1 : -1;
        if (familyOf(a) !== familyOf(b)) return familyOf(a).localeCompare(familyOf(b));
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        // Sizes read in numeric order, not alphabetic: 45 before 180.
        const na = Number((String(a.variant ?? '').match(/\d+/) ?? [])[0]);
        const nb = Number((String(b.variant ?? '').match(/\d+/) ?? [])[0]);
        if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
        return String(a.variant ?? '').localeCompare(String(b.variant ?? ''));
      }),
    }))
    .flatMap((group) => [
      `<h3 class="grp">${escape(group.label)}<span class="grp__n">${group.items.length}</span></h3>`,
      ...group.items.flatMap((product, index, items) => {
        /*
         * Variants of one product sit under its name, the way the stock tab reads.
         *
         * The three Inside Out protocols and the three Ritual Set + Powder sizes were six
         * cards in a row with nothing saying which belonged together. A family of one gets
         * no heading - it would only repeat the card's own name - and neither does a family
         * that is the whole category, which the category heading already names.
         */
        const family = familyOf(product);
        const size = items.filter((p) => familyOf(p) === family).length;
        const first = index === 0 || familyOf(items[index - 1]) !== family;
        const heading = size > 1 && size < items.length && first
          ? `<h4 class="grp grp--fam">${escape(family)}<span class="grp__n">${size} varian</span></h4>`
          : '';
        return [heading, cardFor(product)];
      }),
    ])
    .join('');

  function cardFor(product) {
    // No status tags and no flag, on request: these are display figures rather than a
    // warehouse count, so a card has nothing to warn about. The three numbers say it all.
    const { tt, sp, sy, price } = cell(product);
    const qty = (value, failed) =>
      failed ? '<span class="stop">?</span>'
      : value === null ? '<span class="dim">&mdash;</span>'
      : `<b>${value}</b>`;

    const picture = images[product.sku];
    const entry = live.get(product.sku);
    // Where it stands on each channel, for the dots and for the status filters.
    const st = (key) => (entry?.[key]?.rows?.length ? 'live'
      : (entry?.[`${key}_ignored`] ?? entry?.[key]?.ignored ?? []).some((r) => r.status !== 'DELETED') ? 'off' : 'none');
    const states = { tiktok: st('tiktok'), shopee: st('shopee'), shopify: st('shopify') };
    const href = `?view=products&sku=${encodeURIComponent(product.sku)}`;
    return `<div class="card" data-sku="${escape(product.sku)}" data-st="${Object.entries(states).map(([k, v]) => `${k}:${v}`).join(' ')}">
      <label class="card__pick"><input type="checkbox" data-pick value="${escape(product.sku)}" aria-label="Pilih ${escape(product.name)}${product.variant ? ` ${escape(product.variant)}` : ''}"></label>
      <a class="card__link" href="${href}">
      ${picture?.thumb
        ? `<img class="card__img" src="${escape(picture.thumb)}" alt="${escape(picture.alt || product.name)}" loading="lazy" width="240" height="180" decoding="async">`
        : '<span class="card__img card__img--none" aria-hidden="true">tanpa gambar</span>'}
      <span class="card__top">
        <span class="card__name">${escape(product.name)}${product.variant ? ` <span class="note">${escape(product.variant)}</span>` : ''}</span>
        ${isBundle(product) ? '<span class="badge badge--b">bundle</span>' : ''}
        ${product.gift ? '<span class="badge">gift</span>' : ''}
      </span>
      <span class="card__sku mono">${escape(product.sku)}</span>
      <span class="card__stock mono">
        <span class="qty"><i>Tokped</i>${qty(tt, errors.tiktok)}</span>
        <span class="qty"><i>Shopee</i>${qty(sp, errors.shopee)}</span>
        ${shopifyOn ? `<span class="qty"><i>Shopify</i>${qty(sy, errors.shopify)}</span>` : ''}
      </span>
      <span class="card__foot">
        <span class="mono">${price === null ? '<span class="dim">&mdash;</span>' : escape(rupiah(price))}</span>
        <span class="card__dots" aria-label="Status kanal">${[['tiktok', 'Tokopedia + TikTok'], ['shopee', 'Shopee'], ['shopify', 'Shopify']].map(([k, label]) =>
          `<i class="dot dot--${states[k]}" title="${label}: ${states[k] === 'live' ? 'tayang' : states[k] === 'off' ? 'nonaktif' : 'belum ada'}"></i>`).join('')}</span>
      </span>
      </a>
    </div>`;
  }

  /*
   * Filters by where a product stands, the questions an omnichannel list answers first:
   * what is not on Shopee yet, what is switched off somewhere.
   */
  const FILTERS = [['all', 'Semua'], ['everywhere', 'Tayang di semua'], ['no-tiktok', 'Belum di Tokopedia/TikTok'],
    ['no-shopee', 'Belum di Shopee'], ['no-shopify', 'Belum di Shopify'], ['off', 'Ada yang nonaktif']];
  const toolbar = `<div class="pl__bar">
      <div class="pl__filters" role="group" aria-label="Saring status kanal">${FILTERS.map(([k, label], i) =>
        `<button class="chip${i === 0 ? ' is-on' : ''}" type="button" data-filter="${k}" aria-pressed="${i === 0}">${label}</button>`).join('')}</div>
      <div class="pl__view" role="group" aria-label="Tampilan">
        <button class="pl__vbtn is-on" type="button" data-view="grid" aria-pressed="true" title="Grid">${svg('grid')}<span class="visually-hidden">Grid</span></button>
        <button class="pl__vbtn" type="button" data-view="table" aria-pressed="false" title="Tabel">${svg('list')}<span class="visually-hidden">Tabel</span></button>
      </div>
    </div>`;

  /*
   * What a selection can do, all at once. Each action asks for its one value, confirms
   * with the number it will write, and answers with how many listings it reached.
   */
  // Shopify is edited in Shopify, so no bulk action offers it.
  const CH = [['tiktok', 'Tokopedia + TikTok'], ['shopee', 'Shopee']];
  const chSelect = (name) => `<select name="${name}" aria-label="Kanal">${CH.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`;
  const chBoxes = () => `<span class="bk__chs">${CH.map(([k, l]) => `<label><input type="checkbox" name="channel" value="${k}" checked><span>${l}</span></label>`).join('')}</span>`;
  const bulkForm = (action, label, inner, confirmText) => `<form class="bk__f" method="post" data-bulk="${action}" data-confirm="${escape(confirmText)}" hidden>
      <input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="action" value="${action}">${inner}
      <button class="pf__primary" type="submit">${label}</button><button class="pf__ghost" type="button" data-bulk-close>Batal</button></form>`;
  const bulkBar = `<div class="bk" data-bk hidden role="region" aria-label="Aksi untuk produk terpilih">
      <div class="bk__row">
        <span class="bk__n" aria-live="polite"><b data-bk-n>0</b> dipilih</span>
        <button class="bk__btn" type="button" data-bulk-open="bulk_price">Ubah harga</button>
        <button class="bk__btn" type="button" data-bulk-open="bulk_stock">Set stok induk</button>
        <button class="bk__btn" type="button" data-bulk-open="bulk_active_off">Nonaktifkan</button>
        <button class="bk__btn" type="button" data-bulk-open="bulk_active_on">Aktifkan</button>
        <button class="bk__btn" type="button" data-bulk-open="bulk_publish">Publikasikan</button>
        <button class="bk__btn bk__btn--bad" type="button" data-bulk-open="bulk_remove">Hapus dari daftar</button>
        <span class="pe__grow"></span>
        <button class="bk__btn" type="button" data-bk-clear>Batal pilih</button>
      </div>
      ${bulkForm('bulk_price', 'Setel harga', `<label class="bk__in"><span>Harga (Rp)</span><input name="price" type="number" min="100" step="1" inputmode="numeric" required class="mono"></label>${chBoxes()}`, 'Setel harga Rp{price} untuk {n} produk di kanal terpilih?')}
      ${bulkForm('bulk_stock', 'Setel stok', `<label class="bk__in"><span>Stok induk</span><input name="qty" type="number" min="0" step="1" inputmode="numeric" required class="mono"></label>`, 'Setel stok induk {n} produk menjadi {qty}? Semua kanal akan mengikutinya.')}
      ${bulkForm('bulk_active', 'Nonaktifkan', `<input type="hidden" name="active" value="0"><label class="bk__in"><span>Di kanal</span>${chSelect('channel')}</label>`, 'Nonaktifkan {n} produk di kanal terpilih? Bisa diaktifkan lagi.').replace('data-bulk="bulk_active"', 'data-bulk="bulk_active_off"')}
      ${bulkForm('bulk_active', 'Aktifkan', `<input type="hidden" name="active" value="1"><label class="bk__in"><span>Di kanal</span>${chSelect('channel')}</label>`, 'Aktifkan lagi {n} produk di kanal terpilih?').replace('data-bulk="bulk_active"', 'data-bulk="bulk_active_on"')}
      ${bulkForm('bulk_publish', 'Publikasikan', `<label class="bk__in"><span>Ke kanal</span>${chSelect('channel')}</label><label class="bk__chk"><input type="checkbox" name="mode" value="draft"><span>Sebagai draft</span></label>`, 'Publikasikan {n} produk ke kanal terpilih memakai konten & foto listing yang sudah ada?')}
      ${bulkForm('bulk_remove', 'Hapus dari daftar', '<span class="bk__note">Listing di marketplace tidak disentuh; bisa dikembalikan.</span>', 'Hapus {n} produk dari daftar? Bisa dikembalikan.')}
    </div>`;

  const groups = `${toolbar}<div class="cards" id="rows">${cards}</div>${bulkBar}`;

  const driftNote = drift.length > 0
    ? `<p class="sec">Tayang tapi belum ada di data master</p>
       <div class="scroll"><table>
         <thead><tr><th>SKU</th><th>Judul listing</th><th class="num">Tokped</th><th class="num">Shopee</th><th class="num">Shopify</th></tr></thead>
         <tbody>${drift.map((e) => `<tr>
           <td class="mono nowrap">${escape(e.sku)}</td>
           <td>${escape(e.title)}</td>
           <td class="num mono">${e.tiktok?.qty ?? '&mdash;'}</td>
           <td class="num mono">${e.shopee?.qty ?? '&mdash;'}</td>
           <td class="num mono">${e.shopify?.qty ?? '&mdash;'}</td>
         </tr>`).join('')}</tbody>
       </table></div>`
    : '';

  return shell({ user,
    style: PF_STYLE,
    csrf,
    title: 'Produk',
    range, errors, shopeeShop, generatedAt,
    view: 'products',
    hideRangeControls: true,
    flash,
    stale: Boolean(catalog.stale),
    staleSince: catalog.savedAt ? wibStamp(catalog.savedAt) : null,
    kpis: `<div class="strip">
      ${stat('Produk master', String(PRODUCTS.length))}
      ${stat('Sudah tayang', partial ? '?' : String(listedCount))}
      ${stat('Belum tayang', partial ? '?' : String(missing.length), missing.length > 0 && !partial ? 'flag' : '')}
      ${stat('Di luar master', partial ? '?' : String(drift.length))}
      <span class="strip__grow"></span>
      <input class="search" id="q" type="search" aria-label="Cari produk atau SKU" placeholder="Cari produk atau SKU...">
      <a class="cta" href="?view=products&amp;new=1">${svg('plus')}<span>Tambah produk</span></a>
    </div>`,
    body: `${syncBar}${groups}${removedNote(csrf)}${driftNote}
      <div class="foot">
        <span id="shown"></span>
        <span>Klik kartu untuk melihat dan mengubah data di tiap kanal.</span>
      </div>`,
    script: `
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#rows .card'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('#rows .grp'));
  var shown = document.getElementById('shown');
  var search = document.getElementById('q');
  var grid = document.getElementById('rows');
  var state = { q: '', filter: 'all' };
  var KEYS = ['tiktok', 'shopee', 'shopify'];

  function standing(row) {
    var map = {};
    (row.dataset.st || '').split(' ').forEach(function (p) { var kv = p.split(':'); map[kv[0]] = kv[1]; });
    return map;
  }
  function passes(row) {
    var st = standing(row);
    switch (state.filter) {
      case 'everywhere': return KEYS.every(function (k) { return st[k] === 'live'; });
      case 'no-tiktok': return st.tiktok !== 'live';
      case 'no-shopee': return st.shopee !== 'live';
      case 'no-shopify': return st.shopify !== 'live';
      case 'off': return KEYS.some(function (k) { return st[k] === 'off'; });
      default: return true;
    }
  }

  function apply() {
    var n = 0;
    rows.forEach(function (row) {
      var text = row.textContent.toLowerCase();
      var ok = (state.q === '' || text.indexOf(state.q) !== -1) && passes(row);
      row.hidden = !ok;
      if (ok) n++;
    });
    // A heading with nothing under it is noise, so it hides with its rows. A category
    // reaches to the next category, over its families' headings; a family reaches only
    // to the next heading of either kind. Only cards count as something under it.
    groups.forEach(function (grp) {
      var family = grp.classList.contains('grp--fam');
      var any = false;
      for (var el = grp.nextElementSibling; el; el = el.nextElementSibling) {
        if (el.classList.contains('grp') && (family || !el.classList.contains('grp--fam'))) break;
        if (el.classList.contains('card') && !el.hidden) { any = true; break; }
      }
      grp.hidden = !any;
    });
    shown.textContent = n + ' produk';
  }

  search.addEventListener('input', function (e) {
    state.q = e.target.value.trim().toLowerCase();
    apply();
  });

  document.querySelectorAll('[data-filter]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      state.filter = chip.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(function (c) {
        var on = c === chip;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      apply();
    });
  });

  // Grid or table, remembered per browser.
  var VIEW = 'omni-products-view';
  function setView(v) {
    grid.classList.toggle('is-table', v === 'table');
    document.querySelectorAll('[data-view]').forEach(function (b) {
      var on = b.dataset.view === v;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    try { localStorage.setItem(VIEW, v); } catch (e) {}
  }
  document.querySelectorAll('[data-view]').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.view); }); });
  try { if (localStorage.getItem(VIEW) === 'table') setView('table'); } catch (e) {}

  // Selection and the bulk bar.
  var bar = document.querySelector('[data-bk]');
  var count = document.querySelector('[data-bk-n]');
  function picked() { return Array.prototype.filter.call(document.querySelectorAll('[data-pick]'), function (c) { return c.checked; }); }
  function sync() {
    var list = picked();
    rows.forEach(function (row) { var c = row.querySelector('[data-pick]'); row.classList.toggle('is-picked', Boolean(c && c.checked)); });
    grid.classList.toggle('is-picking', list.length > 0);
    bar.hidden = list.length === 0;
    count.textContent = list.length;
  }
  grid.addEventListener('change', function (e) { if (e.target.matches('[data-pick]')) sync(); });
  document.querySelector('[data-bk-clear]').addEventListener('click', function () {
    document.querySelectorAll('[data-pick]').forEach(function (c) { c.checked = false; });
    closeForms(); sync();
  });
  function closeForms() {
    bar.querySelectorAll('[data-bulk]').forEach(function (f) { f.hidden = true; });
    bar.querySelectorAll('[data-bulk-open]').forEach(function (b) { b.classList.remove('is-on'); });
  }
  bar.querySelectorAll('[data-bulk-open]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var f = bar.querySelector('[data-bulk="' + btn.dataset.bulkOpen + '"]');
      var open = f.hidden;
      closeForms();
      if (open) { f.hidden = false; btn.classList.add('is-on'); var first = f.querySelector('input:not([type=hidden]), select'); if (first) first.focus(); }
    });
  });
  bar.querySelectorAll('[data-bulk-close]').forEach(function (b) { b.addEventListener('click', closeForms); });
  // Before the confirmation reads it: the chosen SKUs travel as fields, and the question
  // quotes the count and the value it will write.
  bar.querySelectorAll('[data-bulk]').forEach(function (f) {
    f.addEventListener('submit', function () {
      f.querySelectorAll('input[name="sku"]').forEach(function (i) { i.remove(); });
      picked().forEach(function (c) {
        var i = document.createElement('input');
        i.type = 'hidden'; i.name = 'sku'; i.value = c.value; f.appendChild(i);
      });
      var text = f.dataset.confirmTemplate || f.dataset.confirm;
      f.dataset.confirmTemplate = text;
      var price = f.querySelector('[name=price]'); var qty = f.querySelector('[name=qty]');
      f.dataset.confirm = text.replace('{n}', picked().length)
        .replace('{price}', price ? Number(price.value || 0).toLocaleString('id-ID') : '')
        .replace('{qty}', qty ? qty.value : '');
    }, true);
  });
  apply();
})();`,
  });
}

/** One product: what each channel holds, and the controls to change it. */
/* ------------------------------------------------------------- product catalogue */

const CATEGORY_OPTIONS = (current) => Object.entries(CATEGORIES)
  .map(([key, label]) => `<option value="${key}" ${key === current ? 'selected' : ''}>${escape(label)}</option>`).join('');

/** Families already in use, offered as suggestions so a new variant joins its siblings. */
const familyList = () => [...new Set(PRODUCTS.map((p) => familyOf(p)))].sort()
  .map((f) => `<option value="${escape(f)}"></option>`).join('');

const partOptions = (selected, exclude) => PRODUCTS.filter((p) => p.sku !== exclude && !isBundle(p))
  .map((p) => `<option value="${escape(p.sku)}" ${p.sku === selected ? 'selected' : ''}>${escape(p.name)}${p.variant ? ` · ${escape(p.variant)}` : ''}</option>`).join('');

/**
 * The master's own facts, as fields. Shared by the new-product form and a product's page,
 * so both say the same thing the same way.
 */
function masterFields(product = null, { idPrefix = 'm', fresh = false } = {}) {
  // `fresh`: a form for a new product, even when filled from another (a duplicate).
  const locked = Boolean(product?.sku) && !fresh;
  const parts = product?.components?.length ? product.components : [];
  const partRow = (part = { sku: '', qty: 1 }) => `<div class="pf__part" data-part>
      <label class="visually-hidden" for="${idPrefix}-ps-${part.sku || 'new'}">Produk</label>
      <select name="part_sku" id="${idPrefix}-ps-${part.sku || 'new'}"><option value="">Pilih produk…</option>${partOptions(part.sku, product?.sku)}</select>
      <label class="visually-hidden" for="${idPrefix}-pq-${part.sku || 'new'}">Jumlah</label>
      <input name="part_qty" id="${idPrefix}-pq-${part.sku || 'new'}" type="number" min="1" max="99" step="1" value="${part.qty}" inputmode="numeric">
      <button class="pf__x" type="button" data-part-remove aria-label="Hapus baris isi bundle">${svg('x')}</button>
    </div>`;
  return `<div class="pf__grid">
      <label class="pf__f"><span>SKU <i aria-hidden="true">*</i></span>
        <input name="sku" required pattern="[A-Za-z0-9][A-Za-z0-9+&amp;._\\-]{1,49}" maxlength="50" autocomplete="off" spellcheck="false"
          value="${escape(product?.sku ?? '')}" ${locked ? 'readonly aria-readonly="true"' : 'autofocus'} class="mono" placeholder="mis. OMC-360-001">
        <small>${locked ? 'SKU tidak bisa diubah: ini yang menyambungkan pesanan, stok dan faktur.' : 'Dipakai sebagai SKU penjual di semua kanal.'}</small></label>
      <label class="pf__f"><span>Kategori <i aria-hidden="true">*</i></span>
        <select name="category" required data-category>${CATEGORY_OPTIONS(product?.category ?? 'capsules')}</select></label>
      <label class="pf__f"><span>Nama produk <i aria-hidden="true">*</i></span>
        <input name="name" required maxlength="120" value="${escape(product?.name ?? '')}" placeholder="mis. Moringa Capsules"></label>
      <label class="pf__f"><span>Varian</span>
        <input name="variant" maxlength="80" value="${escape(product?.variant ?? '')}" placeholder="mis. 360 caps"></label>
      <label class="pf__f"><span>Keluarga</span>
        <input name="family" list="${idPrefix}-families" maxlength="120" value="${escape(product?.family ?? '')}" placeholder="kosong = sama dengan nama">
        <datalist id="${idPrefix}-families">${familyList()}</datalist>
        <small>Produk dengan keluarga sama dikelompokkan di daftar.</small></label>
      <label class="pf__f"><span>Alias SKU</span>
        <input name="aliases" maxlength="400" value="${escape((product?.aliases ?? []).join(', '))}" class="mono" placeholder="OMC360, 1731…">
        <small>Ejaan lain untuk produk yang sama di kanal lain, pisahkan dengan koma.</small></label>
      <div class="pf__f pf__f--wide"><span>Isi bundle</span>
        <div class="pf__parts" data-parts>${parts.map(partRow).join('')}</div>
        <template data-part-template>${partRow()}</template>
        <button class="pf__add" type="button" data-part-add>${svg('plus')}<span>Tambah isi</span></button>
        <small>Kosongkan untuk produk tunggal.</small></div>
      <label class="pf__check"><input type="checkbox" name="gift" value="1" ${product?.gift ? 'checked' : ''}><span>Hadiah gratis, tidak dijual terpisah</span></label>
    </div>`;
}

/** A product's master facts on its own page, with the way out of the catalogue. */
function masterEditor(product, csrf) {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  return `<p class="sec">Data master</p>
    <form class="pf pf--inline" method="post" data-confirm="Simpan data master ${escape(product.sku)}?">
      ${hidden}
      <input type="hidden" name="action" value="product_master">
      <input type="hidden" name="back" value="?view=products&amp;sku=${encodeURIComponent(product.sku)}">
      ${masterFields(product, { idPrefix: 'me' })}
      <div class="pf__go">
        <button class="pf__ghost" type="submit" form="pf-remove">${svg('trash')}<span>Hapus dari daftar</span></button>
        <button class="pf__primary" type="submit">Simpan data master</button>
      </div>
    </form>
    <form id="pf-remove" method="post" hidden data-confirm="Hapus ${escape(product.sku)} dari daftar produk? Listing di marketplace tidak disentuh, pesanan lama tetap terbaca, dan produk bisa dikembalikan.">
      ${hidden}
      <input type="hidden" name="action" value="product_remove">
      <input type="hidden" name="sku" value="${escape(product.sku)}">
      <input type="hidden" name="removed" value="1">
    </form>`;
}

/** Products taken out of the list, each one press from coming back. */
function removedNote(csrf) {
  const gone = allProducts().filter((p) => isRemoved(p.sku));
  if (gone.length === 0) return '';
  return `<details class="pf-gone">
      <summary>${gone.length} produk dihapus dari daftar</summary>
      <ul>${gone.map((p) => `<li><span>${escape(p.name)}${p.variant ? ` <span class="note">${escape(p.variant)}</span>` : ''} <span class="mono dim">${escape(p.sku)}</span></span>
        <form method="post"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="action" value="product_remove">
          <input type="hidden" name="sku" value="${escape(p.sku)}"><input type="hidden" name="removed" value="0">
          <button class="pf__ghost" type="submit">${svg('check2')}<span>Kembalikan</span></button></form></li>`).join('')}</ul>
    </details>`;
}

/** Live listings on a channel, one per listing, as examples a new listing can copy. */
function exampleListings(catalog, channel) {
  const seen = new Map();
  for (const entry of catalog?.skus ?? []) {
    for (const row of entry[channel]?.rows ?? []) {
      const id = channel === 'tiktok' ? row.productId : row.itemId;
      if (!id) continue;
      // One listing can carry several SKUs (the capsules listing holds 90, 180 and 270);
      // every one is remembered, so a duplicate of any of them finds its own listing.
      const known = seen.get(String(id));
      if (known) { if (!known.skus.includes(entry.sku)) known.skus.push(entry.sku); continue; }
      seen.set(String(id), { id, title: row.title ?? entry.title, sku: entry.sku, skus: [entry.sku], category: findProduct(entry.sku)?.category ?? '' });
    }
  }
  return [...seen.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)));
}

/**
 * A new product, and its listings on the channels ticked.
 *
 * Three steps on one page, in the order somebody thinks them: what it is, what the
 * listing says, where it goes. The marketplace-only requirements - category, attributes,
 * brand, logistics, certificates - come from an example listing picked per channel,
 * defaulted to one of the same kind, so nobody has to know Shopee's category tree.
 */
function productForm({ catalog, csrf, duplicateOf = null }) {
  // A duplicate starts from its source: same kind, same family, same listing text and box,
  // the source's own listing as the example, and its pictures unless replaced. SKU and
  // variant are left empty - they are what makes it a different product.
  const src = duplicateOf ? findProduct(duplicateOf.sku) : null;
  const srcL = duplicateOf?.listing?.data ?? null;
  const srcEntry = src ? catalog.skus.find((e) => e.sku === src.sku) : null;
  const seed = src ? { ...src, sku: '', variant: '', aliases: [], family: src.family ?? src.name } : null;
  const listings = (channel) => exampleListings(catalog, channel);
  const channelCard = (key, label, note, options) => {
    const list = options ?? [];
    const usable = key === 'shopify' || list.length > 0;
    return `<div class="pf__ch${usable ? '' : ' is-off'}" data-ch="${key}">
      <label class="pf__chhead"><input type="checkbox" name="channel" value="${key}" ${usable ? 'checked' : 'disabled'} data-ch-toggle>
        <span class="pf__chname">${label}</span></label>
      <p class="pf__chnote">${note}</p>
      ${options ? `<label class="pf__f"><span>Salin kategori &amp; atribut dari</span>
        <select name="template_${key}" data-template ${src ? 'data-fixed' : ''}>${list.map((l) => `<option value="${escape(String(l.id))}" data-category="${escape(l.category)}" ${src && l.skus.includes(src.sku) ? 'selected' : ''}>${escape(String(l.title).slice(0, 90))}</option>`).join('')}</select></label>` : ''}
    </div>`;
  };
  return `<a class="pf-back" href="${src ? `?view=products&amp;sku=${encodeURIComponent(src.sku)}` : '?view=products'}">${svg('chevL')}<span>${src ? escape(src.name) : 'Produk'}</span></a>
  ${src ? `<p class="pf__dup">Duplikat dari <b>${escape(src.name)}${src.variant ? ` ${escape(src.variant)}` : ''}</b> <span class="mono dim">${escape(src.sku)}</span>. Isi SKU dan varian baru, sisanya sudah disalin.</p>` : ''}
  <form class="pf" method="post" enctype="multipart/form-data" novalidate data-pf
        data-confirm="Buat produk baru di kanal terpilih?">
    <input type="hidden" name="csrf" value="${escape(csrf)}">
    <input type="hidden" name="action" value="product_create">
    <input type="hidden" name="back" value="?view=products&amp;new=1">
    <div class="pf__err" role="alert" aria-live="assertive" hidden data-pf-err></div>

    <section class="pf__step" aria-labelledby="pf-s1">
      <header><span class="pf__n" aria-hidden="true">1</span><h2 id="pf-s1">Produk</h2><p>Cara dashboard mengenal produk ini: untuk stok, pesanan, faktur, dan label.</p></header>
      ${masterFields(seed, { idPrefix: 'pn', fresh: true })}
    </section>

    <section class="pf__step" aria-labelledby="pf-s2">
      <header><span class="pf__n" aria-hidden="true">2</span><h2 id="pf-s2">Listing</h2><p>Yang dilihat pembeli. Sama untuk semua kanal yang dipilih.</p></header>
      <div class="pf__grid">
        <label class="pf__f pf__f--wide"><span>Judul listing <i aria-hidden="true">*</i></span>
          <input name="title" required minlength="5" maxlength="255" data-listing placeholder="TREELOGY - Organic Moringa Capsules | Kapsul Daun Kelor Premium" value="${escape(srcL?.title ?? '')}">
          <small data-count="title">${(srcL?.title ?? '').length} / 255</small></label>
        <label class="pf__f pf__f--wide"><span>Deskripsi <i aria-hidden="true">*</i></span>
          <textarea name="description" required minlength="20" rows="8" data-listing placeholder="Manfaat, isi, cara pakai, penyimpanan, sertifikasi…">${escape(srcL?.description ?? '')}</textarea>
          <small>Paragraf dipisah baris kosong.</small></label>
        <label class="pf__f"><span>Harga (Rp) <i aria-hidden="true">*</i></span>
          <input name="price" type="number" required min="100" step="1" inputmode="numeric" data-listing class="mono" placeholder="525000" value="${escape(String(srcEntry?.tiktok?.price ?? srcEntry?.shopee?.price ?? srcEntry?.shopify?.price ?? ''))}"></label>
        <label class="pf__f"><span>Stok awal <i aria-hidden="true">*</i></span>
          <input name="stock" type="number" required min="1" max="99999" step="1" inputmode="numeric" data-listing class="mono" value="150">
          <small>Menjadi stok induk; semua kanal mengikutinya.</small></label>
        <label class="pf__f"><span>Berat paket (gram) <i aria-hidden="true">*</i></span>
          <input name="weightGram" type="number" required min="1" step="1" inputmode="numeric" data-listing class="mono" placeholder="600" value="${srcL?.weightGram ?? ''}"></label>
        <div class="pf__f"><span>Dimensi paket (cm) <i aria-hidden="true">*</i></span>
          <div class="pf__dims">
            <input name="dimL" type="number" min="1" step="1" inputmode="numeric" aria-label="Panjang (cm)" placeholder="P" data-dim class="mono" value="${srcL?.dims?.l ?? ''}">
            <input name="dimW" type="number" min="1" step="1" inputmode="numeric" aria-label="Lebar (cm)" placeholder="L" data-dim class="mono" value="${srcL?.dims?.w ?? ''}">
            <input name="dimH" type="number" min="1" step="1" inputmode="numeric" aria-label="Tinggi (cm)" placeholder="T" data-dim class="mono" value="${srcL?.dims?.h ?? ''}">
          </div>
          <small>Wajib untuk Tokopedia/TikTok dan Shopee.</small></div>
        <div class="pf__f pf__f--wide"><span>Foto <i aria-hidden="true">*</i></span>
          <label class="pf__drop" data-drop>
            <input name="images" type="file" accept="image/jpeg,image/png" multiple data-images>
            ${svg('image')}<b>Pilih atau tarik foto ke sini</b><small>1-9 foto JPG/PNG, maksimal 10 MB per foto. Foto pertama jadi foto utama.</small>
          </label>
          <div class="pf__thumbs" data-thumbs aria-live="polite"></div>
          ${srcL?.images?.length ? `<label class="pf__check pf__reuse"><input type="checkbox" name="photos_from" value="${escape(src.sku)}" checked data-reuse>
            <span>Pakai ${Math.min(9, srcL.images.length)} foto ${escape(src.name)} bila tidak ada foto baru</span></label>
            <div class="pe__pics">${srcL.images.slice(0, 9).map((u, i) => `<figure><img src="${escape(u)}" alt="" width="84" height="84" loading="lazy">${i === 0 ? '<figcaption>Utama</figcaption>' : ''}</figure>`).join('')}</div>` : ''}</div>
      </div>
    </section>

    <section class="pf__step" aria-labelledby="pf-s3">
      <header><span class="pf__n" aria-hidden="true">3</span><h2 id="pf-s3">Kanal</h2><p>Hapus centang kanal yang tidak dipakai. Tanpa kanal, produk hanya masuk ke master. Produk Shopify dibuat langsung di Shopify; begitu SKU-nya sama, dashboard menyambungkannya sendiri.</p></header>
      <div class="pf__chs">
        ${channelCard('tiktok', 'Tokopedia + TikTok', 'Tayang di Tokopedia dan TikTok Shop sekaligus. Sertifikat BPOM ikut disalin dari listing contoh.', listings('tiktok'))}
        ${channelCard('shopee', 'Shopee', 'Jasa kirim, brand, dan atribut wajib ikut disalin dari listing contoh.', listings('shopee'))}
      </div>
      <fieldset class="pf__mode"><legend>Setelah dibuat</legend>
        <label><input type="radio" name="mode" value="live" checked><span><b>Tayangkan sekarang</b><small>Langsung bisa dibeli (TikTok tetap melewati review).</small></span></label>
        <label><input type="radio" name="mode" value="draft"><span><b>Simpan sebagai draft</b><small>Tidak terlihat pembeli: draft di TikTok, nonaktif di Shopee.</small></span></label>
      </fieldset>
    </section>

    <div class="pf__bar"><a class="pf__ghost" href="?view=products">Batal</a><button class="pf__primary" type="submit" data-pf-go>Buat produk</button></div>
  </form>`;
}

const PF_STYLE = `
.pf{display:flex; flex-direction:column; gap:1.1rem; margin-top:1rem}
.pf-back{display:inline-flex; align-items:center; gap:.35rem; min-height:36px; padding:.4rem .8rem .4rem .55rem; font-size:.84rem; font-weight:500;
  color:var(--muted); text-decoration:none; border:1px solid var(--line); border-radius:9px; background:var(--panel); transition:color var(--t-fast), border-color var(--t-fast)}
.pf-back:hover{color:var(--fg); border-color:var(--brand)}
.pf-back:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.pf-back .ico{width:16px; height:16px}
.pf--inline{margin:0; padding:1rem}
.pf__step{border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); padding:1.2rem 1.25rem 1.3rem}
.pf__step > header{display:grid; grid-template-columns:auto 1fr; column-gap:.75rem; align-items:center; margin-bottom:1.1rem}
.pf__step > header h2{margin:0; font-size:1rem; font-weight:600}
.pf__step > header p{grid-column:2; margin:.15rem 0 0; font-size:.8rem; color:var(--muted)}
.pf__n{grid-row:span 2; display:inline-grid; place-items:center; width:30px; height:30px; border-radius:50%; font-size:.8rem; font-weight:600;
  background:color-mix(in srgb, var(--brand) 18%, transparent); color:var(--brand); border:1px solid color-mix(in srgb, var(--brand) 40%, transparent)}
.pf__grid{display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:1rem 1.1rem}
.pf__f{display:flex; flex-direction:column; gap:.35rem; min-width:0}
.pf__f > span{font-size:.78rem; font-weight:500; color:var(--muted)}
.pf__f > span i{color:var(--cta-a); font-style:normal; margin-left:.15rem}
.pf__f--wide{grid-column:1/-1}
.pf__f small{font-size:.72rem; color:var(--dim); line-height:1.4}
.pf input:not([type=checkbox]):not([type=radio]):not([type=file]), .pf select, .pf textarea{font:inherit; font-size:.9rem; color:var(--fg);
  background:var(--panel-2); border:1px solid var(--line); border-radius:10px; padding:.6rem .75rem; min-height:44px; width:100%;
  transition:border-color var(--t-fast), box-shadow var(--t-fast)}
.pf textarea{resize:vertical; line-height:1.55; min-height:10rem}
.pf input[readonly]{color:var(--muted); background:transparent}
.pf input:focus-visible, .pf select:focus-visible, .pf textarea:focus-visible{outline:none; border-color:var(--brand); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand) 25%, transparent)}
.pf .is-bad{border-color:var(--bad) !important; box-shadow:0 0 0 3px color-mix(in srgb, var(--bad) 18%, transparent) !important}
.pf__msg{font-size:.72rem; color:var(--bad)}
.pf__dims{display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:.5rem}
.pf__parts{display:flex; flex-direction:column; gap:.5rem}
.pf__part{display:grid; grid-template-columns:minmax(0,1fr) 5.5rem 44px; gap:.5rem; align-items:center}
.pf__x{display:inline-grid; place-items:center; width:44px; height:44px; border-radius:10px; border:1px solid var(--line); background:transparent; color:var(--muted); cursor:pointer}
.pf__x:hover{color:var(--bad); border-color:var(--bad)}
.pf__x .ico{width:16px; height:16px}
.pf__add{align-self:flex-start; display:inline-flex; align-items:center; gap:.35rem; font:inherit; font-size:.8rem; min-height:40px; padding:.4rem .8rem;
  border-radius:10px; border:1px dashed var(--line); background:transparent; color:var(--muted); cursor:pointer}
.pf__add:hover{color:var(--fg); border-color:var(--brand)}
.pf__add .ico{width:15px; height:15px}
.pf__check{grid-column:1/-1; display:flex; align-items:center; gap:.55rem; font-size:.85rem; cursor:pointer; min-height:44px}
.pf__check input, .pf__chhead input, .pf__mode input{accent-color:var(--brand); width:18px; height:18px; margin:0}
.pf__drop{position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.3rem; text-align:center;
  min-height:8.5rem; padding:1.1rem; border:1.5px dashed var(--line); border-radius:var(--radius-s); background:var(--panel-2); cursor:pointer;
  color:var(--muted); transition:border-color var(--t-fast), background var(--t-fast)}
.pf__drop:hover, .pf__drop.is-over{border-color:var(--brand); background:color-mix(in srgb, var(--brand) 7%, var(--panel-2))}
.pf__drop .ico{width:26px; height:26px; color:var(--brand)}
.pf__drop--s{min-height:6rem; padding:.9rem}
.pf__dup{margin:.8rem 0 0; font-size:.86rem; color:var(--muted)}
.pf__reuse{margin-top:.4rem}
.pf__drop b{font-size:.88rem; color:var(--fg); font-weight:500}
.pf__drop input{position:absolute; inset:0; opacity:0; cursor:pointer}
.pf__drop:focus-within{outline:2px solid var(--brand); outline-offset:2px}
.pf__thumbs{display:flex; flex-wrap:wrap; gap:.55rem}
.pf__thumbs figure{position:relative; margin:0; width:84px}
.pf__thumbs img{width:84px; height:84px; object-fit:cover; border-radius:10px; border:1px solid var(--line); display:block}
.pf__thumbs figcaption{font-size:.66rem; color:var(--dim); margin-top:.2rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.pf__thumbs figure:first-child::after{content:'Utama'; position:absolute; top:6px; left:6px; font-size:.6rem; font-weight:600; letter-spacing:.04em;
  padding:.1rem .35rem; border-radius:5px; background:var(--brand); color:#fff}
.pf__chs{display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:.8rem}
.pf__ch{display:flex; flex-direction:column; gap:.6rem; padding:.95rem 1rem; border:1px solid var(--line); border-radius:var(--radius-s); background:var(--panel-2);
  transition:border-color var(--t-fast), opacity var(--t-fast)}
.pf__ch:has([data-ch-toggle]:checked){border-color:color-mix(in srgb, var(--brand) 55%, var(--line))}
.pf__ch:not(:has([data-ch-toggle]:checked)){opacity:.6}
.pf__ch.is-off{opacity:.45}
.pf__chhead{display:flex; align-items:center; gap:.55rem; cursor:pointer; min-height:32px}
.pf__chname{font-weight:600; font-size:.92rem}
.pf__chnote{margin:0; font-size:.75rem; color:var(--muted); line-height:1.45}
.pf__mode{display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:.75rem; border:0; margin:1rem 0 0; padding:0}
.pf__mode legend{font-size:.78rem; font-weight:500; color:var(--muted); margin-bottom:.5rem; padding:0}
.pf__mode label{display:flex; gap:.65rem; align-items:flex-start; padding:.8rem .9rem; border:1px solid var(--line); border-radius:var(--radius-s); cursor:pointer; background:var(--panel-2)}
.pf__mode label:has(input:checked){border-color:color-mix(in srgb, var(--brand) 55%, var(--line))}
.pf__mode span{display:flex; flex-direction:column; gap:.15rem}
.pf__mode b{font-size:.86rem; font-weight:600}
.pf__mode small{font-size:.74rem; color:var(--muted)}
.pf__bar{position:sticky; bottom:0; z-index:5; display:flex; justify-content:flex-end; gap:.75rem; padding:.9rem 1rem;
  border:1px solid var(--line); border-radius:var(--radius); background:color-mix(in srgb, var(--panel) 88%, transparent); backdrop-filter:blur(var(--blur))}
.pf__go{display:flex; justify-content:flex-end; gap:.65rem; margin-top:1.1rem}
.pf__primary{font:inherit; font-size:.88rem; font-weight:600; padding:.6rem 1.35rem; min-height:44px; border-radius:999px; cursor:pointer; color:#fff;
  border:1px solid transparent; background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent); transition:filter var(--t-base)}
.pf__primary:hover{filter:brightness(1.08)}
.pf__primary[aria-busy="true"]{opacity:.7; cursor:progress}
.pf__ghost{display:inline-flex; align-items:center; gap:.4rem; font:inherit; font-size:.82rem; min-height:44px; padding:.5rem 1rem; border-radius:999px;
  border:1px solid var(--line); background:transparent; color:var(--muted); cursor:pointer; text-decoration:none; transition:color var(--t-fast), border-color var(--t-fast)}
.pf__ghost:hover{color:var(--fg); border-color:var(--muted)}
.pf__ghost .ico{width:15px; height:15px}
.pf__primary:focus-visible, .pf__ghost:focus-visible, .pf__add:focus-visible, .pf__x:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.pf__err{padding:.8rem 1rem; border-radius:var(--radius-s); border:1px solid color-mix(in srgb, var(--bad) 45%, var(--line));
  background:color-mix(in srgb, var(--bad) 10%, var(--panel)); color:var(--fg); font-size:.84rem}
.pf-gone{margin:1.25rem 1rem 0; font-size:.84rem}
.pf-gone summary{cursor:pointer; color:var(--muted); min-height:32px}
.pf-gone ul{list-style:none; margin:.6rem 0 0; padding:0; display:flex; flex-direction:column; gap:.4rem}
.pf-gone li{display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.45rem .7rem; border:1px solid var(--line); border-radius:10px}
/* The product page: header actions, channel tiles, the one editor. */
.pe__head{display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; margin-bottom:.9rem}
.pe__head form{margin:0}
.pe__grow{flex:1}
.pe__name{font-size:1.05rem}
.pe__chips{display:flex; flex-wrap:wrap; gap:.4rem; margin-top:.55rem}
.pe__chip{display:inline-flex; align-items:center; gap:.4rem; font-size:.74rem; padding:.25rem .6rem; border-radius:999px; border:1px solid var(--line); color:var(--muted)}
.pe__chip i{width:8px; height:8px; border-radius:50%; background:var(--dim)}
.pe__chip--live{color:var(--fg)} .pe__chip--live i{background:var(--good, #6fbf73)}
.pe__chip--off i{background:transparent; border:1.5px solid var(--muted)}
.pe__chip--none{opacity:.7} .pe__chip--none i{background:transparent; border:1.5px dashed var(--dim)}
.cts{display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:.75rem; margin:1rem 0}
.ct{display:flex; flex-direction:column; gap:.55rem; padding:.9rem 1rem; border:1px solid var(--line); border-radius:var(--radius-s); background:var(--panel)}
.ct__top{display:flex; align-items:center; gap:.5rem; font-size:.9rem}
.ct__dot{width:9px; height:9px; border-radius:50%; background:var(--dim); flex:none}
.ct--live .ct__dot{background:var(--good, #6fbf73)}
.ct--off .ct__dot{background:transparent; border:1.5px solid var(--muted)}
.ct--none .ct__dot{background:transparent; border:1.5px dashed var(--dim)}
.ct__st{margin-left:auto; font-size:.72rem; color:var(--muted); letter-spacing:.04em; text-transform:uppercase}
.ct__kv{display:flex; gap:1.25rem; margin:0}
.ct__kv dt{font-size:.66rem; color:var(--dim); text-transform:uppercase; letter-spacing:.06em}
.ct__kv dd{margin:.1rem 0 0; font-size:.92rem; font-weight:600}
.ct__title{margin:0; font-size:.76rem; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.ct__acts{margin-top:auto; display:flex}
.ct__acts form{margin:0}
.ct__btn{display:inline-flex; align-items:center; gap:.35rem; font:inherit; font-size:.78rem; min-height:36px; padding:.35rem .75rem; border-radius:8px; cursor:pointer;
  border:1px solid var(--line); background:transparent; color:var(--muted); list-style:none; transition:color var(--t-fast), border-color var(--t-fast)}
.ct__btn::-webkit-details-marker{display:none}
.ct__btn:hover{color:var(--fg); border-color:var(--muted)}
.ct__btn--go{color:var(--brand); border-color:color-mix(in srgb, var(--brand) 45%, var(--line))}
.ct__btn .ico{width:14px; height:14px}
.ct__btn:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.ct__pub{width:100%}
.ct__pubf{display:flex; flex-direction:column; gap:.6rem; margin-top:.7rem}
.ct__pubf label{display:flex; flex-direction:column; gap:.3rem; font-size:.74rem; color:var(--muted)}
.ct__pubf select{font:inherit; font-size:.84rem; color:var(--fg); background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding:.5rem .6rem; min-height:40px}
.ct__pubf .ct__mode{flex-direction:row; align-items:center; gap:.45rem; font-size:.8rem; color:var(--fg)}
.ct__pubf small{font-size:.7rem; color:var(--dim)}
.ct__note{font-size:.74rem; color:var(--dim)}
.ct__need{display:flex; flex-direction:column; gap:.4rem; font-size:.74rem; color:var(--muted)}
.ct__need input{font:inherit; font-size:.84rem; color:var(--fg); background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding:.45rem .6rem; min-height:40px; width:100%}
.ct__dims{display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:.4rem}
.ct__fields{display:flex; flex-direction:column; gap:.7rem}
.ct__cat{display:flex; flex-direction:column; gap:.7rem; padding:.75rem; border-radius:var(--radius-s); border:1px solid color-mix(in srgb, var(--brand) 35%, var(--line)); background:color-mix(in srgb, var(--brand) 6%, transparent)}
.ct__catrow{display:flex; gap:.4rem}
.ct__catrow select{flex:1; min-width:0; font:inherit; font-size:.86rem; color:var(--fg); background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding:.5rem .6rem; min-height:42px}
.ct__again{display:inline-grid; place-items:center; width:42px; height:42px; flex:none; border-radius:9px; border:1px solid var(--line); background:var(--panel-2); color:var(--muted); cursor:pointer}
.ct__again:hover{color:var(--brand); border-color:var(--brand)}
.ct__again .ico{width:16px; height:16px}
.ct__again.is-busy .ico{animation:ct-spin .9s linear infinite}
@keyframes ct-spin{to{transform:rotate(360deg)}}
.ct__attrs{display:flex; flex-direction:column; gap:.6rem}
.ct__attrs:empty{display:none}
.ct__ah{margin:.1rem 0 0; font-size:.68rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted)}
.ct__a{display:flex; flex-direction:column; gap:.3rem; font-size:.76rem; color:var(--muted)}
.ct__a > b{font-weight:500; color:var(--fg); font-size:.8rem}
.ct__a > b i{font-style:normal; color:var(--bad)}
.ct__a select, .ct__a input[type=text]{font:inherit; font-size:.84rem; color:var(--fg); background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding:.45rem .6rem; min-height:40px; width:100%}
.ct__a .ct__pair{display:flex; gap:.4rem} .ct__a .ct__pair select{width:auto}
.ct__chips{display:flex; flex-wrap:wrap; gap:.3rem}
.ct__chips label{display:inline-flex !important; flex-direction:row !important; align-items:center; gap:.3rem !important; font-size:.76rem !important; color:var(--fg) !important; padding:.25rem .6rem; border:1px solid var(--line); border-radius:999px; cursor:pointer; min-height:32px}
.ct__chips label:has(input:checked){border-color:var(--brand); background:color-mix(in srgb, var(--brand) 16%, transparent)}
.ct__chips input{accent-color:var(--brand); margin:0}
.ct__opt{border-top:1px dashed var(--line); padding-top:.5rem}
.ct__opt > summary{cursor:pointer; font-size:.78rem; color:var(--brand); list-style:none}
.ct__opt[open] > summary{margin-bottom:.5rem}
.ct__opt .ct__a + .ct__a{margin-top:.55rem}
.ct__msg{margin:0; font-size:.76rem; color:var(--muted)}
.ct__msg.is-bad{color:var(--bad)}
.ct__adv > summary{cursor:pointer; font-size:.76rem; color:var(--muted); list-style:none}
.ct__adv[open] > summary{margin-bottom:.45rem}
.ct__pubf .ct__f{display:flex; flex-direction:column; gap:.3rem; font-size:.74rem; color:var(--muted)}
.ct__f > span{display:flex; justify-content:space-between; gap:.5rem}
.ct__f em{font-style:normal; color:var(--dim); font-variant-numeric:tabular-nums}
.ct__f em.is-over{color:var(--bad)}
.ct__f input, .ct__f textarea{font:inherit; font-size:.88rem; color:var(--fg); background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding:.5rem .65rem; min-height:42px; width:100%}
.ct__f textarea{resize:vertical; line-height:1.5; min-height:8rem}
.ct__f input:focus-visible, .ct__f textarea:focus-visible{outline:none; border-color:var(--brand); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent)}
.ct__rp{display:flex; align-items:center; background:var(--panel-2); border:1px solid var(--line); border-radius:9px; padding-left:.65rem}
.ct__rp b{font-size:.84rem; color:var(--muted); font-weight:500}
.ct__rp input{border:0; background:none; font-size:1rem; font-weight:600}
.ct__rp:focus-within{border-color:var(--brand); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent)}
.ct__rp input:focus-visible{box-shadow:none}
.ct__row{display:grid; grid-template-columns:repeat(auto-fit, minmax(5.5rem, 1fr)); gap:.45rem}
.ct__pics{display:flex; flex-wrap:wrap; gap:.35rem}
.ct__pics img{width:52px; height:52px; object-fit:cover; border-radius:8px; border:1px solid var(--line); background:#fff}
.ct__up{flex-direction:row !important; align-items:center; gap:.45rem !important; font-size:.8rem !important; color:var(--brand) !important; padding:.5rem .7rem; border:1px dashed var(--line); border-radius:9px; cursor:pointer; position:relative}
.ct__up:hover{border-color:var(--brand)}
.ct__up .ico{width:16px; height:16px; flex:none}
.ct__up input{position:absolute; inset:0; opacity:0; cursor:pointer}
.ct__up.has-files{color:var(--fg) !important; border-style:solid; border-color:var(--brand)}
.ct__stock{margin:0; font-size:.76rem; color:var(--muted)}
.pe__pics{display:flex; flex-wrap:wrap; gap:.5rem; margin-bottom:.5rem}
.pe__pics figure{position:relative; margin:0}
.pe__pics img{width:84px; height:84px; object-fit:cover; border-radius:10px; border:1px solid var(--line); display:block; background:var(--panel)}
.pe__pics figcaption{position:absolute; top:6px; left:6px; font-size:.6rem; font-weight:600; padding:.1rem .35rem; border-radius:5px; background:var(--brand); color:#fff}
.pe__bar{align-items:center; flex-wrap:wrap; justify-content:flex-start}
.pe__bar .chp{flex:1}
.pe__to{font-size:.74rem; color:var(--muted); margin-right:.5rem; padding:0; float:left; line-height:40px}
.pe__count{font-size:.8rem; color:var(--muted)}
.pe__count b{color:var(--fg)}
.pf__primary:disabled{opacity:.45; cursor:not-allowed; filter:none}
@media (max-width:860px){.cts{grid-template-columns:minmax(0,1fr)}}
@media (max-width:860px){.pf__chs{grid-template-columns:minmax(0,1fr)} .pf__mode{grid-template-columns:minmax(0,1fr)}}
@media (max-width:640px){.pf__grid{grid-template-columns:minmax(0,1fr)} .pf__step{padding:1rem}}
@media (prefers-reduced-motion:reduce){.pf *{transition:none !important}}
`;

const PF_SCRIPT = `
(function () {
  // Publish form: category suggested from the product's title, then that category's
  // attributes drawn as fields. Every name and value comes from the channel and is set
  // as text, never as markup.
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function field(a, pre) {
    pre = pre || {};
    var wrap = el('div', { 'class': 'ct__a' });
    var head = el('b', { text: a.name });
    if (a.required) head.appendChild(el('i', { text: ' *' }));
    wrap.appendChild(head);
    var ids = pre.ids || [];
    if (a.values.length && a.multiple) {
      var chips = el('div', { 'class': 'ct__chips' });
      a.values.forEach(function (v) {
        var box = el('input', { type: 'checkbox', name: 'attr:' + a.id, value: v.id });
        if (ids.indexOf(v.id) >= 0) box.checked = true;
        chips.appendChild(el('label', {}, [box, el('span', { text: v.name })]));
      });
      wrap.appendChild(chips);
    } else if (a.values.length) {
      var sel = el('select', { name: 'attr:' + a.id });
      sel.appendChild(el('option', { value: '', text: a.required ? 'Pilih…' : '— tidak diisi —' }));
      a.values.forEach(function (v) { var o = el('option', { value: v.id, text: v.name }); if (ids.indexOf(v.id) >= 0) o.selected = true; sel.appendChild(o); });
      wrap.appendChild(sel);
    }
    if (!a.values.length || a.custom) {
      var text = el('input', { type: 'text', name: 'attrtext:' + a.id, maxlength: '200', placeholder: a.values.length ? 'atau ketik sendiri' : (a.numeric ? 'angka' : 'isi') });
      if (pre.text) text.value = pre.text;
      if (a.units && a.units.length) {
        var unit = el('select', { name: 'attrunit:' + a.id, 'aria-label': 'Satuan ' + a.name });
        a.units.forEach(function (u) { var o = el('option', { value: u, text: u }); if (u === pre.unit) o.selected = true; unit.appendChild(o); });
        wrap.appendChild(el('span', { 'class': 'ct__pair' }, [text, unit]));
      } else wrap.appendChild(text);
    }
    return wrap;
  }
  document.querySelectorAll('[data-cat-box]').forEach(function (box) {
    var form = box.closest('form'), channel = box.dataset.channel;
    var cat = box.querySelector('[data-cat]'), attrs = box.querySelector('[data-attrs]'), again = box.querySelector('[data-cat-again]');
    var template = box.querySelector('[data-template]'), title = form.querySelector('[name=title]');
    var base = location.pathname + '?view=products&meta=';
    var loaded = false, chosen = false;
    // Right under the title it is suggested from.
    var titleField = title && title.closest('label');
    if (titleField) titleField.after(box);
    function say(text, bad) { attrs.innerHTML = ''; attrs.appendChild(el('p', { 'class': 'ct__msg' + (bad ? ' is-bad' : ''), text: text })); }
    function loadAttrs() {
      if (!cat.value) { attrs.innerHTML = ''; return; }
      say('Memuat atribut kategori…');
      fetch(base + 'attributes&channel=' + channel + '&category=' + encodeURIComponent(cat.value) + '&template=' + encodeURIComponent(template ? template.value : ''), { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) return say('Atribut tidak terbaca: ' + d.error, true);
          attrs.innerHTML = '';
          var need = d.attributes.filter(function (a) { return a.required; });
          var rest = d.attributes.filter(function (a) { return !a.required; });
          if (need.length) { attrs.appendChild(el('p', { 'class': 'ct__ah', text: 'Atribut wajib' })); need.forEach(function (a) { attrs.appendChild(field(a, d.prefill[a.id])); }); }
          if (rest.length) {
            var filled = rest.filter(function (a) { return d.prefill[a.id]; }).length;
            var more = el('details', { 'class': 'ct__opt' }, [el('summary', { text: 'Atribut lainnya (opsional) · ' + rest.length + (filled ? ', ' + filled + ' sudah terisi' : '') })]);
            rest.forEach(function (a) { more.appendChild(field(a, d.prefill[a.id])); });
            attrs.appendChild(more);
          }
          if (!need.length && !rest.length) say('Kategori ini tidak meminta atribut.');
        })
        .catch(function () { say('Atribut tidak terbaca, coba pilih kategori lagi.', true); });
    }
    function loadCats() {
      again.classList.add('is-busy');
      cat.innerHTML = ''; cat.appendChild(el('option', { value: '', text: 'Memuat saran kategori…' }));
      fetch(base + 'categories&channel=' + channel + '&title=' + encodeURIComponent(title ? title.value : ''), { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          cat.innerHTML = '';
          if (d.error || !d.categories.length) {
            cat.appendChild(el('option', { value: '', text: d.error ? 'Saran tidak terbaca' : 'Tidak ada saran untuk judul ini' }));
            return say(d.error ? 'Saran kategori tidak terbaca: ' + d.error : 'Ubah judul agar lebih jelas, lalu tekan tombol cari lagi.', true);
          }
          d.categories.forEach(function (c, i) { cat.appendChild(el('option', { value: c.id, text: (i === 0 ? '★ ' : '') + c.path })); });
          loadAttrs();
        })
        .catch(function () { say('Saran kategori tidak terbaca, tekan tombol cari lagi.', true); })
        .then(function () { again.classList.remove('is-busy'); });
    }
    cat.addEventListener('change', function () { chosen = true; loadAttrs(); });
    // A new title asks again, unless a category was already picked by hand.
    if (title) title.addEventListener('change', function () { if (loaded && !chosen) loadCats(); });
    if (template) template.addEventListener('change', loadAttrs);
    again.addEventListener('click', loadCats);
    // Asked only when the form is opened: a product page is read far more than published from.
    var pub = box.closest('details');
    function open() { if (!loaded && (!pub || pub.open)) { loaded = true; loadCats(); } }
    if (pub) pub.addEventListener('toggle', open);
    open();
  });
})();

(function () {
  // Publish form: a live count on the title, rupiah grouping on the price, and the
  // picked photo files named on their button.
  document.querySelectorAll('.ct__pubf [data-count]').forEach(function (input) {
    var out = document.querySelector('[data-count-for="' + input.id + '"]');
    var sync = function () { if (!out) return; out.textContent = input.value.length + '/' + input.maxLength; out.classList.toggle('is-over', input.value.length < 3); };
    input.addEventListener('input', sync); sync();
  });
  document.querySelectorAll('.ct__pubf [data-rupiah]').forEach(function (input) {
    input.addEventListener('input', function () {
      var digits = input.value.replace(/[^0-9]/g, '').replace(/^0+/, '');
      input.value = digits ? Number(digits).toLocaleString('id-ID') : '';
    });
  });
  document.querySelectorAll('.ct__up input[type=file]').forEach(function (input) {
    input.addEventListener('change', function () {
      var label = input.closest('.ct__up'), text = label.querySelector('span');
      var n = input.files.length;
      label.classList.toggle('has-files', n > 0);
      text.textContent = n ? n + ' foto dipilih - menggantikan foto di atas' : 'Ganti dengan foto lain (JPG/PNG, maks. 9)';
    });
  });
})();

(function () {
  // Bundle rows: add from the template, remove in place.
  document.querySelectorAll('.pf').forEach(function (form) {
    var parts = form.querySelector('[data-parts]');
    var tpl = form.querySelector('[data-part-template]');
    var add = form.querySelector('[data-part-add]');
    if (add && parts && tpl) add.addEventListener('click', function () {
      parts.appendChild(tpl.content.cloneNode(true));
      var rows = parts.querySelectorAll('[data-part]');
      var last = rows[rows.length - 1];
      last.querySelectorAll('[id]').forEach(function (el) { el.id = el.id + '-' + rows.length; });
      last.querySelectorAll('label[for]').forEach(function (el) { el.htmlFor = el.htmlFor + '-' + rows.length; });
      last.querySelector('select').focus();
    });
    if (parts) parts.addEventListener('click', function (e) {
      var x = e.target.closest('[data-part-remove]');
      if (x) x.closest('[data-part]').remove();
    });
  });

  // Pictures preview in the order they will be sent; the first is the main one. Every
  // picture field on the page, the new-product form's and the listing editor's alike.
  document.querySelectorAll('[data-images]').forEach(function (input) {
    var field = input.closest('.pf__f, .le__f');
    var thumbs = field && field.querySelector('[data-thumbs]');
    var zone = input.closest('[data-drop]');
    if (!thumbs) return;
    input.addEventListener('change', function () {
      thumbs.innerHTML = '';
      Array.prototype.slice.call(input.files, 0, 9).forEach(function (file) {
        var fig = document.createElement('figure');
        var img = document.createElement('img');
        img.alt = '';
        img.src = URL.createObjectURL(file);
        var cap = document.createElement('figcaption');
        cap.textContent = file.name;
        fig.appendChild(img); fig.appendChild(cap); thumbs.appendChild(fig);
      });
    });
    if (zone) {
      ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function () { zone.classList.add('is-over'); }); });
      ['dragleave', 'drop'].forEach(function (t) { zone.addEventListener(t, function () { zone.classList.remove('is-over'); }); });
    }
  });

  // The product editor: count what changed, and keep Save off until something did.
  var pe = document.querySelector('[data-pe]');
  if (pe) {
    var go = pe.querySelector('[data-pe-go]');
    var counter = pe.querySelector('[data-pe-count]');
    var watched = Array.prototype.filter.call(pe.elements, function (el) {
      return el.name && el.type !== 'hidden' && el.type !== 'submit' && el.name !== 'channel';
    });
    var initial = new Map(watched.map(function (el) { return [el, el.type === 'checkbox' ? el.checked : el.type === 'file' ? '' : el.value]; }));
    var recount = function () {
      var n = 0;
      // Fields and bundle rows can be added and removed; a different set is a change too.
      var now = Array.prototype.filter.call(pe.elements, function (el) { return el.name && el.type !== 'hidden' && el.type !== 'submit' && el.name !== 'channel'; });
      now.forEach(function (el) {
        var v = el.type === 'checkbox' ? el.checked : el.type === 'file' ? (el.files.length ? 'x' : '') : el.value;
        if (!initial.has(el) || initial.get(el) !== v) n += 1;
      });
      initial.forEach(function (_, el) { if (!el.isConnected) n += 1; });
      counter.innerHTML = n ? '<b>' + n + '</b> perubahan' : 'Belum ada perubahan';
      go.disabled = n === 0;
    };
    pe.addEventListener('input', recount);
    pe.addEventListener('change', recount);
    pe.addEventListener('click', function () { setTimeout(recount, 0); });
    recount();
  }

  var form = document.querySelector('[data-pf]');
  if (!form) return;
  var err = form.querySelector('[data-pf-err]');
  var images = form.querySelector('[data-images]');
  var title = form.querySelector('[name="title"]');
  var count = form.querySelector('[data-count="title"]');

  // The example listing follows the product's kind: a new capsule copies a capsule.
  var category = form.querySelector('[data-category]');
  function pickTemplates() {
    form.querySelectorAll('[data-template]:not([data-fixed])').forEach(function (sel) {
      var match = Array.prototype.find.call(sel.options, function (o) { return o.dataset.category === category.value; });
      if (match) sel.value = match.value;
    });
  }
  category.addEventListener('change', pickTemplates);
  pickTemplates();

  title.addEventListener('input', function () { count.textContent = title.value.length + ' / 255'; });

  images.addEventListener('change', function () { check(images); });

  function channels() { return Array.prototype.map.call(form.querySelectorAll('[data-ch-toggle]:checked'), function (c) { return c.value; }); }

  // One message per field, said next to it, checked when the field is left.
  function say(field, text) {
    var holder = field.closest('.pf__f') || field.parentNode;
    var msg = holder.querySelector('.pf__msg');
    field.classList.toggle('is-bad', Boolean(text));
    field.setAttribute('aria-invalid', text ? 'true' : 'false');
    if (!text) { if (msg) msg.remove(); return true; }
    if (!msg) { msg = document.createElement('span'); msg.className = 'pf__msg'; holder.appendChild(msg); }
    msg.textContent = text;
    return false;
  }
  function check(field) {
    var listingNeeded = channels().length > 0;
    var v = (field.value || '').trim();
    if (field.name === 'sku') return say(field, /^[A-Za-z0-9][A-Za-z0-9+&._-]{1,49}$/.test(v) ? '' : 'SKU 2-50 karakter: huruf, angka, - _ . + &');
    if (field.name === 'name') return say(field, v ? '' : 'Nama produk wajib diisi');
    if (!listingNeeded) return say(field, '');
    if (field.name === 'title') return say(field, v.length >= 5 ? '' : 'Judul minimal 5 karakter');
    if (field.name === 'description') return say(field, v.length >= 20 ? '' : 'Deskripsi minimal 20 karakter');
    if (field.name === 'price') return say(field, Number(v) >= 100 ? '' : 'Harga minimal Rp100');
    if (field.name === 'stock') return say(field, Number(v) >= 1 && Number(v) <= 99999 ? '' : 'Stok awal 1-99.999');
    if (field.name === 'weightGram') return say(field, Number(v) >= 1 ? '' : 'Berat wajib diisi');
    if (field.hasAttribute('data-dim')) {
      var marketplace = channels().some(function (c) { return c !== 'shopify'; });
      return say(field, !marketplace || Number(v) >= 1 ? '' : 'Wajib');
    }
    if (field === images) {
      var reuse = form.querySelector('[data-reuse]');
      if (reuse && reuse.checked && images.files.length === 0) return say(images, '');
      return say(images, images.files.length >= 1 && images.files.length <= 9 ? '' : 'Pilih 1-9 foto');
    }
    return true;
  }
  form.querySelectorAll('input, textarea').forEach(function (f) { f.addEventListener('blur', function () { if (f.value) check(f); }); });

  form.addEventListener('submit', function (e) {
    var fields = form.querySelectorAll('[name="sku"], [name="name"], [data-listing], [data-dim]');
    var bad = Array.prototype.filter.call(fields, function (f) { return !check(f); });
    if (channels().length > 0 && !check(images)) bad.push(images);
    if (bad.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      err.hidden = false;
      err.textContent = bad.length + ' kolom perlu diperbaiki sebelum produk dibuat.';
      bad[0].focus();
      return;
    }
    err.hidden = true;
  }, true);
})();
`;

function productDetail({ product, live, ledger, stockOf, csrf, plan, picture = null, images = {}, listing = null, templates = {}, shopifyAdmin = null }) {
  // Shopify is read here, never changed: the team edits, adds and removes it in Shopify.
  const MANAGED = ['tiktok', 'shopee'];
  const entry = live.get(product.sku);
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const back = `<input type="hidden" name="back" value="?view=products&amp;sku=${encodeURIComponent(product.sku)}">`;
  const ledgerRow = ledger?.skus?.[product.sku];
  const LABELS = { tiktok: 'Tokopedia + TikTok', shopee: 'Shopee', shopify: 'Shopify' };
  const switchedOff = (key) => (entry?.[`${key}_ignored`] ?? entry?.[key]?.ignored ?? []).filter((r) => r.status !== 'DELETED');
  const state = (key) => (entry?.[key]?.rows?.length ? 'live' : switchedOff(key).length ? 'off' : 'none');

  /*
   * Where the product stands on each channel, at a glance and with the one action that
   * makes sense there: switch a live listing off, switch an inactive one back on, or put
   * the product on a channel that does not sell it yet.
   */
  const channelTile = (key) => {
    const st = state(key);
    const row = entry?.[key]?.rows?.[0];
    const label = LABELS[key];
    const ask = (action, active, text, cls = '') => `<form method="post" data-confirm="${escape(text)}">
        ${hidden}${back}
        <input type="hidden" name="action" value="${action}"><input type="hidden" name="sku" value="${escape(product.sku)}">
        <input type="hidden" name="channel" value="${key}"><input type="hidden" name="active" value="${active ? '1' : '0'}">
        <button class="ct__btn ${cls}" type="submit">${svg(active ? 'check2' : 'ban')}<span>${active ? 'Aktifkan' : 'Nonaktifkan'}</span></button>
      </form>`;
    const list = templates[key] ?? [];
    const publish = key === 'shopify' || list.length
      ? `<details class="ct__pub"><summary class="ct__btn ct__btn--go">${svg('plus')}<span>Publikasikan</span></summary>
          <form method="post" class="ct__pubf" enctype="multipart/form-data" data-confirm="Publikasikan ${escape(product.sku)} ke ${escape(label)} dengan judul, harga dan isi di form ini?">
            ${hidden}${back}
            <input type="hidden" name="action" value="product_publish"><input type="hidden" name="sku" value="${escape(product.sku)}">
            <input type="hidden" name="channel" value="${key}">
            ${key === 'shopify' ? '' : (() => {
              // The category comes from the product: the channel's own recommendation for
              // this title, with that category's attributes drawn below by the script. The
              // example listing only lends logistics, the warehouse and certificates now,
              // and a free-gift listing is never the one chosen for that.
              const gift = (l) => /free gift|do not order|hadiah/i.test(String(l.title));
              const usable = list.filter((l) => !gift(l)).length ? list.filter((l) => !gift(l)) : list;
              const pick = usable.find((l) => l.category === product.category) ?? usable[0];
              return `<div class="ct__cat" data-cat-box data-channel="${key}">
                <label class="ct__f"><span>Kategori <em>disarankan ${escape(label)} dari judul di atas</em></span>
                  <span class="ct__catrow"><select name="category" data-cat required aria-label="Kategori ${escape(label)}"><option value="">Memuat saran kategori…</option></select>
                  <button type="button" class="ct__again" data-cat-again title="Cari saran lagi dari judul sekarang" aria-label="Cari saran kategori lagi">${svg('refresh')}</button></span></label>
                <div class="ct__attrs" data-attrs aria-live="polite"></div>
                <details class="ct__adv"><summary>Pengaturan lanjutan</summary>
                  <label class="ct__f"><span>Logistik, gudang &amp; sertifikat disalin dari</span><select name="template" data-template>${usable.map((l) => `<option value="${escape(String(l.id))}" ${l === pick ? 'selected' : ''}>${escape(String(l.title).slice(0, 70))}</option>`).join('')}</select></label>
                </details>
              </div>`;
            })()}
            ${(() => {
              // Everything the new listing will say, filled in from the live one and open
              // to change before it goes: title, description, price, weight, box, photos.
              // Stock is not here - every channel shows the master stock.
              const L0 = listing?.data ?? {};
              const srcRow = ['tiktok', 'shopee', 'shopify'].map((k) => entry?.[k]?.rows?.[0]).find((r) => r?.price);
              const titleMax = 255;
              const field = (name, ph, val, label) => `<label class="ct__f ct__f--s"><span>${label}</span><input name="${name}" type="number" min="1" step="1" inputmode="numeric" required placeholder="${ph}" value="${escape(val ?? '')}" class="mono"></label>`;
              return `<div class="ct__fields">
                <label class="ct__f"><span>Judul <em data-count-for="t-${key}">${String(L0.title ?? '').length}/${titleMax}</em></span>
                  <input id="t-${key}" name="title" required minlength="3" maxlength="${titleMax}" value="${escape(String(L0.title ?? '').slice(0, titleMax))}" data-count></label>
                <label class="ct__f"><span>Deskripsi</span>
                  <textarea name="description" rows="6" required minlength="20" maxlength="10000">${escape(L0.description ?? '')}</textarea></label>
                <label class="ct__f"><span>Harga</span>
                  <span class="ct__rp"><b>Rp</b><input name="price" type="text" inputmode="numeric" required pattern="[0-9.]{3,12}" value="${escape(srcRow?.price ? Number(srcRow.price).toLocaleString('id-ID') : '')}" class="mono" data-rupiah></span></label>
                <div class="ct__row">
                  ${field('weightGram', 'gram', L0.weightGram, 'Berat (g)')}
                  ${key === 'shopify' ? '' : ['dimL:P:l', 'dimW:L:w', 'dimH:T:h'].map((d) => { const [n, ph, k] = d.split(':'); return field(n, `${ph} cm`, L0.dims?.[k], `${ph === 'P' ? 'Panjang' : ph === 'L' ? 'Lebar' : 'Tinggi'} (cm)`); }).join('')}
                </div>
                <div class="ct__f"><span>Foto</span>
                  ${(L0.images ?? []).length ? `<div class="ct__pics">${(L0.images ?? []).slice(0, 9).map((u) => `<img src="${escape(u)}" alt="" loading="lazy" width="52" height="52">`).join('')}</div>` : ''}
                  <label class="ct__up">${svg('image')}<span>Ganti dengan foto lain (JPG/PNG, maks. 9)</span><input type="file" name="images" accept="image/jpeg,image/png" multiple></label>
                  <small>Tanpa memilih file, foto di atas yang dipakai.</small>
                </div>
                <p class="ct__stock">Stok mengikuti stok induk: <b class="mono">${escape(String(ledgerRow?.qty ?? row?.qty ?? '-'))}</b></p>
              </div>`;
            })()}
            <label class="ct__mode"><input type="checkbox" name="mode" value="draft"><span>Simpan sebagai draft dulu</span></label>
            <button class="pf__primary" type="submit">Publikasikan</button>
            <small>Isian di atas diambil dari listing yang sedang tayang - ubah seperlunya sebelum dipublikasikan.</small>
          </form></details>`
      : '<span class="ct__note">Belum ada listing contoh di kanal ini.</span>';
    return `<div class="ct ct--${st}">
      <div class="ct__top"><span class="ct__dot" aria-hidden="true"></span><b>${label}</b>
        <span class="ct__st">${st === 'live' ? 'Tayang' : st === 'off' ? 'Nonaktif' : 'Belum ada'}</span></div>
      ${row ? `<dl class="ct__kv"><div><dt>Stok</dt><dd class="mono">${row.qty}</dd></div><div><dt>Harga</dt><dd class="mono">${escape(rupiah(row.price ?? 0))}</dd></div></dl>
        <p class="ct__title" title="${escape(row.title ?? '')}">${escape(row.title ?? '')}</p>` : ''}
      <div class="ct__acts">${key === 'shopify'
        ? (() => {
          const gid = row?.productId ?? switchedOff('shopify')[0]?.productId ?? '';
          const id = String(gid).split('/').pop();
          return id && shopifyAdmin
            ? `<a class="ct__btn" href="${escape(shopifyAdmin + id)}" target="_blank" rel="noopener">${svg('ext')}<span>Kelola di Shopify</span></a>`
            : '<span class="ct__note">Dikelola langsung di Shopify.</span>';
        })()
        : st === 'live'
          ? ask('listing_active', false, `Nonaktifkan ${product.sku} di ${label}? Listing disembunyikan dari pembeli dan bisa diaktifkan lagi.`)
          : st === 'off' ? ask('listing_active', true, `Aktifkan lagi ${product.sku} di ${label}?`, 'ct__btn--go') : publish}</div>
    </div>`;
  };

  const bundle = isBundle(product) ? buildableFrom(product, stockOf) : null;
  // What the bundle is made of, beside its picture. Display figures only, nothing judged.
  const composition = bundle
    ? `<section class="bx" aria-labelledby="bx-h">
        <header class="bx__head"><h2 class="bx__h" id="bx-h">Isi bundle</h2><span class="bx__make">${bundle.parts.length} produk</span></header>
        <ul class="bx__list">${bundle.parts.map((part) => {
          const component = findProduct(part.sku);
          const pic = images[part.sku];
          return `<li><a class="bx__row" href="?view=products&sku=${encodeURIComponent(part.sku)}">
            ${pic?.thumb ? `<img class="bx__pic" src="${escape(pic.thumb)}" alt="" width="44" height="44" loading="lazy" decoding="async">` : '<span class="bx__pic bx__pic--none" aria-hidden="true"></span>'}
            <span class="bx__id"><span class="bx__name">${escape(component?.name ?? part.sku)}${component?.variant ? ` <span class="bx__var">${escape(component.variant)}</span>` : ''}</span>
              <span class="bx__sku mono">${escape(part.sku)}</span></span>
            <span class="bx__qty mono" aria-label="${part.qty} per bundle">&times;${part.qty}</span>
            <span class="bx__stock"><b class="mono">${part.available ?? '&mdash;'}</b><span>stok</span></span>
          </a></li>`;
        }).join('')}</ul>
      </section>`
    : '';

  const L = listing?.data ?? null;
  const liveOn = MANAGED.filter((k) => state(k) === 'live');
  const price = entry?.tiktok?.price ?? entry?.shopee?.price ?? '';
  const before = {
    qty: ledgerRow?.qty ?? null,
    price: price === '' ? null : price,
    listing: L ? { title: L.title, description: L.description, weightGram: L.weightGram, dims: L.dims } : {},
  };
  const field = (label, html, { wide = false, hint = '' } = {}) => `<label class="pf__f${wide ? ' pf__f--wide' : ''}"><span>${label}</span>${html}${hint ? `<small>${hint}</small>` : ''}</label>`;

  /*
   * One form for the whole product, one save. Each part goes only where it belongs and
   * only when it changed: the master facts to the catalogue, the stock to the master and
   * from there to every channel, the price and listing content to the channels ticked.
   */
  const editor = `<form class="pf pe" method="post" enctype="multipart/form-data" data-pe
      data-confirm="Simpan perubahan ${escape(product.sku)} dan sinkronkan ke kanal terpilih?">
    ${hidden}${back}
    <input type="hidden" name="action" value="product_save">
    <input type="hidden" name="before" value="${escape(JSON.stringify(before))}">

    <section class="pf__step"><header><span class="pf__n" aria-hidden="true">1</span><h2>Informasi produk</h2>
      <p>Cara dashboard mengenal produk ini. Hanya tersimpan di dashboard, tidak dikirim ke kanal.</p></header>
      ${masterFields(product, { idPrefix: 'pe' })}</section>

    ${liveOn.length ? `<section class="pf__step"><header><span class="pf__n" aria-hidden="true">2</span><h2>Konten listing</h2>
      <p>${L ? `Diisi dari ${escape(LABELS[listing.source])}.` : listing?.error ? `Isi listing tidak terbaca (${escape(listing.error)}).` : ''} Yang diubah dikirim ke kanal yang dicentang di bawah.${L?.variants > 1 ? ` Berlaku untuk seluruh listing (${L.variants} varian).` : ''}</p></header>
      <div class="pf__grid">
        ${field('Judul listing', `<input name="title" maxlength="255" value="${escape(L?.title ?? '')}" autocomplete="off">`, { wide: true })}
        ${field('Deskripsi', `<textarea name="description" rows="9">${escape(L?.description ?? '')}</textarea>`, { wide: true })}
        <div class="pf__f pf__f--wide"><span>Foto</span>
          ${L?.images?.length ? `<div class="pe__pics">${L.images.slice(0, 9).map((u, i) => `<figure><img src="${escape(u)}" alt="" width="84" height="84" loading="lazy">${i === 0 ? '<figcaption>Utama</figcaption>' : ''}</figure>`).join('')}</div>` : ''}
          <label class="pf__drop pf__drop--s" data-drop><input name="images" type="file" accept="image/jpeg,image/png" multiple data-images>
            ${svg('image')}<b>Ganti foto</b><small>Foto baru mengganti semua foto di kanal terpilih. 1-9 JPG/PNG, 10 MB per foto.</small></label>
          <div class="pf__thumbs" data-thumbs aria-live="polite"></div></div>
      </div></section>` : ''}

    <section class="pf__step"><header><span class="pf__n" aria-hidden="true">${liveOn.length ? 3 : 2}</span><h2>Harga, stok &amp; pengiriman</h2>
      <p>Stok induk diikuti semua kanal otomatis, Shopify termasuk. Harga dikirim ke kanal yang dicentang; harga Shopify diubah di Shopify.</p></header>
      <div class="pf__grid">
        ${liveOn.length ? field('Harga (Rp)', `<input name="price" type="number" min="100" step="1" inputmode="numeric" class="mono" value="${escape(String(price))}">`) : ''}
        ${field('Stok induk', `<input name="qty" type="number" min="0" step="1" inputmode="numeric" class="mono" value="${ledgerRow?.qty ?? ''}" placeholder="&mdash;">`, { hint: 'Di bawah 100, otomatis ditambah 100.' })}
        ${liveOn.length ? field('Berat paket (gram)', `<input name="weightGram" type="number" min="1" step="1" inputmode="numeric" class="mono" value="${L?.weightGram ?? ''}">`) : ''}
        ${liveOn.length ? `<div class="pf__f"><span>Dimensi paket (cm)</span><div class="pf__dims">
            <input name="dimL" type="number" min="1" step="1" inputmode="numeric" aria-label="Panjang (cm)" placeholder="P" class="mono" value="${L?.dims?.l ?? ''}">
            <input name="dimW" type="number" min="1" step="1" inputmode="numeric" aria-label="Lebar (cm)" placeholder="L" class="mono" value="${L?.dims?.w ?? ''}">
            <input name="dimH" type="number" min="1" step="1" inputmode="numeric" aria-label="Tinggi (cm)" placeholder="T" class="mono" value="${L?.dims?.h ?? ''}">
          </div><small>Dikirim ke Tokopedia/TikTok dan Shopee. Shopify diubah langsung di Shopify.</small></div>` : ''}
      </div></section>

    <div class="pf__bar pe__bar">
      ${liveOn.length ? `<fieldset class="chp"><legend class="pe__to">Kirim ke</legend>${liveOn.map((k) => `<label class="chp__opt"><input type="checkbox" name="channel" value="${k}" checked><span>${LABELS[k]}</span></label>`).join('')}</fieldset>` : '<span class="pe__to">Belum tayang di kanal mana pun</span>'}
      <span class="pe__count" data-pe-count aria-live="polite"></span>
      <button class="pf__primary" type="submit" data-pe-go>Simpan &amp; sinkronkan</button>
    </div>
  </form>`;

  return `
    <div class="pe__head">
      <a class="pf-back" href="?view=products">${svg('chevL')}<span>Produk</span></a>
      <span class="pe__grow"></span>
      <a class="pf__ghost" href="?view=products&amp;new=1&amp;from=${encodeURIComponent(product.sku)}">${svg('plus')}<span>Duplikat</span></a>
      <form method="post" data-confirm="Hapus ${escape(product.sku)} dari daftar produk? Listing di marketplace tidak disentuh, pesanan lama tetap terbaca, dan produk bisa dikembalikan.">
        ${hidden}<input type="hidden" name="action" value="product_remove"><input type="hidden" name="sku" value="${escape(product.sku)}"><input type="hidden" name="removed" value="1">
        <button class="pf__ghost" type="submit">${svg('trash')}<span>Hapus dari daftar</span></button></form>
    </div>
    <div class="pd__hero${composition ? ' pd__hero--bx' : ''}">
      ${picture?.url ? `<img class="pd__img" src="${escape(picture.thumb || picture.url)}" alt="${escape(picture.alt || product.name)}" width="200" height="200">` : '<span class="pd__img pd__img--none" aria-hidden="true"></span>'}
      <div class="pd__cap">
        <b class="pe__name">${escape(product.name)}</b>${product.variant ? `<span class="note">${escape(product.variant)}</span>` : ''}
        <span class="mono dim">${escape(product.sku)}</span>
        <span class="pe__chips">${['tiktok', 'shopee', 'shopify'].map((k) => `<span class="pe__chip pe__chip--${state(k)}"><i aria-hidden="true"></i>${LABELS[k]}</span>`).join('')}</span>
      </div>
      ${composition}
    </div>
    <div class="cts">${['tiktok', 'shopee', 'shopify'].map(channelTile).join('')}</div>
    ${editor}`;
}

/**
 * Shown when a print run was not complete.
 *
 * The PDF alone cannot say which parcels are missing from it, and a count in an HTTP
 * header is invisible to the person at the printer. This page names every order that did
 * not print and why, and still hands over the labels that did.
 */
/**
 * What came out of a print run, one stack per channel.
 *
 * The stacks are handed over separately - Shopee's waybills go to the Shopee pickup and
 * J&T's do not - so each gets its own print job rather than one interleaved PDF the bench
 * has to sort. Each opens in its own tab with the print dialog already up.
 *
 * Opening those tabs is attempted on load and will sometimes be refused: a browser only
 * lets a page open windows off a real click, and arriving here was a form submission. So
 * the buttons are always present and always work, and the page says plainly when the
 * browser stopped it rather than leaving somebody waiting for tabs that are not coming.
 */
export function renderLabelReport({
  pageCount, requested, failures, size, groups = [], csrf = null, retried = false,
}) {
  /*
   * A failure is sorted by what the bench should do about it, not by what went wrong.
   *
   * These three used to share one table and one tone: a platform having a bad second, a
   * document the courier has not issued yet, and an order that is never going to print.
   * They read identically, so all three cost the operator the same thing - going back to
   * the list, finding the orders again, ticking them again, for seventeen orders that had
   * nothing wrong with them.
   */
  const ACTIONS = {
    retry: {
      title: 'Gangguan sesaat di platform',
      hint: 'Sudah ditunggu dan dicoba ulang otomatis, tapi masih menolak. Hampir selalu berhasil kalau dicoba sekali lagi.',
    },
    wait: {
      title: 'Dokumen belum terbit di kurir',
      hint: 'Tidak ada yang salah - kurir belum menerbitkan resinya. Coba lagi beberapa menit lagi.',
    },
    check: {
      title: 'Perlu diperiksa dulu',
      hint: 'Mencetak ulang tidak akan menolong; pesanannya sendiri yang harus dilihat.',
    },
  };
  const kindOf = (f) => (ACTIONS[f.kind] ? f.kind : 'check');

  const byKind = new Map();
  for (const failure of failures) {
    const kind = kindOf(failure);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(failure);
  }

  // Asking again is free for these two and pointless for the third, so only they are put
  // on the button. A retry that is certain to fail wastes the one thing the bench has
  // least of, which is the minutes before the courier arrives.
  const retryable = failures.filter((f) => kindOf(f) !== 'check');

  const rowsFor = (list) => list
    .map((f) => `<tr>
      <td class="mono nowrap">${escape(f.id)}</td>
      <td class="dim">${escape(f.channel)}</td>
      <td>${escape(f.reason)}</td>
      <td class="nowrap">${kindOf(f) === 'check'
        ? `<a class="tiny" href="/api/dashboard?view=orders&amp;q=${encodeURIComponent(f.id)}" target="_blank" rel="noopener">Lihat pesanan</a>`
        : ''}</td>
    </tr>`)
    .join('');

  const sections = ['retry', 'wait', 'check']
    .filter((kind) => byKind.has(kind))
    .map((kind) => `<div class="fgroup">
      <p class="fgroup__h">${escape(ACTIONS[kind].title)} <span class="dim">&middot; ${byKind.get(kind).length}</span></p>
      <p class="fgroup__n">${escape(ACTIONS[kind].hint)}</p>
      <table>
        <colgroup><col class="c1"><col class="c2"><col><col class="c4"></colgroup>
        <thead><tr><th>Order ID</th><th>Kanal</th><th>Keterangan</th><th></th></tr></thead>
        <tbody>${rowsFor(byKind.get(kind))}</tbody>
      </table>
    </div>`)
    .join('');

  /*
   * The whole point of the panel: one button that reprints exactly what did not print.
   *
   * Without it the only route back is the label list, where seventeen orders have to be
   * found and ticked again by hand - and a parcel missed in that count is a parcel that
   * does not ship. The selection is already known here, so it travels as hidden fields
   * and the operator presses one thing.
   */
  const retryForm = csrf && retryable.length > 0
    ? `<form class="bar bar--in" method="post" action="/api/labels" id="retryform">
        <input type="hidden" name="csrf" value="${escape(csrf)}">
        <input type="hidden" name="size" value="${escape(size)}">
        <input type="hidden" name="retried" value="1">
        ${retryable.map((f) => `<input type="hidden" name="order" value="${escape(`${f.channel}:${f.id}`)}">`).join('')}
        <button class="btn" type="submit" id="retrygo">Coba cetak lagi ${retryable.length} pesanan</button>
        <span class="dim" id="countdown" aria-live="polite" hidden></span>
      </form>`
    : '';

  /*
   * Retried by itself only when there is nothing on this page to lose.
   *
   * Navigating away takes the printed stacks with it - they live in this page's memory
   * and nowhere else - so a run that produced labels waits for a person. A run that
   * produced none has nothing to protect and every reason to try again by itself, which
   * is exactly the case the operator hit: seventeen selected, seventeen failed, nothing
   * to print. Once only, and visibly, with a way to stop it.
   */
  const autoRetry = Boolean(retryForm) && !retried && groups.length === 0
    && retryable.length === failures.length && retryable.every((f) => kindOf(f) === 'retry');

  return `<!doctype html><html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Hasil cetak label</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Fira+Code:wght@400&display=swap">
<style>
/* Same Treelogy tokens as everywhere else - the print result is part of the product,
   not a stray page that kept the old palette. */
:root{--bg:#141A17;--panel:#1B2320;--panel-2:#222B27;--line:#2E3A34;--fg:#F1F3EE;
  --muted:#A7B3A6;--dim:#839187;--brand:#8FA97F;--fill-a:#5E7352;--fill-b:#3C4C36;
  --good:#6FBF8B;--warn:#E2B252;--ease-out:cubic-bezier(.25,1,.5,1);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#F4F5F0;--panel:#FFF;--panel-2:#F8F8F2;--line:#E1E4DA;
  --fg:#1E2A24;--muted:#57655A;--dim:#67776C;--brand:#526547;--fill-a:#526547;--fill-b:#3C4C36;
  --good:#2F7D4F;--warn:#8A5A12;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;padding:1.5rem;background:var(--bg);color:var(--fg);
  font:400 15px/1.6 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:60rem;margin:0 auto}
h1{font-size:1.2rem;margin:0 0 .3rem;font-weight:600}
p.lead{margin:0 0 1.25rem;color:var(--muted);font-size:.9rem}
.bar{display:flex;gap:.75rem;flex-wrap:wrap;align-items:center;margin-bottom:1.25rem}
.btn{font:inherit;font-size:.9rem;font-weight:600;padding:.6rem 1.2rem;min-height:42px;border-radius:10px;
  cursor:pointer;color:#fff;border:1px solid transparent;text-decoration:none;display:inline-flex;align-items:center;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b));transition:filter var(--t-base) var(--ease-out)}
.btn:hover{filter:brightness(1.12)}
.btn--ghost{background:var(--panel-2);color:var(--fg);border-color:var(--line)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:1.25rem}
.head{padding:.85rem 1rem;border-bottom:1px solid var(--line);font-size:.8rem;letter-spacing:.06em;
  text-transform:uppercase;color:var(--muted);background:var(--panel-2)}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th{text-align:left;font-weight:500;font-size:.74rem;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);padding:.65rem 1rem}
td{padding:.65rem 1rem;border-top:1px solid var(--line);vertical-align:top}
.mono{font-family:"Fira Code",ui-monospace,monospace;font-size:.86em}
.dim{color:var(--dim)}
.count{font-family:"Fira Code",monospace;font-size:1.9rem;font-weight:600;letter-spacing:-.02em}
.ok{color:var(--good)}.warn{color:var(--warn)}
iframe{width:100%;height:38vh;min-height:19rem;border:0;background:#fff;display:block}
.bar--in{margin:0;padding:.85rem 1rem;border-bottom:1px solid var(--line)}
.note{margin:0 0 1.25rem;padding:.8rem 1rem;border-radius:10px;font-size:.86rem;
  color:var(--warn);background:var(--panel);border:1px solid var(--line)}
/* One column layout across all three, or the same order id sits in a different place in
   each section and the eye has to re-find it every time. */
.fgroup table{table-layout:fixed}
.fgroup col.c1{width:13rem}.fgroup col.c2{width:7.5rem}.fgroup col.c4{width:8.5rem}
.fgroup{border-top:1px solid var(--line)}
.fgroup:first-of-type{border-top:0}
.fgroup__h{margin:0;padding:.9rem 1rem .1rem;font-size:.92rem;font-weight:600}
.fgroup__n{margin:0;padding:0 1rem .55rem;font-size:.82rem;color:var(--muted);max-width:52rem}
.tiny{font-size:.8rem;color:var(--brand);text-decoration:none;white-space:nowrap}
.tiny:hover{text-decoration:underline}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>
<div class="wrap">
  <h1>Hasil cetak label</h1>
  <p class="lead">
    <span class="count ${pageCount > 0 ? 'ok' : 'warn'}">${pageCount}</span> dari <span class="count">${requested}</span> label berhasil dibuat
    &middot; ukuran ${escape(size)}
  </p>

  <div class="bar">
    ${groups.length > 0 ? `<button class="btn" id="openall" type="button">Buka ${groups.length} tab cetak</button>` : ''}
    <a class="btn btn--ghost" href="/api/dashboard?view=labels">Kembali</a>
  </div>

  ${groups.length > 0 ? `<p class="note" id="blocked" hidden>
    Tekan <b>Buka ${groups.length} tab cetak</b> di atas untuk mencetak semuanya sekaligus, atau cetak
    tumpukan satu per satu di bawah. Browser hanya mengizinkan tab dibuka otomatis kalau pop-up
    untuk situs ini diizinkan.
  </p>` : ''}

  ${failures.length > 0 ? `<div class="card">
    <p class="head"><span class="warn">${failures.length} pesanan belum tercetak</span></p>
    ${retryForm}
    ${sections}
  </div>` : ''}

  ${groups.map((group) => `<div class="card" data-group="${escape(group.key)}">
    <p class="head">${escape(group.label)} &middot; ${group.pageCount} label</p>
    <div class="bar bar--in">
      <button class="btn" type="button" data-print="${escape(group.key)}">Cetak ${group.pageCount} label</button>
      <a class="btn btn--ghost" data-dl="${escape(group.key)}" download="label-${escape(group.key)}-${escape(size)}.pdf">Unduh PDF</a>
    </div>
    <iframe data-pdf="${escape(group.key)}" title="Label ${escape(group.label)}"></iframe>
  </div>`).join('')}
</div>
<script>
(function () {
  // Every stack travels inline, so this page needs no second request, no temporary file
  // and no second trip to the couriers for documents already fetched.
  var groups = ${JSON.stringify(groups.map((g) => ({ key: g.key, label: g.label })))};
  var data = ${JSON.stringify(Object.fromEntries(groups.map((g) => [g.key, g.pdfBase64])))};
  var urls = {};

  groups.forEach(function (group) {
    var raw = atob(data[group.key]);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    urls[group.key] = url;
    document.querySelector('[data-pdf="' + group.key + '"]').src = url;
    document.querySelector('[data-dl="' + group.key + '"]').href = url;
  });

  // A tab per stack, with the print dialog already up. The fallback is the preview on
  // this page, which needs no permission from anybody.
  function openStack(key, printHere) {
    var tab = window.open(urls[key], '_blank');
    if (!tab) {
      // Only when one stack was asked for. Falling back for a whole blocked run would
      // raise a print dialog per channel at the same moment, and they queue behind each
      // other badly enough that the operator loses track of which stack they are on.
      if (printHere) {
        var frame = document.querySelector('[data-pdf="' + key + '"]');
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { /* the preview is still there */ }
      }
      return false;
    }
    // Chrome will not let a blob tab be printed from here until its viewer has loaded,
    // and there is no event for that across browsers - a short wait is the honest way.
    try { tab.addEventListener('load', function () { tab.print(); }); } catch (e) { /* cross-origin blob */ }
    window.setTimeout(function () { try { tab.print(); } catch (e) { /* the operator can press print */ } }, 900);
    return true;
  }

  function openAll() {
    var blocked = 0;
    groups.forEach(function (group) { if (!openStack(group.key, false)) blocked += 1; });
    document.getElementById('blocked').hidden = blocked === 0;
  }

  var openAllButton = document.getElementById('openall');
  if (openAllButton) openAllButton.addEventListener('click', openAll);
  document.querySelectorAll('[data-print]').forEach(function (button) {
    button.addEventListener('click', function () { openStack(button.getAttribute('data-print'), true); });
  });

  /*
   * One automatic retry, counted down in the open.
   *
   * The server has already waited the fault out and split the batch; if it still says
   * "ask again", asking again is what the operator would do anyway - and every second
   * they spend doing it by hand is a second closer to the courier standing at the door.
   * Visible and cancellable, because a page that navigates itself without warning is a
   * page nobody trusts. Only ever once: the form it submits says so, and the server
   * hands that back, so a broken platform cannot put this into a loop.
   */
  var retryForm = document.getElementById('retryform');
  if (retryForm) {
    // Two taps at a bench is one intention. The second would ask the couriers for the
    // same documents again while the first is still in flight.
    retryForm.addEventListener('submit', function () {
      var go = document.getElementById('retrygo');
      window.setTimeout(function () { go.disabled = true; go.textContent = 'Mencoba lagi\u2026'; }, 0);
    });
  }
  if (retryForm && ${autoRetry ? 'true' : 'false'}) {
    var left = 5;
    var label = document.getElementById('countdown');
    var button = document.getElementById('retrygo');
    var timer = null;
    var stop = function () {
      if (timer) window.clearInterval(timer);
      timer = null;
      label.hidden = true;
    };
    label.hidden = false;
    var tick = function () {
      label.textContent = 'mencoba lagi otomatis dalam ' + left + ' detik \u00b7 klik di mana saja untuk membatalkan';
      if (left <= 0) { stop(); button.disabled = true; retryForm.submit(); return; }
      left -= 1;
    };
    tick();
    timer = window.setInterval(tick, 1000);
    // Any deliberate act cancels it: the operator has decided to do something else.
    ['click', 'keydown', 'touchstart'].forEach(function (name) {
      document.addEventListener(name, function (event) {
        if (event.target === button) return;
        stop();
      }, { once: true, capture: true });
    });
  }

  // Tried once on arrival, because what was asked for is the labels and not a page about
  // the labels. This page is itself a new tab, and a tab cannot open tabs without a click
  // behind it, so unless pop-ups are allowed for this site the attempt is refused - in
  // which case the line above says which button does it instead of nothing happening.
  if (groups.length > 0) openAll();
})();
</script>
</body></html>`;
}

/**
 * The login screen. Deliberately says nothing about why a key was rejected - a wrong key
 * and an unknown one look identical from the outside.
 */
export function renderLogin({ failed = false, lockedFor = 0, email = '', redirectTo = '/api/dashboard' } = {}) {
  const minutes = Math.ceil(lockedFor / 60);
  return `<!doctype html><html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Masuk &mdash; Omnichannel Treelogy</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="mask-icon" href="/favicon.svg" color="#526547">
<meta name="theme-color" content="#1E2A27" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#F3F4EF" media="(prefers-color-scheme: light)">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<style>
/* Same Treelogy tokens as the dashboard - the sign-in screen is the first impression
   of the brand, so it cannot be the one page still wearing the old palette. */
:root{--bg:#121A18;--bg-2:#1E2A27;--glow:#526547;--accent:#3FB8A4;--panel:#1A2320;--panel-2:#222D29;--line:#2C3934;
  --glass:rgba(255,255,255,.06);--glass-line:rgba(255,255,255,.1);--fg:#F1F3EE;
  --muted:#A7B3A6;--dim:#839187;--brand:#8FA97F;--fill-a:#5E7352;--fill-b:#3C4C36;--cta-a:#C2531C;--cta-b:#9E4216;
  --bad:#E08573;--ease-out:cubic-bezier(.25,1,.5,1);--t-base:240ms;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#E8EBE4;--bg-2:#F3F4EF;--glow:#8FA97F;--accent:#0E7A6B;--panel:#FFF;--panel-2:#F3F5EF;--line:#DADFD3;
  --glass:rgba(255,255,255,.7);--glass-line:rgba(30,42,36,.1);
  --fg:#1B2621;--muted:#4F5D53;--dim:#66746A;--brand:#526547;--fill-a:#526547;--fill-b:#3C4C36;--cta-a:#B9491A;--cta-b:#8F3812;
  --bad:#A8412E;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;color:var(--fg);background-color:var(--bg);
  background-image:radial-gradient(70rem 34rem at 8% -12%,color-mix(in srgb,var(--glow) 30%,transparent),transparent 62%),
    radial-gradient(48rem 26rem at 104% 4%,color-mix(in srgb,var(--accent) 12%,transparent),transparent 60%),
    linear-gradient(180deg,var(--bg-2),var(--bg));
  font:400 15px/1.6 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:24rem;padding:2.25rem;background:var(--glass);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  border:1px solid var(--glass-line);border-radius:22px;
  box-shadow:0 1px 2px rgba(0,0,0,.3),0 30px 60px -30px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.06);
  animation:rise 420ms var(--ease-out) both}
.mark{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;margin:0 auto 1.1rem;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b));color:#fff}
.mark svg{width:22px;height:22px}
h1{margin:0 0 .3rem;font-size:1.35rem;font-weight:600;text-align:center;letter-spacing:-.025em}
p.lead{margin:0 0 1.5rem;font-size:.85rem;color:var(--muted);text-align:center}
label{display:block;font-size:.78rem;color:var(--muted);margin-bottom:.4rem}
input{width:100%;font:inherit;font-size:.92rem;padding:.7rem 1rem;min-height:46px;border-radius:999px;
  border:1px solid var(--glass-line);background:var(--panel-2);color:var(--fg)}
input:focus-visible{outline:2px solid var(--brand);outline-offset:1px;border-color:transparent}
button{width:100%;margin-top:1.1rem;font:inherit;font-size:.92rem;font-weight:600;padding:.7rem;min-height:46px;
  border-radius:999px;cursor:pointer;color:#fff;border:1px solid transparent;
  background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset,0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent);
  transition:filter var(--t-base) var(--ease-out)}
button:hover{filter:brightness(1.08)}
button:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
button:disabled,input:disabled{opacity:.5;cursor:not-allowed}
.gap{height:.85rem}
.err{margin:0 0 1rem;padding:.6rem .8rem;border-radius:9px;font-size:.83rem;color:var(--bad);
  border:1px solid color-mix(in srgb,var(--bad) 40%,transparent);
  background:color-mix(in srgb,var(--bad) 12%,transparent)}
.hint{margin:1.1rem 0 0;font-size:.75rem;color:var(--dim);text-align:center}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>
<main class="card">
  <div class="mark">${svg('lock')}</div>
  <h1>Omnichannel Orders</h1>
  ${lockedFor > 0
    ? `<p class="err" role="alert">Terlalu banyak percobaan gagal. Coba lagi dalam ${minutes} menit.</p>`
    : failed
      ? '<p class="err" role="alert">Email atau password salah.</p>'
      : ''}
  <form method="post" action="${escape(redirectTo)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required ${lockedFor > 0 ? 'disabled' : 'autofocus'}
      autocomplete="username" value="${escape(email)}" placeholder="nama@treelogy.com">
    <div class="gap"></div>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required ${lockedFor > 0 ? 'disabled' : ''}
      autocomplete="current-password" placeholder="Password">
    <button type="submit" ${lockedFor > 0 ? 'disabled' : ''}>Masuk</button>
  </form>
</main>
</body></html>`;
}

export const dashboardError = (heading, detail) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(heading)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0E14;color:#E8ECF4;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:1.5rem}
.c{max-width:30rem;padding:2rem;border:1px solid #232937;border-radius:14px;background:#12161F;text-align:center}
h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;color:#94A3B8;font-size:.9rem}</style>
<div class="c"><h1>${escape(heading)}</h1><p>${escape(detail)}</p></div>`;
