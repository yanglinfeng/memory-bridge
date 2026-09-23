#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';

import { snapshotLifecycleBusinessState } from './lifecycle-business-hash-lib.mjs';

function usage() {
  return '用法：node scripts/lifecycle-business-hash.mjs --database FILE';
}

function parse(argv) {
  if (argv.length !== 2 || argv[0] !== '--database' || argv[1].startsWith('--')) {
    throw new Error(usage());
  }
  return path.resolve(argv[1]);
}

try {
  const databasePath = parse(process.argv.slice(2));
  console.log(JSON.stringify(snapshotLifecycleBusinessState(databasePath)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
