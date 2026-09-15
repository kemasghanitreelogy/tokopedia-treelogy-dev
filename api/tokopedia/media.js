import { parseCookies, sessionValid, tokenMatches, COOKIE_NAME } from '../../src/dashboard-auth.js';
import { loadAllReviews } from '../../src/reviews/combined.js';
import { readCached, fetchMedia, attachmentIndex, safeId, safeSize } from '../../src/tokopedia/media.js';
import { cached } from '../../src/cache.js';

/**
 * One review photo, from our cache; fetched from the marketplace the first time it is
 * asked for, using the freshest URL the last sync recorded.
 *
 * Query: ?id=<attachment id>&s=thumb|full. Auth: the dashboard session, or ?key=.
 */
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const fail = (status, text) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
  };

  if (req.method !== 'GET') return fail(405, 'GET saja');
  const session = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const key = url.searchParams.get('key');
  if (!sessionValid(session) && !(key !== null && tokenMatches(key))) return fail(401, 'butuh sesi dashboard');

  const id = safeId(url.searchParams.get('id'));
  const size = safeSize(url.searchParams.get('s') ?? 'thumb');
  if (!id || !size) return fail(400, 'id atau ukuran tidak valid');

  let media = await readCached(id, size);
  if (!media) {
    const doc = await cached('reviews', 60_000, () => loadAllReviews().catch(() => null));
    const entry = attachmentIndex(doc).get(id);
    if (!entry) return fail(404, 'lampiran tidak dikenal');
    try {
      media = await fetchMedia({ id, size, url: entry[size] });
    } catch (error) {
      console.warn(`tokopedia/media ${id} ${size}: ${error.message}`);
      return fail(502, 'foto tidak bisa diambil dari marketplace saat ini');
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', media.type);
  res.setHeader('Content-Length', media.bytes.length);
  // The file under an attachment id never changes, so a day of browser cache is safe;
  // private because the URL is behind the dashboard session.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(media.bytes);
}
