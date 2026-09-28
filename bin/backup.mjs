#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { sendTelegram } from '../src/notify/telegram.js';

/**
 * A copy of the state, taken in a way the user running it is actually allowed to take.
 *
 * The nightly job used to `cp /var/lib/redis/dump.rdb`. That directory is redis:redis
 * 0750 and the job runs as treelogy, so every single run since the unit was written on
 * 14 September failed with "Permission denied" - and the backup folder was found empty a
 * fortnight later. Systemd marked the unit failed each night and nobody noticed, which
 * is the part worth fixing twice: a backup nobody is told about is not a backup.
 *
 * `redis-cli --rdb` asks the server for the dump over the connection it already has, so
 * it needs no access to redis's files at all. Everything else here exists because a
 * backup that is trusted without being looked at is the most expensive kind: the size is
 * checked, the result is announced when it goes wrong, and a run that fails exits
 * non-zero so the unit keeps saying so.
 */

const run = promisify(execFile);

const DIR = process.env.BACKUP_DIR || '/opt/treelogy/backup';
/** Smaller than this and something answered without actually dumping anything. */
const MIN_BYTES = Number(process.env.BACKUP_MIN_BYTES) || 64 * 1024;
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS) || 30;

const today = new Date().toISOString().slice(0, 10);
const target = path.join(DIR, `treelogy-${today}.rdb`);

async function fail(reason) {
  console.error(`backup: ${reason}`);
  await sendTelegram(
    `<b>🛑 Backup state gagal</b>\n${reason}\n\nRedis memegang ledger faktur, token, catatan cetak dan kuota. Tanpa salinan, satu disk rusak menghapus semuanya.`,
    { key: `backup-failed|${today}` },
  ).catch(() => {});
  process.exit(1);
}

try {
  fs.mkdirSync(DIR, { recursive: true });
} catch (error) {
  await fail(`tidak bisa membuat ${DIR}: ${error.message}`);
}

try {
  // --rdb streams the dump to us; no read access to redis's own directory is needed.
  await run('redis-cli', ['--rdb', target], { timeout: 10 * 60_000, maxBuffer: 1 << 20 });
} catch (error) {
  await fail(`redis-cli --rdb gagal: ${String(error.stderr || error.message).slice(0, 300)}`);
}

let size = 0;
try {
  size = fs.statSync(target).size;
} catch (error) {
  await fail(`berkas cadangan tidak ada setelah dump: ${error.message}`);
}
if (size < MIN_BYTES) {
  await fail(`cadangan hanya ${size} byte - di bawah ambang ${MIN_BYTES}, dianggap gagal`);
}

// Pruned only after a good one exists, so a bad night never deletes the last good copy.
let removed = 0;
const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
for (const name of fs.readdirSync(DIR)) {
  if (!name.endsWith('.rdb') || name === path.basename(target)) continue;
  const file = path.join(DIR, name);
  try {
    if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); removed += 1; }
  } catch { /* a file that cannot be read is a file not worth deleting blind */ }
}

const kept = fs.readdirSync(DIR).filter((n) => n.endsWith('.rdb')).length;
console.log(`backup: ${target} ${(size / 1024 / 1024).toFixed(1)} MB · ${kept} salinan disimpan · ${removed} dihapus`);
