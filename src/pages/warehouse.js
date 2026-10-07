import { randomUUID } from 'node:crypto';
import { shell, svg, escape } from '../dashboard-page.js';
import { PRODUCTS, familyOf } from '../master.js';
import { GROUPS, makeable, recipeOf, verifyWarehouse } from '../warehouse.js';

/**
 * The Stok tab: the real warehouse, item by item.
 *
 * Migrated from the "Inventory Movement App" sheet. It shows jars, bowls and boxes on the
 * shelf - never the marketplace figures, which live on the products page and are display
 * numbers - and writing here never reaches a channel. Three parts, in the order a person
 * at the shelf asks them: what is there, what that lets us send, what moved.
 */

const fmt = (n) => Number(n ?? 0).toLocaleString('id-ID');
const when = (at) => (at
  ? new Date(at * 1000).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })
  : '');
// One colour per shelf group, used on the shelf and on the parts of each product.
const TONE = { goods: 'g-goods', set: 'g-set', pack: 'g-pack' };
const KIND = {
  opening: ['Saldo awal', 'k-open'], order: ['Pesanan', 'k-order'], return: ['Kembali', 'k-back'],
  in: ['Masuk', 'k-in'], out: ['Keluar', 'k-out'], count: ['Opname', 'k-count'],
};

export function renderWarehouse({ warehouse, csrf, flash, user, item = '', kind = '', ...common }) {
  const items = warehouse.items ?? {};
  const moves = [...(warehouse.moves ?? [])].reverse();
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const isToday = (at) => new Date(at * 1000 + 7 * 3600_000).toISOString().slice(0, 10) === today;
  const units = Object.values(items).reduce((n, i) => n + Math.max(0, i.qty), 0);

  const kpis = `<section class="strip" aria-label="Ringkasan gudang">
    <span class="stat"><span class="stat__n">${fmt(Object.keys(items).length)}</span><span class="stat__l">barang</span></span>
    <span class="stat"><span class="stat__n">${fmt(units)}</span><span class="stat__l">unit di rak</span></span>
    <span class="stat"><span class="stat__n">${fmt(moves.filter((m) => isToday(m.at) && m.kind !== 'opening').length)}</span><span class="stat__l">gerakan hari ini</span></span>
    <span class="stat"><span class="stat__n">${fmt(new Set(moves.filter((m) => isToday(m.at) && m.kind === 'order').map((m) => m.ref)).size)}</span><span class="stat__l">pesanan keluar hari ini</span></span>
    <span class="strip__grow"></span>
    ${(() => {
      // Proved on every render: each quantity is exactly the sum of its movements.
      const drift = verifyWarehouse(warehouse);
      return drift.length
        ? `<span class="wh__ok wh__ok--bad" role="status">${svg('warn')}<span>${drift.length} barang tidak seimbang dengan riwayatnya</span></span>`
        : `<span class="wh__ok" title="Setiap jumlah sama persis dengan saldo awal ditambah semua gerakannya">${svg('check2')}<span>Seimbang dengan riwayat</span></span>`;
    })()}
    <input class="search" id="wq" type="search" aria-label="Cari barang" placeholder="Cari kode atau nama barang…" autocomplete="off">
  </section>`;

  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="view" value="stock"><input type="hidden" name="back" value="?view=stock">`;
  const row = (code, it, top) => {
    // Bar length is relative to the fullest item in the same group, on a square-root scale
    // so a 7.473 mailerbox does not flatten every other bar to nothing.
    const level = top > 0 ? Math.round(Math.sqrt(Math.max(0, it.qty) / top) * 100) : 0;
    return `<li class="wh__row ${TONE[it.group ?? 'pack'] ?? ''}" data-code="${escape(code)}" data-text="${escape(`${code} ${it.name}`.toLowerCase())}">
      <span class="wh__code mono">${escape(code)}</span>
      <span class="wh__name"><span class="wh__nm">${escape(it.name)}</span><span class="wh__bar" aria-hidden="true"><i style="width:${level}%"></i></span></span>
      <span class="wh__qty"><b class="mono${it.qty <= 0 ? ' is-zero' : ''}">${fmt(it.qty)}</b><small>${escape(it.uom)}</small></span>
      <span class="wh__acts">
        <a class="wh__hist" href="?view=stock&amp;item=${encodeURIComponent(code)}#riwayat" title="Riwayat ${escape(it.name)}">${svg('history')}<span class="visually-hidden">Riwayat</span></a>
        <button class="wh__btn" type="button" data-move="${escape(code)}" aria-expanded="false">Catat</button>
      </span>
      <form class="wh__form" method="post" hidden data-confirm="Catat gerakan ${escape(it.name)}?">
        ${hidden}
        <input type="hidden" name="action" value="wh_move"><input type="hidden" name="code" value="${escape(code)}">
        <input type="hidden" name="token" value="${randomUUID()}">
        <fieldset class="wh__kinds"><legend class="visually-hidden">Jenis</legend>
          <label><input type="radio" name="kind" value="in" checked><span>Masuk</span></label>
          <label><input type="radio" name="kind" value="out"><span>Keluar</span></label>
          <label><input type="radio" name="kind" value="count"><span>Opname (hitung ulang)</span></label>
        </fieldset>
        <label class="wh__in"><span data-qty-label>Jumlah</span><input name="qty" type="number" min="0" step="1" inputmode="numeric" required class="mono"></label>
        <label class="wh__in wh__in--note"><span>Catatan</span><input name="note" maxlength="200" placeholder="mis. PO supplier, rusak, sampel KOL…"></label>
        <button class="pf__primary" type="submit">Simpan</button>
      </form>
    </li>`;
  };

  const shelf = Object.entries(GROUPS).map(([group, label]) => {
    const list = Object.entries(items).filter(([, it]) => (it.group ?? 'pack') === group).sort(([a], [b]) => a.localeCompare(b));
    if (!list.length) return '';
    const top = Math.max(0, ...list.map(([, it]) => it.qty));
    return `<section class="wh__grp ${TONE[group]}"><h2 class="wh__h"><i class="wh__dot" aria-hidden="true"></i>${escape(label)}<span>${list.length}</span></h2>
      <ul class="wh__list">${list.map(([code, it]) => row(code, it, top)).join('')}</ul></section>`;
  }).join('');

  // What the shelf lets us send, per product - the real figure, decided by the scarcest part.
  const sendable = PRODUCTS.map((p) => ({ p, m: makeable(p.sku, items) })).filter((x) => x.m)
    .sort((a, b) => familyOf(a.p).localeCompare(familyOf(b.p)) || a.p.name.localeCompare(b.p.name));
  const tier = (n) => (n <= 0 ? 't-none' : n < 20 ? 't-low' : 't-ok');
  const can = `<section class="wh__grp wh__grp--can"><h2 class="wh__h">Bisa dikirim dari gudang<span>${sendable.length}</span></h2>
    <p class="wh__legend"><span class="g-goods"><i class="wh__dot"></i>Barang jadi</span><span class="g-set"><i class="wh__dot"></i>Set &amp; aksesori</span><span class="wh__legend-lim">Bergaris = penentu jumlah</span></p>
    <ul class="wh__cans">${sendable.map(({ p, m }) => `<li class="wh__can ${tier(m.can)}">
      <span class="wh__canname">${escape(p.name)}${p.variant ? `<small>${escape(p.variant)}</small>` : ''}</span>
      <b class="mono wh__cann">${fmt(m.can)}</b>
      <span class="wh__parts">${m.parts.map((part) => `<span class="wh__part ${TONE[items[part.code]?.group ?? 'pack'] ?? ''}${part.code === m.limit && m.parts.length > 1 ? ' is-limit' : ''}" title="${escape(items[part.code]?.name ?? part.code)}: ${fmt(part.have)} di rak${part.per > 1 ? `, ${part.per} per produk` : ''}${part.code === m.limit ? ' - penentu jumlah' : ''}"><i class="wh__dot" aria-hidden="true"></i>${escape(items[part.code]?.name ?? part.code)}${part.per > 1 ? ` ×${part.per}` : ''}</span>`).join('')}</span>
    </li>`).join('')}</ul></section>`;

  const shown = moves.filter((m) => (!item || m.code === item) && (!kind || m.kind === kind)).slice(0, 150);
  const kindChips = [['', 'Semua'], ...Object.entries(KIND).map(([k, [l]]) => [k, l])].map(([k, l]) =>
    `<a class="chip${kind === k ? ' is-on' : ''}" href="?view=stock${item ? `&amp;item=${encodeURIComponent(item)}` : ''}${k ? `&amp;kind=${k}` : ''}#riwayat">${escape(l)}</a>`).join('');
  const history = `<section class="wh__grp" id="riwayat"><h2 class="wh__h">Riwayat gerakan${item ? ` · ${escape(items[item]?.name ?? item)}` : ''}<span>${shown.length}</span></h2>
    <div class="wh__filters">${kindChips}${item ? `<a class="chip" href="?view=stock#riwayat">${svg('x')} Semua barang</a>` : ''}</div>
    ${shown.length ? `<ol class="wh__log">${shown.map((m) => `<li>
      <span class="wh__t mono">${escape(when(m.at))}</span>
      <span class="wh__k ${KIND[m.kind]?.[1] ?? ''}">${escape(KIND[m.kind]?.[0] ?? m.kind)}</span>
      <span class="wh__lname">${escape(items[m.code]?.name ?? m.code)} <span class="mono dim">${escape(m.code)}</span></span>
      <span class="wh__d mono ${m.delta < 0 ? 'is-out' : 'is-in'}">${m.delta > 0 ? '+' : ''}${fmt(m.delta)}</span>
      <span class="wh__after mono">${fmt(m.after)}</span>
      <span class="wh__note">${escape(m.note ?? '')}${m.by ? ` <span class="dim">· ${escape(m.by)}</span>` : ''}</span>
    </li>`).join('')}</ol>` : '<p class="wh__empty">Belum ada gerakan untuk filter ini.</p>'}
  </section>`;

  const body = `<div class="wh">
    <p class="wh__intro">Stok fisik di gudang, per barang. Terpisah dari stok yang tampil di marketplace: halaman ini tidak pernah mengubah listing. Pesanan yang dikirim mengurangi stok di sini otomatis sesuai isi produknya.</p>
    <div class="wh__cols"><div>${shelf}</div><div>${can}</div></div>
    ${history}
  </div>`;

  return shell({ ...common, csrf, flash, user, kpis, body, title: 'Stok gudang', scope: 'gudang', view: 'stock', hideRangeControls: true, style: STYLE, script: SCRIPT });
}

const STYLE = `
.wh{padding:1rem; display:flex; flex-direction:column; gap:1.25rem}
.wh__intro{margin:0; font-size:.84rem; color:var(--muted); max-width:62rem}
.wh__cols{display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr); gap:1.25rem; align-items:start}
.g-goods{--tone:var(--good)} .g-set{--tone:var(--warn)} .g-pack{--tone:var(--info)}
.wh__dot{display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--tone, var(--muted)); flex:none}
.wh__grp{border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); padding:1rem 1.1rem}
.wh__grp + .wh__grp{margin-top:1.25rem}
.wh__grp[class*=g-]{border-top:2px solid color-mix(in srgb, var(--tone) 55%, var(--line))}
.wh__h .wh__dot{align-self:center}
.wh__cols > div > .wh__grp + .wh__grp{margin-top:1.25rem}
.wh__grp[class*=g-]{border-top:2px solid color-mix(in srgb, var(--tone) 55%, var(--line))}
.wh__h .wh__dot{align-self:center}
.wh__h{display:flex; align-items:baseline; gap:.5rem; margin:0 0 .75rem; font-size:.72rem; font-weight:600; letter-spacing:.08em; text-transform:uppercase; color:var(--muted)}
.wh__h span{opacity:.6; letter-spacing:0}
.wh__sub{margin:-.35rem 0 .75rem; font-size:.76rem; color:var(--dim)}
.wh__legend{display:flex; flex-wrap:wrap; gap:.4rem 1rem; margin:-.25rem 0 .9rem; font-size:.74rem; color:var(--muted)}
.wh__legend span{display:inline-flex; align-items:center; gap:.4rem}
.wh__legend-lim{padding:.05rem .5rem; border:1.5px solid var(--muted); border-radius:999px}
.wh__list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column}
.wh__row{display:grid; grid-template-columns:4.2rem minmax(0,1fr) 6rem auto; align-items:center; gap:.75rem; padding:.55rem .35rem; border-top:1px solid var(--line)}
.wh__row:first-child{border-top:0}
.wh__row[hidden]{display:none}
.wh__code{font-size:.72rem; color:var(--tone, var(--dim)); justify-self:start; padding:.12rem .4rem; border-radius:6px; background:color-mix(in srgb, var(--tone, var(--line)) 12%, transparent)}
.wh__name{display:flex; flex-direction:column; gap:.35rem; min-width:0}
.wh__nm{font-size:.88rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.wh__bar{display:block; height:4px; border-radius:999px; background:color-mix(in srgb, var(--fg) 8%, transparent); overflow:hidden; max-width:22rem}
.wh__bar i{display:block; height:100%; border-radius:inherit; background:var(--tone, var(--brand)); opacity:.8}
.wh__row:hover{background:color-mix(in srgb, var(--fg) 3%, transparent)}
.wh__qty{display:flex; align-items:baseline; justify-content:flex-end; gap:.3rem}
.wh__qty b{font-size:1.05rem; font-weight:600; font-variant-numeric:tabular-nums}
.wh__qty b.is-zero{color:var(--dim)}
.wh__qty small{font-size:.66rem; color:var(--dim)}
.wh__acts{display:flex; align-items:center; gap:.35rem}
.wh__hist{display:inline-grid; place-items:center; width:36px; height:36px; border-radius:9px; color:var(--muted); border:1px solid transparent}
.wh__hist:hover{color:var(--fg); border-color:var(--line)}
.wh__hist .ico{width:16px; height:16px}
.wh__btn{font:inherit; font-size:.78rem; min-height:36px; padding:.3rem .85rem; border-radius:999px; border:1px solid var(--line); background:var(--panel-2); color:var(--fg); cursor:pointer}
.wh__btn:hover, .wh__btn[aria-expanded="true"]{border-color:var(--brand); color:var(--brand)}
.wh__btn:focus-visible, .wh__hist:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.wh__form{grid-column:1/-1; display:flex; flex-wrap:wrap; align-items:flex-end; gap:.6rem; padding:.75rem; margin:.2rem 0 .3rem; border-radius:var(--radius-s); background:var(--panel-2); border:1px solid var(--line)}
.wh__form[hidden]{display:none}
.wh__kinds{display:flex; gap:.35rem; border:0; margin:0; padding:0; flex-wrap:wrap}
.wh__kinds label{display:inline-flex; align-items:center; gap:.35rem; font-size:.8rem; min-height:40px; padding:.3rem .7rem; border:1px solid var(--line); border-radius:999px; cursor:pointer; background:var(--panel)}
.wh__kinds label:has(input:checked){border-color:var(--brand); color:var(--fg)}
.wh__kinds input{accent-color:var(--brand); margin:0}
.wh__in{display:flex; flex-direction:column; gap:.25rem; font-size:.72rem; color:var(--muted)}
.wh__in input{font:inherit; font-size:.9rem; color:var(--fg); background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:.45rem .6rem; min-height:40px; width:8rem}
.wh__in--note{flex:1; min-width:12rem} .wh__in--note input{width:100%}
.wh__in input:focus-visible{outline:none; border-color:var(--brand); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand) 25%, transparent)}
.wh__cans{list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(15.5rem, 1fr)); gap:.6rem}
.wh__can{--t:var(--good); display:grid; grid-template-columns:minmax(0,1fr) auto; column-gap:.75rem; row-gap:.55rem; align-content:start; padding:.75rem .85rem; border-radius:var(--radius-s); background:var(--panel-2); border:1px solid var(--line); border-left:3px solid var(--t)}
.wh__can.t-low{--t:var(--warn)} .wh__can.t-none{--t:var(--bad)}
.wh__canname{font-size:.86rem; line-height:1.3; display:flex; flex-direction:column; gap:.1rem}
.wh__canname small{font-size:.72rem; color:var(--muted)}
.wh__cann{font-size:1.35rem; font-weight:600; text-align:right; color:var(--t); line-height:1}
.wh__parts{grid-column:1/-1; display:flex; flex-wrap:wrap; gap:.3rem}
.wh__part{display:inline-flex; align-items:center; gap:.35rem; font-size:.7rem; padding:.18rem .55rem; border-radius:999px; border:1px solid var(--line); color:var(--muted); background:var(--panel)}
.wh__part.is-limit{border:1.5px solid var(--tone); color:var(--fg); font-weight:600}
.wh__filters{display:flex; flex-wrap:wrap; gap:.35rem; margin-bottom:.75rem}
.wh__filters a{text-decoration:none}
.wh__filters .ico{width:12px; height:12px; vertical-align:-1px}
.wh__log{list-style:none; margin:0; padding:0}
.wh__log li{display:grid; grid-template-columns:8.5rem 6.5rem minmax(0,1.3fr) 4.5rem 4.5rem minmax(0,1.6fr); gap:.75rem; align-items:center; padding:.5rem .2rem; border-top:1px solid var(--line); font-size:.82rem}
.wh__log li:first-child{border-top:0}
.wh__t{font-size:.72rem; color:var(--dim)}
.wh__k{white-space:nowrap; font-size:.68rem; font-weight:600; letter-spacing:.04em; text-transform:uppercase; padding:.15rem .45rem; border-radius:6px; justify-self:start; border:1px solid var(--line); color:var(--muted)}
.wh__k.k-order{color:var(--brand)} .wh__k.k-in, .wh__k.k-back{color:var(--good, #6fbf73)} .wh__k.k-count{color:var(--accent)}
.wh__lname{min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.wh__d{text-align:right; font-weight:600}
.wh__d.is-in{color:var(--good, #6fbf73)}
.wh__after{text-align:right; color:var(--muted)}
.wh__note{font-size:.76rem; color:var(--muted); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.wh__empty{margin:0; font-size:.84rem; color:var(--dim)}
.wh__ok{display:inline-flex; align-items:center; gap:.35rem; font-size:.74rem; color:var(--muted); padding:.3rem .65rem; border:1px solid var(--line); border-radius:999px}
.wh__ok .ico{width:14px; height:14px; color:var(--good, #6fbf73)}
.wh__ok--bad{color:var(--fg); border-color:var(--bad)} .wh__ok--bad .ico{color:var(--bad)}
@media (max-width:1100px){.wh__cols{grid-template-columns:minmax(0,1fr)}}
@media (max-width:700px){
  .strip:has(.wh__ok){display:grid; grid-template-columns:1fr 1fr; gap:.75rem}
  .strip:has(.wh__ok) .stat{border:0; padding:0}
  .strip:has(.wh__ok) .strip__grow{display:none}
  .strip:has(.wh__ok) .wh__ok, .strip:has(.wh__ok) .search{grid-column:1/-1; width:100%}
  .wh__row{grid-template-columns:minmax(0,1fr) auto; row-gap:.2rem}
  .wh__code{grid-column:1} .wh__name{grid-column:1} .wh__nm{white-space:normal} .wh__qty{grid-column:2; grid-row:1}
  .wh__acts{grid-column:2; grid-row:2}
  .wh__log li{grid-template-columns:minmax(0,1fr) auto; row-gap:.15rem}
  .wh__t{grid-column:1} .wh__k{grid-column:2; grid-row:1} .wh__lname{grid-column:1} .wh__d{grid-column:2} .wh__after{display:none} .wh__note{grid-column:1/-1}
}
@media (prefers-reduced-motion:reduce){.wh *{transition:none !important}}
`;

const SCRIPT = `
(function () {
  // One movement form open at a time, under its own row.
  document.querySelectorAll('[data-move]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var row = btn.closest('.wh__row');
      var form = row.querySelector('.wh__form');
      var open = form.hidden;
      document.querySelectorAll('.wh__form').forEach(function (f) { f.hidden = true; });
      document.querySelectorAll('[data-move]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
      if (open) { form.hidden = false; btn.setAttribute('aria-expanded', 'true'); form.querySelector('[name=qty]').focus(); }
    });
  });
  // "Opname" asks for the count on the shelf, not a difference.
  document.querySelectorAll('.wh__form').forEach(function (form) {
    var label = form.querySelector('[data-qty-label]');
    form.addEventListener('change', function () {
      var k = form.querySelector('[name=kind]:checked').value;
      label.textContent = k === 'count' ? 'Jumlah di rak sekarang' : 'Jumlah';
    });
  });
  var q = document.getElementById('wq');
  if (q) q.addEventListener('input', function () {
    var v = q.value.trim().toLowerCase();
    document.querySelectorAll('.wh__row').forEach(function (r) { r.hidden = v !== '' && r.dataset.text.indexOf(v) === -1; });
  });
})();
`;
