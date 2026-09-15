import { businessToday, zoneLabel, zoneName } from './clock.js';
import { CHANNELS, STAGES } from './omni.js';
import { PRESETS } from './range.js';
import { CHANNEL_LABEL } from './stock-sync.js';
import { labelReadiness } from './labels.js';
import { PRODUCTS, CATEGORIES, groupProducts, findProduct, isBundle, buildableFrom, unmapped } from './master.js';
import { pending, nextAction } from './fulfillment.js';
import { orderCode } from './mekari/prefix.js';
import { SOURCE_OPTIONS, SELLABLE } from './mekari/manual.js';
import { ageOf } from './mekari/heartbeat.js';

/** Server-rendered omnichannel dashboard. No secrets and no user input reach the markup unescaped. */

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const rupiah = (n) => 'Rp' + Math.round(n).toLocaleString('id-ID');
const compact = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1).replace('.0', '') + ' M'
  : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + ' jt'
  : n >= 1e3 ? Math.round(n / 1e3) + ' rb'
  : String(Math.round(n));

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

const dateTime = (epochSeconds) =>
  new Date(epochSeconds * 1000).toLocaleString('id-ID', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zoneName(),
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

const svg = (name, cls = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon[name]}</svg>`;


export const VIEWS = {
  orders: 'Pesanan', process: 'Proses', picklist: 'Picklist', labels: 'Label',
  stock: 'Stok', products: 'Produk', jurnal: 'Jurnal', forecast: 'Prakiraan',
};

function viewNav(current, rangeQuery) {
  return `<nav class="views" aria-label="Halaman">${Object.entries(VIEWS)
    .map(([id, label]) => {
      const query = id === 'products' ? `?view=${id}` : `?view=${id}${rangeQuery}`;
      return `<a class="viewtab ${id === current ? 'is-on' : ''}" href="${escape(query)}">${escape(label)}</a>`;
    })
    .join('')}</nav>`;
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

function kpiCard({ iconName, label, value, sub, tone = '' }) {
  return `<article class="kpi ${tone}">
    <span class="kpi__ico">${svg(iconName)}</span>
    <div class="kpi__body">
      <p class="kpi__label">${escape(label)}</p>
      <p class="kpi__value">${escape(value)}</p>
      <p class="kpi__sub">${sub}</p>
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
const AWAITING_AWB = new Set(['to_ship', 'shipping']);
/** Stages whose carrier waybill can exist; mirrors PRINTABLE_STAGES in labels.js. */
const PRINTABLE = new Set(['to_ship', 'shipping']);
/** Mirrors MAX_LABELS in api/labels.js; the button must not offer more than the server takes. */
const MAX_PRESELECT = 100;

function row(order) {
  const meta = CHANNELS[order.channel];
  const stage = STAGE_META[order.stage];
  const track = order.tracking
    ? `<span class="mono">${escape(order.tracking)}</span>`
    : AWAITING_AWB.has(order.stage)
      ? '<span class="await">menunggu</span>'
      : '<span class="dim">&mdash;</span>';
  return `<tr data-channel="${order.channel}" data-stage="${order.stage}" data-search="${escape((order.id + ' ' + order.buyer + ' ' + order.tracking).toLowerCase())}">
    <td><span class="tag" style="--accent:${meta.accent}">${escape(meta.label)}</span></td>
    <td class="mono nowrap">${escape(order.id)}</td>
    <td class="nowrap dim">${escape(dateTime(order.createdAt))}</td>
    <td>${escape(order.buyer) || '<span class="dim">&mdash;</span>'}</td>
    <td class="num mono">${escape(rupiah(order.total))}</td>
    <td><span class="pill pill--${stage.tone}">${escape(stage.label)}</span></td>
    <td class="nowrap dim">${escape(order.carrier) || '&mdash;'}</td>
    <td class="nowrap">${track}</td>
  </tr>`;
}

function shell({
  title, range, errors = {}, truncated = [], maxPerPlatform, shopeeShop, generatedAt,
  view, kpis = '', body = '', hideRangeControls = false, script = '', flash = null,
  stale = false, staleSince = null,
}) {
  const presetLink = (id) => `?view=${view}&preset=${id}`;
  const self = range.preset ? presetLink(range.preset) : `?view=${view}&from=${range.from}&to=${range.to}`;

  const windows = Object.entries(PRESETS)
    .map(([id, meta]) => `<a class="win ${id === range.preset ? 'is-on' : ''}" href="${escape(presetLink(id))}">${escape(meta.label)}</a>`)
    .join('');

  const notice = flash
    ? `<div class="alert ${flash.kind === 'error' ? '' : 'alert--ok'}">${svg(flash.kind === 'error' ? 'warn' : 'check')}<span>${escape(flash.text)}</span></div>`
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap">
<style>
/* --- Treelogy palette, taken from the live storefront (treelogy.com) rather than
   invented: #526547 sage is the brand primary, #2b3c35 the deep forest it sits on,
   #f8f8f2 the warm off-white, #108474 the teal accent. Inter is the storefront face. --- */
:root{
  --bg:#141A17; --panel:#1B2320; --panel-2:#222B27; --line:#2E3A34;
  --fg:#F1F3EE; --muted:#A7B3A6; --dim:#839187;
  --brand:#8FA97F; --brand-deep:#526547; --accent:#3FB8A4;
  --fill-a:#5E7352; --fill-b:#3C4C36;
  --good:#6FBF8B; --info:#5FB3C9; --warn:#E2B252; --act:#E2B252; --bad:#E08573; --done:#9D8FC4;
  --radius:14px;
  --shadow:0 1px 2px rgba(0,0,0,.35), 0 10px 28px -16px rgba(0,0,0,.6);
  /* power3.out from the motion doctrine: the house entrance curve. Smooth, never bouncy. */
  --ease-out:cubic-bezier(.25,1,.5,1);
  --ease-soft:cubic-bezier(.37,0,.63,1);
  --t-fast:160ms; --t-base:240ms; --t-slow:420ms;
  color-scheme:dark;
}
@media (prefers-color-scheme:light){
  :root:not([data-theme="dark"]){
    --bg:#F4F5F0; --panel:#FFFFFF; --panel-2:#F8F8F2; --line:#E1E4DA;
    --fg:#1E2A24; --muted:#57655A; --dim:#67776C;
    --brand:#526547; --brand-deep:#3C4C36; --accent:#0E7A6B;
    --fill-a:#526547; --fill-b:#3C4C36;
    --good:#2F7D4F; --info:#1C6E86; --warn:#8A5A12; --act:#8A5A12; --bad:#A8412E; --done:#5B4A93;
    --shadow:0 1px 2px rgba(43,60,53,.06), 0 10px 28px -18px rgba(43,60,53,.28);
    color-scheme:light;
  }
}
:root[data-theme="light"]{
  --bg:#F4F5F0; --panel:#FFFFFF; --panel-2:#F8F8F2; --line:#E1E4DA;
  --fg:#1E2A24; --muted:#57655A; --dim:#67776C;
  --brand:#526547; --brand-deep:#3C4C36; --accent:#0E7A6B;
  --fill-a:#526547; --fill-b:#3C4C36;
  --good:#2F7D4F; --info:#1C6E86; --warn:#8A5A12; --act:#8A5A12; --bad:#A8412E; --done:#5B4A93;
  --shadow:0 1px 2px rgba(43,60,53,.06), 0 10px 28px -18px rgba(43,60,53,.28);
  color-scheme:light;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:var(--bg); color:var(--fg); min-height:100vh; padding:1.25rem;
  font:400 15px/1.6 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1400px; margin:0 auto}
.mono{font-family:"Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.86em; font-variant-numeric:tabular-nums}
.dim{color:var(--dim)} .nowrap{white-space:nowrap} .num{text-align:right}
.ico{width:20px;height:20px;flex:none}

/* ---- header ---- */
.top{display:flex; flex-wrap:wrap; gap:1rem; align-items:center; justify-content:space-between; margin-bottom:1.5rem}
.brandline{display:flex; align-items:center; gap:.75rem; min-width:0}
.logo{width:38px;height:38px;border-radius:11px;flex:none;display:grid;place-items:center;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b)); color:#fff;
  font-weight:600; font-size:1rem; letter-spacing:-.01em;
  box-shadow:0 2px 10px -4px color-mix(in srgb,var(--brand) 60%,transparent)}
h1{font-size:1.15rem; margin:0; font-weight:600; letter-spacing:-.01em}
.sub{margin:.1rem 0 0; font-size:.8rem; color:var(--muted)}
.tools{display:flex; gap:.5rem; align-items:center}
.wins{display:flex; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:3px}
.win{padding:.35rem .7rem; border-radius:7px; font-size:.82rem; color:var(--muted); text-decoration:none;
  min-height:32px; display:flex; align-items:center; transition:background .2s,color .2s; cursor:pointer}
.win:hover{color:var(--fg); background:var(--panel-2)}
.win.is-on{background:color-mix(in srgb,var(--brand) 20%,transparent);
  color:color-mix(in srgb,var(--brand) 80%,#fff); font-weight:600}
@media (prefers-color-scheme:light){ :root:not([data-theme="dark"]) .win.is-on{color:var(--brand)} }
:root[data-theme="light"] .win.is-on{color:var(--brand)}
.iconbtn{width:38px;height:38px;border-radius:10px;border:1px solid var(--line);background:var(--panel);
  color:var(--muted); display:grid; place-items:center; cursor:pointer; transition:color var(--t-base) var(--ease-out),border-color var(--t-base) var(--ease-out)}
.iconbtn:hover{color:var(--fg); border-color:var(--brand)}
:where(a,button,input):focus-visible{outline:2px solid var(--brand); outline-offset:2px}

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

.views{display:flex; gap:.3rem; margin-bottom:1rem; border-bottom:1px solid var(--line); padding-bottom:.6rem}
.viewtab{padding:.45rem .9rem; border-radius:9px; font-size:.87rem; font-weight:500; text-decoration:none;
  color:var(--muted); transition:background var(--t-base) var(--ease-out),color var(--t-base) var(--ease-out)}
.viewtab:hover{color:var(--fg); background:var(--panel-2)}
.viewtab.is-on{color:var(--fg); background:var(--panel); border:1px solid var(--line);
  box-shadow:0 1px 0 var(--brand) inset, var(--shadow)}
.ok{color:var(--good)} .flag{color:var(--warn)} .stop{color:var(--bad)}
.note{font-size:.75rem; color:var(--muted)}
/* --- compact summary strip --- */
.strip{display:flex; align-items:center; gap:1.5rem; flex-wrap:wrap; padding:.85rem 1.1rem;
  background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  box-shadow:var(--shadow); margin-bottom:.85rem}
.strip__grow{flex:1}
.stat{display:flex; align-items:baseline; gap:.45rem; white-space:nowrap}
.stat__n{font-family:"Fira Code",ui-monospace,monospace; font-size:1.15rem; font-weight:600;
  font-variant-numeric:tabular-nums; letter-spacing:-.01em}
.stat__l{font-size:.76rem; color:var(--muted)}
.strip .search{min-width:170px}

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
  color:var(--fg); background:var(--panel-2); border:1px solid var(--line); border-radius:11px;
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
.wl__hint{margin:.2rem 0 0; font-size:.8rem; color:var(--muted)}
.wl__grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:.7rem; padding:0 1rem}

.wl__bar{display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; padding:0 1rem 1rem}
/* The commit button follows the list down the page - on a thirty-order day the action
   should never be something you have to scroll back to find. */
.wl__go{position:sticky; bottom:0; padding:1rem; margin-top:.5rem;
  background:linear-gradient(to top,var(--bg) 65%,transparent);
  display:flex; justify-content:center}
.wl__go .wo__go{max-width:24rem}

.wo{display:flex; align-items:flex-start; gap:.7rem; margin:0; padding:.85rem .9rem; cursor:pointer;
  background:var(--panel-2); border:1px solid var(--line); border-radius:12px;
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
.wl__note{padding:0 1rem 1rem; margin:-.5rem 0 0}
.wl__bar .chip b{margin-left:.25rem; font-weight:600; font-variant-numeric:tabular-nums}
.wo__in{display:flex; gap:.35rem}
.wo__in .trk{flex:1; width:auto; min-width:0}
.wo__in .trk--s{flex:0 0 6.5rem}
.wo__go{font:inherit; font-size:.86rem; font-weight:600; padding:.55rem; min-height:40px;
  width:100%; border-radius:9px; cursor:pointer; color:#fff; border:1px solid transparent;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b));
  transition:filter var(--t-base) var(--ease-out)}
.wo__go:hover{filter:brightness(1.12)}
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
.st{display:flex; flex-direction:column; gap:.5rem; padding:.85rem .9rem; border-radius:12px;
  background:var(--panel-2); border:1px solid var(--line);
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
  padding:.75rem 1rem; border:1px solid var(--line); border-radius:11px; background:var(--panel-2)}
.sync__txt{font-size:.86rem; flex:1; min-width:14rem}
.sync__d{font-size:.8rem}
.sync__d summary{cursor:pointer; color:var(--muted); list-style:none; padding:.3rem .6rem;
  border:1px solid var(--line); border-radius:8px; min-height:32px; display:inline-flex; align-items:center}
.sync__d summary:hover{color:var(--fg); border-color:var(--brand)}
.sync__d[open]{flex-basis:100%; order:9}
.sync__d[open] summary{margin-bottom:.6rem}
.sync__go{font:inherit; font-size:.85rem; font-weight:600; padding:.45rem 1rem; min-height:36px;
  border-radius:8px; cursor:pointer; color:#fff; border:1px solid transparent;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b)); transition:filter var(--t-base) var(--ease-out)}
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
.apply button{font:inherit; font-size:.85rem; font-weight:600; padding:.55rem 1.1rem; min-height:40px;
  border-radius:9px; cursor:pointer; color:#fff; border:1px solid transparent;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b)); transition:filter var(--t-base) var(--ease-out)}
.apply button:hover{filter:brightness(1.12)}
.apply button:disabled{opacity:.45; cursor:not-allowed; filter:none}
.pick,#head{width:17px; height:17px; cursor:pointer; accent-color:var(--brand)}
select.dr__in{width:auto; text-align:left; cursor:pointer}

.daterange{display:flex; align-items:center; gap:.4rem; background:var(--panel);
  border:1px solid var(--line); border-radius:10px; padding:3px 3px 3px .6rem; flex-wrap:wrap}
.dr__lbl{font-size:.78rem; color:var(--muted)}
.dr__in{font:inherit; font-size:.8rem; padding:.3rem .4rem; min-height:32px; border-radius:7px;
  border:1px solid transparent; background:var(--panel-2); color:var(--fg); color-scheme:inherit}
.dr__in:hover{border-color:var(--line)}
.dr__go{font:inherit; font-size:.8rem; font-weight:600; padding:.35rem .8rem; min-height:32px;
  border-radius:7px; cursor:pointer; border:1px solid color-mix(in srgb,var(--brand) 55%,transparent);
  background:color-mix(in srgb,var(--brand) 20%,transparent); color:var(--fg);
  transition:background .2s,border-color .2s}
.dr__go:hover{background:color-mix(in srgb,var(--brand) 32%,transparent)}

/* ---- kpi ---- */
.kpis{display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:.85rem; margin-bottom:.85rem}
.kpi{display:flex; gap:.85rem; padding:1.1rem; background:var(--panel); border:1px solid var(--line);
  border-radius:var(--radius); box-shadow:var(--shadow)}
.kpi__ico{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;flex:none;
  background:var(--panel-2); color:var(--brand)}
.kpi.is-act .kpi__ico{color:var(--act)}
.kpi__body{min-width:0}
.kpi__label{margin:0; font-size:.74rem; letter-spacing:.06em; text-transform:uppercase; color:var(--muted)}
.kpi__value{margin:.15rem 0; font-size:1.6rem; font-weight:600; letter-spacing:-.02em;
  font-family:"Fira Code",ui-monospace,monospace; font-variant-numeric:tabular-nums}
.kpi__sub{margin:0; font-size:.78rem; color:var(--dim)}

/* ---- channels ---- */
.chs{display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:.85rem; margin-bottom:1.5rem}
.ch{padding:1.1rem; background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
  box-shadow:var(--shadow); border-top:3px solid var(--accent)}
.ch__head{display:flex; align-items:center; gap:.5rem; margin-bottom:.5rem}
.ch__dot{width:9px;height:9px;border-radius:50%;background:var(--accent);flex:none}
.ch__head h3{margin:0; font-size:.95rem; font-weight:600; flex:1}
.ch__count{font-family:"Fira Code",monospace; font-size:.9rem; color:var(--muted)}
.ch__rev{margin:0 0 .75rem; font-size:1.35rem; font-weight:600; letter-spacing:-.02em;
  font-family:"Fira Code",monospace; font-variant-numeric:tabular-nums}
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
.panel{background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); overflow:hidden}
.filters{display:flex; flex-wrap:wrap; gap:.45rem; padding:1rem; border-bottom:1px solid var(--line); align-items:center}
.chip{font:inherit; font-size:.8rem; padding:.4rem .75rem; min-height:34px; border-radius:8px; cursor:pointer;
  border:1px solid var(--line); background:var(--panel-2); color:var(--muted); transition:color .2s,border-color .2s,background .2s}
.chip:hover{color:var(--fg); border-color:var(--chip,var(--brand))}
.chip.is-on{background:color-mix(in srgb,var(--chip,var(--brand)) 18%,transparent);
  border-color:color-mix(in srgb,var(--chip,var(--brand)) 55%,transparent); color:var(--fg); font-weight:600}
.chip b{font-weight:600}
.grow{flex:1}
.search{font:inherit; font-size:.85rem; padding:.45rem .75rem; min-height:34px; min-width:200px;
  border-radius:8px; border:1px solid var(--line); background:var(--panel-2); color:var(--fg)}
.search::placeholder{color:var(--dim)}
.scroll{overflow-x:auto}
table{width:100%; border-collapse:collapse; font-size:.88rem}
th{position:sticky; top:0; background:var(--panel-2); text-align:left; font-weight:500; font-size:.74rem;
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

/* ------------------------------------------------- transaksi manual ---------- */
/* A data-entry form, so it is built for one hand on the keyboard: every field is
   reachable by tab in reading order, the running total never leaves the screen, and the
   money columns are monospaced so a missing zero is visible rather than merely present. */
.mx{display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:1.1rem; align-items:start}
@media (max-width:900px){.mx{grid-template-columns:minmax(0,1fr)}}

.mx__side{position:sticky; top:1rem; display:flex; flex-direction:column; gap:.7rem}
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
.ln{display:grid; grid-template-columns:minmax(0,1fr) 68px 116px 116px 92px 36px; gap:.4rem; align-items:center;
  padding:.4rem 0; animation:rise 260ms var(--ease-out) both}
.ln + .ln{border-top:1px solid color-mix(in srgb,var(--line) 60%,transparent)}
.ln select,.ln input{width:100%; font:inherit; font-size:.82rem; padding:.42rem .5rem; min-height:38px;
  border-radius:8px; border:1px solid var(--line); background:var(--panel-2); color:var(--fg)}
.ln input[type="number"]{font-family:"Fira Code",ui-monospace,monospace; text-align:right}
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
  min-height:46px; border-radius:10px; cursor:pointer; border:0; background:var(--brand-deep); color:#F1F3EE;
  transition:filter var(--t-fast) var(--ease-out)}
.sum__go:hover:not(:disabled){filter:brightness(1.15)}
.sum__go:disabled{opacity:.45; cursor:not-allowed}
.sum__go:focus-visible{outline:2px solid var(--brand); outline-offset:2px}

/* ---------------------------------------------------- motion & loading -------- */
/* Entrances follow the motion doctrine: power3.out, no overshoot, and a stagger whose
   total stays under ~0.5s so an arrival reads as one beat rather than a queue. */
@keyframes rise{from{opacity:0; transform:translateY(10px)}to{opacity:1; transform:none}}
@keyframes sheen{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes breathe{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(0)}}

.strip,.chs,.panel,.cards,.scroll,.sync,.alert{animation:rise var(--t-slow) var(--ease-out) both}
.strip{animation-delay:0ms}
.chs,.sync{animation-delay:60ms}
.panel,.cards,.scroll{animation-delay:120ms}
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
  background:linear-gradient(90deg,var(--brand),var(--accent)); transform:translateX(-100%);
  opacity:0; transition:opacity var(--t-fast)}
#nav-progress.on{opacity:1; animation:sweep 9s var(--ease-soft) forwards}

#loader{position:fixed; inset:0; z-index:55; display:none; padding:1.25rem;
  background:color-mix(in srgb,var(--bg) 88%,transparent); backdrop-filter:blur(3px)}
#loader.on{display:block; animation:rise var(--t-base) var(--ease-out) both}
.sk{position:relative; overflow:hidden; border-radius:12px; background:var(--panel-2);
  border:1px solid var(--line)}
.sk::after{content:''; position:absolute; inset:0;
  background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--fg) 7%,transparent),transparent);
  animation:sheen 1.5s var(--ease-soft) infinite}
.sk--bar{height:56px; margin-bottom:.85rem}
.sk--grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:.7rem;
  background:none; border:0; overflow:visible}
.sk--grid>.sk{height:112px}
.loader__note{display:flex; align-items:center; gap:.6rem; justify-content:center;
  margin:1.25rem 0 .85rem; font-size:.86rem; color:var(--muted); animation:breathe 2.2s var(--ease-soft) infinite}
.loader__dot{width:7px; height:7px; border-radius:50%; background:var(--brand); flex:none}

@media (prefers-reduced-motion:reduce){
  *{transition:none !important; animation:none !important}
  #nav-progress.on{opacity:1; transform:translateX(-15%)}
  .sk::after{display:none}
}
</style>
</head><body>
<div id="nav-progress"></div>
<div id="loader" aria-hidden="true">
  <div class="wrap">
    <p class="loader__note"><span class="loader__dot"></span><span id="loader-text">Memuat…</span></p>
    <div class="sk sk--bar"></div>
    <div class="sk sk--grid"><div class="sk"></div><div class="sk"></div><div class="sk"></div>
      <div class="sk"></div><div class="sk"></div><div class="sk"></div></div>
  </div>
</div>
<div class="wrap">
  <header class="top">
    <div class="brandline">
      <span class="logo" aria-hidden="true">T</span>
      <div>
        <h1>${escape(title)}</h1>
        <p class="sub">${escape(shopeeShop?.shop_name ?? 'Treelogy Moringa')} &middot; ${escape(range.label)} &middot; diperbarui ${escape(new Date(generatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: zoneName() }))} ${zoneLabel()}</p>
      </div>
    </div>
    <div class="tools">
      ${rangeControls}
      <button class="iconbtn" id="theme" type="button" aria-label="Ganti tema terang/gelap">${svg('sun')}</button>
      <a class="iconbtn" href="${escape(self)}" aria-label="Muat ulang data">${svg('refresh')}</a>
      <a class="iconbtn" href="?logout=1" aria-label="Keluar">${svg('logout')}</a>
    </div>
  </header>

  ${problems}

  ${viewNav(view, rangeQuery(range))}

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

  // Confirm with the value that is actually about to be written, not a generic question.
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var field = form.querySelector('input[type="number"]');
      var value = field ? field.value : '';
      var text = form.dataset.confirm.replace('{v}', value);
      if (!window.confirm(text)) e.preventDefault();
    });
  });
})();
</script>
${script ? `<script>
${script}
</script>` : ''}
</body></html>`;
}

export function renderDashboard({ orders, summary, errors, range, truncated = [], maxPerPlatform, shopeeShop, generatedAt }) {
  const { all, byChannel } = summary;
  const inTransit = all.stages.shipping;
  const filters = [
    '<button class="chip is-on" data-filter="channel" data-value="all" type="button">Semua kanal</button>',
    ...Object.keys(CHANNELS).map(
      (id) => `<button class="chip" data-filter="channel" data-value="${id}" style="--chip:${CHANNELS[id].accent}" type="button">${escape(CHANNELS[id].label)}</button>`,
    ),
  ].join('');

  const stageChips = [
    '<button class="chip is-on" data-filter="stage" data-value="all" type="button">Semua status</button>',
    ...STAGES.filter((s) => all.stages[s] > 0).map(
      (s) => `<button class="chip" data-filter="stage" data-value="${s}" type="button">${escape(STAGE_META[s].label)} <b>${all.stages[s]}</b></button>`,
    ),
  ].join('');

  return shell({
    title: 'Omnichannel Orders',
    range, errors, truncated, maxPerPlatform, shopeeShop, generatedAt,
    view: 'orders',
    kpis: `<section class="kpis" aria-label="Ringkasan">
    ${kpiCard({ iconName: 'wallet', label: 'Omzet', value: rupiah(all.revenue), sub: `${compact(all.revenue)} &middot; tanpa order batal` })}
    ${kpiCard({ iconName: 'cube', label: 'Pesanan', value: String(all.count), sub: '3 kanal digabung' })}
    ${kpiCard({ iconName: 'bell', label: 'Perlu tindakan', value: String(all.actionable), sub: 'belum bayar + siap kirim', tone: all.actionable > 0 ? 'is-act' : '' })}
    ${kpiCard({ iconName: 'truck', label: 'Dalam pengiriman', value: String(inTransit), sub: 'sedang di kurir' })}
  </section>`,
    body: `<section class="chs" aria-label="Per kanal">
    ${Object.keys(CHANNELS).map((id) => channelCard(id, byChannel[id])).join('')}
  </section>

  <section class="panel" aria-label="Daftar pesanan">
    <div class="filters">
      ${filters}
      <span class="grow"></span>
      <input class="search" id="q" type="search" aria-label="Cari pesanan berdasarkan order ID, pembeli atau nomor resi" placeholder="Cari order ID, pembeli, resi..." autocomplete="off">
    </div>
    <div class="filters">${stageChips}</div>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Kanal</th><th>Order ID</th><th>Waktu</th><th>Pembeli</th>
          <th class="num">Total</th><th>Status</th><th>Kurir</th><th>Resi</th>
        </tr></thead>
        <tbody id="rows">${orders.map(row).join('')}</tbody>
      </table>
      <p class="empty" id="empty" hidden>Tidak ada pesanan yang cocok dengan filter.</p>
    </div>
    <div class="foot">
      <span id="shown">${orders.length} pesanan</span>
      <span>Waktu ditampilkan dalam WIB</span>
    </div>
  </section>`,
    script: `
(function () {
  var state = { channel: 'all', stage: 'all', q: '' };
  var rows = Array.prototype.slice.call(document.querySelectorAll('#rows tr'));
  var empty = document.getElementById('empty');
  var shown = document.getElementById('shown');

  function apply() {
    var n = 0;
    rows.forEach(function (tr) {
      var ok = (state.channel === 'all' || tr.dataset.channel === state.channel)
        && (state.stage === 'all' || tr.dataset.stage === state.stage)
        && (state.q === '' || tr.dataset.search.indexOf(state.q) !== -1);
      tr.hidden = !ok;
      if (ok) n++;
    });
    empty.hidden = n !== 0;
    shown.textContent = n + ' pesanan';
  }

  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var group = chip.dataset.filter;
      document.querySelectorAll('.chip[data-filter="' + group + '"]').forEach(function (c) {
        c.classList.toggle('is-on', c === chip);
      });
      state[group] = chip.dataset.value;
      apply();
    });
  });

  document.getElementById('q').addEventListener('input', function (e) {
    state.q = e.target.value.trim().toLowerCase();
    apply();
  });
})();
`,
  });
}




const rangeQuery = (range) =>
  range.preset ? `&preset=${range.preset}` : `&from=${range.from}&to=${range.to}`;


/**
 * The fulfillment queue: what still needs a human, and the one move that advances it.
 *
 * Each channel stalls at a different point, so grouping by the action rather than by
 * channel is what makes the page a worklist instead of a report. Actions run one at a
 * time on purpose - shipping cannot be undone from here.
 */
export function renderProcess({ orders, range, errors, shopeeShop, generatedAt, csrf, flash }) {
  const rows = pending(orders);
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
    tiktok_rts: {
      title: 'Tokopedia &amp; TikTok Shop',
      hint: 'Label bisa dicetak setelah pengiriman diatur',
    },
    shopee_ship: {
      title: 'Shopee',
      hint: 'Dokumen kurir dibuat setelah pengiriman diatur',
    },
  };

  // Waiting on the courier, not on us. Shown as a count so the page is not mistaken for
  // the whole picture, but never as a task.
  const waiting = orders.filter((o) => o.stage === 'to_ship' && !nextAction(o)).length;
  const moving = orders.filter((o) => o.stage === 'shipping').length;

  // A worklist, not a report: the action is the point, so each order is a card with the
  // button given real weight rather than a row whose primary control is the smallest
  // thing on screen. Raw platform statuses are dropped - the section heading already
  // says what is needed, and AWAITING_SHIPMENT means nothing to the person packing.
  // One form around everything, so the whole day's shipments go out on one click. Both
  // marketplace paths are handled server-side from the same selection - the operator
  // should not have to know that Shopee and TikTok batch differently.
  const card = ({ order: o }) => {
    const ch = CHANNELS[o.channel];
    return `<label class="wo" data-carrier="${escape(o.carrier || 'Belum ditentukan')}">
      <input class="wo__pick" type="checkbox" name="order" value="${escape(o.channel)}:${escape(o.id)}" checked
        aria-label="Pilih ${escape(o.id)}">
      <span class="wo__body">
        <span class="wo__top">
          <span class="tag" style="--accent:${ch.accent}">${escape(ch.label)}</span>
          <span class="wo__when">${escape(dateTime(o.createdAt))}</span>
        </span>
        <span class="wo__id mono">${escape(o.id)}</span>
        <span class="wo__who">
          <span>${escape(o.buyer) || '<span class="dim">tanpa nama</span>'}</span>
          <b class="mono">${escape(rupiah(o.total))}</b>
        </span>
        <span class="wo__car">${svg('truck')}${o.carrier
          ? escape(o.carrier)
          : '<span class="dim">kurir belum ditentukan</span>'}</span>
      </span>
    </label>`;
  };

  const section = (action, list) => {
    const meta = GROUPS[action];
    return `<section class="wl">
      <header class="wl__h">
        <h3>${meta.title}<span class="wl__n">${list.length}</span></h3>
        <p class="wl__hint">${meta.hint}</p>
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

  return shell({
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

  function sync() {
    var n = picks.filter(function (p) { return p.checked; }).length;
    counter.textContent = n;
    // Nothing selected means nothing to do; a live button would only produce an error.
    go.disabled = n === 0;
    form.dataset.confirm = 'Atur pengiriman untuk ' + n + ' pesanan sekaligus?';
  }
  function setAll(v) { picks.forEach(function (p) { p.checked = v; }); sync(); }

  picks.forEach(function (p) { p.addEventListener('change', sync); });
  document.getElementById('all').addEventListener('click', function () { setAll(true); });
  document.getElementById('none').addEventListener('click', function () { setAll(false); });

  // Selecting by courier rather than hiding by it: a dropoff run covers one courier, but
  // the rest of the day's orders should stay visible so nothing is forgotten.
  document.querySelectorAll('[data-carrier]').forEach(function (chip) {
    if (chip.tagName !== 'BUTTON') return;
    chip.addEventListener('click', function () {
      document.querySelectorAll('button[data-carrier]').forEach(function (c) {
        c.classList.toggle('is-on', c === chip);
      });
      var want = chip.dataset.carrier;
      picks.forEach(function (p) {
        var card = p.closest('.wo');
        p.checked = want === '' || card.dataset.carrier === want;
        card.classList.toggle('wo--dim', want !== '' && card.dataset.carrier !== want);
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
            <span class="strip__grow"></span>
            <button class="chip" type="button" id="all">Pilih semua</button>
            <button class="chip" type="button" id="none">Kosongkan</button>
          </div>
          <p class="wl__note note">Pengiriman tidak bisa dibatalkan dari sini. Menyaring kurir hanya mengubah yang tercentang, bukan yang ditampilkan.</p>
          ${sections}
          <div class="wl__go">
            <button class="wo__go" type="submit" id="go">Atur pengiriman <span id="n">${rows.length}</span> pesanan</button>
          </div>
        </form>`,
  });
}

/** Warehouse view: what to pick, biggest first, with the channel split for packing. */
export function renderPicklist({ picklist, range, errors, shopeeShop, generatedAt }) {
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

  return shell({
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
        <span class="strip__grow"></span>
        <span class="note">Hanya pesanan berbayar yang belum diserahkan ke kurir</span>
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
}) {
  const order = { synced: 0, queued: 1, broken: 2, skipped: 3 };
  const rows = [...overview.rows]
    .sort((a, b) => (order[a.state] - order[b.state]) || (b.order.createdAt - a.order.createdAt))
    .map((r) => {
      const meta = CHANNELS[r.order.channel];
      const state = JURNAL_STATE[r.state];
      return `<tr data-state="${r.state}">
        <td><span class="tag" style="--accent:${meta.accent}">${escape(meta.label)}</span></td>
        <td class="mono nowrap">${escape(orderCode(r.order))}</td>
        <td class="nowrap dim">${escape(dateTime(r.order.createdAt))}</td>
        <td class="num mono">${r.total ? escape(rupiah(r.total)) : '<span class="dim">&mdash;</span>'}</td>
        <td><span class="pill pill--${state.tone}">${escape(state.label)}</span></td>
        <td class="dim">${escape(r.reason ?? (r.invoiceId ? `faktur ${r.invoiceId}` : ''))}</td>
      </tr>`;
    })
    .join('');

  // The button is offered only when pressing it would actually work: the POST refuses
  // while MEKARI_SYNC_LIVE is off, and a control that always errors is worse than none.
  const canPost = configured && live && overview.queued > 0;

  return shell({
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
        <span class="note">${overview.ledgerTotal} faktur tercatat seluruhnya${
          depositTo ? ` &middot; lunas ke ${escape(depositTo)}` : ' &middot; faktur dibiarkan terbuka'}</span>
        <a class="chip" href="?view=jurnal&amp;add=1">${svg('plus')}Tambah transaksi</a>
      </div>`,
    body: `
      ${configured ? '' : '<div class="alert">' + svg('warn') + '<span>Kredensial Mekari belum diisi, jadi tidak ada yang bisa dikirim.</span></div>'}
      <div class="alert ${live ? 'alert--ok' : 'alert--soft'}">
        ${svg(live ? 'check' : 'warn')}
        <span>${live
          ? 'Sinkronisasi <b>real-time aktif</b> &mdash; tiap pesanan berbayar didorong platform ke Jurnal saat itu juga. Daftar di bawah adalah jaring pengaman: apa pun yang terlewat muncul sebagai <b>antre</b>.'
          : 'Sinkronisasi <b>belum aktif</b>. Setel <span class="mono">MEKARI_SYNC_LIVE=1</span> untuk menyalakannya; sampai itu webhook tetap diterima tapi tidak menulis apa pun.'}</span>
      </div>
      ${syncHealth(heartbeat, generatedAt)}
      ${canPost ? `<form method="post" data-confirm="Kirim ${overview.queued} faktur senilai ${escape(rupiah(overview.queuedValue))} ke Mekari Jurnal?">
        <input type="hidden" name="csrf" value="${escape(csrf)}">
        <input type="hidden" name="view" value="jurnal">
        <input type="hidden" name="action" value="mekari_sync">
        <div class="apply">
          <button type="submit">Kirim ${overview.queued} faktur sekarang</button>
          <span class="note">Untuk pesanan yang webhook-nya terlewat. Faktur yang sudah ada tidak akan dibuat dua kali.</span>
        </div>
      </form>` : ''}
      ${rows
        ? `<div class="scroll"><table class="dense">
            <thead><tr>
              <th>Kanal</th><th>Kode</th><th>Tanggal</th><th class="num">Nilai</th><th>Status</th><th>Catatan</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <div class="foot"><span>${overview.rows.length} pesanan pada rentang ini</span></div>`
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
  live, depositTo, existingCodes = [], images = {},
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
  const productOptions = [...byCategory.entries()]
    .map(([category, items]) => `<optgroup label="${escape(CATEGORIES[category] ?? category)}">${
      items.map((p) => `<option value="${escape(p.sku)}">${escape(p.name)}</option>`).join('')
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
      <input type="number" name="unitDiscount" value="0" min="0" step="1" inputmode="numeric" aria-label="Diskon satuan">
      <span class="ln__t" data-line-total>&mdash;</span>
      <button class="ln__x" type="button" data-remove aria-label="Hapus baris ${index + 1}">&times;</button>
    </div>`;

  return shell({
    title: 'Transaksi manual',
    range,
    errors,
    shopeeShop,
    generatedAt,
    view: 'jurnal',
    flash,
    hideRangeControls: true,
    kpis: `
      <div class="strip">
        <span class="note">Untuk penjualan yang tidak lewat marketplace. Tersimpan sebagai faktur Jurnal yang sama persis dengan pesanan online.</span>
        <span class="strip__grow"></span>
        <a class="chip" href="?view=jurnal">&larr; Kembali ke Jurnal</a>
      </div>`,
    body: `
      ${live ? '' : `<div class="alert alert--soft">${svg('warn')}<span>Sinkronisasi belum aktif &mdash; transaksi akan dihitung dan diperiksa, tapi belum dikirim ke Jurnal sampai <span class="mono">MEKARI_SYNC_LIVE=1</span> disetel.</span></div>`}
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
                  <span class="fld__hint" data-code-hint>Otomatis dari sumber dan tanggal. Boleh diubah.</span>
                </div>
                <div class="fld">
                  <label for="date">Tanggal</label>
                  <input id="date" name="date" type="date" value="${escape(today)}" max="${escape(today)}" required>
                </div>
                <div class="fld">
                  <label for="customer">Pelanggan</label>
                  <input id="customer" name="customer" list="mxcontacts" maxlength="120"
                         placeholder="${escape(chosen.label)}" data-customer>
                  <span class="fld__hint">Dibuat otomatis di Jurnal kalau belum ada.</span>
                </div>
                <div class="fld">
                  <label for="shipping">Ongkir</label>
                  <input id="shipping" name="shipping" type="number" value="0" min="0" step="1" inputmode="numeric">
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
              <p class="fld__hint" style="margin:.6rem 0 0">${
                depositTo
                  ? `Ditandai lunas ke <b>${escape(depositTo)}</b>.`
                  : 'Faktur dibiarkan terbuka sebagai piutang.'
              }</p>
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
  var customer = form.querySelector('[data-customer]');
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
  var num = function (el) { var v = Number(el && el.value); return isFinite(v) ? v : 0; };

  function source() {
    var picked = form.querySelector('input[name="source"]:checked');
    return picked || form.querySelector('input[name="source"]');
  }

  function suggest() {
    var prefix = source().value;
    var d = (dateField.value || '').replace(/-/g, '').slice(2);
    var stem = prefix + '-' + d + '-';
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
      var disc = num(row.querySelector('[name="unitDiscount"]'));
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
  form.addEventListener('change', function (e) {
    if (e.target.name === 'sku') showPicture(e.target.closest('[data-row]'));
    if (e.target.name === 'source') {
      customer.placeholder = e.target.dataset.label;
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
export function renderForecast({ forecast, range, errors, shopeeShop, generatedAt, csrf, flash }) {
  if (!forecast) {
    return shell({
      title: 'Prakiraan stok', range, errors, shopeeShop, generatedAt, view: 'forecast', flash,
      hideRangeControls: true,
      body: `<p class="empty">Belum ada prakiraan. Jalankan <span class="mono">npm run forecast</span> di server, atau tunggu tugas harian jam 02.30 WIB.</p>`,
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

  return shell({
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

/**
 * Label view: pick the parcels to print, get one PDF sized for the thermal printer.
 *
 * Orders are pre-selected because printing every waiting label is the normal action;
 * unticking is the exception. The form posts to a separate endpoint that streams the PDF
 * straight into the browser's print preview.
 */
export function renderLabels({ orders, range, errors, shopeeShop, generatedAt, csrf, flash, sizes, defaultSize, showReprints = false }) {
  // The list shows only what actually needs printing today, so everything on screen is
  // ticked and everything ticked will print. Reprints of parcels the courier already
  // took are a deliberate detour, not clutter in the daily view.
  const assessed = orders.map((o) => ({ order: o, readiness: labelReadiness(o) }));

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
      const meta = CHANNELS[o.channel];
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
          <span class="pick__s">${escape(dateTime(o.createdAt))} &middot; ${escape(o.carrier) || 'kurir belum ada'}</span>
        </td>
        <td class="nowrap">${escape(o.buyer) || '<span class="dim">&mdash;</span>'}</td>
        <td class="nowrap"><span class="${READY_TONE[readiness.state]}">${escape(readiness.note)}</span></td>
      </tr>`;
    })
    .join('');



  const sizeOptions = Object.entries(sizes)
    .map(([id, meta]) => `<option value="${escape(id)}" ${id === defaultSize ? 'selected' : ''}>${escape(meta.label)}</option>`)
    .join('');

  return shell({
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
          : 'Semua label sudah dicetak. Tidak ada pesanan yang menunggu.'}</p>
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
            <button class="chip" type="button" id="all">Pilih semua</button>
            <button class="chip" type="button" id="none">Kosongkan</button>
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
            <span class="note">${showReprints
              ? 'Cetak ulang label pesanan yang sudah diambil kurir.'
              : 'Semua yang tampil di sini perlu dicetak dan siap dicetak.'} Maksimal ${MAX_PRESELECT} sekali cetak.</span>
          </div>
        </form>`,
    script: `
(function () {
  var picks = Array.prototype.slice.call(document.querySelectorAll('.pick'));
  var counter = document.getElementById('n');
  var head = document.getElementById('head');
  if (!picks.length) return;

  function sync() {
    var n = picks.filter(function (p) { return p.checked; }).length;
    counter.textContent = n;
    head.checked = n === picks.length;
    head.indeterminate = n > 0 && n < picks.length;
  }
  function setAll(value) { picks.forEach(function (p) { p.checked = value; }); sync(); }

  picks.forEach(function (p) { p.addEventListener('change', sync); });
  head.addEventListener('change', function () { setAll(head.checked); });
  document.getElementById('all').addEventListener('click', function () { setAll(true); });
  document.getElementById('none').addEventListener('click', function () { setAll(false); });
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
export function renderStock({ catalog, ledger, plan, errors, range, shopeeShop, generatedAt, csrf, flash, filter = 'all' }) {
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

  return shell({
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
export function renderProducts({ catalog, ledger, plan, errors, range, shopeeShop, generatedAt, csrf, flash, selected, images = {} }) {
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
    return shell({
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

  return shell({
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
        <span class="fld__hint">Gambar dari Shopify (${escape(picture.source === 'variant' ? 'varian' : 'produk')}), juga terpasang di Jurnal.</span>
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<style>
/* Same Treelogy tokens as the dashboard - the sign-in screen is the first impression
   of the brand, so it cannot be the one page still wearing the old palette. */
:root{--bg:#141A17;--panel:#1B2320;--panel-2:#222B27;--line:#2E3A34;--fg:#F1F3EE;
  --muted:#A7B3A6;--dim:#839187;--brand:#8FA97F;--fill-a:#5E7352;--fill-b:#3C4C36;
  --bad:#E08573;--ease-out:cubic-bezier(.25,1,.5,1);color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#F4F5F0;--panel:#FFF;--panel-2:#F8F8F2;--line:#E1E4DA;
  --fg:#1E2A24;--muted:#57655A;--dim:#67776C;--brand:#526547;--fill-a:#526547;--fill-b:#3C4C36;
  --bad:#A8412E;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:var(--bg);color:var(--fg);
  font:400 15px/1.6 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.card{width:100%;max-width:24rem;padding:2.25rem;background:var(--panel);border:1px solid var(--line);
  border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.3),0 20px 40px -24px rgba(0,0,0,.5);
  animation:rise 420ms var(--ease-out) both}
.mark{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;margin:0 auto 1.1rem;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b));color:#fff}
.mark svg{width:22px;height:22px}
h1{margin:0 0 .3rem;font-size:1.1rem;font-weight:600;text-align:center;letter-spacing:-.01em}
p.lead{margin:0 0 1.5rem;font-size:.85rem;color:var(--muted);text-align:center}
label{display:block;font-size:.78rem;color:var(--muted);margin-bottom:.4rem}
input{width:100%;font:inherit;font-size:.92rem;padding:.7rem .85rem;min-height:44px;border-radius:10px;
  border:1px solid var(--line);background:var(--panel-2);color:var(--fg)}
input:focus-visible{outline:2px solid var(--brand);outline-offset:1px;border-color:transparent}
button{width:100%;margin-top:1rem;font:inherit;font-size:.92rem;font-weight:600;padding:.7rem;min-height:44px;
  border-radius:10px;cursor:pointer;color:#fff;border:1px solid transparent;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b));transition:filter var(--t-base) var(--ease-out)}
button:hover{filter:brightness(1.12)}
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
  <p class="lead">Tokopedia &middot; TikTok Shop &middot; Shopee</p>
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
  <p class="hint">Sesi berlaku 12 jam di perangkat ini.</p>
</main>
</body></html>`;
}

export const dashboardError = (heading, detail) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(heading)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0E14;color:#E8ECF4;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:1.5rem}
.c{max-width:30rem;padding:2rem;border:1px solid #232937;border-radius:14px;background:#12161F;text-align:center}
h1{font-size:1.1rem;margin:0 0 .5rem}p{margin:0;color:#94A3B8;font-size:.9rem}</style>
<div class="c"><h1>${escape(heading)}</h1><p>${escape(detail)}</p></div>`;
