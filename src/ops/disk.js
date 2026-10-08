import { statfs } from 'node:fs/promises';

/**
 * How full the server's disk is, and what to say about it.
 *
 * On 8 Oct 2026 the 38 GB disk filled up with QA reports and Redis stopped writing
 * ("MISCONF ... No space left on device"): invoices to Jurnal failed until space was
 * freed. Above 80% somebody hears about it on Telegram, early enough to act.
 */

export const WARN_PERCENT = 80;
export const CRITICAL_PERCENT = 95;

const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1).replace('.', ',');

export async function diskUsage(path = '/') {
  const s = await statfs(path);
  const total = s.blocks * s.bsize;
  const free = s.bavail * s.bsize;
  const used = total - s.bfree * s.bsize;
  return { total, used, free, percent: Math.round((used / total) * 1000) / 10 };
}

/**
 * The Telegram message for a reading, or null when there is nothing to say. Repeats are
 * spaced by the key: every six hours while it is merely high, every hour once critical.
 */
export function diskAlert(usage, now = new Date()) {
  if (usage.percent < WARN_PERCENT) return null;
  const critical = usage.percent >= CRITICAL_PERCENT;
  const hour = now.toISOString().slice(0, 13);
  const key = critical ? `disk|critical|${hour}` : `disk|warn|${now.toISOString().slice(0, 10)}|${Math.floor(now.getUTCHours() / 6)}`;
  const html = [
    `<b>${critical ? '🚨 Disk server hampir penuh' : '⚠️ Disk server terisi'} ${String(usage.percent).replace('.', ',')}%</b>`,
    `Sisa ${gb(usage.free)} GB dari ${gb(usage.total)} GB.`,
    critical ? 'Redis akan berhenti menyimpan begitu disk penuh - faktur Jurnal dan stok gagal tersimpan.' : 'Masih aman, tapi perlu dilihat sebelum penuh.',
    'Biasanya laporan QA: <code>sudo du -sh /opt/treelogy-qa/reports/*</code>',
  ].join('\n');
  return { key, html, critical };
}
