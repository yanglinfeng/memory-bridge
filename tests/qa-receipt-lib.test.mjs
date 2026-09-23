import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildQaImplementationEvidence,
  createPrivateQaRunRoot,
  createQaRunId,
  immutableQaPath,
  writeImmutableQaFile,
} from '../scripts/qa-receipt-lib.mjs';

test('QA 实现指纹覆盖完整 server 运行时树且忽略 sourcemap', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-implementation-'));
  try {
    fs.mkdirSync(path.join(projectRoot, 'dist/server/nested'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '{"lock":true}\n');
    fs.writeFileSync(path.join(projectRoot, 'dist/server/index.js'), 'import "./nested/worker.js";\n');
    fs.writeFileSync(path.join(projectRoot, 'dist/server/nested/worker.js'), 'export const worker = true;\n');
    fs.writeFileSync(path.join(projectRoot, 'dist/server/index.js.map'), '{"version":3}\n');
    fs.writeFileSync(path.join(projectRoot, 'scripts/probe.mjs'), 'export {};\n');

    const evidence = buildQaImplementationEvidence({
      projectRoot,
      schemaVersion: 31,
      relativeFiles: ['package-lock.json', 'scripts/probe.mjs'],
      runtimeDirectories: ['dist/server'],
    });

    assert.deepEqual(Object.keys(evidence.files), [
      'dist/server/index.js',
      'dist/server/nested/worker.js',
      'package-lock.json',
      'scripts/probe.mjs',
    ]);
    assert.equal(evidence.runtimeFileCount, 2);
    assert.equal(evidence.schemaVersion, 31);
    assert.match(evidence.fingerprintSha256, /^[0-9a-f]{64}$/u);

    fs.writeFileSync(path.join(projectRoot, 'dist/server/nested/worker.js'), 'export const worker = false;\n');
    const changed = buildQaImplementationEvidence({
      projectRoot,
      schemaVersion: 31,
      relativeFiles: ['package-lock.json', 'scripts/probe.mjs'],
      runtimeDirectories: ['dist/server'],
    });
    assert.notEqual(changed.fingerprintSha256, evidence.fingerprintSha256);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('QA 验收 root 可创建在显式持久父目录且保持私有和唯一', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-root-parent-'));
  const parent = path.join(sandbox, 'persistent-acceptance');
  try {
    const first = createPrivateQaRunRoot(parent, 'memory-bridge-airi-final-v31.');
    const second = createPrivateQaRunRoot(parent, 'memory-bridge-airi-final-v31.');
    assert.notEqual(first, second);
    assert.equal(path.dirname(first), parent);
    assert.equal(path.dirname(second), parent);
    assert.equal(fs.statSync(first).mode & 0o777, 0o700);
    assert.equal(fs.statSync(second).mode & 0o777, 0o700);
    assert.throws(
      () => createPrivateQaRunRoot('relative-parent', 'qa.'),
      /绝对路径/u,
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('QA 回执使用唯一 runId 且已有文件绝不覆写', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-receipt-'));
  try {
    const firstRunId = createQaRunId();
    const secondRunId = createQaRunId();
    assert.notEqual(firstRunId, secondRunId);
    const receiptPath = immutableQaPath(
      directory,
      'restart-persistence-probe',
      firstRunId,
      'json',
    );
    const written = writeImmutableQaFile(receiptPath, '{"passed":true}\n');
    assert.equal(written.path, receiptPath);
    assert.match(written.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
    assert.throws(
      () => writeImmutableQaFile(receiptPath, '{"passed":false}\n'),
      (error) => error?.code === 'EEXIST',
    );
    assert.equal(fs.readFileSync(receiptPath, 'utf8'), '{"passed":true}\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('QA 回执路径拒绝不安全标识符', () => {
  assert.throws(
    () => immutableQaPath('/tmp', '../receipt', 'run', 'json'),
    /安全标识符/u,
  );
  assert.throws(
    () => immutableQaPath('/tmp', 'receipt', '../run', 'json'),
    /安全标识符/u,
  );
});
