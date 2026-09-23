import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  CandidateResolver,
  type CandidateResolverOptions,
  type ClaimRelationClassifier,
} from '../src/server/candidate-resolver.js';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryAdminService } from '../src/server/memory-admin.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';
import type { MemoryScopeType } from '../src/server/types.js';

function createFixture(
  resolverOptions: Partial<CandidateResolverOptions> = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-restore-decision-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycleStore,
    store,
    { mode: 'auto', ...resolverOptions },
  );
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    store,
  );
  const admin = new MemoryAdminService(
    database,
    store,
    lifecycleStore,
    resolver,
    governance,
  );
  return {
    database,
    store,
    admin,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function rememberEditor(
  store: MemoryStore,
  input: {
    stableKey: string;
    content: string;
    value: string;
    valueHash: string;
    scopeType?: MemoryScopeType;
    scopeKey?: string;
    validFrom?: string;
    validTo?: string;
    confidence?: number;
    importance?: number;
    tombstoneId?: string;
  },
) {
  return store.remember(
    {
      kind: 'preference',
      content: input.content,
      stableKey: input.stableKey,
      predicateKey: '用户::主要编辑器',
      normalizedValue: input.value,
      normalizedValueHash: input.valueHash,
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
      scopeType: input.scopeType,
      scopeKey: input.scopeKey,
      validFrom: input.validFrom,
      validTo: input.validTo,
      confidence: input.confidence,
      importance: input.importance,
    },
    input.tombstoneId
      ? {
          purpose: 'restore-reconciliation',
          tombstoneId: input.tombstoneId,
        }
      : undefined,
  ).memory;
}

function activeTombstoneId(
  database: DatabaseSync,
  memoryId: string,
): string {
  const id = database
    .prepare(
      `SELECT id
       FROM memory_tombstones
       WHERE memory_item_id = ? AND restored_at IS NULL
       ORDER BY deletion_generation DESC
       LIMIT 1`,
    )
    .get(memoryId)?.id;
  assert.equal(typeof id, 'string');
  return String(id);
}

test('Restore 冲突时保留 tombstone，确认替代后才原子恢复', async () => {
  const fixture = createFixture();
  try {
    const deleted = rememberEditor(fixture.store, {
      stableKey: 'restore-old-editor',
      content: '用户主要使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
    });
    fixture.store.forget(deleted.id);
    const current = rememberEditor(fixture.store, {
      stableKey: 'restore-current-editor',
      content: '用户现在主要使用 Cursor。',
      value: 'Cursor',
      valueHash: 'editor-cursor',
    });

    const pending = await fixture.admin.restoreMemory(deleted.id);
    assert.equal(pending.status, 'requires_confirmation');
    assert.deepEqual(
      pending.conflicts.map((memory) => memory.id),
      [current.id],
    );
    assert.match(pending.confirmationToken || '', /^[0-9a-f]{64}$/);
    assert.equal(
      fixture.store.get(deleted.id, true)?.status,
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

    await assert.rejects(
      () =>
        fixture.admin.restoreMemory(deleted.id, {
          confirmation: 'replace',
          confirmationToken: 'stale-token',
        }),
      /确认已过期/,
    );
    assert.equal(
      fixture.store.get(deleted.id, true)?.status,
      'deleted',
    );

    const restored = await fixture.admin.restoreMemory(deleted.id, {
      confirmation: 'replace',
      confirmationToken: pending.confirmationToken || undefined,
    });
    assert.equal(restored.status, 'restored');
    assert.equal(restored.memory.status, 'active');
    assert.equal(
      fixture.store.get(current.id, true)?.status,
      'superseded',
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
    assert.ok(
      fixture.store
        .relations(deleted.id)
        .some(
          (relation) =>
            relation.toMemoryId === current.id &&
            relation.relationType === 'supersedes',
        ),
    );
  } finally {
    fixture.close();
  }
});

test('Restore 等价值合并到现有规范记忆且不复活重复项', async () => {
  const fixture = createFixture();
  try {
    const deleted = rememberEditor(fixture.store, {
      stableKey: 'restore-equivalent-old',
      content: '用户主要使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
    });
    fixture.store.forget(deleted.id);
    const current = rememberEditor(fixture.store, {
      stableKey: 'restore-equivalent-current',
      content: '用户首选的编辑器是 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
      tombstoneId: activeTombstoneId(
        fixture.database,
        deleted.id,
      ),
    });

    const decision = await fixture.admin.restoreMemory(deleted.id);
    assert.equal(decision.status, 'merged');
    assert.equal(decision.memory.id, current.id);
    assert.equal(
      fixture.store.get(deleted.id, true)?.status,
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
      0,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM audit_log
           WHERE action = 'restore_merge' AND memory_id = ?`,
        )
        .get(deleted.id)?.count,
      1,
    );
    const replayed = await fixture.admin.restoreMemory(deleted.id);
    assert.equal(replayed.status, 'merged');
    assert.equal(replayed.tombstonesRestored, 0);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM audit_log
           WHERE action = 'restore_merge' AND memory_id = ?`,
        )
        .get(deleted.id)?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT observation_count
           FROM memory_items
           WHERE id = ?`,
        )
        .get(current.id)?.observation_count,
      2,
    );
  } finally {
    fixture.close();
  }
});

test('Restore 只在原 scope 内解析，其他项目的同谓词不会被覆盖', async () => {
  const fixture = createFixture();
  try {
    const projectA = rememberEditor(fixture.store, {
      stableKey: 'restore-project-a',
      content: '项目 A 使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
      scopeType: 'project',
      scopeKey: 'project-a',
    });
    fixture.store.forget(projectA.id);
    const projectB = rememberEditor(fixture.store, {
      stableKey: 'restore-project-b',
      content: '项目 B 使用 Cursor。',
      value: 'Cursor',
      valueHash: 'editor-cursor',
      scopeType: 'project',
      scopeKey: 'project-b',
    });

    const decision = await fixture.admin.restoreMemory(projectA.id);
    assert.equal(decision.status, 'restored');
    assert.equal(decision.conflicts.length, 0);
    assert.equal(
      fixture.store.get(projectB.id, true)?.status,
      'active',
    );
  } finally {
    fixture.close();
  }
});

test('Restore 对不重叠时间范围采用安全共存', async () => {
  const fixture = createFixture();
  try {
    const historical = rememberEditor(fixture.store, {
      stableKey: 'restore-historical-editor',
      content: '用户在 2019 年使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
      validFrom: '2019-01-01T00:00:00.000Z',
      validTo: '2020-01-01T00:00:00.000Z',
    });
    fixture.store.forget(historical.id);
    const current = rememberEditor(fixture.store, {
      stableKey: 'restore-modern-editor',
      content: '用户从 2021 年开始使用 Cursor。',
      value: 'Cursor',
      valueHash: 'editor-cursor',
      validFrom: '2021-01-01T00:00:00.000Z',
    });

    const decision = await fixture.admin.restoreMemory(historical.id);
    assert.equal(decision.status, 'restored');
    assert.equal(decision.conflicts.length, 0);
    assert.equal(
      fixture.store.get(current.id, true)?.status,
      'active',
    );
  } finally {
    fixture.close();
  }
});

test('Restore 区分 reinforces 与 equivalent 并重算置信度', async () => {
  const fixture = createFixture();
  try {
    const deleted = rememberEditor(fixture.store, {
      stableKey: 'restore-reinforce-old',
      content: '用户主要使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
      confidence: 0.6,
      importance: 0.7,
    });
    fixture.store.forget(deleted.id);
    const current = rememberEditor(fixture.store, {
      stableKey: 'restore-reinforce-current',
      content: '用户首选的编辑器是 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
      confidence: 1,
      importance: 0.8,
      tombstoneId: activeTombstoneId(
        fixture.database,
        deleted.id,
      ),
    });

    const reinforced = await fixture.admin.restoreMemory(deleted.id);
    assert.equal(reinforced.status, 'merged');
    assert.equal(reinforced.assessment?.relation, 'reinforces');
    assert.equal(reinforced.memory.id, current.id);
    assert.equal(reinforced.memory.confidence, 0.8);
    assert.equal(fixture.store.history(current.id).length, 2);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT observation_count
           FROM memory_items WHERE id = ?`,
        )
        .get(current.id)?.observation_count,
      2,
    );

    const secondDeleted = rememberEditor(fixture.store, {
      stableKey: 'restore-equivalent-old',
      content: '用户主要使用 Zed。',
      value: 'Zed',
      valueHash: 'editor-zed',
    });
    fixture.store.forget(secondDeleted.id);
    const equivalentTarget = rememberEditor(fixture.store, {
      stableKey: 'restore-equivalent-current',
      content: '用户主要使用 Zed。',
      value: 'Zed',
      valueHash: 'editor-zed',
      tombstoneId: activeTombstoneId(
        fixture.database,
        secondDeleted.id,
      ),
    });
    const equivalent = await fixture.admin.restoreMemory(
      secondDeleted.id,
    );
    assert.equal(equivalent.assessment?.relation, 'equivalent');
    assert.equal(equivalent.memory.id, equivalentTarget.id);
    assert.equal(
      fixture.store.history(equivalentTarget.id).length,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('Restore 确认令牌绑定删除世代，旧令牌不能跨删除周期重放', async () => {
  const fixture = createFixture();
  try {
    const deleted = rememberEditor(fixture.store, {
      stableKey: 'restore-generation-old',
      content: '用户主要使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
    });
    fixture.store.forget(deleted.id);
    rememberEditor(fixture.store, {
      stableKey: 'restore-generation-current',
      content: '用户主要使用 Cursor。',
      value: 'Cursor',
      valueHash: 'editor-cursor',
    });
    const preview = await fixture.admin.restoreMemory(deleted.id);
    const firstTombstone = fixture.database
      .prepare(
        `SELECT id
         FROM memory_tombstones
         WHERE memory_item_id = ? AND restored_at IS NULL`,
      )
      .get(deleted.id);
    const timestamp = '2026-07-29T10:00:00.000Z';
    fixture.database
      .prepare(
        `UPDATE memories
         SET status = 'active', deleted_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, deleted.id);
    fixture.database
      .prepare(
        `UPDATE memory_items
         SET status = 'active', updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, deleted.id);
    fixture.database
      .prepare(
        `UPDATE memory_tombstones
         SET restored_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, firstTombstone?.id);
    fixture.store.forget(deleted.id);

    await assert.rejects(
      () =>
        fixture.admin.restoreMemory(deleted.id, {
          confirmation: 'replace',
          confirmationToken:
            preview.confirmationToken || undefined,
        }),
      /确认已过期/,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT MAX(deletion_generation) AS generation
           FROM memory_tombstones WHERE memory_item_id = ?`,
        )
        .get(deleted.id)?.generation,
      2,
    );
    assert.equal(
      fixture.store.get(deleted.id, true)?.status,
      'deleted',
    );
  } finally {
    fixture.close();
  }
});

test('Restore 只关闭目标记忆的 tombstone，不误关同 hash 删除项', async () => {
  const fixture = createFixture();
  try {
    const first = rememberEditor(fixture.store, {
      stableKey: 'restore-shared-hash-first',
      content: '用户主要使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
    });
    fixture.store.forget(first.id);
    const second = rememberEditor(fixture.store, {
      stableKey: 'restore-shared-hash-second',
      content: '用户主要使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
      tombstoneId: activeTombstoneId(
        fixture.database,
        first.id,
      ),
    });
    fixture.store.forget(second.id);

    const restored = await fixture.admin.restoreMemory(first.id);
    assert.equal(restored.status, 'restored');
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE memory_item_id = ? AND restored_at IS NULL`,
        )
        .get(first.id)?.count,
      0,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE memory_item_id = ? AND restored_at IS NULL`,
        )
        .get(second.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('Restore 复用模型五路判断发现跨 predicate 冲突', async () => {
  let targetId = '';
  const classifier: ClaimRelationClassifier = {
    model: 'qwen2.5:14b',
    promptVersion: 'relation-v1',
    async classify() {
      return {
        relation: 'contradicts',
        targetMemoryId: targetId,
        confidence: 0.98,
        rationale: '两个谓词表达同一个当前编辑器且值冲突',
      };
    },
  };
  const fixture = createFixture({
    classifier,
    embeddingProvider: {
      embeddingModel: 'fake-bge-m3',
      async embed(texts) {
        return texts.map(() => new Float32Array([1, 0, 0]));
      },
    },
  });
  try {
    const deleted = fixture.store.remember({
      kind: 'preference',
      content: '用户常用的开发工具是 VS Code。',
      stableKey: 'restore-semantic-old',
      predicateKey: '用户::常用开发工具',
      normalizedValueHash: 'tool-vscode',
      normalizedValue: 'VS Code',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    fixture.store.forget(deleted.id);
    const current = fixture.store.remember({
      kind: 'preference',
      content: '用户当前的主要编辑器是 Cursor。',
      stableKey: 'restore-semantic-current',
      predicateKey: '用户::主要编辑器',
      normalizedValueHash: 'editor-cursor',
      normalizedValue: 'Cursor',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    targetId = current.id;

    const decision = await fixture.admin.restoreMemory(deleted.id);
    assert.equal(decision.status, 'requires_confirmation');
    assert.equal(decision.assessment?.relation, 'contradicts');
    assert.equal(decision.assessment?.method, 'model');
    assert.equal(decision.assessment?.targetMemoryId, current.id);
    assert.deepEqual(
      decision.conflicts.map((memory) => memory.id),
      [current.id],
    );
  } finally {
    fixture.close();
  }
});

test('Restore 分类器失败时不修改记忆或 tombstone', async () => {
  const fixture = createFixture({
    classifier: {
      model: 'qwen2.5:14b',
      promptVersion: 'relation-v1',
      async classify() {
        throw new Error('classifier unavailable');
      },
    },
    embeddingProvider: {
      embeddingModel: 'fake-bge-m3',
      async embed(texts) {
        return texts.map(() => new Float32Array([1, 0, 0]));
      },
    },
  });
  try {
    const deleted = fixture.store.remember({
      kind: 'preference',
      content: '用户常用的开发工具是 VS Code。',
      stableKey: 'restore-failure-old',
      predicateKey: '用户::常用开发工具',
      normalizedValueHash: 'tool-vscode',
      normalizedValue: 'VS Code',
    }).memory;
    fixture.store.forget(deleted.id);
    fixture.store.remember({
      kind: 'preference',
      content: '用户当前的主要编辑器是 Cursor。',
      stableKey: 'restore-failure-current',
      predicateKey: '用户::主要编辑器',
      normalizedValueHash: 'editor-cursor',
      normalizedValue: 'Cursor',
    });

    await assert.rejects(
      () => fixture.admin.restoreMemory(deleted.id),
      /classifier unavailable/,
    );
    assert.equal(
      fixture.store.get(deleted.id, true)?.status,
      'deleted',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE memory_item_id = ? AND restored_at IS NULL`,
        )
        .get(deleted.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('共享关系引擎拒绝分类器引用未知目标记忆', async () => {
  const fixture = createFixture({
    classifier: {
      model: 'qwen2.5:14b',
      promptVersion: 'relation-v1',
      async classify() {
        return {
          relation: 'contradicts',
          targetMemoryId:
            '00000000-0000-4000-8000-000000000000',
          confidence: 0.99,
          rationale: '故意返回不在 read-set 中的目标',
        };
      },
    },
    embeddingProvider: {
      embeddingModel: 'fake-bge-m3',
      async embed(texts) {
        return texts.map(() => new Float32Array([1, 0, 0]));
      },
    },
  });
  try {
    const deleted = fixture.store.remember({
      kind: 'preference',
      content: '用户常用的开发工具是 VS Code。',
      stableKey: 'restore-unknown-target-old',
      predicateKey: '用户::常用开发工具',
      normalizedValueHash: 'tool-vscode',
      normalizedValue: 'VS Code',
      predicateCardinality: 'single',
    }).memory;
    fixture.store.forget(deleted.id);
    fixture.store.remember({
      kind: 'preference',
      content: '用户当前的主要编辑器是 Cursor。',
      stableKey: 'restore-unknown-target-current',
      predicateKey: '用户::主要编辑器',
      normalizedValueHash: 'editor-cursor',
      normalizedValue: 'Cursor',
      predicateCardinality: 'single',
    });

    await assert.rejects(
      () => fixture.admin.restoreMemory(deleted.id),
      /未知目标记忆/,
    );
    assert.equal(
      fixture.store.get(deleted.id, true)?.status,
      'deleted',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE memory_item_id = ? AND restored_at IS NULL`,
        )
        .get(deleted.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('Restore 冲突确认会替代全部同范围当前值', async () => {
  const fixture = createFixture();
  try {
    const deleted = rememberEditor(fixture.store, {
      stableKey: 'restore-multi-old',
      content: '用户主要使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
    });
    fixture.store.forget(deleted.id);
    const cursor = rememberEditor(fixture.store, {
      stableKey: 'restore-multi-cursor',
      content: '用户主要使用 Cursor。',
      value: 'Cursor',
      valueHash: 'editor-cursor',
    });
    const zed = rememberEditor(fixture.store, {
      stableKey: 'restore-multi-zed',
      content: '用户主要使用 Zed。',
      value: 'Zed',
      valueHash: 'editor-zed',
    });

    const preview = await fixture.admin.restoreMemory(deleted.id);
    assert.deepEqual(
      new Set(preview.conflicts.map((memory) => memory.id)),
      new Set([cursor.id, zed.id]),
    );
    const restored = await fixture.admin.restoreMemory(deleted.id, {
      confirmation: 'replace',
      confirmationToken: preview.confirmationToken || undefined,
    });
    assert.equal(restored.status, 'restored');
    assert.equal(
      fixture.store.get(cursor.id, true)?.status,
      'superseded',
    );
    assert.equal(
      fixture.store.get(zed.id, true)?.status,
      'superseded',
    );
  } finally {
    fixture.close();
  }
});

test('Restore CAS 会拒绝评估后新插入的未见冲突项', async () => {
  const fixture = createFixture();
  try {
    const deleted = rememberEditor(fixture.store, {
      stableKey: 'restore-unseen-old',
      content: '用户主要使用 VS Code。',
      value: 'VS Code',
      valueHash: 'editor-vscode',
    });
    fixture.store.forget(deleted.id);
    rememberEditor(fixture.store, {
      stableKey: 'restore-unseen-cursor',
      content: '用户主要使用 Cursor。',
      value: 'Cursor',
      valueHash: 'editor-cursor',
    });
    const originalCommit = fixture.store.commitRestore.bind(
      fixture.store,
    );
    let inserted = false;
    fixture.store.commitRestore = (
      memoryId,
      assessment,
      input,
      userId,
    ) => {
      if (!inserted) {
        inserted = true;
        rememberEditor(fixture.store, {
          stableKey: 'restore-unseen-zed',
          content: '用户主要使用 Zed。',
          value: 'Zed',
          valueHash: 'editor-zed',
        });
      }
      return originalCommit(
        memoryId,
        assessment,
        input,
        userId,
      );
    };

    await assert.rejects(
      () => fixture.admin.restoreMemory(deleted.id),
      /评估已过期/,
    );
    assert.equal(
      fixture.store.get(deleted.id, true)?.status,
      'deleted',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE memory_item_id = ? AND restored_at IS NULL`,
        )
        .get(deleted.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('Restore 本地索引写入失败会回滚状态、tombstone 和事件', async () => {
  const fixture = createFixture();
  try {
    const deleted = rememberEditor(fixture.store, {
      stableKey: 'restore-index-failure',
      content: '用户主要使用 Helix。',
      value: 'Helix',
      valueHash: 'editor-helix',
    });
    fixture.store.forget(deleted.id);
    const beforeEvents = Number(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_events WHERE memory_item_id = ?`,
        )
        .get(deleted.id)?.count,
    );
    fixture.database.exec(`
      CREATE TRIGGER fail_restore_index_insert
      BEFORE INSERT ON memory_ann_index
      BEGIN
        SELECT RAISE(ABORT, 'index failure');
      END;
    `);

    await assert.rejects(
      () => fixture.admin.restoreMemory(deleted.id),
      /index failure/,
    );
    assert.equal(
      fixture.store.get(deleted.id, true)?.status,
      'deleted',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE memory_item_id = ? AND restored_at IS NULL`,
        )
        .get(deleted.id)?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_events WHERE memory_item_id = ?`,
        )
        .get(deleted.id)?.count,
      beforeEvents,
    );
  } finally {
    fixture.close();
  }
});
