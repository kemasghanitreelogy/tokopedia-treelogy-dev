import { loadConfig, redirectUri } from '../src/config.js';
import { loadTokenBundle } from '../src/token-store.js';
import { isSupabaseConfigured } from '../src/db/client.js';
import { readCoverage, dbStats } from '../src/db/orders.js';
import { activeSources } from '../src/orders-source.js';

/**
 * Deployment health check. Reports whether the environment is wired up and whether a
 * token bundle exists - never the tokens themselves.
 */
export default async function handler(req, res) {
  const config = loadConfig();

  let tokenState = 'absent';
  let savedAt = null;
  let shopName = null;

  try {
    const bundle = await loadTokenBundle();
    if (bundle) {
      tokenState = 'present';
      savedAt = bundle.saved_at ?? null;
      shopName = bundle.shop?.name ?? bundle.shop?.shop_name ?? null;
    }
  } catch (error) {
    tokenState = `error: ${error.name}`;
  }

  /**
   * Whether the dashboard is being served from the database or still from the platforms.
   *
   * This is the one fact a health check cannot leave out now: the page looks identical
   * either way, so without it an ingest that quietly stopped would show up only as the
   * site being slow again, and nobody reads slowness as an outage.
   */
  //
  // Bounded hard, and asked only once. The deploy script's health check is this endpoint
  // with a twenty-second ceiling, so the moment it started calling an external service it
  // also started being able to fail a good deploy because that service was slow - which
  // is exactly what happened the first time, and rolled a healthy release back. A report
  // that says "the database did not answer in three seconds" is useful; an endpoint that
  // hangs waiting to find out is not.
  const PROBE = { timeout: 3_000, retries: 1 };
  let database = { configured: isSupabaseConfigured() };
  if (database.configured) {
    try {
      const [stats, coverage] = await Promise.all([dbStats(PROBE), readCoverage(PROBE)]);
      const sources = activeSources();
      database = {
        configured: true,
        orders: stats?.orders ?? null,
        serving: sources.filter((source) => coverage[source]),
        live_only: sources.filter((source) => !coverage[source]),
        coverage: Object.fromEntries(Object.entries(coverage).map(([source, w]) => [
          source,
          { from: new Date(w.from * 1000).toISOString(), through: new Date(w.through * 1000).toISOString(), at: w.at },
        ])),
      };
    } catch (error) {
      database = { configured: true, error: error.message };
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify(
      {
        ok: true,
        redirect_url: redirectUri(config),
        env: {
          APP_KEY: Boolean(config.appKey),
          APP_SECRET: Boolean(config.appSecret),
          SERVICE_ID: Boolean(config.serviceId),
          BLOB_READ_WRITE_TOKEN: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
          SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
          SUPABASE_SECRET_KEY: Boolean(process.env.SUPABASE_SECRET_KEY),
        },
        tokens: { state: tokenState, saved_at: savedAt, shop: shopName },
        database,
      },
      null,
      2,
    ),
  );
}
