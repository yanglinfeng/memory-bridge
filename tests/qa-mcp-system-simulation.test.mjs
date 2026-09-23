import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareExpectedErrorEvidence,
} from '../scripts/qa-mcp-system-simulation-gates.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const harnessPath = path.join(projectRoot, 'scripts', 'qa-mcp-system-simulation.mjs');

function runFullConfiguration(overrides) {
  const qaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-system-contract-'));
  try {
    return spawnSync(process.execPath, [harnessPath], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORY_BRIDGE_QA_ROOT: qaRoot,
        MEMORY_BRIDGE_QA_PROFILE: 'full',
        MEMORY_BRIDGE_QA_USERS: '8',
        MEMORY_BRIDGE_QA_MEMORIES_PER_USER: '75',
        MEMORY_BRIDGE_QA_CONCURRENCY: '4',
        MEMORY_BRIDGE_QA_SOAK_SECONDS: '1800',
        MEMORY_BRIDGE_QA_SEMANTIC_MODE: 'required',
        MEMORY_BRIDGE_QA_RECALL_P95_LIMIT_MS: '1500',
        ...overrides,
      },
    });
  } finally {
    fs.rmSync(qaRoot, { recursive: true, force: true });
  }
}

test('MCP system harness 保持可执行 JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', harnessPath], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('full profile 拒绝缩减 8×75、并发4、30分钟合同', () => {
  for (const [name, overrides] of Object.entries({
    users: { MEMORY_BRIDGE_QA_USERS: '7' },
    memories: { MEMORY_BRIDGE_QA_MEMORIES_PER_USER: '74' },
    concurrency: { MEMORY_BRIDGE_QA_CONCURRENCY: '3' },
    soak: { MEMORY_BRIDGE_QA_SOAK_SECONDS: '1799' },
  })) {
    const result = runFullConfiguration(overrides);
    assert.notEqual(result.status, 0, `${name} 缩减必须失败`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /full profile 固定为 8 用户 × 每用户 75 条、全局并发 4、稳态 1800 秒/u,
      `${name} 缩减必须命中 full 合同`,
    );
  }
});

test('full profile 拒绝关闭或伪造 semantic provider 模式', () => {
  for (const semanticMode of ['off', 'degraded']) {
    const result = runFullConfiguration({
      MEMORY_BRIDGE_QA_SEMANTIC_MODE: semanticMode,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      semanticMode === 'off'
        ? /full profile 固定使用 semantic mode=required/u
        : /只支持 required 或 off/u,
    );
  }
});

test('full profile 拒绝把可靠召回 P95 门槛抬高到 1500ms 以上', () => {
  const result = runFullConfiguration({
    MEMORY_BRIDGE_QA_RECALL_P95_LIMIT_MS: '1501',
  });
  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /P95 发布门槛固定不高于 1500ms/u,
  );
});

test('expected-error 比较同时约束观察、消息指纹和稳定 code', () => {
  const firstFingerprint = 'a'.repeat(64);
  const secondFingerprint = 'b'.repeat(64);
  const base = {
    observed: true,
    fingerprint: firstFingerprint,
    errorCode: null,
  };
  assert.equal(compareExpectedErrorEvidence(base, base).passed, true);
  assert.equal(compareExpectedErrorEvidence(
    { ...base, errorCode: 'MEMORY_NOT_FOUND' },
    { ...base, errorCode: 'MEMORY_NOT_FOUND' },
  ).passed, true);
  assert.equal(compareExpectedErrorEvidence(
    { ...base, errorCode: 'MEMORY_NOT_FOUND' },
    { ...base, fingerprint: secondFingerprint, errorCode: 'MEMORY_NOT_FOUND' },
  ).passed, false, '同 code 不同消息指纹必须失败');
  assert.equal(compareExpectedErrorEvidence(
    { ...base, errorCode: 'MEMORY_NOT_FOUND' },
    base,
  ).passed, false, '单边 code 必须失败');
  assert.equal(compareExpectedErrorEvidence(
    { ...base, errorCode: 'MEMORY_NOT_FOUND' },
    { ...base, errorCode: 'OTHER_ERROR' },
  ).passed, false, '双边 code 值不同必须失败');
  assert.equal(compareExpectedErrorEvidence({}, {}).passed, false);
  assert.equal(compareExpectedErrorEvidence(
    { ...base, observed: false },
    base,
  ).passed, false, '空响应或未观察到错误必须失败');
});
