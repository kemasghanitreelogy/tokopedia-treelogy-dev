import crypto from 'node:crypto';
import { readDoc, updateDoc } from './store/index.js';
import { isEmail } from './mail/smtp.js';

/**
 * Who may open the dashboard, and what each of them may do.
 *
 * For a year the dashboard had one login: an email and a password in the environment.
 * That is fine for one person and wrong the moment there are two, because "who changed
 * the stock of MRS-002 to zero" then has exactly one possible answer and it is always the
 * same name. This module is what makes the answer mean something.
 *
 * The environment account stays. It is the owner, it is never stored, and it cannot be
 * locked out by anything in the store - losing Redis must not lose the front door.
 * Everyone else is a record in one small document: invited by email, activated by
 * choosing their own password on a link that only their inbox saw, and signed in with a
 * session that is bound to their own password hash, so changing or disabling it logs
 * them out everywhere at once.
 */

export const USERS_DOC = 'auth/users.json';
export const OWNER_ID = 'owner';

export const ROLES = {
  owner: { label: 'Pemilik', desc: 'Akun dari environment. Semua hak, tidak bisa diubah dari sini.' },
  admin: { label: 'Admin', desc: 'Semua menu, termasuk mengundang dan mengelola pengguna.' },
  operator: { label: 'Operator', desc: 'Mengubah stok, harga, pengiriman dan Jurnal. Tidak mengelola pengguna.' },
  viewer: { label: 'Peninjau', desc: 'Hanya melihat. Setiap tombol simpan ditolak.' },
};
/** Roles an admin may hand out. `owner` is not one of them. */
export const ASSIGNABLE_ROLES = ['admin', 'operator', 'viewer'];

export const STATUS = {
  invited: 'Diundang',
  active: 'Aktif',
  disabled: 'Nonaktif',
};

const PERMISSIONS = {
  write: new Set(['owner', 'admin', 'operator']),
  users: new Set(['owner', 'admin']),
};

/** @param {{role?: string, status?: string}|null|undefined} user */
export const can = (user, permission) =>
  Boolean(user && user.status === 'active' && PERMISSIONS[permission]?.has(user.role));

export const INVITE_TTL_SECONDS = 3 * 24 * 3600;
export const MIN_PASSWORD_LENGTH = 8;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

/* ---------------------------------------------------------------- passwords */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const expectedBuf = Buffer.from(expected, 'base64url');
  let key;
  try {
    key = crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64url'), expectedBuf.length, { N: Number(N), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  return key.length === expectedBuf.length && crypto.timingSafeEqual(key, expectedBuf);
}

/**
 * What a chosen password must satisfy. Returned as a message rather than thrown so the
 * activation page can show it next to the field.
 */
export function passwordProblem(password, confirm, { email = '' } = {}) {
  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD_LENGTH) return `Password minimal ${MIN_PASSWORD_LENGTH} karakter.`;
  if (pw.length > 200) return 'Password terlalu panjang.';
  if (pw !== String(confirm ?? '')) return 'Konfirmasi password tidak sama.';
  if (email && pw.toLowerCase() === normalizeEmail(email)) return 'Password tidak boleh sama dengan email.';
  if (/^(.)\1+$/.test(pw)) return 'Password tidak boleh satu karakter berulang.';
  return null;
}

/* ----------------------------------------------------------------- the doc */

const EMPTY = { version: 1, users: {} };

/** Everything the page may see. The hash and the invite token never leave this module. */
export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, invite, ...safe } = user;
  return {
    ...safe,
    inviteExpiresAt: invite?.expiresAt ?? null,
    inviteExpired: invite ? invite.expiresAt < nowSeconds() : false,
  };
}

/** The environment account, rendered as a user. */
export function ownerUser() {
  const email = normalizeEmail(process.env.DASHBOARD_EMAIL);
  if (!email) return null;
  return { id: OWNER_ID, email, name: process.env.DASHBOARD_NAME || 'Pemilik', role: 'owner', status: 'active', createdAt: null };
}

const loadDoc = async () => (await readDoc(USERS_DOC)) ?? structuredClone(EMPTY);

/** Owner first, then everyone else by name. */
export async function listUsers() {
  const doc = await loadDoc();
  const stored = Object.values(doc.users).map(publicUser).sort((a, b) => a.name.localeCompare(b.name, 'id'));
  const owner = ownerUser();
  return owner ? [owner, ...stored] : stored;
}

/** The raw record, hash and all. Internal to auth; pages get publicUser. */
export async function findUser(id) {
  if (!id) return null;
  if (id === OWNER_ID) return ownerUser();
  const doc = await loadDoc();
  return doc.users[id] ?? null;
}

export async function findByEmail(email) {
  const wanted = normalizeEmail(email);
  if (!wanted) return null;
  const owner = ownerUser();
  if (owner && owner.email === wanted) return owner;
  const doc = await loadDoc();
  return Object.values(doc.users).find((u) => u.email === wanted) ?? null;
}

/* --------------------------------------------------------------- invitations */

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const newInvite = () => {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, invite: { tokenHash: tokenHash(token), expiresAt: nowSeconds() + INVITE_TTL_SECONDS } };
};

/**
 * @param {{email: string, name: string, role: string, by: {id: string, email: string}}} input
 * @returns {Promise<{user: object, token: string}>} the stored record and the one-time token for the link
 */
export async function inviteUser({ email, name, role, by }) {
  const address = normalizeEmail(email);
  if (!isEmail(address)) throw new Error('alamat email tidak valid');
  const displayName = String(name ?? '').trim();
  if (!displayName) throw new Error('nama wajib diisi');
  if (displayName.length > 80) throw new Error('nama terlalu panjang');
  if (!ASSIGNABLE_ROLES.includes(role)) throw new Error('peran tidak dikenal');
  const owner = ownerUser();
  if (owner && owner.email === address) throw new Error('alamat itu milik akun pemilik');

  const { token, invite } = newInvite();
  const id = crypto.randomUUID();
  const record = {
    id, email: address, name: displayName, role, status: 'invited',
    createdAt: nowSeconds(), invitedBy: { id: by.id, email: by.email }, invitedAt: nowSeconds(),
    activatedAt: null, lastLoginAt: null, passwordHash: null, invite,
  };

  const doc = await updateDoc(USERS_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY);
    if (Object.values(next.users).some((u) => u.email === address)) {
      throw new Error(`${address} sudah terdaftar`);
    }
    next.users[id] = record;
    return next;
  }, structuredClone(EMPTY));

  return { user: publicUser(doc.users[id]), token };
}

/** A fresh link for someone whose first one expired or never arrived. */
export async function renewInvite(id, by) {
  const { token, invite } = newInvite();
  let renewed = null;
  await updateDoc(USERS_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY);
    const user = next.users[id];
    if (!user) throw new Error('pengguna tidak ditemukan');
    if (user.status !== 'invited') throw new Error(`${user.email} sudah aktif, tidak perlu undangan baru`);
    user.invite = invite;
    user.invitedAt = nowSeconds();
    user.invitedBy = { id: by.id, email: by.email };
    renewed = user;
    return next;
  }, structuredClone(EMPTY));
  return { user: publicUser(renewed), token };
}

/** The invited user a token points at, or null when it is unknown, used or expired. */
export async function findInvite(token) {
  if (!token || String(token).length < 20) return null;
  const hash = tokenHash(token);
  const doc = await loadDoc();
  const user = Object.values(doc.users).find((u) => u.invite?.tokenHash === hash);
  if (!user || user.status !== 'invited') return null;
  if (user.invite.expiresAt < nowSeconds()) return null;
  return publicUser(user);
}

/**
 * The invitee sets their password. The token is checked again inside the transaction,
 * so two submissions of the same form cannot both succeed.
 */
export async function activateUser({ token, password, confirm }) {
  const hash = tokenHash(token ?? '');
  let activated = null;
  await updateDoc(USERS_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY);
    const user = Object.values(next.users).find((u) => u.invite?.tokenHash === hash);
    if (!user || user.status !== 'invited') throw new Error('tautan undangan tidak berlaku');
    if (user.invite.expiresAt < nowSeconds()) throw new Error('tautan undangan sudah kedaluwarsa');
    const problem = passwordProblem(password, confirm, { email: user.email });
    if (problem) throw new Error(problem);
    user.passwordHash = hashPassword(password);
    user.invite = null;
    user.status = 'active';
    user.activatedAt = nowSeconds();
    activated = user;
    return next;
  }, structuredClone(EMPTY));
  return activated;
}

/* -------------------------------------------------------------- management */

/**
 * @param {string} id
 * @param {{role?: string, status?: 'active'|'disabled', name?: string}} patch
 * @returns {Promise<{before: object, after: object}>} public views, for the activity log
 */
export async function updateUser(id, patch) {
  if (id === OWNER_ID) throw new Error('akun pemilik diatur lewat environment, bukan dari sini');
  let before = null;
  let after = null;
  await updateDoc(USERS_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY);
    const user = next.users[id];
    if (!user) throw new Error('pengguna tidak ditemukan');
    before = publicUser(structuredClone(user));
    if (patch.role !== undefined) {
      if (!ASSIGNABLE_ROLES.includes(patch.role)) throw new Error('peran tidak dikenal');
      user.role = patch.role;
    }
    if (patch.status !== undefined) {
      if (patch.status !== 'active' && patch.status !== 'disabled') throw new Error('status tidak dikenal');
      if (user.status === 'invited') throw new Error(`${user.email} belum mengaktifkan akunnya`);
      user.status = patch.status;
    }
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error('nama wajib diisi');
      user.name = name.slice(0, 80);
    }
    after = publicUser(structuredClone(user));
    return next;
  }, structuredClone(EMPTY));
  return { before, after };
}

export async function removeUser(id) {
  if (id === OWNER_ID) throw new Error('akun pemilik tidak bisa dihapus');
  let removed = null;
  await updateDoc(USERS_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY);
    if (!next.users[id]) throw new Error('pengguna tidak ditemukan');
    removed = publicUser(next.users[id]);
    delete next.users[id];
    return next;
  }, structuredClone(EMPTY));
  return removed;
}

/* ------------------------------------------------------------------- login */

/**
 * A stored user signing in. The owner is checked by the caller against the environment;
 * this only knows about records with a hash. Returns the raw record on success.
 */
export async function verifyLogin(email, password) {
  const user = await findByEmail(email);
  if (!user || user.id === OWNER_ID) return null;
  if (user.status !== 'active' || !user.passwordHash) return null;
  return verifyPassword(password, user.passwordHash) ? user : null;
}

/** Best effort: a login is not made to fail because a timestamp could not be written. */
export async function touchLogin(id) {
  if (id === OWNER_ID) return;
  try {
    await updateDoc(USERS_DOC, (current) => {
      const next = current ?? structuredClone(EMPTY);
      if (next.users[id]) next.users[id].lastLoginAt = nowSeconds();
      return next;
    }, structuredClone(EMPTY));
  } catch { /* ignore */ }
}
