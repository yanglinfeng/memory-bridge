import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryLifecycle } from '../src/server/memory-lifecycle.js';
import {
  ContextualQueryUnderstandingService,
  type ContextualQueryUnderstandingProvider,
  type QueryUnderstandingInput,
  type QueryUnderstandingResult,
} from '../src/server/contextual-query-understanding.js';
import { openDatabase } from '../src/server/database.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';
import type {
  NamespaceRecallCoordinator,
} from '../src/server/namespace-quality.js';
import type {
  SemanticCandidate,
  SemanticDecision,
  SemanticRanker,
} from '../src/server/semantic-ranker.js';

class ContextRanker implements SemanticRanker {
  readonly embeddingModel = 'context-embedding-v1';
  readonly rerankModel = 'context-reranker-v1';
  readonly rerankQueries: string[] = [];
  readonly rerankCandidateTexts: string[][] = [];
  readonly rewriteQueries: string[] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0, 0]));
  }

  async rewrite(query: string): Promise<string[]> {
    this.rewriteQueries.push(query);
    return [];
  }

  async rerank(
    query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    this.rerankQueries.push(query);
    this.rerankCandidateTexts.push(
      candidates.map((candidate) => candidate.memory),
    );
    return candidates.map((candidate) => ({
      id: candidate.id,
      relevant: true,
      confidence: 0.99,
      reason: '上下文独立查询匹配',
    }));
  }
}

class AmbiguousProvider implements ContextualQueryUnderstandingProvider {
  readonly model = 'qwen2.5:14b-test';
  readonly promptVersion = 'context-query-test-v1';

  async understand(_input: QueryUnderstandingInput): Promise<unknown> {
    return {
      status: 'ambiguous',
      standaloneQuery: null,
      variants: [],
      resolvedReferences: [],
      constraints: {
        temporal: [], negative: [], modal: [], subject: [], object: [],
      },
      unresolvedReferences: ['他'],
      clarificationQuestion: '你说的是哥哥还是同事小林？',
      confidence: 0.4,
    };
  }
}

function resolvedUnderstanding(): QueryUnderstandingResult {
  return {
    status: 'resolved',
    originalQuery: '她最喜欢什么？',
    standaloneQuery: '小林最喜欢什么？',
    rankingQuery: '小林最喜欢什么？',
    variants: ['小林最喜欢的饮品'],
    resolvedReferences: [{
      surface: '她',
      resolvedText: '小林',
      supportingTurnIds: ['turn-1'],
    }],
    constraints: {
      temporal: [], negative: [], modal: [], frequency: [], conditional: [],
      subject: ['小林'], object: [],
    },
    unresolvedReferences: [],
    clarificationQuestion: null,
    confidence: 0.97,
    contextSource: 'trusted_ledger',
    decisionSource: 'model',
    model: 'qwen2.5:14b',
    promptVersion: 'context-query-v1',
    triggerReasons: ['personal_pronoun'],
    latencyMs: 12,
    telemetry: {
      route: 'model',
      providerCalls: 1,
      cacheHit: false,
      singleFlightShared: false,
      keyFingerprint: 'a'.repeat(64),
      queryDelta: true,
      variantDelta: true,
      requestDurationMs: 12,
      providerDurationMs: 10,
      model: {
        totalDurationMs: 9,
        loadDurationMs: 0.5,
        promptEvalCount: 80,
        promptEvalDurationMs: 2,
        evalCount: 12,
        evalDurationMs: 6,
        thermalState: 'warm',
      },
    },
  };
}

function fixture(ranker = new ContextRanker()) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-context-retrieval-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database, ranker);
  const lifecycleStore = new LifecycleStore(database);
  return {
    database,
    store,
    lifecycleStore,
    ranker,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('高置信独立查询参与候选召回并成为严格重排查询', async () => {
  const current = fixture();
  try {
    const memory = current.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'preference',
      content: '小林最喜欢的饮品是桂花乌龙。',
    }).memory;
    const response = await current.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '她最喜欢什么？',
    }, { queryUnderstanding: resolvedUnderstanding() });

    assert.deepEqual(
      response.memories.map((item) => item.memory.id),
      [memory.id],
    );
    assert.deepEqual(
      current.ranker.rerankQueries,
      ['小林最喜欢什么?'],
    );
    assert.equal(current.ranker.rewriteQueries.length, 0);
    const trace = current.store.getRetrievalTrace(
      response.traceId,
      'alice',
    )!;
    const rewrite = trace.events.find((event) => event.stage === 'rewrite')!;
    assert.equal(rewrite.detail.understandingStatus, 'resolved');
    assert.equal(rewrite.detail.route, 'model');
    assert.equal(rewrite.detail.providerCalls, 1);
    assert.equal(rewrite.detail.cacheHit, false);
    assert.equal(rewrite.detail.singleFlightShared, false);
    assert.equal(rewrite.detail.keyFingerprint, 'a'.repeat(64));
    assert.equal(rewrite.detail.queryDelta, true);
    assert.equal(rewrite.detail.variantDelta, true);
    assert.equal(rewrite.detail.providerDurationMs, 10);
    assert.deepEqual(rewrite.detail.modelTelemetry, {
      totalDurationMs: 9,
      loadDurationMs: 0.5,
      promptEvalCount: 80,
      promptEvalDurationMs: 2,
      evalCount: 12,
      evalDurationMs: 6,
      thermalState: 'warm',
    });
    assert.deepEqual(
      (rewrite.detail.variants as Array<{ type: string }>).map(
        (variant) => variant.type,
      ),
      ['original', 'contextual', 'contextual_variant', 'normalized'],
    );
    const selection = trace.events.find(
      (event) => event.stage === 'selection',
    )!;
    assert.equal(
      (selection.detail.results as Array<Record<string, unknown>>)[0]
        .memoryLayer,
      'fact',
    );
  } finally {
    current.close();
  }
});

test('首轮候选低于门槛时只执行确定性变体且不调用 LLM rewrite', async () => {
  const current = fixture();
  try {
    current.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'preference',
      content: '用户最喜欢的饮品是桂花乌龙。',
    });
    const response = await current.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '用户最喜欢的饮品是什么？',
    });

    assert.ok(response.memories.length > 0);
    assert.equal(current.ranker.rewriteQueries.length, 0);
    const trace = current.store.getRetrievalTrace(
      response.traceId,
      'alice',
    )!;
    const rewrite = trace.events.find((event) => event.stage === 'rewrite')!;
    assert.equal(rewrite.detail.triggered, true);
    assert.equal(rewrite.detail.mode, 'deterministic');
    assert.equal(rewrite.detail.deterministicTriggered, true);
    assert.equal(rewrite.detail.llmTriggered, false);
    assert.equal(rewrite.detail.initialCandidateCount, 1);
    assert.ok(Number(rewrite.detail.minCandidateThreshold) > 1);
    assert.ok(
      (rewrite.detail.variants as Array<{ type: string }>).some(
        (variant) => variant.type === 'alias',
      ),
    );
  } finally {
    current.close();
  }
});

test('重排与上下文只使用当前版本的独立用户证据摘要', async () => {
  const current = fixture();
  try {
    const exchanges = [
      ['one', '2026-08-01T07:00:00.000Z', '我起床后会先喝一杯温水。'],
      ['two', '2026-08-05T07:05:00.000Z', '这几天我起床后还是先喝温水。'],
      ['three', '2026-08-09T06:55:00.000Z', '今天起床后照常先喝了温水。'],
    ].map(([suffix, occurredAt, userContent]) =>
      current.lifecycleStore.recordCompletedExchange({
        userId: 'alice',
        namespace: 'personal',
        clientName: 'evidence-digest-test',
        sessionExternalId: `evidence-session-${suffix}`,
        userTurnExternalId: `evidence-user-${suffix}`,
        userContent,
        assistantTurnExternalId: `evidence-assistant-${suffix}`,
        assistantContent: '收到。',
        occurredAt,
      }));
    const assistantOnly = current.lifecycleStore.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'evidence-digest-test',
      sessionExternalId: 'evidence-session-assistant',
      userTurnExternalId: 'evidence-user-assistant',
      userContent: '我们聊点别的。',
      assistantTurnExternalId: 'evidence-assistant-only',
      assistantContent: '你每天起床后都会先喝温水。',
      occurredAt: '2026-08-10T07:00:00.000Z',
    });
    const memory = current.store.remember({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      kind: 'preference',
      content: '用户起床后先喝温水。',
      stableKey: 'alice::habit::morning-water',
      predicateKey: '用户::稳定生活习惯',
      normalizedValue: '起床后先喝温水',
      normalizedValueHash: 'alice-habit-morning-water',
      predicateCardinality: 'set',
      evidenceTurnId: exchanges[0].userTurn.id,
      evidenceExcerpt: exchanges[0].userTurn.content,
      sourceAuthority: 'direct_user',
    }).memory;
    const revision = Number(current.database.prepare(
      'SELECT revision FROM memory_items WHERE id = ?',
    ).get(memory.id)?.revision);
    for (const exchange of exchanges.slice(1)) {
      current.store.observe(memory.id, {
        expectedRevision: revision,
        evidenceTurnId: exchange.userTurn.id,
        evidenceExcerpt: exchange.userTurn.content,
        sensitivity: 'normal',
        sourceAuthority: 'direct_user',
      }, 'alice');
    }
    current.store.observe(memory.id, {
      expectedRevision: revision,
      evidenceTurnId: assistantOnly.assistantTurn.id,
      evidenceExcerpt: assistantOnly.assistantTurn.content,
      sensitivity: 'normal',
      sourceAuthority: 'assistant_inference',
    }, 'alice');

    const response = await current.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '我最近早晨起床后的习惯是什么？',
    });
    const grounding = response.grounding.find(
      (item) => item.memoryId === memory.id,
    )!;
    assert.equal(grounding.proofCount, 3);
    assert.equal(grounding.firstEvidenceAt, '2026-08-01T07:00:00.000Z');
    assert.equal(grounding.lastEvidenceAt, '2026-08-09T06:55:00.000Z');
    assert.equal(grounding.excerpts.length, 2);
    assert.doesNotMatch(
      grounding.excerpts.join('\n'),
      /你每天起床后都会先喝温水/u,
    );
    assert.match(response.context, /独立用户证据 3 条/u);
    assert.match(response.context, /证据时间:/u);
    assert.match(
      response.memories.find((result) => result.memory.id === memory.id)!
        .reasons.join('\n'),
      /时间意图“最近”参考当前版本用户证据时间/u,
    );
    assert.doesNotMatch(
      current.ranker.rerankCandidateTexts.flat().join('\n'),
      /你每天起床后都会先喝温水/u,
    );

    const changed = current.lifecycleStore.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'evidence-digest-test',
      sessionExternalId: 'evidence-session-changed',
      userTurnExternalId: 'evidence-user-changed',
      userContent: '我现在起床后先喝淡茶，不再喝温水。',
      assistantTurnExternalId: 'evidence-assistant-changed',
      assistantContent: '收到，以新习惯为准。',
      occurredAt: '2026-08-20T07:00:00.000Z',
    });
    current.store.update(memory.id, {
      content: '用户现在起床后先喝淡茶。',
      predicateKey: '用户::稳定生活习惯',
      normalizedValue: '起床后先喝淡茶',
      normalizedValueHash: 'alice-habit-morning-tea',
      predicateCardinality: 'set',
      evidenceTurnId: changed.userTurn.id,
      evidenceExcerpt: changed.userTurn.content,
      sourceAuthority: 'direct_user',
      resolutionType: 'correction',
      closePreviousVersion: true,
    }, 'alice');
    const afterCorrection = await current.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '我现在早晨起床后先喝什么？',
    });
    const correctedGrounding = afterCorrection.grounding.find(
      (item) => item.memoryId === memory.id,
    )!;
    assert.equal(correctedGrounding.proofCount, 1);
    assert.deepEqual(
      correctedGrounding.excerpts,
      ['我现在起床后先喝淡茶，不再喝温水。'],
    );
    assert.doesNotMatch(
      correctedGrounding.excerpts.join('\n'),
      /照常先喝了温水/u,
    );
  } finally {
    current.close();
  }
});

test('敏感记忆可计数但不得把敏感原文送入重排或上下文', async () => {
  const current = fixture();
  try {
    const exchange = current.lifecycleStore.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'sensitive-evidence-test',
      sessionExternalId: 'sensitive-evidence-session',
      userTurnExternalId: 'sensitive-evidence-user',
      userContent: '我的具体病历编号是 MED-PRIVATE-88421。',
      assistantTurnExternalId: 'sensitive-evidence-assistant',
      assistantContent: '收到。',
      occurredAt: '2026-08-12T09:00:00.000Z',
    });
    const memory = current.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'profile',
      content: '用户有一项需要私密处理的健康记录。',
      sensitivity: 'sensitive',
      evidenceTurnId: exchange.userTurn.id,
      evidenceExcerpt: exchange.userTurn.content,
      sourceAuthority: 'direct_user',
    }).memory;
    const response = await current.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '我的私密健康记录是什么？',
      allowedSensitivities: ['sensitive'],
    });
    const grounding = response.grounding.find(
      (item) => item.memoryId === memory.id,
    )!;
    assert.equal(grounding.proofCount, 1);
    assert.deepEqual(grounding.excerpts, []);
    assert.doesNotMatch(response.context, /MED-PRIVATE-88421/u);
    assert.doesNotMatch(
      current.ranker.rerankCandidateTexts.flat().join('\n'),
      /MED-PRIVATE-88421/u,
    );
  } finally {
    current.close();
  }
});

test('歧义查询不执行 embedding/重排并在九阶段 trace 标记澄清', async () => {
  const current = fixture();
  try {
    const ambiguous: QueryUnderstandingResult = {
      ...resolvedUnderstanding(),
      status: 'ambiguous',
      standaloneQuery: null,
      rankingQuery: '他喜欢什么？',
      variants: [],
      resolvedReferences: [],
      unresolvedReferences: ['他'],
      clarificationQuestion: '你说的是哥哥还是同事小林？',
      confidence: 0.3,
    };
    const response = await current.store.getContextReliable({
      userId: 'alice',
      query: '他喜欢什么？',
    }, { queryUnderstanding: ambiguous });
    assert.deepEqual(response.memories, []);
    assert.deepEqual(current.ranker.rerankQueries, []);
    const trace = current.store.getRetrievalTrace(
      response.traceId,
      'alice',
    )!;
    assert.deepEqual(
      trace.events.map((event) => event.stage),
      [
        'request', 'rewrite', 'channels', 'fusion', 'semantic',
        'rerank', 'selection', 'context', 'result',
      ],
    );
    assert.equal(
      trace.events.find((event) => event.stage === 'selection')
        ?.detail.reason,
      'clarification_required',
    );
    assert.doesNotMatch(JSON.stringify(trace), /哥哥还是同事小林/u);
  } finally {
    current.close();
  }
});

test('AIRI 对歧义问题只注入澄清要求且不注入长期记忆', async () => {
  const current = fixture();
  try {
    const queryService = new ContextualQueryUnderstandingService(
      new AmbiguousProvider(),
      { mode: 'auto' },
    );
    const coordinator = {
      async recallForLifecycle(
        input: { query: string },
        options: { queryUnderstanding?: QueryUnderstandingResult },
      ) {
        return {
          query: input.query,
          memories: [],
          context: '',
          qualityState: 'full',
          queryUnderstanding: options.queryUnderstanding,
          injectionPath: 'none',
          rollout: { mode: 'auto' },
        };
      },
    } as unknown as NamespaceRecallCoordinator;
    const lifecycle = new MemoryLifecycle(
      current.store,
      current.lifecycleStore,
      'alice',
      'personal',
      undefined,
      coordinator,
      undefined,
      queryService,
    );
    const prepared = await lifecycle.beforeModel({
      model: 'qwen2.5:14b',
      messages: [
        { role: 'user', content: '哥哥喜欢茶。' },
        { role: 'assistant', content: '知道了。' },
        { role: 'user', content: '同事小林喜欢咖啡。' },
        { role: 'assistant', content: '知道了。' },
        { role: 'user', content: '他喜欢什么？' },
      ],
    }, 'ambiguous-airi');
    const messages = prepared.messages as Array<{
      role: string;
      content: string;
    }>;
    const injected = messages.find((message) =>
      message.role === 'system' &&
      message.content.includes('当前问题包含无法可靠消解'),
    );
    assert.ok(injected);
    assert.match(injected.content, /哥哥还是同事小林/u);
    assert.doesNotMatch(injected.content, /不可信的记忆数据/u);
  } finally {
    current.close();
  }
});

test('候选很多但第一轮严格重排全部拒绝时触发一次质量补救', async () => {
  class RescueRanker extends ContextRanker {
    override async rerank(
      query: string,
      candidates: SemanticCandidate[],
    ): Promise<SemanticDecision[]> {
      this.rerankQueries.push(query);
      return candidates.map((candidate) => ({
        id: candidate.id,
        relevant: query.includes('小林'),
        confidence: 0.99,
        reason: query.includes('小林') ? '补救查询命中' : '原查询主体不明',
      }));
    }
  }
  const ranker = new RescueRanker();
  const current = fixture(ranker);
  try {
    const memory = current.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'preference',
      content: '小林最喜欢的饮品是桂花乌龙。',
    }).memory;
    let fallbackCalls = 0;
    const initial: QueryUnderstandingResult = {
      ...resolvedUnderstanding(),
      status: 'not_needed',
      originalQuery: '饮品偏好是什么？',
      standaloneQuery: null,
      rankingQuery: '饮品偏好是什么？',
      variants: [],
      resolvedReferences: [],
      triggerReasons: [],
      confidence: 0,
    };
    const response = await current.store.getContextReliable({
      userId: 'alice',
      namespace: 'personal',
      query: '饮品偏好是什么？',
    }, {
      queryUnderstanding: initial,
      qualityFallback: async () => {
        fallbackCalls += 1;
        return {
          ...initial,
          variants: ['小林最喜欢什么？'],
          confidence: 0.99,
        };
      },
    });

    assert.equal(fallbackCalls, 1);
    assert.deepEqual(ranker.rerankQueries, [
      '饮品偏好是什么?',
      '小林最喜欢什么?',
    ]);
    assert.deepEqual(
      response.memories.map((item) => item.memory.id),
      [memory.id],
    );
    assert.equal(response.queryUnderstanding?.status, 'not_needed');
    assert.deepEqual(
      response.queryUnderstanding?.variants,
      ['小林最喜欢什么？'],
    );
    const trace = current.store.getRetrievalTrace(
      response.traceId,
      'alice',
    )!;
    assert.deepEqual(
      [...new Set(trace.events.map((event) => event.stage))],
      [
        'request', 'rewrite', 'channels', 'fusion', 'semantic',
        'rerank', 'selection', 'context', 'result',
      ],
    );
    assert.deepEqual(
      trace.events
        .filter((event) => event.stage === 'rewrite')
        .map((event) => event.detail.attempt),
      [1, 2],
    );
    assert.equal(
      trace.events.filter((event) => event.stage === 'context').length,
      1,
    );
    assert.equal(
      trace.events.filter((event) => event.stage === 'result').length,
      1,
    );
    assert.equal(
      current.store.listRetrievalTraces({ limit: 10 }, 'alice').length,
      1,
    );
    assert.ok(
      response.memories.every((result) => result.traceId === response.traceId),
    );
  } finally {
    current.close();
  }
});

test('质量补救 provider 失败时降级且在同一 trace 记录第二次 attempt', async () => {
  const current = fixture();
  try {
    const initial: QueryUnderstandingResult = {
      ...resolvedUnderstanding(),
      status: 'not_needed',
      originalQuery: '不存在的偏好是什么？',
      standaloneQuery: null,
      rankingQuery: '不存在的偏好是什么？',
      variants: [],
      resolvedReferences: [],
      triggerReasons: [],
      confidence: 0,
    };
    const qualityFallback = async (): Promise<QueryUnderstandingResult> => {
      await delay(20);
      throw new Error('fallback provider token=never-log-this');
    };

    const context = await current.store.getContextReliable({
      userId: 'alice',
      query: '不存在的偏好是什么？',
    }, { queryUnderstanding: initial, qualityFallback });
    assert.equal(context.qualityState, 'degraded');
    assert.equal(context.memories.length, 0);

    const recalled = await current.store.recallReliable({
      userId: 'alice',
      query: '不存在的偏好是什么？',
    }, { queryUnderstanding: initial, qualityFallback });
    assert.deepEqual(recalled, []);

    const traces = current.store.listRetrievalTraces(
      { limit: 10 },
      'alice',
    );
    assert.equal(traces.length, 2);
    for (const summary of traces) {
      assert.equal(summary.qualityState, 'degraded');
      assert.equal(summary.errorCode, 'quality_fallback_unavailable');
      const trace = current.store.getRetrievalTrace(
        summary.traceId,
        'alice',
      )!;
      assert.deepEqual(
        trace.events
          .filter((event) => event.stage === 'rewrite')
          .map((event) => event.detail.attempt),
        [1, 2],
      );
      assert.equal(
        trace.events.find(
          (event) =>
            event.detail.reason === 'stage_failed' &&
            event.detail.attempt === 2,
        )?.detail.failedStage,
        'rewrite',
      );
      assert.ok(
        Number(
          trace.events.find(
            (event) =>
              event.stage === 'rewrite' && event.detail.attempt === 2,
          )?.detail.durationMs,
        ) >= 10,
        'quality fallback provider 耗时必须归入第二次 rewrite attempt',
      );
      assert.doesNotMatch(JSON.stringify(trace), /never-log-this/u);
      assert.match(JSON.stringify(trace), /errorHash/u);
    }
  } finally {
    current.close();
  }
});

test('质量补救结果无用时仍在同一 trace 记录明确 outcome', async () => {
  const current = fixture();
  try {
    const initial: QueryUnderstandingResult = {
      ...resolvedUnderstanding(),
      status: 'not_needed',
      originalQuery: '不存在的偏好是什么？',
      standaloneQuery: null,
      rankingQuery: '不存在的偏好是什么？',
      variants: [],
      resolvedReferences: [],
      triggerReasons: [],
      confidence: 0,
    };
    let fallbackCalls = 0;
    const response = await current.store.getContextReliable({
      userId: 'alice',
      query: '不存在的偏好是什么？',
    }, {
      queryUnderstanding: initial,
      qualityFallback: async () => {
        fallbackCalls += 1;
        return initial;
      },
    });

    assert.equal(fallbackCalls, 1);
    assert.equal(response.memories.length, 0);
    const trace = current.store.getRetrievalTrace(
      response.traceId,
      'alice',
    )!;
    assert.deepEqual(
      trace.events
        .filter((event) => event.stage === 'rewrite')
        .map((event) => event.detail.attempt),
      [1, 2],
    );
    const fallback = trace.events.find(
      (event) =>
        event.stage === 'rewrite' && event.detail.attempt === 2,
    )!;
    assert.equal(fallback.detail.qualityFallbackOutcome, 'not_useful');
    assert.equal(fallback.detail.reason, 'quality_fallback_not_useful');
  } finally {
    current.close();
  }
});

test('质量补救未产生新查询信号时不得重复检索和重排', async () => {
  class RejectingRanker extends ContextRanker {
    override async rerank(
      query: string,
      candidates: SemanticCandidate[],
    ): Promise<SemanticDecision[]> {
      this.rerankQueries.push(query);
      return candidates.map((candidate) => ({
        id: candidate.id,
        relevant: false,
        confidence: 0.99,
        reason: '测试拒绝',
      }));
    }
  }
  const ranker = new RejectingRanker();
  const current = fixture(ranker);
  try {
    current.store.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'knowledge',
      content: '饮品偏好需要由用户本人确认。',
    });
    const query = '饮品偏好是什么？';
    const initial: QueryUnderstandingResult = {
      ...resolvedUnderstanding(),
      status: 'not_needed',
      originalQuery: query,
      standaloneQuery: null,
      rankingQuery: query,
      variants: [],
      resolvedReferences: [],
      triggerReasons: [],
      confidence: 0,
    };
    const response = await current.store.getContextReliable({
      userId: 'alice', namespace: 'personal', query,
    }, {
      queryUnderstanding: initial,
      qualityFallback: async () => ({
        ...initial,
        status: 'resolved',
        standaloneQuery: query,
        rankingQuery: query,
        confidence: 0.99,
      }),
    });

    assert.equal(response.memories.length, 0);
    assert.equal(ranker.rerankQueries.length, 1);
    const trace = current.store.getRetrievalTrace(
      response.traceId,
      'alice',
    )!;
    const fallback = trace.events.find(
      (event) => event.stage === 'rewrite' && event.detail.attempt === 2,
    )!;
    assert.equal(fallback.detail.qualityFallbackOutcome, 'not_useful');
    assert.equal(fallback.detail.reason, 'quality_fallback_no_query_delta');
  } finally {
    current.close();
  }
});
