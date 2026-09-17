import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, passwordProblem, inviteUser, renewInvite, findInvite, activateUser, updateUser, removeUser,
  listUsers, findByEmail, verifyLogin, can, ownerUser, publicUser, USERS_DOC, OWNER_ID, MIN_PASSWORD_LENGTH,
} from '../src/users.js';
import { issueSession, authenticate, login } from '../src/dashboard-auth.js';
import { deleteDoc, readDoc, closeStore } from '../src/store/index.js';

test.after(async () => { await closeStore(); });

const env = (values) => {
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
test.beforeEach(async () => {
  env({ DASHBOARD_EMAIL: 'kemas@treelogy.com', DASHBOARD_PASSWORD: 'rahasia', DASHBOARD_TOKEN: 'signing-key-that-is-long-and-random', DASHBOARD_NAME: 'Kemas' });
  await deleteDoc(USERS_DOC);
});

const by = { id: OWNER_ID, email: 'kemas@treelogy.com', name: 'Kemas' };

test('passwords are hashed with scrypt and verified in constant shape', () => {
  const stored = hashPassword('kopi-susu-pagi');
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(hashPassword('kopi-susu-pagi'), stored, 'garam acak: hash yang sama dua kali harus berbeda');
  assert.equal(verifyPassword('kopi-susu-pagi', stored), true);
  assert.equal(verifyPassword('kopi-susu-sore', stored), false);
  assert.equal(verifyPassword('apa saja', 'bukan-hash'), false);
  assert.equal(verifyPassword('apa saja', null), false);
});

test('the password rules are the same on the page and in the store', () => {
  assert.match(passwordProblem('pendek', 'pendek'), /minimal/);
  assert.match(passwordProblem('cukup-panjang', 'cukup-panjangx'), /Konfirmasi/);
  assert.match(passwordProblem('dewi@treelogy.com', 'dewi@treelogy.com', { email: 'Dewi@treelogy.com' }), /email/);
  assert.match(passwordProblem('aaaaaaaaaa', 'aaaaaaaaaa'), /berulang/);
  assert.equal(passwordProblem('kopi-susu-pagi', 'kopi-susu-pagi'), null);
  assert.ok(MIN_PASSWORD_LENGTH >= 8);
});

test('the owner comes from the environment and is never stored', async () => {
  const owner = ownerUser();
  assert.deepEqual({ id: owner.id, email: owner.email, name: owner.name, role: owner.role, status: owner.status },
    { id: 'owner', email: 'kemas@treelogy.com', name: 'Kemas', role: 'owner', status: 'active' });
  const users = await listUsers();
  assert.equal(users.length, 1);
  assert.equal(users[0].id, OWNER_ID);
  assert.equal(await readDoc(USERS_DOC), null, 'daftar pengguna tidak ditulis hanya karena dibaca');
  await assert.rejects(inviteUser({ email: 'kemas@treelogy.com', name: 'K', role: 'admin', by }), /pemilik/);
});

test('an invitation creates a pending user and a one-time token, never a password', async () => {
  const { user, token } = await inviteUser({ email: '  Dewi@Treelogy.com ', name: 'Dewi Lestari', role: 'operator', by });
  assert.equal(user.email, 'dewi@treelogy.com');
  assert.equal(user.status, 'invited');
  assert.equal(user.role, 'operator');
  assert.equal(user.passwordHash, undefined, 'hash tidak pernah keluar dari modul');
  assert.equal(user.invite, undefined, 'token tidak pernah keluar dari modul');
  assert.ok(user.inviteExpiresAt > Math.floor(Date.now() / 1000) + 71 * 3600);
  assert.ok(token.length >= 40);

  const raw = await readDoc(USERS_DOC);
  const stored = Object.values(raw.users)[0];
  assert.notEqual(stored.invite.tokenHash, token, 'yang disimpan adalah hash, bukan tokennya');
  assert.equal(stored.passwordHash, null);

  await assert.rejects(inviteUser({ email: 'dewi@treelogy.com', name: 'Lagi', role: 'viewer', by }), /sudah terdaftar/);
  await assert.rejects(inviteUser({ email: 'bukan-email', name: 'X', role: 'viewer', by }), /email/);
  await assert.rejects(inviteUser({ email: 'x@y.co', name: '', role: 'viewer', by }), /nama/);
  await assert.rejects(inviteUser({ email: 'x@y.co', name: 'X', role: 'owner', by }), /peran/);
});

test('the invitee activates with a password of their own and can then sign in', async () => {
  const { token } = await inviteUser({ email: 'dewi@treelogy.com', name: 'Dewi', role: 'operator', by });
  const pending = await findInvite(token);
  assert.equal(pending.email, 'dewi@treelogy.com');
  assert.equal(await findInvite('salah-' + token), null);

  await assert.rejects(activateUser({ token, password: 'pendek', confirm: 'pendek' }), /minimal/);
  await assert.rejects(activateUser({ token, password: 'kopi-susu-pagi', confirm: 'beda' }), /Konfirmasi/);
  assert.equal((await findInvite(token)).status, 'invited', 'gagal validasi tidak menghanguskan tautan');

  const active = await activateUser({ token, password: 'kopi-susu-pagi', confirm: 'kopi-susu-pagi' });
  assert.equal(active.status, 'active');
  assert.equal(active.invite, null);
  assert.equal(await findInvite(token), null, 'tautan sekali pakai');
  await assert.rejects(activateUser({ token, password: 'kopi-susu-pagi', confirm: 'kopi-susu-pagi' }), /tidak berlaku/);

  assert.equal((await verifyLogin('dewi@treelogy.com', 'kopi-susu-pagi')).id, active.id);
  assert.equal(await verifyLogin('dewi@treelogy.com', 'salah'), null);
  assert.equal((await login('DEWI@treelogy.com', 'kopi-susu-pagi')).id, active.id);
  assert.equal((await login('kemas@treelogy.com', 'rahasia')).id, OWNER_ID, 'pemilik tetap masuk lewat environment');
  assert.equal(await login('kemas@treelogy.com', 'kopi-susu-pagi'), null);
});

test('a renewed invitation retires the old link', async () => {
  const first = await inviteUser({ email: 'dewi@treelogy.com', name: 'Dewi', role: 'viewer', by });
  const second = await renewInvite(first.user.id, by);
  assert.notEqual(second.token, first.token);
  assert.equal(await findInvite(first.token), null);
  assert.ok(await findInvite(second.token));
  await activateUser({ token: second.token, password: 'kopi-susu-pagi', confirm: 'kopi-susu-pagi' });
  await assert.rejects(renewInvite(first.user.id, by), /sudah aktif/);
});

test('a session is bound to the user and dies with a disable, a delete or a new password', async () => {
  const { token } = await inviteUser({ email: 'dewi@treelogy.com', name: 'Dewi', role: 'operator', by });
  const dewi = await activateUser({ token, password: 'kopi-susu-pagi', confirm: 'kopi-susu-pagi' });
  const session = issueSession(dewi);
  const who = await authenticate(session);
  assert.equal(who.id, dewi.id);
  assert.equal(who.role, 'operator');

  const { before, after } = await updateUser(dewi.id, { status: 'disabled' });
  assert.equal(before.status, 'active');
  assert.equal(after.status, 'disabled');
  assert.equal(await authenticate(session), null, 'nonaktif: sesi lama tidak berlaku');
  await updateUser(dewi.id, { status: 'active' });
  assert.ok(await authenticate(session), 'aktif lagi: sesi lama berlaku kembali (hash tidak berubah)');

  await removeUser(dewi.id);
  assert.equal(await authenticate(session), null);
  assert.equal(await findByEmail('dewi@treelogy.com'), null);
});

test('roles gate what a session may do', async () => {
  assert.equal(can(ownerUser(), 'users'), true);
  assert.equal(can({ role: 'admin', status: 'active' }, 'users'), true);
  assert.equal(can({ role: 'operator', status: 'active' }, 'users'), false);
  assert.equal(can({ role: 'operator', status: 'active' }, 'write'), true);
  assert.equal(can({ role: 'viewer', status: 'active' }, 'write'), false);
  assert.equal(can({ role: 'admin', status: 'disabled' }, 'write'), false);
  assert.equal(can(null, 'write'), false);

  const { user } = await inviteUser({ email: 'dewi@treelogy.com', name: 'Dewi', role: 'viewer', by });
  await assert.rejects(updateUser(user.id, { status: 'disabled' }), /belum mengaktifkan/);
  await assert.rejects(updateUser(user.id, { role: 'owner' }), /peran/);
  await assert.rejects(updateUser(OWNER_ID, { role: 'viewer' }), /environment/);
  await assert.rejects(removeUser(OWNER_ID), /pemilik/);
  const { after } = await updateUser(user.id, { role: 'admin' });
  assert.equal(after.role, 'admin');
});

test('publicUser strips secrets and reports expiry', () => {
  const past = publicUser({ id: 'x', email: 'a@b.c', name: 'A', status: 'invited', passwordHash: 'h', invite: { tokenHash: 't', expiresAt: 1 } });
  assert.equal(past.passwordHash, undefined);
  assert.equal(past.invite, undefined);
  assert.equal(past.inviteExpired, true);
  assert.equal(publicUser(null), null);
});
