import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryLifecycle } from '../src/server/memory-lifecycle.js';
import {
  openDatabase,
  SCHEMA_VERSION,
} from '../src/server/database.js';
import {
  LifecycleStore,
  type MemoryCandidateInput,
} from '../src/server/lifecycle-store.js';
import {
  MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
} from '../src/server/memory-extractor.js';
import { MemoryStore } from '../src/server/memory-store.js';
import {
  NAMESPACE_QUALITY_DATASET_ID,
  NAMESPACE_QUALITY_DATASET_SHA256,
  NAMESPACE_QUALITY_EVALUATOR_VERSION,
  NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
  NamespaceGatedCandidateResolver,
  NamespaceQualityService,
  NamespaceRecallCoordinator,
  type AiriRecallContext,
  type NamespaceQualitySnapshotInput,
} from '../src/server/namespace-quality.js';
import type {
  MemoryRecord,
  RecallResult,
} from '../src/server/types.js';

const USER_ID = 'quality-user';
const NAMESPACE = 'project:airi';
const NOW = '2026-07-30T08:00:00.000Z';

test('当前 namespace evaluator 使用 v12 数值语义门禁', () => {
  assert.equal(
    NAMESPACE_QUALITY_EVALUATOR_VERSION,
    'namespace-quality-evaluator-v12',
  );
  assert.match(
    NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
    /^[0-9a-f]{64}$/u,
  );
});

function createFixture(now = NOW) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-namespace-quality-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const quality = new NamespaceQualityService(database, {
    now: () => now,
  });
  return {
    database,
    store,
    lifecycleStore,
    quality,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function snapshotInput(
  id: string,
  namespace = NAMESPACE,
  metrics: Partial<
    NamespaceQualitySnapshotInput['metrics']
  > = {},
): NamespaceQualitySnapshotInput {
  return {
    id,
    userId: USER_ID,
    namespace,
    metrics: {
      extractionPrecision: 0.99,
      candidateRecall: 0.95,
      credentialSaves: 0,
      conflictAccuracy: 0.99,
      semanticDuplicateRate: 0.005,
      ...metrics,
    },
    samples: {
      extractionPrecision: 200,
      candidateRecall: 200,
      credentialSafety: 50,
      conflictResolution: 100,
      semanticDuplicate: 200,
    },
    modelVersions: {
      extraction: 'qwen2.5:14b',
      relation: 'qwen2.5:14b',
      rerank: 'qwen2.5:14b',
      embedding: 'bge-m3:latest',
      extractorImplementation:
        MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
      qualityPipelineImplementation:
        NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
    },
    promptVersions: {
      extraction: 'extract-v6',
      relation: 'claim-relation-v1',
      rerank: 'rerank-v1',
    },
    evaluatorVersion: NAMESPACE_QUALITY_EVALUATOR_VERSION,
    datasetId: NAMESPACE_QUALITY_DATASET_ID,
    datasetSha256: NAMESPACE_QUALITY_DATASET_SHA256,
    evaluatedAt: NOW,
  };
}

function recallResult(memory: MemoryRecord): RecallResult {
  return {
    memory,
    score: 0.99,
    reasons: ['deterministic-test'],
    explanation: {
      lexicalRank: null,
      annRank: 1,
      termRank: null,
      semanticSimilarity: 0.99,
      rerankConfidence: 0.99,
      importance: memory.importance,
      memoryConfidence: memory.confidence,
      recency: 1,
      status: memory.status,
      conflictState: 'none',
      diversityPenalty: 0,
    },
  };
}

function recallContext(
  memory: MemoryRecord,
  context: string,
): AiriRecallContext {
  return {
    query: '我喜欢什么颜色？',
    memories: [recallResult(memory)],
    context,
    qualityState: 'full',
  };
}

function candidateInput(
  predicate: string,
  value: string,
): MemoryCandidateInput {
  return {
    kind: 'preference',
    subject: '用户',
    predicate,
    value,
    content: `用户的${predicate}是${value}。`,
    sourceExcerpt: `我的${predicate}是${value}。`,
    confidence: 0.99,
    importance: 0.8,
  };
}

test('当前 schema 保留 namespace 门禁、shadow 审计和语义 tombstone 字段', () => {
  const fixture = createFixture();
  try {
    assert.equal(
      Number(
        fixture.database
          .prepare('PRAGMA user_version')
          .get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    assert.equal(
      Number(
        fixture.database
          .prepare('PRAGMA secure_delete')
          .get()?.secure_delete,
      ),
      1,
    );
    for (const table of [
      'namespace_quality_snapshots',
      'namespace_rollout_state',
      'namespace_recall_shadow_comparisons',
    ]) {
      assert.equal(
        fixture.database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = ?`,
          )
          .get(table)?.name,
        table,
      );
    }
    const tombstoneColumns = fixture.database
      .prepare('PRAGMA table_info(memory_tombstones)')
      .all()
      .map((row) => row.name);
    for (const column of [
      'kind',
      'normalized_key',
      'normalized_value',
      'semantic_fingerprint',
    ]) {
      assert.ok(tombstoneColumns.includes(column));
    }
    assert.equal(
      fixture.database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name = 'memory_tombstones_normalized_key_idx'`,
        )
        .get()?.name,
      'memory_tombstones_normalized_key_idx',
    );
  } finally {
    fixture.close();
  }
});

test('schema v23 迁移会为现存 tombstone 回填规范化语义字段', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-v23-quality-migration-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const database = openDatabase(filePath);
    const store = new MemoryStore(database);
    const memory = store.remember({
      userId: USER_ID,
      namespace: NAMESPACE,
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'personal::self::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'b'.repeat(64),
    }).memory;
    store.forget(memory.id, 'migration-test', USER_ID);
    database.exec(`
      DROP INDEX memory_tombstones_normalized_key_idx;
      ALTER TABLE memory_tombstones DROP COLUMN semantic_fingerprint;
      ALTER TABLE memory_tombstones DROP COLUMN normalized_value;
      ALTER TABLE memory_tombstones DROP COLUMN normalized_key;
      ALTER TABLE memory_tombstones DROP COLUMN kind;
      PRAGMA user_version = 23;
    `);
    database.close();

    const migrated = openDatabase(filePath);
    const tombstone = migrated
      .prepare(
        `SELECT
           kind, normalized_key, normalized_value,
           semantic_fingerprint
         FROM memory_tombstones
         WHERE memory_item_id = ?`,
      )
      .get(memory.id);
    assert.deepEqual({
      kind: tombstone?.kind,
      normalized_key: tombstone?.normalized_key,
      normalized_value: tombstone?.normalized_value,
    }, {
      kind: 'preference',
      normalized_key: '用户::主要编辑器',
      normalized_value: 'VS Code',
    });
    const semanticFingerprint = String(
      tombstone?.semantic_fingerprint || '',
    );
    assert.ok(semanticFingerprint.length > 100);
    assert.equal(semanticFingerprint.includes('VS Code'), false);
    assert.equal(
      semanticFingerprint.includes('用户::主要编辑器'),
      false,
    );
    assert.equal(
      (JSON.parse(semanticFingerprint) as { version?: unknown })
        .version,
      1,
    );
    assert.equal(
      Number(
        migrated.prepare('PRAGMA user_version').get()?.user_version,
      ),
      SCHEMA_VERSION,
    );
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('未评测 namespace 在全局 auto 下仍回退 shadow', () => {
  const fixture = createFixture();
  try {
    assert.deepEqual(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        NAMESPACE,
        'auto',
      ),
      {
        mode: 'shadow',
        qualityState: 'unassessed',
        reason: 'quality_not_evaluated',
        snapshotId: null,
        revision: 0,
      },
    );
    assert.equal(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        NAMESPACE,
        'shadow',
      ).reason,
      'global_shadow_ceiling',
    );
    assert.equal(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        NAMESPACE,
        'off',
      ).mode,
      'off',
    );
  } finally {
    fixture.close();
  }
});

test('通过质量快照开启 auto，指标下降立即回退且完整留痕', () => {
  const fixture = createFixture();
  try {
    const passed = fixture.quality.recordSnapshot(
      snapshotInput('quality-pass'),
    );
    assert.equal(passed.passed, true);
    assert.equal(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        NAMESPACE,
        'auto',
      ).mode,
      'auto',
    );
    assert.deepEqual(
      fixture.quality.latestSnapshot(USER_ID, NAMESPACE),
      passed,
    );

    const failed = fixture.quality.recordSnapshot(
      snapshotInput('quality-regression', NAMESPACE, {
        extractionPrecision: 0.97,
        credentialSaves: 1,
      }),
    );
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.failedMetrics, [
      'extractionPrecision',
      'credentialSafety',
    ]);
    assert.deepEqual(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        NAMESPACE,
        'auto',
      ),
      {
        mode: 'shadow',
        qualityState: 'failed',
        reason: 'quality_gate_failed',
        snapshotId: 'quality-regression',
        revision: 2,
      },
    );
    const auditRows = fixture.database
      .prepare(
        `SELECT action, detail_json
         FROM audit_log
         WHERE user_id = ?
           AND action = 'namespace_quality_evaluated'
         ORDER BY id ASC`,
      )
      .all(USER_ID);
    assert.equal(auditRows.length, 2);
    const auditDetail = JSON.parse(
      String(auditRows[1].detail_json),
    ) as Record<string, unknown>;
    assert.equal(auditDetail.snapshotId, 'quality-regression');
    assert.equal(auditDetail.passed, false);
    assert.deepEqual(
      auditDetail.failedMetrics,
      failed.failedMetrics,
    );
    assert.throws(
      () =>
        fixture.quality.bootstrapAuto({
          userId: USER_ID,
          namespace: NAMESPACE,
          reason: '不得绕过失败评测',
          actor: 'test',
          expiresAt: '2026-07-31T08:00:00.000Z',
        }),
      /不能用 bootstrap 绕过门禁/,
    );
  } finally {
    fixture.close();
  }
});

test('质量状态严格按 user + namespace 隔离', () => {
  const fixture = createFixture();
  try {
    fixture.quality.recordSnapshot(
      snapshotInput('namespace-a-pass', 'project:a'),
    );
    assert.equal(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        'project:a',
        'auto',
      ).mode,
      'auto',
    );
    assert.equal(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        'project:b',
        'auto',
      ).mode,
      'shadow',
    );
    assert.equal(
      fixture.quality.effectiveAutomationMode(
        'another-user',
        'project:a',
        'auto',
      ).mode,
      'shadow',
    );
  } finally {
    fixture.close();
  }
});

test('模型或提示词版本变化会让已通过 namespace 回退 shadow', () => {
  const fixture = createFixture();
  try {
    const mismatched = snapshotInput('runtime-mismatch');
    mismatched.promptVersions = {
      extraction: 'extract-v1',
      relation: 'claim-relation-v1',
    };
    assert.equal(
      fixture.quality.recordSnapshot(mismatched).passed,
      true,
    );
    assert.deepEqual(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        NAMESPACE,
        'auto',
      ),
      {
        mode: 'shadow',
        qualityState: 'passed',
        reason: 'runtime_version_mismatch',
        snapshotId: 'runtime-mismatch',
        revision: 1,
      },
    );
  } finally {
    fixture.close();
  }
});

test('提取器实现版本变化会让旧 namespace 快照回退 shadow', () => {
  const fixture = createFixture();
  try {
    const mismatched = snapshotInput(
      'extractor-implementation-mismatch',
    );
    mismatched.modelVersions.extractorImplementation =
      'ollama-structured-memory-extractor-v9';
    assert.equal(
      fixture.quality.recordSnapshot(mismatched).passed,
      true,
    );
    assert.deepEqual(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        NAMESPACE,
        'auto',
      ),
      {
        mode: 'shadow',
        qualityState: 'passed',
        reason: 'runtime_version_mismatch',
        snapshotId: 'extractor-implementation-mismatch',
        revision: 1,
      },
    );
  } finally {
    fixture.close();
  }
});

test('质量流水线源码指纹变化会让旧 namespace 快照回退 shadow', () => {
  const fixture = createFixture();
  try {
    const mismatched = snapshotInput(
      'quality-pipeline-implementation-mismatch',
    );
    mismatched.modelVersions.qualityPipelineImplementation =
      'f'.repeat(64);
    assert.equal(
      fixture.quality.recordSnapshot(mismatched).passed,
      true,
    );
    assert.deepEqual(
      fixture.quality.effectiveAutomationMode(
        USER_ID,
        NAMESPACE,
        'auto',
      ),
      {
        mode: 'shadow',
        qualityState: 'passed',
        reason: 'runtime_version_mismatch',
        snapshotId: 'quality-pipeline-implementation-mismatch',
        revision: 1,
      },
    );
  } finally {
    fixture.close();
  }
});

test('evaluator 或固定数据集身份变化会让 namespace 回退 shadow', () => {
  const fixture = createFixture();
  try {
    const cases = [
      {
        namespace: 'identity:evaluator',
        mutate(input: NamespaceQualitySnapshotInput) {
          input.evaluatorVersion = 'namespace-quality-evaluator-v10';
        },
      },
      {
        namespace: 'identity:dataset-id',
        mutate(input: NamespaceQualitySnapshotInput) {
          input.datasetId = 'airi-memory-quality-v0';
        },
      },
      {
        namespace: 'identity:dataset-sha',
        mutate(input: NamespaceQualitySnapshotInput) {
          input.datasetSha256 = 'b'.repeat(64);
        },
      },
    ];
    for (const entry of cases) {
      const input = snapshotInput(
        `snapshot-${entry.namespace}`,
        entry.namespace,
      );
      entry.mutate(input);
      assert.equal(
        fixture.quality.recordSnapshot(input).passed,
        true,
      );
      assert.deepEqual(
        fixture.quality.effectiveAutomationMode(
          USER_ID,
          entry.namespace,
          'auto',
        ),
        {
          mode: 'shadow',
          qualityState: 'passed',
          reason: 'runtime_version_mismatch',
          snapshotId: `snapshot-${entry.namespace}`,
          revision: 1,
        },
      );
    }
  } finally {
    fixture.close();
  }
});

test('显式 bootstrap 有审计和期限，过期自动回退 shadow', () => {
  let currentTime = NOW;
  const fixture = createFixture();
  const quality = new NamespaceQualityService(fixture.database, {
    now: () => currentTime,
  });
  try {
    const enabled = quality.bootstrapAuto({
      userId: USER_ID,
      namespace: 'bootstrap-only',
      reason: '隔离库真实 AIRI 验收',
      actor: 'test-operator',
      expiresAt: '2026-07-30T10:00:00.000Z',
    });
    assert.equal(enabled.mode, 'auto');
    assert.equal(enabled.qualityState, 'bootstrap');
    assert.equal(enabled.reason, 'bootstrap_override_active');
    const audit = fixture.database
      .prepare(
        `SELECT detail_json FROM audit_log
         WHERE user_id = ?
           AND action = 'namespace_quality_bootstrap_enabled'`,
      )
      .get(USER_ID);
    assert.match(String(audit?.detail_json), /test-operator/);
    assert.match(String(audit?.detail_json), /真实 AIRI 验收/);

    currentTime = '2026-07-30T09:00:00.000Z';
    const repeated = quality.bootstrapAuto({
      userId: USER_ID,
      namespace: 'bootstrap-only',
      reason: '重启不应续期',
      actor: 'startup-config',
      expiresAt: '2026-07-31T10:00:00.000Z',
    });
    assert.equal(repeated.mode, 'auto');
    const beforeExpiry = fixture.database
      .prepare(
        `SELECT override_reason, override_actor,
                override_created_at, override_expires_at, revision
         FROM namespace_rollout_state
         WHERE user_id = ? AND namespace = ?`,
      )
      .get(USER_ID, 'bootstrap-only');
    assert.deepEqual({ ...beforeExpiry }, {
      override_reason: '隔离库真实 AIRI 验收',
      override_actor: 'test-operator',
      override_created_at: NOW,
      override_expires_at: '2026-07-30T10:00:00.000Z',
      revision: 1,
    });

    currentTime = '2026-07-30T10:00:00.001Z';
    assert.equal(
      quality.effectiveAutomationMode(
        USER_ID,
        'bootstrap-only',
        'auto',
      ).reason,
      'bootstrap_override_expired',
    );
    assert.equal(
      quality.effectiveAutomationMode(
        USER_ID,
        'bootstrap-only',
        'auto',
      ).mode,
      'shadow',
    );
    const afterExpiry = quality.bootstrapAuto({
      userId: USER_ID,
      namespace: 'bootstrap-only',
      reason: '过期后重启也不能续期',
      actor: 'startup-config',
      expiresAt: '2026-07-31T10:00:00.000Z',
    });
    assert.equal(afterExpiry.mode, 'shadow');
    assert.equal(afterExpiry.reason, 'bootstrap_override_expired');
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM audit_log
             WHERE user_id = ?
               AND action = 'namespace_quality_bootstrap_enabled'`,
          )
          .get(USER_ID)?.count,
      ),
      1,
    );
  } finally {
    fixture.close();
  }
});

test('候选自动提交动态服从 namespace 门禁并在质量回归后降级', async () => {
  const fixture = createFixture();
  try {
    const resolver = new NamespaceGatedCandidateResolver(
      fixture.database,
      fixture.lifecycleStore,
      fixture.store,
      fixture.quality,
      'auto',
      {
        autoCommitMinConfidence: 0.95,
        autoCommitMinImportance: 0.5,
      },
    );
    let sequence = 0;
    const candidate = (
      predicate: string,
      value: string,
    ) => {
      sequence += 1;
      const turn = fixture.lifecycleStore.recordTurn({
        userId: USER_ID,
        namespace: NAMESPACE,
        clientName: 'client',
        sessionExternalId: `session-${sequence}`,
        turnExternalId: `turn-${sequence}`,
        role: 'user',
        content: `我的${predicate}是${value}。`,
      });
      const runId = fixture.lifecycleStore.startExtraction(
        turn.turn.id,
        'qwen2.5:14b',
        'extract-v1',
      );
      return fixture.lifecycleStore.completeExtraction(
        runId,
        [candidateInput(predicate, value)],
      )[0];
    };

    const beforeGate = candidate('主要编辑器', 'VS Code');
    const shadow = await resolver.resolve(beforeGate.id);
    assert.equal(shadow.state, 'pending');
    assert.equal(shadow.reason, 'shadow_mode');
    assert.equal(fixture.store.list({ userId: USER_ID }).total, 0);

    fixture.quality.recordSnapshot(snapshotInput('gate-passed'));
    const accepted = await resolver.resolve(beforeGate.id);
    assert.equal(accepted.state, 'accepted');
    assert.equal(fixture.store.list({ userId: USER_ID }).total, 1);

    fixture.quality.recordSnapshot(
      snapshotInput('gate-failed', NAMESPACE, {
        conflictAccuracy: 0.97,
      }),
    );
    const afterRegression = candidate('主题颜色', '蓝色');
    const downgraded = await resolver.resolve(afterRegression.id);
    assert.equal(downgraded.state, 'pending');
    assert.equal(downgraded.reason, 'shadow_mode');
    assert.equal(fixture.store.list({ userId: USER_ID }).total, 1);
  } finally {
    fixture.close();
  }
});

test('AIRI 检索注入与候选自动提交门禁解耦，full hybrid 在 shadow 下也注入', async () => {
  const fixture = createFixture();
  try {
    const hybridMemory = fixture.store.remember({
      userId: USER_ID,
      namespace: NAMESPACE,
      kind: 'preference',
      content: '用户最喜欢蓝色。',
    }).memory;
    const legacyMemory = fixture.store.remember({
      userId: USER_ID,
      namespace: NAMESPACE,
      kind: 'preference',
      content: '用户以前喜欢红色。',
    }).memory;
    const hybrid = recallContext(
      hybridMemory,
      'HYBRID_NEW_CONTEXT',
    );
    const legacy = recallContext(
      legacyMemory,
      'LEGACY_FTS_CONTEXT',
    );
    const coordinator = new NamespaceRecallCoordinator(
      fixture.database,
      fixture.store,
      fixture.quality,
      {
        globalMode: 'auto',
        hybridRecall: async () => hybrid,
        legacyRecall: () => legacy,
        now: () => NOW,
      },
    );
    const lifecycle = new MemoryLifecycle(
      fixture.store,
      fixture.lifecycleStore,
      USER_ID,
      NAMESPACE,
      undefined,
      coordinator,
    );
    const request = {
      model: 'qwen2.5:14b',
      messages: [
        { role: 'user', content: '我喜欢什么颜色？' },
      ],
    };
    const shadowPrepared = await lifecycle.beforeModel(
      request,
      'shadow-request',
    );
    const shadowMessages =
      shadowPrepared.messages as Array<Record<string, unknown>>;
    assert.equal(shadowMessages.length, 2);
    assert.match(
      String(shadowMessages[0].content),
      /用户最喜欢蓝色/u,
    );
    assert.doesNotMatch(
      String(shadowMessages[0].content),
      /用户以前喜欢红色/u,
    );
    assert.doesNotMatch(
      String(shadowMessages[0].content),
      /LEGACY_FTS_CONTEXT|HYBRID_NEW_CONTEXT/u,
    );
    const shadowAudit = fixture.database
      .prepare(
        `SELECT * FROM namespace_recall_shadow_comparisons
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get();
    assert.equal(shadowAudit?.injection_path, 'hybrid');
    assert.equal(shadowAudit?.effective_mode, 'shadow');
    assert.equal(
      shadowAudit?.decision_reason,
      'quality_not_evaluated',
    );
    assert.deepEqual(
      JSON.parse(String(shadowAudit?.new_result_ids_json)),
      [hybridMemory.id],
    );
    assert.deepEqual(
      JSON.parse(String(shadowAudit?.legacy_result_ids_json)),
      [legacyMemory.id],
    );
    assert.deepEqual(
      JSON.parse(String(shadowAudit?.injected_result_ids_json)),
      [hybridMemory.id],
    );
    assert.deepEqual(
      JSON.parse(String(shadowAudit?.new_only_ids_json)),
      [hybridMemory.id],
    );

    fixture.quality.recordSnapshot(snapshotInput('recall-passed'));
    const autoPrepared = await lifecycle.beforeModel(
      request,
      'auto-request',
    );
    const autoMessages =
      autoPrepared.messages as Array<Record<string, unknown>>;
    assert.match(
      String(autoMessages[0].content),
      /用户最喜欢蓝色/u,
    );
    assert.doesNotMatch(
      String(autoMessages[0].content),
      /用户以前喜欢红色/u,
    );
    assert.doesNotMatch(
      String(autoMessages[0].content),
      /LEGACY_FTS_CONTEXT|HYBRID_NEW_CONTEXT/u,
    );
    const autoAudit = fixture.database
      .prepare(
        `SELECT * FROM namespace_recall_shadow_comparisons
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get();
    assert.equal(autoAudit?.injection_path, 'hybrid');
    assert.equal(autoAudit?.effective_mode, 'auto');
    assert.equal(autoAudit?.quality_state, 'passed');
    assert.equal(autoAudit?.snapshot_id, 'recall-passed');
  } finally {
    fixture.close();
  }
});

test('AIRI 只注入 full hybrid，degraded/unavailable 回退 legacy 且 full 空结果保持弃答', async () => {
  const fixture = createFixture();
  try {
    const hybridMemory = fixture.store.remember({
      userId: USER_ID,
      namespace: NAMESPACE,
      kind: 'preference',
      content: '用户最喜欢蓝色。',
    }).memory;
    const legacyMemory = fixture.store.remember({
      userId: USER_ID,
      namespace: NAMESPACE,
      kind: 'preference',
      content: '用户以前喜欢红色。',
    }).memory;
    let hybrid: AiriRecallContext = {
      ...recallContext(hybridMemory, 'HYBRID_CONTEXT'),
      grounding: [{
        memoryId: hybridMemory.id,
        versionId: `${hybridMemory.id}:v1`,
        evidence: [{
          evidenceType: 'direct_user_statement',
          turnId: 'turn-blue',
          sourceRef: null,
        }],
        proofCount: 1,
        firstEvidenceAt: NOW,
        lastEvidenceAt: NOW,
        excerpts: ['我最喜欢蓝色。'],
      }],
    };
    const legacy: AiriRecallContext = {
      ...recallContext(legacyMemory, 'LEGACY_CONTEXT'),
      qualityState: 'degraded',
    };
    const coordinator = new NamespaceRecallCoordinator(
      fixture.database,
      fixture.store,
      fixture.quality,
      {
        globalMode: 'shadow',
        hybridRecall: async () => hybrid,
        legacyRecall: () => legacy,
        now: () => NOW,
      },
    );
    const input = {
      userId: USER_ID,
      namespace: NAMESPACE,
      query: '我喜欢什么颜色？',
    };

    const full = await coordinator.recallForLifecycle(input);
    assert.equal(full.injectionPath, 'hybrid');
    assert.equal(full.qualityState, 'full');
    assert.deepEqual(
      full.memories.map((result) => result.memory.id),
      [hybridMemory.id],
    );
    assert.deepEqual(full.grounding, hybrid.grounding);

    hybrid = { ...hybrid, qualityState: 'degraded' };
    const degraded = await coordinator.recallForLifecycle(input);
    assert.equal(degraded.injectionPath, 'legacy_fts');
    assert.equal(degraded.qualityState, 'degraded');
    assert.deepEqual(
      degraded.memories.map((result) => result.memory.id),
      [legacyMemory.id],
    );
    assert.equal(degraded.grounding, undefined);

    hybrid = { ...hybrid, qualityState: 'unavailable' };
    const unavailable = await coordinator.recallForLifecycle(input);
    assert.equal(unavailable.injectionPath, 'legacy_fts');
    assert.equal(unavailable.qualityState, 'degraded');
    assert.deepEqual(
      unavailable.memories.map((result) => result.memory.id),
      [legacyMemory.id],
    );
    assert.equal(unavailable.grounding, undefined);

    hybrid = {
      query: input.query,
      memories: [],
      context: 'HYBRID_FULL_EMPTY',
      qualityState: 'full',
      grounding: [],
    };
    const fullEmpty = await coordinator.recallForLifecycle(input);
    assert.equal(fullEmpty.injectionPath, 'none');
    assert.equal(fullEmpty.qualityState, 'full');
    assert.deepEqual(fullEmpty.memories, []);
    assert.deepEqual(fullEmpty.grounding, []);
  } finally {
    fixture.close();
  }
});

test('AIRI degraded hybrid 回退 legacy 时共用多作用域并执行同谓词遮蔽', async () => {
  const fixture = createFixture();
  try {
    const rememberLayer = (
      scopeType: 'personal' | 'role' | 'session',
      scopeKey: string,
      answer: string,
    ) => fixture.store.remember({
      userId: USER_ID,
      namespace: NAMESPACE,
      kind: 'preference',
      content: `AIRI 分层 shadow 验证：当前称呼答案是${answer}。`,
      scopeType,
      scopeKey,
      stableKey: `${scopeType}::${scopeKey}::用户::当前称呼`,
      predicateKey: '用户::当前称呼',
      normalizedValue: answer,
      normalizedValueHash: `${scopeType}-${scopeKey}-${answer}`,
    }).memory;
    const personal = rememberLayer('personal', 'self', '个人称呼');
    const role = rememberLayer('role', 'persona-a', '角色称呼');
    const session = rememberLayer(
      'session',
      'persona-a:session-1',
      '会话称呼',
    );
    const unauthorized = rememberLayer(
      'role',
      'persona-b',
      '其他角色称呼',
    );
    const differentPredicate = fixture.store.remember({
      userId: USER_ID,
      namespace: NAMESPACE,
      kind: 'preference',
      content:
        'AIRI 分层 shadow 验证：当前称呼对话中的输出风格答案是简洁。',
      scopeType: 'personal',
      scopeKey: 'self',
      stableKey: 'personal::self::用户::输出风格',
      predicateKey: '用户::输出风格',
      normalizedValue: '简洁',
      normalizedValueHash: 'airi-shadow-concise',
    }).memory;
    const coordinator = new NamespaceRecallCoordinator(
      fixture.database,
      fixture.store,
      fixture.quality,
      {
        globalMode: 'auto',
        hybridRecall: async (input) => ({
          query: input.query,
          memories: [],
          context: 'HYBRID_EMPTY',
          qualityState: 'degraded',
        }),
        now: () => NOW,
      },
    );

    const selected = await coordinator.recallForLifecycle({
      userId: USER_ID,
      namespace: NAMESPACE,
      query: 'AIRI 分层 shadow 验证 当前称呼 输出风格',
      scopes: [
        { scopeType: 'session', scopeKey: 'persona-a:session-1' },
        { scopeType: 'role', scopeKey: 'persona-a' },
        { scopeType: 'personal', scopeKey: 'self' },
      ],
      limit: 10,
    });
    const ids = selected.memories
      .map((result) => result.memory.id)
      .sort();

    assert.equal(selected.injectionPath, 'legacy_fts');
    assert.deepEqual(ids, [session.id, differentPredicate.id].sort());
    assert.ok(!ids.includes(personal.id));
    assert.ok(!ids.includes(role.id));
    assert.ok(!ids.includes(unauthorized.id));
  } finally {
    fixture.close();
  }
});
