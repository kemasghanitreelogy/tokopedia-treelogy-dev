import { shell, svg, escape, initials } from '../dashboard-page.js';
import { ROLES, ASSIGNABLE_ROLES, STATUS, OWNER_ID } from '../users.js';

/**
 * The Pengguna tab: who has a login, what they may do, and the door for adding one.
 *
 * Adding a person is an invitation, never a password typed on their behalf: the form
 * takes an address, a name and a role, and the rest happens in that person's inbox.
 */

const when = (epochSeconds) =>
  epochSeconds
    ? new Date(epochSeconds * 1000).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })
    : '';

const relative = (epochSeconds, now = Math.floor(Date.now() / 1000)) => {
  if (!epochSeconds) return 'belum pernah';
  const diff = now - epochSeconds;
  if (diff < 60) return 'baru saja';
  if (diff < 3600) return `${Math.floor(diff / 60)} mnt lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} hari lalu`;
  return when(epochSeconds);
};

const STATUS_TONE = { active: 'good', invited: 'act', disabled: 'bad' };

const hidden = (csrf, view = 'users') =>
  `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="view" value="${view}">`;

function userRow({ u, me, csrf, now }) {
  const isOwner = u.id === OWNER_ID;
  const isMe = u.id === me?.id;
  const inviteLeft = u.status === 'invited' && u.inviteExpiresAt ? u.inviteExpiresAt - now : 0;
  const statusNote = u.status === 'invited'
    ? (u.inviteExpired || inviteLeft <= 0
      ? '<span class="um__note um__note--bad">tautan kedaluwarsa</span>'
      : `<span class="um__note">tautan berlaku ${Math.max(1, Math.round(inviteLeft / 3600))} jam lagi</span>`)
    : u.status === 'active'
      ? `<span class="um__note">masuk terakhir ${escape(relative(u.lastLoginAt, now))}</span>`
      : '<span class="um__note">tidak bisa masuk</span>';

  const roleCell = isOwner
    ? `<span class="pill pill--done">${escape(ROLES.owner.label)}</span>`
    : `<form method="post" class="um__role">
        ${hidden(csrf)}<input type="hidden" name="action" value="user_role"><input type="hidden" name="id" value="${escape(u.id)}">
        <label class="visually-hidden" for="role-${escape(u.id)}">Peran ${escape(u.name)}</label>
        <select id="role-${escape(u.id)}" name="role" class="um__sel" data-autosave ${isMe ? 'disabled title="Peran sendiri tidak bisa diubah"' : ''}>
          ${ASSIGNABLE_ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${escape(ROLES[r].label)}</option>`).join('')}
        </select>
        <button class="um__save" type="submit" ${isMe ? 'disabled' : ''} aria-label="Simpan peran">${svg('check')}</button>
      </form>`;

  const actions = isOwner
    ? '<span class="um__note">diatur di environment</span>'
    : [
      u.status === 'invited'
        ? `<form method="post">${hidden(csrf)}<input type="hidden" name="action" value="user_resend"><input type="hidden" name="id" value="${escape(u.id)}">
            <button class="um__act" type="submit" title="Kirim ulang undangan">${svg('send')}<span>Kirim ulang</span></button></form>`
        : u.status === 'active'
          ? `<form method="post" data-confirm-text="Nonaktifkan ${escape(u.name)}? Sesinya langsung berakhir.">${hidden(csrf)}<input type="hidden" name="action" value="user_status"><input type="hidden" name="id" value="${escape(u.id)}"><input type="hidden" name="status" value="disabled">
              <button class="um__act" type="submit" ${isMe ? 'disabled title="Tidak bisa menonaktifkan diri sendiri"' : 'title="Nonaktifkan"'}>${svg('ban')}<span>Nonaktifkan</span></button></form>`
          : `<form method="post">${hidden(csrf)}<input type="hidden" name="action" value="user_status"><input type="hidden" name="id" value="${escape(u.id)}"><input type="hidden" name="status" value="active">
              <button class="um__act um__act--good" type="submit" title="Aktifkan kembali">${svg('check2')}<span>Aktifkan</span></button></form>`,
      `<form method="post" data-confirm-text="Hapus ${escape(u.name)} (${escape(u.email)})? Riwayat aktivitasnya tetap tersimpan.">${hidden(csrf)}<input type="hidden" name="action" value="user_delete"><input type="hidden" name="id" value="${escape(u.id)}">
        <button class="um__act um__act--bad" type="submit" ${isMe ? 'disabled title="Tidak bisa menghapus diri sendiri"' : 'title="Hapus pengguna"'}>${svg('trash')}<span>Hapus</span></button></form>`,
    ].join('');

  return `<tr class="um__row ${u.status === 'disabled' ? 'is-off' : ''}">
    <td>
      <div class="um__who">
        <span class="um__av um__av--${u.status}" aria-hidden="true">${escape(initials(u.name || u.email))}</span>
        <div class="um__id">
          <span class="um__name">${escape(u.name)}${isMe ? ' <span class="um__me">Anda</span>' : ''}</span>
          <a class="um__mail" href="mailto:${escape(u.email)}">${escape(u.email)}</a>
        </div>
      </div>
    </td>
    <td>${roleCell}</td>
    <td>
      <span class="pill pill--${STATUS_TONE[u.status] ?? 'info'}">${escape(STATUS[u.status] ?? u.status)}</span>
      ${statusNote}
    </td>
    <td class="um__meta">
      ${isOwner ? '<span class="dim">&mdash;</span>' : `<span>${escape(when(u.activatedAt ?? u.invitedAt))}</span><span class="um__note">${u.activatedAt ? 'aktif sejak' : 'diundang'} &middot; oleh ${escape(u.invitedBy?.email ?? '?')}</span>`}
    </td>
    <td class="um__acts">${actions}</td>
  </tr>`;
}

/**
 * @param {{users: object[], me: object, smtpReady: boolean, range, errors, shopeeShop, generatedAt, csrf, flash, user}} props
 */
export function renderUsers({ users, me, smtpReady, csrf, flash, ...common }) {
  const now = Math.floor(Date.now() / 1000);
  const counts = {
    total: users.length,
    active: users.filter((u) => u.status === 'active').length,
    invited: users.filter((u) => u.status === 'invited').length,
    disabled: users.filter((u) => u.status === 'disabled').length,
  };

  const kpis = `<section class="strip um__strip" aria-label="Ringkasan pengguna">
    <span class="stat"><span class="stat__n">${counts.total}</span><span class="stat__l">pengguna</span></span>
    <span class="stat"><span class="stat__n ok">${counts.active}</span><span class="stat__l">aktif</span></span>
    <span class="stat"><span class="stat__n ${counts.invited ? 'flag' : ''}">${counts.invited}</span><span class="stat__l">menunggu aktivasi</span></span>
    <span class="stat"><span class="stat__n ${counts.disabled ? 'stop' : ''}">${counts.disabled}</span><span class="stat__l">nonaktif</span></span>
    <span class="strip__grow"></span>
    <span class="um__smtp ${smtpReady ? 'is-ok' : 'is-off'}">${svg(smtpReady ? 'mail' : 'warn')}<span>${smtpReady ? 'Email undangan siap dikirim' : 'SMTP belum disetel: undangan tidak bisa dikirim'}</span></span>
  </section>`;

  const invite = `<section class="panel um__invite" aria-labelledby="um-invite-h">
    <div class="um__invite-h">
      <span class="um__invite-ico" aria-hidden="true">${svg('userPlus')}</span>
      <h2 id="um-invite-h">Undang pengguna baru</h2>
    </div>
    <form method="post" class="um__form">
      ${hidden(csrf)}<input type="hidden" name="action" value="user_invite">
      <div class="fld">
        <label for="inv-name">Nama</label>
        <input id="inv-name" name="name" type="text" required maxlength="80" autocomplete="off" placeholder="mis. Dewi Lestari">
      </div>
      <div class="fld">
        <label for="inv-email">Email</label>
        <input id="inv-email" name="email" type="email" required autocomplete="off" placeholder="nama@treelogy.com">
      </div>
      <fieldset class="um__roles">
        <legend>Peran</legend>
        ${ASSIGNABLE_ROLES.map((r, i) => `<label class="um__opt">
          <input type="radio" name="role" value="${r}" ${i === 1 ? 'checked' : ''}>
          <span class="um__opt-b"><b>${escape(ROLES[r].label)}</b><small>${escape(ROLES[r].desc)}</small></span>
        </label>`).join('')}
      </fieldset>
      <button class="um__go" type="submit">${svg('send')}Kirim undangan</button>
    </form>
  </section>`;

  const table = `<section class="panel um__list" aria-label="Daftar pengguna">
    <div class="scroll"><table>
      <thead><tr><th>Pengguna</th><th>Peran</th><th>Status</th><th>Sejak</th><th class="num">Tindakan</th></tr></thead>
      <tbody>${users.map((u) => userRow({ u, me, csrf, now })).join('')}</tbody>
    </table></div>
  </section>`;

  const body = `<div class="um">${invite}${table}</div>`;

  return shell({
    ...common, csrf, flash, title: 'Pengguna', view: 'users', kpis, body, hideRangeControls: true, user: me, style: STYLE, script: SCRIPT,
  });
}

const STYLE = `
.um{display:grid; grid-template-columns:minmax(280px,360px) minmax(0,1fr); gap:1rem; align-items:start}
@media (max-width:960px){ .um{grid-template-columns:minmax(0,1fr)} .um__invite{position:static} }
.um__strip{margin-bottom:1rem}
.um__smtp{display:inline-flex; align-items:center; gap:.45rem; font-size:.78rem; padding:.35rem .7rem; border-radius:8px;
  border:1px solid var(--line); color:var(--muted)}
.um__smtp .ico{width:16px; height:16px}
.um__smtp.is-ok{color:var(--good); border-color:color-mix(in srgb,var(--good) 40%,transparent); background:color-mix(in srgb,var(--good) 10%,transparent)}
.um__smtp.is-off{color:var(--warn); border-color:color-mix(in srgb,var(--warn) 45%,transparent); background:color-mix(in srgb,var(--warn) 10%,transparent)}

.um__invite{position:sticky; top:1rem; padding:1.25rem}
.um__invite-h{display:flex; gap:.75rem; align-items:center; margin-bottom:1.1rem}
.um__invite-h h2{margin:0; font-size:1rem; font-weight:600; letter-spacing:-.01em}
.um__invite-ico{width:38px; height:38px; border-radius:10px; display:grid; place-items:center; flex:none; color:#fff;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b))}
.um__form{display:flex; flex-direction:column; gap:.85rem}
.um__roles{margin:0; padding:0; border:0; display:flex; flex-direction:column; gap:.4rem}
.um__roles legend{font-size:.74rem; color:var(--muted); margin-bottom:.4rem; padding:0}
.um__opt{display:flex; gap:.6rem; align-items:flex-start; padding:.6rem .7rem; border:1px solid var(--line); border-radius:10px;
  background:var(--panel-2); cursor:pointer; transition:border-color var(--t-fast), background var(--t-fast)}
.um__opt:hover{border-color:var(--brand)}
.um__opt:has(input:checked){border-color:var(--brand); background:color-mix(in srgb,var(--brand) 10%,var(--panel-2))}
.um__opt:has(input:focus-visible){outline:2px solid var(--brand); outline-offset:1px}
.um__opt input{margin:.2rem 0 0; accent-color:var(--brand); flex:none}
.um__opt-b{display:flex; flex-direction:column; gap:.1rem; font-size:.82rem; line-height:1.35}
.um__opt-b small{font-size:.72rem; color:var(--muted)}
.um__go{display:inline-flex; align-items:center; justify-content:center; gap:.5rem; font:inherit; font-size:.9rem; font-weight:600;
  padding:.65rem 1rem; min-height:44px; border-radius:10px; cursor:pointer; color:#fff; border:1px solid transparent;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b)); transition:filter var(--t-base) var(--ease-out)}
.um__go:hover{filter:brightness(1.12)}
.um__go:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.um__go .ico{width:18px; height:18px}

.um__list .scroll{overflow:auto}
.um__row.is-off{opacity:.55}
.um__row.is-off:hover{opacity:1}
.um__who{display:flex; align-items:center; gap:.7rem; min-width:0}
.um__av{width:36px; height:36px; border-radius:10px; display:grid; place-items:center; flex:none; font-size:.76rem; font-weight:700; color:#fff;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b))}
.um__av--invited{background:linear-gradient(155deg,color-mix(in srgb,var(--act) 70%,#000),color-mix(in srgb,var(--act) 40%,#000))}
.um__av--disabled{background:var(--line); color:var(--muted)}
.um__id{display:flex; flex-direction:column; min-width:0; line-height:1.3}
.um__name{font-weight:600; font-size:.9rem; white-space:nowrap}
.um__me{font-size:.62rem; font-weight:600; letter-spacing:.06em; text-transform:uppercase; padding:.1rem .4rem; border-radius:5px;
  color:var(--brand); background:color-mix(in srgb,var(--brand) 16%,transparent); vertical-align:middle; margin-left:.3rem}
.um__mail{font-size:.76rem; color:var(--muted); text-decoration:none; white-space:nowrap}
.um__mail:hover{color:var(--fg); text-decoration:underline}
.um__note{display:block; font-size:.7rem; color:var(--dim); margin-top:.2rem; white-space:nowrap}
.um__note--bad{color:var(--bad)}
.um__meta{font-size:.8rem; white-space:nowrap}
.um__role{display:flex; align-items:center; gap:.3rem}
.um__sel{font:inherit; font-size:.82rem; padding:.35rem .5rem; min-height:36px; border-radius:8px; border:1px solid var(--line);
  background:var(--panel-2); color:var(--fg); cursor:pointer}
.um__sel:focus-visible{outline:2px solid var(--brand); outline-offset:1px}
.um__sel:disabled{cursor:not-allowed; opacity:.6}
.um__save{width:36px; height:36px; border-radius:8px; border:1px solid var(--line); background:var(--panel-2); color:var(--muted);
  display:grid; place-items:center; cursor:pointer; transition:color var(--t-fast), border-color var(--t-fast)}
.um__save:hover{color:var(--good); border-color:var(--good)}
.um__save:disabled{opacity:.35; cursor:not-allowed}
.um__save .ico{width:16px; height:16px}
.js .um__save{display:none}
.js .um__role.is-dirty .um__save{display:grid}
.um__acts{white-space:nowrap; text-align:right}
.um__acts form{display:inline-block; margin-left:.3rem}
.um__act{display:inline-flex; align-items:center; gap:.35rem; font:inherit; font-size:.76rem; font-weight:500; padding:.35rem .6rem; min-height:34px;
  border-radius:8px; border:1px solid var(--line); background:var(--panel-2); color:var(--muted); cursor:pointer;
  transition:color var(--t-fast), border-color var(--t-fast)}
.um__act .ico{width:15px; height:15px}
.um__act:hover{color:var(--fg); border-color:var(--brand)}
.um__act--good:hover{color:var(--good); border-color:var(--good)}
.um__act--bad:hover{color:var(--bad); border-color:var(--bad)}
.um__act:disabled{opacity:.35; cursor:not-allowed}
.um__act:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
@media (max-width:900px){ .um__act span{display:none} .um__act{padding:.35rem .5rem} }
`;

const SCRIPT = `
document.documentElement.classList.add('js');
document.querySelectorAll('.um__role select').forEach(function (sel) {
  var form = sel.closest('form');
  var initial = sel.value;
  sel.addEventListener('change', function () {
    form.classList.toggle('is-dirty', sel.value !== initial);
  });
});
document.querySelectorAll('form[data-confirm-text]').forEach(function (form) {
  form.addEventListener('submit', function (e) {
    if (!window.confirm(form.dataset.confirmText)) e.preventDefault();
  });
});
`;
