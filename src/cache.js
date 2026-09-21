/**
 * A tiny in-process cache that would rather be stale than slow.
 *
 * The dashboard reads the same window of orders on every menu, and the database that
 * answers it sits in Sydney: a quarter of a second on a good day, and now and then a
 * request that never comes back. A cache that expired every five seconds put that wait
 * in front of nearly every click, and a timeout behind it fell through to four
 * marketplaces and ten seconds of skeleton.
 *
 * So an entry has two lives. While fresh it is simply returned. Past `ttlMs` and within
 * `staleMs` it is still returned - at once - and one refresh is started behind it, so the
 * next click sees the newer data and no click waits for it. A refresh that fails keeps
 * the stale value on screen rather than an error, and backs off before trying again.
 * Only an entry nobody has asked for in `staleMs` is fetched in the caller's face.
 *
 * Correctness after a write still matters more than any hit rate: every write path
 * invalidates, so the next read after a change is a real one.
 */

const store = new Map();
const RETRY_AFTER_FAILURE_MS = 5_000;

/**
 * @param {string} key
 * @param {number} ttlMs   how long a value is fresh
 * @param {() => any} factory
 * @param {{staleMs?: number}} [options]  how long past fresh it may still be served while refreshing
 */
export function cached(key, ttlMs, factory, { staleMs = 0 } = {}) {
  const now = Date.now();
  const hit = store.get(key);

  // Fresh, or still being fetched: everybody shares the one promise.
  if (hit && hit.expires > now) return hit.value;

  // Stale but usable: hand back what we have and refresh once, behind the caller.
  if (hit && hit.settled && hit.staleUntil > now) {
    if (!hit.refreshing) {
      hit.refreshing = Promise.resolve()
        .then(factory)
        .then((value) => {
          if (store.get(key) === hit) {
            store.set(key, { value: Promise.resolve(value), settled: true, expires: Date.now() + ttlMs, staleUntil: Date.now() + ttlMs + staleMs, refreshing: null });
          }
        })
        .catch((error) => {
          console.warn(`cache: pembaruan ${key} gagal, tetap memakai data lama - ${error.message}`);
          hit.refreshing = null;
          hit.expires = Date.now() + RETRY_AFTER_FAILURE_MS;
        });
    }
    return hit.value;
  }

  const entry = { value: null, settled: false, expires: now + ttlMs, staleUntil: now + ttlMs + staleMs, refreshing: null };
  entry.value = Promise.resolve()
    .then(factory)
    .then((value) => { entry.settled = true; return value; })
    .catch((error) => {
      // A rejected promise must never be served to the next caller.
      if (store.get(key) === entry) store.delete(key);
      throw error;
    });
  store.set(key, entry);
  return entry.value;
}

export function invalidate(prefix = '') {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export const cacheSize = () => store.size;
