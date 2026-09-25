import { readEnv } from '../env-file.js';
import { wibDate } from '../range.js';
import { fetchWithTimeout } from '../http.js';
import { ENV_PATH, ENV_LOCAL_PATH, publicBaseUrl } from '../config.js';

/**
 * Telling a person when the books did not get written.
 *
 * Every other safety net here is silent: the sweep retries, the ledger refuses
 * duplicates, the dashboard shows a red chip if somebody happens to open it. None of that
 * reaches anyone at 11pm when Jurnal starts returning 422s. This does. It is deliberately
 * narrow - failures only, never "34 invoices posted fine" - because an alert channel that
 * carries good news is one people mute.
 *
 * Nothing here may ever break the thing it is reporting on: every call swallows its own
 * errors, and an unconfigured bot is simply silence.
 */

export function loadTelegramConfig() {
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';
  return {
    token: get('TELEGRAM_BOT') || get('TELEGRAM_BOT_TOKEN'),
    chatId: get('TELEGRAM_CHAT_ID'),
  };
}

export const isTelegramConfigured = (config = loadTelegramConfig()) => Boolean(config.token && config.chatId);

/** Telegram's HTML mode needs these three escaped and nothing else. */
export const escapeHtml = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MAX_LENGTH = 3800; // Telegram caps a message at 4096; leave room for the footer.

/**
 * Same failure, same hour, one message.
 *
 * A Jurnal outage makes every order in a sweep fail the same way, and a sweep runs four
 * times an hour. Without this the phone buzzes eighty times about one problem. Keyed on
 * the message's own fingerprint so two different failures still both get through.
 */
const recentlySent = new Map();
const DEDUPE_MS = 60 * 60 * 1000;

function alreadySent(key, now = Date.now()) {
  for (const [k, at] of recentlySent) if (now - at > DEDUPE_MS) recentlySent.delete(k);
  if (recentlySent.has(key)) return true;
  recentlySent.set(key, now);
  return false;
}

export function resetDedupe() {
  recentlySent.clear();
}

/**
 * @param {string} html  message body, already escaped where it carries user data
 * The default sender carries a deadline, and it has to.
 *
 * This call sits at the very end of every job - after the summary is printed, after the
 * work is done - which made it the worst possible place for a request that can wait
 * forever. api.telegram.org accepting the connection and then answering nothing held
 * treelogy-sweep for 45 minutes at 0% CPU, every run, until systemd killed it: the sync
 * had already finished and the books were already written, but the unit reported failure
 * and the timer would not schedule the next run.
 *
 * @param {{key?: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendTelegram(html, { key = html, fetchImpl = fetchWithTimeout, config = loadTelegramConfig() } = {}) {
  // A test that did not inject its own sender is not asking to message a real chat.
  if (process.env.NODE_TEST_CONTEXT && fetchImpl === fetchWithTimeout) return { sent: false, reason: 'test' };
  if (!isTelegramConfigured(config)) return { sent: false, reason: 'belum dikonfigurasi' };
  if (alreadySent(key)) return { sent: false, reason: 'sudah dikirim dalam satu jam terakhir' };

  const text = html.length > MAX_LENGTH ? `${html.slice(0, MAX_LENGTH)}\n…(dipotong)` : html;
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      console.warn(`telegram: gagal kirim - ${payload.description ?? response.status}`);
      return { sent: false, reason: payload.description ?? `HTTP ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    console.warn(`telegram: tidak terjangkau - ${error.message}`);
    return { sent: false, reason: error.message };
  }
}

const dashboardLink = () => `${publicBaseUrl()}/api/dashboard?view=jurnal`;

/**
 * One message for a batch of failed invoices, grouped by what went wrong.
 *
 * Reads as a list of problems, not a list of orders: twenty orders that all hit "product
 * not available" is one problem with twenty examples, and the person reading it needs to
 * know which of the two it is.
 */
export function formatFailures({ source, failures = [], channelErrors = {} }) {
  const byReason = new Map();
  for (const f of failures) {
    const reason = String(f.error ?? 'tanpa alasan').replace(/\s+/g, ' ').slice(0, 160);
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push(f.customId ?? f.id ?? '?');
  }

  const lines = [`<b>⚠️ Sinkronisasi Jurnal gagal</b> — ${escapeHtml(source)}`];
  if (failures.length > 0) lines.push(`${failures.length} faktur tidak masuk:`);
  for (const [reason, ids] of byReason) {
    const shown = ids.slice(0, 8).map((id) => `<code>${escapeHtml(id)}</code>`).join(', ');
    lines.push(`• ${escapeHtml(reason)}\n  ${shown}${ids.length > 8 ? ` +${ids.length - 8} lagi` : ''}`);
  }
  for (const [channel, message] of Object.entries(channelErrors)) {
    lines.push(`• Kanal <b>${escapeHtml(channel)}</b> tidak bisa dibaca: ${escapeHtml(String(message).slice(0, 160))}`);
  }
  lines.push(`\n<a href="${dashboardLink()}">Buka tab Jurnal</a>`);
  return lines.join('\n');
}

/** Report a sync's failures, if it had any. Silent otherwise. */
export async function notifySyncFailures({ source, results = [], channelErrors = {} }, options = {}) {
  // A mismatch is a wrong number already in the books; it outranks a plain failure.
  const failures = results.filter((r) => r.status === 'failed' || r.status === 'mismatch');
  if (failures.length === 0 && Object.keys(channelErrors).length === 0) return { sent: false, reason: 'tidak ada kegagalan' };
  const html = formatFailures({ source, failures, channelErrors });
  // Keyed on the reasons, not the order ids, so the same outage does not re-alert every
  // sweep as new orders join it.
  const key = `${source}|${[...new Set(failures.map((f) => f.error))].sort().join('|')}|${Object.keys(channelErrors).sort().join(',')}`;
  return sendTelegram(html, { ...options, key });
}

/**
 * Orders that have been tried enough times to know the problem is not clearing itself.
 *
 * Deliberately different from formatFailures, which groups by reason and is right for a
 * batch that just failed all at once. This one is per order and says everything needed to
 * act without opening anything: which sale, whose, how much, since when, how many tries,
 * and the error exactly as Jurnal phrased it.
 *
 * The rule on top is that a first failure is not news. Most of them are a moment's bad
 * weather and are gone by the next sweep. What deserves a person is an order that has
 * been refused three times over an hour, because by then something is actually wrong.
 */
export function formatStuckOrders(entries = [], { now = Date.now() } = {}) {
  const lines = [`<b>🚨 ${entries.length} pesanan belum masuk Jurnal</b> — sudah dicoba berulang kali`];

  for (const e of entries.slice(0, 10)) {
    const since = e.first_failed_at ? Math.max(0, Math.round((now - Date.parse(e.first_failed_at)) / 60_000)) : null;
    const rupiah = Number.isFinite(Number(e.total)) && e.total !== null
      ? `Rp${Number(e.total).toLocaleString('id-ID')}` : 'nilai tidak terbaca';
    const ordered = Number.isFinite(Number(e.ordered_at)) ? wibDate(Number(e.ordered_at)) : null;

    lines.push(
      `\n• <b>${escapeHtml(e.channel ?? '?')}</b> <code>${escapeHtml(e.order_id ?? e.customId)}</code>` +
      (e.customer ? ` — ${escapeHtml(String(e.customer).slice(0, 40))}` : '') +
      `\n  ${rupiah}${ordered ? ` · pesanan ${escapeHtml(ordered)}` : ''}` +
      `\n  gagal <b>${e.attempts ?? '?'}×</b>${since === null ? '' : ` selama ${formatSpan(since)}`}` +
      `\n  <code>${escapeHtml(String(e.error ?? 'tanpa alasan').slice(0, 300))}</code>`,
    );
  }
  if (entries.length > 10) lines.push(`\n…dan ${entries.length - 10} pesanan lagi`);

  lines.push(`\n<a href="${dashboardLink()}">Buka tab Jurnal</a>`);
  return lines.join('\n');
}

/** Minutes into something a person reads without doing arithmetic. */
function formatSpan(minutes) {
  if (minutes < 60) return `${minutes} menit`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} jam`;
  return `${Math.round(minutes / (60 * 24))} hari`;
}

/**
 * Report the stuck orders, and say which ones were reported so they are not repeated.
 *
 * The dedupe key carries the attempt counts, not just the order ids, so the next message
 * about the same orders only goes out once they have actually been tried again - and a
 * newly stuck order always gets through even while an old one is still stuck.
 */
export async function notifyStuckOrders(entries = [], options = {}) {
  if (entries.length === 0) return { sent: false, reason: 'tidak ada yang macet' };
  const key = `stuck|${entries.map((e) => `${e.customId}@${e.attempts}`).sort().join(',')}`;
  return sendTelegram(formatStuckOrders(entries, options), { ...options, key });
}

/**
 * The nightly proof that every sale is in the books, and the list when it is not.
 *
 * This is the only check that asks Jurnal rather than our own ledger. The sweep's retry
 * book knows about orders the sweep attempted; it cannot know about one it never saw -
 * an order whose stage moved to completed a fortnight after it was placed, outside the
 * seven days the sweep looks at, or one that was lost while a channel could not be read.
 * Comparing the whole corpus against the books catches those, and nothing else does.
 *
 * Silent when a scan came back short: a truncated read makes invoices look absent that
 * are merely unread, and an alert built on that is worse than no alert.
 */
export function formatUninvoiced({ from, missingOrders = [], uninvoiceable = [], missingValue = 0 } = {}, { now = Date.now() } = {}) {
  const lines = [
    `<b>📕 ${missingOrders.length} pesanan belum ada fakturnya di Jurnal</b>`,
    `sejak ${escapeHtml(from)} · senilai Rp${Number(missingValue).toLocaleString('id-ID')}`,
  ];

  for (const o of missingOrders.slice(0, 12)) {
    const age = Number.isFinite(Number(o.orderedAt))
      ? Math.max(0, Math.round((now / 1000 - Number(o.orderedAt)) / 86400)) : null;
    lines.push(
      `\n• <b>${escapeHtml(o.channel ?? '?')}</b> <code>${escapeHtml(o.id ?? o.customId)}</code>` +
      (o.customer ? ` — ${escapeHtml(String(o.customer).slice(0, 40))}` : '') +
      `\n  Rp${Number(o.total ?? 0).toLocaleString('id-ID')} · ${escapeHtml(o.day ?? '?')}` +
      `${age === null ? '' : ` · ${age} hari lalu`} · ${escapeHtml(o.stage ?? '?')}`,
    );
  }
  if (missingOrders.length > 12) lines.push(`\n…dan ${missingOrders.length - 12} pesanan lagi`);

  if (uninvoiceable.length > 0) {
    lines.push(`\n<i>${uninvoiceable.length} pesanan lain tidak bisa dibuat faktur sama sekali (tanpa baris keuangan):</i>`);
    lines.push(uninvoiceable.slice(0, 6).map((o) => `<code>${escapeHtml(o.id ?? o.customId)}</code>`).join(', '));
  }

  lines.push(`\n<a href="${dashboardLink()}">Buka tab Jurnal</a>`);
  return lines.join('\n');
}

/** Report the nightly audit, if it found anything and if it can be trusted. */
export async function notifyUninvoiced(recap, options = {}) {
  if (recap?.complete === false) {
    // Said out loud rather than swallowed: a night with no audit is not a clean night.
    return sendTelegram(
      `<b>⚠️ Audit faktur tidak bisa diselesaikan</b>\nHanya ${recap.walked} dari ${recap.expected} faktur terbaca, jadi malam ini tidak ada jaminan setiap pesanan sudah dibukukan.`,
      { ...options, key: `audit-incomplete|${recap.from}|${recap.walked}` },
    );
  }
  const missingOrders = recap?.missingOrders ?? [];
  const uninvoiceable = recap?.uninvoiceable ?? [];
  if (missingOrders.length === 0 && uninvoiceable.length === 0) return { sent: false, reason: 'semua pesanan sudah dibukukan' };

  const key = `uninvoiced|${[...missingOrders, ...uninvoiceable].map((o) => o.customId).sort().join(',')}`;
  return sendTelegram(formatUninvoiced(recap, options), { ...options, key });
}

/** Something broke before any order was even attempted - the run itself died. */
export async function notifyCrash({ source, error }, options = {}) {
  const html = [
    `<b>🛑 Sinkronisasi Jurnal berhenti</b> — ${escapeHtml(source)}`,
    `<code>${escapeHtml(String(error?.message ?? error).slice(0, 600))}</code>`,
    `\n<a href="${dashboardLink()}">Buka tab Jurnal</a>`,
  ].join('\n');
  return sendTelegram(html, { ...options, key: `crash|${source}|${String(error?.message ?? error).slice(0, 80)}` });
}

/**
 * The one thing worth a message about stock: what will run out before a reorder lands.
 *
 * Sent once a day after the forecast rebuilds, and only when there is something to say.
 * A SKU whose model never beat the seasonal naive is still listed - it is still running
 * out - but flagged, because "order 325" resting on an unreliable model deserves a
 * second look rather than a purchase order.
 */
export async function notifyStockRisk(forecast, options = {}) {
  const rows = (forecast?.rows ?? []).filter((r) => r.urgency === 'stockout' || r.urgency === 'critical');
  if (rows.length === 0) return { sent: false, reason: 'tidak ada yang kritis' };

  const lines = [`<b>📦 Stok akan habis sebelum pesanan tiba</b> — lead time ${forecast.policy.leadTimeDays} hari`];
  for (const r of rows.slice(0, 12)) {
    const s = r.stock ?? {};
    const a = r.accuracy?.[s.horizonUsed] ?? r.accuracy?.[30] ?? {};
    const shaky = a.beatsNaive === false ? ' ⚠︎ model tak lebih baik dari pola minggu lalu' : '';
    lines.push(
      `• <b>${escapeHtml(r.name)}</b> <code>${escapeHtml(r.sku)}</code>\n` +
      `  sisa ${r.onHand ?? '?'} — habis ${escapeHtml(s.stockoutDate ?? '?')} (${s.daysOfCover ?? '?'} hari)\n` +
      `  pesan <b>${s.reorderQty ?? '?'}</b>${shaky}`,
    );
  }
  if (rows.length > 12) lines.push(`…dan ${rows.length - 12} SKU lagi`);
  lines.push(`\n<a href="${publicBaseUrl()}/api/dashboard?view=forecast">Buka tab Prakiraan</a>`);

  // Keyed on the day and the SKUs, so the same set is not repeated within a day but a
  // newly critical product still gets through.
  // Keyed on the Jakarta day, not the UTC one: a "once a day" alert keyed on UTC resets
  // at 07:00 local, which is the middle of the working morning rather than the boundary
  // anybody thinks in.
  const key = `stock|${wibDate(Math.floor(Date.now() / 1000))}|${rows.map((r) => r.sku).sort().join(',')}`;
  return sendTelegram(lines.join('\n'), { ...options, key });
}

/** Nothing to close here today, but shell one-shots call it so the process can exit. */
export async function closeQuietly() {}
