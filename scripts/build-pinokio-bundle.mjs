#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  buildPinokioBundle,
  checkPinokioBundle,
} from './build-pinokio-bundle-lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return `用法：
  node scripts/build-pinokio-bundle.mjs [--source DIR] [--bundle DIR]
  node scripts/build-pinokio-bundle.mjs --check [--source DIR] [--bundle DIR]`;
}

function parse(argv) {
  const options = {
    check: false,
    source: projectRoot,
    destination: path.join(projectRoot, 'packaging', 'pinokio', 'memory-bridge', 'bundle'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check') {
      options.check = true;
      continue;
    }
    const key = argument === '--source'
      ? 'source'
      : argument === '--bundle'
        ? 'destination'
        : null;
    if (!key) throw new Error(`未知参数：${argument}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少路径`);
    options[key] = path.resolve(value);
    index += 1;
  }
  return options;
}

try {
  const options = parse(process.argv.slice(2));
  const result = options.check
    ? checkPinokioBundle(options)
    : buildPinokioBundle(options);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
