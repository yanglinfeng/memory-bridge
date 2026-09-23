import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseScaleBenchmarkArgs,
  writeScaleBenchmarkReceipt,
} from '../scripts/benchmark-scale-lib.mjs';

test('规模基准只接受显式 receipt 路径', () => {
  assert.deepEqual(parseScaleBenchmarkArgs([]), { receipt: '' });
  assert.deepEqual(
    parseScaleBenchmarkArgs(['--receipt', '/private/tmp/scale.json']),
    { receipt: '/private/tmp/scale.json' },
  );
  assert.throws(() => parseScaleBenchmarkArgs(['--receipt']), /需要文件路径/u);
  assert.throws(() => parseScaleBenchmarkArgs(['--unknown']), /未知参数/u);
});

test('规模基准回执原子写入机器可读 JSON', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-scale-receipt-'),
  );
  try {
    const receiptPath = path.join(directory, 'nested', 'receipt.json');
    const report = {
      format: 'memory-bridge-scale-benchmark-v1',
      passed: true,
      dataset: { memories: 100_000, conversationTurns: 1_000_000 },
    };
    assert.equal(
      writeScaleBenchmarkReceipt(receiptPath, report),
      receiptPath,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(receiptPath, 'utf8')),
      report,
    );
    assert.equal(
      fs.readdirSync(path.dirname(receiptPath)).some(
        (name) => name.includes('.tmp-'),
      ),
      false,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
