import { put, get } from '@vercel/blob';
import { loadConfig } from './config.js';

/**
 * Last-known-good snapshots, shared across serverless instances.
 *
 * The in-process cache dies with its instance, so a burst of traffic spread over several
 * instances hits the marketplaces from cold every time - which is how the rate limit was
 * tripped. A snapshot in Blob gives every instance the same recent copy, and, more
 * importantly, gives the page something truthful to show when an upstream call fails:
 * yesterday's number labelled as such beats an error page or, worse, a blank that reads
 * as "not listed".
 */

const PREFIX = 'snapshot/';

function blobToken() {
  return process.env.BLOB_READ_WRITE_TOKEN || loadConfig().blobToken || '';
}

export async function readSnapshot(name) {
  const token = blobToken();
  if (!token) return null;
  try {
    const result = await get(`${PREFIX}${name}.json`, { access: 'private', useCache: false, token });
    if (!result) return null;
    const body = JSON.parse(await new Response(result.stream).text());
    return { data: body.data, savedAt: body.saved_at };
  } catch {
    // A missing or corrupt snapshot must never be the reason a page fails.
    return null;
  }
}

export async function writeSnapshot(name, data) {
  const token = blobToken();
  if (!token) return;
  try {
    await put(`${PREFIX}${name}.json`, JSON.stringify({ saved_at: new Date().toISOString(), data }), {
      access: 'private', allowOverwrite: true, contentType: 'application/json',
      token, cacheControlMaxAge: 0,
    });
  } catch {
    // Best effort: failing to record a snapshot should not fail the request that produced it.
  }
}

/**
 * Read fresh data, fall back to the last good copy when a channel fails.
 *
 * `isComplete` decides what counts as worth keeping - a catalogue missing a whole channel
 * is not, or the next failure would fall back onto a half-empty snapshot and compound the
 * problem.
 */
export async function withFallback(name, fetcher, { isComplete = () => true, maxAgeMs = 30 * 60 * 1000 } = {}) {
  let fresh;
  try {
    fresh = await fetcher();
  } catch (error) {
    const snapshot = await readSnapshot(name);
    if (!snapshot) throw error;
    return { ...snapshot.data, stale: true, savedAt: snapshot.savedAt, reason: error.message };
  }

  if (isComplete(fresh)) {
    await writeSnapshot(name, fresh);
    return fresh;
  }

  // Partial: prefer a complete snapshot if it is recent enough to still be useful.
  const snapshot = await readSnapshot(name);
  const age = snapshot ? Date.now() - Date.parse(snapshot.savedAt) : Infinity;
  if (snapshot && age < maxAgeMs) {
    return { ...snapshot.data, stale: true, savedAt: snapshot.savedAt, partialNow: fresh.errors };
  }
  return fresh;
}
