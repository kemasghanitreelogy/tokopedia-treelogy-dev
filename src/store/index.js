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
  /*
   * The test runner never touches a real store, and this check comes FIRST.
   *
   * It used to come after STATE_BACKEND, which was a loaded gun: the deploy script runs
   * `npm test` with the production environment file loaded, so the suite would have
   * connected to the production Redis - and one of its tests deletes the TikTok token
   * bundle. Every deploy would have wiped it. Testing a real Redis on purpose is still
   * possible, but it needs its own variable that production never sets.
   */
  if (process.env.NODE_TEST_CONTEXT) {
    return env('STATE_BACKEND_TEST').toLowerCase() === 'redis' ? 'redis' : 'sqlite';
  }
  const explicit = env('STATE_BACKEND').toLowerCase();
  if (explicit === 'sqlite' || explicit === 'blob' || explicit === 'redis') return explicit;
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
let pool = null;

/**
 * One connection pool per process, not one connection per transaction.
 *
 * WATCH has to run on a connection nobody else is using, and the first version of this
 * got that by calling duplicate() + connect() + quit() around every update - a full TCP
 * handshake per ledger write. Production showed ten open connections and eighty-six
 * handshakes for a handful of operations. node-redis has a pool for exactly this:
 * ordinary commands go straight through it, and `execute` lends out a private connection
 * for the length of a transaction and takes it back afterwards.
 */
async function redis() {
  if (pool) return pool;
  const { createClientPool } = await import('redis');
  pool = createClientPool(
    {
      url: env('REDIS_URL') || 'redis://127.0.0.1:6379',
      socket: { reconnectStrategy: (retries) => Math.min(retries * 100, 3000), connectTimeout: 5000 },
    },
    // Two is enough for a web process plus one transaction in flight; four gives the
    // sweeps headroom without holding connections open for nothing.
    { minimum: 1, maximum: 4, acquireTimeout: 10_000 },
  );
  pool.on('error', (error) => console.error(`redis: ${error.message}`));
  await pool.connect();
  return pool;
}

const rkey = (key) => `${REDIS_PREFIX}${key}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One update per key at a time within this process.
 *
 * WATCH handles writers in *other* processes, but it handles them by making the loser
 * start over - and twenty-five callers inside one process all retrying at the same
 * instant just collide again, until they run out of attempts. Queueing them locally means
 * each one does a single clean round trip, and WATCH is left to do the job it is good at:
 * catching the webhook that arrived while the sweep was mid-update.
 */
const inFlight = new Map();

function queued(key, run) {
  const previous = inFlight.get(key) ?? Promise.resolve();
  const mine = previous.then(run, run);
  // The chain the next caller waits on swallows outcomes, so one failed update does not
  // reject every update queued behind it. Only `mine` is returned, so the caller's own
  // error handling is the only handling that matters - a stray derived promise here
  // would surface as an unhandled rejection and fail the process.
  inFlight.set(key, mine.then(() => {}, () => {}));
  return mine;
}

const redisBackend = {
  /*
   * A sliding-window reservation shared by every process.
   *
   * On the VPS the web service, the 15-minute sweep and the daily job are three separate
   * processes, each of which used to keep its own in-memory budget of 34 requests a
   * minute against a Jurnal limit of about 40. Two of them running at once was already
   * over. The window lives in Redis so the budget belongs to the account, not to one
   * process.
   */
  async reserveSlot(key, limit, windowMs) {
    const client = await redis();
    const k = rkey(`rate:${key}`);
    const now = Date.now();
    await client.zRemRangeByScore(k, 0, now - windowMs);
    const used = await client.zCard(k);
    if (used < limit) {
      await client.zAdd(k, { score: now, value: `${now}:${Math.random().toString(36).slice(2, 8)}` });
      await client.pExpire(k, windowMs * 2);
      return 0;
    }
    const oldest = await client.zRangeWithScores(k, 0, 0);
    const freesAt = (oldest[0]?.score ?? now) + windowMs;
    return Math.max(50, freesAt - now + 50);
  },

  async read(key) {
    const raw = await (await redis()).get(rkey(key));
    return raw === null ? null : JSON.parse(raw);
  },
  async write(key, value) {
    await (await redis()).set(rkey(key), JSON.stringify(value));
  },
  update(key, fn, initial) {
    return queued(key, () => this.updateNow(key, fn, initial));
  },
  async updateNow(key, fn, initial) {
    const client = await redis();
    // Optimistic concurrency across processes: watch the key, compute, commit only if it
    // did not change underneath us; otherwise read again and recompute. A short random
    // backoff keeps two processes from retrying in lockstep forever.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const next = await client.execute(async (isolated) => {
          await isolated.watch(rkey(key));
          const raw = await isolated.get(rkey(key));
          const candidate = fn(raw === null ? structuredClone(initial ?? null) : JSON.parse(raw));
          const result = await isolated.multi().set(rkey(key), JSON.stringify(candidate)).exec();
          return result === null ? undefined : candidate;
        });
        if (next !== undefined) return next;
      } catch (error) {
        // node-redis reports an aborted EXEC as WatchError; older clients returned null.
        // Both mean "somebody wrote first, go again".
        if (error?.name !== 'WatchError' && !/watched keys/i.test(error?.message ?? '')) throw error;
      }
      await sleep(10 + Math.random() * 40);
    }
    throw new Error(`redis: ${key} terus berubah, update dibatalkan setelah 20 percobaan`);
  },

  async list(prefix) {
    const client = await redis();
    // Borrow one connection for the whole listing: scanIterator is a client helper, and a
    // scan spread across pooled connections would be several independent cursors.
    return client.execute(async (isolated) => {
      const keys = [];
      for await (const batch of isolated.scanIterator({ MATCH: `${rkey(prefix)}*`, COUNT: 500 })) {
        keys.push(...(Array.isArray(batch) ? batch : [batch]));
      }
      if (keys.length === 0) return [];
      // One pipeline rather than a round trip per key: listing history is forty-odd keys
      // today and grows by one a month per channel.
      const sizes = await Promise.all(keys.map((k) => isolated.strLen(k)));
      return keys
        .map((k, i) => ({ key: k.slice(REDIS_PREFIX.length), size: sizes[i], updatedAt: null }))
        .sort((a, b) => a.key.localeCompare(b.key));
    });
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
  if (pool) await pool.close().catch(() => {});
  pool = null;
  resetStore();
}

/** @returns {Promise<any|null>} the document, or null when there is none. Never throws on absence. */
/**
 * Ask for permission to make one rate-limited request.
 *
 * @returns {Promise<number>} 0 when there is room now, otherwise milliseconds to wait.
 *   A backend with no shared view returns 0 and leaves the caller's own budget in charge.
 */
export const reserveSlot = (key, limit, windowMs) => {
  const b = backend();
  return b.reserveSlot ? b.reserveSlot(key, limit, windowMs) : Promise.resolve(0);
};

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
