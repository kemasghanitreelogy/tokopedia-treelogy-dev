import { shell, svg, escape, initials, pager } from '../dashboard-page.js';
import { paginate, DEFAULT_PER_PAGE } from '../paging.js';
import { MENUS, VERBS } from '../audit.js';

/**
 * The Aktivitas tab: the journey of every change, newest first.
 *
 * One row per action - who, when, on which menu, what it did in a sentence. Anything
 * that had a before and after opens into a table of exactly those. Filters and the date
 * range live in the URL, like every other list here, so "show me everything Dewi did to
 * stock last week" is a link that can be sent to someone.
 */

const clock = (epochSeconds) =>
  new Date(epochSeconds * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' });

const dayLabel = (epochSeconds) =>
  new Date(epochSeconds * 1000).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });

const dayOf = (epochSeconds) =>
  new Date((epochSeconds + 7 * 3600) * 1000).toISOString().slice(0, 10);

const show = (value) => {
  if (value === null || value === undefined || value === '') return '<span class="dim">&mdash;</span>';
  if (typeof value === 'number') return `<span class="mono">${escape(value.toLocaleString('id-ID'))}</span>`;
  if (typeof value === 'boolean') return value ? 'ya' : 'tidak';
  if (typeof value === 'object') return `<span class="mono">${escape(JSON.stringify(value))}</span>`;
  return escape(value);
};

function changesTable(e) {
  if (!e.changes?.length) return '';
  const hasFrom = e.changes.some((c) => c.from !== undefined);
  const hasTo = e.changes.some((c) => c.to !== undefined);
  const hasNote = e.changes.some((c) => c.note);
  return `<table class="ac__chg">
    <thead><tr><th>Apa</th>${hasFrom ? '<th>Sebelum</th>' : ''}${hasTo ? '<th>Sesudah</th>' : ''}${hasNote ? '<th>Keterangan</th>' : ''}</tr></thead>
    <tbody>${e.changes.map((c) => `<tr>
      <td class="ac__f">${escape(c.field)}</td>
      ${hasFrom ? `<td class="ac__from">${show(c.from)}</td>` : ''}
      ${hasTo ? `<td class="ac__to">${show(c.to)}</td>` : ''}
      ${hasNote ? `<td class="ac__n">${escape(c.note ?? '')}</td>` : ''}
    </tr>`).join('')}</tbody>
  </table>${e.changesTruncated ? `<p class="ac__more">Menampilkan ${e.changes.length} dari ${e.changesTruncated} perubahan.</p>` : ''}`;
}

function entryRow(e) {
  const verb = VERBS[e.verb] ?? VERBS.edit;
  const failed = e.status === 'failed';
  const details = changesTable(e);
  const hasDetails = Boolean(details || e.error);
  const inner = `
    <span class="ac__time mono">${escape(clock(e.at))}</span>
    <span class="ac__av" aria-hidden="true">${escape(initials(e.actor.name || e.actor.email))}</span>
    <span class="ac__main">
      <span class="ac__line">
        <a class="ac__who" href="?view=activity&actor=${escape(e.actor.id)}" title="${escape(e.actor.email)}">${escape(e.actor.name || e.actor.email)}</a>
        <span class="pill pill--${failed ? 'bad' : verb.tone}">${failed ? 'Gagal' : escape(verb.label)}</span>
        <a class="ac__menu" href="?view=activity&menu=${escape(e.menu)}">${escape(MENUS[e.menu] ?? e.menu)}</a>
      </span>
      <span class="ac__sum">${escape(e.summary)}${e.target ? ` <span class="ac__target mono">${escape(e.target)}</span>` : ''}</span>
      ${failed && e.error ? `<span class="ac__err">${svg('warn')}${escape(e.error)}</span>` : ''}
    </span>
    ${hasDetails && details ? `<span class="ac__n-chg">${e.changes.length} ${e.changes.length === 1 ? 'perubahan' : 'perubahan'}</span>` : ''}`;

  if (!details) return `<li class="ac__item ${failed ? 'is-failed' : ''}"><div class="ac__row">${inner}</div></li>`;
  return `<li class="ac__item ${failed ? 'is-failed' : ''}">
    <details class="ac__d">
      <summary class="ac__row">${inner}${svg('chevR', 'ac__chev')}</summary>
      <div class="ac__body">
        ${details}
        <p class="ac__meta">${escape(e.action)} &middot; ${escape(e.actor.email)}${e.ip ? ` &middot; ${escape(e.ip)}` : ''}</p>
      </div>
    </details>
  </li>`;
}

/**
 * @param {{entries: object[], actors: object[], filter: {actor: string, menu: string, status: string, q: string},
 *   paging: {page: number, perPage: number}, baseQuery: string, user: object, range, errors, shopeeShop, generatedAt, csrf, flash}} props
 */
export function renderActivity({ entries, actors, filter, paging = { page: 1, perPage: DEFAULT_PER_PAGE }, baseQuery = '', user, csrf, flash, ...common }) {
  const paged = paginate(entries, paging);
  const keep = (over) => {
    const q = new URLSearchParams(baseQuery);
    q.set('view', 'activity');
    for (const [k, v] of Object.entries(over)) { if (v) q.set(k, v); else q.delete(k); }
    return `?${q.toString()}`;
  };

  const counts = {
    failed: entries.filter((e) => e.status === 'failed').length,
    people: new Set(entries.map((e) => e.actor.id)).size,
  };
  const kpis = `<section class="strip ac__strip" aria-label="Ringkasan aktivitas">
    <span class="stat"><span class="stat__n">${entries.length.toLocaleString('id-ID')}</span><span class="stat__l">tindakan</span></span>
    <span class="stat"><span class="stat__n">${counts.people}</span><span class="stat__l">orang</span></span>
    <span class="stat"><span class="stat__n ${counts.failed ? 'stop' : 'ok'}">${counts.failed}</span><span class="stat__l">gagal</span></span>
    <span class="strip__grow"></span>
    <form method="get" class="ac__search" role="search">
      <input type="hidden" name="view" value="activity">
      ${common.range?.preset ? `<input type="hidden" name="preset" value="${escape(common.range.preset)}">` : `<input type="hidden" name="from" value="${escape(common.range?.from ?? '')}"><input type="hidden" name="to" value="${escape(common.range?.to ?? '')}">`}
      ${filter.actor ? `<input type="hidden" name="actor" value="${escape(filter.actor)}">` : ''}
      ${filter.menu ? `<input type="hidden" name="menu" value="${escape(filter.menu)}">` : ''}
      ${filter.status ? `<input type="hidden" name="status" value="${escape(filter.status)}">` : ''}
      <label class="visually-hidden" for="ac-q">Cari aktivitas</label>
      ${svg('search', 'ac__search-ico')}
      <input class="search" id="ac-q" name="q" type="search" value="${escape(filter.q)}" placeholder="Cari SKU, pesanan, nama…">
    </form>
  </section>`;

  const menuChips = ['', ...Object.keys(MENUS).filter((m) => m !== 'activity')].map((m) =>
    `<a class="chip ${filter.menu === m ? 'is-on' : ''}" href="${escape(keep({ menu: m, page: '' }))}">${m ? escape(MENUS[m]) : 'Semua menu'}</a>`).join('');
  const actorOptions = [['', 'Semua orang'], ...actors.map((a) => [a.id, a.name || a.email])].map(([v, label]) =>
    `<option value="${escape(v)}" ${filter.actor === v ? 'selected' : ''}>${escape(label)}</option>`).join('');
  const statusChips = [['', 'Semua'], ['ok', 'Berhasil'], ['failed', 'Gagal']].map(([v, label]) =>
    `<a class="chip ${filter.status === v ? 'is-on' : ''}" href="${escape(keep({ status: v, page: '' }))}">${label}</a>`).join('');

  const filters = `<div class="filters ac__filters">
    <form method="get" class="ac__actor">
      <input type="hidden" name="view" value="activity">
      ${common.range?.preset ? `<input type="hidden" name="preset" value="${escape(common.range.preset)}">` : ''}
      ${filter.menu ? `<input type="hidden" name="menu" value="${escape(filter.menu)}">` : ''}
      ${filter.status ? `<input type="hidden" name="status" value="${escape(filter.status)}">` : ''}
      ${filter.q ? `<input type="hidden" name="q" value="${escape(filter.q)}">` : ''}
      <label class="visually-hidden" for="ac-actor">Orang</label>
      ${svg('users', 'ac__actor-ico')}
      <select id="ac-actor" name="actor" class="ac__sel" data-autosubmit>${actorOptions}</select>
      <noscript><button class="chip" type="submit">Terapkan</button></noscript>
    </form>
    <span class="ac__sep" aria-hidden="true"></span>
    ${menuChips}
    <span class="ac__sep" aria-hidden="true"></span>
    ${statusChips}
  </div>`;

  let list;
  if (paged.items.length === 0) {
    list = `<div class="ac__empty">
      <span class="ac__empty-ico" aria-hidden="true">${svg('history')}</span>
      <p><b>Belum ada aktivitas</b> untuk rentang dan filter ini.</p>
      <p class="dim">Setiap simpan, kirim, cetak dan perubahan pengguna tercatat di sini begitu terjadi.</p>
    </div>`;
  } else {
    const groups = [];
    for (const e of paged.items) {
      const day = dayOf(e.at);
      if (groups.length === 0 || groups[groups.length - 1].day !== day) groups.push({ day, at: e.at, items: [] });
      groups[groups.length - 1].items.push(e);
    }
    list = groups.map((g) => `<section class="ac__day">
      <h3 class="ac__day-h"><span>${escape(dayLabel(g.at))}</span><span class="ac__day-n">${g.items.length}</span></h3>
      <ol class="ac__list">${g.items.map(entryRow).join('')}</ol>
    </section>`).join('');
  }

  const body = `<section class="panel ac">
    ${filters}
    ${list}
    ${pager(paged, { baseQuery, noun: 'tindakan' })}
  </section>`;

  return shell({
    ...common, csrf, flash, user, title: 'Aktivitas', view: 'activity', kpis, body, style: STYLE, script: SCRIPT,
  });
}

const STYLE = `
.ac__strip{margin-bottom:1rem}
.ac__search{display:flex; align-items:center; gap:.4rem; position:relative}
.ac__search .search{padding-left:2rem; min-width:220px}
.ac__search-ico{position:absolute; left:.6rem; width:16px; height:16px; color:var(--dim); pointer-events:none}
.ac__filters{gap:.4rem}
.ac__actor{display:flex; align-items:center; gap:.4rem; position:relative}
.ac__actor-ico{position:absolute; left:.6rem; width:16px; height:16px; color:var(--dim); pointer-events:none}
.ac__sel{font:inherit; font-size:.8rem; padding:.4rem .75rem .4rem 2rem; min-height:34px; border-radius:8px; cursor:pointer;
  border:1px solid var(--line); background:var(--panel-2); color:var(--fg); max-width:16rem}
.ac__sel:focus-visible{outline:2px solid var(--brand); outline-offset:1px}
.ac__sep{width:1px; height:22px; background:var(--line); margin:0 .3rem}

.ac__day{border-top:1px solid var(--line)}
.ac__day:first-of-type{border-top:0}
.ac__day-h{position:sticky; top:0; z-index:2; margin:0; padding:.55rem 1rem; display:flex; align-items:center; gap:.6rem;
  font-size:.74rem; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);
  background:color-mix(in srgb,var(--panel-2) 92%,transparent); backdrop-filter:blur(6px); border-bottom:1px solid var(--line)}
.ac__day-n{font-family:"Fira Code",ui-monospace,monospace; font-weight:500; letter-spacing:0; padding:.05rem .4rem; border-radius:5px;
  background:var(--panel); border:1px solid var(--line); color:var(--dim)}
.ac__list{list-style:none; margin:0; padding:0}
.ac__item{border-top:1px solid var(--line); animation:rise 300ms var(--ease-out) both}
.ac__item:first-child{border-top:0}
.ac__item:nth-child(6n+2){animation-delay:40ms} .ac__item:nth-child(6n+3){animation-delay:80ms}
.ac__item:nth-child(6n+4){animation-delay:120ms} .ac__item:nth-child(6n+5){animation-delay:160ms} .ac__item:nth-child(6n){animation-delay:200ms}
.ac__item.is-failed{box-shadow:inset 3px 0 0 var(--bad)}
.ac__row{display:grid; grid-template-columns:auto auto minmax(0,1fr) auto auto; gap:.8rem; align-items:center; padding:.7rem 1rem;
  list-style:none; transition:background var(--t-fast)}
.ac__d>summary{cursor:pointer}
.ac__d>summary::-webkit-details-marker{display:none}
.ac__d>summary:hover{background:var(--panel-2)}
.ac__d>summary:focus-visible{outline:2px solid var(--brand); outline-offset:-2px}
.ac__time{font-size:.76rem; color:var(--dim); white-space:nowrap; min-width:4.6rem}
.ac__av{width:30px; height:30px; border-radius:9px; display:grid; place-items:center; flex:none; font-size:.66rem; font-weight:700; color:#fff;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b))}
.ac__main{display:flex; flex-direction:column; gap:.15rem; min-width:0}
.ac__line{display:flex; align-items:center; gap:.45rem; flex-wrap:wrap}
.ac__who{font-weight:600; font-size:.86rem; color:var(--fg); text-decoration:none}
.ac__who:hover{text-decoration:underline}
.ac__menu{font-size:.68rem; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); text-decoration:none;
  padding:.1rem .45rem; border:1px solid var(--line); border-radius:5px; transition:border-color var(--t-fast), color var(--t-fast)}
.ac__menu:hover{color:var(--fg); border-color:var(--brand)}
.ac__sum{font-size:.86rem; line-height:1.45; overflow-wrap:anywhere}
.ac__target{color:var(--muted); font-size:.78em}
.ac__err{display:inline-flex; align-items:center; gap:.35rem; font-size:.78rem; color:var(--bad); margin-top:.1rem}
.ac__err .ico{width:14px; height:14px}
.ac__n-chg{font-size:.72rem; color:var(--dim); white-space:nowrap}
.ac__chev{width:16px; height:16px; color:var(--dim); transition:transform var(--t-base) var(--ease-out)}
.ac__d[open]>summary .ac__chev{transform:rotate(90deg)}
.ac__body{padding:0 1rem 1rem 5.35rem; animation:rise 240ms var(--ease-out) both}
.ac__chg{width:auto; min-width:min(100%,32rem); font-size:.82rem; border:1px solid var(--line); border-radius:10px; overflow:hidden;
  background:var(--panel-2); border-collapse:separate; border-spacing:0}
.ac__chg th{position:static; font-size:.68rem; padding:.45rem .75rem}
.ac__chg td{padding:.45rem .75rem; border-top:1px solid var(--line)}
.ac__f{font-weight:500}
.ac__from{color:var(--muted)}
.ac__from .mono{text-decoration:line-through; text-decoration-color:color-mix(in srgb,var(--bad) 60%,transparent)}
.ac__to{color:var(--fg); font-weight:500}
.ac__n{color:var(--muted); font-size:.78rem}
.ac__more{margin:.4rem 0 0; font-size:.74rem; color:var(--dim)}
.ac__meta{margin:.6rem 0 0; font-size:.72rem; color:var(--dim); font-family:"Fira Code",ui-monospace,monospace}
.ac__empty{padding:3rem 1rem; text-align:center}
.ac__empty p{margin:.25rem 0; font-size:.9rem}
.ac__empty-ico{width:52px; height:52px; border-radius:14px; display:grid; place-items:center; margin:0 auto .85rem;
  background:var(--panel-2); border:1px solid var(--line); color:var(--muted)}
.ac__empty-ico .ico{width:24px; height:24px}
@media (max-width:640px){
  .ac__row{grid-template-columns:auto minmax(0,1fr) auto; gap:.6rem}
  .ac__time{display:none} .ac__n-chg{display:none}
  .ac__body{padding-left:1rem}
}
`;

const SCRIPT = `
document.querySelectorAll('select[data-autosubmit]').forEach(function (sel) {
  sel.addEventListener('change', function () { sel.form.submit(); });
});
`;
