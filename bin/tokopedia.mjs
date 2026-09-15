#!/usr/bin/env node
import { run } from '../src/tokopedia/cli.js';
import { closeStore } from '../src/store/index.js';

try {
  process.exitCode = await run(process.argv.slice(2));
} finally {
  // An open Redis client would otherwise keep the process alive after the command is done.
  await closeStore();
}
