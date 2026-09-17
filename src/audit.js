import crypto from 'node:crypto';
import { readDoc, updateDoc, listDocs } from './store/index.js';
import { wibDate } from './range.js';

/**
 * Who did what, on which menu, and what it was before.
 *
 * Every write the dashboard accepts passes through here on its way out: a stock number,
 * a price, a shipping arrangement, an invoice, an invitation. The entry names the person
 * (from their session, never from the form), the menu they were on, the thing they
 * touched and - for anything that had a previous value - what it was and what it became.
 * Failures are kept too: "tried to set MRS-002 to -4 and was refused" is part of the
 * story of that SKU.
 *
 * One document per WIB day, appended to atomically. Days keep each document small,
 * listing a month is one prefix scan, and there is nothing to rotate.
 */

export const AUDIT_PREFIX = 'audit/';
const MAX_CHANGES = 250;
const MAX_TEXT = 300;

/** Menus as the activity page names them. Keys match the dashboard's `view` ids. */
export const MENUS = {
  orders: 'Pesanan', process: 'Proses', picklist: 'Picklist', labels: 'Label', stock: 'Stok',
  products: 'Produk', jurnal: 'Jurnal', forecast: 'Prakiraan', reviews: 'Ulasan',
  users: 'Pengguna', auth: 'Masuk', activity: 'Aktivitas',
};

export const VERBS = {
  add: { label: 'Tambah', tone: 'good' },
  edit: { label: 'Ubah', tone: 'info' },
  delete: { label: 'Hapus', tone: 'bad' },
  sync: { label: 'Sinkron', tone: 'done' },
  print: { label: 'Cetak', tone: 'info' },
  send: { label: 'Kirim', tone: 'act' },
  login: { label: 'Masuk', tone: 'good' },
  logout: { label: 'Keluar', tone: 'muted' },
  invite: { label: 'Undang', tone: 'act' },
  activate: { label: 'Aktivasi', tone: 'good' },
};

const dayKey = (epochSeconds) => `${AUDIT_PREFIX}${wibDate(epochSeconds)}.json`;
const clip = (value) => {
  if (value === null || value === undefined) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : (typeof value === 'string' ? text : value);
};

/**
 * @typedef {object} Change
 * @property {string} field   what changed: a SKU, "harga", "peran", "qty"
 * @property {*} [from]       the previous value, if there was one
 * @property {*} [to]         the new value
 * @property {string} [note]  a per-line outcome such as an error message
 */

/**
 * @param {{
 *   actor: {id: string, email: string, name?: string},
 *   ip?: string,
 *   menu: string, action: string, verb?: string,
 *   target?: string, summary: string,
 *   changes?: Change[], status?: 'ok'|'failed', error?: string,
 * }} entry
 * @returns {Promise<object>} the stored entry. Never throws: the log must not break the action it records.
 */
export async function recordActivity(entry) {
  const at = Math.floor(Date.now() / 1000);
  const stored = {
    id: crypto.randomUUID(),
    at,
    actor: { id: entry.actor?.id ?? '?', email: entry.actor?.email ?? '', name: entry.actor?.name ?? '' },
    ip: entry.ip ?? '',
    menu: Object.hasOwn(MENUS, entry.menu) ? entry.menu : 'orders',
    action: String(entry.action ?? ''),
    verb: Object.hasOwn(VERBS, entry.verb) ? entry.verb : 'edit',
    target: clip(String(entry.target ?? '')),
    summary: clip(String(entry.summary ?? '')),
    status: entry.status === 'failed' ? 'failed' : 'ok',
    error: entry.error ? clip(String(entry.error)) : null,
    changes: (entry.changes ?? []).slice(0, MAX_CHANGES).map((c) => ({
      field: clip(String(c.field ?? '')),
      ...(c.from !== undefined ? { from: clip(c.from) } : {}),
      ...(c.to !== undefined ? { to: clip(c.to) } : {}),
      ...(c.note ? { note: clip(String(c.note)) } : {}),
    })),
    changesTruncated: (entry.changes?.length ?? 0) > MAX_CHANGES ? entry.changes.length : null,
  };
  try {
    await updateDoc(dayKey(at), (doc) => {
      const next = doc ?? { day: wibDate(at), entries: [] };
      next.entries.push(stored);
      return next;
    }, null);
  } catch (error) {
    console.error(`audit: gagal mencatat ${stored.action} oleh ${stored.actor.email}: ${error.message}`);
  }
  return stored;
}

/** Every WIB day from `from` to `to` inclusive, as YYYY-MM-DD, newest first. Capped at 92. */
export function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const days = [];
  for (let t = end; t >= start && days.length < 92; t -= 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Entries for a date range, newest first, with optional filters.
 *
 * @param {{from: string, to: string, actor?: string, menu?: string, status?: string, q?: string}} query
 */
export async function readActivity({ from, to, actor = '', menu = '', status = '', q = '' }) {
  const docs = await Promise.all(daysBetween(from, to).map((day) => readDoc(`${AUDIT_PREFIX}${day}.json`).catch(() => null)));
  const needle = q.trim().toLowerCase();
  const entries = [];
  for (const doc of docs) {
    for (const e of doc?.entries ?? []) {
      if (actor && e.actor.id !== actor) continue;
      if (menu && e.menu !== menu) continue;
      if (status && e.status !== status) continue;
      if (needle) {
        const hay = `${e.summary} ${e.target} ${e.action} ${e.actor.email} ${e.actor.name} ${e.error ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      entries.push(e);
    }
  }
  entries.sort((a, b) => b.at - a.at);
  return entries;
}

/** The people who appear in the log at all, for the filter chips. */
export function actorsIn(entries) {
  const seen = new Map();
  for (const e of entries) if (!seen.has(e.actor.id)) seen.set(e.actor.id, e.actor);
  return [...seen.values()].sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email, 'id'));
}

/** Which days have any activity at all, from the store listing; for the "terakhir" note. */
export async function activityDays() {
  const docs = await listDocs(AUDIT_PREFIX).catch(() => []);
  return docs.map((d) => d.key.slice(AUDIT_PREFIX.length).replace(/\.json$/, '')).sort().reverse();
}
