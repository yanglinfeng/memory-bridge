import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { constants as sqliteConstants } from 'node:sqlite';
import test from 'node:test';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import { openDatabase } from '../src/server/database.js';
import {
  DENSE_EVALUATION_CASES,
  DENSE_EVALUATION_DATASET_SHA256,
  DenseIndexEvaluator,
} from '../src/server/dense-index-evaluator.js';
import { embedText, vectorToBuffer } from '../src/server/embedding.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import {
  alignSourceExcerpt,
  containsCredentialSecret,
  extractionTargetDisposition,
  isAtomicCandidateContentSupported,
  normalizeAtomicCandidateContent,
  OllamaMemoryExtractor,
  protectedCredentialSensitivity,
  structuredAtomicCandidateText,
  type MemoryExtractor,
} from '../src/server/memory-extractor.js';
import {
  MemoryConsolidator,
  type ConsolidationProvider,
} from '../src/server/memory-consolidator.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';
import {
  beginForegroundActivity,
  resetModelQosForTests,
} from '../src/server/model-qos.js';
import {
  classifyMemoryJobFailure,
  memoryJobRetryDelayMs,
  MemoryWorker,
  PURGE_DISCOVERY_POLL_MAX_MS,
  PURGE_MEMORY_LEASE_SECONDS,
  purgeAwareWorkerPollMs,
} from '../src/server/memory-worker.js';
import type { SemanticRanker } from '../src/server/semantic-ranker.js';

test('Worker 对瞬态、协议、coverage 和不支持故障采用不同策略', () => {
  assert.deepEqual(
    classifyMemoryJobFailure(
      { jobType: 'consolidate_scope', attempts: 1 },
      'Ollama 记忆巩固未覆盖全部来源：1 条',
    ),
    {
      retryable: false,
      failureClass: 'coverage',
      compensationAction: 'stop_duplicate_retry',
    },
  );
  assert.equal(
    classifyMemoryJobFailure(
      { jobType: 'extract_turn', attempts: 1 },
      'fetch failed ECONNRESET',
    ).retryable,
    true,
  );
  assert.equal(
    classifyMemoryJobFailure(
      { jobType: 'extract_turn', attempts: 1 },
      '模型返回的 JSON 无法解析',
    ).retryable,
    true,
  );
  assert.equal(
    classifyMemoryJobFailure(
      { jobType: 'extract_turn', attempts: 2 },
      '模型返回的 JSON 无法解析',
    ).retryable,
    false,
  );
  assert.equal(
    classifyMemoryJobFailure(
      { jobType: 'consolidate_scope', attempts: 1 },
      'scope 所有权不一致',
    ).failureClass,
    'unsupported',
  );
});

test('Worker 重试退避包含有界 jitter 且不同 attempt 不固定重复', () => {
  const first = memoryJobRetryDelayMs({
    id: 'job-jitter',
    attempts: 1,
    updatedAt: '2026-08-10T00:00:00.000Z',
  });
  const second = memoryJobRetryDelayMs({
    id: 'job-jitter',
    attempts: 2,
    updatedAt: '2026-08-10T00:00:01.000Z',
  });
  assert.ok(first >= 800 && first <= 1_200);
  assert.ok(second >= 1_600 && second <= 2_400);
  assert.notEqual(first * 2, second);
});

test('前台压力存在时 Worker 不领取后台模型任务', async () => {
  const fixture = createFixture();
  let extractorCalls = 0;
  const extractor: MemoryExtractor = {
    extractorId: 'qos-test-extractor',
    extractorVersion: '1',
    model: 'qwen2.5:14b',
    promptVersion: 'qos-test-v1',
    async extract() {
      extractorCalls += 1;
      return [];
    },
  };
  try {
    fixture.lifecycle.enqueueJob({
      id: 'foreground-yield-extraction',
      jobType: 'extract_turn',
      payload: { turnId: 'not-needed-because-not-claimed' },
    });
    const worker = new MemoryWorker(fixture.lifecycle, extractor);
    const result = await worker.processNext('qos-worker', {
      backgroundModelAllowed: false,
    });
    assert.equal(result.job, null);
    assert.equal(result.processed, false);
    assert.equal(extractorCalls, 0);
    assert.equal(
      fixture.lifecycle.getJob('foreground-yield-extraction')?.status,
      'pending',
    );
  } finally {
    fixture.close();
  }
});

test('Worker 领取模型任务后若前台请求到达会安全归还且不消耗 attempt', async () => {
  resetModelQosForTests();
  const fixture = createFixture();
  let extractorCalls = 0;
  let releaseForeground: (() => void) | null = null;
  const originalClaim = fixture.lifecycle.claimJob.bind(
    fixture.lifecycle,
  );
  fixture.lifecycle.claimJob = ((
    ...args: Parameters<LifecycleStore['claimJob']>
  ) => {
    const claimed = originalClaim(...args);
    if (
      claimed?.jobType === 'extract_turn' &&
      !releaseForeground
    ) {
      releaseForeground = beginForegroundActivity();
    }
    return claimed;
  }) as LifecycleStore['claimJob'];
  const extractor: MemoryExtractor = {
    extractorId: 'qos-race-extractor',
    extractorVersion: '1',
    model: 'qwen2.5:14b',
    promptVersion: 'qos-race-v1',
    async extract() {
      extractorCalls += 1;
      return [];
    },
  };
  try {
    fixture.lifecycle.enqueueJob({
      id: 'foreground-race-extraction',
      jobType: 'extract_turn',
      payload: { turnId: 'not-needed-because-deferred' },
    });
    const result = await new MemoryWorker(
      fixture.lifecycle,
      extractor,
    ).processNext('qos-race-worker', {
      backgroundModelAllowed: true,
    });

    assert.equal(result.processed, false);
    assert.equal(extractorCalls, 0);
    const deferred = fixture.lifecycle.getJob(
      'foreground-race-extraction',
    );
    assert.equal(deferred?.status, 'pending');
    assert.equal(deferred?.attempts, 0);
    assert.equal(deferred?.leaseOwner, null);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE action = 'job_claim_deferred'`,
      ).get()?.count,
      1,
    );
  } finally {
    releaseForeground?.();
    fixture.close();
    resetModelQosForTests();
  }
});

test('后台提取 fetch 进行中遇到前台请求会取消并安全归还任务', async () => {
  resetModelQosForTests();
  const fixture = createFixture();
  let releaseForeground: (() => void) | null = null;
  let notifyFetchStarted: (() => void) | null = null;
  const fetchStarted = new Promise<void>((resolve) => {
    notifyFetchStarted = resolve;
  });
  try {
    const turn = fixture.lifecycle.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-qos-inflight',
      turnExternalId: 'turn-qos-inflight',
      role: 'user',
      content: '我开发应用时不喜欢内置演示数据。',
    }).turn;
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-qos-inflight-v1',
      timeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        notifyFetchStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('后台模型请求缺少 abort signal'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    });
    const processing = new MemoryWorker(
      fixture.lifecycle,
      extractor,
    ).processNext('qos-inflight-worker');

    await fetchStarted;
    releaseForeground = beginForegroundActivity();
    const result = await processing;

    assert.equal(result.processed, false);
    assert.equal(result.job?.status, 'pending');
    assert.equal(result.job?.attempts, 0);
    assert.equal(result.job?.leaseOwner, null);
    assert.equal(result.candidateCount, 0);
    assert.equal(fixture.lifecycle.listCandidates({}).length, 0);
    assert.equal(
      fixture.database.prepare(
        `SELECT status FROM extraction_runs WHERE turn_id = ?`,
      ).get(turn.id)?.status,
      'queued',
    );
    const deferred = fixture.database.prepare(
      `SELECT detail_json FROM audit_log
       WHERE action = 'job_claim_deferred'
         AND json_extract(detail_json, '$.jobId') = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(result.job?.id) as { detail_json?: string } | undefined;
    assert.equal(
      JSON.parse(deferred?.detail_json || '{}').reason,
      'foreground_activity_during_model',
    );
  } finally {
    releaseForeground?.();
    fixture.close();
    resetModelQosForTests();
  }
});

test('Worker 将 protocol recovery 的缩批策略传给巩固执行器', async () => {
  const fixture = createFixture();
  try {
    let observedOptions: Record<string, unknown> | undefined;
    const consolidator = {
      async consolidateScope(
        _scope: unknown,
        options: Record<string, unknown>,
      ) {
        observedOptions = options;
        return {
          status: 'completed_noop',
          consolidationId: null,
          memoryId: null,
          sourceCount: 2,
          sentenceCount: 0,
          unsupportedSentenceCount: 0,
          noopReason: 'protocol_repair_noop',
          inputFingerprint: 'a'.repeat(64),
          modelDurationMs: 1,
          compensationAction: 'single_attempt_protocol_repair',
        };
      },
    } as unknown as MemoryConsolidator;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    fixture.lifecycle.enqueueJob({
      id: 'protocol-recovery-consolidation',
      jobType: 'consolidate_scope',
      userId: 'alice',
      namespace: 'acceptance',
      payload: {
        userId: 'alice',
        namespace: 'acceptance',
        scopeType: 'topic',
        scopeKey: 'kind:preference',
        recovery: {
          mode: 'repair',
          failedJobId: 'failed-consolidation',
          failureClass: 'protocol',
          requestedAt: '2026-08-10T00:00:00.000Z',
          reason: 'invalid provider JSON',
          strategy: 'single_attempt_protocol_repair',
        },
      },
      maxAttempts: 1,
    });
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      consolidator,
    );

    const result = await worker.processNext('worker-protocol-repair');

    assert.equal(result.job?.status, 'completed');
    assert.deepEqual(observedOptions, {
      recoveryStrategy: 'single_attempt_protocol_repair',
    });
  } finally {
    fixture.close();
  }
});

function createWorkerRanker(
  embeddingModel = 'worker-embedding-v1',
): SemanticRanker {
  return {
    embeddingModel,
    rerankModel: 'worker-reranker-v1',
    async embed(texts) {
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
}

function createWorkerEvaluationRanker(
  embeddingModel: string,
): SemanticRanker {
  const normalizedVector = (values: number[]): Float32Array => {
    const norm = Math.sqrt(
      values.reduce((total, value) => total + value * value, 0),
    );
    return Float32Array.from(values, (value) => value / norm);
  };
  const caseIndex = (text: string): number => {
    const normalized = text.normalize('NFKC');
    return DENSE_EVALUATION_CASES.findIndex(
      (fixture) =>
        normalized.includes(fixture.query.normalize('NFKC')) ||
        normalized.includes(fixture.relevant.normalize('NFKC')),
    );
  };
  return {
    embeddingModel,
    rerankModel: 'worker-evaluation-reranker-v1',
    async embed(texts) {
      return texts.map((text) => {
        const target = caseIndex(text);
        if (target < 0) {
          return normalizedVector(Array.from(
            { length: 128 },
            (_, index) => (index % 2 === 0 ? -1 : -0.5),
          ));
        }
        return normalizedVector(Array.from(
          { length: 128 },
          (_, index) =>
            Math.sin((index + 1) * (target + 1) * 0.31) +
            Math.cos((index + 3) * (target + 2) * 0.17),
        ));
      });
    },
    async rerank(query, candidates) {
      const fixture = DENSE_EVALUATION_CASES.find(
        (item) => item.query.normalize('NFKC') === query,
      );
      return candidates.map((candidate) => {
        const relevant = Boolean(
          fixture &&
          candidate.memory.normalize('NFKC').includes(
            fixture.relevant.normalize('NFKC'),
          ),
        );
        return {
          id: candidate.id,
          relevant,
          confidence: relevant ? 1 : 0,
          reason: relevant ? '固定目标一致' : '固定干扰项',
        };
      });
    },
  };
}

function createFixture(startAt?: string) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-worker-'),
  );
  let current = startAt ? new Date(startAt) : null;
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycle = new LifecycleStore(
    database,
    () => current || new Date(),
  );
  return {
    directory,
    database,
    lifecycle,
    advance(milliseconds: number) {
      if (!current) {
        throw new Error('fixture 未配置确定性时钟');
      }
      current = new Date(current.getTime() + milliseconds);
    },
    now() {
      return current ? new Date(current) : new Date();
    },
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function recordPassingDenseEvaluation(
  store: MemoryStore,
  generationId: string,
  evaluationId: string,
  datasetSha256 = DENSE_EVALUATION_DATASET_SHA256,
): void {
  const generation = store.denseIndexGeneration(generationId)!;
  const cases = Array.from({ length: 20 }, (_, index) => ({
    caseId: `case-${index}`,
    expectedMemoryId: `expected-${index}`,
    retrievedMemoryIds: [`expected-${index}`],
    rank: 1,
    hitAt20: true,
    reciprocalRank: 1,
  }));
  store.recordDenseIndexEvaluation({
    evaluationId,
    generationId,
    modelId: generation.modelId,
    embeddingModel: generation.embeddingModel,
    generationKey: generation.generationKey,
    dimensions: generation.dimensions,
    datasetId: 'memory-bridge-recall-gate-v1',
    datasetSha256,
    evaluatorVersion: 'dense-evaluator-v1',
    queryCount: cases.length,
    recallAt20: 1,
    mrrAt10: 1,
    passed: true,
    startedAt: '2026-07-29T00:00:00.000Z',
    completedAt: '2026-07-29T00:01:00.000Z',
    cases,
  });
}

test('Dense 固定评测拒绝非官方数据集指纹', async () => {
  const fixture = createFixture();
  try {
    const store = new MemoryStore(
      fixture.database,
      createWorkerRanker('forged-evaluation-model'),
    );
    const generation = await store.backfillDenseIndex();
    assert.throws(
      () => recordPassingDenseEvaluation(
        store,
        generation.generationId!,
        'forged-dataset-evaluation',
        'f'.repeat(64),
      ),
      /报告不完整或计算不一致/u,
    );
  } finally {
    fixture.close();
  }
});

test('Dense 固定评测按 generation 复用，不因 principal 不同误报 degraded', async () => {
  const fixture = createFixture();
  try {
    const store = new MemoryStore(
      fixture.database,
      createWorkerRanker('shared-evaluation-model'),
    );
    const defaultGeneration = await store.backfillDenseIndex(
      256,
      undefined,
      'default',
      'shared-namespace',
    );
    const aliceGeneration = await store.backfillDenseIndex(
      256,
      undefined,
      'alice',
      'shared-namespace',
    );

    assert.equal(defaultGeneration.complete, true);
    assert.equal(
      aliceGeneration.generationId,
      defaultGeneration.generationId,
    );
    recordPassingDenseEvaluation(
      store,
      defaultGeneration.generationId!,
      'shared-generation-evaluation',
    );

    assert.equal(
      store.latestDenseIndexEvaluation(
        defaultGeneration.generationId!,
        'alice',
      )?.passed,
      true,
    );
  } finally {
    fixture.close();
  }
});

function excerptCandidate(
  input: Partial<Parameters<typeof alignSourceExcerpt>[1]> = {},
): Parameters<typeof alignSourceExcerpt>[1] {
  return {
    kind: 'preference',
    subject: '用户',
    predicate: '偏好',
    value: '深色模式',
    content: '用户默认使用深色模式。',
    confidence: 0.99,
    importance: 0.8,
    sensitivity: 'normal',
    negated: false,
    scopeType: 'personal',
    scopeKey: 'self',
    claimOccurredAt: null,
    claimValidFrom: null,
    claimValidTo: null,
    sourceExcerpt: '模型返回的原始证据',
    sourceAuthority: 'direct_user',
    ...input,
  };
}

function modelCandidate(
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'knowledge',
    subject: '用户',
    predicate: '稳定事实',
    value: '默认值',
    content: '用户有一条稳定事实。',
    confidence: 0.99,
    importance: 0.8,
    sensitivity: 'normal',
    negated: false,
    scopeType: 'personal',
    scopeKey: 'self',
    claimOccurredAt: null,
    claimValidFrom: null,
    claimValidTo: null,
    sourceExcerpt: '用户有一条稳定事实。',
    sourceAuthority: 'direct_user',
    ...input,
  };
}

function extractionResponse(
  candidates: Array<Record<string, unknown>>,
): Response {
  return new Response(
    JSON.stringify({
      message: {
        content: JSON.stringify({ candidates }),
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

test('sourceExcerpt 的 NFKC 等价标点对齐后仍保存原始逐字片段', () => {
  const turn =
    '我现在的项目原则变了：新软件第一次打开不再要求空数据，' +
    '今后应该自动导入一套最小示例数据，方便客户马上体验。';
  const requested =
    '项目原则变了:新软件第一次打开不再要求空数据,' +
    '今后应该自动导入一套最小示例数据,方便客户马上体验。';
  const aligned = alignSourceExcerpt(
    turn,
    excerptCandidate({
      content:
        '用户的新软件首次打开数据原则是自动导入一套最小示例数据。',
      value: '自动导入一套最小示例数据',
      sourceExcerpt: requested,
    }),
  );

  assert.equal(
    aligned,
    '项目原则变了：新软件第一次打开不再要求空数据，' +
      '今后应该自动导入一套最小示例数据，方便客户马上体验。',
  );
  assert.ok(turn.includes(aligned));
  assert.equal(
    aligned.normalize('NFKC'),
    requested.normalize('NFKC'),
  );
});

test('sourceExcerpt 的 NFKC 对齐拒绝等价碰撞、跨句和第三方归因', () => {
  const candidate = excerptCandidate({
    content: '用户的项目原则是自动导入示例。',
    value: '自动导入示例',
    sourceExcerpt: '项目原则:自动导入示例',
  });
  assert.equal(
    alignSourceExcerpt(
      '项目原则：自动导入示例，备用描述是项目原则:自动导入示例。',
      candidate,
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '项目原则：自动导入。下一句才说示例。',
      {
        ...candidate,
        sourceExcerpt: '项目原则:自动导入。下一句才说示例。',
      },
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '小王说：项目原则是自动导入示例。',
      {
        ...candidate,
        sourceExcerpt: '小王说:项目原则是自动导入示例。',
      },
    ),
    '',
  );
});

test('提取器拒绝不含具体事实的指代型原则元描述', async () => {
  const turnContent =
    '我做新软件时从来不接受内置演示数据，第一次打开必须是空数据。' +
    '这是我所有客户项目一直遵守的原则。今天先聊聊交付节奏吧。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v6',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      if (target.targetSentence.startsWith('我做新软件时')) {
        return extractionResponse([
          modelCandidate({
            kind: 'instruction',
            subject: '用户',
            predicate: '首次打开数据原则',
            value:
              '做新软件时从来不接受内置演示数据，第一次打开必须是空数据',
            sourceExcerpt: target.targetSentence,
          }),
        ]);
      }
      if (target.targetSentence.startsWith('这是我所有客户项目')) {
        return extractionResponse([
          modelCandidate({
            kind: 'knowledge',
            subject: '用户',
            predicate: '长期原则',
            value: '这是我所有客户项目一直遵守的原则',
            sourceExcerpt: target.targetSentence,
          }),
        ]);
      }
      return extractionResponse([]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-anaphoric-meta',
    sessionId: 'session-anaphoric-meta',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-anaphoric-meta',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.predicate, '首次打开数据原则');
  assert.match(result[0]?.value || '', /空数据/u);
  assert.doesNotMatch(result[0]?.value || '', /这是/u);
});

test('提取入口把明确事实、一次性闲聊和隐式重复行为送往正确记忆层', () => {
  assert.equal(
    extractionTargetDisposition(
      '我平时最常喝桂花乌龙，点单时优先选它。',
      '我平时最常喝桂花乌龙，点单时优先选它。',
    ),
    'extract_now',
  );
  assert.equal(
    extractionTargetDisposition(
      '第12天，路口的银杏叶刚开始变黄；这只是今天碰巧遇到的见闻。',
      '第12天，路口的银杏叶刚开始变黄；',
    ),
    'episode_only_non_durable',
  );
  assert.equal(
    extractionTargetDisposition(
      '今天照常晚饭后散步二十分钟，结束后整个人轻松了不少。',
      '今天照常晚饭后散步二十分钟，结束后整个人轻松了不少。',
    ),
    'episode_only_pattern_evidence',
  );
  assert.equal(
    extractionTargetDisposition(
      '这周又坚持了晚饭后散步二十分钟，做完以后心情很平静。',
      '这周又坚持了晚饭后散步二十分钟，做完以后心情很平静。',
    ),
    'episode_only_pattern_evidence',
  );
  assert.equal(
    extractionTargetDisposition(
      '我的固定习惯是每天晚饭后散步二十分钟。',
      '我的固定习惯是每天晚饭后散步二十分钟。',
    ),
    'extract_now',
  );
  assert.equal(
    extractionTargetDisposition(
      '同事说他每天晚饭后散步，但那不是我的习惯。',
      '同事说他每天晚饭后散步，但那不是我的习惯。',
    ),
    'not_direct_user',
  );
});

test('一次性闲聊和隐式习惯证据不调用 14B，明确长期事实仍调用', async () => {
  let calls = 0;
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-layer-routing-v1',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      return extractionResponse([
        modelCandidate({
          kind: 'preference',
          predicate: '常喝饮品',
          value: '桂花乌龙',
          sourceExcerpt: target.targetSentence,
        }),
      ]);
    },
  });
  const baseTurn = {
    id: 'turn-layer-routing',
    sessionId: 'session-layer-routing',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-layer-routing',
    role: 'user' as const,
    occurredAt: '2026-08-15T00:00:00.000Z',
    createdAt: '2026-08-15T00:00:00.000Z',
    metadata: {},
  };

  assert.deepEqual(await extractor.extract({
    ...baseTurn,
    content: '路口的银杏叶刚开始变黄；这只是今天碰巧遇到的见闻。',
  }), []);
  assert.deepEqual(await extractor.extract({
    ...baseTurn,
    id: 'turn-layer-routing-habit',
    externalId: 'turn-layer-routing-habit',
    content: '今天照常晚饭后散步二十分钟，结束后整个人轻松了不少。',
  }), []);
  assert.equal(calls, 0);

  const facts = await extractor.extract({
    ...baseTurn,
    id: 'turn-layer-routing-fact',
    externalId: 'turn-layer-routing-fact',
    content: '我平时最常喝桂花乌龙，点单时优先选它。',
  });
  assert.equal(calls, 1);
  assert.equal(facts[0]?.value, '桂花乌龙');
});

test('明确直系关系走确定性原子提取且不调用 14B', async () => {
  let calls = 0;
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-direct-relationship-v1',
    timeoutMs: 5_000,
    fetchImpl: async () => {
      calls += 1;
      return extractionResponse([]);
    },
  });
  const candidates = await extractor.extract({
    id: 'turn-direct-relationship',
    sessionId: 'session-direct-relationship',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-direct-relationship',
    role: 'user',
    content: '小安是我的妹妹，以后提到这个名字时按这个关系理解。',
    occurredAt: '2026-08-15T00:00:00.000Z',
    createdAt: '2026-08-15T00:00:00.000Z',
    metadata: {},
  });
  assert.equal(calls, 0);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.kind, 'relationship');
  assert.equal(candidates[0]?.subject, '小安');
  assert.equal(candidates[0]?.predicate, '与用户的关系');
  assert.equal(candidates[0]?.value, '妹妹');
  assert.equal(candidates[0]?.scopeType, 'personal');
  assert.equal(candidates[0]?.scopeKey, 'self');
});

test('指代型元描述过滤保留句内写明的具体规则', async () => {
  const contents = [
    '这是之前的决定。',
    '这是所有客户项目一直遵守的原则。',
    '这是首次打开必须为空数据的原则。',
  ];
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v6',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      return extractionResponse([
        modelCandidate({
          kind: 'instruction',
          subject: '用户',
          predicate: '项目原则',
          value: target.targetSentence,
          sourceExcerpt: target.targetSentence,
        }),
      ]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-anaphoric-concrete',
    sessionId: 'session-anaphoric-concrete',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-anaphoric-concrete',
    role: 'user',
    content: contents.join(''),
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(
    result[0]?.sourceExcerpt,
    '这是首次打开必须为空数据的原则。',
  );
});

test('sourceExcerpt 对齐支持中英文标点且只返回一个原文句子', () => {
  const turn =
    '界面默认使用深色模式。Tests must run before merge. ' +
    '日志保留七天！';
  assert.equal(
    alignSourceExcerpt(
      turn,
      excerptCandidate({
        sourceExcerpt: '界面默认使用深色模式。',
      }),
    ),
    '界面默认使用深色模式。',
  );
  assert.equal(
    alignSourceExcerpt(
      turn,
      excerptCandidate({
        predicate: '合并前测试',
        value: 'run before merge',
        content: 'Tests must run before merge.',
        sourceExcerpt: 'Tests must run before merge.',
      }),
    ),
    'Tests must run before merge.',
  );
  assert.equal(
    alignSourceExcerpt(
      turn,
      excerptCandidate({
        predicate: '日志保留期',
        value: '七天',
        content: '日志保留七天。',
        sourceExcerpt: '日志保留七天！',
      }),
    ),
    '日志保留七天！',
  );
  assert.equal(
    alignSourceExcerpt(
      '用户默认使用深色模式。',
      excerptCandidate({
        sourceExcerpt: '用户默认使用深色模式。',
      }),
    ),
    '用户默认使用深色模式。',
  );
  assert.equal(
    alignSourceExcerpt(
      '界面默认使用深色模式。提交前运行测试。',
      excerptCandidate({
        sourceExcerpt: '默认使用深色模式',
      }),
    ),
    '默认使用深色模式',
  );
  assert.equal(
    alignSourceExcerpt(
      '我的日程统一按上海时区安排。上午九点前不要安排会议。' +
        '每天下午两点到四点固定作为专注时间。' +
        '每周五下午做下一周计划。',
      excerptCandidate({
        predicate: '每周计划时间',
        value: '每周五下午做下一周计划',
        content: '用户每周五下午做下一周计划。',
        sourceExcerpt: '每周五下午做下一周计划。',
      }),
    ),
    '每周五下午做下一周计划。',
  );
});

test('sourceExcerpt 对齐拒绝平分、低重合和模型伪造证据', () => {
  const tied = '用户偏好蓝色。用户偏好蓝色！';
  assert.equal(
    alignSourceExcerpt(
      tied,
      excerptCandidate({
        value: '蓝色',
        content: '用户偏好蓝色。',
        sourceExcerpt: '用户偏好蓝色。',
      }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '用户住在上海。用户使用 VS Code。',
      excerptCandidate({
        value: '爵士乐',
        content: '用户喜欢爵士乐。',
        sourceExcerpt: '用户住在上海。',
      }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '用户住在上海。',
      excerptCandidate({
        value: '爵士乐',
        content: '用户住在上海。',
        sourceExcerpt: '用户住在上海。',
      }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '界面默认使用深色模式。日志保留七天。',
      excerptCandidate({
        sourceExcerpt: '模型伪造的原始证据',
      }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '界面默认使用深色模式。',
      excerptCandidate({ sourceExcerpt: '' }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '每周五下午做下一周计划。每周五下午做下周计划！',
      excerptCandidate({
        predicate: '每周计划时间',
        value: '每周五下午做下一周计划',
        content: '用户每周五下午做下一周计划。',
        sourceExcerpt: '每周五下午做下一周计划。',
      }),
    ),
    '',
  );
  const quotedTurn = 'I prefer dark mode." I use VS Code.';
  assert.equal(
    alignSourceExcerpt(
      quotedTurn,
      excerptCandidate({
        value: 'dark mode',
        content: quotedTurn,
        sourceExcerpt: quotedTurn,
      }),
    ),
    '',
  );
});

test('sourceExcerpt 对齐拒绝第三方引述和整段非用户语境', () => {
  assert.equal(
    alignSourceExcerpt(
      '我妈妈总说：‘你出生在杭州。’',
      excerptCandidate({
        value: '杭州',
        content: '用户出生在杭州。',
        sourceExcerpt: '你出生在杭州。',
      }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '小王说你一直住在深圳。',
      excerptCandidate({
        value: '深圳',
        content: '用户一直住在深圳。',
        sourceExcerpt: '你一直住在深圳。',
      }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '小王说你一直住在深圳。',
      excerptCandidate({
        value: '深圳',
        content: '用户一直住在深圳。',
        sourceExcerpt: '小王说你一直住在深圳。',
      }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '这些都是别人的事实：小王住深圳；李老师用 PyCharm。',
      excerptCandidate({
        value: 'PyCharm',
        content: '用户使用 PyCharm。',
        sourceExcerpt: '李老师用 PyCharm。',
      }),
    ),
    '',
  );
  assert.equal(
    alignSourceExcerpt(
      '我的妈妈叫王芳。',
      excerptCandidate({
        value: '王芳',
        content: '用户的妈妈叫王芳。',
        sourceExcerpt: '我的妈妈叫王芳。',
      }),
    ),
    '我的妈妈叫王芳。',
  );
});

test('提取器确定性拒绝第三方引语但保留用户本人直接陈述', async () => {
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v12',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      const quoted = target.targetSentence.includes('杭州');
      return extractionResponse([
        modelCandidate({
          kind: 'profile',
          subject: '用户',
          predicate: '出生地',
          value: quoted ? '杭州' : '上海',
          content: quoted
            ? '用户出生在杭州。'
            : '用户出生在上海。',
          sourceExcerpt: target.targetSentence,
        }),
      ]);
    },
  });
  const turn = (id: string, content: string) => ({
    id,
    sessionId: 'session-provenance-gate',
    userId: 'default',
    namespace: 'personal',
    externalId: id,
    role: 'user' as const,
    content,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  const quoted = await extractor.extract(
    turn(
      'turn-third-party-quote',
      '我妈妈总说：‘你出生在杭州。’',
    ),
  );
  const direct = await extractor.extract(
    turn('turn-direct-user-fact', '我出生在上海。'),
  );

  assert.deepEqual(quoted, []);
  assert.equal(direct.length, 1);
  assert.equal(direct[0]?.value, '上海');
  assert.equal(direct[0]?.sourceAuthority, 'direct_user');
  assert.equal(direct[0]?.sourceExcerpt, '我出生在上海。');
});

test('中文归因只在完整句式边界触发而不截断普通词', () => {
  const directFacts = [
    {
      turn:
        '我的长期收件地址与说明是上海市浦东新区世纪大道100号。',
      value: '上海市浦东新区世纪大道100号',
      content:
        '用户的长期收件地址与说明是上海市浦东新区世纪大道100号。',
    },
    {
      turn: '我对这件事的说法是先做代码审查。',
      value: '先做代码审查',
      content: '用户对这件事的说法是先做代码审查。',
    },
    {
      turn: '我的长期沟通原则是不强行说服别人。',
      value: '不强行说服别人',
      content: '用户的长期沟通原则是不强行说服别人。',
    },
    {
      turn: '我最近在读的小说是《三体》。',
      value: '《三体》',
      content: '用户最近在读的小说是《三体》。',
    },
    {
      turn: '我最喜欢的传说是精卫填海。',
      value: '精卫填海',
      content: '用户最喜欢的传说是精卫填海。',
    },
  ];
  for (const fact of directFacts) {
    assert.equal(
      alignSourceExcerpt(
        fact.turn,
        excerptCandidate({
          value: fact.value,
          content: fact.content,
          sourceExcerpt: fact.turn,
        }),
      ),
      fact.turn,
      fact.turn,
    );
  }

  for (const turn of [
    '小王说：他一直住在深圳。',
    '小王说“他一直住在深圳。”',
    '小王说你一直住在深圳。',
    '小王表示他一直住在深圳。',
    '据小王说，他一直住在深圳。',
  ]) {
    assert.equal(
      alignSourceExcerpt(
        turn,
        excerptCandidate({
          value: '深圳',
          content: '用户一直住在深圳。',
          sourceExcerpt: turn,
        }),
      ),
      '',
      turn,
    );
  }
});

test('sourceExcerpt 对齐保持否定与数值且绝不跨句拼接', () => {
  const turn =
    '用户不接受每周三次提醒。用户接受每周两次提醒。';
  const excerpt = alignSourceExcerpt(
    turn,
    excerptCandidate({
      predicate: '提醒频率限制',
      value: '不接受每周三次提醒',
      content: '用户不接受每周三次提醒。',
      sourceExcerpt: '用户不接受每周三次提醒。',
    }),
  );
  assert.equal(excerpt, '用户不接受每周三次提醒。');
  assert.match(excerpt, /不接受/u);
  assert.match(excerpt, /三次/u);
  assert.doesNotMatch(excerpt, /两次/u);
  assert.equal(
    alignSourceExcerpt(
      turn,
      excerptCandidate({
        predicate: '提醒频率限制',
        value: '不接受每周三次提醒',
        content: '用户不接受每周三次提醒。',
        sourceExcerpt: turn,
      }),
    ),
    '',
  );
});

test('凭据判定区分真实 secret 值与长期安全规则', () => {
  const policy = {
    predicate: '服务密钥读取规则',
    value: '所有服务密钥必须从环境变量读取',
    content: '所有服务密钥必须从环境变量读取。',
    sourceExcerpt: '所有服务密钥必须从环境变量读取。',
    sensitivity: 'credential',
  };
  assert.equal(containsCredentialSecret(policy), false);
  assert.equal(
    protectedCredentialSensitivity(policy),
    'normal',
  );
  assert.equal(
    containsCredentialSecret({
      predicate: 'API Key',
      value: 'secret-value',
      content: '用户的 API Key 是 secret-value。',
      sourceExcerpt: 'API Key 是 secret-value。',
      sensitivity: 'normal',
    }),
    true,
  );
  assert.equal(
    containsCredentialSecret(
      '密码不得写入日志，并且必须定期轮换。',
    ),
    false,
  );
  assert.equal(
    containsCredentialSecret('验证码是 123456。'),
    true,
  );
  for (const secret of [
    '密码是 hunter2。',
    'access token: DEMO_ONLY_ACCESS_TOKEN_01',
    'Cookie SESSION_ID=abc123',
    '私钥 -----BEGIN PRIVATE KEY-----',
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature123',
    'sk-proj-abc123XYZ789',
    'token=generic-token-123456',
    'API Key: sk-proj-abc123XYZ789 must-not-log',
  ]) {
    assert.equal(
      containsCredentialSecret(secret),
      true,
      `${secret} 必须被识别为真实凭据值`,
    );
  }
});

test('提取器逐项丢弃无效候选并保留同批有效候选', async () => {
  const turnContent = '我默认使用深色模式。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({ subject: '' }),
        modelCandidate({ predicate: '　' }),
        modelCandidate({ value: '' }),
        modelCandidate({ sourceExcerpt: '   ' }),
        {},
        modelCandidate({
          kind: 'preference',
          subject: '用户',
          predicate: '界面偏好',
          value: '深色模式',
          content: '用户默认使用深色模式。',
          sourceExcerpt: turnContent,
        }),
      ]),
  });

  const result = await extractor.extract({
    id: 'turn-mixed-invalid-candidates',
    sessionId: 'session-invalid-candidates',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-mixed-invalid-candidates',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.value, '深色模式');
});

test('提取器全批候选无效时返回空数组且不抛错', async () => {
  const turnContent = '我默认使用深色模式。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({ subject: '   ' }),
        modelCandidate({ predicate: '' }),
        modelCandidate({ value: '　' }),
        modelCandidate({ sourceExcerpt: '' }),
        {},
      ]),
  });

  const result = await extractor.extract({
    id: 'turn-all-invalid-candidates',
    sessionId: 'session-invalid-candidates',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-all-invalid-candidates',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.deepEqual(result, []);
});

test('纯回忆问句和本次回答约束不会占用 14B 长期记忆提取', async () => {
  let calls = 0;
  const content =
    '当前项目的项目专属代号、验收颜色和接头暗号分别是什么？' +
    '如果没有当前项目的长期记忆依据，请只回答不知道，不要引用其他项目。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v6',
    timeoutMs: 5_000,
    fetchImpl: async () => {
      calls += 1;
      return extractionResponse([]);
    },
  });
  const result = await extractor.extract({
    id: 'turn-recall-question-skip',
    sessionId: 'session-recall-question-skip',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-recall-question-skip',
    role: 'user',
    content,
    occurredAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, []);
});

test('普通日常问句分句后仍不得被误收为长期记忆', async () => {
  for (const content of [
    '1月31日周六午休想学一首简单的吉他曲，但不想把休息变成任务，你能给我一个轻松的开始方式吗？',
    '今天杭州预报有阵雨，我还要骑车去见朋友，怎么穿比较合适？',
    '我想去泉州旅行三天，交通别太折腾，能排一个不过度赶路的行程吗？',
    '我有个专业问题：向量检索的召回率怎么评估，能先给判断思路再举一个小例子吗？',
  ]) {
    let calls = 0;
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-natural-question-v1',
      timeoutMs: 5_000,
      fetchImpl: async () => {
        calls += 1;
        return extractionResponse([]);
      },
    });

    const result = await extractor.extract({
      id: `turn-natural-question-${calls}`,
      sessionId: 'session-natural-question-skip',
      userId: 'default',
      namespace: 'personal',
      externalId: `turn-natural-question-${calls}`,
      role: 'user',
      content,
      occurredAt: '2026-08-31T00:00:00.000Z',
      createdAt: '2026-08-31T00:00:00.000Z',
      metadata: {},
    });

    assert.equal(calls, 0, content);
    assert.deepEqual(result, [], content);
  }
});

test('问句中的明确长期陈述仍只提取陈述分句', async () => {
  const content = '我一直不吃香菜，今天吃什么比较好？';
  const requestedTargets: string[] = [];
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-durable-assertion-question-v1',
    timeoutMs: 5_000,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(String(init?.body || '{}')) as {
        messages?: Array<{ content?: string }>;
      };
      const input = JSON.parse(
        request.messages?.at(-1)?.content || '{}',
      ) as { targetSentence?: string };
      requestedTargets.push(input.targetSentence || '');
      return extractionResponse([
        modelCandidate({
          predicate: '饮食忌口',
          value: '不吃香菜',
          content: '用户不吃香菜。',
          sourceExcerpt: input.targetSentence,
        }),
      ]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-durable-assertion-question',
    sessionId: 'session-durable-assertion-question',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-durable-assertion-question',
    role: 'user',
    content,
    occurredAt: '2026-08-31T00:00:00.000Z',
    createdAt: '2026-08-31T00:00:00.000Z',
    metadata: {},
  });

  assert.deepEqual(requestedTargets, ['我一直不吃香菜']);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.value, '不吃香菜');
});

test('14B 空结果时明确项目专属事实仍生成逐字可验证候选', async () => {
  const exactCases = [
    {
      content:
        '验收项目A的项目专属验收颜色是靛蓝，只属于当前项目。我们继续聊别的。',
      subject: '验收项目A',
      predicate: '项目专属验收颜色',
      value: '靛蓝',
      excerpt:
        '验收项目A的项目专属验收颜色是靛蓝，只属于当前项目。',
    },
    {
      content:
        '验收项目A的项目专属接头暗号是琥珀灯塔，只属于当前项目。',
      subject: '验收项目A',
      predicate: '项目专属接头暗号',
      value: '琥珀灯塔',
      excerpt:
        '验收项目A的项目专属接头暗号是琥珀灯塔，只属于当前项目。',
    },
  ];

  for (const fixture of exactCases) {
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v6',
      timeoutMs: 5_000,
      fetchImpl: async () => extractionResponse([]),
    });
    const result = await extractor.extract({
      id: `turn-project-fallback-${fixture.value}`,
      sessionId: 'session-project-fallback',
      userId: 'default',
      namespace: 'personal',
      externalId: `turn-project-fallback-${fixture.value}`,
      role: 'user',
      content: fixture.content,
      occurredAt: '2026-08-09T00:00:00.000Z',
      createdAt: '2026-08-09T00:00:00.000Z',
      metadata: {},
    });

    assert.equal(result.length, 1);
    assert.deepEqual(
      {
        kind: result[0]?.kind,
        subject: result[0]?.subject,
        predicate: result[0]?.predicate,
        value: result[0]?.value,
        scopeType: result[0]?.scopeType,
        scopeKey: result[0]?.scopeKey,
        sourceExcerpt: result[0]?.sourceExcerpt,
      },
      {
        kind: 'project',
        subject: fixture.subject,
        predicate: fixture.predicate,
        value: fixture.value,
        scopeType: 'project',
        scopeKey: '当前项目',
        sourceExcerpt: fixture.excerpt,
      },
    );
    assert.equal(
      isAtomicCandidateContentSupported(result[0]!),
      true,
    );
    assert.equal(
      alignSourceExcerpt(fixture.content, {
        ...result[0]!,
        content: structuredAtomicCandidateText(result[0]!),
      }),
      fixture.excerpt,
    );
  }
});

test('项目专属兜底拒绝假设、转述、叙事提及、凭据和弱信号', async () => {
  const rejectedCases = [
    '假设验收项目A的项目专属验收颜色是靛蓝，只属于当前项目。',
    '小王说：验收项目A的项目专属验收颜色是靛蓝，只属于当前项目。',
    '我们聊到验收项目A的项目专属验收颜色是靛蓝，只属于当前项目。',
    '验收项目A的项目专属密码是 hunter2，只属于当前项目。',
    '验收项目A的项目专属验收颜色是靛蓝。',
    '验收项目A的项目专属验收颜色是不是靛蓝，只属于当前项目。',
  ];

  for (const [index, content] of rejectedCases.entries()) {
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v6',
      timeoutMs: 5_000,
      fetchImpl: async () => extractionResponse([]),
    });
    const result = await extractor.extract({
      id: `turn-project-fallback-rejected-${index}`,
      sessionId: 'session-project-fallback-rejected',
      userId: 'default',
      namespace: 'personal',
      externalId: `turn-project-fallback-rejected-${index}`,
      role: 'user',
      content,
      occurredAt: '2026-08-09T00:00:00.000Z',
      createdAt: '2026-08-09T00:00:00.000Z',
      metadata: {},
    });
    assert.deepEqual(result, [], content);
  }
});

test('明确编辑器纠正使用确定性候选且不调用 14B', async () => {
  const content =
    '更正一下，只在和规划助手这个角色聊天时，' +
    '我现在常用的编辑器改成Helix，之前的Zed不用了。';
  let providerCalls = 0;
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v19',
    timeoutMs: 5_000,
    fetchImpl: async () => {
      providerCalls += 1;
      return extractionResponse([]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-deterministic-editor-correction',
    sessionId: 'session-deterministic-editor-correction',
    userId: 'alice',
    namespace: 'personal',
    externalId: 'turn-deterministic-editor-correction',
    role: 'user',
    content,
    occurredAt: '2026-08-12T00:00:00.000Z',
    createdAt: '2026-08-12T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, 'preference');
  assert.equal(result[0]?.subject, '用户');
  assert.equal(result[0]?.predicate, '常用编辑器');
  assert.equal(result[0]?.value, 'Helix');
  assert.equal(result[0]?.scopeType, 'role');
  assert.equal(result[0]?.scopeKey, '规划助手');
  assert.equal(result[0]?.sourceExcerpt, content);
  assert.equal(isAtomicCandidateContentSupported(result[0]!), true);
});

test('稳定编辑器谓词校准模型的 event、低价值和伪时间', async () => {
  const content =
    '只在和规划助手这个角色聊天时，' +
    '我常用的编辑器是Visual Studio Code。';
  let providerCalls = 0;
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-stable-predicate-normalization-v1',
    timeoutMs: 5_000,
    fetchImpl: async () => {
      providerCalls += 1;
      return extractionResponse([
        modelCandidate({
          kind: 'event',
          subject: '用户',
          predicate: '常用编辑器',
          value: 'Visual Studio Code',
          content: '用户常用 Visual Studio Code。',
          confidence: 0.95,
          importance: 0.3,
          scopeType: 'role',
          scopeKey: '规划助手',
          claimOccurredAt: '2026-08-12T00:00:00.000Z',
          claimValidFrom: '2026-08-12T00:00:00.000Z',
          claimValidTo: '2026-12-31T00:00:00.000Z',
          sourceExcerpt: content,
        }),
      ]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-stable-editor-normalization',
    sessionId: 'session-stable-editor-normalization',
    userId: 'alice',
    namespace: 'personal',
    externalId: 'turn-stable-editor-normalization',
    role: 'user',
    content,
    occurredAt: '2026-08-12T00:00:00.000Z',
    createdAt: '2026-08-12T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(providerCalls, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, 'preference');
  assert.equal(result[0]?.predicate, '常用编辑器');
  assert.equal(result[0]?.importance, 0.6);
  assert.equal(result[0]?.claimOccurredAt, null);
  assert.equal(result[0]?.claimValidFrom, null);
  assert.equal(result[0]?.claimValidTo, null);
  assert.equal(result[0]?.scopeType, 'role');
  assert.equal(result[0]?.scopeKey, '规划助手');
});

test('第三方引述和假设在模型调用前确定性弃答', async () => {
  let providerCalls = 0;
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v19',
    timeoutMs: 5_000,
    fetchImpl: async () => {
      providerCalls += 1;
      return extractionResponse([]);
    },
  });
  const contents = [
    '同事说他离不开香菜，但那是他的口味，不是我的偏好。',
    '如果以后搬到海边，我也许会每天冲浪；这只是随口假设，不是现在的计划。',
  ];

  for (const [index, content] of contents.entries()) {
    const result = await extractor.extract({
      id: `turn-pre-model-abstention-${index}`,
      sessionId: 'session-pre-model-abstention',
      userId: 'alice',
      namespace: 'personal',
      externalId: `turn-pre-model-abstention-${index}`,
      role: 'user',
      content,
      occurredAt: '2026-08-12T00:00:00.000Z',
      createdAt: '2026-08-12T00:00:00.000Z',
      metadata: {},
    });
    assert.deepEqual(result, [], content);
  }
  assert.equal(providerCalls, 0);
});

test('模糊编辑器计划不走确定性纠正快路', async () => {
  let providerCalls = 0;
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v19',
    timeoutMs: 5_000,
    fetchImpl: async () => {
      providerCalls += 1;
      return extractionResponse([]);
    },
  });
  const content = '我最近在考虑把编辑器换成Helix。';
  const result = await extractor.extract({
    id: 'turn-ambiguous-editor-plan',
    sessionId: 'session-ambiguous-editor-plan',
    userId: 'alice',
    namespace: 'personal',
    externalId: 'turn-ambiguous-editor-plan',
    role: 'user',
    content,
    occurredAt: '2026-08-12T00:00:00.000Z',
    createdAt: '2026-08-12T00:00:00.000Z',
    metadata: {},
  });

  assert.deepEqual(result, []);
  assert.equal(providerCalls, 1);
});

test('空 content 候选会使用结构化字段生成规范 content', async () => {
  const turnContent = '我默认使用深色模式。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({
          kind: 'preference',
          subject: '用户',
          predicate: '界面偏好',
          value: '深色模式',
          content: '',
          sourceExcerpt: turnContent,
        }),
      ]),
  });

  const result = await extractor.extract({
    id: 'turn-empty-candidate-content',
    sessionId: 'session-empty-candidate-content',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-empty-candidate-content',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(
    result[0]?.content,
    'atomic-memory-v1:' +
      '{"subject":"用户","predicate":"界面偏好",' +
      '"value":"深色模式","negated":false}',
  );
});

test('证据对齐只使用结构化 claim 字段且不信任模型 content', async () => {
  const turnContent =
    '我希望你一直用日语回复。Nova 软件第一次打开必须是空白状态。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      const isLanguage = target.targetSentence.includes('日语');
      return extractionResponse([
        modelCandidate(
          isLanguage
            ? {
                kind: 'instruction',
                subject: '助手',
                predicate: '回复语言',
                value: '使用日语',
                content: '模型夹带的其他事实不能参与证据评分。',
                sourceExcerpt: target.targetSentence,
              }
            : {
                kind: 'project',
                subject: 'Nova 软件',
                predicate: '首次启动状态',
                value: '必须为空白状态',
                content: '模型夹带的其他事实不能参与证据评分。',
                sourceExcerpt: target.targetSentence,
                scopeType: 'project',
                scopeKey: 'Nova',
              },
        ),
      ]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-structured-alignment',
    sessionId: 'session-structured-alignment',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-structured-alignment',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.deepEqual(
    result.map((candidate) => candidate.value),
    ['使用日语', 'Nova 软件第一次打开必须是空白状态'],
  );
  assert.ok(
    result.every((candidate) =>
      candidate.content.startsWith('atomic-memory-v1:')),
  );
  assert.ok(
    result.every((candidate) =>
      !candidate.content.includes('模型夹带')),
  );
});

test('directive 的安全原文会在证据对齐前补全低覆盖 value', async () => {
  const turnContent = '正式通知请一直发到我的工作邮箱。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({
          kind: 'instruction',
          subject: '用户',
          predicate: '正式通知渠道',
          value: '发送正式通知至工作邮箱',
          content: '正式通知发送到用户的工作邮箱。',
          sourceExcerpt: turnContent,
        }),
      ]),
  });

  const result = await extractor.extract({
    id: 'turn-directive-evidence-normalization',
    sessionId: 'session-directive-evidence-normalization',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-directive-evidence-normalization',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(
    result[0]?.value,
    '正式通知请一直发到我的工作邮箱',
  );
  assert.equal(result[0]?.sourceExcerpt, turnContent);
});

test('固定 directive 会保留第一块学习板的序数证据', async () => {
  const turnContent = '我的第一块学习板固定选 ESP32-S3。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({
          kind: 'knowledge',
          subject: '用户',
          predicate: '主要学习板型号',
          value: 'ESP32-S3',
          content: '用户的第一块学习板选择 ESP32-S3。',
          sourceExcerpt: turnContent,
        }),
      ]),
  });

  const result = await extractor.extract({
    id: 'turn-first-learning-board',
    sessionId: 'session-first-learning-board',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-first-learning-board',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(
    result[0]?.value,
    '我的第一块学习板固定选 ESP32-S3',
  );
  assert.equal(result[0]?.sourceExcerpt, turnContent);
});

test('sourceExcerpt 只差安全空格时回填 targetSentence 精确原文', async () => {
  const turnContent = '我的 NOVA 助手名字固定叫小舟。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({
          subject: '用户',
          predicate: 'NOVA 助手名字',
          value: '小舟',
          content: '用户的 NOVA 助手名字是小舟。',
          sourceExcerpt: '我的NOVA助手名字固定叫小舟。',
        }),
      ]),
  });

  const result = await extractor.extract({
    id: 'turn-compact-source-excerpt',
    sessionId: 'session-compact-source-excerpt',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-compact-source-excerpt',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.sourceExcerpt, turnContent);
});

test('唯一显式项目可解引用本该这个项目且多项目保持保守', async () => {
  const extractScope = async (content: string) => {
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v5',
      timeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        const target = JSON.parse(request.messages[1].content);
        if (!target.targetSentence.includes('bun')) {
          return extractionResponse([]);
        }
        return extractionResponse([
          modelCandidate({
            kind: 'project',
            subject: '项目',
            predicate: '依赖管理工具',
            value: 'bun',
            content: target.targetSentence,
            sourceExcerpt: target.targetSentence,
            scopeType: 'project',
            scopeKey: 'Nova 项目的后端',
          }),
        ]);
      },
    });
    return extractor.extract({
      id: `turn-project-anaphora-${content}`,
      sessionId: 'session-project-anaphora',
      userId: 'default',
      namespace: 'personal',
      externalId: `turn-project-anaphora-${content}`,
      role: 'user',
      content,
      occurredAt: '2026-07-31T00:00:00.000Z',
      createdAt: '2026-07-31T00:00:00.000Z',
      metadata: {},
    });
  };

  const unique = await extractScope(
    'Nova 项目的后端确定使用 Deno。这个项目统一用 bun 管理依赖。',
  );
  assert.equal(unique.length, 1);
  assert.equal(unique[0]?.scopeType, 'project');
  assert.equal(unique[0]?.scopeKey, 'Nova');

  const ambiguous = await extractScope(
    'Nova 项目使用 Deno。Luna 项目使用 Go。这个项目统一用 bun 管理依赖。',
  );
  assert.deepEqual(ambiguous, []);
});

test('否定的真实偏好措辞不会把反话语境重置为本人事实', async () => {
  const turnContent =
    '下面全是反话，不是我的真实偏好：我可太喜欢清晨四点开会了；' +
    '网络中断真让我快乐；程序每次崩溃都棒极了。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      return extractionResponse([
        modelCandidate({
          kind: 'preference',
          subject: '用户',
          predicate: '偏好',
          value: target.targetSentence,
          content: target.targetSentence,
          sourceExcerpt: target.targetSentence,
          confidence: 0.99,
          importance: 0.9,
        }),
      ]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-negated-sarcasm-context',
    sessionId: 'session-negated-sarcasm-context',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-negated-sarcasm-context',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.deepEqual(result, []);
});

test('结构化证据在提取、持久化和自动解析路径保持一致', async () => {
  const fixture = createFixture();
  try {
    const turnContent = '我希望你一直用日语回复。';
    const turn = fixture.lifecycle.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-structured-evidence-pipeline',
      turnExternalId: 'turn-structured-evidence-pipeline',
      role: 'user',
      content: turnContent,
    }).turn;
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v5',
      timeoutMs: 5_000,
      fetchImpl: async () =>
        extractionResponse([
          modelCandidate({
            kind: 'instruction',
            subject: '助手',
            predicate: '回复语言',
            value: '使用日语',
            content: '助手一直使用日语回复。',
            sourceExcerpt: turnContent,
          }),
        ]),
    });
    const extracted = await extractor.extract(turn);
    const runId = fixture.lifecycle.startExtraction(
      turn.id,
      extractor.model,
      extractor.promptVersion,
      extractor.extractorId,
      extractor.extractorVersion,
    );
    const [stored] = fixture.lifecycle.completeExtraction(
      runId,
      extracted,
    );
    assert.ok(stored);
    assert.equal(stored.sourceExcerpt, turnContent);

    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      { mode: 'auto' },
    );
    const resolution = await resolver.resolve(stored.id);

    assert.equal(resolution.state, 'accepted');
  } finally {
    fixture.close();
  }
});

test('空 value 或 sourceExcerpt 不会形成 LifecycleStore 候选', async () => {
  const fixture = createFixture();
  try {
    const turn = fixture.lifecycle.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-empty-required-fields',
      turnExternalId: 'turn-empty-required-fields',
      role: 'user',
      content: '我默认使用深色模式。',
    }).turn;
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v5',
      timeoutMs: 5_000,
      fetchImpl: async () =>
        extractionResponse([
          modelCandidate({ value: '' }),
          modelCandidate({ sourceExcerpt: '　' }),
        ]),
    });

    const extracted = await extractor.extract(turn);
    const runId = fixture.lifecycle.startExtraction(
      turn.id,
      extractor.model,
      extractor.promptVersion,
      extractor.extractorId,
      extractor.extractorVersion,
    );
    const stored = fixture.lifecycle.completeExtraction(
      runId,
      extracted,
    );

    assert.deepEqual(extracted, []);
    assert.deepEqual(stored, []);
    assert.deepEqual(
      fixture.lifecycle.listCandidates({ state: 'pending' }),
      [],
    );
  } finally {
    fixture.close();
  }
});

test('提取器继续拒绝损坏或越界的外层 JSON 契约', async () => {
  const turnContent = '我默认使用深色模式。';
  const responses = [
    '{',
    JSON.stringify({ candidates: [], unexpected: true }),
    JSON.stringify({
      candidates: Array.from(
        { length: 13 },
        () => modelCandidate(),
      ),
    }),
  ];
  for (const [index, content] of responses.entries()) {
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v5',
      timeoutMs: 5_000,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ message: { content } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    });
    await assert.rejects(
      () =>
        extractor.extract({
          id: `turn-invalid-envelope-${index}`,
          sessionId: 'session-invalid-envelope',
          userId: 'default',
          namespace: 'personal',
          externalId: `turn-invalid-envelope-${index}`,
          role: 'user',
          content: turnContent,
          occurredAt: '2026-07-31T00:00:00.000Z',
          createdAt: '2026-07-31T00:00:00.000Z',
          metadata: {},
        }),
      index === 0
        ? /JSON 无法解析/u
        : /记忆提取结果无效/u,
    );
  }
});

test('转折复句会形成正负极性独立的原子候选', async () => {
  const turnContent = '我不使用 Chrome，但我使用 Firefox。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      const chrome = target.targetSentence.includes('Chrome');
      return extractionResponse([
        modelCandidate({
          kind: 'preference',
          predicate: '浏览器使用偏好',
          value: chrome ? 'Chrome' : 'Firefox',
          content: chrome
            ? '用户不使用 Chrome。'
            : '用户使用 Firefox。',
          sourceExcerpt: chrome
            ? `${target.targetSentence}。`
            : target.targetSentence,
        }),
      ]);
    },
  });
  const now = '2026-07-29T00:00:00.000Z';
  const result = await extractor.extract({
    id: 'turn-compound-adversative',
    sessionId: 'session-compound-adversative',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-compound-adversative',
    role: 'user',
    content: turnContent,
    occurredAt: now,
    createdAt: now,
    metadata: {},
  });

  assert.equal(result.length, 2);
  const chrome = result.find((candidate) =>
    candidate.content.includes('Chrome'));
  const firefox = result.find((candidate) =>
    candidate.content.includes('Firefox'));
  assert.ok(chrome);
  assert.ok(firefox);
  assert.equal(chrome.negated, true);
  assert.match(chrome.value, /Chrome/u);
  assert.doesNotMatch(chrome.value, /Firefox/u);
  assert.doesNotMatch(chrome.sourceExcerpt || '', /Firefox/u);
  assert.equal(firefox.negated, false);
  assert.equal(firefox.value, 'Firefox');
  assert.doesNotMatch(firefox.sourceExcerpt || '', /Chrome/u);
});

test('角色 scope 排除语句不会把前面的肯定事实标成否定', async () => {
  const turnContent =
    '当前角色独有的幸运数字是47，其他角色不用沿用。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({
          kind: 'preference',
          subject: '当前角色',
          predicate: '幸运数字',
          value: '47',
          content: '当前角色独有的幸运数字是47。',
          negated: true,
          scopeType: 'personal',
          scopeKey: 'self',
          sourceExcerpt: turnContent,
        }),
      ]),
  });

  const result = await extractor.extract({
    id: 'turn-role-scope-exclusion',
    sessionId: 'session-role-scope-exclusion',
    userId: 'alice',
    namespace: 'personal',
    externalId: 'turn-role-scope-exclusion',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.value, '47');
  assert.equal(result[0]?.negated, false);
  assert.equal(result[0]?.sourceExcerpt, turnContent);
});

test('角色限定使用可信 persona 映射且未知角色 fail closed', () => {
  const fixture = createFixture();
  try {
    const persist = (
      sessionExternalId: string,
      turnExternalId: string,
      content: string,
      displayName: string,
      extractedScopeKey: string,
    ) => {
      const turn = fixture.lifecycle.recordTurn({
        userId: 'alice',
        namespace: 'personal',
        personaId: 'alice-star',
        projectId: null,
        identitySource: 'credential',
        identityStatus: 'complete',
        roundId: `${turnExternalId}-round`,
        clientName: 'ollama-compat',
        sessionExternalId,
        turnExternalId,
        role: 'user',
        content,
        metadata: { trustedPersonaDisplayName: displayName },
      }).turn;
      const runId = fixture.lifecycle.startExtraction(
        turn.id,
        'qwen2.5:14b',
        'extract-v15',
      );
      return fixture.lifecycle.completeExtraction(runId, [
        {
          kind: 'preference',
          subject: '用户',
          predicate: '角色称呼',
          value: content.replace(/[。；;]+$/u, ''),
          content: normalizeAtomicCandidateContent({
            subject: '用户',
            predicate: '角色称呼',
            value: content.replace(/[。；;]+$/u, ''),
            content: '',
            sourceExcerpt: content,
          }),
          confidence: 0.99,
          importance: 0.9,
          scopeType: 'role',
          scopeKey: extractedScopeKey,
          sourceExcerpt: content,
        },
      ])[0];
    };

    const trusted = persist(
      'alice-star-known',
      'alice-star-known-turn',
      '只在和星璃这个角色聊天时，请叫我小枫。',
      '星璃',
      '星璃',
    );
    assert.equal(trusted.scopeType, 'role');
    assert.equal(trusted.scopeKey, 'alice-star');
    assert.equal(trusted.state, 'pending');

    const unknown = persist(
      'alice-star-unknown',
      'alice-star-unknown-turn',
      '只在和未知角色这个角色聊天时，请叫我小枫。',
      '星璃',
      '未知角色',
    );
    assert.equal(unknown.scopeType, 'role');
    assert.match(unknown.scopeKey, /^unbound:/u);
    assert.equal(unknown.state, 'rejected');
    assert.equal(
      unknown.decisionReason,
      'trusted_named_role_scope_required',
    );
  } finally {
    fixture.close();
  }
});

test('提取器把工作日和早上条件写入规范谓词和值', async () => {
  const turnContent =
    '早上还是桂花乌龙，这个习惯在工作日也一样。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v15',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({
          kind: 'preference',
          subject: '用户',
          predicate: '主要饮品',
          value: '桂花乌龙',
          sourceExcerpt: turnContent,
        }),
      ]),
  });

  const result = await extractor.extract({
    id: 'turn-weekday-morning-drink',
    sessionId: 'session-weekday-morning-drink',
    userId: 'alice',
    namespace: 'personal',
    externalId: 'turn-weekday-morning-drink',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.match(result[0]?.predicate || '', /条件:工作日\+早上/u);
  assert.match(result[0]?.value || '', /工作日/u);
  assert.match(result[0]?.value || '', /早上/u);
  assert.match(result[0]?.content || '', /条件:工作日\+早上/u);
});

test('提取器把同句项目代号和发布窗口拆成两个原子事实', async () => {
  const turnContent =
    '晨舟项目代号是赤狐42，固定发布窗口是星期三晚上九点。';
  const targets: string[] = [];
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v16',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const request = JSON.parse(body.messages[1].content) as {
        targetSentence: string;
      };
      targets.push(request.targetSentence);
      const isCode = request.targetSentence.includes('代号');
      return extractionResponse([
        modelCandidate({
          kind: 'project',
          subject: '晨舟项目',
          predicate: isCode ? '代号' : '固定发布窗口',
          value: isCode ? '赤狐42' : '星期三晚上九点',
          scopeType: 'project',
          scopeKey: '晨舟项目',
          sourceExcerpt: request.targetSentence,
        }),
      ]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-project-code-window',
    sessionId: 'session-project-code-window',
    userId: 'alice',
    namespace: 'personal',
    externalId: 'turn-project-code-window',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    metadata: {},
  });

  assert.deepEqual(targets, [
    '晨舟项目代号是赤狐42',
    '固定发布窗口是星期三晚上九点。',
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.predicate, '代号');
  assert.equal(result[0]?.value, '赤狐42');
  assert.equal(
    result[1]?.predicate,
    '固定发布窗口 [条件:晚上]',
  );
  assert.equal(result[1]?.value, '星期三晚上九点');
});

test('提取器把逗号后以“计划在”开头的项目事实拆开', async () => {
  const turnContent =
    '青岚项目代号是绿松石33，计划在星期六早上验收。';
  const targets: string[] = [];
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v16',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const request = JSON.parse(body.messages[1].content) as {
        targetSentence: string;
      };
      targets.push(request.targetSentence);
      const isCode = request.targetSentence.includes('代号');
      return extractionResponse([
        modelCandidate({
          kind: 'project',
          subject: '青岚项目',
          predicate: isCode ? '代号' : '验收时间',
          value: isCode ? '绿松石33' : '星期六早上',
          scopeType: 'project',
          scopeKey: '青岚项目',
          sourceExcerpt: request.targetSentence,
        }),
      ]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-project-code-acceptance',
    sessionId: 'session-project-code-acceptance',
    userId: 'bob',
    namespace: 'personal',
    externalId: 'turn-project-code-acceptance',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    metadata: {},
  });

  assert.deepEqual(targets, [
    '青岚项目代号是绿松石33',
    '计划在星期六早上验收。',
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.predicate, '代号');
  assert.equal(result[0]?.value, '绿松石33');
  assert.equal(result[1]?.predicate, '验收时间 [条件:早上]');
  assert.equal(result[1]?.value, '星期六早上');
});

test('明确项目代号在 14B 返回空候选时仍安全提取', async () => {
  const turnContent =
    '晨舟项目代号是赤狐42，固定发布窗口是星期三晚上九点。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v16',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ content: string }>;
      };
      const request = JSON.parse(body.messages[1].content) as {
        targetSentence: string;
      };
      if (request.targetSentence.includes('代号')) {
        return extractionResponse([]);
      }
      return extractionResponse([
        modelCandidate({
          kind: 'knowledge',
          subject: '晨舟项目',
          predicate: '固定发布窗口',
          value: '星期三晚上九点',
          scopeType: 'project',
          scopeKey: '晨舟项目',
          sourceExcerpt: request.targetSentence,
        }),
      ]);
    },
  });

  const result = await extractor.extract({
    id: 'turn-project-code-empty-model-result',
    sessionId: 'session-project-code-empty-model-result',
    userId: 'alice',
    namespace: 'personal',
    externalId: 'turn-project-code-empty-model-result',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 2);
  assert.equal(result[0]?.kind, 'project');
  assert.equal(result[0]?.subject, '晨舟项目');
  assert.equal(result[0]?.predicate, '代号');
  assert.equal(result[0]?.value, '赤狐42');
  assert.equal(result[0]?.scopeType, 'project');
  assert.equal(result[0]?.scopeKey, '当前项目');
  assert.equal(result[1]?.predicate, '固定发布窗口 [条件:晚上]');
});

test('明确项目计划时间在 14B 返回空候选时仍安全提取', async () => {
  const turnContent =
    '青岚项目代号是绿松石33，计划在星期六早上验收。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v17',
    timeoutMs: 5_000,
    fetchImpl: async () => extractionResponse([]),
  });

  const result = await extractor.extract({
    id: 'turn-project-schedule-empty-model-result',
    sessionId: 'session-project-schedule-empty-model-result',
    userId: 'bob',
    namespace: 'personal',
    externalId: 'turn-project-schedule-empty-model-result',
    role: 'user',
    content: turnContent,
    occurredAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 2);
  assert.equal(result[0]?.subject, '青岚项目');
  assert.equal(result[0]?.predicate, '代号');
  assert.equal(result[0]?.value, '绿松石33');
  assert.equal(result[1]?.kind, 'project');
  assert.equal(result[1]?.subject, '青岚项目');
  assert.equal(result[1]?.predicate, '验收时间 [条件:早上]');
  assert.equal(result[1]?.value, '星期六早上');
  assert.equal(result[1]?.scopeType, 'project');
  assert.equal(result[1]?.scopeKey, '当前项目');
});

test('确定性项目代号兜底不把提问当作事实', async () => {
  const question = '晨舟项目代号是赤狐42吗？';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v16',
    timeoutMs: 5_000,
    fetchImpl: async () => extractionResponse([]),
  });

  const result = await extractor.extract({
    id: 'turn-project-code-question',
    sessionId: 'session-project-code-question',
    userId: 'alice',
    namespace: 'personal',
    externalId: 'turn-project-code-question',
    role: 'user',
    content: question,
    occurredAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    metadata: {},
  });

  assert.deepEqual(result, []);
});

test('候选 content 只接受结构化字段生成的语言无关规范形式', () => {
  const expected =
    'atomic-memory-v1:' +
    '{"subject":"用户","predicate":"界面偏好",' +
    '"value":"深色模式","negated":false}';
  const variants = [
    '用户默认使用深色模式。用户的协作工具是飞书。',
    '用户默认使用深色模式，协作工具是飞书。',
    '用户默认使用深色模式、协作工具是飞书。',
    '用户默认使用深色模式；协作工具是飞书。',
    '用户默认使用深色模式协作工具飞书。',
    '用户默认使用深色模式，primary tool 是 Feishu。',
  ];
  const base = {
    subject: '用户',
    predicate: '界面偏好',
    value: '深色模式',
    sourceExcerpt: '我默认使用深色模式。',
    negated: false,
  };

  assert.deepEqual(
    variants.map((content) => ({
      normalized: normalizeAtomicCandidateContent({
        ...base,
        content,
      }),
      supported: isAtomicCandidateContentSupported({
        ...base,
        content,
      }),
    })),
    variants.map(() => ({
      normalized: expected,
      supported: false,
    })),
  );
  assert.equal(
    isAtomicCandidateContentSupported({
      ...base,
      content: expected,
    }),
    true,
  );
});

test('规范原子 content 无损支持中文长值、地址和任意标点', () => {
  const value = (
    '北京市朝阳区建国路88号A座15层，收件人写“前台代收”、' +
    '备注写全天可联系；工作日九点到十八点均可送达。'
  ).repeat(4);
  const normalizedValue = value.normalize('NFKC').trim();
  const expected = `atomic-memory-v1:${JSON.stringify({
    subject: '用户',
    predicate: '收件地址与说明',
    value: normalizedValue,
    negated: false,
  })}`;
  const candidate = {
    subject: '用户',
    predicate: '收件地址与说明',
    value,
    content: '模型给出的自然语言建议不属于规范内容。',
    sourceExcerpt: value,
    negated: false,
  };

  assert.equal(normalizeAtomicCandidateContent(candidate), expected);
  assert.equal(
    isAtomicCandidateContentSupported({
      ...candidate,
      content: expected,
    }),
    true,
  );
  assert.equal(
    JSON.parse(
      expected.slice('atomic-memory-v1:'.length),
    ).value,
    normalizedValue,
  );
});

test('提取器会移除 content 中夹带的同回合第二条事实', async () => {
  const turnContent =
    '我默认使用深色模式。我的协作工具是飞书。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      if (!target.targetSentence.includes('深色模式')) {
        return extractionResponse([]);
      }
      return extractionResponse([
        modelCandidate({
          kind: 'preference',
          subject: '用户',
          predicate: '界面偏好',
          value: '深色模式',
          content:
            '用户默认使用深色模式。用户的协作工具是飞书。',
          sourceExcerpt: target.targetSentence,
        }),
      ]);
    },
  });
  const now = '2026-07-29T00:00:00.000Z';
  const result = await extractor.extract({
    id: 'turn-content-smuggling',
    sessionId: 'session-content-smuggling',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-content-smuggling',
    role: 'user',
    content: turnContent,
    occurredAt: now,
    createdAt: now,
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(
    result[0]?.content,
    'atomic-memory-v1:' +
      '{"subject":"用户","predicate":"界面偏好",' +
      '"value":"深色模式","negated":false}',
  );
  assert.doesNotMatch(result[0]?.content || '', /飞书/u);
  assert.equal(
    result[0]?.sourceExcerpt,
    '我默认使用深色模式。',
  );
});

test('完整 directive 不会覆盖已经规范化的原子 value', async () => {
  const turnContent = '我新项目默认用 TypeScript。';
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v4',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({
          kind: 'preference',
          predicate: '新项目默认语言',
          value: 'TypeScript',
          content: '用户的新项目默认使用 TypeScript。',
          sourceExcerpt: turnContent,
        }),
      ]),
  });
  const now = '2026-07-29T00:00:00.000Z';
  const result = await extractor.extract({
    id: 'turn-normalized-directive',
    sessionId: 'session-normalized-directive',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-normalized-directive',
    role: 'user',
    content: turnContent,
    occurredAt: now,
    createdAt: now,
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.value, 'TypeScript');
  assert.equal(result[0]?.negated, false);
});

test('scope 允许同名项目重复出现但拒绝同句多项目歧义', async () => {
  const now = '2026-07-29T00:00:00.000Z';
  const repeated =
    'Atlas 项目使用 TypeScript。Atlas 项目部署到云端。';
  const repeatedExtractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v4',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      return extractionResponse([
        modelCandidate({
          subject: 'Atlas 项目',
          predicate: target.targetSentence.includes('TypeScript')
            ? '技术语言'
            : '部署位置',
          value: target.targetSentence.includes('TypeScript')
            ? 'TypeScript'
            : '云端',
          content: target.targetSentence,
          scopeType: 'project',
          scopeKey: 'Atlas',
          sourceExcerpt: target.targetSentence,
        }),
      ]);
    },
  });
  const repeatedResult = await repeatedExtractor.extract({
    id: 'turn-repeated-scope',
    sessionId: 'session-repeated-scope',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-repeated-scope',
    role: 'user',
    content: repeated,
    occurredAt: now,
    createdAt: now,
    metadata: {},
  });
  assert.equal(repeatedResult.length, 2);
  for (const candidate of repeatedResult) {
    assert.equal(candidate.scopeType, 'project');
    assert.equal(candidate.scopeKey, 'Atlas');
  }

  const ambiguous = 'Atlas 项目和 Boreal 项目都使用 TypeScript。';
  const ambiguousExtractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v4',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      extractionResponse([
        modelCandidate({
          subject: '项目',
          predicate: '技术语言',
          value: 'TypeScript',
          content: ambiguous,
          scopeType: 'project',
          scopeKey: 'Atlas',
          sourceExcerpt: ambiguous,
        }),
      ]),
  });
  const ambiguousResult = await ambiguousExtractor.extract({
    id: 'turn-ambiguous-scope',
    sessionId: 'session-ambiguous-scope',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-ambiguous-scope',
    role: 'user',
    content: ambiguous,
    occurredAt: now,
    createdAt: now,
    metadata: {},
  });
  assert.deepEqual(ambiguousResult, []);
});

test('超过十二个单句事实不会静默丢弃后句候选', async () => {
  const facts = Array.from(
    { length: 13 },
    (_, index) => `用户长期偏好代号 P${String(index + 1).padStart(2, '0')}。`,
  );
  const turnContent = facts.join('');
  let calls = 0;
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v4',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body));
      const target = JSON.parse(request.messages[1].content);
      const value = String(target.targetSentence).match(/P\d{2}/u)?.[0];
      return extractionResponse([
        modelCandidate({
          kind: 'preference',
          predicate: '长期偏好代号',
          value,
          content: target.targetSentence,
          sourceExcerpt: target.targetSentence,
        }),
      ]);
    },
  });
  const now = '2026-07-29T00:00:00.000Z';
  const result = await extractor.extract({
    id: 'turn-thirteen-facts',
    sessionId: 'session-thirteen-facts',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-thirteen-facts',
    role: 'user',
    content: turnContent,
    occurredAt: now,
    createdAt: now,
    metadata: {},
  });

  assert.equal(calls, 13);
  assert.equal(result.length, 13);
  assert.ok(result.some((candidate) => candidate.value === 'P13'));
});

test('逐句 discourse 状态继承非本人语境并允许明确恢复', async () => {
  const now = '2026-07-29T00:00:00.000Z';
  const extract = async (content: string) => {
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v5',
      timeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body));
        const target = JSON.parse(request.messages[1].content);
        if (
          !/(?:住在|住址|开会)/u.test(target.targetSentence)
        ) {
          return extractionResponse([]);
        }
        const value =
          String(target.targetSentence).match(
            /(?:北京|上海|深圳|凌晨三点)/u,
          )?.[0] || '未知';
        return extractionResponse([
          modelCandidate({
            kind: 'profile',
            predicate: target.targetSentence.includes('开会')
              ? '会议偏好'
              : '居住地',
            value,
            content: target.targetSentence,
            sourceExcerpt: target.targetSentence,
          }),
        ]);
      },
    });
    return extractor.extract({
      id: `turn-discourse-${content}`,
      sessionId: 'session-discourse',
      userId: 'default',
      namespace: 'personal',
      externalId: `turn-discourse-${content}`,
      role: 'user',
      content,
      occurredAt: now,
      createdAt: now,
      metadata: {},
    });
  };

  for (const content of [
    '假设场景如下。我住北京。',
    '小王资料如下。他住上海。',
    '开启反讽模式。我最喜欢凌晨三点开会。',
    '我扮演小王。我住深圳。',
  ]) {
    assert.deepEqual(
      await extract(content),
      [],
      `${content} 必须继承非本人语境`,
    );
  }
  const reset = await extract(
    '下面一句是引用：小王住北京。我的真实住址是上海。',
  );
  assert.equal(reset.length, 1);
  assert.equal(reset[0]?.value, '上海');
  assert.equal(
    reset[0]?.sourceExcerpt,
    '我的真实住址是上海。',
  );
});

test('“说明”中的说不会吞掉敏感地址候选且保持待确认', async () => {
  const fixture = createFixture();
  try {
    const content =
      '我的长期收件地址与说明是上海市浦东新区世纪大道100号。';
    const turn = fixture.lifecycle.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-address-attribution',
      turnExternalId: 'turn-address-attribution',
      role: 'user',
      content,
    }).turn;
    const extractor = new OllamaMemoryExtractor({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v5',
      timeoutMs: 5_000,
      fetchImpl: async () =>
        extractionResponse([
          modelCandidate({
            kind: 'profile',
            subject: '用户',
            predicate: '长期收件地址与说明',
            value: '上海市浦东新区世纪大道100号',
            content:
              '用户的长期收件地址与说明是上海市浦东新区世纪大道100号。',
            sourceExcerpt: content,
            sensitivity: 'normal',
          }),
        ]),
    });
    const extracted = await extractor.extract(turn);

    assert.equal(extracted.length, 1);
    assert.equal(extracted[0]?.sourceExcerpt, content);
    assert.equal(extracted[0]?.sensitivity, 'sensitive');

    const runId = fixture.lifecycle.startExtraction(
      turn.id,
      extractor.model,
      extractor.promptVersion,
      extractor.extractorId,
      extractor.extractorVersion,
    );
    const [candidate] = fixture.lifecycle.completeExtraction(
      runId,
      extracted,
    );
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      { mode: 'auto' },
    );
    const result = await resolver.resolve(candidate.id);

    assert.equal(result.state, 'pending');
    assert.equal(result.reason, 'sensitive_requires_confirmation');
  } finally {
    fixture.close();
  }
});

test('14B 提取器使用结构化输出并确定性阻止凭据', async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v2',
    timeoutMs: 5_000,
    fetchImpl: async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as
        Record<string, unknown>;
      requestBodies.push(requestBody);
      const messages = requestBody.messages as Array<
        Record<string, unknown>
      >;
      const target = JSON.parse(
        String(messages[1]?.content),
      ) as Record<string, unknown>;
      const editorCandidate = {
        kind: 'preference',
        subject: '用户',
        predicate: '主要编辑器',
        value: 'VS Code',
        content: '用户主要使用 VS Code。',
        confidence: 98,
        importance: 8,
        sensitivity: 'normal',
        scopeType: 'personal',
        scopeKey: 'self',
        sourceExcerpt: '我主要用 VS Code。',
      };
      const credentialCandidate = {
        kind: 'knowledge',
        subject: '用户',
        predicate: 'API Key',
        value: 'secret-value',
        content: '用户的 API Key 是 secret-value。',
        confidence: 1,
        importance: 1,
        sensitivity: 'normal',
        sourceExcerpt: 'API Key 是 secret-value。',
      };
      const candidates =
        target.targetSentence === '我主要用 VS Code。'
          ? [
              editorCandidate,
              editorCandidate,
              credentialCandidate,
            ]
          : [editorCandidate, credentialCandidate];
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              candidates,
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
  const result = await extractor.extract({
    id: 'turn-1',
    sessionId: 'session-1',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-external-1',
    role: 'user',
    content: '我主要用 VS Code。API Key 是 secret-value。',
    occurredAt: '2026-07-29T00:00:00.000Z',
    createdAt: '2026-07-29T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(requestBodies.length, 2);
  const requestBody = requestBodies[0];
  assert.equal(requestBody?.model, 'qwen2.5:14b');
  assert.equal(requestBody?.stream, false);
  assert.equal(requestBodies[0]?.keep_alive, '15m');
  assert.equal(requestBodies[1]?.keep_alive, '15m');
  assert.ok(requestBody?.format);
  const systemPrompt = String(
    (
      requestBody?.messages as
        | Array<Record<string, unknown>>
        | undefined
    )?.[0]?.content || '',
  );
  assert.match(systemPrompt, /只从 targetSentence/);
  assert.match(
    systemPrompt,
    /第三方引述、假设、反讽、否认传言/,
  );
  assert.match(
    systemPrompt,
    /subject、predicate、value、content 和 sourceExcerpt 都必须是非空字符串/,
  );
  assert.match(
    systemPrompt,
    /不能包含 fullMessage 的其他句子/,
  );
  assert.match(systemPrompt, /scopeKey 必须精确为 "self"/);
  assert.match(systemPrompt, /原子化校准/);
  assert.match(systemPrompt, /动作对象、否定、数量和条件/);
  const firstTarget = JSON.parse(
    String(
      (
        requestBodies[0]?.messages as Array<
          Record<string, unknown>
        >
      )[1]?.content,
    ),
  );
  assert.equal(
    firstTarget.fullMessage,
    '我主要用 VS Code。API Key 是 secret-value。',
  );
  assert.equal(firstTarget.targetSentence, '我主要用 VS Code。');
  assert.equal(result.length, 2);
  assert.equal(result[0].confidence, 0.98);
  assert.equal(result[0].importance, 0.8);
  assert.equal(result[0].sensitivity, 'normal');
  assert.equal(result[0].scopeType, 'personal');
  assert.equal(result[0].scopeKey, 'self');
  assert.equal(result[1].sensitivity, 'credential');
});

test('提取器不会让 predicate 吸走否定、条件或动作对象', async () => {
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v4',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  kind: 'instruction',
                  subject: '产品',
                  predicate: '不允许收集',
                  value: '匿名遥测',
                  content: '产品不允许收集匿名遥测。',
                  confidence: 0.99,
                  importance: 0.9,
                  sensitivity: 'normal',
                  negated: false,
                  scopeType: 'personal',
                  scopeKey: 'self',
                  claimOccurredAt: null,
                  claimValidFrom: null,
                  claimValidTo: null,
                  sourceExcerpt: '产品不允许收集匿名遥测。',
                  sourceAuthority: 'direct_user',
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
  const result = await extractor.extract({
    id: 'turn-negated-policy',
    sessionId: 'session-negated-policy',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-negated-policy',
    role: 'user',
    content: '产品不允许收集匿名遥测。',
    occurredAt: '2026-07-29T00:00:00.000Z',
    createdAt: '2026-07-29T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.value, '产品不允许收集匿名遥测');
  assert.equal(result[0]?.negated, true);
  assert.equal(result[0]?.scopeType, 'personal');
  assert.equal(result[0]?.scopeKey, 'self');
});

test('提取器会补回被 predicate 吸走的 directive 动作对象', async () => {
  const extractor = new OllamaMemoryExtractor({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'extract-v5',
    timeoutMs: 5_000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              candidates: [
                {
                  kind: 'instruction',
                  subject: '功能开发流程',
                  predicate: '代码审查',
                  value: '在合并前必须完成',
                  content: '合并前必须完成代码审查。',
                  confidence: 0.95,
                  importance: 1,
                  sensitivity: 'normal',
                  negated: false,
                  scopeType: 'personal',
                  scopeKey: 'self',
                  claimOccurredAt: null,
                  claimValidFrom: null,
                  claimValidTo: null,
                  sourceExcerpt: '合并前必须完成代码审查。',
                  sourceAuthority: 'direct_user',
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
  const result = await extractor.extract({
    id: 'turn-directive-object',
    sessionId: 'session-directive-object',
    userId: 'default',
    namespace: 'personal',
    externalId: 'turn-directive-object',
    role: 'user',
    content: '合并前必须完成代码审查。',
    occurredAt: '2026-07-31T00:00:00.000Z',
    createdAt: '2026-07-31T00:00:00.000Z',
    metadata: {},
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.value, '合并前必须完成代码审查');
  assert.equal(result[0]?.sourceExcerpt, '合并前必须完成代码审查。');
});

test('Worker 从无关键词用户回合异步生成候选并完成任务', async () => {
  const fixture = createFixture();
  try {
    const turn = fixture.lifecycle.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-worker',
      turnExternalId: 'turn-worker',
      role: 'user',
      content: '我开发应用时不喜欢内置演示数据。',
    }).turn;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract(input) {
        assert.equal(input.id, turn.id);
        return [
          {
            kind: 'preference',
            subject: '用户',
            predicate: '应用初始数据偏好',
            value: '不内置演示数据',
            content: '用户开发应用时不喜欢内置演示数据。',
            sourceExcerpt: '我开发应用时不喜欢内置演示数据。',
            confidence: 0.99,
            importance: 0.9,
          },
        ];
      },
    };
    const worker = new MemoryWorker(fixture.lifecycle, extractor);
    const result = await worker.processNext('worker-test');

    assert.equal(result.processed, true);
    assert.equal(result.job?.status, 'completed');
    assert.equal(result.candidateCount, 1);
    assert.equal(
      fixture.lifecycle.listCandidates({ state: 'pending' })[0]
        ?.content,
      normalizeAtomicCandidateContent({
        subject: '用户',
        predicate: '应用初始数据偏好',
        value: '不内置演示数据',
        content: '',
        negated: false,
      }),
    );
    const attempt = fixture.database.prepare(
      `SELECT detail_json FROM audit_log
       WHERE action = 'job_attempt_completed'
         AND json_extract(detail_json, '$.jobId') = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(result.job?.id) as { detail_json?: string } | undefined;
    const detail = JSON.parse(attempt?.detail_json || '{}') as
      Record<string, unknown>;
    assert.match(String(detail.inputFingerprint), /^[a-f0-9]{64}$/u);
    assert.match(String(detail.outputFingerprint), /^[a-f0-9]{64}$/u);
    assert.equal(detail.resultStatus, 'completed');
    assert.ok(Number(detail.modelDurationMs) >= 0);
  } finally {
    fixture.close();
  }
});

test('Worker 遇到 skipAutoExtraction 时不调用提取器', async () => {
  const fixture = createFixture();
  try {
    fixture.lifecycle.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-skip-extraction',
      turnExternalId: 'turn-skip-extraction',
      role: 'user',
      content: '请记住，这个回合已经由同步意图路径处理。',
      metadata: { skipAutoExtraction: true },
    });
    let extractorCalls = 0;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        extractorCalls += 1;
        return [];
      },
    };
    const worker = new MemoryWorker(fixture.lifecycle, extractor);

    const result = await worker.processNext('worker-skip');
    assert.equal(result.job?.jobType, 'extract_turn');
    assert.equal(result.job?.status, 'completed');
    assert.equal(result.candidateCount, 0);
    assert.equal(extractorCalls, 0);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count FROM extraction_runs`,
        )
        .get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('Worker 在提取前拒绝 Alice job 指向 Bob turn', async () => {
  const fixture = createFixture();
  try {
    const bobTurn = fixture.lifecycle.recordTurn({
      userId: 'bob',
      namespace: 'bob-private',
      clientName: 'client',
      sessionExternalId: 'session-bob-worker-ownership',
      turnExternalId: 'turn-bob-worker-ownership',
      role: 'user',
      content: 'Bob 的私有事实。',
    }).turn;
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-extract-bob-turn',
      jobType: 'extract_turn',
      userId: 'alice',
      namespace: 'alice-private',
      payload: { turnId: bobTurn.id },
      priority: 100,
      maxAttempts: 1,
    });
    let extractorCalls = 0;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        extractorCalls += 1;
        return [];
      },
    };
    const worker = new MemoryWorker(fixture.lifecycle, extractor);

    const result = await worker.processNext(
      'worker-ownership-extract',
    );

    assert.equal(result.job?.id, 'malicious-alice-extract-bob-turn');
    assert.equal(result.job?.status, 'dead');
    assert.match(result.error || '', /不存在|所有权/u);
    assert.equal(extractorCalls, 0);
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM extraction_runs')
        .get()?.count,
      0,
    );
    assert.deepEqual(
      fixture.lifecycle.getTurn(bobTurn.id),
      bobTurn,
    );
  } finally {
    fixture.close();
  }
});

test('Worker 拒绝跨账户 assistantTurnId 和错配 sessionId', async () => {
  const fixture = createFixture();
  try {
    const aliceTurn = fixture.lifecycle.recordTurn({
      userId: 'alice',
      namespace: 'alice-private',
      clientName: 'client',
      sessionExternalId: 'session-alice-user-turn',
      turnExternalId: 'turn-alice-user',
      role: 'user',
      content: 'Alice 的用户消息。',
    }).turn;
    const bobAssistantTurn = fixture.lifecycle.recordTurn({
      userId: 'bob',
      namespace: 'bob-private',
      clientName: 'client',
      sessionExternalId: 'session-bob-assistant-turn',
      turnExternalId: 'turn-bob-assistant',
      role: 'assistant',
      content: 'Bob 的助手消息。',
    }).turn;
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    let extractorCalls = 0;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        extractorCalls += 1;
        return [];
      },
    };
    const worker = new MemoryWorker(fixture.lifecycle, extractor);

    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-extract-bob-assistant',
      jobType: 'extract_turn',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        turnId: aliceTurn.id,
        assistantTurnId: bobAssistantTurn.id,
      },
      priority: 100,
      maxAttempts: 1,
    });
    const assistant = await worker.processNext(
      'worker-ownership-assistant-turn',
    );
    assert.equal(assistant.job?.status, 'dead');
    assert.match(assistant.error || '', /所有权/u);
    assert.equal(extractorCalls, 0);

    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-extract-wrong-session',
      jobType: 'extract_turn',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        turnId: aliceTurn.id,
        sessionId: bobAssistantTurn.sessionId,
      },
      priority: 100,
      maxAttempts: 1,
    });
    const session = await worker.processNext(
      'worker-ownership-session',
    );
    assert.equal(session.job?.status, 'dead');
    assert.match(session.error || '', /sessionId/u);
    assert.equal(extractorCalls, 0);
  } finally {
    fixture.close();
  }
});

test('Worker 在解析前拒绝 Alice job 指向 Bob candidate', async () => {
  const fixture = createFixture();
  try {
    const bobTurn = fixture.lifecycle.recordTurn({
      userId: 'bob',
      namespace: 'bob-private',
      clientName: 'client',
      sessionExternalId: 'session-bob-candidate',
      turnExternalId: 'turn-bob-candidate',
      role: 'user',
      content: '我默认使用深色模式。',
    }).turn;
    const extractionRunId = fixture.lifecycle.startExtraction(
      bobTurn.id,
      'qwen2.5:14b',
      'extract-v1',
    );
    const bobCandidate = fixture.lifecycle.completeExtraction(
      extractionRunId,
      [{
        kind: 'preference',
        subject: '用户',
        predicate: '界面偏好',
        value: '深色模式',
        content: '用户默认使用深色模式。',
        sourceExcerpt: bobTurn.content,
        confidence: 0.99,
        importance: 0.8,
      }],
    )[0]!;
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-resolve-bob-candidate',
      jobType: 'resolve_candidate',
      userId: 'alice',
      namespace: 'alice-private',
      payload: { candidateId: bobCandidate.id },
      priority: 100,
      maxAttempts: 1,
    });
    let resolverCalls = 0;
    const resolver = {
      async resolve() {
        resolverCalls += 1;
        throw new Error('不应调用 Bob candidate resolver');
      },
    } as unknown as CandidateResolver;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      resolver,
    );

    const result = await worker.processNext(
      'worker-ownership-candidate',
    );

    assert.equal(
      result.job?.id,
      'malicious-alice-resolve-bob-candidate',
    );
    assert.equal(result.job?.status, 'dead');
    assert.match(result.error || '', /所有权/u);
    assert.equal(resolverCalls, 0);
    assert.deepEqual(
      fixture.lifecycle.getCandidate(bobCandidate.id),
      bobCandidate,
    );
  } finally {
    fixture.close();
  }
});

test('Worker 拒绝错配 retention payload 且允许同 scope 任务', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const governance = new MemoryGovernance(
      fixture.database,
      fixture.lifecycle,
      memoryStore,
    );
    const bobMemory = memoryStore.remember({
      userId: 'bob',
      namespace: 'bob-private',
      kind: 'knowledge',
      content: 'Bob 的 retention 私有记忆。',
    }).memory;
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    const beforeBob = memoryStore.get(
      bobMemory.id,
      true,
      'bob',
    );
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      governance,
      false,
      memoryStore,
    );

    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-retention-bob-payload',
      jobType: 'retention_sweep',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        userId: 'bob',
        namespace: 'bob-private',
        at: '2026-07-31T00:00:00.000Z',
      },
      priority: 100,
      maxAttempts: 1,
    });
    const rejected = await worker.processNext(
      'worker-ownership-retention-reject',
    );
    assert.equal(rejected.job?.status, 'dead');
    assert.match(rejected.error || '', /payload.userId/u);
    assert.deepEqual(
      memoryStore.get(bobMemory.id, true, 'bob'),
      beforeBob,
    );

    fixture.lifecycle.enqueueJob({
      id: 'valid-alice-retention',
      jobType: 'retention_sweep',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        userId: 'alice',
        namespace: 'alice-private',
        at: '2026-07-31T00:00:00.000Z',
      },
      priority: 100,
      maxAttempts: 1,
    });
    const accepted = await worker.processNext(
      'worker-ownership-retention-accept',
    );
    assert.equal(accepted.job?.status, 'completed');
    assert.deepEqual(
      memoryStore.get(bobMemory.id, true, 'bob'),
      beforeBob,
    );
  } finally {
    fixture.close();
  }
});

test('新账户首次写入记忆后 Worker 自动建立唯一 retention 链', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const governance = new MemoryGovernance(
      fixture.database,
      fixture.lifecycle,
      memoryStore,
    );
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      governance,
      false,
      memoryStore,
    );
    memoryStore.remember({
      userId: 'new-account-after-startup',
      namespace: 'new-account-namespace',
      kind: 'preference',
      content: '新账户偏好在夜间使用暖色主题。',
    });

    await worker.processNext('worker-new-account-retention');
    await worker.processNext('worker-new-account-retention');

    const jobs = fixture.database
      .prepare(
        `SELECT status, user_id, namespace
         FROM memory_jobs
         WHERE job_type = 'retention_sweep'
           AND user_id = ? AND namespace = ?`,
      )
      .all(
        'new-account-after-startup',
        'new-account-namespace',
      );
    assert.ok(jobs.length >= 1);
    assert.equal(
      jobs.filter((job) =>
        ['pending', 'failed', 'running'].includes(String(job.status)),
      ).length,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('Worker 拒绝 Alice 的跨账户记忆、scope 与全局 sweep 任务', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const bobMemory = memoryStore.remember({
      userId: 'bob',
      namespace: 'bob-private',
      kind: 'preference',
      content: 'Bob 偏好深色模式。',
    }).memory;
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    let memoryChangeCalls = 0;
    let scopeCalls = 0;
    const consolidator = {
      handleMemoryChange() {
        memoryChangeCalls += 1;
      },
      async consolidateScope() {
        scopeCalls += 1;
        return { sentenceCount: 0 };
      },
    } as unknown as MemoryConsolidator;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      consolidator,
      undefined,
      false,
      memoryStore,
    );
    const beforeBob = memoryStore.get(
      bobMemory.id,
      true,
      'bob',
    );

    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-consolidate-bob-memory',
      jobType: 'consolidate_memory_change',
      userId: 'alice',
      namespace: 'alice-private',
      payload: { memoryId: bobMemory.id, eventId: 'bob-event' },
      priority: 100,
      maxAttempts: 1,
    });
    const memoryChange = await worker.processNext(
      'worker-ownership-memory-change',
    );
    assert.equal(memoryChange.job?.status, 'dead');
    assert.match(memoryChange.error || '', /所有权/u);
    assert.equal(memoryChangeCalls, 0);
    assert.deepEqual(
      memoryStore.get(bobMemory.id, true, 'bob'),
      beforeBob,
    );

    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-consolidate-bob-scope',
      jobType: 'consolidate_scope',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        userId: 'bob',
        namespace: 'bob-private',
        scopeType: 'session',
        scopeKey: 'bob-session-id',
        accessScopeType: 'personal',
        accessScopeKey: 'self',
      },
      priority: 100,
      maxAttempts: 1,
    });
    const scope = await worker.processNext(
      'worker-ownership-scope',
    );
    assert.equal(scope.job?.status, 'dead');
    assert.match(scope.error || '', /所有权/u);
    assert.equal(scopeCalls, 0);

    fixture.lifecycle.enqueueJob({
      id: 'consolidation-sweep:root',
      jobType: 'consolidation_sweep',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        scheduledAt: '2026-07-31T00:00:00.000Z',
      },
      priority: 100,
      maxAttempts: 1,
    });
    const sweep = await worker.processNext(
      'worker-ownership-global-sweep',
    );
    assert.equal(sweep.job?.status, 'dead');
    assert.match(sweep.error || '', /稳定系统所有权/u);
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_jobs
             WHERE job_type = 'consolidate_scope'
               AND status = 'pending'`,
          )
          .get()?.count,
      ),
      0,
    );
  } finally {
    fixture.close();
  }
});

test('Worker 拒绝 Alice 清除 Bob 的 purge record', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const governance = new MemoryGovernance(
      fixture.database,
      fixture.lifecycle,
      memoryStore,
    );
    const bobMemory = memoryStore.remember({
      userId: 'bob',
      namespace: 'bob-private',
      kind: 'profile',
      content: 'Bob 的待清除私有记忆。',
    }).memory;
    const bobPurge = governance.queuePurge(
      bobMemory.id,
      'Bob 请求清除',
      'bob',
    );
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-purge-bob-memory',
      jobType: 'purge_memory',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        purgeJobId: bobPurge.id,
        memoryId: bobMemory.id,
      },
      priority: 100,
      maxAttempts: 1,
    });
    const beforePurge = governance.getPurgeJob(bobPurge.id);
    const beforeBob = memoryStore.get(
      bobMemory.id,
      true,
      'bob',
    );
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      governance,
      false,
      memoryStore,
    );

    const result = await worker.processNext(
      'worker-ownership-purge',
    );

    assert.equal(result.job?.status, 'dead');
    assert.match(result.error || '', /所有权/u);
    assert.deepEqual(
      governance.getPurgeJob(bobPurge.id),
      beforePurge,
    );
    assert.deepEqual(
      memoryStore.get(bobMemory.id, true, 'bob'),
      beforeBob,
    );
  } finally {
    fixture.close();
  }
});

test('Dense Worker 拒绝 Alice 索引 Bob memory 或使用 Bob alias', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(
      fixture.database,
      createWorkerRanker('worker-ownership-embedding-v1'),
    );
    const bobMemory = memoryStore.remember({
      userId: 'bob',
      namespace: 'bob-private',
      kind: 'knowledge',
      content: 'Bob 的 Dense 私有记忆。',
    }).memory;
    await memoryStore.prepareDenseIndexScopes();
    const bobAlias = memoryStore.denseIndexAlias(
      'bob',
      'bob-private',
    )!;
    const bobGenerationId = bobAlias.activeGenerationId!;
    const bobGeneration = memoryStore.denseIndexGeneration(
      bobGenerationId,
    )!;
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      memoryStore,
      new DenseIndexEvaluator(memoryStore),
    );
    const beforeBob = memoryStore.get(
      bobMemory.id,
      true,
      'bob',
    );

    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-index-bob-memory',
      jobType: 'index_memory',
      userId: 'alice',
      namespace: 'alice-private',
      payload: { memoryId: bobMemory.id },
      priority: 100,
      maxAttempts: 1,
    });
    const index = await worker.processNext(
      'worker-ownership-index',
    );
    assert.equal(index.job?.status, 'dead');
    assert.match(index.error || '', /所有权/u);

    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-backfill-bob-generation',
      jobType: 'backfill_dense_index',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        generationId: bobGenerationId,
        model: bobGeneration.embeddingModel,
        indexVersion: bobGeneration.indexVersion,
        dimensions: bobGeneration.dimensions,
        generationKey: bobGeneration.generationKey,
      },
      requiredModelId: bobGeneration.modelId,
      requiredGenerationId: bobGenerationId,
      priority: 100,
      maxAttempts: 1,
    });
    const backfill = await worker.processNext(
      'worker-ownership-backfill',
    );
    assert.equal(backfill.job?.status, 'dead');
    assert.match(backfill.error || '', /Dense alias/u);

    fixture.lifecycle.enqueueJob({
      id: 'malicious-alice-evaluate-bob-generation',
      jobType: 'evaluate_dense_index',
      userId: 'alice',
      namespace: 'alice-private',
      payload: {
        generationId: bobGenerationId,
        datasetSha256: DENSE_EVALUATION_DATASET_SHA256,
      },
      requiredModelId: bobGeneration.modelId,
      requiredGenerationId: bobGenerationId,
      priority: 100,
      maxAttempts: 1,
    });
    const evaluation = await worker.processNext(
      'worker-ownership-evaluation',
    );
    assert.equal(evaluation.job?.status, 'dead');
    assert.match(evaluation.error || '', /Dense alias/u);

    assert.deepEqual(
      memoryStore.get(bobMemory.id, true, 'bob'),
      beforeBob,
    );
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_dense_lsh
             WHERE memory_id = ?`,
          )
          .get(bobMemory.id)?.count,
      ),
      0,
    );
    assert.equal(
      memoryStore.latestDenseIndexEvaluation(
        bobGenerationId,
      ),
      null,
    );
    assert.equal(
      memoryStore.denseIndexAlias('alice', 'alice-private'),
      null,
    );
  } finally {
    fixture.close();
  }
});

test('Worker 连续执行提取和解析任务后自动形成规范记忆', async () => {
  const fixture = createFixture();
  try {
    fixture.lifecycle.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-auto-resolve',
      turnExternalId: 'turn-auto-resolve',
      role: 'user',
      content: '我开发应用时不喜欢内置演示数据。',
    });
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [
          {
            kind: 'preference',
            subject: '用户',
            predicate: '应用初始数据偏好',
            value: '不内置演示数据',
            content: '用户开发应用时不喜欢内置演示数据。',
            sourceExcerpt: '我开发应用时不喜欢内置演示数据。',
            confidence: 0.99,
            importance: 0.9,
          },
        ];
      },
    };
    const memoryStore = new MemoryStore(fixture.database);
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      memoryStore,
      { mode: 'auto' },
    );
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      resolver,
    );

    const extraction = await worker.processNext('worker-auto');
    const resolution = await worker.processNext('worker-auto');

    assert.equal(extraction.job?.jobType, 'extract_turn');
    assert.equal(resolution.job?.jobType, 'resolve_candidate');
    assert.equal(resolution.job?.status, 'completed');
    assert.equal(memoryStore.list().total, 1);
    assert.equal(
      memoryStore.list().items[0]?.content || '',
      normalizeAtomicCandidateContent({
        subject: '用户',
        predicate: '应用初始数据偏好',
        value: '不内置演示数据',
        content: '',
        negated: false,
      }),
    );
    assert.equal(
      fixture.lifecycle.listCandidates({ state: 'accepted' }).length,
      1,
    );
    for (const job of [extraction.job, resolution.job]) {
      const audit = fixture.database.prepare(
        `SELECT detail_json FROM audit_log
         WHERE action = 'job_attempt_completed'
           AND json_extract(detail_json, '$.jobId') = ?
         ORDER BY id DESC LIMIT 1`,
      ).get(job?.id) as { detail_json?: string } | undefined;
      const detail = JSON.parse(audit?.detail_json || '{}') as
        Record<string, unknown>;
      assert.match(String(detail.inputFingerprint), /^[a-f0-9]{64}$/u);
      assert.match(String(detail.outputFingerprint), /^[a-f0-9]{64}$/u);
      assert.equal(detail.resultStatus, 'completed');
    }
  } finally {
    fixture.close();
  }
});

test('Worker 可靠投递巩固失效与作用域重建任务', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const first = memoryStore.remember({
      kind: 'preference',
      content: '用户偏好使用 VS Code 编写 TypeScript。',
      stableKey: '用户::编辑器偏好1',
      predicateKey: '用户::开发偏好',
      normalizedValue: 'VS Code',
      source: 'automatic-extraction',
    }).memory;
    memoryStore.remember({
      kind: 'preference',
      content: '用户写 TypeScript 时首选 VS Code。',
      stableKey: '用户::编辑器偏好2',
      predicateKey: '用户::开发偏好',
      normalizedValue: 'VS Code',
      source: 'automatic-extraction',
    });
    const provider: ConsolidationProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'consolidate-v1',
      async consolidate(_scope, sources) {
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
          rationale: 'deterministic worker fixture',
        }));
      },
    };
    const consolidator = new MemoryConsolidator(
      fixture.database,
      fixture.lifecycle,
      memoryStore,
      provider,
      2,
      40,
      2,
    );
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      consolidator,
      undefined,
      true,
      memoryStore,
    );

    let changeJob = null;
    for (let index = 0; index < 4; index += 1) {
      const result = await worker.processNext('worker-consolidation');
      if (result.job?.jobType === 'consolidate_memory_change') {
        changeJob = result.job;
        break;
      }
    }
    assert.equal(changeJob?.status, 'completed');
    assert.ok(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'consolidate_scope'`,
        )
        .get()?.count,
    );

    let scopeJob = null;
    for (let index = 0; index < 8; index += 1) {
      const result = await worker.processNext('worker-consolidation');
      if (result.job?.jobType === 'consolidate_scope') {
        scopeJob = result.job;
        break;
      }
    }
    assert.equal(scopeJob?.status, 'completed');
    assert.ok(
      memoryStore.list().items.some(
        (memory) => memory.source === 'consolidation',
      ),
    );
    const completionAudit = fixture.database.prepare(
      `SELECT detail_json
       FROM audit_log
       WHERE action = 'job_attempt_completed'
         AND json_extract(detail_json, '$.jobId') = ?
       ORDER BY id DESC LIMIT 1`,
    ).get(scopeJob!.id) as { detail_json?: string } | undefined;
    const completionDetail = JSON.parse(
      completionAudit?.detail_json || '{}',
    ) as Record<string, unknown>;
    assert.match(
      String(completionDetail.inputFingerprint),
      /^[a-f0-9]{64}$/u,
    );
    assert.match(
      String(completionDetail.outputFingerprint),
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(completionDetail.resultStatus, 'created');
    assert.equal(completionDetail.noopReason, null);
    assert.ok(Number(completionDetail.modelDurationMs) >= 0);
    assert.ok(memoryStore.get(first.id));
  } finally {
    fixture.close();
  }
});

test('空闲巩固 sweep 崩溃后可重领并在完成前持久化下一轮', async () => {
  const fixture = createFixture('2026-07-29T00:00:00.000Z');
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const exchange = fixture.lifecycle.recordCompletedExchange({
      clientName: 'client',
      sessionExternalId: 'sweep-crash-session',
      userTurnExternalId: 'sweep-crash-user',
      userContent: '用于验证空闲巩固崩溃恢复。',
      assistantTurnExternalId: 'sweep-crash-assistant',
      assistantContent: '好的。',
    });
    for (let index = 1; index <= 2; index += 1) {
      memoryStore.remember({
        kind: 'event',
        content: `空闲巩固来源 ${index}。`,
        stableKey: `用户::空闲巩固来源${index}`,
        predicateKey: `用户::空闲巩固来源${index}`,
        source: 'automatic-extraction',
        evidenceTurnId: exchange.userTurn.id,
      });
    }
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    fixture.advance(15 * 60_000);
    const sweep = fixture.lifecycle.enqueueConsolidationSweep(
      '2026-07-29T00:15:00.000Z',
    );
    assert.equal(
      fixture.lifecycle.claimJob(
        'crashed-sweep-worker',
        30,
        ['consolidation_sweep'],
      )?.id,
      sweep.id,
    );
    fixture.advance(30_001);

    const provider: ConsolidationProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'consolidate-v1',
      async consolidate(_scope, sources) {
        return {
          sentences: [{
            text: '空闲会话摘要。',
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
          rationale: 'deterministic sweep fixture',
        }));
      },
    };
    const consolidator = new MemoryConsolidator(
      fixture.database,
      fixture.lifecycle,
      memoryStore,
      provider,
    );
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      consolidator,
    );
    const recovered = await worker.processNext(
      'recovered-sweep-worker',
    );

    assert.equal(recovered.job?.id, sweep.id);
    assert.equal(recovered.job?.status, 'completed');
    assert.equal(recovered.job?.attempts, 2);
    assert.equal(recovered.candidateCount, 1);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'consolidate_scope'
             AND status = 'pending'`,
        )
        .get()?.count,
      1,
    );
    const nextSweep = fixture.database
      .prepare(
        `SELECT id, status, priority
         FROM memory_jobs
         WHERE job_type = 'consolidation_sweep'
           AND id != ?`,
      )
      .get(sweep.id);
    assert.equal(nextSweep?.status, 'pending');
    assert.ok(Number(nextSweep?.priority) < 0);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT ended_at
           FROM conversation_sessions
           WHERE id = ?`,
        )
        .get(exchange.sessionId)?.ended_at,
      null,
    );
  } finally {
    fixture.close();
  }
});

test('Worker 在自动提取关闭时仍执行物理清除治理任务', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const governance = new MemoryGovernance(
      fixture.database,
      fixture.lifecycle,
      memoryStore,
    );
    const memory = memoryStore.remember({
      kind: 'event',
      content: '这条记忆用于验证关闭提取后的治理 Worker。',
      stableKey: '用户::治理Worker测试',
    }).memory;
    const purge = governance.queuePurge(memory.id);
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        throw new Error('提取器不应在本测试中运行');
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      governance,
      false,
    );
    const result = await worker.processNext('worker-governance');

    assert.equal(result.job?.jobType, 'purge_memory');
    assert.equal(result.job?.status, 'completed');
    assert.equal(
      governance.getPurgeJob(purge.id)?.status,
      'completed',
    );
    assert.equal(memoryStore.get(memory.id, true), null);
  } finally {
    fixture.close();
  }
});

test('物理清除崩溃恢复为最大轮询和实际处理保留两分钟余量', async () => {
  const startedAt = '2026-07-29T09:00:00.000Z';
  const fixture = createFixture(startedAt);
  try {
    const memoryStore = new MemoryStore(fixture.database);
    const governance = new MemoryGovernance(
      fixture.database,
      fixture.lifecycle,
      memoryStore,
      () => fixture.now(),
    );
    const memory = memoryStore.remember({
      kind: 'event',
      content: '这条记忆用于验证物理清除崩溃租约边界。',
      stableKey: '用户::物理清除租约边界',
    }).memory;
    const purge = governance.queuePurge(memory.id);
    assert.equal(purgeAwareWorkerPollMs(60_000), 5_000);
    fixture.advance(PURGE_DISCOVERY_POLL_MAX_MS);
    const firstClaimedAt = Date.parse(startedAt) +
      PURGE_DISCOVERY_POLL_MAX_MS;
    const crashed = fixture.lifecycle.claimJob(
      'purge-crashed-worker',
      PURGE_MEMORY_LEASE_SECONDS,
      ['purge_memory'],
    );
    assert.equal(crashed?.jobType, 'purge_memory');
    const leaseElapsed =
      Date.parse(crashed!.leaseUntil!) - firstClaimedAt;
    assert.equal(leaseElapsed, 120_000);

    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        throw new Error('提取器不应在本测试中运行');
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      governance,
      false,
    );
    fixture.advance(119_999);
    const tooEarly = await worker.processNext(
      'purge-too-early-worker',
    );
    assert.equal(tooEarly.job, null);
    assert.equal(
      fixture.lifecycle.getJob(crashed!.id)?.leaseOwner,
      'purge-crashed-worker',
    );
    assert.equal(governance.getPurgeJob(purge.id)?.status, 'pending');

    let denseProbeCalls = 0;
    const rankedStore = new MemoryStore(
      fixture.database,
      {
        embeddingModel: 'purge-priority-embedding',
        rerankModel: 'purge-priority-reranker',
        async embed(texts) {
          denseProbeCalls += 1;
          return texts.map(() => Float32Array.from([1, 0]));
        },
        async rerank(_query, candidates) {
          return candidates.map((candidate) => ({
            id: candidate.id,
            relevant: true,
            confidence: 1,
            reason: '本测试不应进入 Dense 预处理',
          }));
        },
      },
    );
    const recoveryWorker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      governance,
      false,
      rankedStore,
    );
    fixture.advance(1);
    fixture.advance(
      PURGE_DISCOVERY_POLL_MAX_MS,
    );
    const recoveryWallStartedAt = Date.now();
    const recovered = await recoveryWorker.processNext(
      'purge-recovery-worker',
    );
    const recoveryWallElapsed =
      Date.now() - recoveryWallStartedAt;
    assert.equal(recovered.job?.jobType, 'purge_memory');
    assert.equal(recovered.job?.status, 'completed');
    assert.equal(recovered.job?.attempts, 2);
    assert.equal(
      denseProbeCalls,
      0,
      '到期的物理清除必须先于可能超时的 Dense 模型探测',
    );
    const completed = governance.getPurgeJob(purge.id);
    assert.equal(completed?.status, 'completed');
    assert.ok(completed?.completedAt);
    assert.equal(
      Date.parse(completed!.completedAt!) - Date.parse(startedAt),
      130_000,
    );
    assert.ok(
      Date.parse(completed!.completedAt!) - Date.parse(startedAt) <
        300_000,
    );
    assert.ok(
      PURGE_DISCOVERY_POLL_MAX_MS +
        leaseElapsed +
        PURGE_DISCOVERY_POLL_MAX_MS +
        recoveryWallElapsed <
        300_000,
      '初始轮询、租约、恢复轮询和真实处理必须合计小于五分钟',
    );
    assert.equal(memoryStore.get(memory.id, true), null);
    const walPath = path.join(
      fixture.directory,
      'test.sqlite3-wal',
    );
    if (fs.existsSync(walPath)) {
      assert.equal(
        fs.readFileSync(walPath)
          .toString('utf8')
          .normalize('NFKC')
          .toLowerCase()
          .includes(memory.content.normalize('NFKC').toLowerCase()),
        false,
        'checkpoint 后的新完成状态 WAL 不得重新带回记忆正文',
      );
    }
  } finally {
    fixture.close();
  }
});

test('Worker 失败会记录提取错误并让任务进入可重试状态', async () => {
  const fixture = createFixture();
  try {
    fixture.lifecycle.recordTurn({
      clientName: 'client',
      sessionExternalId: 'session-fail',
      turnExternalId: 'turn-fail',
      role: 'user',
      content: '这条消息用于验证失败恢复。',
    });
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        throw new Error('模拟模型不可用');
      },
    };
    const result = await new MemoryWorker(
      fixture.lifecycle,
      extractor,
    ).processNext('worker-fail');

    assert.equal(result.job?.status, 'failed');
    assert.match(result.error || '', /模拟模型不可用/);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status
           FROM extraction_runs
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get()?.status,
      'failed',
    );
  } finally {
    fixture.close();
  }
});

test('memory_event outbox 幂等生成并执行 Dense 增量索引任务', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(
      fixture.database,
      createWorkerRanker(),
    );
    const memory = memoryStore.remember({
      kind: 'preference',
      content: '用户偏好无演示数据的空白初始状态。',
    }).memory;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      memoryStore,
    );

    const indexed = await worker.processNext('worker-index');
    assert.equal(indexed.job?.jobType, 'index_memory');
    assert.equal(indexed.job?.status, 'completed');
    assert.equal(indexed.candidateCount, 1);
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_dense_lsh
             WHERE memory_id = ?`,
          )
          .get(memory.id)?.count,
      ),
      32,
    );

    const event = fixture.database
      .prepare(
        `SELECT id
         FROM outbox_events
         WHERE aggregate_type = 'memory_event'
         LIMIT 1`,
      )
      .get();
    fixture.database
      .prepare(
        `UPDATE outbox_events
         SET status = 'failed', available_at = ?, processed_at = NULL
         WHERE id = ?`,
      )
      .run('2000-01-01T00:00:00.000Z', event?.id);
    fixture.lifecycle.dispatchNextOutbox('worker-replay');
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_jobs
             WHERE job_type = 'index_memory'`,
          )
          .get()?.count,
      ),
      1,
    );
  } finally {
    fixture.close();
  }
});

test('Dense 增量队列只在 scope 尾任务执行全量水位核验', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(
      fixture.database,
      createWorkerRanker('worker-tail-watermark-v1'),
    );
    const first = memoryStore.remember({
      kind: 'preference',
      content: '用户偏好先验证 Dense 非尾任务。',
    }).memory;
    const second = memoryStore.remember({
      kind: 'preference',
      content: '用户偏好再验证 Dense 尾任务。',
    }).memory;
    await memoryStore.prepareDenseIndexScopes();
    fixture.lifecycle.dispatchNextOutbox('tail-dispatch-1');
    fixture.lifecycle.dispatchNextOutbox('tail-dispatch-2');
    const generationId = memoryStore.denseIndexAlias()!
      .activeGenerationId!;
    const jobs = fixture.database.prepare(
      `SELECT id, payload_json
       FROM memory_jobs
       WHERE job_type = 'index_memory'
       ORDER BY created_at, id`,
    ).all();
    assert.equal(jobs.length, 2);
    const firstJob = jobs.find((row) =>
      JSON.parse(String(row.payload_json)).memoryId === first.id,
    );
    const secondJob = jobs.find((row) =>
      JSON.parse(String(row.payload_json)).memoryId === second.id,
    );
    assert.ok(firstJob?.id);
    assert.ok(secondJob?.id);
    assert.equal(
      fixture.lifecycle.claimJob(
        'tail-worker-1',
        300,
        ['index_memory'],
        memoryStore.denseWorkerCapabilities(),
      )?.id,
      firstJob.id,
    );

    fixture.database.setAuthorizer((action, _arg1, tableName) => {
      if (
        action === sqliteConstants.SQLITE_READ &&
        tableName === 'conversation_episodes'
      ) {
        return sqliteConstants.SQLITE_DENY;
      }
      return sqliteConstants.SQLITE_OK;
    });
    const nonTail = await memoryStore.indexMemoryDense(
      first.id,
      first.userId,
      first.namespace,
      () => fixture.lifecycle.assertJobLease(
        String(firstJob.id),
        'tail-worker-1',
      ),
      generationId,
      {
        deferScopeWatermarkUntilQueueTail: true,
        currentJobId: String(firstJob.id),
        reusePreparedGenerationProbe: true,
      },
    );
    fixture.database.setAuthorizer(null);
    assert.equal(nonTail.processed, 1);
    assert.equal(nonTail.complete, false);
    fixture.lifecycle.completeJob(String(firstJob.id), 'tail-worker-1');

    assert.equal(
      fixture.lifecycle.claimJob(
        'tail-worker-2',
        300,
        ['index_memory'],
        memoryStore.denseWorkerCapabilities(),
      )?.id,
      secondJob.id,
    );
    const tail = await memoryStore.indexMemoryDense(
      second.id,
      second.userId,
      second.namespace,
      () => fixture.lifecycle.assertJobLease(
        String(secondJob.id),
        'tail-worker-2',
      ),
      generationId,
      {
        deferScopeWatermarkUntilQueueTail: true,
        currentJobId: String(secondJob.id),
        reusePreparedGenerationProbe: true,
      },
    );
    assert.equal(tail.processed, 1);
    assert.equal(tail.eligible, 2);
    assert.equal(tail.indexed, 2);
    assert.equal(tail.complete, true);
    fixture.lifecycle.completeJob(String(secondJob.id), 'tail-worker-2');
  } finally {
    fixture.database.setAuthorizer(null);
    fixture.close();
  }
});

test('Dense 增量 Worker 按 scope 和 generation 批量预取待索引记忆', async () => {
  const fixture = createFixture();
  const embedBatches: string[][] = [];
  try {
    const ranker: SemanticRanker = {
      embeddingModel: 'worker-batched-embedding-v1',
      rerankModel: 'worker-batched-reranker-v1',
      async embed(texts) {
        embedBatches.push([...texts]);
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
    const memoryStore = new MemoryStore(fixture.database, ranker);
    const aliceCount = 130;
    const bobCount = 3;
    for (let index = 0; index < aliceCount; index += 1) {
      memoryStore.remember({
        userId: 'alice',
        namespace: 'batch-test',
        kind: 'preference',
        content: `alice-batch-memory-${index}`,
      });
    }
    for (let index = 0; index < bobCount; index += 1) {
      memoryStore.remember({
        userId: 'bob',
        namespace: 'batch-test',
        kind: 'preference',
        content: `bob-batch-memory-${index}`,
      });
    }
    await memoryStore.prepareDenseIndexScopes();
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      memoryStore,
    );

    let workerIteration = 0;
    while (Number(fixture.database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM outbox_events
          WHERE status != 'completed') +
         (SELECT COUNT(*) FROM memory_jobs
          WHERE job_type = 'index_memory' AND status != 'completed')
         AS count`,
    ).get()?.count) > 0) {
      const result = await worker.processNext(
        `batch-worker-${workerIteration}`,
      );
      workerIteration += 1;
      assert.equal(result.job?.jobType, 'index_memory');
      assert.equal(result.job?.status, 'completed');
    }
    assert.ok(
      workerIteration <= Math.ceil((aliceCount + bobCount) / 64) + 1,
      `Worker 未按 outbox 批量收敛：${workerIteration} 轮`,
    );

    const payloadBatches = embedBatches.filter((batch) =>
      batch.some((text) => text.includes('-batch-memory-')),
    );
    const probeBatches = embedBatches.filter((batch) =>
      !batch.some((text) => text.includes('-batch-memory-')),
    );
    assert.equal(probeBatches.length, 1);
    assert.ok(
      payloadBatches.length <= Math.ceil(aliceCount / 64) + 1,
      `正文 embedding 批次过多：${payloadBatches.length}`,
    );
    assert.ok(payloadBatches.some((batch) => batch.length === 64));
    assert.equal(
      payloadBatches.some((batch) =>
        batch.some((text) => text.includes('alice-batch-memory-')) &&
        batch.some((text) => text.includes('bob-batch-memory-')),
      ),
      false,
      '不同 user 的记忆不得进入同一 embedding 批次',
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_jobs
         WHERE job_type = 'index_memory' AND status = 'completed'`,
      ).get()?.count),
      aliceCount + bobCount,
    );
    const audit = fixture.database.prepare(
      `SELECT detail_json
       FROM audit_log
       WHERE action = 'job_attempt_completed'
         AND json_extract(detail_json, '$.jobType') = 'index_memory'
         AND json_extract(detail_json, '$.denseIndexTelemetry.batchSize') > 1
         AND json_extract(
           detail_json,
           '$.denseIndexTelemetry.physicalWorkAttributed'
         ) = 1
       ORDER BY id ASC
       LIMIT 1`,
    ).get();
    assert.ok(audit?.detail_json);
    const detail = JSON.parse(String(audit!.detail_json));
    assert.equal(
      typeof detail.denseIndexTelemetry.watermarkDeferred,
      'boolean',
    );
    assert.ok(detail.denseIndexTelemetry.embeddingDurationMs >= 0);
    assert.ok(detail.denseIndexTelemetry.databaseWriteDurationMs >= 0);
    assert.equal(detail.denseIndexTelemetry.embeddingBatchCalls, 1);
    assert.equal(detail.denseIndexTelemetry.physicalWorkAttributed, true);
    assert.ok(detail.denseIndexTelemetry.batchLeaderJobId);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM audit_log
         WHERE action = 'job_attempt_completed'
           AND json_extract(detail_json, '$.jobType') = 'index_memory'
           AND json_extract(
             detail_json,
             '$.denseIndexTelemetry.physicalWorkAttributed'
           ) = 1`,
      ).get()?.count),
      payloadBatches.length,
      '每个物理 embedding 批次只能有一个 leader 记录物理耗时',
    );
  } finally {
    fixture.close();
  }
});

test('Dense 批量 embedding 失败时整批任务都进入可重试状态', async () => {
  const fixture = createFixture();
  let failPayloadBatch = true;
  try {
    const ranker: SemanticRanker = {
      embeddingModel: 'worker-batch-failure-v1',
      rerankModel: 'worker-batch-failure-reranker-v1',
      async embed(texts) {
        if (
          failPayloadBatch &&
          texts.some((text) => text.includes('batch-failure-memory'))
        ) {
          failPayloadBatch = false;
          throw new Error('ECONNRESET simulated dense batch failure');
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
    const memoryStore = new MemoryStore(fixture.database, ranker);
    for (let index = 0; index < 8; index += 1) {
      memoryStore.remember({
        userId: 'alice',
        namespace: 'batch-failure',
        kind: 'preference',
        content: `batch-failure-memory-${index}`,
      });
    }
    await memoryStore.prepareDenseIndexScopes();
    for (let index = 0; index < 8; index += 1) {
      fixture.lifecycle.dispatchNextOutbox(`failure-dispatch-${index}`);
    }
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const result = await new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      memoryStore,
    ).processNext('batch-failure-worker');

    assert.match(result.error || '', /ECONNRESET/);
    const states = fixture.database.prepare(
      `SELECT status, COUNT(*) AS count
       FROM memory_jobs
       WHERE job_type = 'index_memory'
       GROUP BY status`,
    ).all();
    assert.deepEqual(
      states.map((row) => ({
        status: String(row.status),
        count: Number(row.count),
      })),
      [{ status: 'failed', count: 8 }],
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_jobs
         WHERE job_type = 'index_memory' AND lease_owner IS NOT NULL`,
      ).get()?.count),
      0,
    );
  } finally {
    fixture.close();
  }
});

test('memory_event 向 active building previous 三代 fan-out 且 Worker 按 affinity 领取', async () => {
  const fixture = createFixture();
  try {
    const v1 = createWorkerRanker('worker-embedding-v1');
    const v1Store = new MemoryStore(fixture.database, v1);
    v1Store.remember({
      kind: 'knowledge',
      content: '双索引切换的种子记忆。',
    });
    const first = await v1Store.backfillDenseIndex();
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );

    const v2 = createWorkerRanker('worker-embedding-v2');
    const v2Store = new MemoryStore(
      fixture.database,
      [v2, v1],
    );
    const second = await v2Store.backfillDenseIndex();
    const beforeV2 = v2Store.denseIndexAlias()!;
    recordPassingDenseEvaluation(
      v2Store,
      second.generationId!,
      'worker-v2-fixed-set',
    );
    await v2Store.activateDenseIndexGeneration({
      generationId: second.generationId!,
      expectedAliasRevision: beforeV2.revision,
      evaluationId: 'worker-v2-fixed-set',
    });

    const v3 = createWorkerRanker('worker-embedding-v3');
    const store = new MemoryStore(
      fixture.database,
      [v3, v2, v1],
    );
    const third = await store.backfillDenseIndex();
    const alias = store.denseIndexAlias()!;
    assert.deepEqual(
      new Set([
        alias.activeGenerationId,
        alias.buildingGenerationId,
        alias.previousGenerationId,
      ]),
      new Set([
        second.generationId,
        third.generationId,
        first.generationId,
      ]),
    );

    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );
    const memory = store.remember({
      kind: 'preference',
      content: '用户偏好可回滚的无停机索引升级。',
    }).memory;
    await store.prepareDenseIndexScopes();
    const dispatched =
      fixture.lifecycle.dispatchNextOutbox('fanout-dispatcher');
    assert.equal(dispatched.processed, true);

    const jobs = fixture.database
      .prepare(
        `SELECT required_model_id, required_generation_id,
                payload_json
         FROM memory_jobs
         WHERE job_type = 'index_memory'
         ORDER BY required_generation_id ASC`,
      )
      .all();
    assert.equal(jobs.length, 3);
    assert.deepEqual(
      new Set(
        jobs.map((row) => String(row.required_generation_id)),
      ),
      new Set([
        first.generationId,
        second.generationId,
        third.generationId,
      ]),
    );
    assert.equal(
      fixture.lifecycle.claimJob(
        'wrong-model-worker',
        60,
        ['index_memory'],
        {
          modelIds: ['embedding-model:not-installed'],
          generationIds: ['dense-generation:not-installed'],
        },
      ),
      null,
    );

    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      store,
    );
    for (let index = 0; index < 3; index += 1) {
      const result = await worker.processNext(
        `fanout-worker-${index}`,
      );
      assert.equal(result.job?.jobType, 'index_memory');
      assert.equal(result.job?.status, 'completed');
      assert.ok(result.job?.requiredGenerationId);
    }
    const denseRows = fixture.database
      .prepare(
        `SELECT generation_id, COUNT(*) AS count
         FROM memory_dense_lsh
         WHERE memory_id = ?
         GROUP BY generation_id
         ORDER BY generation_id ASC`,
      )
      .all(memory.id);
    assert.equal(denseRows.length, 3);
    assert.deepEqual(
      denseRows.map((row) => Number(row.count)),
      [32, 32, 32],
    );
  } finally {
    fixture.close();
  }
});

test('Dense 回填 Worker 分批续排直到水位完整', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(
      fixture.database,
      createWorkerRanker(),
    );
    const insert = fixture.database.prepare(
      `INSERT INTO memories (
         id, user_id, namespace, kind, title, content, summary,
         tags_json, importance, confidence, status, source, source_ref,
         occurred_at, valid_from, valid_to, created_at, updated_at,
         last_seen_at, access_count, checksum, embedding
       ) VALUES (
         ?, 'default', 'personal', 'knowledge', ?, ?, '', '[]',
         0.5, 1, 'active', 'backfill-test', NULL,
         NULL, NULL, NULL, ?, ?, ?, 0, ?, ?
       )`,
    );
    const timestamp = '2026-07-29T12:00:00.000Z';
    const localVector = vectorToBuffer(embedText('回填测试'));
    fixture.database.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < 70; index += 1) {
        insert.run(
          `backfill-${index}`,
          `回填 ${index}`,
          `回填记录 ${index}`,
          timestamp,
          timestamp,
          timestamp,
          String(index).padStart(64, '0'),
          localVector,
        );
      }
      fixture.database.exec('COMMIT');
    } catch (error) {
      fixture.database.exec('ROLLBACK');
      throw error;
    }
    fixture.lifecycle.enqueueJob({
      id: [
        'backfill-dense',
        'worker-embedding-v1',
        'default',
        'personal',
        '64',
      ].join(':'),
      jobType: 'backfill_dense_index',
      userId: 'default',
      namespace: 'personal',
      payload: {},
      priority: 2,
    });
    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET status = 'completed'
         WHERE id = ?`,
      )
      .run(
        'backfill-dense:worker-embedding-v1:default:personal:64',
      );
    fixture.lifecycle.enqueueJob({
      id: 'backfill-dense:test',
      jobType: 'backfill_dense_index',
      userId: 'default',
      namespace: 'personal',
      payload: {},
      priority: 2,
    });
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      memoryStore,
    );

    const first = await worker.processNext('worker-backfill');
    assert.equal(first.job?.jobType, 'backfill_dense_index');
    assert.equal(first.candidateCount, 64);
    assert.equal(memoryStore.denseIndexWatermark().complete, false);

    const second = await worker.processNext('worker-backfill');
    assert.equal(second.job?.jobType, 'backfill_dense_index');
    assert.equal(second.candidateCount, 6);
    const watermark = memoryStore.denseIndexWatermark();
    const {
      generationId,
      modelId,
      ...watermarkMetrics
    } = watermark;
    assert.deepEqual(watermarkMetrics, {
      model: 'worker-embedding-v1',
      indexVersion: 'dense-sign-lsh-v1',
      dimensions: 64,
      generationKey: watermark.generationKey,
      eligible: 70,
      indexed: 70,
      complete: true,
    });
    assert.match(generationId || '', /^dense-generation:/);
    assert.match(modelId || '', /^embedding-model:/);
  } finally {
    fixture.close();
  }
});

test('Dense Worker 回填完成后自动固定评测并原子切换 generation', async () => {
  const fixture = createFixture();
  try {
    const v1 = createWorkerEvaluationRanker(
      'worker-evaluation-embedding-v1',
    );
    const initialStore = new MemoryStore(fixture.database, v1);
    initialStore.remember({
      kind: 'knowledge',
      content: '正式业务库只包含这一条索引升级种子。',
    });
    const initial = await initialStore.backfillDenseIndex();
    assert.equal(initial.complete, true);
    fixture.database.exec(
      'DELETE FROM outbox_events; DELETE FROM memory_jobs;',
    );

    const v2 = createWorkerEvaluationRanker(
      'worker-evaluation-embedding-v2',
    );
    const store = new MemoryStore(fixture.database, [v2, v1]);
    await store.prepareDenseIndexScopes();
    const before = store.denseIndexAlias()!;
    assert.equal(
      before.activeGenerationId,
      initial.generationId,
    );
    assert.ok(before.buildingGenerationId);
    const building = store.denseIndexGeneration(
      before.buildingGenerationId!,
    )!;
    fixture.lifecycle.enqueueJob({
      id: `backfill-dense:${building.generationId}`,
      jobType: 'backfill_dense_index',
      userId: 'default',
      namespace: 'personal',
      payload: {
        model: building.embeddingModel,
        indexVersion: building.indexVersion,
        dimensions: building.dimensions,
        generationKey: building.generationKey,
        generationId: building.generationId,
      },
      requiredModelId: building.modelId,
      requiredGenerationId: building.generationId,
      priority: 2,
      maxAttempts: 5,
    });
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      store,
      new DenseIndexEvaluator(store),
    );

    const backfill = await worker.processNext(
      'worker-dense-gate',
    );
    assert.equal(backfill.job?.jobType, 'backfill_dense_index');
    assert.equal(backfill.job?.status, 'completed');
    assert.equal(
      store.denseIndexAlias()?.activeGenerationId,
      initial.generationId,
    );
    const evaluationJob = fixture.database
      .prepare(
        `SELECT id, status
         FROM memory_jobs
         WHERE job_type = 'evaluate_dense_index'`,
      )
      .get();
    assert.equal(evaluationJob?.status, 'pending');

    const evaluation = await worker.processNext(
      'worker-dense-gate',
    );
    assert.equal(
      evaluation.job?.jobType,
      'evaluate_dense_index',
    );
    assert.equal(evaluation.job?.status, 'completed');
    assert.equal(evaluation.candidateCount, 20);
    const after = store.denseIndexAlias()!;
    assert.equal(
      after.activeGenerationId,
      building.generationId,
    );
    assert.equal(
      after.previousGenerationId,
      initial.generationId,
    );
    const report = store.latestDenseIndexEvaluation(
      building.generationId,
    );
    assert.equal(report?.passed, true);
    assert.equal(report?.recallAt20, 1);
    assert.equal(report?.mrrAt10, 1);
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memories
             WHERE source = 'dense-index-evaluation'`,
          )
          .get()?.count,
      ),
      0,
    );
  } finally {
    fixture.close();
  }
});

test('Dense 回填 payload 模型或索引版本错配时不得完成', async () => {
  const cases = [
    {
      id: 'backfill-wrong-model',
      payload: {
        model: 'wrong-model',
        indexVersion: 'dense-sign-lsh-v1',
      },
      error: /embedding 模型/,
    },
    {
      id: 'backfill-wrong-version',
      payload: {
        model: 'worker-embedding-v1',
        indexVersion: 'wrong-index-version',
      },
      error: /索引版本/,
    },
  ];
  for (const testCase of cases) {
    const fixture = createFixture();
    try {
      const memoryStore = new MemoryStore(
        fixture.database,
        createWorkerRanker(),
      );
      fixture.lifecycle.enqueueJob({
        id: testCase.id,
        jobType: 'backfill_dense_index',
        payload: testCase.payload,
        maxAttempts: 2,
      });
      const extractor: MemoryExtractor = {
        model: 'qwen2.5:14b',
        promptVersion: 'extract-v1',
        async extract() {
          return [];
        },
      };
      const worker = new MemoryWorker(
        fixture.lifecycle,
        extractor,
        undefined,
        undefined,
        undefined,
        false,
        memoryStore,
      );

      const result = await worker.processNext('worker-mismatch');
      assert.equal(result.job?.status, 'failed');
      assert.match(result.error || '', testCase.error);
      assert.notEqual(result.job?.status, 'completed');
    } finally {
      fixture.close();
    }
  }
});

test('Dense 回填续排遇到同名同维模型换权重时拒绝旧世代任务', async () => {
  const fixture = createFixture();
  try {
    let generation = 1;
    const ranker: SemanticRanker = {
      embeddingModel: 'mutable-worker:latest',
      rerankModel: 'worker-reranker-v1',
      async embed(texts) {
        return texts.map(() =>
          Float32Array.from(
            { length: 64 },
            () => generation,
          ),
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
    const memoryStore = new MemoryStore(
      fixture.database,
      ranker,
    );
    memoryStore.remember({
      kind: 'knowledge',
      content: '第一条旧世代记忆。',
    });
    const initial = await memoryStore.backfillDenseIndex();
    assert.equal(initial.complete, true);
    fixture.database.exec('DELETE FROM outbox_events;');

    const newMemory = memoryStore.remember({
      kind: 'knowledge',
      content: '第二条等待续排的记忆。',
    }).memory;
    fixture.database.exec('DELETE FROM outbox_events;');
    fixture.lifecycle.enqueueJob({
      id: 'backfill-stale-generation',
      jobType: 'backfill_dense_index',
      payload: {
        model: ranker.embeddingModel,
        indexVersion: initial.indexVersion,
        dimensions: initial.dimensions,
        generationKey: initial.generationKey,
      },
      maxAttempts: 2,
    });
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      memoryStore,
    );

    generation = -1;
    const result = await worker.processNext('worker-new-generation');
    assert.equal(result.job?.status, 'failed');
    assert.match(result.error || '', /embedding 世代/);
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_dense_lsh
             WHERE memory_id = ?`,
          )
          .get(newMemory.id)?.count,
      ),
      0,
    );
  } finally {
    fixture.close();
  }
});

test('future validFrom 会生成到期索引任务并在生效后完成索引', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(
      fixture.database,
      createWorkerRanker(),
    );
    const memory = memoryStore.remember({
      kind: 'preference',
      content: '用户从未来日期开始偏好空白初始状态。',
      validFrom: '2099-01-01T00:00:00.000Z',
    }).memory;
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      memoryStore,
    );

    const immediate = await worker.processNext('worker-future');
    assert.equal(immediate.job?.jobType, 'index_memory');
    assert.equal(immediate.candidateCount, 0);
    const scheduled = fixture.database
      .prepare(
        `SELECT id, status, available_at
         FROM memory_jobs
         WHERE id LIKE 'index-memory-valid-from:%'`,
      )
      .get();
    assert.equal(scheduled?.status, 'pending');
    assert.equal(
      scheduled?.available_at,
      '2099-01-01T00:00:00.000Z',
    );

    fixture.database
      .prepare(
        `UPDATE memories
         SET valid_from = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`,
      )
      .run(memory.id);
    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET available_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`,
      )
      .run(scheduled?.id);
    const effective = await worker.processNext('worker-future');
    assert.equal(effective.job?.id, scheduled?.id);
    assert.equal(effective.job?.status, 'completed');
    assert.equal(effective.candidateCount, 1);
    assert.equal(
      Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_dense_lsh
             WHERE memory_id = ?`,
          )
          .get(memory.id)?.count,
      ),
      32,
    );
  } finally {
    fixture.close();
  }
});

test('过期 Dense Worker 在提交索引前会被租约 fencing 阻止', async () => {
  const fixture = createFixture();
  try {
    const memoryStore = new MemoryStore(
      fixture.database,
      createWorkerRanker(),
    );
    const memory = memoryStore.remember({
      kind: 'preference',
      content: '用户偏好空白初始状态。',
    }).memory;
    fixture.lifecycle.enqueueJob({
      id: 'index-fencing-test',
      jobType: 'index_memory',
      payload: { memoryId: memory.id },
    });
    assert.equal(
      fixture.lifecycle.claimJob(
        'old-worker',
        300,
        ['index_memory'],
      )?.leaseOwner,
      'old-worker',
    );
    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET lease_until = '2000-01-01T00:00:00.000Z'
         WHERE id = 'index-fencing-test'`,
      )
      .run();
    assert.equal(
      fixture.lifecycle.claimJob(
        'new-worker',
        300,
        ['index_memory'],
      )?.leaseOwner,
      'new-worker',
    );

    await memoryStore.indexMemoryDense(
      memory.id,
      memory.userId,
      memory.namespace,
      () => fixture.lifecycle.assertJobLease(
        'index-fencing-test',
        'new-worker',
      ),
    );
    fixture.lifecycle.completeJob(
      'index-fencing-test',
      'new-worker',
    );
    const indexedAt = fixture.database
      .prepare(
        `SELECT DISTINCT updated_at
         FROM memory_dense_lsh
         WHERE memory_id = ?`,
      )
      .get(memory.id)?.updated_at;

    await assert.rejects(
      memoryStore.indexMemoryDense(
        memory.id,
        memory.userId,
        memory.namespace,
        () => fixture.lifecycle.assertJobLease(
          'index-fencing-test',
          'old-worker',
        ),
      ),
      /租约已过期/,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT DISTINCT updated_at
           FROM memory_dense_lsh
           WHERE memory_id = ?`,
        )
        .get(memory.id)?.updated_at,
      indexedAt,
    );
  } finally {
    fixture.close();
  }
});
