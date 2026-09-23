import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import {
  ConsolidationProviderOutputError,
  MemoryConsolidator,
  OllamaConsolidationProvider,
  type ConsolidationProvider,
  type ConsolidationSource,
} from '../src/server/memory-consolidator.js';
import { MemoryStore } from '../src/server/memory-store.js';

function createFixture(
  provider: ConsolidationProvider,
  options: {
    minimumSources?: number;
    maximumSources?: number;
    redundancyThreshold?: number;
  } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-consolidation-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycleStore = new LifecycleStore(database);
  const memoryStore = new MemoryStore(database);
  const consolidator = new MemoryConsolidator(
    database,
    lifecycleStore,
    memoryStore,
    provider,
    options.minimumSources,
    options.maximumSources,
    options.redundancyThreshold,
  );
  return {
    database,
    lifecycleStore,
    memoryStore,
    consolidator,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function rememberSources(memoryStore: MemoryStore) {
  const first = memoryStore.remember({
    kind: 'preference',
    content: '用户偏好使用 VS Code 编写 TypeScript。',
    stableKey: '用户::主要编辑器',
    predicateKey: '用户::开发偏好',
    normalizedValue: 'VS Code',
    normalizedValueHash: 'editor-vscode',
    source: 'automatic-extraction',
  }).memory;
  const second = memoryStore.remember({
    kind: 'preference',
    content: '用户写 TypeScript 时首选 VS Code。',
    stableKey: '用户::TypeScript编辑器偏好复述',
    predicateKey: '用户::开发偏好',
    normalizedValue: 'VS Code',
    normalizedValueHash: 'editor-vscode-restated',
    source: 'automatic-extraction',
  }).memory;
  return { first, second };
}

function atomicityProvider(
  promptVersion: string,
  sentencePrefix = '',
): ConsolidationProvider {
  return {
    model: 'qwen2.5:14b',
    promptVersion,
    async consolidate(_scope, sources) {
      return {
        sentences: [{
          text: [
            sentencePrefix,
            sources.map((source) => source.content).join(' '),
          ].filter(Boolean).join(' '),
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic atomicity fixture',
      }));
    },
  };
}

function consolidationPersistenceState(database: DatabaseSync) {
  const rows = (sql: string) =>
    database.prepare(sql).all() as Array<Record<string, unknown>>;
  return {
    memories: rows('SELECT * FROM memories ORDER BY id'),
    items: rows('SELECT * FROM memory_items ORDER BY id'),
    versions: rows(
      `SELECT * FROM memory_versions
       ORDER BY memory_item_id, version`,
    ),
    evidence: rows(
      `SELECT * FROM memory_evidence
       ORDER BY memory_version_id, id`,
    ),
    events: rows('SELECT * FROM memory_events ORDER BY id'),
    outbox: rows('SELECT * FROM outbox_events ORDER BY id'),
    jobs: rows('SELECT * FROM memory_jobs ORDER BY id'),
    audit: rows('SELECT * FROM audit_log ORDER BY user_id, id'),
    idempotency: rows(
      `SELECT * FROM idempotency_keys
       ORDER BY user_id, namespace, key`,
    ),
    consolidations: rows(
      'SELECT * FROM derived_consolidations ORDER BY id',
    ),
    consolidationSources: rows(
      `SELECT * FROM derived_consolidation_sources
       ORDER BY consolidation_id, memory_version_id`,
    ),
    sentences: rows(
      `SELECT * FROM derived_consolidation_sentences
       ORDER BY consolidation_id, sentence_index`,
    ),
    sentenceSources: rows(
      `SELECT * FROM derived_sentence_sources
       ORDER BY sentence_id, memory_version_id`,
    ),
    fts: rows(
      `SELECT memory_id, user_id, namespace, kind, title, content,
              summary, tags
       FROM memories_fts
       ORDER BY memory_id`,
    ),
    ann: rows(
      `SELECT * FROM memory_ann_index
       ORDER BY memory_id, index_model, band`,
    ),
    terms: rows(
      `SELECT * FROM memory_term_index
       ORDER BY memory_id, index_model, term`,
    ),
    embeddings: rows(
      `SELECT * FROM memory_embeddings
       ORDER BY memory_id, generation_id`,
    ),
    denseIndex: rows(
      `SELECT * FROM memory_dense_lsh
       ORDER BY memory_id, generation_id, band`,
    ),
  };
}

test('会话中的跨 kind 独立事实完成 no-op 且不调用巩固模型', async () => {
  let providerCalls = 0;
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-noop-v1',
    async consolidate() {
      providerCalls += 1;
      throw new Error('独立事实不应调用 provider');
    },
    async verifySupport() {
      providerCalls += 1;
      return [];
    },
  };
  const fixture = createFixture(provider, { minimumSources: 2 });
  try {
    const exchange = fixture.lifecycleStore.recordCompletedExchange({
      clientName: 'client',
      sessionExternalId: 'mixed-kind-session',
      userTurnExternalId: 'mixed-kind-user',
      userContent: '首次启动不要演示数据；长期记忆采用本地数据库。',
      assistantTurnExternalId: 'mixed-kind-assistant',
      assistantContent: '知道了。',
    });
    fixture.memoryStore.remember({
      kind: 'instruction',
      content: '产品首次启动不要演示数据。',
      predicateKey: '产品::首次启动数据',
      stableKey: '产品::首次启动数据',
      evidenceTurnId: exchange.userTurn.id,
      source: 'automatic-extraction',
    });
    fixture.memoryStore.remember({
      kind: 'knowledge',
      content: '长期记忆采用本地数据库。',
      predicateKey: '长期记忆::存储架构',
      stableKey: '长期记忆::存储架构',
      evidenceTurnId: exchange.userTurn.id,
      source: 'automatic-extraction',
    });

    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'session',
      scopeKey: exchange.sessionId,
    });

    assert.equal(result.status, 'completed_noop');
    assert.equal(result.noopReason, 'mixed_kinds_require_cluster_split');
    assert.equal(result.sourceCount, 2);
    assert.equal(providerCalls, 0);
  } finally {
    fixture.close();
  }
});

test('会话中的同 kind 不同谓词事实也完成 no-op 且不调用模型', async () => {
  let providerCalls = 0;
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-same-kind-noop-v1',
    async consolidate() {
      providerCalls += 1;
      throw new Error('不存在冗余簇时不应调用 provider');
    },
    async verifySupport() {
      providerCalls += 1;
      return [];
    },
  };
  const fixture = createFixture(provider, { minimumSources: 2 });
  try {
    const exchange = fixture.lifecycleStore.recordCompletedExchange({
      clientName: 'client',
      sessionExternalId: 'same-kind-independent-session',
      userTurnExternalId: 'same-kind-independent-user',
      userContent: '我喜欢深色主题，回答也请保持简短。',
      assistantTurnExternalId: 'same-kind-independent-assistant',
      assistantContent: '知道了。',
    });
    for (const [stableKey, content] of [
      ['用户::界面主题', '用户偏好深色主题。'],
      ['用户::回答长度', '用户偏好简短回答。'],
    ]) {
      fixture.memoryStore.remember({
        kind: 'preference',
        content,
        predicateKey: stableKey,
        stableKey,
        evidenceTurnId: exchange.userTurn.id,
        source: 'automatic-extraction',
      });
    }

    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'session',
      scopeKey: exchange.sessionId,
    });

    assert.equal(result.status, 'completed_noop');
    assert.equal(
      result.noopReason,
      'not_beneficial_no_redundant_cluster',
    );
    assert.equal(result.sourceCount, 2);
    assert.equal(providerCalls, 0);
  } finally {
    fixture.close();
  }
});

test('topic 中同 kind 不同谓词事实也完成 no-op 且不调用模型', async () => {
  let providerCalls = 0;
  const provider: ConsolidationProvider = {
    ...atomicityProvider('topic-independent-noop-v1'),
    async consolidate(scope, sources) {
      providerCalls += 1;
      return atomicityProvider('topic-independent-noop-v1')
        .consolidate(scope, sources);
    },
  };
  const fixture = createFixture(provider, { minimumSources: 2 });
  try {
    fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户喜欢深色主题。',
      stableKey: '用户::界面主题',
      predicateKey: '用户::界面主题',
      source: 'automatic-extraction',
    });
    fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户不吃香菜。',
      stableKey: '用户::饮食禁忌',
      predicateKey: '用户::饮食禁忌',
      source: 'automatic-extraction',
    });
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
      accessScopeType: 'personal',
      accessScopeKey: 'self',
    });
    assert.equal(result.status, 'completed_noop');
    assert.equal(
      result.noopReason,
      'not_beneficial_no_redundant_cluster',
    );
    assert.equal(providerCalls, 0);
  } finally {
    fixture.close();
  }
});

test('同一宽泛谓词下语义独立的事实也完成 no-op 且不调用模型', async () => {
  let providerCalls = 0;
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'same-predicate-independent-noop-v1',
    async consolidate() {
      providerCalls += 1;
      throw new Error('语义独立事实不应调用巩固模型');
    },
    async verifySupport() {
      providerCalls += 1;
      return [];
    },
  };
  const fixture = createFixture(provider, { minimumSources: 2 });
  try {
    for (const [stableKey, content] of [
      ['用户::主要编辑器', '用户偏好使用 VS Code 编写 TypeScript。'],
      ['用户::演示数据偏好', '用户不喜欢应用内置演示数据。'],
    ]) {
      fixture.memoryStore.remember({
        kind: 'preference',
        content,
        stableKey,
        predicateKey: '用户::开发偏好',
        source: 'automatic-extraction',
      });
    }
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
      accessScopeType: 'personal',
      accessScopeKey: 'self',
    });

    assert.equal(result.status, 'completed_noop');
    assert.equal(
      result.noopReason,
      'not_beneficial_no_redundant_cluster',
    );
    assert.equal(providerCalls, 0);
  } finally {
    fixture.close();
  }
});

test('语义冗余簇与来源插入顺序无关', async () => {
  const sourceTexts = [
    '用户稳定偏好深色主题。',
    '用户一直喜欢深色主题。',
    '用户的界面主题首选深色。',
    '用户偏爱的界面主题是深色。',
    '用户长期选择深色界面主题。',
  ];
  const observedClusters: string[][][] = [];

  for (const orderedTexts of [sourceTexts, [...sourceTexts].reverse()]) {
    const runClusters: string[][] = [];
    const provider: ConsolidationProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'order-independent-clusters-v1',
      async consolidate(_scope, sources) {
        runClusters.push(
          sources.map((source) => source.content).sort(),
        );
        return {
          sentences: [{
            text: '用户稳定偏好深色主题。',
            sourceVersionIds: sources.map(
              (source) => source.memoryVersionId,
            ),
          }],
        };
      },
      async verifySupport(_scope, _sources, sentences) {
        return sentences.map((_sentence, sentenceIndex) => ({
          sentenceIndex,
          supported: true,
          rationale: 'deterministic order fixture',
        }));
      },
    };
    const fixture = createFixture(provider);
    try {
      orderedTexts.forEach((content, index) => {
        fixture.memoryStore.remember({
          kind: 'preference',
          content,
          stableKey: `用户::顺序无关偏好${index}`,
          predicateKey: '用户::稳定偏好',
          source: 'automatic-extraction',
        });
      });
      const result = await fixture.consolidator.consolidateScope({
        userId: 'default',
        namespace: 'personal',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
        accessScopeType: 'personal',
        accessScopeKey: 'self',
      });
      assert.equal(result.status, 'created');
      assert.equal(result.sourceCount, sourceTexts.length);
      observedClusters.push(runClusters);
    } finally {
      fixture.close();
    }
  }

  assert.deepEqual(observedClusters[0], observedClusters[1]);
  assert.deepEqual(observedClusters[0], [[...sourceTexts].sort()]);
});

test('同一宽泛谓词下两组冗余只按语义簇送模型且排除噪声', async () => {
  const observedClusters: string[][] = [];
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'cluster-noise-boundary-v1',
    async consolidate(_scope, sources) {
      observedClusters.push(
        sources.map((source) => source.content).sort(),
      );
      return {
        sentences: [{
          text: sources[0].content,
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic cluster boundary fixture',
      }));
    },
  };
  const fixture = createFixture(provider, { minimumSources: 2 });
  try {
    const themeCluster = [
      '用户偏好深色界面主题。',
      '用户的界面主题首选深色。',
    ];
    const editorCluster = [
      '用户偏好用 VS Code 编写 TypeScript。',
      '用户写 TypeScript 时首选 VS Code。',
    ];
    const noise = '用户偏好阅读纸质历史书。';
    [...themeCluster, ...editorCluster, noise].forEach(
      (content, index) => {
        fixture.memoryStore.remember({
          kind: 'preference',
          content,
          stableKey: `用户::宽泛偏好${index}`,
          predicateKey: '用户::宽泛偏好',
          source: 'automatic-extraction',
        });
      },
    );

    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
      accessScopeType: 'personal',
      accessScopeKey: 'self',
    });

    assert.equal(result.status, 'created');
    assert.equal(result.sourceCount, 4);
    assert.deepEqual(
      observedClusters.map((cluster) => [...cluster].sort()).sort(),
      [themeCluster.sort(), editorCluster.sort()].sort(),
    );
    assert.equal(
      observedClusters.flat().includes(noise),
      false,
    );
  } finally {
    fixture.close();
  }
});

test('不同 role access scope 的来源永远不会进入同一派生摘要', async () => {
  const observed = new Map<string, string[]>();
  const provider: ConsolidationProvider = {
    ...atomicityProvider('consolidate-role-scope-isolation-v1'),
    async consolidate(scope, sources) {
      observed.set(
        `${scope.accessScopeType}/${scope.accessScopeKey}`,
        sources.map((source) => source.memoryId).sort(),
      );
      return {
        sentences: [{
          text: sources.map((source) => source.content).join(' '),
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
  };
  const fixture = createFixture(provider, { minimumSources: 2 });
  try {
    const rememberRole = (
      personaId: string,
      suffix: string,
      normalizedValue: string,
    ) => fixture.memoryStore.remember({
      kind: 'preference',
      content: `${personaId} 角色规则 ${suffix}。`,
      stableKey: `${personaId}::角色规则::${suffix}`,
      predicateKey: `${personaId}::角色规则`,
      normalizedValue,
      normalizedValueHash: `${personaId}-${normalizedValue}`,
      source: 'automatic-extraction',
      scopeType: 'role',
      scopeKey: personaId,
    }).memory;
    const star = [
      rememberRole('persona-star', '称呼小枫', '小枫'),
      rememberRole('persona-star', '称呼用户为小枫', '小枫'),
    ];
    const ink = [
      rememberRole('persona-ink', '称呼阿林', '阿林'),
      rememberRole('persona-ink', '称呼用户为阿林', '阿林'),
    ];
    const scope = (personaId: string) => ({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic' as const,
      scopeKey: 'kind:preference',
      accessScopeType: 'role' as const,
      accessScopeKey: personaId,
    });
    const starSummary = await fixture.consolidator.consolidateScope(
      scope('persona-star'),
    );
    const inkSummary = await fixture.consolidator.consolidateScope(
      scope('persona-ink'),
    );
    assert.equal(starSummary.status, 'created');
    assert.equal(inkSummary.status, 'created');
    assert.deepEqual(
      observed.get('role/persona-star'),
      star.map((memory) => memory.id).sort(),
    );
    assert.deepEqual(
      observed.get('role/persona-ink'),
      ink.map((memory) => memory.id).sort(),
    );
    assert.equal(
      observed.get('role/persona-star')?.some(
        (memoryId) => ink.some((memory) => memory.id === memoryId),
      ),
      false,
    );
    assert.deepEqual(
      fixture.database.prepare(
        `SELECT scope_type, scope_key
         FROM memories
         WHERE id IN (?, ?)
         ORDER BY scope_key`,
      ).all(starSummary.memoryId!, inkSummary.memoryId!).map((row) => ({
        scope_type: String(row.scope_type),
        scope_key: String(row.scope_key),
      })),
      [
        { scope_type: 'role', scope_key: 'persona-ink' },
        { scope_type: 'role', scope_key: 'persona-star' },
      ],
    );
  } finally {
    fixture.close();
  }
});

test('巩固持久化失败时原子回滚派生记忆及既有重建', async () => {
  const provider = atomicityProvider('consolidate-atomicity-v1');
  const fixture = createFixture(provider);
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  try {
    rememberSources(fixture.memoryStore);
    const beforeCreate = consolidationPersistenceState(
      fixture.database,
    );
    fixture.database.exec(`
      CREATE TRIGGER fail_consolidation_insert
      BEFORE INSERT ON derived_consolidations
      BEGIN
        SELECT RAISE(ABORT, 'injected consolidation insert failure');
      END
    `);

    await assert.rejects(
      fixture.consolidator.consolidateScope(scope),
      /injected consolidation insert failure/u,
    );
    assert.equal(fixture.database.isTransaction, false);
    assert.deepEqual(
      consolidationPersistenceState(fixture.database),
      beforeCreate,
    );

    fixture.database.exec('DROP TRIGGER fail_consolidation_insert');
    const created =
      await fixture.consolidator.consolidateScope(scope);
    assert.equal(created.status, 'created');
    const priorMemory =
      fixture.memoryStore.get(created.memoryId!, true);
    assert.ok(priorMemory);

    fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户开发 TypeScript 时仍首选 VS Code。',
      stableKey: '用户::TypeScript编辑器再次确认',
      predicateKey: '用户::开发偏好',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'editor-vscode-third',
      source: 'automatic-extraction',
    });
    const beforeRebuild = consolidationPersistenceState(
      fixture.database,
    );
    fixture.database.exec(`
      CREATE TRIGGER fail_sentence_source_insert
      BEFORE INSERT ON derived_sentence_sources
      BEGIN
        SELECT RAISE(ABORT, 'injected sentence source failure');
      END
    `);

    await assert.rejects(
      fixture.consolidator.consolidateScope(scope),
      /injected sentence source failure/u,
    );
    assert.equal(fixture.database.isTransaction, false);
    assert.deepEqual(
      consolidationPersistenceState(fixture.database),
      beforeRebuild,
    );
    assert.deepEqual(
      fixture.memoryStore.get(created.memoryId!, true),
      priorMemory,
    );

    fixture.database.exec('DROP TRIGGER fail_sentence_source_insert');
    const beforeFinalActivation = consolidationPersistenceState(
      fixture.database,
    );
    fixture.database.exec(`
      CREATE TRIGGER fail_final_activation
      BEFORE UPDATE ON memory_items
      WHEN NEW.revision = OLD.revision
        AND NEW.status = 'active'
      BEGIN
        SELECT RAISE(ABORT, 'injected final activation failure');
      END
    `);

    await assert.rejects(
      fixture.consolidator.consolidateScope(scope),
      /injected final activation failure/u,
    );
    assert.equal(fixture.database.isTransaction, false);
    assert.deepEqual(
      consolidationPersistenceState(fixture.database),
      beforeFinalActivation,
    );
    assert.deepEqual(
      fixture.memoryStore.get(created.memoryId!, true),
      priorMemory,
    );
  } finally {
    fixture.close();
  }
});

test('巩固内层事件或 outbox 失败时关闭事务并回滚全部副作用', async () => {
  for (const target of ['memory_events', 'outbox_events'] as const) {
    const fixture = createFixture(
      atomicityProvider(`consolidate-${target}-failure`),
    );
    try {
      rememberSources(fixture.memoryStore);
      const beforeFailure = consolidationPersistenceState(
        fixture.database,
      );
      fixture.database.exec(`
        CREATE TRIGGER fail_${target}_insert
        BEFORE INSERT ON ${target}
        BEGIN
          SELECT RAISE(ABORT, 'injected ${target} failure');
        END
      `);

      await assert.rejects(
        fixture.consolidator.consolidateScope({
          userId: 'default',
          namespace: 'personal',
          scopeType: 'topic',
          scopeKey: 'kind:preference',
        }),
        new RegExp(`injected ${target} failure`, 'u'),
      );
      assert.equal(fixture.database.isTransaction, false);
      assert.deepEqual(
        consolidationPersistenceState(fixture.database),
        beforeFailure,
      );
    } finally {
      fixture.close();
    }
  }
});

test('新提示版本替换旧摘要后若最终激活失败则旧摘要保持完整 active', async () => {
  const fixture = createFixture(
    atomicityProvider('consolidate-stable-v1'),
  );
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  try {
    rememberSources(fixture.memoryStore);
    const initial = await fixture.consolidator.consolidateScope(scope);
    assert.equal(initial.status, 'created');
    const priorMemory = fixture.memoryStore.get(
      initial.memoryId!,
      true,
    );
    assert.ok(priorMemory);
    const beforeReplacement = consolidationPersistenceState(
      fixture.database,
    );
    const replacement = new MemoryConsolidator(
      fixture.database,
      fixture.lifecycleStore,
      fixture.memoryStore,
      atomicityProvider(
        'consolidate-stable-v2',
        '以下是新版巩固摘要。',
      ),
    );
    fixture.database.exec(`
      CREATE TRIGGER fail_replacement_final_activation
      BEFORE UPDATE ON memory_items
      WHEN NEW.revision = OLD.revision
        AND NEW.status = 'active'
      BEGIN
        SELECT RAISE(
          ABORT,
          'injected replacement final activation failure'
        );
      END
    `);

    await assert.rejects(
      replacement.consolidateScope(scope),
      /injected replacement final activation failure/u,
    );
    assert.equal(fixture.database.isTransaction, false);
    assert.deepEqual(
      consolidationPersistenceState(fixture.database),
      beforeReplacement,
    );
    assert.deepEqual(
      fixture.memoryStore.get(initial.memoryId!, true),
      priorMemory,
    );
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT status
           FROM derived_consolidations
           WHERE id = ?`,
        )
        .get(initial.consolidationId!)?.status,
      'active',
    );
  } finally {
    fixture.close();
  }
});

test('新提示版本生成相同正文时原子复用记忆并保留两代生成元数据', async () => {
  const fixture = createFixture(
    atomicityProvider('consolidate-identical-v1'),
  );
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  try {
    rememberSources(fixture.memoryStore);
    const initial = await fixture.consolidator.consolidateScope(scope);
    assert.equal(initial.status, 'created');

    const replacement = new MemoryConsolidator(
      fixture.database,
      fixture.lifecycleStore,
      fixture.memoryStore,
      atomicityProvider('consolidate-identical-v2'),
    );
    const beforeUpgrade = consolidationPersistenceState(
      fixture.database,
    );
    fixture.database.exec(`
      CREATE TRIGGER fail_identical_upgrade_activation
      BEFORE UPDATE ON memory_items
      WHEN NEW.revision = OLD.revision
        AND NEW.status = 'active'
      BEGIN
        SELECT RAISE(
          ABORT,
          'injected identical upgrade activation failure'
        );
      END
    `);
    await assert.rejects(
      replacement.consolidateScope(scope),
      /injected identical upgrade activation failure/u,
    );
    assert.equal(fixture.database.isTransaction, false);
    assert.deepEqual(
      consolidationPersistenceState(fixture.database),
      beforeUpgrade,
    );
    fixture.database.exec(
      'DROP TRIGGER fail_identical_upgrade_activation',
    );

    const upgraded = await replacement.consolidateScope(scope);
    assert.equal(upgraded.status, 'created');
    assert.notEqual(upgraded.consolidationId, initial.consolidationId);
    assert.equal(upgraded.memoryId, initial.memoryId);
    const beforeUnchanged = consolidationPersistenceState(
      fixture.database,
    );
    assert.equal(
      (await replacement.consolidateScope(scope)).status,
      'unchanged',
    );
    assert.deepEqual(
      consolidationPersistenceState(fixture.database),
      beforeUnchanged,
    );

    const projections = fixture.database
      .prepare(
        `SELECT id, memory_id, model, prompt_version, status,
                source_set_hash
         FROM derived_consolidations
         ORDER BY prompt_version`,
      )
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      projections.map((row) => ({
        id: row.id,
        memoryId: row.memory_id,
        model: row.model,
        promptVersion: row.prompt_version,
        status: row.status,
      })),
      [
        {
          id: initial.consolidationId,
          memoryId: null,
          model: 'qwen2.5:14b',
          promptVersion: 'consolidate-identical-v1',
          status: 'stale',
        },
        {
          id: upgraded.consolidationId,
          memoryId: upgraded.memoryId,
          model: 'qwen2.5:14b',
          promptVersion: 'consolidate-identical-v2',
          status: 'active',
        },
      ],
    );
    assert.equal(
      projections[0]?.source_set_hash,
      projections[1]?.source_set_hash,
    );
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT consolidation_id, COUNT(*) AS source_count
           FROM derived_consolidation_sources
           GROUP BY consolidation_id
           ORDER BY consolidation_id`,
        )
        .all()
        .map((row) => ({
          consolidation_id: row.consolidation_id,
          source_count: row.source_count,
        })),
      [
        {
          consolidation_id: [
            initial.consolidationId,
            upgraded.consolidationId,
          ].sort()[0],
          source_count: 2,
        },
        {
          consolidation_id: [
            initial.consolidationId,
            upgraded.consolidationId,
          ].sort()[1],
          source_count: 2,
        },
      ],
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memories
           WHERE source = 'consolidation'`,
        )
        .get()?.count,
      1,
    );
    const activeMemory = fixture.memoryStore.get(
      upgraded.memoryId!,
      true,
    );
    assert.equal(activeMemory?.status, 'active');
    assert.equal(
      activeMemory?.sourceRef,
      `consolidation:${upgraded.consolidationId}`,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT revision
           FROM memory_items
           WHERE id = ?`,
        )
        .get(upgraded.memoryId!)?.revision,
      2,
    );
    const versions = fixture.database
      .prepare(
        `SELECT version, source_ref, created_by, superseded_at,
                valid_from, valid_to
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version`,
      )
      .all(upgraded.memoryId!) as Array<Record<string, unknown>>;
    assert.deepEqual(
      versions.map((row) => ({
        version: row.version,
        sourceRef: row.source_ref,
        createdBy: row.created_by,
        superseded: row.superseded_at !== null,
      })),
      [
        {
          version: 1,
          sourceRef: `consolidation:${initial.consolidationId}`,
          createdBy: 'consolidator:qwen2.5:14b',
          superseded: true,
        },
        {
          version: 2,
          sourceRef: `consolidation:${upgraded.consolidationId}`,
          createdBy: 'consolidator:qwen2.5:14b',
          superseded: false,
        },
      ],
    );
    assert.ok(versions[0]?.valid_from);
    assert.equal(
      versions[0]?.valid_to,
      versions[1]?.valid_from,
    );
    assert.equal(versions[1]?.valid_to, null);
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT s.consolidation_id, COUNT(ss.memory_version_id) AS count
           FROM derived_consolidation_sentences s
           JOIN derived_sentence_sources ss ON ss.sentence_id = s.id
           WHERE s.consolidation_id IN (?, ?)
           GROUP BY s.consolidation_id
           ORDER BY s.consolidation_id`,
        )
        .all(initial.consolidationId!, upgraded.consolidationId!)
        .map((row) => ({
          consolidationId: row.consolidation_id,
          count: row.count,
        })),
      [
        {
          consolidationId: [
            initial.consolidationId,
            upgraded.consolidationId,
          ].sort()[0],
          count: 2,
        },
        {
          consolidationId: [
            initial.consolidationId,
            upgraded.consolidationId,
          ].sort()[1],
          count: 2,
        },
      ],
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM derived_consolidations
           WHERE user_id = ? AND namespace = ?
             AND status = 'active'`,
        )
        .get(scope.userId, scope.namespace)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('相同正文只复用所有权、命名空间与访问作用域完全匹配的派生记忆', async () => {
  const cases: Array<{
    label: string;
    mutate(
      fixture: ReturnType<typeof createFixture>,
      memoryId: string,
    ): void;
  }> = [
    {
      label: 'projection-user',
      mutate(fixture, memoryId) {
        fixture.database
          .prepare(
            `UPDATE derived_consolidations
             SET user_id = 'other-user'
             WHERE memory_id = ?`,
          )
          .run(memoryId);
      },
    },
    {
      label: 'projection-namespace',
      mutate(fixture, memoryId) {
        fixture.database
          .prepare(
            `UPDATE derived_consolidations
             SET namespace = 'beta'
             WHERE memory_id = ?`,
          )
          .run(memoryId);
      },
    },
    {
      label: 'projection-logical-scope',
      mutate(fixture, memoryId) {
        fixture.database
          .prepare(
            `UPDATE derived_consolidations
             SET scope_type = 'project'
             WHERE memory_id = ?`,
          )
          .run(memoryId);
      },
    },
    {
      label: 'user',
      mutate(fixture, memoryId) {
        fixture.database
          .prepare(
            `UPDATE memories
             SET user_id = 'other-user'
             WHERE id = ?`,
          )
          .run(memoryId);
      },
    },
    {
      label: 'namespace',
      mutate(fixture, memoryId) {
        fixture.memoryStore.update(
          memoryId,
          { namespace: 'beta' },
          'default',
        );
      },
    },
    {
      label: 'access-scope',
      mutate(fixture, memoryId) {
        fixture.memoryStore.update(
          memoryId,
          {
            scopeType: 'project',
            scopeKey: 'beta-project',
          },
          'default',
        );
      },
    },
    {
      label: 'source',
      mutate(fixture, memoryId) {
        fixture.memoryStore.update(
          memoryId,
          { source: 'manual-edit' },
          'default',
        );
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = createFixture(
      atomicityProvider(`consolidate-boundary-${testCase.label}-v1`),
    );
    const scope = {
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic' as const,
      scopeKey: 'kind:preference',
      accessScopeType: 'personal' as const,
      accessScopeKey: 'self',
    };
    try {
      rememberSources(fixture.memoryStore);
      const initial =
        await fixture.consolidator.consolidateScope(scope);
      assert.equal(initial.status, 'created', testCase.label);
      testCase.mutate(fixture, initial.memoryId!);

      const replacement = new MemoryConsolidator(
        fixture.database,
        fixture.lifecycleStore,
        fixture.memoryStore,
        atomicityProvider(
          `consolidate-boundary-${testCase.label}-v2`,
        ),
      );
      const result = await replacement.consolidateScope(scope);
      assert.equal(result.status, 'created', testCase.label);
      assert.notEqual(
        result.memoryId,
        initial.memoryId,
        testCase.label,
      );
      assert.equal(
        fixture.database
          .prepare(
            `SELECT status
             FROM memories
             WHERE id = ?`,
          )
          .get(initial.memoryId!)?.status,
        'active',
        testCase.label,
      );
      assert.deepEqual(
        {
          ...fixture.database
            .prepare(
              `SELECT user_id, namespace, scope_type, scope_key, source
               FROM memories
               WHERE id = ?`,
            )
            .get(result.memoryId!),
        },
        {
          user_id: 'default',
          namespace: 'personal',
          scope_type: 'personal',
          scope_key: 'self',
          source: 'consolidation',
        },
        testCase.label,
      );
    } finally {
      fixture.close();
    }
  }
});

test('当前 provider 的已挂载记忆移出边界后不会误报 unchanged 或被改回', async () => {
  const fixture = createFixture(
    atomicityProvider('consolidate-attached-boundary-v1'),
  );
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  try {
    rememberSources(fixture.memoryStore);
    const initial =
      await fixture.consolidator.consolidateScope(scope);
    fixture.memoryStore.update(
      initial.memoryId!,
      { namespace: 'beta' },
      'default',
    );

    const rebuilt =
      await fixture.consolidator.consolidateScope(scope);
    assert.equal(rebuilt.status, 'rebuilt');
    assert.equal(
      rebuilt.consolidationId,
      initial.consolidationId,
    );
    assert.notEqual(rebuilt.memoryId, initial.memoryId);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT namespace, status
           FROM memories
           WHERE id = ?`,
        )
        .get(initial.memoryId!)?.namespace,
      'beta',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status
           FROM memories
           WHERE id = ?`,
        )
        .get(initial.memoryId!)?.status,
      'active',
    );
    assert.deepEqual(
      {
        ...fixture.database
          .prepare(
            `SELECT namespace, status
             FROM memories
             WHERE id = ?`,
          )
          .get(rebuilt.memoryId!),
      },
      {
        namespace: 'personal',
        status: 'active',
      },
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT memory_id
           FROM derived_consolidations
           WHERE id = ?`,
        )
        .get(rebuilt.consolidationId!)?.memory_id,
      rebuilt.memoryId,
    );
  } finally {
    fixture.close();
  }
});

test('同 namespace 的访问 scope 漂移可 rehome 且新旧边界严格隔离', async () => {
  const promptVersion = 'consolidate-access-rehome-v1';
  const fixture = createFixture(atomicityProvider(promptVersion));
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
    accessScopeType: 'personal' as const,
    accessScopeKey: 'self',
  };
  try {
    rememberSources(fixture.memoryStore);
    const initial =
      await fixture.consolidator.consolidateScope(scope);
    assert.equal(initial.status, 'created');
    fixture.memoryStore.update(
      initial.memoryId!,
      {
        scopeType: 'project',
        scopeKey: 'moved-boundary',
      },
      'default',
    );

    const rebuilt =
      await fixture.consolidator.consolidateScope(scope);
    assert.equal(rebuilt.status, 'rebuilt');
    assert.notEqual(rebuilt.memoryId, initial.memoryId);
    assert.equal(
      rebuilt.consolidationId,
      initial.consolidationId,
      '来源集合相同的 rehome 可复用不可变 projection',
    );
    assert.deepEqual(
      {
        ...fixture.database
          .prepare(
            `SELECT namespace, scope_type, scope_key, status
             FROM memories
             WHERE id = ?`,
          )
          .get(initial.memoryId!),
      },
      {
        namespace: 'personal',
        scope_type: 'project',
        scope_key: 'moved-boundary',
        status: 'active',
      },
    );
    assert.deepEqual(
      {
        ...fixture.database
          .prepare(
            `SELECT namespace, scope_type, scope_key, status
             FROM memories
             WHERE id = ?`,
          )
          .get(rebuilt.memoryId!),
      },
      {
        namespace: 'personal',
        scope_type: 'personal',
        scope_key: 'self',
        status: 'active',
      },
    );
    assert.deepEqual(
      {
        ...fixture.database
          .prepare(
            `SELECT status, memory_id
             FROM derived_consolidations
             WHERE id = ?`,
          )
          .get(rebuilt.consolidationId!),
      },
      { status: 'active', memory_id: rebuilt.memoryId },
    );
    const stableKeys = fixture.database
      .prepare(
        `SELECT stable_key
         FROM memory_items
         WHERE id IN (?, ?)
         ORDER BY stable_key`,
      )
      .all(initial.memoryId!, rebuilt.memoryId!)
      .map((row) => String(row.stable_key));
    assert.equal(stableKeys.length, 2);
    assert.notEqual(stableKeys[0], stableKeys[1]);
  } finally {
    fixture.close();
  }
});

test('并发相同 provider 与来源集合只持久化一次且另一调用 unchanged', async () => {
  let arrivals = 0;
  let releaseBarrier: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const base = atomicityProvider('consolidate-concurrent-v1');
  const provider: ConsolidationProvider = {
    ...base,
    async consolidate(scope, sources) {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier?.();
      await barrier;
      return base.consolidate(scope, sources);
    },
  };
  const fixture = createFixture(provider);
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  try {
    rememberSources(fixture.memoryStore);
    const results = await Promise.all([
      fixture.consolidator.consolidateScope(scope),
      fixture.consolidator.consolidateScope(scope),
    ]);
    assert.equal(arrivals, 2);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ['created', 'unchanged'],
    );
    assert.equal(results[0]?.memoryId, results[1]?.memoryId);
    assert.equal(
      results[0]?.consolidationId,
      results[1]?.consolidationId,
    );

    const derivedMemoryId = results[0]!.memoryId!;
    assert.equal(
      fixture.database
        .prepare(
          `SELECT revision
           FROM memory_items
           WHERE id = ?`,
        )
        .get(derivedMemoryId)?.revision,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM derived_consolidations`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_events
           WHERE memory_item_id = ?`,
        )
        .get(derivedMemoryId)?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM outbox_events o
           JOIN memory_events e ON e.id = o.aggregate_id
           WHERE o.aggregate_type = 'memory_event'
             AND e.memory_item_id = ?`,
        )
        .get(derivedMemoryId)?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE payload_json LIKE ?`,
        )
        .get(`%${derivedMemoryId}%`)?.count,
      0,
      '派生摘要不得递归触发新的巩固任务',
    );
    const beforeSequentialUnchanged =
      consolidationPersistenceState(fixture.database);
    assert.equal(
      (await fixture.consolidator.consolidateScope(scope)).status,
      'unchanged',
    );
    assert.deepEqual(
      consolidationPersistenceState(fixture.database),
      beforeSequentialUnchanged,
    );
  } finally {
    fixture.close();
  }
});

test('模型生成期间来源改版会丢弃旧草稿并基于事务内最新来源重试', async () => {
  let consolidateCalls = 0;
  let markFirstEntered: (() => void) | null = null;
  let releaseFirst: (() => void) | null = null;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-source-drift-v1',
    async consolidate(_scope, sources) {
      consolidateCalls += 1;
      if (consolidateCalls === 1) {
        markFirstEntered?.();
        await firstBarrier;
      }
      return {
        sentences: [{
          text: sources
            .map((source) => source.content)
            .join(' '),
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic source drift fixture',
      }));
    },
  };
  const fixture = createFixture(provider);
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  try {
    const { first, second } = rememberSources(fixture.memoryStore);
    const pending =
      fixture.consolidator.consolidateScope(scope);
    await firstEntered;
    fixture.memoryStore.update(
      first.id,
      {
        content: '用户偏好使用 Zed 编写 TypeScript。',
        normalizedValue: 'Zed',
        normalizedValueHash: 'editor-zed',
        closePreviousVersion: true,
        source: 'automatic-extraction',
      },
      'default',
    );
    fixture.memoryStore.update(
      second.id,
      {
        content: '用户写 TypeScript 时首选 Zed。',
        normalizedValue: 'Zed',
        normalizedValueHash: 'editor-zed-restated',
        closePreviousVersion: true,
        source: 'automatic-extraction',
      },
      'default',
    );
    releaseFirst?.();

    const result = await pending;
    assert.equal(result.status, 'created');
    assert.equal(consolidateCalls, 2);
    assert.match(
      fixture.memoryStore.get(result.memoryId!)?.content || '',
      /Zed/u,
    );
    assert.doesNotMatch(
      fixture.memoryStore.get(result.memoryId!)?.content || '',
      /VS Code/u,
    );
    const canonical = fixture.database
      .prepare(
        `SELECT
           d.source_set_hash,
           i.normalized_value_hash AS item_hash,
           i.normalized_value AS item_value,
           v.normalized_value_hash AS version_hash,
           v.normalized_value AS version_value
         FROM derived_consolidations d
         JOIN memory_items i ON i.id = d.memory_id
         JOIN memory_versions v ON v.id = i.current_version_id
         WHERE d.id = ?`,
      )
      .get(result.consolidationId!);
    assert.ok(canonical);
    assert.equal(
      canonical.item_hash,
      canonical.source_set_hash,
    );
    assert.equal(
      canonical.item_value,
      canonical.source_set_hash,
    );
    assert.equal(
      canonical.version_hash,
      canonical.source_set_hash,
    );
    assert.equal(
      canonical.version_value,
      canonical.source_set_hash,
    );
  } finally {
    fixture.close();
  }
});

test('过期失败草稿不得覆盖并发提交的新 active projection', async () => {
  let markEntered: (() => void) | null = null;
  let releaseDraft: (() => void) | null = null;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    releaseDraft = resolve;
  });
  const promptVersion = 'consolidate-quarantine-race-v1';
  const staleProvider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion,
    async consolidate() {
      markEntered?.();
      await barrier;
      return {
        sentences: [{
          text: '过期失败草稿。',
          sourceVersionIds: ['not-a-current-source-version'],
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: false,
        rationale: 'deterministic stale quarantine fixture',
      }));
    },
  };
  const fixture = createFixture(staleProvider);
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  try {
    rememberSources(fixture.memoryStore);
    const staleAttempt =
      fixture.consolidator.consolidateScope(scope);
    await entered;

    const winningConsolidator = new MemoryConsolidator(
      fixture.database,
      fixture.lifecycleStore,
      fixture.memoryStore,
      atomicityProvider(promptVersion),
    );
    const winner = await winningConsolidator.consolidateScope(scope);
    assert.equal(winner.status, 'created');
    const stateAfterWinner = consolidationPersistenceState(
      fixture.database,
    );
    releaseDraft?.();

    const staleResult = await staleAttempt;
    assert.equal(staleResult.status, 'unchanged');
    assert.equal(staleResult.consolidationId, winner.consolidationId);
    assert.equal(staleResult.memoryId, winner.memoryId);
    assert.deepEqual(
      consolidationPersistenceState(fixture.database),
      stateAfterWinner,
      '失败草稿发现 projection revision 漂移后必须零副作用丢弃',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM derived_consolidations
           WHERE status = 'quarantined'`,
        )
        .get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('非破坏式巩固逐句绑定来源版本且不覆盖原子事实', async () => {
  let observedSources: ConsolidationSource[] = [];
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    async consolidate(_scope, sources) {
      observedSources = sources;
      return {
        sentences: [{
          text: '用户编写 TypeScript 时首选 VS Code。',
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic test evidence',
      }));
    },
  };
  const fixture = createFixture(provider);
  try {
    rememberSources(fixture.memoryStore);
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });

    assert.equal(result.status, 'created');
    assert.equal(result.sourceCount, 2);
    assert.equal(result.sentenceCount, 1);
    assert.equal(observedSources.length, 2);
    assert.equal(fixture.memoryStore.list().total, 3);
    const derived = fixture.memoryStore.get(result.memoryId!);
    assert.equal(derived?.source, 'consolidation');
    assert.match(derived?.content || '', /派生摘要/);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM derived_sentence_sources`,
        )
        .get()?.count,
      2,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_versions
           WHERE memory_item_id IN (?, ?)`,
        )
        .get(
          observedSources[0].memoryId,
          observedSources[1].memoryId,
        )?.count,
      2,
    );
    const recalled = fixture.memoryStore.recall({
      query: '用户编写 TypeScript 时首选哪个编辑器？',
      limit: 10,
    });
    assert.deepEqual(
      recalled.map((entry) => entry.memory.id),
      [result.memoryId],
    );
    assert.match(
      recalled[0]?.reasons.join(' ') || '',
      /覆盖 2 条原子事实/,
    );
  } finally {
    fixture.close();
  }
});

test('来源修改后派生摘要立即 stale 并用同一稳定 ID 重建', async () => {
  let generation = 0;
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    async consolidate(_scope, sources) {
      generation += 1;
      return {
        sentences: [{
          text:
            generation === 1
              ? '用户编写 TypeScript 时首选 VS Code。'
              : '用户编写 TypeScript 时首选 Zed。',
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic test evidence',
      }));
    },
  };
  const fixture = createFixture(provider);
  try {
    const { first, second } = rememberSources(fixture.memoryStore);
    const scope = {
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic' as const,
      scopeKey: 'kind:preference',
    };
    const initial = await fixture.consolidator.consolidateScope(scope);
    const initialSourceSetHash = String(
      fixture.database
        .prepare(
          `SELECT source_set_hash
           FROM derived_consolidations
           WHERE id = ?`,
        )
        .get(initial.consolidationId!)?.source_set_hash,
    );
    const initialSourceVersionIds = (
      fixture.database
        .prepare(
          `SELECT memory_version_id
           FROM derived_consolidation_sources
           WHERE consolidation_id = ?
           ORDER BY memory_version_id`,
        )
        .all(initial.consolidationId!) as Array<Record<string, unknown>>
    ).map((row) => String(row.memory_version_id));
    const initialSentenceChain = (
      fixture.database
        .prepare(
          `SELECT s.sentence_text, ss.memory_version_id
           FROM derived_consolidation_sentences s
           JOIN derived_sentence_sources ss ON ss.sentence_id = s.id
           WHERE s.consolidation_id = ?
           ORDER BY s.sentence_index, ss.memory_version_id`,
        )
        .all(initial.consolidationId!) as Array<Record<string, unknown>>
    ).map((row) => ({
      sentenceText: String(row.sentence_text),
      sourceVersionId: String(row.memory_version_id),
    }));
    fixture.memoryStore.update(first.id, {
      content: '用户偏好使用 Zed 编写 TypeScript。',
      normalizedValue: 'Zed',
      normalizedValueHash: 'editor-zed',
      closePreviousVersion: true,
      source: 'automatic-extraction',
    });
    fixture.memoryStore.update(second.id, {
      content: '用户写 TypeScript 时首选 Zed。',
      normalizedValue: 'Zed',
      normalizedValueHash: 'editor-zed-restated',
      closePreviousVersion: true,
      source: 'automatic-extraction',
    });
    const invalidation =
      fixture.consolidator.handleMemoryChange(first.id, 'event-change');
    assert.ok(invalidation.invalidated >= 1);
    assert.equal(invalidation.enqueued, 1);
    const rebuildPayload = JSON.parse(String(
      fixture.database
        .prepare(
          `SELECT payload_json
           FROM memory_jobs
           WHERE job_type = 'consolidate_scope'
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get()?.payload_json,
    ));
    assert.equal(rebuildPayload.accessScopeType, 'personal');
    assert.equal(rebuildPayload.accessScopeKey, 'self');
    assert.equal(
      fixture.memoryStore.get(initial.memoryId!, true)?.status,
      'archived',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status
           FROM derived_consolidations
           WHERE id = ?`,
        )
        .get(initial.consolidationId!)?.status,
      'stale',
    );

    const rebuilt = await fixture.consolidator.consolidateScope(scope);
    assert.equal(rebuilt.status, 'rebuilt');
    assert.equal(rebuilt.memoryId, initial.memoryId);
    assert.notEqual(
      rebuilt.consolidationId,
      initial.consolidationId,
      '每个派生 memory version 必须指向不可覆盖的独立 projection',
    );
    assert.match(
      fixture.memoryStore.get(rebuilt.memoryId!)?.content || '',
      /Zed/,
    );
    assert.deepEqual(
      {
        ...fixture.database
          .prepare(
            `SELECT revision, status, memory_id, source_set_hash
             FROM derived_consolidations
             WHERE id = ?`,
          )
          .get(initial.consolidationId!),
      },
      {
        revision: 1,
        status: 'stale',
        memory_id: null,
        source_set_hash: initialSourceSetHash,
      },
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status
           FROM derived_consolidations
           WHERE id = ?`,
        )
        .get(rebuilt.consolidationId!)?.status,
      'active',
    );
    assert.deepEqual(
      (
        fixture.database
          .prepare(
            `SELECT memory_version_id
             FROM derived_consolidation_sources
             WHERE consolidation_id = ?
             ORDER BY memory_version_id`,
          )
          .all(initial.consolidationId!) as Array<Record<string, unknown>>
      ).map((row) => String(row.memory_version_id)),
      initialSourceVersionIds,
      '重建不得覆盖旧 projection 的 source-set',
    );
    assert.deepEqual(
      (
        fixture.database
          .prepare(
            `SELECT s.sentence_text, ss.memory_version_id
             FROM derived_consolidation_sentences s
             JOIN derived_sentence_sources ss ON ss.sentence_id = s.id
             WHERE s.consolidation_id = ?
             ORDER BY s.sentence_index, ss.memory_version_id`,
          )
          .all(initial.consolidationId!) as Array<Record<string, unknown>>
      ).map((row) => ({
        sentenceText: String(row.sentence_text),
        sourceVersionId: String(row.memory_version_id),
      })),
      initialSentenceChain,
      '重建不得覆盖旧 projection 的逐句来源链',
    );
    const derivedVersions = fixture.database
      .prepare(
        `SELECT version, source_ref, superseded_at
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version`,
      )
      .all(rebuilt.memoryId!) as Array<Record<string, unknown>>;
    assert.deepEqual(
      derivedVersions.map((row) => ({
        version: Number(row.version),
        sourceRef: String(row.source_ref),
        superseded: row.superseded_at !== null,
      })),
      [
        {
          version: 1,
          sourceRef: `consolidation:${initial.consolidationId}`,
          superseded: true,
        },
        {
          version: 2,
          sourceRef: `consolidation:${rebuilt.consolidationId}`,
          superseded: false,
        },
      ],
    );
    const rebuiltCanonical = fixture.database
      .prepare(
        `SELECT
           d.source_set_hash,
           i.normalized_value_hash AS item_hash,
           i.normalized_value AS item_value,
           v.normalized_value_hash AS version_hash,
           v.normalized_value AS version_value
         FROM derived_consolidations d
         JOIN memory_items i ON i.id = d.memory_id
         JOIN memory_versions v ON v.id = i.current_version_id
         WHERE d.id = ?`,
      )
      .get(rebuilt.consolidationId!);
    assert.ok(rebuiltCanonical);
    assert.notEqual(
      rebuiltCanonical.source_set_hash,
      initialSourceSetHash,
    );
    assert.equal(
      rebuiltCanonical.item_hash,
      rebuiltCanonical.source_set_hash,
    );
    assert.equal(
      rebuiltCanonical.item_value,
      rebuiltCanonical.source_set_hash,
    );
    assert.equal(
      rebuiltCanonical.version_hash,
      rebuiltCanonical.source_set_hash,
    );
    assert.equal(
      rebuiltCanonical.version_value,
      rebuiltCanonical.source_set_hash,
    );
  } finally {
    fixture.close();
  }
});

test('无有效来源支持的摘要进入隔离区且不参与召回', async () => {
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    async consolidate() {
      return {
        sentences: [{
          text: '模型凭空添加的事实。',
          sourceVersionIds: ['hallucinated-version'],
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'invalid source IDs are rejected first',
      }));
    },
  };
  const fixture = createFixture(provider);
  try {
    rememberSources(fixture.memoryStore);
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });
    assert.equal(result.status, 'quarantined');
    assert.equal(result.memoryId, null);
    assert.equal(result.unsupportedSentenceCount, 1);
    assert.equal(fixture.memoryStore.list().total, 2);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status
           FROM derived_consolidations
           WHERE id = ?`,
        )
        .get(result.consolidationId!)?.status,
      'quarantined',
    );
  } finally {
    fixture.close();
  }
});

test('合法来源 ID 不能掩盖未被来源语义蕴含的摘要', async () => {
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    async consolidate(_scope, sources) {
      return {
        sentences: [{
          text: '用户每周一都去上海办公室。',
          sourceVersionIds: [sources[0].memoryVersionId],
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: false,
        rationale: '引用来源没有办公室或时间信息',
      }));
    },
  };
  const fixture = createFixture(provider);
  try {
    rememberSources(fixture.memoryStore);
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });
    assert.equal(result.status, 'quarantined');
    assert.equal(result.memoryId, null);
    assert.equal(result.unsupportedSentenceCount, 1);
    assert.equal(fixture.memoryStore.list().total, 2);
    assert.deepEqual(
      (fixture.database
        .prepare(
          `SELECT sentence_index, supported
           FROM derived_consolidation_sentences
           WHERE consolidation_id = ?
           ORDER BY sentence_index ASC`,
        )
        .all(result.consolidationId!) as Array<Record<string, unknown>>)
        .map((row) => ({
          sentence_index: Number(row.sentence_index),
          supported: Number(row.supported),
        })),
      [{ sentence_index: 0, supported: 0 }],
    );
  } finally {
    fixture.close();
  }
});

test('混合摘要逐句保存核验结果且整份不进入召回', async () => {
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    async consolidate(_scope, sources) {
      return {
        sentences: [
          {
            text: '用户使用 VS Code。',
            sourceVersionIds: [sources[0].memoryVersionId],
          },
          {
            text: '用户住在上海。',
            sourceVersionIds: [sources[1].memoryVersionId],
          },
        ],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: sentenceIndex === 0,
        rationale:
          sentenceIndex === 0
            ? '同义改写'
            : '来源没有住址信息',
      }));
    },
  };
  const fixture = createFixture(provider);
  try {
    rememberSources(fixture.memoryStore);
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });
    assert.equal(result.status, 'quarantined');
    assert.equal(result.unsupportedSentenceCount, 1);
    assert.deepEqual(
      (fixture.database
        .prepare(
          `SELECT sentence_index, supported
           FROM derived_consolidation_sentences
           WHERE consolidation_id = ?
           ORDER BY sentence_index ASC`,
        )
        .all(result.consolidationId!) as Array<Record<string, unknown>>)
        .map((row) => ({
          sentence_index: Number(row.sentence_index),
          supported: Number(row.supported),
        })),
      [
        { sentence_index: 0, supported: 1 },
        { sentence_index: 1, supported: 0 },
      ],
    );
    assert.equal(fixture.memoryStore.list().total, 2);
  } finally {
    fixture.close();
  }
});

test('project scopeKey 中的 LIKE 通配字符按结构化前缀精确匹配', async () => {
  const observedSourceIds: string[][] = [];
  const provider: ConsolidationProvider = {
    ...atomicityProvider('consolidate-special-scope-key-v1'),
    async consolidate(_scope, sources) {
      observedSourceIds.push(
        sources.map((source) => source.memoryId).sort(),
      );
      return {
        sentences: [{
          text: sources.map((source) => source.content).join(' '),
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
  };
  const fixture = createFixture(provider);
  const logicalScopeKey = 'Atlas_100%\\blue';
  const wildcardCollision = 'AtlasX100ZZ\\blue';
  const accessScopeKey = 'shared-project-boundary';
  const rememberProjectFact = (
    logicalKey: string,
    suffix: string,
    index: number,
  ) => fixture.memoryStore.remember({
    kind: 'project',
    content: `${logicalKey} 的 ${suffix}。`,
    stableKey: `${logicalKey}::后端技术::${index}`,
    predicateKey: `${logicalKey}::项目配置`,
    normalizedValue: 'Node.js',
    normalizedValueHash: `${logicalKey}-nodejs-${index}`,
    scopeType: 'project',
    scopeKey: accessScopeKey,
    source: 'automatic-extraction',
  }).memory;
  try {
    const expected = [
      rememberProjectFact(logicalScopeKey, '后端采用 Node.js', 1),
      rememberProjectFact(logicalScopeKey, '服务端使用 Node.js', 2),
    ];
    const decoys = [
      rememberProjectFact(wildcardCollision, '后端采用 Node.js', 1),
      rememberProjectFact(wildcardCollision, '服务端使用 Node.js', 2),
    ];

    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'project',
      scopeKey: logicalScopeKey,
      accessScopeType: 'project',
      accessScopeKey,
    });

    assert.equal(result.status, 'created');
    assert.equal(result.sourceCount, 2);
    assert.deepEqual(
      observedSourceIds,
      [expected.map((memory) => memory.id).sort()],
    );
    assert.equal(
      observedSourceIds[0]?.some((id) =>
        decoys.some((memory) => memory.id === id)),
      false,
    );
  } finally {
    fixture.close();
  }
});

test('新巩固达到第 4 条才触发且 namespace 与访问 scope 绝不混合', async () => {
  const observed: Array<{
    namespace: string;
    accessScopeType: string;
    accessScopeKey: string;
    sourceIds: string[];
  }> = [];
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    async consolidate(scope, sources) {
      observed.push({
        namespace: scope.namespace,
        accessScopeType: scope.accessScopeType || 'personal',
        accessScopeKey: scope.accessScopeKey || 'self',
        sourceIds: sources.map((source) => source.memoryId),
      });
      return {
        sentences: [{
          text: `${scope.namespace}/${scope.accessScopeType}/${
            scope.accessScopeKey
          } 的偏好摘要。`,
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic scope fixture',
      }));
    },
  };
  const fixture = createFixture(provider, {
    redundancyThreshold: 4,
  });
  try {
    const rememberScoped = (
      namespace: string,
      scopeType: 'personal' | 'project' | 'role' | 'session',
      scopeKey: string,
      index: number,
    ) => fixture.memoryStore.remember({
      namespace,
      kind: 'preference',
      content: `${namespace}/${scopeType}/${scopeKey} ${[
        '使用深色主题',
        '偏好深色主题',
        '首选深色主题',
        '喜欢深色主题',
      ][index - 1]}。`,
      stableKey: `${scopeType}::${scopeKey}::偏好${index}`,
      predicateKey: '用户::作用域偏好',
      normalizedValue: '深色主题',
      normalizedValueHash:
        `${namespace}-${scopeType}-${scopeKey}-${index}`,
      source: 'automatic-extraction',
      scopeType,
      scopeKey,
    }).memory;

    const personal = [
      rememberScoped('personal', 'personal', 'self', 1),
      rememberScoped('personal', 'personal', 'self', 2),
      rememberScoped('personal', 'personal', 'self', 3),
    ];
    assert.equal(
      fixture.consolidator.handleMemoryChange(
        personal[2].id,
        'personal-before-threshold',
      ).enqueued,
      0,
    );
    personal.push(
      rememberScoped('personal', 'personal', 'self', 4),
    );
    assert.equal(
      fixture.consolidator.handleMemoryChange(
        personal[3].id,
        'personal-at-threshold',
      ).enqueued,
      1,
    );

    const project = Array.from(
      { length: 4 },
      (_, index) =>
        rememberScoped(
          'personal',
          'project',
          'client-a',
          index + 1,
        ),
    );
    assert.equal(
      fixture.consolidator.handleMemoryChange(
        project[3].id,
        'project-at-threshold',
      ).enqueued,
      1,
    );
    const role = Array.from(
      { length: 4 },
      (_, index) =>
        rememberScoped(
          'personal',
          'role',
          'developer',
          index + 1,
        ),
    );
    assert.equal(
      fixture.consolidator.handleMemoryChange(
        role[3].id,
        'role-at-threshold',
      ).enqueued,
      1,
    );
    const session = Array.from(
      { length: 4 },
      (_, index) =>
        rememberScoped(
          'personal',
          'session',
          'source-session',
          index + 1,
        ),
    );
    assert.equal(
      fixture.consolidator.handleMemoryChange(
        session[3].id,
        'session-access-at-threshold',
      ).enqueued,
      1,
    );
    const otherNamespace = Array.from(
      { length: 4 },
      (_, index) =>
        rememberScoped(
          'other',
          'personal',
          'self',
          index + 1,
        ),
    );

    const queuedPayloads = (
      fixture.database
        .prepare(
          `SELECT payload_json
           FROM memory_jobs
           WHERE job_type = 'consolidate_scope'
           ORDER BY id ASC`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => JSON.parse(String(row.payload_json)));
    assert.deepEqual(
      queuedPayloads.map((payload) => [
        payload.namespace,
        payload.accessScopeType,
        payload.accessScopeKey,
      ]).sort(),
      [
        ['personal', 'personal', 'self'],
        ['personal', 'project', 'client-a'],
        ['personal', 'role', 'developer'],
        ['personal', 'session', 'source-session'],
      ],
    );

    const personalResult =
      await fixture.consolidator.consolidateScope({
        userId: 'default',
        namespace: 'personal',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
        accessScopeType: 'personal',
        accessScopeKey: 'self',
      });
    const projectResult =
      await fixture.consolidator.consolidateScope({
        userId: 'default',
        namespace: 'personal',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
        accessScopeType: 'project',
        accessScopeKey: 'client-a',
      });
    const otherResult =
      await fixture.consolidator.consolidateScope({
        userId: 'default',
        namespace: 'other',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
        accessScopeType: 'personal',
        accessScopeKey: 'self',
      });
    const roleResult =
      await fixture.consolidator.consolidateScope({
        userId: 'default',
        namespace: 'personal',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
        accessScopeType: 'role',
        accessScopeKey: 'developer',
      });
    const sessionResult =
      await fixture.consolidator.consolidateScope({
        userId: 'default',
        namespace: 'personal',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
        accessScopeType: 'session',
        accessScopeKey: 'source-session',
      });

    assert.deepEqual(
      observed.map((entry) => [
        entry.namespace,
        entry.accessScopeType,
        entry.accessScopeKey,
        entry.sourceIds.length,
      ]),
      [
        ['personal', 'personal', 'self', 4],
        ['personal', 'project', 'client-a', 4],
        ['other', 'personal', 'self', 4],
        ['personal', 'role', 'developer', 4],
        ['personal', 'session', 'source-session', 4],
      ],
    );
    assert.deepEqual(
      [
        fixture.memoryStore.get(personalResult.memoryId!)?.scopeType,
        fixture.memoryStore.get(personalResult.memoryId!)?.scopeKey,
        fixture.memoryStore.get(projectResult.memoryId!)?.scopeType,
        fixture.memoryStore.get(projectResult.memoryId!)?.scopeKey,
        fixture.memoryStore.get(otherResult.memoryId!)?.namespace,
        fixture.memoryStore.get(roleResult.memoryId!)?.scopeType,
        fixture.memoryStore.get(roleResult.memoryId!)?.scopeKey,
        fixture.memoryStore.get(sessionResult.memoryId!)?.scopeType,
        fixture.memoryStore.get(sessionResult.memoryId!)?.scopeKey,
      ],
      [
        'personal',
        'self',
        'project',
        'client-a',
        'other',
        'role',
        'developer',
        'session',
        'source-session',
      ],
    );
    const storedScopes = fixture.database
      .prepare(
        `SELECT namespace, scope_key
         FROM derived_consolidations
         WHERE scope_type = 'topic'`,
      )
      .all() as Array<Record<string, unknown>>;
    assert.equal(storedScopes.length, 5);
    assert.equal(
      new Set(storedScopes.map((row) =>
        `${row.namespace}\u0000${row.scope_key}`)).size,
      5,
    );
    assert.equal(
      personal.some((memory) =>
        observed[1].sourceIds.includes(memory.id)),
      false,
    );
    assert.equal(
      project.some((memory) =>
        observed[0].sourceIds.includes(memory.id)),
      false,
    );
    assert.equal(
      role.some((memory) =>
        observed[0].sourceIds.includes(memory.id)),
      false,
    );
    assert.equal(
      session.some((memory) =>
        observed[0].sourceIds.includes(memory.id)),
      false,
    );
    assert.equal(otherNamespace.length, 4);
  } finally {
    fixture.close();
  }
});

test('同 scope 巩固任务只保留最新待处理项且不打断运行中任务', () => {
  const fixture = createFixture(atomicityProvider('scope-coalescing-v1'), {
    redundancyThreshold: 2,
  });
  try {
    const first = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户偏好深色主题。',
      stableKey: '用户::深色主题偏好一',
      predicateKey: '用户::界面偏好',
      normalizedValue: '深色主题',
      normalizedValueHash: 'dark-theme-1',
      source: 'automatic-extraction',
    }).memory;
    const second = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户一直首选深色界面。',
      stableKey: '用户::深色主题偏好二',
      predicateKey: '用户::界面偏好',
      normalizedValue: '深色主题',
      normalizedValueHash: 'dark-theme-2',
      source: 'automatic-extraction',
    }).memory;
    assert.ok(first.id);

    assert.equal(
      fixture.consolidator.handleMemoryChange(
        second.id,
        'scope-coalescing-event-1',
      ).enqueued,
      1,
    );
    assert.equal(
      fixture.consolidator.handleMemoryChange(
        second.id,
        'scope-coalescing-event-2',
      ).enqueued,
      1,
    );
    const rowsAfterSecond = fixture.database.prepare(
      `SELECT id, status, last_error
       FROM memory_jobs
       WHERE job_type = 'consolidate_scope'
       ORDER BY created_at ASC, id ASC`,
    ).all() as Array<Record<string, unknown>>;
    assert.equal(rowsAfterSecond.length, 2);
    assert.equal(
      rowsAfterSecond.filter((row) => row.status === 'pending').length,
      1,
    );
    assert.equal(
      rowsAfterSecond.filter((row) => row.status === 'completed').length,
      1,
    );
    assert.match(
      String(rowsAfterSecond.find(
        (row) => row.status === 'completed',
      )?.last_error || ''),
      /coalesced_by_newer_scope_job/u,
    );

    const pendingId = String(rowsAfterSecond.find(
      (row) => row.status === 'pending',
    )?.id || '');
    fixture.database.prepare(
      `UPDATE memory_jobs
       SET status = 'running', lease_owner = 'scope-worker',
           lease_until = '2099-01-01T00:00:00.000Z'
       WHERE id = ?`,
    ).run(pendingId);
    fixture.consolidator.handleMemoryChange(
      second.id,
      'scope-coalescing-event-3',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT status FROM memory_jobs WHERE id = ?`,
      ).get(pendingId)?.status,
      'running',
      '新事件不得中断已开始的巩固',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_jobs
         WHERE job_type = 'consolidate_scope'
           AND status = 'pending'`,
      ).get()?.count,
      1,
      '运行任务之后只允许保留一个最新后继任务',
    );
  } finally {
    fixture.close();
  }
});

test('5 条冗余原子来源确定性压缩为不超过 2 条摘要句', async () => {
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    async consolidate(_scope, sources) {
      return {
        sentences: [{
          text: '用户稳定偏好深色主题。',
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic compression fixture',
      }));
    },
  };
  const fixture = createFixture(provider);
  try {
    const redundantSources = [
      '用户稳定偏好深色主题。',
      '用户一直喜欢深色主题。',
      '用户的界面主题首选深色。',
      '用户偏爱的界面主题是深色。',
      '用户长期选择深色界面主题。',
    ];
    for (let index = 1; index <= 5; index += 1) {
      fixture.memoryStore.remember({
        kind: 'preference',
        content: redundantSources[index - 1],
        stableKey: `用户::稳定偏好${index}`,
        predicateKey: '用户::稳定偏好',
        source: 'automatic-extraction',
      });
    }
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
      accessScopeType: 'personal',
      accessScopeKey: 'self',
    });
    assert.equal(result.status, 'created');
    assert.equal(result.sourceCount, 5);
    assert.ok(result.sentenceCount <= 2);
    assert.ok(1 - result.sentenceCount / result.sourceCount >= 0.6);
  } finally {
    fixture.close();
  }
});

test('protocol repair 将大语义簇确定性缩成单次小批处理', async () => {
  const observedBatchSizes: number[] = [];
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'protocol-repair-batching-v1',
    async consolidate(_scope, sources) {
      observedBatchSizes.push(sources.length);
      return {
        sentences: [{
          text: '用户偏好深色主题。',
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic protocol repair fixture',
      }));
    },
  };
  const fixture = createFixture(provider, { minimumSources: 2 });
  try {
    [
      '用户稳定偏好深色主题。',
      '用户一直喜欢深色主题。',
      '用户的界面主题首选深色。',
      '用户偏爱的界面主题是深色。',
      '用户长期选择深色界面主题。',
    ].forEach((content, index) => {
      fixture.memoryStore.remember({
        kind: 'preference',
        content,
        stableKey: `用户::协议修复主题${index}`,
        predicateKey: '用户::界面主题',
        normalizedValue: '深色主题',
        source: 'automatic-extraction',
      });
    });

    const result = await fixture.consolidator.consolidateScope(
      {
        userId: 'default',
        namespace: 'personal',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
      },
      { recoveryStrategy: 'single_attempt_protocol_repair' },
    );

    assert.equal(result.status, 'created');
    assert.equal(result.sourceCount, 5);
    assert.deepEqual(observedBatchSizes, [2, 3]);
    assert.equal(
      result.compensationAction,
      'single_attempt_protocol_repair',
    );
  } finally {
    fixture.close();
  }
});

test('14B 巩固器生成和逐句核验各使用一次批量请求并保持模型常驻', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const provider = new OllamaConsolidationProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as
        Record<string, unknown>;
      requestBodies.push(requestBody);
      return new Response(
        JSON.stringify({
          message: {
            content:
              requestBodies.length === 1
                ? JSON.stringify({
                    sentences: [{
                      text:
                        '用户有两项稳定偏好。' +
                        '(memoryVersionId: version-1, version-2)',
                      sourceVersionIds: [
                        'version-1',
                        'version-2',
                      ],
                    }],
                  })
                : JSON.stringify({
                    verdicts: [{
                      sentenceIndex: 0,
                      supported: true,
                      rationale: '来源共同蕴含该压缩表述',
                    }],
                  }),
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  });
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  const sources: ConsolidationSource[] = [
    {
      memoryId: 'memory-1',
      memoryVersionId: 'version-1',
      kind: 'preference',
      title: '编辑器',
      content: '用户使用 VS Code。',
      updatedAt: '2026-07-29T00:00:00.000Z',
    },
    {
      memoryId: 'memory-2',
      memoryVersionId: 'version-2',
      kind: 'preference',
      title: '演示数据',
      content: '用户拒绝演示数据。',
      updatedAt: '2026-07-29T00:00:00.000Z',
    },
  ];
  const result = await provider.consolidate(scope, sources);
  const verdicts = await provider.verifySupport(
    scope,
    sources,
    result.sentences,
  );

  assert.equal(requestBodies.length, 2);
  for (const requestBody of requestBodies) {
    assert.equal(requestBody.model, 'qwen2.5:14b');
    assert.equal(requestBody.stream, false);
    assert.equal(requestBody.think, false);
    assert.equal(requestBody.keep_alive, '15m');
    assert.ok(requestBody.format);
  }
  const generationFormat = requestBodies[0].format as {
    properties?: {
      sentences?: { maxItems?: number };
    };
  };
  assert.equal(
    generationFormat.properties?.sentences?.maxItems,
    1,
  );
  const generationMessages = requestBodies[0].messages as Array<{
    role: string;
    content: string;
  }>;
  const generationInput = JSON.parse(
    generationMessages.find((message) => message.role === 'user')!
      .content,
  ) as {
    compressionPolicy?: {
      maxSentences?: number;
      minimumReduction?: number;
    };
  };
  assert.equal(generationInput.compressionPolicy?.maxSentences, 1);
  assert.equal(
    generationInput.compressionPolicy?.minimumReduction,
    0.6,
  );
  assert.equal(result.sentences.length, 1);
  assert.equal(result.sentences[0].text, '用户有两项稳定偏好。');
  assert.equal(verdicts[0]?.supported, true);
});

test('14B 巩固 coverage 失败携带输出指纹和缺失来源而不记录原文', async () => {
  let providerCalls = 0;
  const provider = new OllamaConsolidationProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v7',
    timeoutMs: 5_000,
    fetchImpl: async () => {
      providerCalls += 1;
      return (
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              sentences: [{
                text: '用户喜欢深色主题。',
                sourceVersionIds: ['theme-version'],
              }],
            }),
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
      );
    },
  });
  await assert.rejects(
    () => provider.consolidate(
      {
        userId: 'default',
        namespace: 'personal',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
      },
      [
        {
          memoryId: 'theme-memory',
          memoryVersionId: 'theme-version',
          kind: 'preference',
          title: '主题',
          content: '用户喜欢深色主题。',
          updatedAt: '2026-08-10T00:00:00.000Z',
          predicateKey: '用户::界面主题',
          negated: false,
          occurredAt: null,
          validFrom: null,
          validTo: null,
        },
        {
          memoryId: 'food-memory',
          memoryVersionId: 'food-version',
          kind: 'preference',
          title: '饮食',
          content: '用户不吃香菜。',
          updatedAt: '2026-08-10T00:00:00.000Z',
          predicateKey: '用户::饮食禁忌',
          negated: true,
          occurredAt: null,
          validFrom: null,
          validTo: null,
        },
      ],
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConsolidationProviderOutputError);
      assert.match(error.outputFingerprint, /^[a-f0-9]{64}$/u);
      assert.deepEqual(error.missingSourceIds, ['food-version']);
      assert.ok(error.modelDurationMs >= 0);
      assert.doesNotMatch(error.message, /不吃香菜/u);
      return true;
    },
  );
  assert.equal(providerCalls, 2);
});

test('14B 巩固 coverage 只携带缺失来源进行一次定向修复', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const provider = new OllamaConsolidationProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-coverage-repair-v1',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      const content = requestBodies.length === 1
        ? {
            sentences: [{
              text: '用户喜欢深色主题。',
              sourceVersionIds: ['theme-version'],
            }],
          }
        : {
            sentences: [{
              text: '用户喜欢深色主题，并且不吃香菜。',
              sourceVersionIds: ['theme-version', 'food-version'],
            }],
          };
      return new Response(
        JSON.stringify({
          message: { content: JSON.stringify(content) },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
  });
  const sources: ConsolidationSource[] = [
    {
      memoryId: 'theme-memory',
      memoryVersionId: 'theme-version',
      kind: 'preference',
      title: '主题',
      content: '用户喜欢深色主题。',
      updatedAt: '2026-08-10T00:00:00.000Z',
      predicateKey: '用户::界面主题',
      negated: false,
      occurredAt: null,
      validFrom: null,
      validTo: null,
    },
    {
      memoryId: 'food-memory',
      memoryVersionId: 'food-version',
      kind: 'preference',
      title: '饮食',
      content: '用户不吃香菜。',
      updatedAt: '2026-08-10T00:00:00.000Z',
      predicateKey: '用户::饮食禁忌',
      negated: true,
      occurredAt: null,
      validFrom: null,
      validTo: null,
    },
  ];

  const result = await provider.consolidate(
    {
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    },
    sources,
  );

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(
    result.sentences[0]?.sourceVersionIds,
    ['food-version', 'theme-version'],
  );
  const repairMessages = requestBodies[1].messages as Array<{
    role: string;
    content: string;
  }>;
  const repairInput = JSON.parse(
    repairMessages.find((message) => message.role === 'user')!.content,
  ) as {
    missingSources?: Array<{
      memoryVersionId?: string;
      content?: string;
    }>;
    sources?: unknown;
  };
  assert.deepEqual(repairInput.missingSources, [{
    memoryVersionId: 'food-version',
    kind: 'preference',
    title: '饮食',
    content: '用户不吃香菜。',
  }]);
  assert.equal(repairInput.sources, undefined);
});

test('coverage 补偿失败时保留原子来源并以 no-op 完成', async () => {
  let providerCalls = 0;
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'coverage-noop-v1',
    async consolidate(_scope, sources) {
      providerCalls += 1;
      throw new ConsolidationProviderOutputError(
        'Ollama 记忆巩固未覆盖全部来源：1 条',
        '{"sentences":[]}',
        12.5,
        [sources[1].memoryVersionId],
      );
    },
    async verifySupport() {
      throw new Error('coverage no-op 不应进入支持核验');
    },
  };
  const fixture = createFixture(provider, { minimumSources: 2 });
  try {
    rememberSources(fixture.memoryStore);
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
      accessScopeType: 'personal',
      accessScopeKey: 'self',
    });
    assert.equal(result.status, 'completed_noop');
    assert.equal(
      result.noopReason,
      'coverage_repair_preserved_atomic_sources',
    );
    assert.equal(result.sourceCount, 2);
    assert.equal(providerCalls, 1);
    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM derived_consolidations',
      ).get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('14B 核验返回无效 JSON 时摘要安全隔离', async () => {
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v1',
    async consolidate(_scope, sources) {
      return {
        sentences: [{
          text: '用户使用 VS Code。',
          sourceVersionIds: [sources[0].memoryVersionId],
        }],
      };
    },
    async verifySupport() {
      throw new Error('Ollama 摘要证据核验返回的 JSON 无法解析');
    },
  };
  const fixture = createFixture(provider);
  try {
    rememberSources(fixture.memoryStore);
    const result = await fixture.consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });
    assert.equal(result.status, 'quarantined');
    assert.equal(result.unsupportedSentenceCount, 1);
    assert.equal(result.memoryId, null);
    assert.equal(fixture.memoryStore.list().total, 2);
  } finally {
    fixture.close();
  }
});

test('14B 巩固器补齐明确支持分句的遗漏来源引用', async () => {
  const provider = new OllamaConsolidationProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v6',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              sentences: [{
                text: '回复应简洁，默认使用简体中文。',
                sourceVersionIds: ['concise-version'],
              }],
            }),
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });
  const result = await provider.consolidate(
    {
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    },
    [
      {
        memoryId: 'concise-memory',
        memoryVersionId: 'concise-version',
        kind: 'preference',
        title: '简洁',
        content: '回复应简洁。',
        updatedAt: '2026-07-29T00:00:00.000Z',
      },
      {
        memoryId: 'language-memory',
        memoryVersionId: 'language-version',
        kind: 'preference',
        title: '语言',
        content: '默认使用简体中文。',
        updatedAt: '2026-07-29T00:00:00.000Z',
      },
    ],
  );
  assert.deepEqual(
    result.sentences[0].sourceVersionIds,
    ['concise-version', 'language-version'],
  );
});

test('确定性逐分句证据校验修正 14B 的保守漏判和宽松误判', async () => {
  const provider = new OllamaConsolidationProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-v6',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              verdicts: [
                {
                  sentenceIndex: 0,
                  supported: false,
                  rationale: '模拟 14B 漏读第二个来源分句',
                },
                {
                  sentenceIndex: 1,
                  supported: true,
                  rationale: '模拟 14B 仅凭共享主题放行',
                },
                {
                  sentenceIndex: 2,
                  supported: true,
                  rationale: '模拟 14B 忽略国内与国外的范围冲突',
                },
                {
                  sentenceIndex: 3,
                  supported: false,
                  rationale: '模拟 14B 未识别简洁和不冗长的等价表达',
                },
              ],
            }),
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });
  const scope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'topic' as const,
    scopeKey: 'kind:preference',
  };
  const sources: ConsolidationSource[] = [
    {
      memoryId: 'travel-memory',
      memoryVersionId: 'travel-version',
      kind: 'preference',
      title: '差旅',
      content:
        '安排国内差旅时应先查看高铁方案，' +
        '用户通常不首选航班。',
      updatedAt: '2026-07-29T00:00:00.000Z',
    },
    {
      memoryId: 'style-memory',
      memoryVersionId: 'style-version',
      kind: 'preference',
      title: '回答风格',
      content:
        '回复用户时应结论优先，不要写冗长铺垫，' +
        '并保持简洁。',
      updatedAt: '2026-07-29T00:00:00.000Z',
    },
  ];
  const verdicts = await provider.verifySupport(
    scope,
    sources,
    [
      {
        text:
          '用户在国内出差时优先选择高铁，' +
          '商务出行时通常不首选航班。',
        sourceVersionIds: ['travel-version'],
      },
      {
        text: '默认使用简体中文。',
        sourceVersionIds: ['style-version'],
      },
      {
        text: '用户在国外出差时优先选择高铁。',
        sourceVersionIds: ['travel-version'],
      },
      {
        text: '回答应简洁明了。',
        sourceVersionIds: ['style-version'],
      },
    ],
  );
  assert.equal(verdicts[0].supported, true);
  assert.match(verdicts[0].rationale, /deterministic=strong/u);
  assert.equal(verdicts[1].supported, false);
  assert.match(verdicts[1].rationale, /deterministic=none/u);
  assert.equal(verdicts[2].supported, false);
  assert.match(verdicts[2].rationale, /deterministic=none/u);
  assert.equal(verdicts[3].supported, true);
  assert.match(verdicts[3].rationale, /deterministic=strong/u);
});
