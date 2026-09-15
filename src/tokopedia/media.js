import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

/**
 * Review photos, kept on our own disk.
 *
 * Tokopedia serves review attachments through signed URLs that expire in about three
 * days. A page that hot-linked them would show broken images the moment a nightly sync
 * was missed, and every viewer would pull each photo from Tokopedia again. So the first
 * time a photo is needed - by the sync, or by the dashboard on demand - it is fetched
 * once and stored under its attachment id, which never changes. The page only ever
 * links to /api/tokopedia/media, which serves from here.
 */

export const MEDIA_SIZES = ['thumb', 'full'];
const MAX_BYTES = 8 * 1024 * 1024;

export const mediaDir = () => process.env.TOKOPEDIA_MEDIA_DIR || resolve(process.cwd(), 'state', 'tokopedia-media');

/** Attachment ids are numeric; anything else never reaches the filesystem. */
export const safeId = (id) => (/^\d{1,24}$/.test(String(id ?? '')) ? String(id) : null);
export const safeSize = (size) => (MEDIA_SIZES.includes(size) ? size : null);

export const mediaFile = (id, size) => join(mediaDir(), `${id}-${size}`);
export const mediaUrl = (id, size = 'thumb') => `/api/tokopedia/media?id=${encodeURIComponent(id)}&s=${size}`;

/** The image type from its first bytes; the CDN's Content-Type is not always honest. */
export function sniffType(bytes) {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.length >= 6 && b.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return null;
}

export async function readCached(id, size) {
  try {
    const bytes = await readFile(mediaFile(id, size));
    const type = sniffType(bytes);
    return type ? { bytes, type } : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Download one attachment and keep it. Written to a temp name and renamed, so a reader
 * never sees half a file, and a failed download leaves nothing behind.
 */
export async function fetchMedia({ id, size, url, fetchImpl = fetchWithTimeout }) {
  if (!url) throw new Error(`tidak ada URL untuk lampiran ${id}`);
  const response = await fetchImpl(url, { timeout: TIMEOUTS.download, headers: { Accept: 'image/*' } });
  if (!response.ok) throw new Error(`lampiran ${id}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`lampiran ${id}: ${bytes.length} byte, terlalu besar`);
  const type = sniffType(bytes);
  if (!type) throw new Error(`lampiran ${id}: bukan gambar`);

  await mkdir(mediaDir(), { recursive: true });
  const final = mediaFile(id, size);
  const temp = `${final}.${process.pid}.tmp`;
  try {
    await writeFile(temp, bytes);
    await rename(temp, final);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { bytes, type };
}

export async function ensureMedia({ id, size, url, fetchImpl }) {
  return (await readCached(id, size)) ?? fetchMedia({ id, size, url, fetchImpl });
}

/** attachment id -> the freshest signed URLs and the review it belongs to. */
export function attachmentIndex(doc) {
  const index = new Map();
  for (const review of Object.values(doc?.reviews ?? {})) {
    for (const image of review.images ?? []) {
      if (safeId(image.id)) index.set(image.id, { thumb: image.thumbnail, full: image.full, reviewId: review.id });
    }
  }
  return index;
}

/**
 * Warm the cache for a set of reviews, both sizes, a few at a time.
 *
 * Bounded by `limit` files per call so a first import of a shop with thousands of
 * photos stays a few minutes and never runs the nightly job into its timeout; whatever
 * is left gets fetched the first time someone looks at it.
 */
export async function prefetchMedia(reviews, { limit = 600, concurrency = 3, fetchImpl, log = () => {} } = {}) {
  const jobs = [];
  for (const review of reviews) {
    for (const image of review.images ?? []) {
      if (!safeId(image.id)) continue;
      jobs.push({ id: image.id, size: 'thumb', url: image.thumbnail });
      jobs.push({ id: image.id, size: 'full', url: image.full });
    }
  }
  // What is already on disk costs nothing and must not use up the limit, or a second
  // run would count the same six hundred cached files again and never reach the rest.
  const result = { fetched: 0, cached: 0, failed: 0, deferred: 0 };
  const queue = [];
  for (const job of jobs) {
    if (await readCached(job.id, job.size)) result.cached++;
    else if (queue.length < limit) queue.push(job);
    else result.deferred++;
  }

  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        await fetchMedia({ ...job, fetchImpl });
        result.fetched++;
      } catch (error) {
        result.failed++;
        log(`  foto ${job.id} (${job.size}): ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return result;
}
