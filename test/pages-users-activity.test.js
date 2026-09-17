import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUsers } from '../src/pages/users.js';
import { renderActivity } from '../src/pages/activity.js';
import { renderActivate, renderActivateInvalid } from '../src/pages/activate.js';
import { renderDashboard, VIEWS } from '../src/dashboard-page.js';
import { summarize } from '../src/omni.js';

const range = { preset: '7d', from: '2026-09-11', to: '2026-09-17', label: '7 hari', since: 1, until: 2, clamped: false };
const common = { range, errors: {}, shopeeShop: null, generatedAt: Date.now(), csrf: 'tok', flash: null };
const owner = { id: 'owner', email: 'kemas@treelogy.com', name: 'Kemas', role: 'owner', status: 'active' };
const admin = { id: 'u-admin', email: 'admin@treelogy.com', name: 'Admin', role: 'admin', status: 'active' };
const operator = { id: 'u-op', email: 'op@treelogy.com', name: 'Opera <b>Tor</b>', role: 'operator', status: 'active', lastLoginAt: Math.floor(Date.now() / 1000) - 120, activatedAt: 1789000000, invitedBy: { email: 'kemas@treelogy.com' } };
const invited = { id: 'u-inv', email: 'dewi@treelogy.com', name: 'Dewi', role: 'viewer', status: 'invited', invitedAt: 1789000000, inviteExpiresAt: Math.floor(Date.now() / 1000) + 7200, inviteExpired: false, invitedBy: { email: 'admin@treelogy.com' } };
const disabled = { id: 'u-off', email: 'off@treelogy.com', name: 'Nonaktif', role: 'operator', status: 'disabled', activatedAt: 1789000000, invitedBy: { email: 'kemas@treelogy.com' } };

const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const validJs = (html, name) => {
  for (const body of scripts(html)) {
    try { new Function(body); } catch (error) { assert.fail(`${name}: ${error.message}`); }
  }
};

test('the users page lists everyone, offers the invite form, and escapes names', () => {
  const html = renderUsers({ users: [owner, admin, operator, invited, disabled], me: admin, smtpReady: true, ...common });
  assert.match(html, /Undang pengguna baru/);
  assert.match(html, /name="action" value="user_invite"/);
  assert.match(html, /Opera &lt;b&gt;Tor&lt;\/b&gt;/);
  assert.ok(!html.includes('<b>Tor</b>'));
  assert.match(html, /user_resend/, 'yang diundang punya tombol kirim ulang');
  assert.match(html, /value="disabled"/, 'yang aktif bisa dinonaktifkan');
  assert.match(html, /Aktifkan/, 'yang nonaktif bisa diaktifkan');
  assert.match(html, /Email undangan siap dikirim/);
  assert.match(html, /<option value="admin" selected>/);
  assert.ok(/Anda/.test(html), 'baris sendiri ditandai');
  assert.match(html, /viewtab is-on" href="\?view=users"/);
  assert.match(html, /Pengguna<\/a>/, 'admin melihat tab Pengguna');
  validJs(html, 'users');
});

test('without SMTP the page says so, and the owner row has no destructive controls', () => {
  const html = renderUsers({ users: [owner], me: owner, smtpReady: false, ...common });
  assert.match(html, /SMTP belum disetel/);
  assert.ok(!html.includes('user_delete'));
  assert.match(html, /diatur di environment/);
});

test('the users tab is hidden from operators and viewers but the activity tab is not', () => {
  const html = renderDashboard({ orders: [], summary: summarize([]), user: { ...operator, name: 'Op' }, ...common });
  assert.ok(!html.includes('?view=users'), 'operator tidak melihat tab Pengguna');
  assert.match(html, /\?view=activity/);
  assert.match(html, /class="who"/, 'identitas yang masuk tampil di header');
  assert.match(html, /Operator/);
  assert.equal(VIEWS.users, 'Pengguna');
  assert.equal(VIEWS.activity, 'Aktivitas');
});

test('the activity page groups by day, shows before/after tables and honours filters', () => {
  const now = Math.floor(Date.now() / 1000);
  const entries = [
    { id: '1', at: now, actor: { id: 'owner', email: 'kemas@treelogy.com', name: 'Kemas' }, ip: '1.2.3.4', menu: 'products', action: 'ledger', verb: 'edit', target: 'MRS-002', summary: 'Mengubah stok ledger MRS-002 dari 74 menjadi 70', status: 'ok', error: null, changes: [{ field: 'stok MRS-002', from: 74, to: 70 }] },
    { id: '2', at: now - 90000, actor: { id: 'u-op', email: 'op@treelogy.com', name: 'Opera' }, ip: '', menu: 'jurnal', action: 'manual_invoice', verb: 'add', target: 'CS-260917-0000066', summary: 'Menambah <script>alert(1)</script>', status: 'failed', error: 'kode sudah dipakai', changes: [] },
  ];
  const html = renderActivity({
    entries, actors: [{ id: 'owner', email: 'kemas@treelogy.com', name: 'Kemas' }, { id: 'u-op', email: 'op@treelogy.com', name: 'Opera' }],
    filter: { actor: 'u-op', menu: '', status: '', q: 'x' }, paging: { page: 1, perPage: 50 }, baseQuery: 'view=activity&actor=u-op', user: owner, ...common,
  });
  assert.equal((html.match(/class="ac__day-h"/g) ?? []).length, 2, 'dua hari, dua kepala');
  assert.match(html, /<td class="ac__from">.*74.*<\/td>/);
  assert.match(html, /<td class="ac__to">.*70.*<\/td>/);
  assert.match(html, /Gagal/);
  assert.match(html, /kode sudah dipakai/);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'ringkasan diloloskan');
  assert.match(html, /<option value="u-op" selected>/);
  assert.match(html, /value="x"/);
  assert.match(html, /2 tindakan|dari <b>2<\/b>/);
  validJs(html, 'activity');
});

test('an empty activity range explains itself', () => {
  const html = renderActivity({ entries: [], actors: [], filter: { actor: '', menu: '', status: '', q: '' }, user: owner, ...common });
  assert.match(html, /Belum ada aktivitas/);
});

test('the activation page shows who is activating, both password fields, and the server error', () => {
  const html = renderActivate({ invitee: { name: 'Dewi <x>', email: 'dewi@treelogy.com', role: 'operator' }, token: 'tok-123', error: 'Konfirmasi password tidak sama.' });
  assert.match(html, /Dewi &lt;x&gt;/);
  assert.match(html, /name="token" value="tok-123"/);
  assert.match(html, /id="password"/);
  assert.match(html, /id="confirm"/);
  assert.match(html, /autocomplete="new-password"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Konfirmasi password tidak sama\./);
  assert.match(html, /Operator/);
  validJs(html, 'activate');
  assert.match(renderActivateInvalid(), /tidak berlaku/);
});
