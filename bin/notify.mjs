#!/usr/bin/env node
import { sendTelegram, closeQuietly } from '../src/notify/telegram.js';

/**
 * One-shot Telegram message, for shell scripts that have something to say.
 *
 * Used by the deploy script, which cannot import the app: at the moment it runs, the code
 * on disk may be the version that just failed its tests.
 */
const text = process.argv.slice(2).join(' ').replace(/%0A/g, '\n');
if (!text) {
  console.error('pakai: node bin/notify.mjs "<pesan HTML>"');
  process.exit(2);
}
const result = await sendTelegram(text, { key: `cli-${Date.now()}` });
if (!result.sent) console.error(`tidak terkirim: ${result.reason}`);
await closeQuietly();
