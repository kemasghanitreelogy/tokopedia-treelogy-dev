import { loadConfig } from '../config.js';

/**
 * Where the application's state lives, behind one door.
 *
 * Every piece of state here is a small JSON document with a path-like key: token
 * bundles, the invoice ledger, heartbeats, sales history by month. Ten modules used to
 * talk to Vercel Blob directly; when the Blob store was suspended for exceeding the
 * Hobby quota, all ten went down together and none of their data could be read back.
 *
 * Two backends, chosen by environment:
 *
 *   sqlite  one file on local disk via node:sqlite - ACID, transactional, no service to
 *           run, no quota. The default on the VPS. `updateDoc` is a real transaction, so
 *           two writers can no longer lose each other's changes.
 *   blob    Vercel Blob, kept for the Vercel deployment. `updateDoc` there is
 *           read-then-write and only narrows the race, as before.
 *
 * STATE_BACKEND=sqlite|blob picks explicitly; otherwise sqlite when STATE_DB_PATH is set,
 * blob when a Blob token is, sqlite in a temp dir when neither (tests, local dry runs).
 */

const env = (key) => process.env[key] ?? '';

export function backendName() {
  const explicit = env('STATE_BACKEND').toLowerCase();
  if (explicit === 'sqlite' || explicit === 'blob' || explicit === 'redis') return explicit;
  // The suite must never touch a real store, whatever the local .env holds - unless a
  // Redis is pointed at on purpose (STATE_BACKEND=redis) to test that backend.
  if (process.env.NODE_TEST_CONTEXT) return 'sqlite';
  if (env('REDIS_URL')) return 'redis';
  if (env('STATE_DB_PATH')) return 'sqlite';
  if (process.env.BLOB_READ_WRITE_TOKEN || loadConfig().blobToken) return 'blob';
  return 'sqlite';
}

/* ------------------------------------------------------------------ sqlite */

let db = null;
let dbPath = null;

async function sqlite() {
  const wanted = env('STATE_DB_PATH') || defaultDbPath();
  if (db && dbPath === wanted) return db;
  const { DatabaseSync } = await import('node:sqlite');
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(wanted), { recursive: true });
  db = new DatabaseSync(wanted);
  dbPath = wanted;
  // WAL lets the dashboard read while a sweep writes; synchronous=NORMAL is durable
  // enough for a ledger that is also reconstructible from Jurnal.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS docs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  return db;
}

function defaultDbPath() {
  if (process.env.NODE_TEST_CONTEXT) {
    return `${process.env.TMPDIR || '/tmp'}/treelogy-test-${process.pid}.sqlite`;
  }
  return `${process.cwd()}/state/treelogy.sqlite`;
}

const sqliteBackend = {
  async read(key) {
    const row = (await sqlite()).prepare('SELECT value FROM docs WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  },
  async write(key, value) {
    (await sqlite()).prepare(
      'INSERT INTO docs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(key, JSON.stringify(value), new Date().toISOString());
  },
  async update(key, fn, initial) {
    const d = await sqlite();
    // BEGIN IMMEDIATE takes the write lock up front, so the read inside cannot be stale by
    // the time the write lands - the property the Blob backend never had.
    d.exec('BEGIN IMMEDIATE');
    try {
      const row = d.prepare('SELECT value FROM docs WHERE key = ?').get(key);
      const current = row ? JSON.parse(row.value) : structuredClone(initial ?? null);
      const next = fn(current);
      d.prepare(
        'INSERT INTO docs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ).run(key, JSON.stringify(next), new Date().toISOString());
      d.exec('COMMIT');
      return next;
    } catch (error) {
      d.exec('ROLLBACK');
      throw error;
    }
  },
  async list(prefix) {
    return (await sqlite()).prepare('SELECT key, length(value) AS size, updated_at FROM docs WHERE key LIKE ? ORDER BY key')
      .all(`${prefix}%`).map((r) => ({ key: r.key, size: r.size, updatedAt: r.updated_at }));
  },
  async remove(key) {
    (await sqlite()).prepare('DELETE FROM docs WHERE key = ?').run(key);
  },
};

/* ------------------------------------------------------------------- redis */

/**
 * Redis on the VPS: every document is one string under `treelogy:<key>`.
 *
 * Two things make this the production backend rather than a cache:
 *   - `updateDoc` is WATCH / MULTI / EXEC with retry, so a webhook and a sweep updating
 *     the ledger at the same instant both land - the guarantee Blob never gave.
 *   - The setup script turns on AOF (`appendonly yes`, fsync every second). Ubuntu's
 *     default is RDB snapshots at most every few minutes, which would make a crash cost
 *     the last few minutes of ledger. With AOF it costs at most one second.
 *
 * One client per process, connected lazily and reconnecting on its own; the server, the
 * sweep and the CLI each hold their own.
 */
const REDIS_PREFIX = env('REDIS_PREFIX') || 'treelogy:';
let redisClient = null;

async function redis() {
  if (redisClient?.isOpen) return redisClient;
  const { createClient } = await import('redis');
  redisClient = createClient({
    url: env('REDIS_URL') || 'redis://127.0.0.1:6379',
    socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 3000), connectTimeout: 5000 },
  });
  redisClient.on('error', (error) => console.error(`redis: ${error.message}`));
  await redisClient.connect();
  return redisClient;
}

const rkey = (key) => `${REDIS_PREFIX}${key}`;

const redisBackend = {
  async read(key) {
    const raw = await (await redis()).get(rkey(key));
    return raw === null ? null : JSON.parse(raw);
  },
  async write(key, value) {
    await (await redis()).set(rkey(key), JSON.stringify(value));
  },
  async update(key, fn, initial) {
    const client = await redis();
    // Optimistic concurrency: watch the key, compute, commit only if it did not change
    // underneath us; otherwise read again and recompute. Contention here is a handful of
    // writers a minute, so a retry is rare and cheap.
    for (let attempt = 0; attempt < 20; attempt++) {
      const isolated = client.duplicate();
      await isolated.connect();
      try {
        await isolated.watch(rkey(key));
        const raw = await isolated.get(rkey(key));
        const current = raw === null ? structuredClone(initial ?? null) : JSON.parse(raw);
        const next = fn(current);
        // node-redis v5 reports an aborted EXEC by throwing WatchError; older clients
        // returned null. Both mean "somebody wrote first, go again".
        const result = await isolated.multi().set(rkey(key), JSON.stringify(next)).exec();
        if (result !== null) return next;
      } catch (error) {
        if (error?.name !== 'WatchError' && !/watched keys/i.test(error?.message ?? '')) throw error;
      } finally {
        await isolated.quit().catch(() => {});
      }
    }
    throw new Error(`redis: ${key} terus berubah, update dibatalkan setelah 20 percobaan`);
  },
  async list(prefix) {
    const client = await redis();
    const out = [];
    for await (const batch of client.scanIterator({ MATCH: `${rkey(prefix)}*`, COUNT: 200 })) {
      for (const full of (Array.isArray(batch) ? batch : [batch])) {
        const size = await client.strLen(full);
        out.push({ key: full.slice(REDIS_PREFIX.length), size, updatedAt: null });
      }
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  },
  async remove(key) {
    await (await redis()).del(rkey(key));
  },
};

/* -------------------------------------------------------------------- blob */

const blobToken = () => process.env.BLOB_READ_WRITE_TOKEN || loadConfig().blobToken || '';

const blobBackend = {
  async read(key) {
    const token = blobToken();
    if (!token) return null;
    const { get } = await import('@vercel/blob');
    const result = await get(key, { access: 'private', useCache: false, token });
    if (!result) return null;
    return JSON.parse(await new Response(result.stream).text());
  },
  async write(key, value) {
    const token = blobToken();
    if (!token) throw new Error('BLOB_READ_WRITE_TOKEN tidak ada');
    const { put } = await import('@vercel/blob');
    await put(key, JSON.stringify(value), {
      access: 'private', allowOverwrite: true, contentType: 'application/json', token, cacheControlMaxAge: 0,
    });
  },
  async update(key, fn, initial) {
    const current = (await this.read(key).catch(() => null)) ?? structuredClone(initial ?? null);
    const next = fn(current);
    await this.write(key, next);
    return next;
  },
  async list(prefix) {
    const token = blobToken();
    if (!token) return [];
    const { list } = await import('@vercel/blob');
    const out = [];
    let cursor;
    do {
      const page = await list({ token, prefix, cursor, limit: 1000 });
      out.push(...page.blobs.map((b) => ({ key: b.pathname, size: b.size, updatedAt: b.uploadedAt })));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },
  async remove(key) {
    const token = blobToken();
    if (!token) return;
    const { del } = await import('@vercel/blob');
    await del(key, { token });
  },
};

const backend = () => {
  const name = backendName();
  if (name === 'blob') return blobBackend;
  if (name === 'redis') return redisBackend;
  return sqliteBackend;
};

/** Close whatever is open; for a clean process exit in the CLI and timers. */
export async function closeStore() {
  if (redisClient?.isOpen) await redisClient.quit().catch(() => {});
  redisClient = null;
  resetStore();
}

/** @returns {Promise<any|null>} the document, or null when there is none. Never throws on absence. */
export const readDoc = (key) => backend().read(key);
export const writeDoc = (key, value) => backend().write(key, value);
/** Atomic read-modify-write. `fn` must be synchronous and return the next document. */
export const updateDoc = (key, fn, initial = null) => backend().update(key, fn, initial);
export const listDocs = (prefix = '') => backend().list(prefix);
export const deleteDoc = (key) => backend().remove(key);

/** For tests: forget the open database so the next call re-opens at the current path. */
export function resetStore() {
  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = null;
  dbPath = null;
}
