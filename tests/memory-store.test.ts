import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import { openDatabase } from '../src/server/database.js';
import {
  consolidationSweepSuccessorId,
  LifecycleStore,
} from '../src/server/lifecycle-store.js';
import { MemoryAdminService } from '../src/server/memory-admin.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';

function createStore() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-store-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycleStore,
    store,
    { mode: 'auto' },
  );
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    store,
  );
  return {
    database,
    store,
    lifecycleStore,
    admin: new MemoryAdminService(
      database,
      store,
      lifecycleStore,
      resolver,
      governance,
    ),
    close: () => {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('稳定系统 sweep 接管后 legacy 用户所有权死信只保留为已解决历史', () => {
  const fixture = createStore();
  try {
    const legacy = fixture.lifecycleStore.enqueueJob({
      id: 'consolidation-sweep:root',
      jobType: 'consolidation_sweep',
      userId: 'alice',
      namespace: 'legacy-personal',
      payload: { scheduledAt: '2026-07-31T00:00:00.000Z' },
      maxAttempts: 1,
    });
    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET status = 'dead', attempts = max_attempts,
             last_error = '旧默认账户所有权漂移'
         WHERE id = ?`,
      )
      .run(legacy.id);
    fixture.database
      .prepare(
        `INSERT INTO dead_letter_jobs (
           job_id, job_type, user_id, namespace, payload_json,
           attempts, last_error, failed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        legacy.id,
        legacy.jobType,
        legacy.userId,
        legacy.namespace,
        JSON.stringify(legacy.payload),
        legacy.maxAttempts,
        '旧默认账户所有权漂移',
        '2026-07-31T00:00:00.000Z',
      );

    const completedSystemId = consolidationSweepSuccessorId(
      'stable-system-bootstrap',
    );
    fixture.lifecycleStore.enqueueJob({
      id: completedSystemId,
      jobType: 'consolidation_sweep',
      userId: '__memory_bridge_system__',
      namespace: '__global__',
      payload: { scheduledAt: '2026-08-01T00:00:00.000Z' },
    });
    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET status = 'completed', updated_at = ?
         WHERE id = ?`,
      )
      .run('2026-08-01T00:01:00.000Z', completedSystemId);
    const activeSystemId = consolidationSweepSuccessorId(
      completedSystemId,
    );
    fixture.lifecycleStore.enqueueJob({
      id: activeSystemId,
      jobType: 'consolidation_sweep',
      userId: '__memory_bridge_system__',
      namespace: '__global__',
      payload: { scheduledAt: '2026-08-01T00:15:00.000Z' },
    });

    const health = fixture.admin.systemHealth(
      { ollamaAvailable: true },
      'alice',
    );

    assert.equal(health.quality, 'full');
    assert.equal(health.deadLetterCount, 0);
    assert.equal(health.deadLetterHistoryCount, 1);
    assert.equal(health.deadLetters[0]?.jobId, legacy.id);
    assert.equal(health.deadLetters[0]?.resolved, true);
    assert.equal(
      health.queues.some((queue) => queue.status === 'dead'),
      false,
    );
    assert.equal(
      health.deadLetters[0]?.recoveryJobId,
      activeSystemId,
    );
  } finally {
    fixture.close();
  }
});

test('真正的稳定系统 sweep 死信会让所有账户 health unavailable', () => {
  const fixture = createStore();
  try {
    const systemJobId = consolidationSweepSuccessorId(
      'unresolved-system-failure',
    );
    const systemJob = fixture.lifecycleStore.enqueueJob({
      id: systemJobId,
      jobType: 'consolidation_sweep',
      userId: '__memory_bridge_system__',
      namespace: '__global__',
      payload: { scheduledAt: '2026-08-02T00:00:00.000Z' },
      maxAttempts: 1,
    });
    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET status = 'dead', attempts = max_attempts,
             last_error = '稳定系统 sweep 真实失败'
         WHERE id = ?`,
      )
      .run(systemJob.id);
    fixture.database
      .prepare(
        `INSERT INTO dead_letter_jobs (
           job_id, job_type, user_id, namespace, payload_json,
           attempts, last_error, failed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        systemJob.id,
        systemJob.jobType,
        systemJob.userId,
        systemJob.namespace,
        JSON.stringify(systemJob.payload),
        systemJob.maxAttempts,
        '稳定系统 sweep 真实失败',
        systemJob.updatedAt,
      );

    for (const principalId of ['alice', 'bob']) {
      const health = fixture.admin.systemHealth(
        { ollamaAvailable: true },
        principalId,
      );
      assert.equal(health.quality, 'unavailable');
      assert.equal(health.deadLetterCount, 1);
      assert.equal(health.deadLetters[0]?.jobId, systemJob.id);
      assert.equal(health.deadLetters[0]?.resolved, false);
      assert.throws(
        () => fixture.lifecycleStore.recoverDeadLetterJob(
          systemJob.id,
          principalId,
          systemJob.namespace,
          'recompute',
        ),
        /不属于当前账户/u,
      );
    }
  } finally {
    fixture.close();
  }
});

test('写入、去重、中文召回和访问计数形成闭环', () => {
  const fixture = createStore();
  try {
    const first = fixture.store.remember({
      kind: 'preference',
      title: '项目数据偏好',
      content: '用户要求忆桥项目首次打开必须为空数据，不能放演示数据。',
      tags: ['忆桥', '数据'],
      importance: 0.9,
      confidence: 1,
    });
    assert.equal(first.created, true);

    const duplicate = fixture.store.remember({
      kind: 'preference',
      content: '用户要求忆桥项目首次打开必须为空数据，不能放演示数据。',
      tags: ['产品要求'],
      importance: 0.8,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.deduplicated, true);
    assert.equal(fixture.store.list().total, 1);
    assert.deepEqual(
      new Set(duplicate.memory.tags),
      new Set(['忆桥', '数据', '产品要求']),
    );
    assert.equal(fixture.store.history(first.memory.id).length, 2);

    const recalled = fixture.store.recall({
      query: '忆桥项目的数据应该怎么处理？',
      limit: 5,
    });
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].memory.id, first.memory.id);
    assert.ok(recalled[0].score > 0.2);
    assert.equal(fixture.store.get(first.memory.id)?.accessCount, 1);

    const paraphrased = fixture.store.recall({
      query: '软件第一次启动时的数据要求是什么？',
    });
    assert.equal(paraphrased.length, 1);
    assert.equal(paraphrased[0].memory.id, first.memory.id);
  } finally {
    fixture.close();
  }
});

test('记忆列表在数据库查询阶段按账户、类型和 scope key 筛选', () => {
  const fixture = createStore();
  try {
    const personal = fixture.store.remember({
      userId: 'alice',
      namespace: 'shared',
      kind: 'profile',
      content: 'Alice 的个人共享记忆。',
    }).memory;
    const roleA = fixture.store.remember({
      userId: 'alice',
      namespace: 'shared',
      kind: 'relationship',
      content: 'Alice 与 persona A 的私有记忆。',
      scopeType: 'role',
      scopeKey: 'persona-a',
    }).memory;
    fixture.store.remember({
      userId: 'alice',
      namespace: 'shared',
      kind: 'relationship',
      content: 'Alice 与 persona B 的私有记忆。',
      scopeType: 'role',
      scopeKey: 'persona-b',
    });
    const session = fixture.store.remember({
      userId: 'alice',
      namespace: 'shared',
      kind: 'project',
      content: 'Alice 当前聊天私有记忆。',
      scopeType: 'session',
      scopeKey: 'session-a1',
    }).memory;
    fixture.store.remember({
      userId: 'bob',
      namespace: 'shared',
      kind: 'relationship',
      content: 'Bob 与同名 persona A 的私有记忆。',
      scopeType: 'role',
      scopeKey: 'persona-a',
    });

    assert.deepEqual(
      fixture.store.list({
        userId: 'alice',
        scopeType: 'personal',
      }).items.map((memory) => memory.id),
      [personal.id],
    );
    assert.deepEqual(
      fixture.store.list({
        userId: 'alice',
        scopeType: 'role',
        scopeKey: 'persona-a',
      }).items.map((memory) => memory.id),
      [roleA.id],
    );
    assert.deepEqual(
      fixture.store.list({
        userId: 'alice',
        scopeType: 'session',
        scopeKey: 'session-a1',
      }).items.map((memory) => memory.id),
      [session.id],
    );
    assert.equal(
      fixture.store.list({
        userId: 'alice',
        scopeType: 'role',
      }).total,
      2,
    );
    assert.throws(
      () => fixture.store.list({
        userId: 'alice',
        scopeKey: 'persona-a',
      }),
      /scopeType/u,
    );
  } finally {
    fixture.close();
  }
});

test('记忆可以替代、修改、软删除和恢复', async () => {
  const fixture = createStore();
  try {
    const oldMemory = fixture.store.remember({
      kind: 'project',
      content: '用户当前主要学习嵌入式开发。',
    }).memory;
    const replacement = fixture.store.remember({
      kind: 'project',
      content: '用户当前主要开发 AIRI 长期记忆 MCP 服务。',
      supersedesId: oldMemory.id,
    }).memory;

    assert.equal(
      fixture.store.get(oldMemory.id, true)?.status,
      'superseded',
    );
    assert.equal(fixture.store.relations(replacement.id).length, 1);

    const updated = fixture.store.update(replacement.id, {
      importance: 0.95,
      tags: ['AIRI', 'MCP'],
    });
    assert.equal(updated.importance, 0.95);
    assert.deepEqual(updated.tags, ['airi', 'mcp']);
    assert.equal(fixture.store.history(replacement.id).length, 2);

    assert.equal(
      fixture.store.forget(replacement.id).status,
      'deleted',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE restored_at IS NULL`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.store.forget(replacement.id).status,
      'deleted',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_events
           WHERE memory_item_id = ? AND event_type = 'forgotten'`,
        )
        .get(replacement.id)?.count,
      1,
    );
    let callbackCalls = 0;
    assert.throws(
      () => fixture.store.forget(
        replacement.id,
        '已删除目标不得冒领新请求',
        'default',
        {
          expectedNamespace: 'personal',
          authorizedScopes: [{
            scopeType: 'personal',
            scopeKey: 'self',
          }],
          beforeCommit: () => {
            callbackCalls += 1;
          },
        },
      ),
      /只能忘记当前有效或已归档/u,
    );
    assert.equal(callbackCalls, 0);
    assert.equal(fixture.store.get(replacement.id), null);
    assert.equal(
      (await fixture.admin.restoreMemory(replacement.id)).memory.status,
      'active',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE restored_at IS NULL`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_events
           WHERE memory_item_id = ?`,
        )
        .get(replacement.id)?.count,
      4,
    );
    assert.ok(fixture.store.audits().length >= 5);
  } finally {
    fixture.close();
  }
});

test('底层 remember 不能绕过 tombstone 且同谓词新值仍可保存', () => {
  const fixture = createStore();
  try {
    const original = fixture.store.remember({
      kind: 'preference',
      content: '用户要求软件第一次启动不能内置演示数据。',
      stableKey: 'personal::self::用户::软件首次打开数据要求',
      predicateKey: '用户::软件首次打开数据要求',
      normalizedValue: '第一次启动不能内置演示数据',
      normalizedValueHash: 'no-demo-data',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    fixture.store.forget(original.id);

    const tombstone = fixture.database
      .prepare(
        `SELECT kind, normalized_key, normalized_value, content_hash,
                semantic_fingerprint
         FROM memory_tombstones
         WHERE memory_item_id = ? AND restored_at IS NULL`,
      )
      .get(original.id);
    assert.equal(tombstone?.kind, 'preference');
    assert.equal(
      tombstone?.normalized_key,
      '用户::软件首次打开数据要求',
    );
    assert.equal(
      tombstone?.normalized_value,
      '第一次启动不能内置演示数据',
    );
    assert.equal(tombstone?.content_hash, original.checksum);
    assert.ok(String(tombstone?.semantic_fingerprint).length > 100);
    assert.doesNotMatch(
      String(tombstone?.semantic_fingerprint),
      /演示数据|首次打开|第一次启动/,
    );

    assert.throws(
      () => fixture.store.remember({
        kind: 'preference',
        content: '用户要求软件第一次启动不能内置演示数据。',
      }),
      /遗忘规则阻止/,
    );
    assert.throws(
      () => fixture.store.remember({
        kind: 'preference',
        content: '用户要求软件首次打开为空数据且不放演示内容。',
        stableKey: 'personal::self::用户::软件首次打开数据要求',
        predicateKey: '用户::软件首次打开数据要求',
        normalizedValue: '首次打开必须为空数据，不放演示内容',
        normalizedValueHash: 'no-demo-data-paraphrase',
        predicateCardinality: 'single',
      }),
      /遗忘规则阻止/,
    );

    const replacement = fixture.store.remember({
      kind: 'preference',
      content: '用户要求软件首次打开自动导入最小示例数据。',
      stableKey: 'personal::self::用户::软件首次打开数据要求',
      predicateKey: '用户::软件首次打开数据要求',
      normalizedValue: '自动导入一套最小示例数据',
      normalizedValueHash: 'minimal-sample-data',
      predicateCardinality: 'single',
    }).memory;
    assert.equal(replacement.status, 'active');
    assert.match(replacement.content, /自动导入/);

    const dislikedLatte = fixture.store.remember({
      kind: 'preference',
      content: '用户不喜欢拿铁咖啡。',
      stableKey: 'personal::self::用户::不喜欢的咖啡',
      predicateKey: '用户::不喜欢的咖啡',
      normalizedValue: '不喜欢拿铁',
      normalizedValueHash: 'dislike-latte',
      predicateCardinality: 'set',
    }).memory;
    fixture.store.forget(dislikedLatte.id);
    const dislikedAmericano = fixture.store.remember({
      kind: 'preference',
      content: '用户不喜欢美式咖啡。',
      stableKey: 'personal::self::用户::不喜欢的咖啡',
      predicateKey: '用户::不喜欢的咖啡',
      normalizedValue: '不喜欢美式',
      normalizedValueHash: 'dislike-americano',
      predicateCardinality: 'set',
    }).memory;
    assert.equal(dislikedAmericano.status, 'active');
    assert.match(dislikedAmericano.content, /美式/);
  } finally {
    fixture.close();
  }
});

test('修正正文时自动标题同步更新且自定义标题保持不变', () => {
  const fixture = createStore();
  try {
    const generated = fixture.store.remember({
      kind: 'preference',
      content: '用户回答偏好是简洁直接。',
    }).memory;
    const corrected = fixture.store.update(generated.id, {
      content: '用户修正：回答需要详细，并附带必要示例。',
    });
    assert.equal(
      corrected.title,
      '用户修正:回答需要详细,并附带必要示例。',
    );

    const custom = fixture.store.remember({
      kind: 'project',
      title: '固定项目标题',
      content: '项目当前使用旧方案。',
    }).memory;
    assert.equal(
      fixture.store.update(custom.id, {
        content: '项目已经改用新方案。',
      }).title,
      '固定项目标题',
    );
  } finally {
    fixture.close();
  }
});

test('includeArchived 也不会召回来源已非 active 的派生摘要', () => {
  const fixture = createStore();
  try {
    const source = fixture.store.remember({
      kind: 'preference',
      content: '用户在工作台使用海蓝色主题。',
      source: 'automatic-extraction',
    }).memory;
    const derived = fixture.store.remember({
      kind: 'preference',
      content: '派生摘要：用户在工作台使用海蓝色主题。',
      source: 'consolidation',
    }).memory;
    const sourceVersion = fixture.database
      .prepare(
        `SELECT current_version_id
         FROM memory_items WHERE id = ?`,
      )
      .get(source.id)?.current_version_id;
    const timestamp = new Date().toISOString();
    fixture.database
      .prepare(
        `INSERT INTO derived_consolidations (
           id, memory_id, user_id, namespace, scope_type, scope_key,
           source_set_hash, model, prompt_version, status, generated_at
         ) VALUES (
           ?, ?, 'default', 'personal', 'topic', 'theme',
           'source-set-theme', 'qwen2.5:14b', 'test-v1', 'active', ?
         )`,
      )
      .run('derived-source-status-test', derived.id, timestamp);
    fixture.database
      .prepare(
        `INSERT INTO derived_consolidation_sources (
           consolidation_id, memory_version_id
         ) VALUES (?, ?)`,
      )
      .run('derived-source-status-test', sourceVersion);
    fixture.database
      .prepare(
        `INSERT INTO derived_consolidation_sentences (
           id, consolidation_id, sentence_index, sentence_text, supported
         ) VALUES (?, ?, 0, ?, 1)`,
      )
      .run(
        'derived-source-status-sentence',
        'derived-source-status-test',
        '用户在工作台使用海蓝色主题。',
      );

    assert.ok(
      fixture.store.recall({
        query: '工作台使用什么颜色的主题？',
        includeArchived: true,
      }).some((result) => result.memory.id === derived.id),
    );

    fixture.database
      .prepare(
        `UPDATE memories SET status = 'archived' WHERE id = ?`,
      )
      .run(source.id);
    fixture.database
      .prepare(
        `UPDATE memory_items SET status = 'archived' WHERE id = ?`,
      )
      .run(source.id);

    const recalled = fixture.store.recall({
      query: '工作台使用什么颜色的主题？',
      includeArchived: true,
      limit: 10,
    });
    assert.ok(recalled.some((result) => result.memory.id === source.id));
    assert.ok(
      recalled.every((result) => result.memory.id !== derived.id),
    );
  } finally {
    fixture.close();
  }
});

test('派生摘要只覆盖逐句实际引用的原子来源', () => {
  const fixture = createStore();
  try {
    const first = fixture.store.remember({
      kind: 'preference',
      content: '用户偏好结论优先。',
      source: 'automatic-extraction',
    }).memory;
    const uncited = fixture.store.remember({
      kind: 'preference',
      content: '用户偏好深色界面。',
      source: 'automatic-extraction',
    }).memory;
    const derived = fixture.store.remember({
      kind: 'preference',
      content: '派生摘要：用户偏好结论优先。',
      source: 'consolidation',
    }).memory;
    const versionRows = fixture.database
      .prepare(
        `SELECT id, memory_item_id
         FROM memory_versions
         WHERE memory_item_id IN (?, ?)`,
      )
      .all(first.id, uncited.id) as Array<
        { id: string; memory_item_id: string }
      >;
    const versionByMemory = new Map(
      versionRows.map((row) => [row.memory_item_id, row.id]),
    );
    const timestamp = new Date().toISOString();
    fixture.database
      .prepare(
        `INSERT INTO derived_consolidations (
           id, memory_id, user_id, namespace, scope_type, scope_key,
           source_set_hash, model, prompt_version, status, generated_at
         ) VALUES (
           'derived-citation-coverage', ?, 'default', 'personal',
           'topic', 'preference', 'coverage-set', 'qwen2.5:14b',
           'consolidate-v3', 'active', ?
         )`,
      )
      .run(derived.id, timestamp);
    const insertSource = fixture.database.prepare(
      `INSERT INTO derived_consolidation_sources (
         consolidation_id, memory_version_id
       ) VALUES ('derived-citation-coverage', ?)`,
    );
    insertSource.run(versionByMemory.get(first.id));
    insertSource.run(versionByMemory.get(uncited.id));
    fixture.database
      .prepare(
        `INSERT INTO derived_consolidation_sentences (
           id, consolidation_id, sentence_index, sentence_text,
           supported
         ) VALUES (
           'derived-citation-sentence',
           'derived-citation-coverage', 0, ?, 1
         )`,
      )
      .run('用户偏好结论优先。');
    fixture.database
      .prepare(
        `INSERT INTO derived_sentence_sources (
           sentence_id, memory_version_id
         ) VALUES ('derived-citation-sentence', ?)`,
      )
      .run(versionByMemory.get(first.id));

    const explanation = {
      lexicalRank: 1,
      annRank: null,
      termRank: null,
      semanticSimilarity: 1,
      rerankConfidence: 1,
      importance: 1,
      memoryConfidence: 1,
      recency: 1,
      status: 'active',
      conflictState: 'none',
      diversityPenalty: 0,
    };
    const collapsed = (
      fixture.store as unknown as {
        collapseCoveredAtomicResults(
          ranked: unknown[],
        ): {
          results: Array<{ memory: { id: string } }>;
          suppressedCount: number;
        };
      }
    ).collapseCoveredAtomicResults([
      {
        memory: derived,
        score: 0.9,
        reasons: [],
        explanation,
      },
      {
        memory: first,
        score: 0.88,
        reasons: [],
        explanation,
      },
      {
        memory: uncited,
        score: 0.88,
        reasons: [],
        explanation,
      },
    ]);
    assert.equal(collapsed.suppressedCount, 1);
    assert.equal(
      collapsed.results.some(
        (result) => result.memory.id === first.id,
      ),
      false,
    );
    assert.equal(
      collapsed.results.some(
        (result) => result.memory.id === uncited.id,
      ),
      true,
    );
  } finally {
    fixture.close();
  }
});

test('备份可以导出并导入到空记忆库', () => {
  const source = createStore();
  const target = createStore();
  try {
    const first = source.store.remember({
      kind: 'instruction',
      namespace: 'project:airi',
      content: '完成前必须真实验证 MCP 工具调用。',
      tags: ['验收'],
      idempotencyKey: 'airi-acceptance-rule',
    }).memory;
    const replacement = source.store.remember({
      kind: 'instruction',
      namespace: 'project:airi',
      content: '完成前必须在真实 AIRI 中验证两层 MCP 工具调用。',
      tags: ['验收', 'airi'],
      supersedesId: first.id,
      idempotencyKey: 'airi-acceptance-rule-v2',
    }).memory;
    source.store.recall({
      query: 'AIRI 的验收必须验证什么？',
      namespace: 'project:airi',
    });
    source.store.forget(replacement.id, '测试备份删除状态');

    const backup = source.store.exportAll();
    target.store.remember({
      kind: 'knowledge',
      content: '这条目标库旧数据应被完整备份替换。',
    });
    const result = target.store.importAll(backup);
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.relationCount, 1);
    assert.equal(result.idempotencyKeyCount, 2);
    assert.equal(result.auditCount, backup.auditLog.length);

    const restored = target.store.exportAll();
    assert.deepEqual(
      { ...restored, exportedAt: backup.exportedAt },
      backup,
    );
  } finally {
    source.close();
    target.close();
  }
});

test('备份可以恢复到已有其他用户数据的共享库', () => {
  const source = createStore();
  const target = createStore();
  try {
    source.store.remember({
      kind: 'instruction',
      content: 'AIRI 的长期记忆必须经过真实跨会话验收。',
      idempotencyKey: 'airi-real-e2e',
    });
    const backup = source.store.exportAll();

    target.store.remember({
      userId: 'bob',
      kind: 'preference',
      content: 'Bob 喜欢红茶。',
      idempotencyKey: 'bob-tea',
    });
    const bobBefore = target.store.exportAll('bob');

    const result = target.store.importAll(backup);
    assert.equal(result.imported, backup.memories.length);

    const restored = target.store.exportAll();
    assert.deepEqual(
      { ...restored, exportedAt: backup.exportedAt },
      backup,
    );
    const bobAfter = target.store.exportAll('bob');
    assert.deepEqual(
      { ...bobAfter, exportedAt: bobBefore.exportedAt },
      bobBefore,
    );
  } finally {
    source.close();
    target.close();
  }
});

test('损坏备份会整体失败，不会留下部分恢复数据', () => {
  const source = createStore();
  const target = createStore();
  try {
    const memory = source.store.remember({
      kind: 'project',
      content: '可靠恢复必须是全事务操作。',
    }).memory;
    const backup = source.store.exportAll();
    const sentinel = target.store.remember({
      kind: 'knowledge',
      content: '目标库原有数据必须在失败后保持不变。',
    }).memory;
    const before = target.store.exportAll();
    const corrupted = structuredClone(backup);
    corrupted.relations.push({
      fromMemoryId: memory.id,
      toMemoryId: '00000000-0000-4000-8000-000000000000',
      relationType: 'references',
      createdAt: new Date().toISOString(),
    });

    assert.throws(
      () => target.store.importAll(corrupted),
      /关系引用了不存在的记忆/,
    );
    assert.equal(target.store.get(sentinel.id)?.id, sentinel.id);
    const after = target.store.exportAll();
    assert.deepEqual(
      { ...after, exportedAt: before.exportedAt },
      before,
    );
  } finally {
    source.close();
    target.close();
  }
});

test('召回拒绝通用措辞重叠但主题不同的记忆', () => {
  const fixture = createStore();
  try {
    fixture.store.remember({
      kind: 'preference',
      content: '用户最喜欢的甜点是提拉米苏。',
      importance: 1,
      confidence: 1,
    });

    for (const query of [
      '用户最喜欢的编程语言是什么？',
      '用户最喜欢的宠物是什么？',
      '用户喜欢怎样的工作方式？',
    ]) {
      assert.deepEqual(fixture.store.recall({ query }), []);
    }

    const related = fixture.store.recall({
      query: '用户最喜欢什么甜点？',
    });
    assert.equal(related.length, 1);
    assert.match(related[0].memory.content, /提拉米苏/);
  } finally {
    fixture.close();
  }
});

test('召回不会把编辑器记忆误认为住址或工作', () => {
  const fixture = createStore();
  try {
    fixture.store.remember({
      kind: 'preference',
      content: '用户常用的代码编辑器是 VS Code。',
      importance: 1,
      confidence: 1,
    });

    for (const query of [
      '用户的家庭住址是什么？',
      '用户现在的工作是什么？',
      '用户最喜欢的编程语言是什么？',
    ]) {
      assert.deepEqual(fixture.store.recall({ query }), []);
    }

    for (const query of [
      '用户使用哪一种 IDE？',
      '常用的代码编辑器是什么？',
      '用户使用什么开发环境？',
      '开发环境是什么？',
    ]) {
      const related = fixture.store.recall({ query });
      assert.equal(related.length, 1);
      assert.match(related[0].memory.content, /VS Code/);
    }
  } finally {
    fixture.close();
  }
});

test('召回拒绝无关、高分、未生效和已过期记忆', () => {
  const fixture = createStore();
  try {
    fixture.store.remember({
      kind: 'knowledge',
      content: '会议室的投影仪需要使用 HDMI 转接线。',
      importance: 1,
      confidence: 1,
    });
    fixture.store.remember({
      kind: 'preference',
      content: '用户喝咖啡时只选择无糖拿铁。',
      importance: 0.7,
      confidence: 0.9,
    });
    fixture.store.remember({
      kind: 'preference',
      content: '用户过去喜欢双倍糖的摩卡咖啡。',
      validTo: '2020-01-01T00:00:00.000Z',
    });
    fixture.store.remember({
      kind: 'preference',
      content: '用户未来开始只喝浓缩咖啡。',
      validFrom: '2999-01-01T00:00:00.000Z',
    });

    assert.deepEqual(
      fixture.store.recall({ query: '家里的宠物叫什么名字？' }),
      [],
    );
    const recalled = fixture.store.recall({
      query: '用户喝咖啡有什么偏好？',
    });
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].memory.content, /无糖拿铁/);

    for (const query of [
      '咖啡要不要加糖？',
      '喝拿铁时放糖吗？',
    ]) {
      const paraphrased = fixture.store.recall({ query });
      assert.equal(paraphrased.length, 1);
      assert.match(paraphrased[0].memory.content, /无糖拿铁/);
    }
  } finally {
    fixture.close();
  }
});

test('交流语言不会与编程语言混淆且支持自然改写', () => {
  const fixture = createStore();
  try {
    fixture.store.remember({
      kind: 'profile',
      content: '用户使用中文。',
      importance: 1,
      confidence: 1,
    });

    assert.deepEqual(
      fixture.store.recall({
        query: '用户最喜欢的编程语言是什么？',
      }),
      [],
    );

    const recalled = fixture.store.recall({
      query: '请用用户偏好的语言回复。',
    });
    assert.equal(recalled.length, 1);
    assert.match(recalled[0].memory.content, /中文/);
  } finally {
    fixture.close();
  }
});

test('幂等键和 UUID 修改删除严格按用户隔离', () => {
  const fixture = createStore();
  try {
    const alice = fixture.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'preference',
      content: 'Alice 喜欢乌龙茶。',
      idempotencyKey: 'same-key',
    });
    const aliceAgain = fixture.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'preference',
      content: '这段内容不会覆盖幂等写入。',
      idempotencyKey: 'same-key',
    });
    const bob = fixture.store.remember({
      userId: 'bob',
      namespace: 'personal',
      kind: 'preference',
      content: 'Bob 喜欢红茶。',
      idempotencyKey: 'same-key',
    });

    assert.equal(aliceAgain.memory.id, alice.memory.id);
    assert.notEqual(bob.memory.id, alice.memory.id);
    assert.equal(fixture.store.get(alice.memory.id, true, 'bob'), null);
    assert.throws(
      () => fixture.store.update(
        alice.memory.id,
        { content: 'Bob 试图篡改 Alice 的记忆。' },
        'bob',
      ),
      /记忆不存在/,
    );
    assert.throws(
      () => fixture.store.forget(alice.memory.id, '越权删除', 'bob'),
      /记忆不存在/,
    );
    assert.equal(
      fixture.store.get(alice.memory.id, true, 'alice')?.content,
      'Alice 喜欢乌龙茶。',
    );
  } finally {
    fixture.close();
  }
});

test('corpusDomain 语料域标注：落库读回、非法值归一、备份回环保真', () => {
  const fixture = createStore();
  try {
    const policy = fixture.store.remember({
      kind: 'document_chunk',
      title: '差旅制度 > 第三章 住宿',
      content: '差旅住宿标准：一线城市每人每晚 500 元。',
      corpusDomain: 'policy',
    });
    assert.equal(fixture.store.get(policy.memory.id)?.corpusDomain, 'policy');

    const untagged = fixture.store.remember({
      kind: 'document_chunk',
      title: '普通片段',
      content: '未标注语料域的片段，召回走全局默认门槛。',
    });
    assert.equal(fixture.store.get(untagged.memory.id)?.corpusDomain, undefined);

    // 非法值一律归一为未标注，不允许任意字符串进入门槛查表。
    const invalid = fixture.store.remember({
      kind: 'document_chunk',
      title: '非法域',
      content: 'corpusDomain 传入非法值的片段。',
      corpusDomain: 'wiki' as never,
    });
    assert.equal(fixture.store.get(invalid.memory.id)?.corpusDomain, undefined);

    // 备份导出包含标注，导入后保留（分档门槛跨备份迁移仍生效）。
    const backup = fixture.store.exportAll();
    const exported = backup.memories.find((m) => m.id === policy.memory.id);
    assert.equal(exported?.corpusDomain, 'policy');

    const restored = createStore();
    try {
      restored.store.importAll(
        JSON.parse(JSON.stringify(backup)),
      );
      assert.equal(
        restored.store.get(policy.memory.id)?.corpusDomain,
        'policy',
      );
      assert.equal(
        restored.store.get(untagged.memory.id)?.corpusDomain,
        undefined,
      );
    } finally {
      restored.close();
    }
  } finally {
    fixture.close();
  }
});
