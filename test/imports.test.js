import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Every module must at least load.
 *
 * This exists because two stale references reached the production box in one afternoon -
 * a helper renamed out of one file while another still imported it, and a function used
 * without its import. Neither was caught, for the same reason both times: the suite tests
 * behaviour, and a module no test happens to import is a module nobody ever tries to load
 * until systemd does, at which point the failure is a unit that will not start.
 *
 * It is not a substitute for testing what the code does. It is the cheapest possible
 * check that the code can be run at all, which is a different and lower bar, and one that
 * had been quietly unmet.
 */

const ROOT = new URL('../', import.meta.url).pathname;

/** Directories whose modules are loadable without arguments or a live service. */
const ROOTS = ['src', 'api'];

/** Loading these has side effects beyond defining things, so they are left alone. */
const SKIP = new Set(['src/dashboard-page.js']);

async function* jsFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) yield full;
  }
}

test('every module under src/ and api/ can be imported', async () => {
  const failures = [];
  let loaded = 0;

  for (const base of ROOTS) {
    for await (const file of jsFiles(join(ROOT, base))) {
      const rel = relative(ROOT, file);
      if (SKIP.has(rel)) continue;
      try {
        await import(pathToFileURL(file).href);
        loaded += 1;
      } catch (error) {
        failures.push(`${rel}: ${error.message.split('\n')[0]}`);
      }
    }
  }

  assert.ok(loaded > 30, `hanya ${loaded} modul termuat - penelusuran berkas gagal?`);
  assert.deepEqual(failures, [], `modul gagal dimuat:\n  ${failures.join('\n  ')}`);
});
