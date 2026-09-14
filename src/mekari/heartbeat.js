import { readDoc, writeDoc } from '../store/index.js';

/**
 * When did each part of the sync last show signs of life.
 *
 * A webhook channel that goes silent looks exactly like a quiet day, and a sweep that
 * stopped running looks exactly like one with nothing to do. Recording the last time each
 * one actually did something is what turns "no news" into either "all fine" or "go look",
 * and the Jurnal tab reads this to say which.
 */

export const HEARTBEAT_PATHNAME = 'mekari/heartbeat.json';

/**
 * No Blob token under the test runner, whatever .env says.
 *
 * The suite drives the webhook handlers with forged pushes on purpose, and each rejection
 * writes a heartbeat. With a real token in the local .env those writes landed in the
 * production heartbeat and showed five Shopee rejections that never happened. node:test
 * marks its processes with NODE_TEST_CONTEXT, which is the cleanest way to tell.
 */
const testing = () => Boolean(process.env.NODE_TEST_CONTEXT);

export async function loadHeartbeat() {
  if (testing()) return { webhooks: {}, sweep: null };
  try {
    const parsed = await readDoc(HEARTBEAT_PATHNAME);
    return { webhooks: parsed?.webhooks ?? {}, sweep: parsed?.sweep ?? null };
  } catch {
    return { webhooks: {}, sweep: null };
  }
}

async function save(state) {
  if (testing()) return;
  await writeDoc(HEARTBEAT_PATHNAME, state);
}

/**
 * A push was verified and handled on this channel.
 *
 * Recorded after the handler ran, never before, so the timestamp means "we did something
 * with it", not merely "something arrived". Two pushes racing to write lose at worst one
 * timestamp a few seconds newer than the other, which changes nothing anyone reads.
 */
export async function beatWebhook(channel, outcome) {
  try {
    const state = await loadHeartbeat();
    state.webhooks[channel] = { at: new Date().toISOString(), status: outcome?.status ?? 'unknown', id: outcome?.id ?? null };
    await save(state);
  } catch {
    // A heartbeat must never fail the push it is describing.
  }
}

/**
 * A push arrived on this channel and was turned away.
 *
 * Counted separately from accepted pushes because the two mean opposite things: an
 * accepted push says the channel is healthy, a run of rejections says the platform is
 * talking and we are not listening - a signature that no longer matches, a key that was
 * rotated. Without this, a broken verifier looks identical to a quiet day.
 */
export async function beatRejected(channel, reason) {
  try {
    const state = await loadHeartbeat();
    const current = state.webhooks[channel] ?? {};
    state.webhooks[channel] = {
      ...current,
      rejected: { at: new Date().toISOString(), reason: String(reason ?? '').slice(0, 120), count: (current.rejected?.count ?? 0) + 1 },
    };
    await save(state);
  } catch {
    // As above.
  }
}

/** A reconciliation sweep finished, whatever it found. */
export async function beatSweep(summary) {
  try {
    const state = await loadHeartbeat();
    state.sweep = { at: new Date().toISOString(), ...summary };
    await save(state);
  } catch {
    // As above.
  }
}

/** Human-readable age, for the dashboard. */
export function ageOf(iso, now = Date.now()) {
  if (!iso) return null;
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
}
