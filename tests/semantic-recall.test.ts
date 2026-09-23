import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { EpisodicMemoryService } from
  '../src/server/episodic-memory-service.js';
import {
  DENSE_EVALUATION_DATASET_SHA256,
} from '../src/server/dense-evaluation-contract.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';
import type {
  SemanticCandidate,
  SemanticDecision,
  SemanticRanker,
} from '../src/server/semantic-ranker.js';

class FakeSemanticRanker implements SemanticRanker {
  readonly embeddingModel = 'fake-embedding-v1';
  readonly rerankModel = 'fake-reranker-v1';
  readonly embedCalls: string[][] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls.push([...texts]);
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }

  async rerank(
    _query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    return candidates.map((candidate) => {
      const relevant = candidate.memory.includes('优先乘坐高铁');
      return {
        id: candidate.id,
        relevant,
        confidence: relevant ? 0.98 : 0.99,
        reason: relevant
          ? '出行首选可以直接回答问题'
          : '同为交通主题但不是用户偏好',
      };
    });
  }
}

class ControlledDenseRanker implements SemanticRanker {
  readonly rerankModel = 'controlled-reranker-v1';
  readonly embedCalls: string[][] = [];

  constructor(
    readonly embeddingModel: string,
    public dimensions = 64,
    public generation = 1,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls.push([...texts]);
    return texts.map((text) => {
      const isTarget =
        text.includes('最让我舒服') ||
        text.includes('安静且低照度');
      return Float32Array.from(
        { length: this.dimensions },
        () => (isTarget ? 1 : -1) * this.generation,
      );
    });
  }

  async rerank(
    _query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    return candidates.map((candidate) => {
      const relevant = candidate.memory.includes('安静且低照度');
      return {
        id: candidate.id,
        relevant,
        confidence: relevant ? 0.99 : 0.1,
        reason: relevant ? '语义一致' : '无关填充项',
      };
    });
  }
}

class DiversityRanker implements SemanticRanker {
  readonly embeddingModel = 'diversity-embedding-v1';
  readonly rerankModel = 'diversity-reranker-v1';

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }

  async rerank(
    _query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    return candidates.map((candidate) => ({
      id: candidate.id,
      relevant: true,
      confidence: candidate.memory.includes('完整交付报告')
        ? 0.99
        : 0.97,
      reason: '同属用户明确的项目交付偏好',
    }));
  }
}

class LayeredScopeRanker implements SemanticRanker {
  readonly embeddingModel = 'layered-scope-embedding-v1';
  readonly rerankModel = 'layered-scope-reranker-v1';
  readonly embedCalls: string[][] = [];
  rerankCalls = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls.push([...texts]);
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }

  async rerank(
    _query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    this.rerankCalls += 1;
    return candidates.map((candidate) => ({
      id: candidate.id,
      relevant: true,
      confidence: 0.99,
      reason: '分层作用域语义一致',
    }));
  }
}

class IdentifierRanker implements SemanticRanker {
  readonly embeddingModel = 'identifier-embedding-v1';
  readonly rerankModel = 'identifier-reranker-v1';
  rerankCalls = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }

  async rerank(
    _query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    this.rerankCalls += 1;
    return candidates.map((candidate) => ({
      id: candidate.id,
      relevant: true,
      confidence: 0.99,
      reason: '模型重排',
    }));
  }
}

class CanonicalAdversarialRanker implements SemanticRanker {
  readonly embeddingModel = 'canonical-adversarial-embedding-v1';
  readonly rerankModel = 'canonical-adversarial-reranker-v1';
  rerankCalls = 0;

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }

  async rerank(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    this.rerankCalls += 1;
    return candidates.map((candidate) => {
      const relevant = query.includes('不再用 Zed')
        ? candidate.memory.includes('不再用 Zed')
        : candidate.memory.includes('我常用 Zed');
      return {
        id: candidate.id,
        relevant,
        confidence: relevant ? 0.99 : 0.95,
        reason: relevant ? '对抗模型选择 episode' : '对抗模型拒绝',
      };
    });
  }
}

class TimelineRanker implements SemanticRanker {
  readonly embeddingModel = 'timeline-embedding-v1';
  readonly rerankModel = 'timeline-reranker-v1';

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }

  async rerank(
    _query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    return candidates.map((candidate) => ({
      id: candidate.id,
      relevant: true,
      confidence: 1,
      reason: '时间线候选与问题匹配',
    }));
  }
}

class TopKTelemetryRanker extends TimelineRanker {
  readonly rerankModel = 'topk-telemetry-reranker-v1';
  maximumCandidates = 0;

  async rerankWithTelemetry(
    query: string,
    candidates: SemanticCandidate[],
  ) {
    this.maximumCandidates = Math.max(
      this.maximumCandidates,
      candidates.length,
    );
    return {
      result: await this.rerank(query, candidates),
      telemetry: {
        route: 'model' as const,
        providerCalls: 1,
        cacheHit: false,
        singleFlightShared: false,
        keyFingerprint: 'a'.repeat(64),
        requestDurationMs: 1,
        providerDurationMs: 1,
        model: null,
      },
    };
  }
}

function createStore(ranker: SemanticRanker) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-semantic-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  return {
    database,
    store: new MemoryStore(database, ranker),
    close: () => {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function materializeEpisode(
  fixture: ReturnType<typeof createStore>,
  key: string,
  content: string,
  occurredAt: string,
) {
  const current = new Date(occurredAt);
  const lifecycle = new LifecycleStore(fixture.database, () => current);
  const exchange = lifecycle.recordCompletedExchange({
    clientName: 'semantic-recall-episode-test',
    sessionExternalId: `episode-session-${key}`,
    userTurnExternalId: `episode-user-${key}`,
    userContent: content,
    assistantTurnExternalId: `episode-assistant-${key}`,
    assistantContent: '已记录这次对话。',
    occurredAt,
  });
  const episode = new EpisodicMemoryService(
    fixture.database,
    () => new Date(current.getTime() + 1_000),
  ).materialize({
    userId: 'default',
    namespace: 'personal',
    userTurnId: exchange.userTurn.id,
    assistantTurnId: exchange.assistantTurn.id,
  });
  return fixture.store.get(episode.memoryId)!;
}

function recordDenseEvaluation(
  store: MemoryStore,
  generationId: string,
  evaluationId: string,
  passed = true,
): void {
  const generation = store.denseIndexGeneration(generationId)!;
  const hitCount = passed ? 20 : 18;
  const cases = Array.from({ length: 20 }, (_, index) => ({
    caseId: `case-${index}`,
    expectedMemoryId: `expected-${index}`,
    retrievedMemoryIds:
      index < hitCount ? [`expected-${index}`] : [],
    rank: index < hitCount ? 1 : null,
    hitAt20: index < hitCount,
    reciprocalRank: index < hitCount ? 1 : 0,
  }));
  store.recordDenseIndexEvaluation({
    evaluationId,
    generationId,
    modelId: generation.modelId,
    embeddingModel: generation.embeddingModel,
    generationKey: generation.generationKey,
    dimensions: generation.dimensions,
    datasetId: 'memory-bridge-recall-gate-v1',
    datasetSha256: DENSE_EVALUATION_DATASET_SHA256,
    evaluatorVersion: 'dense-evaluator-v1',
    queryCount: cases.length,
    recallAt20: hitCount / cases.length,
    mrrAt10: hitCount / cases.length,
    passed,
    startedAt: '2026-07-29T00:00:00.000Z',
    completedAt: '2026-07-29T00:01:00.000Z',
    cases,
  });
}

test('可靠召回以语义候选加严格重排过滤同主题误命中', async () => {
  const ranker = new FakeSemanticRanker();
  const fixture = createStore(ranker);
  try {
    const relevant = fixture.store.remember({
      kind: 'preference',
      content: '用户出差时优先乘坐高铁。',
    }).memory;
    fixture.store.remember({
      kind: 'knowledge',
      content: '公司交通补贴政策已经更新。',
      importance: 1,
      confidence: 1,
    });

    const recalled = await fixture.store.recallReliable({
      query: '出行交通方式首选什么？',
    });
    assert.deepEqual(
      recalled.map((result) => result.memory.id),
      [relevant.id],
    );
    assert.match(recalled[0].reasons.join(' '), /严格重排/);
    const recallAudit = fixture.store.audits(1)[0];
    assert.match(
      String(recallAudit.detail.generationId),
      /^dense-generation:/,
    );
    assert.deepEqual(recallAudit.detail.filterSummary, [
      {
        reasonCode: 'rerank_rejected_or_low_confidence',
        reason: '严格重排判定无关或置信不足',
        count: 1,
      },
    ]);

    const cached = fixture.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM memory_embeddings
         WHERE model = ?`,
      )
      .get(ranker.embeddingModel);
    assert.equal(Number(cached?.count), 2);

    await fixture.store.recallReliable({
      query: '出行交通方式首选什么？',
    });
    assert.equal(ranker.embedCalls.at(-1)?.length, 2);
  } finally {
    fixture.close();
  }
});

test('高熵唯一标识符精确命中时走确定性快路且不调用生成式重排', async () => {
  const ranker = new IdentifierRanker();
  const fixture = createStore(ranker);
  try {
    const target = fixture.store.remember({
      kind: 'knowledge',
      content: '唯一交付标识 CASE-7391-ALPHA 对应蓝色方案。',
    }).memory;
    for (let index = 0; index < 10; index += 1) {
      fixture.store.remember({
        kind: 'knowledge',
        content: `其他交付记录 CASE-${8000 + index}-BETA 对应灰色方案。`,
      });
    }

    const recalled = await fixture.store.recallReliable({
      query: '请查找唯一标识 CASE-7391-ALPHA',
      limit: 5,
    });
    assert.deepEqual(recalled.map((result) => result.memory.id), [target.id]);
    assert.equal(ranker.rerankCalls, 0);
    assert.match(recalled[0].reasons.join(' '), /确定性标识/u);
  } finally {
    fixture.close();
  }
});

test('当前编辑器以规范原子值为 top1 且旧肯定 episode 不复活', async () => {
  const ranker = new CanonicalAdversarialRanker();
  const fixture = createStore(ranker);
  try {
    const canonical = fixture.store.remember({
      kind: 'preference',
      content: 'atomic-memory-v1:' + JSON.stringify({
        subject: '用户',
        predicate: '常用编辑器',
        value: 'Visual Studio Code',
        negated: false,
      }),
      stableKey: 'personal::self::user-editor',
      predicateKey: '用户::常用编辑器',
      normalizedValue: 'Visual Studio Code',
      normalizedValueHash: 'editor-vscode',
      predicateCardinality: 'single',
      confidence: 0.99,
      sourceAuthority: 'direct_user',
    }).memory;
    const stalePositive = materializeEpisode(
      fixture,
      'old-editor',
      '我常用 Zed 写代码。',
      '2026-01-10T08:00:00.000Z',
    );
    const correction = materializeEpisode(
      fixture,
      'editor-correction',
      '我现在不再用 Zed，改用 Visual Studio Code。',
      '2026-02-10T08:00:00.000Z',
    );
    await fixture.store.backfillDenseIndex();

    const current = await fixture.store.recallReliable({
      query: '我现在常用哪个编辑器？',
      limit: 5,
    });
    assert.deepEqual(
      current.map((result) => result.memory.id),
      [canonical.id],
    );
    assert.ok(!current.some((result) => result.memory.id === stalePositive.id));
    assert.ok(!current.some((result) => result.memory.id === correction.id));
    assert.equal(ranker.rerankCalls, 0);

    const history = await fixture.store.recallReliable({
      query: '我什么时候明确说过不再用 Zed？',
      limit: 5,
    });
    assert.ok(
      history.some((result) => result.memory.id === correction.id),
      JSON.stringify({
        history: history.map((result) => result.memory.id),
        audits: fixture.store.audits(2),
      }),
    );
    assert.ok(!history.some((result) => result.memory.id === stalePositive.id));
    assert.equal(ranker.rerankCalls, 1);
  } finally {
    fixture.close();
  }
});

test('前后两次事件均保留并按 occurredAt 正序返回', async () => {
  const fixture = createStore(new TimelineRanker());
  try {
    const oldEvent = materializeEpisode(
      fixture,
      'old-bookstore',
      '今天午休我去了云杉书店，翻了几本旅行地图。',
      '2026-01-20T08:00:00.000Z',
    );
    const newEvent = materializeEpisode(
      fixture,
      'new-bookstore',
      '今天午休我又去了南桥书店，看了摄影画册。',
      '2026-02-09T08:00:00.000Z',
    );
    await fixture.store.backfillDenseIndex();

    const recalled = await fixture.store.recallReliable({
      query: '我前后两次午休去过哪两家书店？',
      limit: 5,
    });

    assert.deepEqual(
      recalled.map((result) => result.memory.id),
      [oldEvent.id, newEvent.id],
      JSON.stringify({ audits: fixture.store.audits(1) }),
    );
  } finally {
    fixture.close();
  }
});

test('已冷却 episode 召回只使用临时向量且不重建持久热索引', async () => {
  const fixture = createStore(new TimelineRanker());
  try {
    const lifecycle = new LifecycleStore(
      fixture.database,
      () => new Date('2026-01-20T08:00:00.000Z'),
    );
    const exchange = lifecycle.recordCompletedExchange({
      clientName: 'compacted-recall-test',
      sessionExternalId: 'compacted-recall-session',
      userTurnExternalId: 'compacted-recall-user',
      userContent: '旧情景中的精确检索暗号是青黛纸鸢。',
      assistantTurnExternalId: 'compacted-recall-assistant',
      assistantContent: '已记录这个暗号。',
      occurredAt: '2026-01-20T08:00:00.000Z',
    });
    const episode = new EpisodicMemoryService(
      fixture.database,
      () => new Date('2026-01-20T08:00:01.000Z'),
    ).materialize({
      userId: 'default',
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });
    await fixture.store.backfillDenseIndex();
    const rowCount = (table: string) => Number(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE memory_id = ?`,
      ).get(episode.memoryId)?.count || 0,
    );
    const before = {
      embedding: rowCount('memory_embeddings'),
      dense: rowCount('memory_dense_lsh'),
      ann: rowCount('memory_ann_index'),
      term: rowCount('memory_term_index'),
    };
    fixture.database.prepare(
      `INSERT INTO conversation_episode_compactions (
         episode_id, memory_id, summary_id, user_id, namespace,
         compacted_at, last_verified_at, removed_embedding_rows,
         removed_dense_rows, removed_ann_rows, removed_term_rows
       ) VALUES (?, ?, NULL, 'default', 'personal', ?, ?, ?, ?, ?, ?)`,
    ).run(
      episode.episodeId,
      episode.memoryId,
      '2026-03-20T08:00:00.000Z',
      '2026-03-20T08:00:00.000Z',
      before.embedding,
      before.dense,
      before.ann,
      before.term,
    );
    for (const table of [
      'memory_embeddings',
      'memory_dense_lsh',
      'memory_ann_index',
      'memory_term_index',
    ]) {
      fixture.database.prepare(
        `DELETE FROM ${table} WHERE memory_id = ?`,
      ).run(episode.memoryId);
      assert.equal(rowCount(table), 0, table);
    }

    const recalled = await fixture.store.recallReliable({
      query: '青黛纸鸢',
      limit: 3,
    });

    assert.equal(recalled[0]?.memory.id, episode.memoryId);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM conversation_episode_compactions
         WHERE memory_id = ?`,
      ).get(episode.memoryId)?.count),
      1,
    );
    for (const table of [
      'memory_embeddings',
      'memory_dense_lsh',
      'memory_ann_index',
      'memory_term_index',
    ]) {
      assert.equal(rowCount(table), 0, table);
    }
  } finally {
    fixture.close();
  }
});

test('可靠检索对普通未决候选最多只提交前十六条重排', async () => {
  const ranker = new TopKTelemetryRanker();
  const fixture = createStore(ranker);
  try {
    for (let index = 0; index < 64; index += 1) {
      fixture.store.remember({
        kind: 'knowledge',
        content: `供应链风险备忘录 ${index}：普通候选记录。`,
      });
    }
    await fixture.store.backfillDenseIndex(128);

    await fixture.store.recallReliable({
      query: '供应链风险备忘录有哪些？',
      limit: 5,
    });

    const audit = fixture.store.audits(1)[0];
    assert.ok(Number(audit.detail.candidateCount) > 16);
    assert.equal(ranker.maximumCandidates, 16);
  } finally {
    fixture.close();
  }
});

test('可靠 Dense 召回一次融合多作用域并在重排后执行谓词遮蔽', async () => {
  const ranker = new LayeredScopeRanker();
  const fixture = createStore(ranker);
  try {
    const rememberLayer = (
      scopeType: 'personal' | 'role' | 'session',
      scopeKey: string,
      answer: string,
    ) => fixture.store.remember({
      kind: 'preference',
      content: `可靠分层召回验证：当前称呼答案是${answer}。`,
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
      kind: 'preference',
      content:
        '可靠分层召回验证：当前称呼对话中的输出风格答案是简洁。',
      scopeType: 'personal',
      scopeKey: 'self',
      stableKey: 'personal::self::用户::输出风格',
      predicateKey: '用户::输出风格',
      normalizedValue: '简洁',
      normalizedValueHash: 'personal-self-reliable-concise',
    }).memory;

    const recalled = await fixture.store.recallReliable({
      query: '可靠分层召回验证 当前称呼 输出风格',
      scopes: [
        { scopeType: 'session', scopeKey: 'persona-a:session-1' },
        { scopeType: 'role', scopeKey: 'persona-a' },
        { scopeType: 'personal', scopeKey: 'self' },
      ],
      limit: 10,
    });
    const ids = recalled.map((result) => result.memory.id).sort();

    assert.deepEqual(ids, [session.id, differentPredicate.id].sort());
    assert.ok(!ids.includes(personal.id));
    assert.ok(!ids.includes(role.id));
    assert.ok(!ids.includes(unauthorized.id));
    assert.equal(ranker.rerankCalls, 1);
    assert.equal(ranker.embedCalls[0]?.length, 2);
    const audit = fixture.store.audits(1)[0];
    assert.equal(audit.detail.candidateCount, 4);
    assert.equal(audit.detail.denseEligible, 4);
    assert.deepEqual(
      (
        audit.detail.filterSummary as Array<{
          reasonCode: string;
          reason: string;
          count: number;
        }>
      ).find(
        (entry) => entry.reason === '被更高优先级作用域遮蔽',
      ),
      {
        reasonCode: 'scope_precedence',
        reason: '被更高优先级作用域遮蔽',
        count: 2,
      },
    );
    assert.equal(fixture.store.get(session.id)?.accessCount, 1);
    assert.equal(fixture.store.get(differentPredicate.id)?.accessCount, 1);
    assert.equal(fixture.store.get(personal.id)?.accessCount, 0);
    assert.equal(fixture.store.get(role.id)?.accessCount, 0);
    assert.equal(fixture.store.get(unauthorized.id)?.accessCount, 0);
  } finally {
    fixture.close();
  }
});

test('可靠召回用 MMR 防止近重复事实挤掉相关的另一主题', async () => {
  const fixture = createStore(new DiversityRanker());
  try {
    const firstReport = fixture.store.remember({
      kind: 'preference',
      content: '用户的项目交付偏好是上线前生成完整交付报告。',
      stableKey: 'delivery-report-primary',
    }).memory;
    const paraphrasedReport = fixture.store.remember({
      kind: 'preference',
      content:
        '用户的项目交付偏好要求每次上线之前都生成完整交付报告。',
      stableKey: 'delivery-report-paraphrase',
    }).memory;
    const theme = fixture.store.remember({
      kind: 'preference',
      content:
        '用户的项目交付偏好还包括客户界面默认使用深色主题。',
      stableKey: 'delivery-interface-theme',
    }).memory;

    const recalled = await fixture.store.recallReliable({
      query: '我的项目交付偏好包括报告和界面上的哪些要求？',
      limit: 2,
    });
    assert.equal(recalled.length, 2);
    assert.ok(
      recalled.some((result) =>
        [firstReport.id, paraphrasedReport.id].includes(result.memory.id)
      ),
    );
    assert.ok(
      recalled.some((result) => result.memory.id === theme.id),
    );
    assert.ok(
      recalled.some(
        (result) => result.explanation.diversityPenalty > 0,
      ),
    );
    for (const result of recalled) {
      assert.ok(result.explanation.lexicalRank !== null);
      assert.equal(result.explanation.rerankConfidence !== null, true);
      assert.equal(result.explanation.importance, result.memory.importance);
      assert.equal(
        result.explanation.memoryConfidence,
        result.memory.confidence,
      );
      assert.equal(result.explanation.conflictState, 'none');
    }

    const resultDetails = fixture.store.audits(1)[0]?.detail
      .resultDetails as Array<Record<string, unknown>>;
    assert.equal(resultDetails.length, 2);
    assert.ok(
      resultDetails.every(
        (detail) =>
          detail.explanation &&
          typeof detail.explanation === 'object',
      ),
    );
  } finally {
    fixture.close();
  }
});

test('可靠召回仅在查询有时间意图时优先近期发生的同主题记忆', async () => {
  const fixture = createStore(new DiversityRanker());
  try {
    const recent = fixture.store.remember({
      kind: 'preference',
      content: '用户常去松林健身房锻炼。',
      occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      importance: 0.6,
      confidence: 0.6,
      stableKey: 'gym-recent',
    }).memory;
    const older = fixture.store.remember({
      kind: 'preference',
      content: '用户常去江畔健身房锻炼。',
      occurredAt: new Date(Date.now() - 240 * 86_400_000).toISOString(),
      importance: 1,
      confidence: 1,
      stableKey: 'gym-older',
    }).memory;

    const timeless = await fixture.store.recallReliable({
      query: '我常去的健身房是哪家？',
      limit: 1,
    });
    assert.deepEqual(
      timeless.map((result) => result.memory.id),
      [older.id],
    );

    const temporal = await fixture.store.recallReliable({
      query: '最近我常去的健身房是哪家？',
      limit: 1,
    });
    assert.deepEqual(
      temporal.map((result) => result.memory.id),
      [recent.id],
    );
    assert.match(temporal[0].reasons.join(' '), /时间意图.*最近/u);
  } finally {
    fixture.close();
  }
});

test('可靠召回对上周等明确时间范围进行软匹配并记录 trace', async () => {
  const fixture = createStore(new DiversityRanker());
  try {
    const lastWeek = fixture.store.remember({
      kind: 'preference',
      content: '用户常去梧桐书店看书。',
      occurredAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      importance: 0.6,
      confidence: 0.6,
      stableKey: 'bookstore-last-week',
    }).memory;
    fixture.store.remember({
      kind: 'preference',
      content: '用户常去河岸书店看书。',
      occurredAt: new Date(Date.now() - 80 * 86_400_000).toISOString(),
      importance: 1,
      confidence: 1,
      stableKey: 'bookstore-distant',
    });

    const recalled = await fixture.store.recallReliable({
      query: '上周我常去的书店是哪家？',
      limit: 1,
    });
    assert.deepEqual(
      recalled.map((result) => result.memory.id),
      [lastWeek.id],
    );
    assert.match(recalled[0].reasons.join(' '), /时间意图“上周”/u);
    const trace = fixture.store.getRetrievalTrace(recalled[0].traceId!)!;
    const semantic = trace.events.find(
      (event) => event.stage === 'semantic',
    )!;
    assert.deepEqual(
      (semantic.detail.temporalIntent as { kind: string }).kind,
      'last_week',
    );
  } finally {
    fixture.close();
  }
});

test('可靠召回在本地语义服务失败时明确报错且不静默降级', async () => {
  const failing: SemanticRanker = {
    embeddingModel: 'offline-embedding',
    rerankModel: 'offline-reranker',
    async embed() {
      throw new Error('connection refused');
    },
    async rerank() {
      return [];
    },
  };
  const fixture = createStore(failing);
  try {
    fixture.store.remember({
      kind: 'preference',
      content: '用户喜欢无糖拿铁。',
    });
    await assert.rejects(
      fixture.store.recallReliable({
        query: '咖啡是否加糖？',
      }),
      /可靠语义召回不可用，已拒绝降级.*connection refused/,
    );
    const context = await fixture.store.getContextReliable({
      query: '咖啡是否加糖？',
    });
    assert.equal(context.qualityState, 'unavailable');
    assert.equal(context.memories.length, 0);
    assert.match(context.context, /未注入记忆/);
    assert.equal(
      fixture.store.audits(1)[0]?.detail.qualityState,
      'unavailable',
    );
    assert.deepEqual(
      fixture.store.audits(1)[0]?.detail.filterSummary,
      [{
        reasonCode: 'semantic_pipeline_unavailable',
        reason: '语义流水线不可用',
        count: 1,
      }],
    );
    const traces = fixture.store.listRetrievalTraces({ limit: 10 });
    assert.equal(traces.length, 2);
    for (const summary of traces) {
      const trace = fixture.store.getRetrievalTrace(summary.traceId)!;
      assert.deepEqual(
        trace.events.map((event) => event.stage),
        [
          'request', 'rewrite', 'channels', 'fusion', 'semantic',
          'rerank', 'selection', 'context', 'result',
        ],
      );
      assert.equal(trace.qualityState, 'unavailable');
      assert.ok(trace.errorCode);
      assert.doesNotMatch(JSON.stringify(trace), /connection refused/u);
      assert.match(JSON.stringify(trace), /errorHash/u);
      assert.ok(
        trace.events.every(
          (event) =>
            Number.isFinite(Number(event.detail.durationMs)) &&
            Number(event.detail.durationMs) >= 0,
        ),
      );
      const failed = trace.events.find(
        (event) => event.detail.reason === 'stage_failed',
      );
      assert.ok(failed);
      assert.equal(failed.detail.failedStage, 'rewrite');
    }
  } finally {
    fixture.close();
  }
});

test('语义向量跨数据库进程重启持久化复用', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-semantic-restart-'),
  );
  const filePath = path.join(directory, 'test.sqlite3');
  try {
    const firstRanker = new FakeSemanticRanker();
    const firstDatabase = openDatabase(filePath);
    const firstStore = new MemoryStore(firstDatabase, firstRanker);
    firstStore.remember({
      kind: 'preference',
      content: '用户出差时优先乘坐高铁。',
    });
    assert.equal(
      (await firstStore.recallReliable({
        query: '出行方式首选什么？',
      })).length,
      1,
    );
    firstDatabase.close();

    const restartedRanker = new FakeSemanticRanker();
    const restartedDatabase = openDatabase(filePath);
    const restartedStore = new MemoryStore(
      restartedDatabase,
      restartedRanker,
    );
    assert.equal(
      (await restartedStore.recallReliable({
        query: '出行方式首选什么？',
      })).length,
      1,
    );
    assert.equal(restartedRanker.embedCalls[0]?.length, 2);
    assert.ok(
      restartedRanker.embedCalls.flat().every(
        (text) => !text.includes('用户出差时优先乘坐高铁'),
      ),
      '重启后只应生成查询及查询变体向量，不应重算记忆向量',
    );
    restartedDatabase.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Dense ANN 在无词面重叠时召回并按回填水位报告质量', async () => {
  const ranker = new ControlledDenseRanker('dense-model-v1');
  const fixture = createStore(ranker);
  try {
    const target = fixture.store.remember({
      kind: 'preference',
      content: '用户长期偏好安静且低照度的工作空间。',
    }).memory;
    fixture.store.remember({
      kind: 'knowledge',
      content: '仓库的发布流水线使用蓝绿部署。',
    });

    const before = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(before.memories.length, 0);
    assert.equal(before.qualityState, 'degraded');

    const backfill = await fixture.store.backfillDenseIndex();
    assert.equal(backfill.complete, true);
    assert.equal(backfill.eligible, 2);
    assert.equal(backfill.indexed, 2);

    const after = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(after.qualityState, 'full');
    assert.deepEqual(
      after.memories.map((result) => result.memory.id),
      [target.id],
    );
    assert.match(
      after.memories[0].reasons.join(' '),
      /Dense sign-LSH/,
    );

    const audit = fixture.store.audits(1)[0];
    assert.equal(audit.detail.qualityState, 'full');
    assert.equal(audit.detail.denseEligible, 2);
    assert.equal(audit.detail.denseIndexed, 2);
    assert.equal(audit.detail.indexVersion, 'dense-sign-lsh-v1');
    assert.equal(audit.detail.lexicalCandidateCount, 0);
    assert.equal(audit.detail.termCandidateCount, 0);
    assert.ok(Number(audit.detail.annCandidateCount) >= 1);

    const budgeted = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
      contextTokenBudget: 256,
    });
    assert.match(budgeted.context, new RegExp(target.id));
    assert.match(budgeted.context, /version_id:/);
    assert.match(budgeted.context, /来源摘要:/);
    assert.ok(
      [...budgeted.context].filter(
        (character) => !/\s/u.test(character),
      ).length <= 256,
    );
  } finally {
    fixture.close();
  }
});

test('Dense ANN 模型版本共存且更新时间使旧 bucket 立即失效', async () => {
  const firstRanker = new ControlledDenseRanker('dense-model-v1');
  const fixture = createStore(firstRanker);
  try {
    const target = fixture.store.remember({
      kind: 'preference',
      content: '用户长期偏好安静且低照度的工作空间。',
    }).memory;
    const firstGeneration =
      await fixture.store.backfillDenseIndex();

    const secondRanker =
      new ControlledDenseRanker('dense-model-v2');
    const secondStore = new MemoryStore(
      fixture.database,
      [secondRanker, firstRanker],
    );
    const secondGeneration =
      await secondStore.backfillDenseIndex();
    const models = fixture.database
      .prepare(
        `SELECT DISTINCT embedding_model
         FROM memory_dense_lsh
         WHERE memory_id = ?
         ORDER BY embedding_model`,
      )
      .all(target.id)
      .map((row) => String(row.embedding_model));
    assert.deepEqual(models, ['dense-model-v1', 'dense-model-v2']);
    const buildingAlias = secondStore.denseIndexAlias();
    assert.equal(
      buildingAlias?.activeGenerationId,
      firstGeneration.generationId,
    );
    assert.equal(
      buildingAlias?.buildingGenerationId,
      secondGeneration.generationId,
    );

    const firstCallsBefore = firstRanker.embedCalls.length;
    const secondCallsBefore = secondRanker.embedCalls.length;
    const beforeSwitch = await secondStore.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(beforeSwitch.qualityState, 'full');
    assert.equal(beforeSwitch.memories[0]?.memory.id, target.id);
    assert.ok(firstRanker.embedCalls.length > firstCallsBefore);
    assert.equal(secondRanker.embedCalls.length, secondCallsBefore);

    recordDenseEvaluation(
      secondStore,
      secondGeneration.generationId!,
      'failed-quality-gate',
      false,
    );
    await assert.rejects(
      secondStore.activateDenseIndexGeneration({
        generationId: secondGeneration.generationId!,
        expectedAliasRevision: buildingAlias!.revision,
        evaluationId: 'failed-quality-gate',
      }),
      /可信固定评测|质量门槛/,
    );
    assert.equal(
      secondStore.denseIndexAlias()?.activeGenerationId,
      firstGeneration.generationId,
    );
    recordDenseEvaluation(
      secondStore,
      secondGeneration.generationId!,
      'semantic-recall-fixed-set-v1',
    );
    const activated = await secondStore.activateDenseIndexGeneration({
      generationId: secondGeneration.generationId!,
      expectedAliasRevision: buildingAlias!.revision,
      evaluationId: 'semantic-recall-fixed-set-v1',
    });
    assert.equal(
      activated.activeGenerationId,
      secondGeneration.generationId,
    );
    assert.equal(
      activated.previousGenerationId,
      firstGeneration.generationId,
    );

    fixture.database
      .prepare(
        `UPDATE memories
         SET content = content || '并且远离噪声。',
             updated_at = '2099-01-01T00:00:00.000Z'
         WHERE id = ?`,
      )
      .run(target.id);
    const stale = await secondStore.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(stale.memories.length, 0);
    assert.equal(stale.qualityState, 'degraded');

    await secondStore.indexMemoryDense(
      target.id,
      target.userId,
      target.namespace,
      undefined,
      secondGeneration.generationId!,
    );
    const refreshed = await secondStore.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(refreshed.qualityState, 'full');
    assert.equal(refreshed.memories[0]?.memory.id, target.id);

    await secondStore.indexMemoryDense(
      target.id,
      target.userId,
      target.namespace,
      undefined,
      firstGeneration.generationId!,
    );
    const beforeRollback = secondStore.denseIndexAlias()!;
    const rolledBack =
      await secondStore.rollbackDenseIndexGeneration({
        expectedAliasRevision: beforeRollback.revision,
        reason: '测试质量回归回滚',
      });
    assert.equal(
      rolledBack.activeGenerationId,
      firstGeneration.generationId,
    );
    const recalledAfterRollback =
      await secondStore.getContextReliable({
        query: '什么场所最让我舒服？',
      });
    assert.equal(recalledAfterRollback.qualityState, 'full');
    assert.equal(
      recalledAfterRollback.memories[0]?.memory.id,
      target.id,
    );
  } finally {
    fixture.close();
  }
});

test('同毫秒正文更新会使旧 Dense 修订失效且不得误报 full', async () => {
  const ranker = new ControlledDenseRanker('same-ms-revision-v1');
  const fixture = createStore(ranker);
  try {
    const target = fixture.store.remember({
      kind: 'preference',
      content: '用户长期偏好安静且低照度的工作空间。',
    }).memory;
    await fixture.store.backfillDenseIndex();
    const before = fixture.database
      .prepare(
        `SELECT updated_at, semantic_revision
         FROM memories
         WHERE id = ?`,
      )
      .get(target.id);
    fixture.database
      .prepare(
        `UPDATE memories
         SET content = content || '并且不播放背景音乐。',
             updated_at = ?
         WHERE id = ?`,
      )
      .run(before?.updated_at, target.id);
    const after = fixture.database
      .prepare(
        `SELECT semantic_revision
         FROM memories
         WHERE id = ?`,
      )
      .get(target.id);
    assert.equal(
      Number(after?.semantic_revision),
      Number(before?.semantic_revision) + 1,
    );

    const stale = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(stale.memories.length, 0);
    assert.equal(stale.qualityState, 'degraded');

    const rebuilt = await fixture.store.indexMemoryDense(target.id);
    assert.equal(rebuilt.processed, 1);
    assert.equal(rebuilt.complete, true);
    const recalled = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(recalled.qualityState, 'full');
    assert.equal(recalled.memories[0]?.memory.id, target.id);
  } finally {
    fixture.close();
  }
});

test('较旧快照晚提交时不会覆盖已经索引的新修订', async () => {
  let releaseOld: (() => void) | null = null;
  let oldEmbeddingStarted: (() => void) | null = null;
  const oldStarted = new Promise<void>((resolve) => {
    oldEmbeddingStarted = resolve;
  });
  let holdOld = true;
  const ranker: SemanticRanker = {
    embeddingModel: 'revision-race-v1',
    rerankModel: 'revision-race-reranker-v1',
    async embed(texts) {
      if (
        holdOld &&
        texts.some((text) => text.includes('旧版工作空间偏好'))
      ) {
        oldEmbeddingStarted?.();
        await new Promise<void>((resolve) => {
          releaseOld = resolve;
        });
      }
      return texts.map(() =>
        Float32Array.from({ length: 64 }, () => 1),
      );
    },
    async rerank(_query, candidates) {
      return candidates.map((candidate) => ({
        id: candidate.id,
        relevant: true,
        confidence: 1,
        reason: '测试',
      }));
    },
  };
  const fixture = createStore(ranker);
  try {
    const memory = fixture.store.remember({
      kind: 'preference',
      content: '用户的旧版工作空间偏好是安静。',
    }).memory;
    const oldIndex = fixture.store.indexMemoryDense(memory.id);
    await oldStarted;

    fixture.store.update(memory.id, {
      content: '用户的新版工作空间偏好是安静且低照度。',
    });
    holdOld = false;
    const newIndex = await fixture.store.indexMemoryDense(memory.id);
    assert.equal(newIndex.processed, 1);
    releaseOld?.();
    const staleResult = await oldIndex;
    assert.equal(staleResult.processed, 0);

    const revisions = fixture.database
      .prepare(
        `SELECT DISTINCT d.memory_revision AS dense_revision,
                         m.semantic_revision AS current_revision
         FROM memory_dense_lsh d
         JOIN memories m ON m.id = d.memory_id
         WHERE d.memory_id = ?`,
      )
      .get(memory.id);
    assert.equal(
      revisions?.dense_revision,
      revisions?.current_revision,
    );
    assert.equal(fixture.store.denseIndexWatermark().complete, true);
  } finally {
    fixture.close();
  }
});

test('同名 embedding 模型维度变化会降级并强制重建索引', async () => {
  const ranker = new ControlledDenseRanker(
    'mutable-embedding:latest',
    64,
  );
  const fixture = createStore(ranker);
  try {
    const target = fixture.store.remember({
      kind: 'preference',
      content: '用户长期偏好安静且低照度的工作空间。',
    }).memory;
    const initial = await fixture.store.backfillDenseIndex();
    assert.equal(initial.dimensions, 64);
    assert.equal(initial.complete, true);

    ranker.dimensions = 128;
    const stale = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(stale.memories.length, 0);
    assert.equal(stale.qualityState, 'unavailable');

    const rebuilt = await fixture.store.backfillDenseIndex();
    assert.equal(rebuilt.dimensions, 128);
    assert.equal(rebuilt.complete, true);
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT DISTINCT dimensions
             FROM memory_dense_lsh
             WHERE memory_id = ? AND generation_id = ?`,
          )
          .get(target.id, rebuilt.generationId)?.dimensions,
      ),
      128,
    );
    const buildingAlias = fixture.store.denseIndexAlias();
    recordDenseEvaluation(
      fixture.store,
      rebuilt.generationId!,
      'dimension-upgrade-fixed-set-v1',
    );
    await fixture.store.activateDenseIndexGeneration({
      generationId: rebuilt.generationId!,
      expectedAliasRevision: buildingAlias!.revision,
      evaluationId: 'dimension-upgrade-fixed-set-v1',
    });
    const recalled = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(recalled.qualityState, 'full');
    assert.equal(recalled.memories[0]?.memory.id, target.id);
  } finally {
    fixture.close();
  }
});

test('同名同维 embedding 权重变化会降级并强制重建索引', async () => {
  const ranker = new ControlledDenseRanker(
    'mutable-same-dimension:latest',
    64,
  );
  const fixture = createStore(ranker);
  try {
    const target = fixture.store.remember({
      kind: 'preference',
      content: '用户长期偏好安静且低照度的工作空间。',
    }).memory;
    const initial = await fixture.store.backfillDenseIndex();
    assert.equal(initial.complete, true);
    assert.ok(initial.generationKey);

    ranker.generation = -1;
    const stale = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(stale.memories.length, 0);
    assert.equal(stale.qualityState, 'unavailable');

    const rebuilt = await fixture.store.backfillDenseIndex();
    assert.equal(rebuilt.complete, true);
    assert.notEqual(rebuilt.generationKey, initial.generationKey);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT DISTINCT generation_key
           FROM memory_embeddings
           WHERE memory_id = ? AND generation_id = ?`,
        )
        .get(target.id, rebuilt.generationId)?.generation_key,
      rebuilt.generationKey,
    );
    const buildingAlias = fixture.store.denseIndexAlias();
    recordDenseEvaluation(
      fixture.store,
      rebuilt.generationId!,
      'weight-upgrade-fixed-set-v1',
    );
    await fixture.store.activateDenseIndexGeneration({
      generationId: rebuilt.generationId!,
      expectedAliasRevision: buildingAlias!.revision,
      evaluationId: 'weight-upgrade-fixed-set-v1',
    });
    const recalled = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(recalled.qualityState, 'full');
    assert.equal(recalled.memories[0]?.memory.id, target.id);
  } finally {
    fixture.close();
  }
});

test('includeArchived 会把未索引归档记忆计入水位并报告降级', async () => {
  const ranker = new ControlledDenseRanker('archive-watermark-v1');
  const fixture = createStore(ranker);
  try {
    fixture.store.remember({
      kind: 'knowledge',
      content: '仓库的发布流水线使用蓝绿部署。',
    });
    await fixture.store.backfillDenseIndex();
    const archived = fixture.store.remember({
      kind: 'preference',
      content: '用户长期偏好安静且低照度的工作空间。',
    }).memory;
    fixture.database
      .prepare(
        `UPDATE memories
         SET status = 'archived'
         WHERE id = ?`,
      )
      .run(archived.id);

    const activeOnly = await fixture.store.getContextReliable({
      query: '完全无关的检索短语',
    });
    assert.equal(activeOnly.qualityState, 'full');

    const withArchived = await fixture.store.getContextReliable({
      query: '完全无关的检索短语',
      includeArchived: true,
    });
    assert.equal(withArchived.qualityState, 'degraded');
    const audit = fixture.store.audits(1)[0];
    assert.equal(audit.detail.denseEligible, 2);
    assert.equal(audit.detail.denseIndexed, 1);
  } finally {
    fixture.close();
  }
});

test('retention 归档后 includeArchived 仍能召回且默认召回排除', async () => {
  const ranker = new ControlledDenseRanker('archived-recall-v1');
  const fixture = createStore(ranker);
  try {
    const target = fixture.store.remember({
      kind: 'preference',
      content: '用户长期偏好安静且低照度的工作空间。',
    }).memory;
    await fixture.store.backfillDenseIndex();
    const lifecycle = new LifecycleStore(fixture.database);
    const governance = new MemoryGovernance(
      fixture.database,
      lifecycle,
      fixture.store,
    );
    // 默认已是不衰减；这里显式声明衰减策略，以复现"归档后仍可召回"的场景。
    governance.upsertPolicy({ halfLifeDays: 730 });
    const sweep = governance.runRetentionSweep({
      at: '2099-07-29T00:00:00.000Z',
    });
    assert.equal(sweep.archived, 1);

    const hidden = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
    });
    assert.equal(hidden.memories.length, 0);
    const archived = await fixture.store.getContextReliable({
      query: '什么场所最让我舒服？',
      includeArchived: true,
    });
    assert.equal(archived.qualityState, 'full');
    assert.equal(archived.memories[0]?.memory.id, target.id);
  } finally {
    fixture.close();
  }
});

test('完整备份恢复后总会重新排队 Dense 回填', async () => {
  const source = createStore(
    new ControlledDenseRanker('restore-embedding-v1'),
  );
  const target = createStore(
    new ControlledDenseRanker('restore-embedding-v1'),
  );
  try {
    source.store.remember({
      kind: 'preference',
      content: '用户长期偏好安静且低照度的工作空间。',
    });
    await source.store.backfillDenseIndex();
    const backup = source.store.exportAll();

    target.database
      .prepare(
        `INSERT INTO memory_jobs (
           id, job_type, user_id, namespace, payload_json, status,
           priority, attempts, max_attempts, available_at, lease_until,
           lease_owner, last_error, created_at, updated_at
         ) VALUES (
           'backfill-dense:restore-embedding-v1:default:personal:startup',
           'backfill_dense_index', 'default', 'personal', '{}',
           'completed', 2, 1, 5, ?, NULL, NULL, NULL, ?, ?
         )`,
      )
      .run(
        '2026-07-29T00:00:00.000Z',
        '2026-07-29T00:00:00.000Z',
        '2026-07-29T00:00:00.000Z',
      );
    target.store.importAll(backup);

    const ready = Number(
      target.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'backfill_dense_index'
             AND status = 'pending'`,
        )
        .get()?.count,
    );
    assert.ok(ready >= 1);
  } finally {
    source.close();
    target.close();
  }
});
