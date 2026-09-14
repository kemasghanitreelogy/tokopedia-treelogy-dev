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

/**
 * Name what is still open, with enough detail to act on.
 *
 * "TCPSocketWrap" tells you a socket is open and nothing else - which host, which port,
 * which service is exactly the part you need, and chasing it took a dozen probes against
 * the live box. Printing the remote address turns the next occurrence into one line.
 */
function describeOpenHandles() {
  const handles = typeof process._getActiveHandles === 'function' ? process._getActiveHandles() : [];
  const described = handles
    .filter((h) => h !== process.stdout && h !== process.stderr && h !== process.stdin)
    .map((h) => {
      const kind = h?.constructor?.name ?? typeof h;
      if (h?.remoteAddress) return `${kind} -> ${h.remoteAddress}:${h.remotePort}`;
      if (h?._host) return `${kind} -> ${h._host}`;
      return kind;
    });
  return described.length ? described.join(', ') : process.getActiveResourcesInfo().join(', ');
}

try {
  process.exitCode = await run(process.argv.slice(2));
} finally {
  // An open Redis client would otherwise keep the process alive after the command is done.
  await closeStore();
  // unref'd, so a command that exits cleanly - which is all of them - never waits for it.
  setTimeout(() => {
    console.error(`(masih terbuka setelah selesai, keluar paksa: ${describeOpenHandles()})`);
    process.exit(process.exitCode ?? 0);
  }, LINGER_MS).unref();
}
