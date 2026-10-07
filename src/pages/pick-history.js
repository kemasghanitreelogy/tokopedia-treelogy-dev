import { shell, svg, escape } from '../dashboard-page.js';
import { findProduct } from '../master.js';
import { channelMeta } from '../omni.js';
import { orderCode } from '../mekari/prefix.js';

/**
 * Riwayat picklist: every confirmation, by day.
 *
 * Read from the warehouse document's own history, written in the same transaction that
 * took the goods off the shelf - so a run listed here is exactly what left, no more and no
 * less. The day is the house day (WIB), the one the bench works by.
 */

const WIB = 7 * 3600;
const dayOf = (at) => new Date((at + WIB) * 1000).toISOString().slice(0, 10);
const clock = (at) => new Date((at + WIB) * 1000).toISOString().slice(11, 16).replace(':', '.');
const fmt = (n) => Number(n ?? 0).toLocaleString('id-ID');
const longDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const shift = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const initials = (name) => String(name || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const splitKey = (key) => { const i = key.indexOf('|'); return { channel: key.slice(0, i), id: key.slice(i + 1) }; };
const codeOf = ({ channel, id }) => (channel === 'shopify' || channel === 'manual' ? id : orderCode({ channel, id }));

export function renderPickHistory({ warehouse, images = {}, date = '', user = null, csrf = null, flash = null, ...common }) {
  const runs = [...(warehouse?.picks ?? [])].sort((a, b) => b.at - a.at);
  const today = dayOf(Math.floor(Date.now() / 1000));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today;
  const ofDay = runs.filter((r) => dayOf(r.at) === day);

  // Days that have runs, newest first, for the quick chips.
  const perDay = new Map();
  for (const r of runs) {
    const d = dayOf(r.at);
    const cur = perDay.get(d) ?? { runs: 0, orders: 0 };
    perDay.set(d, { runs: cur.runs + 1, orders: cur.orders + r.orders.length });
  }

  const photo = (sku) => {
    const p = findProduct(sku);
    const hit = images[sku] ?? (p && images[p.sku]) ?? (p?.components ?? []).map((c) => images[c.sku] ?? images[findProduct(c.sku)?.sku]).find(Boolean);
    return hit?.thumb || hit?.url || '';
  };
  const thumb = (sku, cls) => {
    const src = photo(sku);
    const name = findProduct(sku)?.name ?? sku;
    return src ? `<img class="${cls}" src="${escape(src)}" alt="${escape(name)}" loading="lazy" decoding="async">` : `<span class="${cls} ${cls}--none" aria-hidden="true">${svg('cube')}</span>`;
  };
  const nameOf = (sku) => {
    const p = findProduct(sku);
    return p ? `${escape(p.name)}${p.variant ? ` <span class="note">${escape(p.variant)}</span>` : ''}` : escape(sku);
  };
  const tag = (channel) => {
    const meta = channelMeta(channel);
    return `<span class="tag" style="--accent:${meta.accent}">${escape(meta.label)}</span>`;
  };

  const dayOrders = ofDay.reduce((n, r) => n + r.orders.length, 0);
  const dayUnits = ofDay.reduce((n, r) => n + r.orders.reduce((m, o) => m + (o.units ?? 0), 0), 0);

  const card = (run, open) => {
    const units = run.orders.reduce((n, o) => n + (o.units ?? 0), 0);
    // What the run picked, per product, biggest first: the line a picker checks against.
    const bySku = new Map();
    for (const o of run.orders) for (const [sku, q] of Object.entries(o.lines ?? {})) {
      const master = findProduct(sku)?.sku ?? sku;
      bySku.set(master, (bySku.get(master) ?? 0) + q);
    }
    const products = [...bySku.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return `<details class="ph__run"${open ? ' open' : ''}>
      <summary class="ph__sum">
        <span class="ph__time mono">${clock(run.at)}</span>
        <span class="ph__who"><span class="ph__av" aria-hidden="true">${escape(initials(run.by))}</span><span>${escape(run.by || 'tanpa nama')}</span></span>
        <span class="ph__grow"></span>
        <span class="ph__pill"><b class="mono">${fmt(run.orders.length)}</b> pesanan</span>
        <span class="ph__pill"><b class="mono">${fmt(units)}</b> unit</span>
        <span class="ph__chev" aria-hidden="true">${svg('chevR')}</span>
      </summary>
      <div class="ph__body">
        <section class="ph__col">
          <h3 class="ph__h">Produk <span>${products.length}</span></h3>
          <ul class="ph__prods">${products.map(([sku, q]) => `<li>${thumb(sku, 'ph__img')}<b class="mono">${fmt(q)}×</b><span class="ph__pn">${nameOf(sku)}<span class="mono dim">${escape(sku)}</span></span></li>`).join('')}</ul>
        </section>
        <section class="ph__col">
          <h3 class="ph__h">Pesanan <span>${run.orders.length}</span></h3>
          <ul class="ph__orders">${run.orders.map((o) => {
            const k = splitKey(o.key);
            return `<li><div class="ph__oh">${tag(k.channel)}<span class="mono ph__code">${escape(codeOf(k))}</span><span class="ph__grow"></span><span class="dim mono">${fmt(o.units)} unit</span></div>
              <div class="ph__ol">${Object.entries(o.lines ?? {}).map(([sku, q]) => `<span class="ph__line">${thumb(sku, 'ph__mini')}<b class="mono">${fmt(q)}×</b> ${nameOf(sku)}</span>`).join('') || '<span class="dim">isi tidak tercatat</span>'}</div></li>`;
          }).join('')}</ul>
        </section>
      </div>
    </details>`;
  };

  const chips = [...perDay.entries()].slice(0, 14).map(([d, v]) =>
    `<a class="ph__chip${d === day ? ' is-on' : ''}" href="?view=picklist&amp;history=1&amp;date=${d}"${d === day ? ' aria-current="date"' : ''}><span>${escape(d === today ? 'Hari ini' : shortDay(d))}</span><b class="mono">${fmt(v.orders)}</b></a>`).join('');

  const kpis = `<section class="strip" aria-label="Ringkasan hari ini">
    <span class="stat"><span class="stat__n">${fmt(ofDay.length)}</span><span class="stat__l">konfirmasi</span></span>
    <span class="stat"><span class="stat__n">${fmt(dayOrders)}</span><span class="stat__l">pesanan</span></span>
    <span class="stat"><span class="stat__n">${fmt(dayUnits)}</span><span class="stat__l">unit keluar</span></span>
    <span class="strip__grow"></span>
    <a class="ph__back" href="?view=picklist">${svg('chevL')}<span>Kembali ke picklist</span></a>
  </section>`;

  const body = `<div class="ph">
    <form class="ph__bar" method="get" role="search" aria-label="Pilih tanggal">
      <input type="hidden" name="view" value="picklist"><input type="hidden" name="history" value="1">
      <a class="ph__nav" href="?view=picklist&amp;history=1&amp;date=${shift(day, -1)}" aria-label="Hari sebelumnya">${svg('chevL')}</a>
      <label class="ph__date"><span class="visually-hidden">Tanggal</span><input type="date" name="date" value="${day}" max="${today}" data-autosubmit></label>
      <a class="ph__nav${day >= today ? ' is-off' : ''}" href="?view=picklist&amp;history=1&amp;date=${shift(day, 1)}" aria-label="Hari berikutnya"${day >= today ? ' aria-disabled="true" tabindex="-1"' : ''}>${svg('chevR')}</a>
      <h2 class="ph__day">${escape(longDay(day))}</h2>
      ${day !== today ? `<a class="ph__today" href="?view=picklist&amp;history=1">Hari ini</a>` : ''}
    </form>
    ${chips ? `<nav class="ph__chips" aria-label="Hari dengan konfirmasi">${chips}</nav>` : ''}
    ${ofDay.length
      ? `<div class="ph__runs">${ofDay.map((r, i) => card(r, i === 0)).join('')}</div>`
      : `<div class="ph__empty">${svg('history')}<p>Tidak ada konfirmasi picklist pada tanggal ini.</p>${perDay.size ? '<span>Pilih tanggal lain di atas.</span>' : ''}</div>`}
  </div>`;

  return shell({ ...common, user, csrf, flash, kpis, body, title: 'Riwayat picklist', view: 'picklist', scope: `riwayat ${shortDay(day)}`, hideRangeControls: true, style: STYLE, script: SCRIPT });
}

const STYLE = `
.ph{padding:1rem; display:flex; flex-direction:column; gap:1rem}
.ph__back{display:inline-flex; align-items:center; gap:.35rem; font-size:.82rem; min-height:40px; padding:.35rem .9rem; border-radius:999px; border:1px solid var(--line); color:var(--fg); text-decoration:none}
.ph__back:hover{border-color:var(--brand); color:var(--brand)}
.ph__back .ico{width:15px; height:15px}
.ph__bar{display:flex; align-items:center; gap:.5rem; flex-wrap:wrap}
.ph__nav{display:inline-grid; place-items:center; width:42px; height:42px; border-radius:12px; border:1px solid var(--line); color:var(--fg); background:var(--panel)}
.ph__nav:hover{border-color:var(--brand); color:var(--brand)}
.ph__nav.is-off{opacity:.35; pointer-events:none}
.ph__nav .ico{width:18px; height:18px}
.ph__date input{font:inherit; font-size:.9rem; color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:.5rem .75rem; min-height:42px; color-scheme:dark light; cursor:pointer}
.ph__date input:focus-visible, .ph__nav:focus-visible, .ph__chip:focus-visible, .ph__sum:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.ph__day{margin:0 0 0 .4rem; font-size:1.05rem; font-weight:600}
.ph__today{font-size:.8rem; color:var(--brand); margin-left:.3rem}
.ph__chips{display:flex; gap:.4rem; overflow-x:auto; padding-bottom:.2rem; scrollbar-width:thin}
.ph__chip{flex:none; display:inline-flex; align-items:center; gap:.5rem; font-size:.8rem; min-height:38px; padding:.3rem .85rem; border-radius:999px; border:1px solid var(--line); color:var(--muted); text-decoration:none; background:var(--panel); transition:border-color .15s, color .15s}
.ph__chip b{font-size:.74rem; color:var(--fg); padding:.05rem .45rem; border-radius:999px; background:color-mix(in srgb, var(--fg) 8%, transparent)}
.ph__chip:hover{color:var(--fg); border-color:var(--brand)}
.ph__chip.is-on{background:var(--brand); border-color:var(--brand); color:var(--bg); font-weight:600}
.ph__chip.is-on b{background:color-mix(in srgb, var(--bg) 18%, transparent); color:var(--bg)}
.ph__runs{display:flex; flex-direction:column; gap:.75rem}
.ph__run{border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); overflow:hidden}
.ph__run[open]{border-color:color-mix(in srgb, var(--brand) 40%, var(--line))}
.ph__sum{display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; padding:.85rem 1.1rem; cursor:pointer; list-style:none; min-height:56px}
.ph__sum::-webkit-details-marker{display:none}
.ph__sum:hover{background:color-mix(in srgb, var(--fg) 3%, transparent)}
.ph__time{font-size:1.25rem; font-weight:600; min-width:3.6rem}
.ph__who{display:inline-flex; align-items:center; gap:.5rem; font-size:.88rem}
.ph__av{display:inline-grid; place-items:center; width:30px; height:30px; border-radius:50%; font-size:.68rem; font-weight:700; color:var(--bg); background:var(--brand)}
.ph__grow{flex:1}
.ph__pill{font-size:.8rem; color:var(--muted); padding:.2rem .65rem; border-radius:999px; border:1px solid var(--line)}
.ph__pill b{color:var(--fg)}
.ph__chev{display:inline-grid; place-items:center; color:var(--dim); transition:transform .2s}
.ph__chev .ico{width:16px; height:16px}
.ph__run[open] .ph__chev{transform:rotate(90deg)}
.ph__body{display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.3fr); gap:1.25rem; padding:.25rem 1.1rem 1.1rem; border-top:1px solid var(--line)}
.ph__h{display:flex; gap:.45rem; align-items:baseline; margin:.85rem 0 .6rem; font-size:.7rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted)}
.ph__h span{opacity:.6; letter-spacing:0}
.ph__prods, .ph__orders{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:.5rem}
.ph__prods li{display:grid; grid-template-columns:48px 2.6rem minmax(0,1fr); gap:.6rem; align-items:center}
.ph__prods b{font-size:1.1rem; text-align:right}
.ph__pn{display:flex; flex-direction:column; font-size:.86rem; line-height:1.35; min-width:0}
.ph__pn .mono{font-size:.7rem}
.ph__img, .ph__mini{flex:none; object-fit:cover; background:#fff; border:1px solid var(--line)}
.ph__img{width:48px; height:48px; border-radius:10px}
.ph__mini{width:28px; height:28px; border-radius:7px}
.ph__img--none, .ph__mini--none{display:inline-grid; place-items:center; background:var(--panel-2); color:var(--dim)}
.ph__img--none .ico{width:20px; height:20px} .ph__mini--none .ico{width:14px; height:14px}
.ph__orders li{padding:.6rem .7rem; border-radius:var(--radius-s); background:var(--panel-2); border:1px solid var(--line); display:flex; flex-direction:column; gap:.45rem}
.ph__oh{display:flex; align-items:center; gap:.5rem; font-size:.8rem}
.ph__code{font-weight:600; font-size:.82rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0}
.ph__oh .dim{white-space:nowrap}
.ph__ol{display:flex; flex-direction:column; gap:.3rem}
.ph__line{display:flex; align-items:center; gap:.45rem; font-size:.82rem}
.ph__empty{display:flex; flex-direction:column; align-items:center; gap:.4rem; padding:3rem 1rem; color:var(--muted); text-align:center; border:1px dashed var(--line); border-radius:var(--radius)}
.ph__empty .ico{width:28px; height:28px; color:var(--dim)}
.ph__empty p{margin:0; font-size:.92rem}
.ph__empty span{font-size:.8rem; color:var(--dim)}
@media (max-width:860px){.ph__body{grid-template-columns:minmax(0,1fr)}}
@media (max-width:700px){
  .ph__day{flex-basis:100%; margin:.2rem 0 0}
  .ph__sum{gap:.5rem}
  .ph__grow{flex-basis:100%; height:0}
  .strip:has(.ph__back){display:grid; grid-template-columns:1fr 1fr 1fr; gap:.6rem}
  .strip:has(.ph__back) .stat{border:0; padding:0}
  .strip:has(.ph__back) .strip__grow{display:none}
  .strip:has(.ph__back) .ph__back{grid-column:1/-1; justify-content:center}
}
@media (prefers-reduced-motion:reduce){.ph *{transition:none !important}}
`;

const SCRIPT = `
(function () {
  // Picking a date in the calendar goes there at once.
  document.querySelectorAll('[data-autosubmit]').forEach(function (input) {
    input.addEventListener('change', function () { if (input.value) input.form.submit(); });
  });
})();
`;
