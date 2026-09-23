import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  countNonVerbatimEvidence,
  loadEvidenceTurnContent,
  parseContextReflectionFixtureBytes,
  requiredPreflightModels,
  summarizeQueryModelTelemetry,
  summarizeQueryQuality,
  summarizeReflectionQuality,
} from '../scripts/evaluate-context-reflection-quality.mjs';

const FIXTURE_PATH = fileURLToPath(
  new URL(
    '../scripts/fixtures/context-reflection-quality-v1.json',
    import.meta.url,
  ),
);

test('固定集确定性展开为 120 条查询和 100 个历史窗口', () => {
  const parsed = parseContextReflectionFixtureBytes(
    fs.readFileSync(FIXTURE_PATH),
  );

  assert.equal(parsed.dataset.datasetId, 'context-reflection-quality-v1');
  assert.equal(parsed.queryCases.length, 120);
  assert.equal(parsed.reflectionWindows.length, 100);
  assert.equal(new Set(parsed.queryCases.map((entry) => entry.id)).size, 120);
  assert.equal(
    new Set(parsed.reflectionWindows.map((entry) => entry.id)).size,
    100,
  );
  assert.match(parsed.datasetSha256, /^[0-9a-f]{64}$/u);
});

test('查询专项预检不加载无关 embedding，完整与反思评测保留所需模型', () => {
  const options = {
    queryModel: 'qwen2.5:14b',
    extractModel: 'extract-model',
    reflectionModel: 'reflection-model',
    embeddingModel: 'bge-m3:latest',
  };
  assert.deepEqual(requiredPreflightModels({ ...options, section: 'query' }), {
    models: ['qwen2.5:14b'],
    checkEmbedding: false,
  });
  assert.deepEqual(
    requiredPreflightModels({ ...options, section: 'reflection' }),
    {
      models: ['extract-model', 'reflection-model', 'bge-m3:latest'],
      checkEmbedding: true,
    },
  );
  assert.deepEqual(requiredPreflightModels({ ...options, section: 'all' }), {
    models: [
      'qwen2.5:14b', 'extract-model', 'reflection-model', 'bge-m3:latest',
    ],
    checkEmbedding: true,
  });
});

test('fixture 校验拒绝不足数量和重复实体 ID', () => {
  const source = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  assert.throws(
    () => parseContextReflectionFixtureBytes(Buffer.from(JSON.stringify({
      ...source,
      entities: source.entities.slice(0, 19),
    }))),
    /必须恰好包含 20 个实体/u,
  );
  assert.throws(
    () => parseContextReflectionFixtureBytes(Buffer.from(JSON.stringify({
      ...source,
      entities: [source.entities[0], source.entities[0], ...source.entities.slice(2)],
    }))),
    /实体 id 重复/u,
  );
});

test('查询质量门槛锁定消解、约束、歧义注入、泄漏和调用上限', () => {
  const passing = summarizeQueryQuality([
    {
      expectedStatus: 'resolved',
      semanticCorrect: true,
      constraintsPreserved: true,
      wrongMemoryInjection: false,
      scopeLeak: false,
      modelCalls: 1,
      latencyMs: 100,
    },
    {
      expectedStatus: 'ambiguous',
      semanticCorrect: true,
      constraintsPreserved: true,
      wrongMemoryInjection: false,
      scopeLeak: false,
      modelCalls: 1,
      latencyMs: 120,
    },
  ]);
  assert.equal(passing.passed, true);
  assert.equal(passing.metrics.wrongMemoryInjections, 0);

  const bypassedProvider = summarizeQueryQuality([{
    expectedStatus: 'resolved',
    semanticCorrect: true,
    constraintsPreserved: true,
    wrongMemoryInjection: false,
    scopeLeak: false,
    modelCalls: 0,
    latencyMs: 1,
  }]);
  assert.equal(bypassedProvider.passed, false);
  assert.deepEqual(bypassedProvider.failedMetrics, ['providerCallCoverage']);

  const failing = summarizeQueryQuality([
    {
      expectedStatus: 'resolved',
      semanticCorrect: false,
      constraintsPreserved: false,
      wrongMemoryInjection: false,
      scopeLeak: true,
      modelCalls: 2,
      latencyMs: 2_000,
    },
  ]);
  assert.equal(failing.passed, false);
  assert.deepEqual(
    new Set(failing.failedMetrics),
    new Set([
      'resolutionAccuracy',
      'constraintPreservation',
      'scopeLeaks',
      'maxModelCallsPerCase',
      'warmP95Ms',
    ]),
  );
});

test('查询评测聚合 provider、prompt 和生成阶段遥测', () => {
  const telemetry = summarizeQueryModelTelemetry([
    {
      providerDurationMs: 900,
      modelTelemetry: {
        totalDurationMs: 850,
        loadDurationMs: 10,
        promptEvalCount: 500,
        promptEvalDurationMs: 90,
        evalCount: 40,
        evalDurationMs: 700,
        thermalState: 'warm',
      },
    },
    {
      providerDurationMs: 1_200,
      modelTelemetry: {
        totalDurationMs: 1_150,
        loadDurationMs: 120,
        promptEvalCount: 520,
        promptEvalDurationMs: 100,
        evalCount: 60,
        evalDurationMs: 900,
        thermalState: 'cold',
      },
    },
  ]);

  assert.equal(telemetry.samplesWithModelTelemetry, 2);
  assert.equal(telemetry.providerDurationMs.p95, 1_200);
  assert.equal(telemetry.promptEvalCount.p50, 500);
  assert.equal(telemetry.evalCount.p95, 60);
  assert.equal(telemetry.evalDurationMs.p95, 900);
  assert.deepEqual(telemetry.thermalStates, {
    cold: 1,
    warm: 1,
    unknown: 0,
  });
});

test('历史质量门槛要求直接事实 precision 及所有安全计数归零', () => {
  const passing = summarizeReflectionQuality([
    {
      kind: 'direct_explicit',
      directTruePositive: 1,
      directFalsePositive: 0,
      inferenceAutoCommits: 0,
      nonVerbatimEvidence: 0,
      tombstoneRevivals: 0,
      scopeMixes: 0,
      credentialLeaks: 0,
      duplicateSideEffects: 0,
      crossVersionDuplicates: 0,
    },
  ]);
  assert.equal(passing.passed, true);
  assert.equal(passing.metrics.directPrecision, 1);

  const failing = summarizeReflectionQuality([
    {
      kind: 'direct_explicit',
      directTruePositive: 0,
      directFalsePositive: 1,
      inferenceAutoCommits: 1,
      nonVerbatimEvidence: 1,
      tombstoneRevivals: 1,
      scopeMixes: 1,
      credentialLeaks: 1,
      duplicateSideEffects: 1,
      crossVersionDuplicates: 1,
    },
  ]);
  assert.equal(failing.passed, false);
  assert.deepEqual(
    new Set(failing.failedMetrics),
    new Set([
      'directPrecision',
      'directPositiveWindowRecall',
      'inferenceAutoCommits',
      'nonVerbatimEvidence',
      'tombstoneRevivals',
      'scopeMixes',
      'credentialLeaks',
      'duplicateSideEffects',
      'crossVersionDuplicates',
    ]),
  );
});

test('逐字证据按内部 turn ID 映射正文而不是误用外部 ID', () => {
  const turnContentById = new Map([
    ['internal-turn-uuid', '周一晨会前我选择桂花乌龙。'],
  ]);
  assert.equal(countNonVerbatimEvidence([
    {
      turnId: 'internal-turn-uuid',
      excerpt: '我选择桂花乌龙',
    },
  ], turnContentById), 0);
  assert.equal(countNonVerbatimEvidence([
    {
      turnId: 'external-turn-id',
      excerpt: '我选择桂花乌龙',
    },
  ], turnContentById), 1);
});

test('跨窗口合并证据从隔离数据库读取全部内部 turn 正文', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(
      'CREATE TABLE conversation_turns (id TEXT PRIMARY KEY, content TEXT NOT NULL)',
    );
    database.prepare(
      'INSERT INTO conversation_turns (id, content) VALUES (?, ?)',
    ).run('prior-window-turn', '我的常用饮品是桂花乌龙。');
    database.prepare(
      'INSERT INTO conversation_turns (id, content) VALUES (?, ?)',
    ).run('current-window-turn', '周一晨会前我选择桂花乌龙。');
    const evidence = [
      { turnId: 'prior-window-turn', excerpt: '常用饮品是桂花乌龙' },
      { turnId: 'current-window-turn', excerpt: '我选择桂花乌龙' },
    ];

    const content = loadEvidenceTurnContent(database, evidence);

    assert.equal(content.size, 2);
    assert.equal(countNonVerbatimEvidence(evidence, content), 0);
  } finally {
    database.close();
  }
});

test('--validate-fixture 只校验固定集并输出机器可读摘要', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/evaluate-context-reflection-quality.mjs', '--validate-fixture'],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMORY_BRIDGE_OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'valid');
  assert.equal(output.queryCases, 120);
  assert.equal(output.reflectionWindows, 100);
  assert.match(output.datasetSha256, /^[0-9a-f]{64}$/u);
});
