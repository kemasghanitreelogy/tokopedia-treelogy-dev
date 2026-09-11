/**
 * A tiny in-process TTL cache.
 *
 * Serverless instances are reused between requests, so caching here turns tab switching
 * and repeated refreshes into instant renders. It is deliberately short-lived and
 * process-local: order data goes stale quickly, and correctness after a write matters
 * more than a hit rate, so every write path invalidates rather than waits for expiry.
 */

const store = new Map();

/** In-flight requests are shared, so a burst of clicks makes one upstream call, not five. */
export function cached(key, ttlMs, factory) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expires > now) return hit.value;

  const value = Promise.resolve(factory()).catch((error) => {
    // A rejected promise must never be served to the next caller.
    store.delete(key);
    throw error;
  });

  store.set(key, { value, expires: now + ttlMs });
  return value;
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
