import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  DatabaseSync,
  SQLInputValue,
} from 'node:sqlite';
import { embedText, vectorToBuffer } from '../src/server/embedding.js';
import { openDatabase } from '../src/server/database.js';
import { EpisodicMemoryService } from '../src/server/episodic-memory-service.js';
import {
  HybridRetrievalIndex,
  deriveDenseGenerationIdentity,
  normalizeAccessScopes,
  type HybridSearchInput,
} from '../src/server/hybrid-retrieval.js';
import { MemoryStore } from '../src/server/memory-store.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';

function searchPlan(
  marker: string,
  input: HybridSearchInput,
): string {
  const database = openDatabase(':memory:');
  let capturedSql = '';
  let capturedValues: SQLInputValue[] = [];
  const instrumentedDatabase = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      if (!sql.includes(marker)) return statement;
      return {
        all(...values: SQLInputValue[]) {
          capturedSql = sql;
          capturedValues = values;
          return statement.all(...values);
        },
      };
    },
  } as unknown as DatabaseSync;
  try {
    new HybridRetrievalIndex(instrumentedDatabase).search(input);
    assert.ok(capturedSql, `未捕获查询：${marker}`);
    return database
      .prepare(`EXPLAIN QUERY PLAN ${capturedSql}`)
      .all(...capturedValues)
      .map((row) => String(row.detail))
      .join('\n');
  } finally {
    database.close();
  }
}

test('Dense 与 ANN bucket 查询使用完整复合索引 seek', () => {
  const baseInput = {
    query: '安静工作空间偏好',
    userId: 'default',
    namespace: 'personal',
    timestamp: '2026-07-29T12:00:00.000Z',
  };
  const densePlan = searchPlan('FROM memory_dense_lsh d', {
    ...baseInput,
    denseVector: Float32Array.from(
      { length: 96 },
      (_, index) => Math.sin(index + 1),
    ),
    denseModel: 'query-plan-model',
    denseGenerationKey: 'query-plan-generation-key',
    denseGenerationId: 'query-plan-generation-id',
  });
  assert.match(
    densePlan,
    /SEARCH d USING (?:COVERING )?INDEX memory_dense_lsh_bucket_idx \(generation_id=\? AND band=\? AND bucket=\?\)/,
  );
  assert.doesNotMatch(densePlan, /\bSCAN d\b/);

  const annPlan = searchPlan('FROM memory_ann_index a', baseInput);
  assert.match(
    annPlan,
    /SEARCH a USING (?:COVERING )?INDEX memory_ann_bucket_idx \(index_model=\? AND band=\? AND bucket=\?\)/,
  );
  assert.doesNotMatch(annPlan, /\bSCAN a\b/);
});

test('小作用域 Dense LSH 漏桶时使用有界精确向量回退', () => {
  const database = openDatabase(':memory:');
  const store = new MemoryStore(database);
  try {
    const memory = store.remember({
      kind: 'knowledge',
      content: '精确向量回退只用于小作用域的漏桶候选。',
    }).memory;
    const index = new HybridRetrievalIndex(database);
    const dimensions = 64;
    const generationKey = 'exact-fallback-generation-key';
    const registered = index.registerDenseGeneration({
      userId: 'default',
      namespace: 'personal',
      embeddingModel: 'exact-fallback-model',
      dimensions,
      generationKey,
      timestamp: memory.updatedAt,
    });
    const vector = Float32Array.from(
      { length: dimensions },
      () => -1 / Math.sqrt(dimensions),
    );
    const textHash = 'exact-fallback-text-hash';
    database.prepare(
      `INSERT INTO memory_embeddings (
         memory_id, generation_id, model, text_hash, dimensions,
         generation_key, memory_revision, embedding, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      memory.id,
      registered.generation.generationId,
      registered.generation.embeddingModel,
      textHash,
      dimensions,
      generationKey,
      vectorToBuffer(vector),
      memory.updatedAt,
    );
    index.upsertDense(
      memory.id,
      registered.generation.generationId,
      registered.generation.embeddingModel,
      textHash,
      vector,
      memory.updatedAt,
      1,
      generationKey,
    );

    const result = index.searchWithDiagnostics({
      query: '完全不同的查询词',
      userId: 'default',
      namespace: 'personal',
      timestamp: memory.updatedAt,
      denseVector: Float32Array.from(
        { length: dimensions },
        () => 1 / Math.sqrt(dimensions),
      ),
      denseModel: registered.generation.embeddingModel,
      denseGenerationKey: generationKey,
      denseGenerationId: registered.generation.generationId,
      limit: 20,
    });

    assert.deepEqual(
      result.candidates.map((candidate) => candidate.id),
      [memory.id],
    );
    assert.equal(
      result.diagnostics.channels.ann.strategy,
      'exact_fallback',
    );
    assert.equal(result.diagnostics.channels.ann.scannedCount, 1);
  } finally {
    database.close();
  }
});

test('稠密通道按可见性 v2 跨主体可达：A 写 role scope，B 读命中同一 generation', () => {
  const database = openDatabase(':memory:');
  const store = new MemoryStore(database);
  try {
    const memory = store.remember({
      userId: 'writer-a',
      namespace: 'personal',
      kind: 'knowledge',
      content: '跨主体稠密通道验证：运维录入的部门制度文档。',
      scopeType: 'role',
      scopeKey: 'dept-x',
    }).memory;
    const index = new HybridRetrievalIndex(database);
    const dimensions = 64;
    const generationKey = 'cross-subject-generation-key';
    const registered = index.registerDenseGeneration({
      userId: 'writer-a',
      namespace: 'personal',
      embeddingModel: 'cross-subject-model',
      dimensions,
      generationKey,
      timestamp: memory.updatedAt,
    });
    const storedVector = Float32Array.from(
      { length: dimensions },
      () => -1 / Math.sqrt(dimensions),
    );
    const textHash = 'cross-subject-text-hash';
    database.prepare(
      `INSERT INTO memory_embeddings (
         memory_id, generation_id, model, text_hash, dimensions,
         generation_key, memory_revision, embedding, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      memory.id,
      registered.generation.generationId,
      registered.generation.embeddingModel,
      textHash,
      dimensions,
      generationKey,
      vectorToBuffer(storedVector),
      memory.updatedAt,
    );
    index.upsertDense(
      memory.id,
      registered.generation.generationId,
      registered.generation.embeddingModel,
      textHash,
      storedVector,
      memory.updatedAt,
      1,
      generationKey,
    );

    // 确定性派生：不查 alias 也能算出与写入侧完全相同的 generationId
    // （generationId 由 模型 + LSH 版本 + 维度 + 探测向量指纹 决定，不含 userId）。
    assert.equal(
      deriveDenseGenerationIdentity({
        embeddingModel: 'cross-subject-model',
        dimensions,
        generationKey,
      }).generationId,
      registered.generation.generationId,
    );

    // 读者 B 与写入者 A 不同主体，仅凭 role scope 即可命中稠密通道。
    const result = index.searchWithDiagnostics({
      query: '部门制度文档',
      userId: 'reader-b',
      namespace: 'personal',
      scopes: [{ scopeType: 'role', scopeKey: 'dept-x' }],
      timestamp: memory.updatedAt,
      denseVector: Float32Array.from(
        { length: dimensions },
        () => 1 / Math.sqrt(dimensions),
      ),
      denseModel: registered.generation.embeddingModel,
      denseGenerationKey: generationKey,
      denseGenerationId: registered.generation.generationId,
      limit: 20,
    });
    assert.deepEqual(
      result.candidates.map((candidate) => candidate.id),
      [memory.id],
    );

    // 只读主体不产生 alias 脏写：dense_index_aliases 只应有写入侧行。
    const aliasRows = database.prepare(
      'SELECT user_id FROM dense_index_aliases ORDER BY user_id',
    ).all().map((row) => String(row.user_id));
    assert.deepEqual(aliasRows, ['writer-a']);
  } finally {
    database.close();
  }
});

test('多作用域规范化去重、拒绝歧义并保留默认兼容行为', () => {
  assert.deepEqual(normalizeAccessScopes({}), [
    { scopeType: 'personal', scopeKey: 'self' },
  ]);
  assert.deepEqual(
    normalizeAccessScopes({
      scopes: [
        { scopeType: 'role', scopeKey: ' persona-a ' },
        { scopeType: 'role', scopeKey: 'persona-a' },
      ],
    }),
    [{ scopeType: 'role', scopeKey: 'persona-a' }],
  );
  assert.deepEqual(
    normalizeAccessScopes({
      scopes: [{ scopeType: 'role', scopeKey: 'persona-a' }],
      scopeType: 'role',
      scopeKey: 'persona-a',
    }),
    [{ scopeType: 'role', scopeKey: 'persona-a' }],
  );
  assert.throws(
    () => normalizeAccessScopes({ scopes: [] }),
    /作用域.*不能为空|scopes.*不能为空/u,
  );
  assert.throws(
    () => normalizeAccessScopes({
      scopes: [{ scopeType: 'role', scopeKey: 'persona-a' }],
      scopeType: 'session',
      scopeKey: 'persona-a:session-1',
    }),
    /作用域.*冲突|不能混用/u,
  );
});

test('FTS、ANN、term 候选按可见性模型 v2 隔离（shared 按 scope、owner-bound 按 user）', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-hybrid-scope-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const content = '精确作用域通道验证：玄青海豚只属于授权聊天对象。';
  const remember = (
    userId: string,
    namespace: string,
    scopeType: 'personal' | 'role' | 'session',
    scopeKey: string,
  ) => store.remember({
    userId,
    namespace,
    kind: 'knowledge',
    content,
    scopeType,
    scopeKey,
  }).memory;

  try {
    const roleA = remember('scope-user', 'scope-namespace', 'role', 'A');
    const sessionA1 = remember(
      'scope-user',
      'scope-namespace',
      'session',
      'A1',
    );
    const crossedRole = remember(
      'scope-user',
      'scope-namespace',
      'role',
      'A1',
    );
    const crossedSession = remember(
      'scope-user',
      'scope-namespace',
      'session',
      'A',
    );
    // 可见性 v2：role/session 是 shared/owner-bound 之分——role 共享，
    // 其他用户写的 role:A 文档对持同 scope 会话者可见（跨主体协作）。
    const otherUser = remember(
      'other-user',
      'scope-namespace',
      'role',
      'A',
    );
    // personal 仍按 user_id 私有：别人的个人记忆永远不可见。
    const otherUserPersonal = remember(
      'other-user',
      'scope-namespace',
      'personal',
      'self',
    );
    const otherNamespace = remember(
      'scope-user',
      'other-namespace',
      'role',
      'A',
    );
    const candidates = new HybridRetrievalIndex(database).search({
      query: content,
      userId: 'scope-user',
      namespace: 'scope-namespace',
      scopes: [
        { scopeType: 'role', scopeKey: 'A' },
        { scopeType: 'session', scopeKey: 'A1' },
        { scopeType: 'role', scopeKey: 'A' },
      ],
      timestamp: '2026-07-31T08:00:00.000Z',
      limit: 20,
    });
    const ids = candidates.map((candidate) => candidate.id).sort();

    assert.deepEqual(ids, [roleA.id, sessionA1.id, otherUser.id].sort());
    assert.ok(
      candidates.every(
        (candidate) =>
          candidate.lexicalRank !== null &&
          candidate.annRank !== null &&
          candidate.termRank !== null,
      ),
      '授权候选应同时命中 FTS、ANN 和 term 三个通道',
    );
    assert.ok(!ids.includes(crossedRole.id));
    assert.ok(!ids.includes(crossedSession.id));
    assert.ok(!ids.includes(otherUserPersonal.id));
    assert.ok(!ids.includes(otherNamespace.id));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('通道与融合候选上限返回精确聚合诊断', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-hybrid-cap-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);

  try {
    for (let index = 0; index < 45; index += 1) {
      store.remember({
        kind: 'knowledge',
        content: `channel cap probe candidate ${index}`,
        stableKey: `channel-cap-${index}`,
      });
    }

    const result = new HybridRetrievalIndex(database).searchWithDiagnostics({
      query: 'channel cap probe',
      userId: 'default',
      namespace: 'personal',
      timestamp: '2026-08-10T08:00:00.000Z',
      limit: 2,
    });

    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.diagnostics.channels.lexical, {
      rawCount: 45,
      returnedCount: 40,
      cappedCount: 5,
    });
    assert.equal(result.diagnostics.fusion.returnedCount, 2);
    assert.equal(
      result.diagnostics.fusion.cappedCount,
      result.diagnostics.fusion.validCount - 2,
    );
    assert.ok(result.diagnostics.fusion.rawCount >= 40);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('融合诊断显式统计被淘汰的无效派生来源', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-hybrid-invalid-derived-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);

  try {
    store.remember({
      kind: 'knowledge',
      content: 'invalid derived source probe valid memory',
    });
    store.remember({
      kind: 'knowledge',
      content: 'invalid derived source probe stale consolidation',
      source: 'consolidation',
    });

    const result = new HybridRetrievalIndex(database).searchWithDiagnostics({
      query: 'invalid derived source probe',
      userId: 'default',
      namespace: 'personal',
      timestamp: '2026-08-10T08:00:00.000Z',
      limit: 20,
    });

    assert.equal(result.diagnostics.fusion.rawCount, 2);
    assert.equal(result.diagnostics.fusion.validCount, 1);
    assert.equal(result.diagnostics.fusion.invalidDerivedSourceCount, 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('active tombstone 沿证据图阻断 episode 与 summary 且恢复后重新可见', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-hybrid-tombstone-evidence-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const lifecycle = new LifecycleStore(database);
  const episodic = new EpisodicMemoryService(database);
  const recordEpisode = (
    userId: string,
    suffix: string,
  ): { episodeId: string; memoryId: string; userTurnId: string } => {
    const exchange = lifecycle.recordCompletedExchange({
      userId,
      namespace: 'personal',
      clientName: 'hybrid-tombstone-test',
      sessionExternalId: `${userId}-session-${suffix}`,
      userTurnExternalId: `${userId}-user-${suffix}`,
      userContent: `这次临时出差我会住在青禾旅店，记录 ${suffix}。`,
      assistantTurnExternalId: `${userId}-assistant-${suffix}`,
      assistantContent: '收到，这只是一次历史对话情景。',
      occurredAt: `2026-08-${suffix === 'one' ? '10' : '11'}T08:00:00.000Z`,
    });
    const episode = episodic.materialize({
      userId,
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });
    return {
      ...episode,
      userTurnId: exchange.userTurn.id,
    };
  };

  try {
    const first = recordEpisode('alice', 'one');
    const second = recordEpisode('alice', 'two');
    const bob = recordEpisode('bob', 'one');
    const fact = store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'event',
      content: '用户这次临时出差住在青禾旅店。',
      stableKey: 'alice::trip::hotel',
      predicateKey: '用户::临时出差住宿',
      normalizedValue: '青禾旅店',
      normalizedValueHash: 'alice-trip-hotel-qinghe',
      predicateCardinality: 'single',
      evidenceTurnId: first.userTurnId,
      evidenceExcerpt: '这次临时出差我会住在青禾旅店',
      sourceAuthority: 'direct_user',
    }).memory;
    const revision = Number(database.prepare(
      'SELECT revision FROM memory_items WHERE id = ?',
    ).get(fact.id)?.revision);
    store.observe(fact.id, {
      expectedRevision: revision,
      evidenceTurnId: second.userTurnId,
      evidenceExcerpt: '这次临时出差我会住在青禾旅店',
      sourceAuthority: 'direct_user',
      sensitivity: 'normal',
    }, 'alice');

    const summaryId = 'alice-trip-summary';
    const summary = store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'event',
      content: '本周对话摘要：用户临时出差住在青禾旅店。',
      source: 'hierarchical_summary',
      sourceRef: `hierarchical-summary:${summaryId}`,
      stableKey: `hierarchical-summary:${summaryId}`,
      predicateKey: `hierarchical-summary::${summaryId}`,
      normalizedValue: '用户临时出差住在青禾旅店',
      normalizedValueHash: 'alice-trip-summary-qinghe',
      predicateCardinality: 'event',
    }).memory;
    database.prepare(
      `INSERT INTO conversation_memory_summaries (
         id, memory_id, user_id, namespace, summary_type, bucket_key,
         scope_type, scope_key, source_fingerprint, source_count, status,
         model, prompt_version, created_at, updated_at
       ) VALUES (?, ?, 'alice', 'personal', 'week', '2026-W33',
         'personal', 'self', 'alice-trip-summary-sources', 2, 'active',
         'qwen2.5:14b', 'test-v1', ?, ?)`,
    ).run(
      summaryId,
      summary.id,
      '2026-08-12T00:00:00.000Z',
      '2026-08-12T00:00:00.000Z',
    );
    database.prepare(
      `INSERT INTO conversation_memory_summary_sources (
         summary_id, episode_id, ordinal
       ) VALUES (?, ?, 0), (?, ?, 1)`,
    ).run(summaryId, first.episodeId, summaryId, second.episodeId);

    const search = (userId: string) =>
      new HybridRetrievalIndex(database).search({
        query: '临时出差住在青禾旅店',
        userId,
        namespace: 'personal',
        timestamp: '2026-08-13T00:00:00.000Z',
        limit: 20,
      }).map((candidate) => candidate.id);

    const beforeForget = search('alice');
    assert.ok(beforeForget.includes(fact.id));
    assert.ok(beforeForget.includes(first.memoryId));
    assert.ok(beforeForget.includes(second.memoryId));
    assert.ok(beforeForget.includes(summary.id));

    store.forget(fact.id, '用户要求忘记住宿', 'alice');
    const afterForget = search('alice');
    assert.ok(!afterForget.includes(first.memoryId));
    assert.ok(!afterForget.includes(second.memoryId));
    assert.ok(!afterForget.includes(summary.id));
    const localAfterForget = store.recall({
      query: '临时出差住在青禾旅店',
      userId: 'alice',
      namespace: 'personal',
      limit: 20,
    }).map((result) => result.memory.id);
    assert.ok(!localAfterForget.includes(first.memoryId));
    assert.ok(!localAfterForget.includes(second.memoryId));
    assert.ok(!localAfterForget.includes(summary.id));
    assert.ok(search('bob').includes(bob.memoryId), '其他租户不得被阻断');

    database.prepare(
      `UPDATE memory_tombstones
       SET restored_at = '2026-08-13T01:00:00.000Z'
       WHERE memory_item_id = ? AND restored_at IS NULL`,
    ).run(fact.id);
    const afterRestore = search('alice');
    assert.ok(afterRestore.includes(first.memoryId));
    assert.ok(afterRestore.includes(second.memoryId));
    assert.ok(afterRestore.includes(summary.id));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('可靠召回在重排前排除被 tombstone 证据阻断的 episode', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-reliable-tombstone-evidence-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const rerankedIds: string[][] = [];
  const ranker = {
    embeddingModel: 'tombstone-evidence-embedding-v1',
    rerankModel: 'tombstone-evidence-reranker-v1',
    async embed(texts: string[]) {
      return texts.map(() => Float32Array.from([1, 0, 0]));
    },
    async rerank(
      _query: string,
      candidates: Array<{ id: string }>,
    ) {
      rerankedIds.push(candidates.map((candidate) => candidate.id));
      return candidates.map((candidate) => ({
        id: candidate.id,
        relevant: true,
        confidence: 0.99,
        reason: '测试候选相关',
      }));
    },
  };
  const store = new MemoryStore(database, ranker);
  const lifecycle = new LifecycleStore(database);
  const episodic = new EpisodicMemoryService(database);

  try {
    const exchange = lifecycle.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'reliable-tombstone-test',
      sessionExternalId: 'reliable-session',
      userTurnExternalId: 'reliable-user-turn',
      userContent: '这次临时出差我会住在青禾旅店。',
      assistantTurnExternalId: 'reliable-assistant-turn',
      assistantContent: '收到，这是历史情景。',
    });
    const episode = episodic.materialize({
      userId: 'alice',
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });
    const fact = store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'event',
      content: '用户这次临时出差住在青禾旅店。',
      stableKey: 'alice::reliable::hotel',
      predicateKey: '用户::临时出差住宿',
      normalizedValue: '青禾旅店',
      normalizedValueHash: 'alice-reliable-hotel-qinghe',
      predicateCardinality: 'single',
      evidenceTurnId: exchange.userTurn.id,
      evidenceExcerpt: exchange.userTurn.content,
      sourceAuthority: 'direct_user',
    }).memory;

    await store.backfillDenseIndex(200, undefined, 'alice', 'personal');
    store.forget(fact.id, '用户要求忘记住宿', 'alice');
    const recalled = await store.recallReliable({
      query: '这次临时出差住在哪里？',
      userId: 'alice',
      namespace: 'personal',
      limit: 5,
    });

    assert.ok(!recalled.some((result) => result.memory.id === episode.memoryId));
    assert.ok(
      rerankedIds.every((ids) => !ids.includes(episode.memoryId)),
      '被阻断 episode 不得发送给重排 provider',
    );
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('事实版本修正后旧值与纠正措辞 episode 均不参与记忆召回', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-hybrid-superseded-evidence-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const lifecycle = new LifecycleStore(database);
  const episodic = new EpisodicMemoryService(database);
  const recordEpisode = (
    suffix: string,
    userContent: string,
  ): { episodeId: string; memoryId: string; userTurnId: string } => {
    const exchange = lifecycle.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'hybrid-correction-test',
      sessionExternalId: 'hybrid-correction-session',
      userTurnExternalId: `hybrid-correction-user-${suffix}`,
      userContent,
      assistantTurnExternalId: `hybrid-correction-assistant-${suffix}`,
      assistantContent: '收到，后续以当前值为准。',
    });
    const episode = episodic.materialize({
      userId: 'alice',
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });
    return { ...episode, userTurnId: exchange.userTurn.id };
  };

  try {
    const oldEpisode = recordEpisode(
      'old',
      '我常用的编辑器是Visual Studio Code。',
    );
    const correctionEpisode = recordEpisode(
      'new',
      '更正一下，我现在改用Neovim，之前的Visual Studio Code不用了。',
    );
    const fact = store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'preference',
      content: '用户常用的编辑器是Visual Studio Code。',
      stableKey: 'alice::editor',
      predicateKey: '用户::常用编辑器',
      normalizedValue: 'Visual Studio Code',
      normalizedValueHash: 'alice-editor-vscode',
      predicateCardinality: 'single',
      evidenceTurnId: oldEpisode.userTurnId,
      evidenceExcerpt: '我常用的编辑器是Visual Studio Code。',
      sourceAuthority: 'direct_user',
    }).memory;
    store.update(fact.id, {
      content: '用户现在常用的编辑器是Neovim。',
      predicateKey: '用户::常用编辑器',
      normalizedValue: 'Neovim',
      normalizedValueHash: 'alice-editor-neovim',
      predicateCardinality: 'single',
      evidenceTurnId: correctionEpisode.userTurnId,
      evidenceExcerpt:
        '更正一下，我现在改用Neovim，之前的Visual Studio Code不用了。',
      resolutionType: 'correction',
      closePreviousVersion: true,
      sourceAuthority: 'direct_user',
    }, 'alice');

    const candidates = new HybridRetrievalIndex(database).search({
      query: '现在常用的编辑器是什么',
      userId: 'alice',
      namespace: 'personal',
      timestamp: '2026-08-13T00:00:00.000Z',
      limit: 20,
    }).map((candidate) => candidate.id);
    assert.ok(candidates.includes(fact.id));
    assert.ok(!candidates.includes(oldEpisode.memoryId));
    assert.ok(!candidates.includes(correctionEpisode.memoryId));
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('图扩散候选上限返回精确聚合诊断', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-graph-cap-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);

  try {
    const seed = store.remember({
      kind: 'project',
      content: 'graph cap seed memory',
    }).memory;
    for (let index = 0; index < 5; index += 1) {
      const neighbor = store.remember({
        kind: 'project',
        content: `graph cap neighbor ${index}`,
      }).memory;
      store.addRelation(seed.id, neighbor.id, 'supports');
    }

    const result = new HybridRetrievalIndex(database)
      .expandGraphWithDiagnostics(
        {
          query: 'graph cap seed memory',
          userId: 'default',
          namespace: 'personal',
          timestamp: '2026-08-10T08:00:00.000Z',
        },
        [seed.id],
        2,
      );

    assert.equal(result.candidates.length, 2);
    assert.deepEqual(result.diagnostics, {
      rawCount: 5,
      returnedCount: 2,
      cappedCount: 3,
    });
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('全库 FTS 在第 1001、第 10001 和最老位置仍可召回', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-hybrid-scale-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const insert = database.prepare(
    `INSERT INTO memories (
       id, user_id, namespace, kind, title, content, summary,
       tags_json, importance, confidence, status, source, source_ref,
       occurred_at, valid_from, valid_to, created_at, updated_at,
       last_seen_at, access_count, checksum, embedding
     ) VALUES (
       ?, 'default', 'personal', 'knowledge', ?, ?, '', '[]',
       0.8, 1, 'active', 'scale-test', NULL,
       NULL, NULL, NULL, ?, ?, ?, 0, ?, ?
     )`,
  );
  const fillerVector = vectorToBuffer(embedText('普通规模填充记录'));
  const base = Date.parse('2026-07-29T12:00:00.000Z');
  const targets = new Map<number, {
    id: string;
    query: string;
    content: string;
  }>([
    [
      1_000,
      {
        id: 'boundary-1001',
        query: '第1001位的玄青海豚验收词是什么？',
        content: '第1001位的玄青海豚验收词是「潮汐-A1」。',
      },
    ],
    [
      10_000,
      {
        id: 'boundary-10001',
        query: '第10001位的赤金蜂鸟验收词是什么？',
        content: '第10001位的赤金蜂鸟验收词是「云脊-B2」。',
      },
    ],
    [
      10_019,
      {
        id: 'boundary-oldest',
        query: '最老位置的银灰鲸鱼验收词是什么？',
        content: '最老位置的银灰鲸鱼验收词是「深湾-C3」。',
      },
    ],
  ]);

  try {
    database.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 10_020; index += 1) {
      const target = targets.get(index);
      const id = target?.id || `filler-${index}`;
      const content =
        target?.content || `普通规模填充记录 ${index}，没有验收词。`;
      const timestamp = new Date(base - index * 1_000).toISOString();
      insert.run(
        id,
        `规模记录 ${index}`,
        content,
        timestamp,
        timestamp,
        timestamp,
        String(index).padStart(64, '0').slice(-64),
        fillerVector,
      );
    }
    database.exec('COMMIT');

    for (const target of targets.values()) {
      const recalled = store.recall({
        query: target.query,
        limit: 3,
      });
      assert.equal(recalled[0]?.memory.id, target.id);
      assert.match(recalled[0]?.reasons.join(' ') || '', /FTS5\/BM25/);
    }
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
