#!/usr/bin/env node
import { run } from '../src/cli.js';

import { closeStore } from '../src/store/index.js';

/**
 * How long a finished command is allowed to linger before it is made to leave.
 *
 * Every outbound request is bounded now (src/http.js), so nothing should reach this. It
 * exists because the failure it guards against is silent and expensive: the sweep spent
 * 45 minutes per run at 0% CPU on a Telegram POST that had no deadline, with the invoices
 * already written and the summary already printed. systemd called that a failed start,
 * and the timer would not schedule the next run until it gave up. A stray handle should
 * cost five seconds, not a whole sweep interval.
 */
const LINGER_MS = 5_000;

try {
  process.exitCode = await run(process.argv.slice(2));
} finally {
  // An open Redis client would otherwise keep the process alive after the command is done.
  await closeStore();
  // unref'd, so a command that exits cleanly - which is all of them - never waits for it.
  setTimeout(() => {
    console.error(`(masih ada ${process.getActiveResourcesInfo().join(', ')} setelah selesai - keluar paksa)`);
    process.exit(process.exitCode ?? 0);
  }, LINGER_MS).unref();
}
