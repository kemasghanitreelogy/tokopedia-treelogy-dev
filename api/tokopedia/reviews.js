import { parseCookies, sessionValid, tokenMatches, COOKIE_NAME } from '../../src/dashboard-auth.js';
import { selectReviews, reviewStats } from '../../src/tokopedia/reviews.js';
import { loadAllReviews, REVIEW_CHANNELS } from '../../src/reviews/combined.js';

/**
 * Stored reviews from both marketplaces as JSON, for the dashboard and for anything
 * else that wants them. Read-only: the syncs run from the CLI on their own schedule,
 * and a web request never triggers a crawl.
 *
 * Query: ?channel=shopee|tokopedia  ?rating=1,2,3  ?sku=OMC-180-001  ?product=<id>  ?days=30  ?text=1  ?limit=50  ?stats=1
 * Auth: the dashboard session cookie, or ?key=<dashboard token>.
 */
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body, null, 2));
  };

  if (req.method !== 'GET') return send(405, { ok: false, error: 'GET saja' });

  const session = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const key = url.searchParams.get('key');
  if (!(await sessionValid(session)) && !(key !== null && tokenMatches(key))) return send(401, { ok: false, error: 'butuh sesi dashboard' });

  const doc = await loadAllReviews();
  const days = Number(url.searchParams.get('days')) || 0;
  const ratings = url.searchParams.get('rating')?.split(',').map(Number).filter((n) => n >= 1 && n <= 5);
  const channel = url.searchParams.get('channel');
  const reviews = selectReviews(doc, {
    channel: REVIEW_CHANNELS[channel] ? channel : undefined,
    ratings,
    sku: url.searchParams.get('sku') ?? undefined,
    productId: url.searchParams.get('product') ?? undefined,
    sinceEpoch: days ? Math.floor(Date.now() / 1000) - days * 86400 : undefined,
    withText: url.searchParams.get('text') === '1',
    limit: Number(url.searchParams.get('limit')) || undefined,
  });

  return send(200, {
    ok: true,
    syncedAt: doc.syncedAt,
    channels: doc.channels,
    stats: url.searchParams.get('stats') === '1' ? reviewStats(doc) : undefined,
    count: reviews.length,
    reviews,
  });
}
