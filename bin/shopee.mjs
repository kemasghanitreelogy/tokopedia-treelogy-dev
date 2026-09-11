#!/usr/bin/env node
import { run } from '../src/shopee/cli.js';

process.exitCode = await run(process.argv.slice(2));
