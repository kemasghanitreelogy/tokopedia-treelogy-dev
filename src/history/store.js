import { readDoc, writeDoc, updateDoc } from '../store/index.js';

/**
 * Where the sales history lives.
 *
 * One file per channel per month, rewritten whole. A month that is over is pulled once and
 * never again; the running month is pulled on every run. That split is what makes a pull
 * resumable and cheap: a crash halfway through October loses October, not the year.
 */

export const MANIFEST_PATHNAME = 'history/manifest.json';
export const monthPathname = (channel, month) => `history/${channel}/${month}.json`;

async function readJson(pathname, fallback) {
  try {
    return (await readDoc(pathname)) ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(pathname, value) {
  await writeDoc(pathname, value);
}

export const loadManifest = () => readJson(MANIFEST_PATHNAME, { version: 1, channels: {} });

/**
 * Merge, never overwrite.
 *
 * Two pulls running at once - one per channel, which is the obvious way to run them -
 * each held their own copy of the manifest and the later save erased the earlier one's
 * channel. The month files were all safely written; the index of them was not, so a
 * whole channel's history became invisible to the forecast. One transaction per channel,
 * per month, keyed deep enough that two channels cannot collide.
 */
export const saveManifest = (manifest) => updateDoc(MANIFEST_PATHNAME, (current) => {
  const merged = { ...(current ?? {}), ...manifest, version: 1, updated_at: new Date().toISOString(), channels: { ...(current?.channels ?? {}) } };
  for (const [channel, data] of Object.entries(manifest.channels ?? {})) {
    merged.channels[channel] = {
      ...(current?.channels?.[channel] ?? {}),
      ...data,
      months: { ...(current?.channels?.[channel]?.months ?? {}), ...(data.months ?? {}) },
    };
  }
  return merged;
}, { version: 1, channels: {} });

export const loadMonth = (channel, month) => readJson(monthPathname(channel, month), null);

export async function saveMonth(channel, month, { orders, complete }) {
  const file = { channel, month, pulled_at: new Date().toISOString(), complete, orders };
  await writeJson(monthPathname(channel, month), file);
  return file;
}

/** Every stored month for a channel, oldest first. */
export async function loadChannelHistory(channel, manifest) {
  const months = Object.keys(manifest.channels?.[channel]?.months ?? {}).sort();
  const files = [];
  for (const month of months) {
    const file = await loadMonth(channel, month);
    if (file) files.push(file);
  }
  return files;
}

/** WIB calendar month of an epoch-seconds instant, as YYYY-MM. */
export const monthOf = (epochSeconds) => new Date((epochSeconds + 7 * 3600) * 1000).toISOString().slice(0, 7);

/** Epoch bounds of a WIB calendar month. */
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const since = Date.UTC(y, m - 1, 1) / 1000 - 7 * 3600;
  const until = Date.UTC(y, m, 1) / 1000 - 7 * 3600 - 1;
  return { since, until };
}

/** Months from `from` (YYYY-MM) up to and including the current WIB month. */
export function monthsSince(from, now = Date.now()) {
  const current = monthOf(Math.floor(now / 1000));
  const out = [];
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    out.push(month);
    if (month >= current) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
