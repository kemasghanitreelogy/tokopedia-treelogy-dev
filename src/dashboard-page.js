import { businessToday, zoneLabel, zoneName, zoneForChannel, ZONES } from './clock.js';
import { CHANNELS, STAGES, MANUAL_CHANNEL, channelMeta } from './omni.js';
import { PRESETS } from './range.js';
import { CHANNEL_LABEL } from './stock-sync.js';
import { labelReadiness } from './labels.js';
import { PRODUCTS, CATEGORIES, groupProducts, findProduct, isBundle, buildableFrom, unmapped } from './master.js';
import { pending, nextAction } from './fulfillment.js';
import { orderCode } from './mekari/prefix.js';
import { SOURCE_OPTIONS, SELLABLE, MANUAL_CARRIERS } from './mekari/manual.js';
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

const STAGE_META = {
  unpaid: { label: 'Belum bayar', tone: 'warn' },
  to_ship: { label: 'Siap kirim', tone: 'act' },
  shipping: { label: 'Dikirim', tone: 'info' },
  delivered: { label: 'Terkirim', tone: 'good' },
  completed: { label: 'Selesai', tone: 'done' },
  cancelled: { label: 'Batal', tone: 'bad' },
  returned: { label: 'Retur', tone: 'bad' },
};

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
export const HIDDEN_VIEWS = { jurnal: 'Jurnal', activity: 'Aktivitas' };
export const VALID_VIEWS = { ...VIEWS, ...HIDDEN_VIEWS };

/** Tabs that need a permission the person may not have are not shown, not merely refused. */
const TAB_PERMISSION = { users: 'users' };
/**
 * Menus whose actions write something, and therefore have a log of their own. The log
 * button sits in the tab row of exactly these; a read-only menu has nothing to show.
 */
export const LOGGED_MENUS = new Set(['process', 'labels', 'stock', 'products', 'jurnal', 'users']);

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

function row(order, index) {
  const meta = channelMeta(order.channel);
  const stage = STAGE_META[order.stage];
  const track = order.tracking
    ? `<span class="mono">${escape(order.tracking)}</span>`
    : AWAITING_AWB.has(order.stage)
      ? '<span class="await">menunggu</span>'
      : '<span class="dim">&mdash;</span>';
  return `<tr class="row" tabindex="0" role="button" aria-label="Rincian pesanan ${escape(order.id)}"
    data-detail="od-${index}" data-channel="${order.channel}" data-stage="${order.stage}">
    <td><span class="tag" style="--accent:${meta.accent}">${escape(meta.label)}</span></td>
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
 * Everything known about one order, as the popup shows it.
 *
 * Rendered with the list rather than fetched on click: the page already holds the whole
 * order, so opening it costs nothing and works with the network off. Escaping happens
 * here, once, which is why the dialog copies markup instead of parsing a data attribute.
 */
function orderDetail(order, index) {
  const meta = channelMeta(order.channel);
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
      <span class="tag" style="--accent:${meta.accent}">${escape(meta.label)}</span>
      <span class="pill pill--${stage.tone}">${escape(stage.label)}</span>
      <span class="od__when">${escape(dateTime(order.createdAt, order.channel))}</span>
    </div>
    <p class="od__id mono">${escape(order.id)}</p>

    <dl class="od__grid">
      ${field('Pembeli', order.buyer)}
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

    <a class="od__print" target="_blank" rel="noopener"
       href="/api/invoice?channel=${escape(order.channel)}&amp;id=${escape(encodeURIComponent(order.id))}">
      ${svg('printer')}<span>Cetak faktur</span>
    </a>
  </div>`;
}

export function shell({
  title, range, errors = {}, truncated = [], maxPerPlatform, shopeeShop, generatedAt,
  view, kpis = '', body = '', hideRangeControls = false, script = '', flash = null,
  stale = false, staleSince = null, user = null, style = '', log = false,
}) {
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
.grp[hidden],.card[hidden]{display:none}

.card{display:flex; flex-direction:column; gap:.25rem; padding:.55rem .6rem; text-decoration:none;
  color:var(--fg); background:var(--glass-2); border:1px solid var(--glass-line); border-radius:var(--radius-s);
  transition:border-color var(--t-base) var(--ease-out),background var(--t-base) var(--ease-out),transform var(--t-base) var(--ease-out)}
.card:hover{border-color:var(--brand); background:var(--panel); transform:translateY(-2px);
  box-shadow:0 8px 20px -14px color-mix(in srgb,var(--brand) 70%,transparent)}
.card:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.card--flag{box-shadow:inset 3px 0 0 var(--warn)}
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
.card__tags{display:flex; gap:.3rem; align-items:center; font-size:.68rem}
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
.wl{margin-bottom:1.5rem}
.wl__h{padding:0 1rem .6rem}
.wl__h h3{margin:0; font-size:.95rem; font-weight:600; letter-spacing:-.01em; display:flex;
  align-items:center; gap:.5rem}
.wl__n{font:500 .72rem/1 "Inter",sans-serif; padding:.22rem .45rem; border-radius:6px;
  background:var(--panel-2); color:var(--muted); border:1px solid var(--line)}
.wl__grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:.7rem; padding:0 1rem}

.wl__bar{display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; padding:0 1rem 1rem}
.wl__sep{width:1px; height:22px; background:var(--line); margin:0 .25rem}
/* The commit button follows the list down the page - on a thirty-order day the action
   should never be something you have to scroll back to find. */
.wl__go{position:sticky; bottom:0; padding:1rem; margin-top:.5rem;
  background:linear-gradient(to top,color-mix(in srgb,var(--bg) 94%,transparent) 65%,transparent);
  display:flex; justify-content:center}
.wl__go .wo__go{max-width:24rem}

.wo{display:flex; align-items:flex-start; gap:.7rem; margin:0; padding:.85rem .9rem; cursor:pointer;
  background:var(--glass-2); border:1px solid var(--glass-line); border-radius:14px;
  transition:border-color var(--t-base) var(--ease-out), transform var(--t-base) var(--ease-out)}
.wo:hover{border-color:color-mix(in srgb,var(--brand) 55%,transparent); transform:translateY(-1px)}
.wo:focus-within{border-color:var(--brand)}
.wo__pick{width:17px; height:17px; margin-top:.15rem; flex:none; cursor:pointer; accent-color:var(--brand)}
.wo__body{display:flex; flex-direction:column; gap:.35rem; min-width:0; flex:1}
.wo:has(.wo__pick:checked){border-color:color-mix(in srgb,var(--brand) 55%,transparent);
  background:color-mix(in srgb,var(--brand) 7%,var(--panel-2))}
.wo__top{display:flex; align-items:center; justify-content:space-between; gap:.5rem}
.wo__when{font-size:.74rem; color:var(--dim); white-space:nowrap}
.wo__id{font-size:.82rem; color:var(--fg); overflow-wrap:anywhere; line-height:1.3}
.wo__who{display:flex; align-items:baseline; justify-content:space-between; gap:.6rem;
  font-size:.84rem; color:var(--muted)}
.wo__who b{color:var(--fg); font-weight:600; font-variant-numeric:tabular-nums; white-space:nowrap}
.wo__car{display:flex; align-items:center; gap:.35rem; font-size:.78rem; color:var(--muted)}
.wo__car .ico{width:14px; height:14px; color:var(--muted)}
/* A card outside the chosen courier stays readable but steps back. */
.wo--dim{opacity:.45}
.wo--dim:hover{opacity:1}
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
.st__grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:.7rem; padding:1rem}
.st__grid .grp{grid-column:1/-1; margin:.75rem 0 -.15rem; display:flex; align-items:baseline; gap:.5rem}
.st__grid .grp:first-child{margin-top:0}
.st{display:flex; flex-direction:column; gap:.5rem; padding:.85rem .9rem; border-radius:14px;
  background:var(--glass-2); border:1px solid var(--glass-line);
  transition:border-color var(--t-base) var(--ease-out), background var(--t-base) var(--ease-out)}
.st[hidden]{display:none}
.st--new{border-style:dashed}
/* The left edge carries the state so a problem is visible without reading the card. */
.st--new{box-shadow:inset 3px 0 0 var(--muted)}
.st--held,.st--drift{box-shadow:inset 3px 0 0 var(--warn)}
.st--ready{box-shadow:inset 3px 0 0 var(--good)}
.st--blind{box-shadow:inset 3px 0 0 var(--bad)}
.filters .chip b{margin-left:.3rem; font-weight:600; font-variant-numeric:tabular-nums}
.filters .chip b.ok{color:var(--good)}
.filters .chip b.flag{color:var(--warn)}
.chip.is-on b{color:inherit}
.st--dirty{border-color:var(--brand); background:color-mix(in srgb,var(--brand) 8%,var(--panel-2))}
.st__head{display:flex; flex-direction:column; gap:.1rem; min-width:0}
.st__name{font-size:.9rem; font-weight:500; line-height:1.3}
.st__sku{font-size:.7rem; color:var(--dim)}
.st__ch{display:flex; gap:.5rem; flex-wrap:wrap; padding:.4rem 0; border-top:1px solid var(--line);
  border-bottom:1px solid var(--line)}
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
.st__grid .st{animation:rise 340ms var(--ease-out) both}
.st__grid .st:nth-child(6n+1){animation-delay:120ms}
.st__grid .st:nth-child(6n+2){animation-delay:160ms}
.st__grid .st:nth-child(6n+3){animation-delay:200ms}
.st__grid .st:nth-child(6n+4){animation-delay:240ms}
.st__grid .st:nth-child(6n+5){animation-delay:280ms}
.st__grid .st:nth-child(6n){animation-delay:320ms}
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
.apply{display:flex; gap:.75rem; align-items:center; flex-wrap:wrap; padding:1rem;
  border-top:1px solid var(--line)}
.apply button{font:inherit; font-size:.85rem; font-weight:600; padding:.55rem 1.25rem; min-height:42px;
  border-radius:999px; cursor:pointer; color:#fff; border:1px solid transparent;
  background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent);
  transition:filter var(--t-base) var(--ease-out)}
.apply button:hover{filter:brightness(1.08)}
.apply .chip{color:var(--muted); font-weight:500; background:var(--glass); border:1px solid var(--glass-line); box-shadow:none}
.apply .chip:hover{color:var(--fg); background:var(--glass-2); filter:none}
.apply button:disabled{opacity:.45; cursor:not-allowed; filter:none}
.pick,#head{width:17px; height:17px; cursor:pointer; accent-color:var(--brand)}
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
  box-shadow:var(--shadow), inset 0 1px 0 rgba(255,255,255,.04); overflow:hidden}
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
.lnh{display:grid; grid-template-columns:minmax(0,1fr) 68px 116px 116px 92px 36px; gap:.4rem;
  font-size:.68rem; letter-spacing:.06em; text-transform:uppercase; color:var(--dim); padding-bottom:.35rem;
  border-bottom:1px solid var(--line)}
.lnh span:nth-child(n+2){text-align:right}
@media (max-width:720px){
  .lnh{display:none}
  .ln{grid-template-columns:minmax(0,1fr) 36px; grid-auto-rows:auto; gap:.35rem;
    padding:.7rem 0; border-top:1px solid var(--line)}
  .ln select{grid-column:1}
  .ln__x{grid-row:1; grid-column:2}
  .ln input,.ln__t{grid-column:1/-1}
}

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
${style}
@media (prefers-reduced-motion:reduce){
  *{transition:none !important; animation:none !important}
  #nav-progress.on{opacity:1; transform:translateX(-15%)}
  .sk::after{display:none}
}
</style>
</head><body>
<div id="nav-progress"></div>
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
      <button class="iconbtn" id="theme" type="button" aria-label="Ganti tema terang/gelap">${svg('sun')}</button>
      <a class="iconbtn" href="${escape(self)}" aria-label="Muat ulang data">${svg('refresh')}</a>
      <a class="iconbtn" href="?logout=1" aria-label="Keluar">${svg('logout')}</a>
    </div>
  </header>

  <section class="pagehead">
    <div class="pagehead__t">
      <h1>${escape(title)}</h1>
      <p class="sub">${escape(shopeeShop?.shop_name ?? 'Treelogy Moringa')} &middot; ${escape(range.label)} &middot; diperbarui ${escape(new Date(generatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: zoneName() }))} ${zoneLabel()}</p>
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
    var href = link.getAttribute('href');
    if (!href || href.charAt(0) === '#' || href.indexOf('javascript:') === 0) return;
    beginNavigation(link.classList.contains('viewtab') ? 'Memuat ' + link.textContent.trim() + '…' : 'Memuat…');
  }, true);

  document.addEventListener('submit', function (e) {
    if (e.target.getAttribute('target') === '_blank') return;
    beginNavigation('Menyimpan…');
    // A listener further down the chain can still cancel this submit - every confirmation
    // on this dashboard does exactly that - and a navigation that never starts must not
    // leave a skeleton over the page forever. Checked on the next tick, by which time
    // every other handler has had its say.
    window.setTimeout(function () { if (e.defaultPrevented) endNavigation(); }, 0);
  }, true);

  // Coming back through history shows a cached page; a stuck skeleton would be a lie.
  window.addEventListener('pageshow', function () {
    progress.classList.remove('on');
    loader.classList.remove('on');
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
  filter = {}, paging = { page: 1, perPage: DEFAULT_PER_PAGE }, baseQuery = '', user = null, flash = null,
}) {
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
    <div class="filters">${stageChips}</div>
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
    <div id="od-store" hidden>${paged.items.map((o, i) => orderDetail(o, i)).join('')}</div>
    <dialog class="od" id="od">
      <button class="od__x" type="button" id="od-close" aria-label="Tutup">${svg('x')}</button>
      <div id="od-body"></div>
    </dialog>
    ${pager(paged, { baseQuery, noun })}
    <div class="foot">
      <span>${idNumber(all.count)} pesanan pada rentang ini</span>
      <span>Waktu mengikuti jam masing-masing platform</span>
    </div>
  </section>`,
    style: ORDER_DETAIL_STYLE,
    script: ORDER_DETAIL_SCRIPT,
  });
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
export function renderProcess({ orders, range, errors, shopeeShop, generatedAt, csrf, flash, arranged = {}, user = null }) {
  const rows = pending(orders, arranged);
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;

  const byAction = {};
  for (const row of rows) (byAction[row.next.action] ??= []).push(row);

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

  const GROUPS = {
    tiktok_rts: { title: 'Tokopedia &amp; TikTok Shop' },
    shopee_ship: { title: 'Shopee' },
    shopify_arrange: { title: 'Shopify' },
  };

  // Waiting on the courier, not on us. Shown as a count so the page is not mistaken for
  // the whole picture, but never as a task.
  const waiting = orders.filter((o) => o.stage === 'to_ship' && !nextAction(o, arranged)).length;
  const moving = orders.filter((o) => o.stage === 'shipping').length;

  // A worklist, not a report: the action is the point, so each order is a card with the
  // button given real weight rather than a row whose primary control is the smallest
  // thing on screen. Raw platform statuses are dropped - the section heading already
  // says what is needed, and AWAITING_SHIPMENT means nothing to the person packing.
  // One form around everything, so the whole day's shipments go out on one click. Both
  // marketplace paths are handled server-side from the same selection - the operator
  // should not have to know that Shopee and TikTok batch differently.
  const cutoff = dispatchCutoff(Math.floor(generatedAt / 1000));
  const early = rows.filter(({ order }) => order.createdAt < cutoff).length;

  const card = ({ order: o }) => {
    const ch = channelMeta(o.channel);
    return `<label class="wo" data-carrier="${escape(o.carrier || 'Belum ditentukan')}"
      data-early="${o.createdAt < cutoff ? '1' : '0'}">
      <input class="wo__pick" type="checkbox" name="order" value="${escape(o.channel)}:${escape(o.id)}" checked
        aria-label="Pilih ${escape(o.id)}">
      <span class="wo__body">
        <span class="wo__top">
          <span class="tag" style="--accent:${ch.accent}">${escape(ch.label)}</span>
          <span class="wo__when">${escape(dateTime(o.createdAt, o.channel))}</span>
        </span>
        <span class="wo__id mono">${escape(o.id)}</span>
        <span class="wo__who">
          <span>${escape(o.buyer) || '<span class="dim">tanpa nama</span>'}</span>
          <b class="mono">${escape(rupiah(o.total))}</b>
        </span>
        ${o.channel === 'shopify'
          // Shopify records no courier until the parcel is already gone, so an empty
          // line there is the normal case and saying so every time is just noise.
          ? (o.carrier ? `<span class="wo__car">${svg('truck')}${escape(o.carrier)}</span>` : '')
          : `<span class="wo__car">${svg('truck')}${o.carrier
              ? escape(o.carrier)
              : '<span class="dim">kurir belum ditentukan</span>'}</span>`}
      </span>
    </label>`;
  };

  const section = (action, list) => {
    const meta = GROUPS[action];
    return `<section class="wl">
      <header class="wl__h">
        <h3>${meta.title}<span class="wl__n">${list.length}</span></h3>
      </header>
      <div class="wl__grid">${list.map(card).join('')}</div>
    </section>`;
  };

  // Arranging shipment comes before recording a dispatch, so the sections follow the
  // order a day actually runs in rather than whatever order the channels answered.
  const sections = Object.entries(byAction)
    .sort(([a], [b]) => Object.keys(GROUPS).indexOf(a) - Object.keys(GROUPS).indexOf(b))
    .map(([action, list]) => section(action, list))
    .join('');

  return shell({ user,
    title: 'Proses Pesanan',
    range, errors, shopeeShop, generatedAt,
    view: 'process',
    flash,
    kpis: `<div class="strip">
      ${stat('Perlu diatur', String(rows.length), rows.length > 0 ? 'flag' : 'ok')}
      ${stat('Menunggu kurir', String(waiting))}
      ${stat('Dalam pengiriman', String(moving))}
    </div>`,
    script: `
(function () {
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
  function setAll(v) { picks.forEach(function (p) { p.checked = v; }); sync(); }

  picks.forEach(function (p) { p.addEventListener('change', sync); });
  toggle.addEventListener('click', function () {
    setAll(toggle.getAttribute('aria-pressed') !== 'true');
  });

  // Selecting rather than hiding: a dropoff run covers one courier, or everything that
  // made today's cut-off, but the rest of the day's orders stay visible so nothing is
  // forgotten. One selector is active at a time, whichever axis it selects by.
  var selectors = Array.prototype.slice.call(form.querySelectorAll('.wl__bar button[data-carrier], .wl__bar button[data-early]'));
  selectors.forEach(function (chip) {
    chip.addEventListener('click', function () {
      selectors.forEach(function (c) { c.classList.toggle('is-on', c === chip); });
      var wantEarly = chip.hasAttribute('data-early');
      var want = chip.dataset.carrier;
      picks.forEach(function (p) {
        var card = p.closest('.wo');
        var hit = wantEarly ? card.dataset.early === '1' : (want === '' || card.dataset.carrier === want);
        p.checked = hit;
        card.classList.toggle('wo--dim', !hit && (wantEarly || want !== ''));
      });
      sync();
    });
  });

  sync();
})();\n`,
    body: rows.length === 0
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
          ${sections}
          <div class="wl__go">
            <button class="wo__go" type="submit" id="go">Atur pengiriman <span id="n">${rows.length}</span> pesanan</button>
          </div>
        </form>`,
  });
}

/** Warehouse view: what to pick, biggest first, with the channel split for packing. */
export function renderPicklist({ picklist, range, errors, shopeeShop, generatedAt, user = null }) {
  // A picker reads quantity first and everything else only to confirm, so the number
  // leads and the channel split collapses into one line of small tags.
  const split = (by) => Object.entries({ tokopedia: 'Tokped', tiktok_shop: 'TikTok', shopee: 'Shopee' })
    .filter(([key]) => by[key] > 0)
    .map(([key, label]) => `<span class="mini" style="--chip:${CHANNELS[key].accent}">${label} ${by[key]}</span>`)
    .join('');

  const rows = picklist.items
    .map((i) => `<tr>
      <td class="pick__q mono">${i.qty}</td>
      <td>
        <span class="pick__n">${escape(i.name)}${i.variant ? ` <span class="note">${escape(i.variant)}</span>` : ''}</span>
        <span class="pick__s mono">${escape(i.sku)}</span>
      </td>
      <td class="pick__c">${split(i.byChannel)}</td>
      <td class="num dim nowrap">${i.orders} order</td>
    </tr>`)
    .join('');

  return shell({ user,
    title: 'Picklist',
    range,
    errors,
    shopeeShop,
    generatedAt,
    view: 'picklist',
    kpis: `
      <div class="strip">
        ${stat('Unit dipetik', String(picklist.unitCount))}
        ${stat('SKU', String(picklist.skuCount))}
        ${stat('Pesanan', String(picklist.orderCount))}
      </div>`,
    body: picklist.items.length === 0
      ? '<p class="empty">Tidak ada pesanan yang menunggu dipetik.</p>'
      : `<div class="scroll"><table class="dense">
          <thead><tr>
            <th class="num">Qty</th><th>Produk</th><th>Kanal</th><th class="num">Pesanan</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div class="foot"><span>${picklist.skuCount} SKU &middot; ${picklist.unitCount} unit</span></div>`,
  });
}

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
      const meta = channelMeta(r.order.channel);
      const state = JURNAL_STATE[r.state];
      return `<tr data-state="${r.state}">
        <td><span class="tag" style="--accent:${meta.accent}">${escape(meta.label)}</span></td>
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
  live, existingCodes = [], images = {}, seqTail = '', prices = {}, user = null,
}) {
  const chosen = SOURCE_OPTIONS.find((o) => o.prefix === source) ?? SOURCE_OPTIONS[0];

  const sources = SOURCE_OPTIONS.map((o) => `
    <label class="src__o">
      <input type="radio" name="source" value="${o.prefix}" ${o.prefix === chosen.prefix ? 'checked' : ''}
             data-term="${o.termDays}" data-label="${escape(o.label)}">
      <span class="src__b">
        <span class="src__p">${o.prefix}</span>
        <span class="src__l">${escape(o.label)}</span>
        <span class="src__t">Net ${o.termDays}</span>
      </span>
    </label>`).join('');

  // Grouped so a long flat list does not have to be read top to bottom every time.
  const byCategory = new Map();
  for (const product of SELLABLE) {
    if (!byCategory.has(product.category)) byCategory.set(product.category, []);
    byCategory.get(product.category).push(product);
  }
  // Each option carries the price Shopify sells it at, copied into our own store by the
  // daily job. The field is still editable - a consignment is often discounted - but
  // nobody has to go and look the number up.
  const productOptions = [...byCategory.entries()]
    .map(([category, items]) => `<optgroup label="${escape(CATEGORIES[category] ?? category)}">${
      items.map((p) => `<option value="${escape(p.sku)}" data-price="${Number(prices[p.sku]) || 0}">${escape(p.name)}</option>`).join('')
    }</optgroup>`)
    .join('');

  const lineRow = (index) => `
    <div class="ln" data-row>
      <span class="ln__prod">
        <img class="ln__pic" alt="" width="38" height="38" hidden>
        <select name="sku" aria-label="Produk baris ${index + 1}">
          <option value="">Pilih produk&hellip;</option>
          ${productOptions}
        </select>
      </span>
      <input type="number" name="qty" value="1" min="1" step="1" inputmode="numeric" aria-label="Kuantitas">
      <input type="number" name="unitPrice" value="" min="0" step="1" inputmode="numeric" placeholder="Harga" aria-label="Harga satuan">
      <span class="ln__disc">
        <input type="number" name="unitDiscount" value="0" min="0" step="1" inputmode="numeric"
               aria-label="Diskon baris ${index + 1}">
        <span class="seg" role="group" aria-label="Satuan diskon baris ${index + 1}">
          <button class="seg__b is-on" type="button" data-mode="rp" aria-pressed="true">Rp</button>
          <button class="seg__b" type="button" data-mode="pct" aria-pressed="false">%</button>
        </span>
        <input type="hidden" name="discountMode" value="rp">
      </span>
      <span class="ln__t" data-line-total>&mdash;</span>
      <button class="ln__x" type="button" data-remove aria-label="Hapus baris ${index + 1}">&times;</button>
    </div>`;

  return shell({ user,
    title: 'Transaksi manual',
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
      <form method="post" id="mxform" data-confirm="Simpan transaksi ini dan kirim ke Mekari Jurnal?">
        <input type="hidden" name="csrf" value="${escape(csrf)}">
        <input type="hidden" name="view" value="jurnal">
        <input type="hidden" name="action" value="manual_invoice">

        <div class="mx">
          <div class="panel">
            <div class="fset">
              <h3 class="fset__h">Sumber</h3>
              <div class="src">${sources}</div>
            </div>

            <div class="fset">
              <h3 class="fset__h">Detail</h3>
              <div class="flds">
                <div class="fld fld--mono">
                  <label for="code">Kode transaksi</label>
                  <input id="code" name="code" value="${escape(code)}" required maxlength="43"
                         pattern="[A-Za-z]{2}-[A-Za-z0-9-]{1,40}" data-code>
                </div>
                <div class="fld">
                  <label for="date">Tanggal</label>
                  <input id="date" name="date" type="date" value="${escape(today)}" max="${escape(today)}" required>
                </div>
                <div class="fld">
                  <label for="shipping">Ongkir</label>
                  <input id="shipping" name="shipping" type="number" value="0" min="0" step="1" inputmode="numeric">
                </div>
              </div>
            </div>

            <div class="fset">
              <h3 class="fset__h">Pelanggan</h3>
              <div class="flds">
                <div class="fld">
                  <label for="buyer">Nama pelanggan</label>
                  <input id="buyer" name="buyer" list="mxcontacts" maxlength="120" autocomplete="off"
                         placeholder="Nama orang atau toko" data-customer>
                  <span class="fld__hint" data-customer-hint>Kosong: ditagih atas nama ${escape(chosen.label)}</span>
                </div>
                <div class="fld">
                  <label for="buyerPhone">Nomor telepon</label>
                  <input id="buyerPhone" name="buyerPhone" type="tel" maxlength="40" autocomplete="off" placeholder="08...">
                </div>
                <div class="fld">
                  <label for="buyerEmail">Email</label>
                  <input id="buyerEmail" name="buyerEmail" type="email" maxlength="120" autocomplete="off" placeholder="nama@contoh.id">
                </div>
                <div class="fld">
                  <label for="carrier">Kurir</label>
                  <select id="carrier" name="carrier">
                    <option value="">Belum ditentukan</option>
                    ${MANUAL_CARRIERS.map((name) => `<option value="${escape(name)}">${escape(name)}</option>`).join('')}
                  </select>
                </div>
              </div>
              <div class="flds flds--one">
                <div class="fld">
                  <label for="shipTo">Alamat</label>
                  <textarea id="shipTo" name="shipTo" rows="2" maxlength="400"
                            placeholder="Jalan, kelurahan, kecamatan, kota, provinsi, kode pos"></textarea>
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
              <div id="lines">${lineRow(0)}</div>
              <button class="addln" type="button" id="addln">+ Tambah baris</button>
            </div>

            <div class="fset">
              <h3 class="fset__h">Catatan</h3>
              <div class="fld">
                <label for="note">Keterangan (ikut ke memo faktur)</label>
                <input id="note" name="note" maxlength="200" placeholder="mis. titip di toko A, tempo 7 hari">
              </div>
            </div>
          </div>

          <aside class="mx__side">
            <div class="panel sum">
              <div class="sum__r"><span>Produk</span><b data-sum-goods>Rp0</b></div>
              <div class="sum__r"><span>Ongkir</span><b data-sum-ship>Rp0</b></div>
              <div class="sum__r"><span>Termin</span><b data-sum-term>Net ${chosen.termDays}</b></div>
              <div class="sum__r"><span>Jatuh tempo</span><b data-sum-due>&mdash;</b></div>
              <div class="sum__t"><span>Total</span><b data-sum-total>Rp0</b></div>
              <input type="hidden" name="total" data-total-field value="0">
              <button class="sum__go" type="submit" id="mxgo" disabled>Simpan &amp; kirim ke Jurnal</button>
            </div>
          </aside>
        </div>
      </form>`,
    script: `
(function () {
  var form = document.getElementById('mxform');
  if (!form) return;

  var lines = document.getElementById('lines');
  var template = lines.firstElementChild.cloneNode(true);
  var codeField = form.querySelector('[data-code]');
  var customerHint = form.querySelector('[data-customer-hint]');
  var dateField = form.querySelector('input[name="date"]');
  var shipField = form.querySelector('input[name="shipping"]');
  var go = document.getElementById('mxgo');
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
    if (codeIsOurs) codeField.value = suggest();
  }

  function total() {
    var goods = 0;
    Array.prototype.forEach.call(lines.querySelectorAll('[data-row]'), function (row) {
      var sku = row.querySelector('select').value;
      var qty = num(row.querySelector('[name="qty"]'));
      var price = num(row.querySelector('[name="unitPrice"]'));
      var disc = discountOf(row, price);
      var cell = row.querySelector('[data-line-total]');
      // A row without a product or a price contributes nothing and says so, rather than
      // quietly counting as zero in a total that looks complete.
      if (!sku || price <= 0 || qty <= 0) { cell.textContent = '\\u2014'; return; }
      var net = Math.max(0, price - disc) * qty;
      cell.textContent = rupiah(net);
      goods += net;
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

    go.disabled = goods <= 0;
    // The confirmation quotes what is actually about to be written - the house rule for
    // anything that writes - so it is rebuilt whenever the numbers change.
    form.dataset.confirm = 'Simpan ' + (codeField.value || 'transaksi') +
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

  wire(lines.firstElementChild);

  document.getElementById('addln').addEventListener('click', function () {
    var row = template.cloneNode(true);
    row.querySelector('select').value = '';
    row.querySelector('[name="unitPrice"]').value = '';
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
   * Picking a product fills its price, once.
   *
   * Only into an empty field: the operator who typed a consignment discount and then
   * corrected the product should not watch their number vanish.
   */
  function fillPrice(select) {
    var row = select.closest('[data-row]');
    var field = row.querySelector('[name="unitPrice"]');
    var option = select.options[select.selectedIndex];
    var price = option ? Number(option.dataset.price) : 0;
    if (price > 0 && !field.value) field.value = price;
  }

  form.addEventListener('change', function (e) {
    if (e.target.name === 'sku') { showPicture(e.target.closest('[data-row]')); fillPrice(e.target); }
    if (e.target.name === 'source') {
      // An empty name bills the source itself, and the hint says which.
      if (customerHint) customerHint.textContent = 'Kosong: ditagih atas nama ' + e.target.dataset.label;
      refreshCode();
    }
    if (e.target === dateField) refreshCode();
    total();
  });

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
        <span class="note">Sinkron ${escape(syncNotes)}</span>
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

/**
 * Label view: pick the parcels to print, get one PDF sized for the thermal printer.
 *
 * Orders are pre-selected because printing every waiting label is the normal action;
 * unticking is the exception. The form posts to a separate endpoint that streams the PDF
 * straight into the browser's print preview.
 */
export function renderLabels({ orders, range, errors, shopeeShop, generatedAt, csrf, flash, sizes, defaultSize, showReprints = false, printed = {}, user = null }) {
  // The list shows only what actually needs printing today, so everything on screen is
  // ticked and everything ticked will print. Reprints of parcels the courier already
  // took are a deliberate detour, not clutter in the daily view.
  const assessed = orders.map((o) => ({ order: o, readiness: labelReadiness(o, printed) }));

  const counts = { needsPrint: 0, waiting: 0, arrange: 0, reprint: 0 };
  for (const { readiness } of assessed) {
    if (counts[readiness.state] !== undefined) counts[readiness.state] += 1;
  }

  const wanted = showReprints ? ['needsPrint', 'reprint'] : ['needsPrint'];
  // Printing is capped server-side; showing past it would hand the operator a button
  // that always errors.
  const candidates = assessed
    .filter(({ readiness }) => wanted.includes(readiness.state) && !readiness.unavailable)
    .slice(0, MAX_PRESELECT);

  let ticked = 0;

  const READY_TONE = { needsPrint: 'ok', reprint: 'flag' };

  const rows = candidates
    .map(({ order: o, readiness }) => {
      const meta = channelMeta(o.channel);
      const stage = STAGE_META[o.stage];
      // Everything listed is printable, so everything listed starts ticked.
      ticked += 1;
      const checked = ' checked';
      // The stage pill is redundant here - every row on this page is printable by
      // definition, and the readiness note already says what matters.
      return `<tr>
        <td><input class="pick" type="checkbox" name="order" value="${escape(o.channel)}:${escape(o.id)}"${checked}
          aria-label="Cetak label ${escape(o.id)}"></td>
        <td><span class="tag" style="--accent:${meta.accent}">${escape(meta.label)}</span></td>
        <td>
          <span class="mono nowrap">${escape(o.id)}</span>
          <span class="pick__s">${escape(dateTime(o.createdAt, o.channel))} &middot; ${escape(o.carrier) || 'kurir belum ada'}</span>
        </td>
        <td class="nowrap">${escape(o.buyer) || '<span class="dim">&mdash;</span>'}</td>
        <td class="nowrap"><span class="${READY_TONE[readiness.state]}">${escape(readiness.note)}</span></td>
      </tr>`;
    })
    .join('');



  const sizeOptions = Object.entries(sizes)
    .map(([id, meta]) => `<option value="${escape(id)}" ${id === defaultSize ? 'selected' : ''}>${escape(meta.label)}</option>`)
    .join('');

  return shell({ user,
    title: 'Cetak Label',
    range, errors, shopeeShop, generatedAt,
    view: 'labels',
    flash,
    kpis: `
      <div class="strip">
        ${stat('Perlu dicetak', String(counts.needsPrint), counts.needsPrint > 0 ? 'ok' : '')}
        ${stat('Menunggu kurir', String(counts.waiting), counts.waiting > 0 ? 'flag' : '')}
        ${stat('Atur pengiriman', String(counts.arrange), counts.arrange > 0 ? 'flag' : '')}
        ${stat('Sudah jalan', String(counts.reprint))}
      </div>`,
    body: candidates.length === 0
      ? `<p class="empty">${showReprints
          ? 'Tidak ada label yang bisa dicetak.'
          : 'Semua label sudah dicetak.'}</p>
         <div class="apply"><a class="chip" href="?view=labels&reprint=${showReprints ? '0' : '1'}">${
           showReprints ? 'Kembali ke daftar harian' : 'Tampilkan cetak ulang'}</a></div>`
      : `<form method="post" action="/api/labels" target="_blank">
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
            <tbody>${rows}</tbody>
          </table></div>
          <div class="apply">
            <button type="submit">Cetak <span id="n">${ticked}</span> label</button>
            ${candidates.some(({ order: o }) => o.channel === 'shopify') && !showReprints
              ? `<button class="chip" type="submit" formaction="/api/dashboard" formtarget="_self"
                   name="action" value="label_printed"
                   data-confirm-text="Tandai label yang tercentang sebagai sudah dicetak, tanpa mencetak?">Tandai sudah dicetak</button>`
              : ''}
          </div>
          <input type="hidden" name="view" value="labels">
        </form>`,
    script: `
(function () {
  var picks = Array.prototype.slice.call(document.querySelectorAll('.pick'));
  var counter = document.getElementById('n');
  var head = document.getElementById('head');
  var toggle = document.getElementById('pickall');
  if (!picks.length) return;

  function sync() {
    var n = picks.filter(function (p) { return p.checked; }).length;
    counter.textContent = n;
    head.checked = n === picks.length;
    head.indeterminate = n > 0 && n < picks.length;
    // One control, and it says what pressing it will do rather than what is true now.
    var allOn = n > 0 && n === picks.length;
    toggle.textContent = allOn ? 'Kosongkan semua' : 'Pilih semua';
    toggle.setAttribute('aria-pressed', allOn ? 'true' : 'false');
  }
  function setAll(value) { picks.forEach(function (p) { p.checked = value; }); sync(); }

  picks.forEach(function (p) { p.addEventListener('change', sync); });
  head.addEventListener('change', function () { setAll(head.checked); });
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
function channelChip(key, qty, { failed = false, off = false } = {}) {
  const mark = CHANNEL_MARKS[key];
  const value = failed ? '<b class="stop">?</b>' : qty === null ? '<b class="dim">&mdash;</b>' : `<b>${qty}</b>`;
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
export function renderStock({ catalog, ledger, plan, errors, range, shopeeShop, generatedAt, csrf, flash, filter = 'all', user = null }) {
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
    const key = product?.name ?? entry.title ?? entry.sku;
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

  const cardFor = (entry, { grouped }) => {
      const product = findProduct(entry.sku);
      const row = ledger?.skus?.[entry.sku];
      const master = row && !row.alias_of ? row.qty : null;
      if (row) managed += 1;

      const channels = [
        ['tiktok', entry.tiktok?.qty ?? null, errors.tiktok],
        ['shopee', entry.shopee?.qty ?? null, errors.shopee],
        ['shopify', entry.shopify?.qty ?? null, errors.shopify],
      ].filter(([, qty, failed]) => qty !== null || failed);

      const values = channels.map(([, q]) => q).filter((q) => typeof q === 'number');
      const spread = values.length > 1 && new Set(values).size > 1;

      // What saving this number would actually do, in one line the operator can act on.
      const mine = planFor(entry.sku);
      // A held row is usually right - it is held because the number came from the seed,
      // not because it is wrong. Without a way to vouch for it, the operator would have
      // to nudge the value up and back down to make the button light up.
      const heldBySeed = mine.some((c) => /angka awal/.test(c.reason ?? ''));

      // One state per card drives its colour, its filter bucket and its count. Deriving
      // all three from the same value is what keeps the chips honest.
      let state;
      let note;
      if (blind) { state = 'blind'; note = '<span class="stop">sebagian kanal tidak terbaca</span>'; }
      else if (!row) { state = 'new'; note = '<span class="flag">belum dikelola &mdash; isi untuk mulai</span>'; }
      else if (row.alias_of) { state = 'alias'; note = `<span class="dim">ikut ${escape(row.alias_of)}</span>`; }
      else if (mine.some((c) => c.reason)) {
        state = 'held';
        note = `<span class="flag">${escape(mine.find((c) => c.reason).reason)}</span>`;
      } else if (mine.length > 0) {
        state = 'ready';
        note = `<span class="ok">siap ditulis ke ${mine.length} listing</span>`;
      } else if (spread) { state = 'drift'; note = '<span class="flag">kanal belum seragam</span>'; }
      else { state = 'ok'; note = '<span class="ok">semua kanal sudah sama</span>'; }

      if (state === 'new' || state === 'held' || state === 'drift') needsAttention += 1;
      counts[state] = (counts[state] ?? 0) + 1;

      const suggestion = spread && values.length > 0 ? Math.min(...values) : null;

      return `<div class="st st--${state}" data-state="${state}" data-drift="${spread ? '1' : '0'}"
        data-lowest="${suggestion ?? ''}">
        <div class="st__head">
          <span class="st__name">${grouped && product?.variant
            ? product.variant
            : escape(product?.name ?? entry.title)}</span>
          <span class="st__sku mono">${escape(entry.sku)}</span>
        </div>
        <div class="st__ch">
          ${channels.map(([key, qty, failed]) => channelChip(key, qty, {
            failed: Boolean(failed),
            off: typeof qty === 'number' && master !== null && qty !== master,
          })).join('')}
        </div>
        <div class="st__edit">
          <button class="st__b" type="button" data-step="-1" aria-label="Kurangi ${escape(entry.sku)}">&minus;</button>
          <input class="st__in mono" type="number" min="0" step="1" inputmode="numeric"
            name="qty:${escape(entry.sku)}" value="${master ?? ''}" placeholder="&mdash;"
            data-original="${master ?? ''}" aria-label="Stok ${escape(entry.sku)}">
          <button class="st__b" type="button" data-step="1" aria-label="Tambah ${escape(entry.sku)}">+</button>
          ${suggestion !== null
            ? `<button class="st__fix" type="button" data-set="${suggestion}" title="Pakai angka terendah antar kanal">= ${suggestion}</button>`
            : ''}
        </div>
        <p class="st__note">${note}</p>
        ${heldBySeed ? `<label class="st__vouch">
          <input type="checkbox" name="vouch:${escape(entry.sku)}" value="1">
          <span>Saya konfirmasi stoknya memang ${master}</span>
        </label>` : ''}
      </div>`;
  };

  const cards = ordered
    .map((group) => {
      const many = group.items.length > 1;
      // A heading over a single card would only repeat that card's own title.
      const heading = many
        ? `<h3 class="grp">${escape(group.name)}<span class="grp__n">${group.items.length} varian</span></h3>`
        : '';
      return heading + group.items.map((entry) => cardFor(entry, { grouped: many })).join('');
    })
    .join('');

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
        <div class="st__grid" id="rows">${cards}</div>
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
export function renderProducts({ catalog, ledger, plan, errors, range, shopeeShop, generatedAt, csrf, flash, selected, images = {}, user = null }) {
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
  const syncBar = plan && (plan.changes.length > 0 || plan.review.length > 0 || plan.blocked.length > 0)
    ? `<div class="sync">
        <span class="sync__txt">
          ${plan.changes.length > 0
            ? `<b>${plan.changes.length}</b> perubahan stok siap ditulis ke marketplace`
            : 'Tidak ada perubahan yang siap ditulis'}
          ${plan.review.length + plan.blocked.length > 0
            ? ` &middot; <span class="flag">${plan.review.length + plan.blocked.length} ditahan untuk ditinjau</span>`
            : ''}
        </span>
        <details class="sync__d">
          <summary>Lihat rincian</summary>
          <div class="scroll"><table class="dense">
            <thead><tr><th>SKU</th><th>Kanal</th><th class="num">Dari</th><th class="num">Jadi</th><th>Keterangan</th></tr></thead>
            <tbody>${[...plan.changes, ...plan.review, ...plan.blocked].map((c) => `<tr>
              <td class="mono nowrap">${escape(c.sku)}</td>
              <td class="dim nowrap">${escape(CHANNEL_LABEL[c.channel] ?? c.channel)}</td>
              <td class="num mono">${c.from}</td>
              <td class="num mono">${c.to}</td>
              <td>${c.reason ? `<span class="flag">${escape(c.reason)}</span>` : '<span class="ok">siap</span>'}</td>
            </tr>`).join('')}</tbody>
          </table></div>
        </details>
        <form method="post" data-confirm="Tulis ${plan.changes.length} perubahan stok ke marketplace?">
          ${hidden}
          <input type="hidden" name="action" value="apply">
          <button class="sync__go" type="submit" ${plan.changes.length === 0 ? 'disabled' : ''}>Terapkan</button>
        </form>
      </div>`
    : '';

  const detail = selected ? findProduct(selected) : null;
  if (detail) {
    return shell({ user,
      title: detail.name,
      range, errors, shopeeShop, generatedAt,
      view: 'products',
      hideRangeControls: true,
      flash,
      stale: Boolean(catalog.stale),
      staleSince: catalog.savedAt ? wibStamp(catalog.savedAt) : null,
      kpis: '',
      body: productDetail({ product: detail, live, ledger, stockOf, csrf, plan , picture: images[selected] ?? null }),
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
  const drift = partial ? [] : unmapped(catalog.skus).filter((e) => e.tiktok || e.shopee);

  // One table, not one per category: separate tables cannot share column widths, so the
  // numbers drifted out of alignment down the page and the header repeated six times.
  const cell = (product) => {
    const entry = live.get(product.sku);
    const tt = entry?.tiktok?.qty ?? null;
    const sp = entry?.shopee?.qty ?? null;
    const sy = entry?.shopify?.qty ?? null;
    const price = entry?.tiktok?.price ?? entry?.shopee?.price ?? entry?.shopify?.price ?? null;

    let status;
    let attention = false;
    if (blindTo.length > 0) {
      status = `<span class="stop">${escape(blindTo.join(' & '))} tidak terbaca</span>`;
    } else if (!entry) {
      status = '<span class="flag">belum tayang</span>';
      attention = true;
    } else if (tt === null) {
      status = '<span class="flag">hanya Shopee</span>';
      attention = true;
    } else if (sp === null) {
      status = '<span class="flag">hanya Tokopedia</span>';
      attention = true;
    } else if (tt !== sp || (sy !== null && sy !== tt)) {
      const values = [tt, sp, sy].filter((v) => v !== null);
      status = `<span class="flag">stok beda ${Math.max(...values) - Math.min(...values)}</span>`;
      attention = true;
    } else {
      status = '<span class="ok">sinkron</span>';
    }

    let build = '';
    if (isBundle(product) && !partial) {
      const info = buildableFrom(product, stockOf);
      const listed = stockOf(product.sku);
      if (info.buildable !== null && listed !== null && listed > info.buildable) {
        build = `<span class="stop" title="Komponen hanya cukup untuk ${info.buildable}">oversell ${listed - info.buildable}</span>`;
        attention = true;
      } else if (info.buildable !== null) {
        build = `<span class="dim">rakit ${info.buildable}</span>`;
      }
    }

    return { entry, tt, sp, sy, price, status, build, attention };
  };

  // A card grid rather than a table: the table spent most of its width on empty space in
  // the product column, so 23 products needed twice the scrolling they deserve.
  const cards = groupProducts()
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => {
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
      ...group.items.map((product) => {
        const { tt, sp, sy, price, status, build, attention } = cell(product);
        const qty = (value, failed) =>
          failed ? '<span class="stop">?</span>'
          : value === null ? '<span class="dim">&mdash;</span>'
          : `<b>${value}</b>`;

        const picture = images[product.sku];
        return `<a class="card${attention ? ' card--flag' : ''}" href="?view=products&sku=${encodeURIComponent(product.sku)}">
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
            <span class="card__tags">${build}${status}</span>
          </span>
        </a>`;
      }),
    ])
    .join('');

  const groups = `<div class="cards" id="rows">${cards}</div>`;

  const driftNote = drift.length > 0
    ? `<p class="sec">Tayang tapi belum ada di data master</p>
       <div class="scroll"><table>
         <thead><tr><th>SKU</th><th>Judul listing</th><th class="num">Tokped</th><th class="num">Shopee</th></tr></thead>
         <tbody>${drift.map((e) => `<tr>
           <td class="mono nowrap">${escape(e.sku)}</td>
           <td>${escape(e.title)}</td>
           <td class="num mono">${e.tiktok?.qty ?? '&mdash;'}</td>
           <td class="num mono">${e.shopee?.qty ?? '&mdash;'}</td>
         </tr>`).join('')}</tbody>
       </table></div>`
    : '';

  return shell({ user,
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
      <button class="chip" type="button" id="only">Perlu perhatian</button>
      <input class="search" id="q" type="search" aria-label="Cari produk atau SKU" placeholder="Cari produk atau SKU...">
    </div>`,
    body: `${syncBar}${groups}${driftNote}
      <div class="foot">
        <span id="shown"></span>
        <span>Klik kartu untuk melihat dan mengubah data di tiap kanal.</span>
      </div>`,
    script: `
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#rows .card'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('#rows .grp'));
  var shown = document.getElementById('shown');
  var onlyBtn = document.getElementById('only');
  var search = document.getElementById('q');
  var state = { only: false, q: '' };

  function apply() {
    var n = 0;
    rows.forEach(function (row) {
      var text = row.textContent.toLowerCase();
      var ok = (!state.only || row.classList.contains('card--flag'))
        && (state.q === '' || text.indexOf(state.q) !== -1);
      row.hidden = !ok;
      if (ok) n++;
    });
    // A category heading with nothing under it is noise, so it hides with its rows.
    groups.forEach(function (grp) {
      var any = false;
      for (var el = grp.nextElementSibling; el && !el.classList.contains('grp'); el = el.nextElementSibling) {
        if (!el.hidden) { any = true; break; }
      }
      grp.hidden = !any;
    });
    shown.textContent = n + ' produk';
  }

  onlyBtn.addEventListener('click', function () {
    state.only = !state.only;
    onlyBtn.classList.toggle('is-on', state.only);
    apply();
  });
  search.addEventListener('input', function (e) {
    state.q = e.target.value.trim().toLowerCase();
    apply();
  });
  apply();
})();`,
  });
}

/** One product: what each channel holds, and the controls to change it. */
function productDetail({ product, live, ledger, stockOf, csrf, plan, picture = null }) {
  const entry = live.get(product.sku);
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const ledgerRow = ledger?.skus?.[product.sku];

  const mine = plan
    ? [...plan.changes, ...plan.review, ...plan.blocked].filter((c) => c.sku === product.sku)
    : [];
  const syncNote = mine.length > 0
    ? `<div class="apply">
        <span class="note">${mine.map((c) => `${escape(CHANNEL_LABEL[c.channel] ?? c.channel)}:
          <b>${c.from} &rarr; ${c.to}</b>${c.reason ? ` <span class="flag">${escape(c.reason)}</span>` : ' <span class="ok">siap</span>'}`).join(' &middot; ')}</span>
      </div>`
    : '';

  const channelCard = (key, label, row) => {
    if (!row) {
      return `<div class="ch"><header class="ch__head"><h3>${escape(label)}</h3></header>
        <p class="empty">Belum ada listing hidup di kanal ini.</p></div>`;
    }
    const ids = key === 'tiktok'
      ? [['Product ID', row.productId], ['SKU ID', row.skuId], ['Gudang', row.warehouseId]]
      : key === 'shopify'
        ? [['Product', row.productId], ['Variant', row.variantId]]
        : [['Item ID', row.itemId], ['Model ID', row.modelId || '(tanpa varian)']];
    return `<div class="ch">
      <header class="ch__head"><h3>${escape(label)}</h3><span class="ch__count">${escape(row.status ?? '')}</span></header>
      <dl class="kv">
        <dt>Stok</dt><dd class="mono">${row.qty}</dd>
        <dt>Harga</dt><dd class="mono">${escape(rupiah(row.price ?? 0))}</dd>
        ${row.hasPromotion ? `<dt>Promo</dt><dd class="flag mono">${escape(rupiah(row.promoPrice ?? 0))}</dd>` : ''}
        <dt>Judul</dt><dd>${escape(row.title ?? '')}</dd>
        ${ids.map(([k, v]) => `<dt>${escape(k)}</dt><dd class="mono dim">${escape(String(v ?? '-'))}</dd>`).join('')}
      </dl>
    </div>`;
  };

  const bundle = isBundle(product) ? buildableFrom(product, stockOf) : null;
  const listedQty = stockOf(product.sku);

  const bundleBlock = bundle
    ? `<p class="sec">Isi bundle</p>
       <div class="scroll"><table>
         <thead><tr><th>Komponen</th><th class="num">Butuh</th><th class="num">Stok</th><th class="num">Cukup untuk</th></tr></thead>
         <tbody>${bundle.parts.map((part) => {
           const component = findProduct(part.sku);
           return `<tr>
             <td><a class="plink" href="?view=products&sku=${encodeURIComponent(part.sku)}">${escape(component?.name ?? part.sku)}</a>
                 ${component?.variant ? `<span class="note"> &middot; ${escape(component.variant)}</span>` : ''}
                 <span class="note mono"> ${escape(part.sku)}</span></td>
             <td class="num mono">${part.qty}</td>
             <td class="num mono">${part.available ?? '&mdash;'}</td>
             <td class="num mono">${part.possible ?? '&mdash;'}</td>
           </tr>`;
         }).join('')}</tbody>
       </table></div>
       <div class="apply">
         <span class="note">
           Komponen cukup untuk <b>${bundle.buildable ?? '?'}</b> bundle.
           ${listedQty !== null && bundle.buildable !== null && listedQty > bundle.buildable
             ? `<span class="stop">Listing memasang ${listedQty} &mdash; lebih besar dari yang bisa dirakit.</span>`
             : ''}
         </span>
       </div>`
    : '';

  return `
    ${picture?.url ? `<div class="pd__hero">
      <img class="pd__img" src="${escape(picture.thumb || picture.url)}" alt="${escape(picture.alt || product.name)}" width="200" height="200">
      <div class="pd__cap">
        <b>${escape(product.name)}</b>${product.variant ? ` <span class="note">${escape(product.variant)}</span>` : ''}
        <span class="mono dim">${escape(product.sku)}</span>
      </div>
    </div>` : ''}
    <p class="sec">${escape(product.name)}${product.variant ? ' &middot; ' + escape(product.variant) : ''}
      <span class="mono dim"> ${escape(product.sku)}</span></p>
    <div class="chs" style="padding:1rem">
      ${channelCard('tiktok', 'Tokopedia + TikTok Shop', entry?.tiktok?.rows?.[0])}
      ${channelCard('shopee', 'Shopee', entry?.shopee?.rows?.[0])}
      ${entry?.shopify ? channelCard('shopify', 'Shopify', entry.shopify.rows?.[0]) : ''}
    </div>
    ${bundleBlock}
    <p class="sec">Ubah</p>
    ${syncNote}
    <div class="apply">
      <form class="edit" method="post" data-confirm="Setel stok ledger ${escape(product.sku)} menjadi {v}?">
        ${hidden}
        <input type="hidden" name="action" value="ledger">
        <input type="hidden" name="sku" value="${escape(product.sku)}">
        <label class="dr__lbl" for="qty">Stok ledger</label>
        <input id="qty" name="qty" type="number" min="0" step="1" inputmode="numeric"
          value="${ledgerRow ? ledgerRow.qty : ''}" placeholder="&mdash;">
        <button type="submit">Simpan</button>
      </form>
      ${entry ? `<form class="edit" method="post" data-confirm="Setel harga ${escape(product.sku)} menjadi Rp{v} di semua kanal?">
        ${hidden}
        <input type="hidden" name="action" value="price">
        <input type="hidden" name="sku" value="${escape(product.sku)}">
        <label class="dr__lbl" for="price">Harga</label>
        <input id="price" name="price" type="number" min="1" step="1" inputmode="numeric"
          value="${entry.tiktok?.price ?? entry.shopee?.price ?? ''}">
        <button type="submit">Setel di semua kanal</button>
      </form>` : '<span class="note">Belum tayang, harga tidak bisa disetel.</span>'}
    </div>
    <div class="foot"><span><a class="plink" href="?view=products">&larr; Kembali ke daftar produk</a></span></div>`;
}

/**
 * Shown when a print run was not complete.
 *
 * The PDF alone cannot say which parcels are missing from it, and a count in an HTTP
 * header is invisible to the person at the printer. This page names every order that did
 * not print and why, and still hands over the labels that did.
 */
export function renderLabelReport({ pageCount, requested, failures, pdfBase64, size }) {
  const rows = failures
    .map((f) => `<tr>
      <td class="mono nowrap">${escape(f.id)}</td>
      <td class="dim">${escape(f.channel)}</td>
      <td>${escape(f.reason)}</td>
    </tr>`)
    .join('');

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
iframe{width:100%;height:70vh;border:0;background:#fff;display:block}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style></head><body>
<div class="wrap">
  <h1>Hasil cetak label</h1>
  <p class="lead">
    <span class="count ok">${pageCount}</span> dari <span class="count">${requested}</span> label berhasil dibuat
    &middot; ukuran ${escape(size)}
  </p>

  <div class="bar">
    <button class="btn" id="print" type="button">Cetak ${pageCount} label</button>
    <a class="btn btn--ghost" id="dl" download="label-${escape(size)}.pdf">Unduh PDF</a>
    <a class="btn btn--ghost" href="/api/dashboard?view=labels">Kembali</a>
  </div>

  <div class="card">
    <p class="head"><span class="warn">${failures.length} pesanan tidak tercetak</span></p>
    <table>
      <thead><tr><th>Order ID</th><th>Kanal</th><th>Alasan</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="card">
    <p class="head">Pratinjau label</p>
    <iframe id="pdf" title="Label pengiriman"></iframe>
  </div>
</div>
<script>
(function () {
  // The PDF travels inline so this page needs no second request and no temporary file.
  var raw = atob(${JSON.stringify(pdfBase64)});
  var bytes = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));

  document.getElementById('pdf').src = url;
  document.getElementById('dl').href = url;
  document.getElementById('print').addEventListener('click', function () {
    var frame = document.getElementById('pdf');
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      window.open(url, '_blank');
    }
  });
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
