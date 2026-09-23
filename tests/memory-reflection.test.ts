import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import { openDatabase, SCHEMA_VERSION } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryAdminService } from '../src/server/memory-admin.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import {
  MemoryReflectionError,
  MemoryReflectionService,
  OllamaReflectionProvider,
  REFLECTION_IMPLEMENTATION_VERSION,
  shouldIncludeReflectionDiscoveryTurn,
  type ReflectionCandidateInput,
  type ReflectionProvider,
} from '../src/server/memory-reflection.js';
import type { MemoryExtractor } from '../src/server/memory-extractor.js';
import {
  beginForegroundActivity,
  resetModelQosForTests,
} from '../src/server/model-qos.js';
import { MemoryWorker } from '../src/server/memory-worker.js';
import { MemoryStore } from '../src/server/memory-store.js';
import { PatternObservationStore } from
  '../src/server/pattern-observation-store.js';

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-reflection-'),
  );
  let current = new Date('2026-08-09T12:00:00.000Z');
  const filePath = path.join(directory, 'test.sqlite3');
  const database = openDatabase(filePath);
  const lifecycle = new LifecycleStore(database, () => current);
  const record = (
    userId: string,
    sessionExternalId: string,
    turnExternalId: string,
    content: string,
    occurredAt: string,
  ) => lifecycle.recordTurn({
    userId,
    namespace: 'personal',
    clientName: 'client',
    sessionExternalId,
    turnExternalId,
    role: 'user',
    content,
    occurredAt,
  }).turn;
  return {
    database,
    filePath,
    lifecycle,
    record,
    now() {
      return new Date(current);
    },
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

const extractor: MemoryExtractor = {
  model: 'qwen2.5:14b',
  promptVersion: 'extract-test-v1',
  extractorId: 'test-extractor',
  extractorVersion: 'v1',
  async extract(turn) {
    return turn.content.includes('桂花乌龙')
      ? [{
          kind: 'preference',
          subject: '用户',
          predicate: '工作日早晨饮品',
          value: '工作日早上喝桂花乌龙',
          content: '',
          confidence: 1,
          importance: 0.8,
          sensitivity: 'normal',
          scopeType: 'personal',
          scopeKey: 'self',
          sourceExcerpt: turn.content,
          sourceAuthority: 'direct_user',
        }]
      : [];
  },
};

function provider(
  output: Awaited<ReturnType<ReflectionProvider['reflect']>>,
): ReflectionProvider {
  return {
    model: 'qwen2.5:14b',
    promptVersion: 'reflection-test-v1',
    async reflect() {
      return output;
    },
  };
}

test('反思发现过滤普通问句但保留带重复行为事实的问句', () => {
  for (const content of [
    '今天杭州天气怎么样？',
    '中午吃什么比较好？',
    'TypeScript 的 satisfies 和 as 有什么区别?',
    '去大阪旅行三天怎么安排行程？',
    '我应该继续使用 TypeScript 吗？',
  ]) {
    assert.equal(
      shouldIncludeReflectionDiscoveryTurn(content),
      false,
      content,
    );
  }

  for (const content of [
    '我今天照常在晚饭后散步了，你觉得要增加到四十分钟吗？',
    '我今天又坚持读了二十页，这个节奏合适吗？',
    '最近晚间拉伸一直没有中断，要不要增加强度？',
    '我今晚还是喝了桂花乌龙，需要改成无咖啡因的吗？',
  ]) {
    assert.equal(
      shouldIncludeReflectionDiscoveryTurn(content),
      true,
      content,
    );
  }
});

test('反思发现问句过滤不改变原有非问句和非持久证据语义', () => {
  assert.equal(
    shouldIncludeReflectionDiscoveryTurn('我昨天开始学习 Rust。'),
    true,
  );
  assert.equal(
    shouldIncludeReflectionDiscoveryTurn(
      '书店换了橱窗，我只是路过时看了一眼。',
    ),
    false,
  );
  assert.equal(
    shouldIncludeReflectionDiscoveryTurn(
      '我今天又坚持跑了五公里，但这只是今天碰巧，不代表习惯，可以吗？',
    ),
    false,
  );
});

test('反思执行只把可沉淀内容送入 provider 发现阶段', async () => {
  const fixture = createFixture();
  try {
    const contents = [
      '今天杭州天气怎么样？',
      '中午吃什么比较好？',
      'TypeScript 的 satisfies 和 as 有什么区别?',
      '去大阪旅行三天怎么安排行程？',
      '我今天又坚持读了二十页，这个节奏合适吗？',
      '我昨天开始学习 Rust。',
      '书店换了橱窗，我只是路过时看了一眼。',
    ];
    contents.forEach((content, index) => fixture.record(
      'alice',
      'discovery-question-filter-s1',
      `discovery-question-filter-t${index + 1}`,
      content,
      `2026-08-0${index + 1}T08:00:00.000Z`,
    ));
    const providerInputs: Array<{
      phase?: 'discover' | 'verify';
      turns: Array<{ content: string }>;
    }> = [];
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-question-filter-v1',
      async reflect(input) {
        providerInputs.push(input);
        return { candidates: [] };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minNewTurns: 1, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    await service.executeRun(queued.run.id, 'question-filter-worker');

    assert.deepEqual(
      providerInputs.map((input) => ({
        phase: input.phase,
        contents: input.turns.map((turn) => turn.content),
      })),
      [{
        phase: 'discover',
        contents: [
          '我今天又坚持读了二十页，这个节奏合适吗？',
          '我昨天开始学习 Rust。',
        ],
      }],
    );
  } finally {
    fixture.close();
  }
});

test('前部四个单事实不会饿死后部重复习惯', async () => {
  const fixture = createFixture();
  try {
    const facts = [
      '我的名字是林澈。',
      '我平时最常喝桂花乌龙。',
      '我目前的职业是室内设计师。',
      '工作日我通常骑共享单车到地铁站。',
    ];
    const habit = '晚饭后散步二十分钟';
    const habitTurns = [
      `今天照常${habit}，结束后整个人轻松了不少。`,
      `这周又坚持了${habit}，做完以后心情很平静。`,
      `最近没有中断${habit}这个安排，今天也照常完成。`,
    ];
    [...facts, ...habitTurns].forEach((content, index) => fixture.record(
      'alice',
      'priority-habit-s1',
      `priority-habit-t${index + 1}`,
      content,
      `2026-08-${String(index + 1).padStart(2, '0')}T20:00:00.000Z`,
    ));
    const discoveryOrders: string[][] = [];
    const stableCandidate = (
      evidence: Array<{ turnAlias: string }>,
    ): ReflectionCandidateInput => ({
      kind: 'preference',
      subject: '用户',
      predicate: '稳定生活习惯',
      value: habit,
      confidence: 0.92,
      importance: 0.7,
      sensitivity: 'normal',
      negated: false,
      observationType: 'stable_pattern',
      evidence,
    });
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'priority-before-cap-v1',
      async reflect(input) {
        if (input.phase === 'verify') {
          return {
            candidates: [stableCandidate(input.turns.map((turn) => ({
              turnAlias: turn.turnAlias,
            })))],
          };
        }
        discoveryOrders.push(input.turns.map((turn) => turn.content));
        const supporting = input.turns.filter((turn) =>
          turn.content.includes(habit)
        );
        const candidates: ReflectionCandidateInput[] = [];
        for (const turn of input.turns) {
          if (turn.content.includes(habit)) {
            if (!candidates.some((candidate) =>
              candidate.predicate === '稳定生活习惯'
            )) {
              candidates.push(stableCandidate(supporting.map((item) => ({
                turnAlias: item.turnAlias,
              }))));
            }
          } else {
            candidates.push({
              kind: 'profile',
              subject: '用户',
              predicate: `单次事实${turn.turnAlias}`,
              value: turn.content,
              confidence: 0.8,
              importance: 0.5,
              sensitivity: 'normal',
              negated: false,
              observationType: 'stable_pattern',
              evidence: [{ turnAlias: turn.turnAlias }],
            });
          }
          if (candidates.length === 4) break;
        }
        return { candidates };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    const result = await service.executeRun(
      queued.run.id,
      'priority-before-cap-worker',
    );

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.value, habit);
    assert.deepEqual(discoveryOrders[0]?.slice(0, 3), habitTurns);
  } finally {
    fixture.close();
  }
});

test('反思 provider 发现阶段使用 alias 证据并允许单条观察跨窗口累积', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const reflectionProvider = new OllamaReflectionProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'reflection-prompt-contract-v1',
    timeoutMs: 5_000,
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body || '{}')) as
        Record<string, unknown>;
      return new Response(JSON.stringify({
        message: { content: JSON.stringify({ candidates: [] }) },
      }), { status: 200 });
    },
  });

  await reflectionProvider.reflect({
    userId: 'alice',
    namespace: 'personal',
    scopeType: 'personal',
    scopeKey: 'self',
    currentTime: '2026-08-09T12:00:00.000Z',
    turns: [
      {
        turnAlias: 'T1', content: '周一我选择绿茶。',
        occurredAt: '2026-08-08T08:00:00.000Z',
      },
      {
        turnAlias: 'T2', content: '周三我继续选择绿茶。',
        occurredAt: '2026-08-08T09:00:00.000Z',
      },
      {
        turnAlias: 'T3', content: '周五我还是选择绿茶。',
        occurredAt: '2026-08-08T10:00:00.000Z',
      },
    ],
  });

  const messages = requestBody?.messages as Array<{ content?: string }>;
  const systemPrompt = messages?.[0]?.content || '';
  assert.match(systemPrompt, /当前是发现阶段/u);
  assert.match(systemPrompt, /证据只输出 turnAlias/u);
  assert.match(systemPrompt, /跨窗口累积/u);
  assert.match(systemPrompt, /不得因[^]*不足三条而丢弃/u);
  assert.match(systemPrompt, /predicate=“稳定生活习惯”/u);
  assert.match(systemPrompt, /停止旧行为并改用新行为/u);
  assert.match(systemPrompt, /原文未明确旧 value 时不得猜测/u);
  assert.match(systemPrompt, /互不相关的事实拼成模式/u);
  assert.match(systemPrompt, /一次性见闻/u);
  const format = requestBody?.format as {
    properties?: {
      candidates?: {
        items?: {
          properties?: {
            evidence?: {
              items?: {
                properties?: Record<string, Record<string, unknown>>;
              };
            };
          };
        };
      };
    };
  };
  const evidenceProperties = format.properties?.candidates?.items
    ?.properties?.evidence?.items?.properties;
  assert.ok(evidenceProperties);
  assert.equal(evidenceProperties.turnAlias?.minLength, 1);
  assert.equal(evidenceProperties.turnAlias?.maxLength, 64);
  assert.equal('excerpt' in evidenceProperties, false);
});

test('Ollama alias 证据协议过滤空白和过长 alias，并兼容旧 excerpt', async () => {
  const cases = [
    { evidence: { turnAlias: ' ', excerpt: '有效摘录' }, expected: [] },
    {
      evidence: { turnAlias: 'T'.repeat(65), excerpt: '有效摘录' },
      expected: [],
    },
    { evidence: { turnAlias: 'T1' }, expected: [{ turnAlias: 'T1' }] },
    {
      evidence: { turnAlias: 'T1', excerpt: '有效摘录' },
      expected: [{ turnAlias: 'T1', excerpt: '有效摘录' }],
    },
  ];
  for (const item of cases) {
    const reflectionProvider = new OllamaReflectionProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-server-boundary-v1',
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(JSON.stringify({
        message: { content: JSON.stringify({
          candidates: [{
            kind: 'preference',
            subject: '用户',
            predicate: '工作日饮品',
            value: '桂花乌龙',
            confidence: 0.9,
            importance: 0.8,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence: [item.evidence],
          }],
        }) },
      }), { status: 200 }),
    });
    const result = await reflectionProvider.reflect({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      currentTime: '2026-08-13T12:00:00.000Z',
      turns: [{
        turnAlias: 'T1',
        content: '有效摘录',
        occurredAt: '2026-08-13T08:00:00.000Z',
      }],
    });
    assert.deepEqual(result.candidates[0]?.evidence, item.expected);
  }
});

test('Ollama 反思 length 截断只补偿一次且每次进入模型调用账本', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'truncated-reflection-s1',
      'truncated-reflection-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const requestBodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const reflectionProvider = new OllamaReflectionProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-truncation-v1',
      timeoutMs: 5_000,
      fetchImpl: async (_url, init) => {
        requestBodies.push(JSON.parse(String(init?.body || '{}')) as
          Record<string, unknown>);
        calls += 1;
        return new Response(JSON.stringify(calls === 1 ? {
          done_reason: 'length',
          eval_count: 1_536,
          message: { content: '{"candidates":[' },
        } : {
          done_reason: 'stop',
          eval_count: 12,
          message: { content: '{"candidates":[]}' },
        }), { status: 200 });
      },
    });
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minNewTurns: 1, maxDailyCalls: 10 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    const result = await service.executeRun(
      queued.run.id,
      'truncated-reflection-worker',
    );

    assert.equal(result.run.status, 'completed');
    assert.equal(calls, 2);
    assert.deepEqual(
      service.modelCalls(queued.run.id, 'alice').map((call) => call.status),
      ['failed', 'completed'],
    );
    const options = requestBodies.map((body) => body.options as {
      num_predict?: number;
    });
    assert.ok(Number(options[1]?.num_predict) < Number(options[0]?.num_predict));
    const retry = service.runEvents(queued.run.id, 'alice').find(
      (event) => event.eventType === 'model_output_retry',
    );
    assert.equal(retry?.detail.reasonCode, 'truncated_json');
    assert.equal(retry?.detail.doneReason, 'length');
    assert.equal(retry?.detail.outputChars, 15);
    assert.match(String(retry?.detail.outputFingerprint), /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(retry?.detail).includes('candidates'), false);
  } finally {
    fixture.close();
  }
});

test('Ollama 反思连续两次截断失败且 checkpoint 不推进', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'double-truncated-s1',
      'double-truncated-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    let calls = 0;
    const reflectionProvider = new OllamaReflectionProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-double-truncation-v1',
      timeoutMs: 5_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          done_reason: 'length',
          eval_count: 1_536,
          message: { content: '{"candidates":[' },
        }), { status: 200 });
      },
    });
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minNewTurns: 1, maxDailyCalls: 10 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    await assert.rejects(
      service.executeRun(queued.run.id, 'double-truncated-worker'),
      /长度上限/u,
    );

    assert.equal(calls, 2);
    assert.equal(service.getRun(queued.run.id, 'alice')?.status, 'failed');
    assert.deepEqual(
      service.modelCalls(queued.run.id, 'alice').map((call) => call.status),
      ['failed', 'failed'],
    );
    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_reflection_checkpoints',
      ).get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('Ollama 反思连续截断由 Worker 重试后进入 protocol dead-letter 且不推进 checkpoint', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'worker-double-truncated-s1',
      'worker-double-truncated-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    fixture.database.prepare(
      "UPDATE outbox_events SET status = 'completed'",
    ).run();
    let providerCalls = 0;
    const reflectionProvider = new OllamaReflectionProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-worker-double-truncation-v1',
      timeoutMs: 5_000,
      fetchImpl: async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({
          done_reason: 'length',
          eval_count: 1_536,
          message: { content: '{"candidates":[' },
        }), { status: 200 });
      },
    });
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minNewTurns: 1, maxDailyCalls: 10 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      service,
    );

    const first = await worker.processNext('truncated-worker-a');
    assert.equal(first.job?.status, 'failed');
    assert.equal(service.getRun(queued.run.id, 'alice')?.status, 'failed');
    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_reflection_checkpoints',
      ).get()?.count,
      0,
    );

    fixture.advance(120_000);
    const second = await worker.processNext('truncated-worker-b');
    assert.equal(providerCalls, 4, '每次 Worker attempt 最多两次物理调用');
    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM dead_letter_jobs WHERE job_id = ?',
      ).get(`reflection-run:${queued.run.id}`)?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_reflection_checkpoints',
      ).get()?.count,
      0,
    );
    const attempts = fixture.database.prepare(
      `SELECT detail_json
       FROM audit_log
       WHERE user_id = 'alice' AND action = 'job_attempt_failed'
         AND json_extract(detail_json, '$.jobId') = ?
       ORDER BY id ASC`,
    ).all(`reflection-run:${queued.run.id}`) as Array<{
      detail_json: string;
    }>;
    const attemptDetails = attempts.map((row) => JSON.parse(
      row.detail_json,
    ) as Record<string, unknown>);
    assert.deepEqual({
      jobStatus: second.job?.status,
      runStatus: service.getRun(queued.run.id, 'alice')?.status,
      failureClasses: attemptDetails.map((detail) => detail.failureClass),
      compensationActions: attemptDetails.map(
        (detail) => detail.compensationAction,
      ),
    }, {
      jobStatus: 'dead',
      runStatus: 'dead',
      failureClasses: ['protocol', 'protocol'],
      compensationActions: [
        'retry_protocol_once',
        'stop_repeated_fingerprint',
      ],
    });
  } finally {
    fixture.close();
  }
});

test('历史重提炼 generation key 绑定当前数据库 schema', async () => {
  const fixture = createFixture();
  try {
    const reflectionProvider = provider({ candidates: [] });
    const minPatternEvidence = 3;
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minPatternEvidence },
    );
    const preview = await service.preview({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
    });
    const expectedKey = (
      runType: 'reextract' | 'reflect',
      model: string,
      promptVersion: string,
    ) => createHash('sha256').update([
      runType,
      REFLECTION_IMPLEMENTATION_VERSION,
      model,
      promptVersion,
      extractor.extractorId,
      extractor.extractorVersion,
      `minEvidence:${minPatternEvidence}`,
      `schema:${SCHEMA_VERSION}`,
    ].join('\n')).digest('hex');

    assert.equal(
      preview.generationKeys.reextract,
      expectedKey('reextract', extractor.model, extractor.promptVersion),
    );
    assert.equal(
      preview.generationKeys.reflect,
      expectedKey(
        'reflect',
        reflectionProvider.model,
        reflectionProvider.promptVersion,
      ),
    );
  } finally {
    fixture.close();
  }
});

test('历史重提炼证据多样性配置进入 reflect generation key', async () => {
  const fixture = createFixture();
  try {
    const reflectionProvider = provider({ candidates: [] });
    const defaultService = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minPatternEvidence: 3 },
    );
    const strictService = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      {
        minPatternEvidence: 3,
        requireCrossSessionEvidence: true,
        requireCrossDayEvidence: true,
      },
    );
    const scope = {
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal' as const,
      scopeKey: 'self',
    };
    assert.notEqual(
      (await defaultService.preview(scope)).generationKeys.reflect,
      (await strictService.preview(scope)).generationKeys.reflect,
    );
  } finally {
    fixture.close();
  }
});

test('preview 只读取当前账户窗口且不写 run、候选或 checkpoint', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'alice-session',
      'alice-1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    fixture.record(
      'bob',
      'bob-session',
      'bob-1',
      '我每天晚上喝玄米茶。',
      '2026-08-08T09:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1 },
    );
    const preview = await service.preview({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
    });
    assert.equal(preview.turnCount, 1);
    assert.equal(preview.turns[0]?.content, '工作日早上我会喝桂花乌龙。');
    for (const table of [
      'memory_reflection_runs',
      'memory_reflection_checkpoints',
      'memory_candidates',
    ]) {
      assert.equal(
        fixture.database
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get()?.count,
        0,
      );
    }
  } finally {
    fixture.close();
  }
});

test('preview 必须分别显示 reextract 和 reflect 的漂移窗口', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'preview-drift-s1',
      'preview-drift-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1 },
    );
    const completedReflect = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    await service.executeRun(completedReflect.run.id, 'preview-drift-worker');
    const retiredJob = fixture.lifecycle.getJob(
      `reflection-run:${completedReflect.run.id}`,
    );
    assert.equal(retiredJob?.status, 'completed');
    assert.equal(retiredJob?.lastError, 'reflection_run_terminal');

    const preview = await service.preview({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
    });
    assert.equal(preview.pipelines.reextract.turnCount, 1);
    assert.equal(preview.pipelines.reflect.turnCount, 0);
    assert.equal(preview.callsRequired.reextract, 1);
    assert.equal(preview.callsRequired.reflect, 0);
  } finally {
    fixture.close();
  }
});

test('超长单 turn 不得被截断后推进 checkpoint', async () => {
  const fixture = createFixture();
  try {
    const turn = fixture.record(
      'alice',
      'oversized-s1',
      'oversized-t1',
      `头部背景${'很长的无关背景。'.repeat(30)}尾部事实：我喜欢桂花乌龙。`,
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1, tokenBudget: 20 },
    );
    const preview = await service.preview({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
    });
    assert.equal(preview.turnCount, 0);
    assert.equal(preview.pipelines.reextract.blockedTurn?.id, turn.id);
    assert.equal(preview.pipelines.reflect.blockedTurn?.id, turn.id);
    assert.throws(
      () => service.queueRun({
        userId: 'alice',
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType: 'reextract',
        trigger: 'manual',
        requestedBy: 'alice',
      }),
      (error: unknown) => {
        assert.ok(error instanceof MemoryReflectionError);
        assert.equal(error.code, 'REFLECTION_TOKEN_BUDGET_EXCEEDED');
        assert.match(error.message, /超过单窗口 token 预算/u);
        return true;
      },
    );
    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_reflection_checkpoints',
      ).get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('跨多轮反思保存逐字多证据，并仅在 auto 模式激活已验证稳定习惯', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record('alice', 's1', 't1', '周一早上我喝桂花乌龙。', '2026-08-05T08:00:00.000Z'),
      fixture.record('alice', 's1', 't2', '周三早上我也喝桂花乌龙。', '2026-08-06T08:00:00.000Z'),
      fixture.record('alice', 's1', 't3', '今天上班前还是桂花乌龙。', '2026-08-07T08:00:00.000Z'),
    ];
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({
        candidates: [{
          kind: 'preference',
          subject: '用户',
          predicate: '工作日前饮品模式',
          value: '工作日前偏好桂花乌龙',
          confidence: 0.9,
          importance: 0.7,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: turns.map((_turn, index) => ({
            turnAlias: `T${index + 1}`,
          })),
        }],
      }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const result = await service.executeRun(queued.run.id, 'worker-a');
    assert.equal(result.run.status, 'completed');
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.state, 'pending');
    assert.equal(
      result.candidates[0]?.sourceAuthority,
      'assistant_inference',
    );
    assert.equal(result.candidates[0]?.candidateOrigin, 'reflection');
    const evidence = fixture.database
      .prepare(
        `SELECT turn_id, excerpt
         FROM memory_candidate_evidence
         WHERE candidate_id = ?
         ORDER BY ordinal ASC`,
      )
      .all(result.candidates[0]!.id) as Array<Record<string, unknown>>;
    assert.deepEqual(
      evidence.map((row) => row.turn_id),
      turns.map((turn) => turn.id),
    );
    assert.ok(evidence.every((row, index) =>
      turns[index]!.content.includes(String(row.excerpt)),
    ));
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM memories')
        .get()?.count,
      0,
    );
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      {
        mode: 'auto',
        autoCommitMinConfidence: 0.95,
        autoCommitMinImportance: 0.5,
      },
    );
    const resolution = await resolver.resolve(result.candidates[0]!.id);
    assert.equal(resolution.state, 'accepted');
    assert.ok(resolution.memoryId);
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM memories')
        .get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('发现阶段丢弃 Qwen 夹带的无关 alias，用冻结窗口中的同一习惯原文补齐证据', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record(
        'alice', 'habit-repair-s1', 'habit-repair-t1',
        '今天照常晚饭后散步二十分钟，结束后整个人轻松了不少。',
        '2026-08-01T20:00:00.000Z',
      ),
      fixture.record(
        'alice', 'habit-repair-s1', 'habit-repair-t2',
        '这周又坚持了晚饭后散步二十分钟，做完以后心情很平静。',
        '2026-08-03T20:00:00.000Z',
      ),
      fixture.record(
        'alice', 'habit-repair-s1', 'habit-repair-noise',
        '请忘记我前面说的青禾旅店临时住宿安排，它已经取消了。',
        '2026-08-04T09:00:00.000Z',
      ),
      fixture.record(
        'alice', 'habit-repair-s1', 'habit-repair-t3',
        '忙完手上的事，我还是去晚饭后散步二十分钟了，身体也放松下来。',
        '2026-08-05T20:00:00.000Z',
      ),
      fixture.record(
        'alice', 'habit-repair-s1', 'habit-repair-t4',
        '最近没有中断晚饭后散步二十分钟这个安排，今天做完也很舒服。',
        '2026-08-07T20:00:00.000Z',
      ),
    ];
    const candidate = (evidence: Array<{ turnAlias: string }>) => ({
      kind: 'relationship' as const,
      subject: '用户',
      predicate: '稳定生活习惯',
      value: '晚饭后散步二十分钟',
      confidence: 0.9,
      importance: 1,
      sensitivity: 'sensitive' as const,
      negated: false,
      observationType: 'stable_pattern' as const,
      evidence,
    });
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-evidence-repair-v1',
      async reflect(input) {
        if (input.phase === 'discover') {
          return {
            candidates: [candidate([
              { turnAlias: 'T2' },
              { turnAlias: 'T3' },
              { turnAlias: 'T5' },
            ])],
          };
        }
        assert.equal(input.phase, 'verify');
        assert.equal(input.verificationClaim?.value, '晚饭后散步二十分钟');
        return {
          candidates: [candidate(input.turns.map((turn) => ({
            turnAlias: turn.turnAlias,
          })))],
        };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        clock: fixture.now,
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    const result = await service.executeRun(
      queued.run.id,
      'habit-evidence-repair-worker',
    );

    assert.equal(result.run.rejectedCount, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.sensitivity, 'normal');
    const evidence = fixture.database.prepare(
      `SELECT turn_id FROM memory_candidate_evidence
       WHERE candidate_id = ? ORDER BY ordinal ASC`,
    ).all(result.candidates[0]!.id) as Array<{ turn_id: string }>;
    assert.deepEqual(
      new Set(evidence.map((entry) => entry.turn_id)),
      new Set([turns[0]!.id, turns[1]!.id, turns[3]!.id, turns[4]!.id]),
    );
    assert.equal(
      evidence.some((entry) => entry.turn_id === turns[2]!.id),
      false,
    );
    const events = service.runEvents(queued.run.id, 'alice');
    assert.ok(events.some((event) =>
      event.eventType === 'candidate_evidence_repaired' &&
      event.detail.discardedEvidenceCount === 1 &&
      event.detail.augmentedEvidenceCount === 2
    ));
    assert.ok(events.some((event) =>
      event.eventType === 'candidate_sensitivity_normalized' &&
      event.detail.from === 'sensitive' &&
      event.detail.to === 'normal'
    ));
    const resolveJob = fixture.lifecycle.getJob(
      `resolve:${result.candidates[0]!.id}`,
    );
    assert.equal(resolveJob?.jobType, 'resolve_candidate');
    assert.equal(resolveJob?.status, 'pending');
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      {
        mode: 'auto',
        autoCommitMinConfidence: 0.95,
        autoCommitMinImportance: 0.5,
      },
    );
    const resolution = await resolver.resolve(result.candidates[0]!.id);
    assert.equal(resolution.state, 'accepted');
  } finally {
    fixture.close();
  }
});

test('14B 将稳定习惯 value 过度概括时用重复原文恢复完整行为', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      '今天照常周中晚上做半小时力量训练，结束后整个人轻松了不少。',
      '这周又坚持了周中晚上做半小时力量训练，做完以后心情很平静。',
      '忙完手上的事，我还是去周中晚上做半小时力量训练了，身体也放松下来。',
      '最近没有中断周中晚上做半小时力量训练这个安排，今天做完也很舒服。',
    ].map((content, index) => fixture.record(
      'alice',
      'habit-value-repair-s1',
      `habit-value-repair-t${index + 1}`,
      content,
      `2026-08-0${index + 1}T20:00:00.000Z`,
    ));
    const candidate = (
      value: string,
      evidence: Array<{ turnAlias: string }>,
    ) => ({
      kind: 'event' as const,
      subject: '用户',
      predicate: '稳定生活习惯',
      value,
      confidence: 0.9,
      importance: 1,
      sensitivity: 'normal' as const,
      negated: false,
      observationType: 'stable_pattern' as const,
      evidence,
    });
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-habit-value-repair-v1',
      async reflect(input) {
        const evidence = input.turns.map((turn) => ({
          turnAlias: turn.turnAlias,
        }));
        if (input.phase === 'discover') {
          return {
            candidates: [candidate('正常力量训练', evidence)],
          };
        }
        assert.equal(input.phase, 'verify');
        assert.equal(
          input.verificationClaim?.value,
          '周中晚上做半小时力量训练',
        );
        return {
          candidates: [candidate(
            input.verificationClaim?.value || '',
            evidence,
          )],
        };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        clock: fixture.now,
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    const result = await service.executeRun(
      queued.run.id,
      'habit-value-repair-worker',
    );

    assert.equal(result.run.rejectedCount, 0);
    assert.equal(result.candidates.length, 1);
    assert.equal(
      result.candidates[0]?.value,
      '周中晚上做半小时力量训练',
    );
    const evidence = fixture.database.prepare(
      `SELECT turn_id FROM memory_candidate_evidence
       WHERE candidate_id = ? ORDER BY ordinal ASC`,
    ).all(result.candidates[0]!.id) as Array<{ turn_id: string }>;
    assert.deepEqual(
      new Set(evidence.map((entry) => entry.turn_id)),
      new Set(turns.map((turn) => turn.id)),
    );
  } finally {
    fixture.close();
  }
});

test('普通手机使用习惯不会因为手机字样被误判为敏感内容', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      '今天照常睡前把手机放到客厅充电，结束后整个人轻松了不少。',
      '这周又坚持了睡前把手机放到客厅充电，做完以后心情很平静。',
      '最近没有中断睡前把手机放到客厅充电这个安排，今天也照常完成。',
    ].map((content, index) => fixture.record(
      'alice',
      'phone-habit-s1',
      `phone-habit-t${index + 1}`,
      content,
      `2026-08-0${index + 1}T22:00:00.000Z`,
    ));
    const output = {
      candidates: [{
        kind: 'relationship' as const,
        subject: '用户',
        predicate: '稳定生活习惯',
        value: '睡前把手机放到客厅充电',
        confidence: 1,
        importance: 0.85,
        sensitivity: 'sensitive' as const,
        negated: false,
        observationType: 'stable_pattern' as const,
        evidence: turns.map((_turn, index) => ({
          turnAlias: `T${index + 1}`,
        })),
      }],
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider(output),
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        clock: fixture.now,
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    const result = await service.executeRun(
      queued.run.id,
      'phone-habit-worker',
    );

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.sensitivity, 'normal');
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      { mode: 'auto' },
    );
    const resolution = await resolver.resolve(result.candidates[0]!.id);
    assert.equal(resolution.state, 'accepted');
  } finally {
    fixture.close();
  }
});

test('健康用药类稳定习惯仍保持 sensitive 并需要人工确认', async () => {
  const fixture = createFixture();
  try {
    const turns = [1, 2, 3].map((index) => fixture.record(
      'alice',
      'sensitive-habit-s1',
      `sensitive-habit-t${index}`,
      `第 ${index} 次健康用药记录：晚饭后按医嘱服药。`,
      `2026-08-0${index}T20:00:00.000Z`,
    ));
    const output = {
      candidates: [{
        kind: 'relationship' as const,
        subject: '用户',
        predicate: '稳定生活习惯',
        value: '健康用药：晚饭后按医嘱服药',
        confidence: 0.99,
        importance: 1,
        sensitivity: 'sensitive' as const,
        negated: false,
        observationType: 'stable_pattern' as const,
        evidence: turns.map((_turn, index) => ({
          turnAlias: `T${index + 1}`,
        })),
      }],
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider(output),
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        clock: fixture.now,
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    const result = await service.executeRun(
      queued.run.id,
      'sensitive-habit-worker',
    );

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.sensitivity, 'sensitive');
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      { mode: 'auto' },
    );
    const resolution = await resolver.resolve(result.candidates[0]!.id);
    assert.equal(resolution.state, 'pending');
    assert.equal(
      resolution.reason,
      'assistant_inference_requires_confirmation',
    );
  } finally {
    fixture.close();
  }
});

test('反思拒绝混合不一致证据和重复的一次性见闻', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record(
        'alice', 's1', 'mixed-1',
        '我平时最常喝桂花乌龙。',
        '2026-08-01T08:00:00.000Z',
      ),
      fixture.record(
        'alice', 's1', 'mixed-2',
        '工作日我通常骑共享单车到地铁站。',
        '2026-08-02T08:00:00.000Z',
      ),
      fixture.record(
        'alice', 's1', 'mixed-3',
        '请先给结论再列两点依据。',
        '2026-08-03T08:00:00.000Z',
      ),
      fixture.record(
        'alice', 's1', 'noise-1',
        '路口的银杏叶变黄了，我只是路过时看了一眼。',
        '2026-08-04T08:00:00.000Z',
      ),
      fixture.record(
        'alice', 's1', 'noise-2',
        '书店换了橱窗，我只是路过时看了一眼。',
        '2026-08-05T08:00:00.000Z',
      ),
      fixture.record(
        'alice', 's1', 'noise-3',
        '公园新增指路牌，我只是路过时看了一眼。',
        '2026-08-06T08:00:00.000Z',
      ),
    ];
    const evidence = (indexes: number[]) => indexes.map((index) => ({
      turnAlias: `T${index + 1}`,
      excerpt: turns[index]!.content,
    }));
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [
        {
          kind: 'preference',
          subject: '喝桂花乌龙',
          predicate: '优先选择',
          value: '平时最常喝桂花乌龙',
          confidence: 0.9,
          importance: 0.7,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: evidence([0, 1, 2]),
        },
        {
          kind: 'preference',
          subject: '路过时看一眼',
          predicate: '频繁发生',
          value: '经常路过时看一眼',
          confidence: 0.9,
          importance: 0.5,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: evidence([3, 4, 5]),
        },
      ] }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const result = await service.executeRun(
      queued.run.id,
      'evidence-consistency-worker',
    );

    assert.equal(result.candidates.length, 0);
    assert.equal(result.run.rejectedCount, 2);
  } finally {
    fixture.close();
  }
});

test('反思最终证据严格限制为 3–5 条且构造参数不能降低三证据门槛', async () => {
  const invalidFixture = createFixture();
  try {
    assert.throws(
      () => new MemoryReflectionService(
        invalidFixture.database,
        invalidFixture.lifecycle,
        extractor,
        provider({ candidates: [] }),
        { minPatternEvidence: 2 },
      ),
      /3–5/u,
    );
    assert.throws(
      () => new MemoryReflectionService(
        invalidFixture.database,
        invalidFixture.lifecycle,
        extractor,
        provider({ candidates: [] }),
        { minPatternEvidence: 6 },
      ),
      /3–5/u,
    );
  } finally {
    invalidFixture.close();
  }

  for (const evidenceCount of [2, 5, 6]) {
    const fixture = createFixture();
    try {
      const turns = Array.from({ length: evidenceCount }, (_, index) =>
        fixture.record(
          'alice',
          `evidence-boundary-s${index + 1}`,
          `evidence-boundary-t${index + 1}`,
          `第 ${index + 1} 次记录：工作日早上我仍然选择桂花乌龙。`,
          `2026-08-${String(index + 1).padStart(2, '0')}T08:00:00.000Z`,
        )
      );
      const candidate = {
        kind: 'preference' as const,
        subject: '用户',
        predicate: '工作日早晨饮品',
        value: '桂花乌龙',
        confidence: 0.9,
        importance: 0.7,
        sensitivity: 'normal' as const,
        negated: false,
        observationType: 'stable_pattern' as const,
        evidence: turns.map((turn, index) => ({
          turnAlias: `T${index + 1}`,
          excerpt: turn.content,
        })),
      };
      const service = new MemoryReflectionService(
        fixture.database,
        fixture.lifecycle,
        extractor,
        provider({ candidates: [candidate] }),
        {
          minNewTurns: 1,
          minPatternEvidence: 3,
          clock: fixture.now,
        },
      );
      const queued = service.queueRun({
        userId: 'alice',
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType: 'reflect',
        trigger: 'manual',
        requestedBy: 'alice',
      });
      const result = await service.executeRun(
        queued.run.id,
        `evidence-boundary-${evidenceCount}`,
      );

      assert.equal(result.candidates.length, evidenceCount === 5 ? 1 : 0);
      const observations = Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_pattern_observations
         WHERE user_id = 'alice'`,
      ).get()?.count || 0);
      assert.equal(
        observations,
        evidenceCount > 5 ? 0 : evidenceCount,
      );
      if (evidenceCount === 6) {
        const rejected = service.runEvents(queued.run.id, 'alice').find(
          (event) => event.eventType === 'candidate_rejected',
        );
        assert.equal(
          rejected?.detail.reasonCode,
          'evidence_count_out_of_range',
        );
      }
    } finally {
      fixture.close();
    }
  }
});

test('possible_change 与原习惯共用观察簇并仅由停止后三条证据恢复', async () => {
  const fixture = createFixture();
  try {
    const habitValue = '工作日早上喝桂花乌龙';
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'habit-change-cluster-v1',
      async reflect(input) {
        const stopped = input.phase !== 'verify'
          ? input.turns.find((turn) => turn.content.includes('已经停止'))
          : undefined;
        const evidenceTurns = stopped ? [stopped] : input.turns;
        const locked = input.verificationClaim;
        return {
          candidates: evidenceTurns.length === 0 ? [] : [{
            kind: stopped ? 'event' : locked?.kind || 'preference',
            subject: locked?.subject || '用户',
            predicate: locked?.predicate || '稳定生活习惯',
            value: locked?.value || habitValue,
            confidence: 0.92,
            importance: 0.7,
            sensitivity: 'normal',
            negated: stopped ? true : locked?.negated || false,
            observationType: stopped ? 'possible_change' : 'stable_pattern',
            evidence: evidenceTurns.map((turn) => ({
              turnAlias: turn.turnAlias,
              excerpt: turn.content,
            })),
          }],
        };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        clock: fixture.now,
      },
    );
    const execute = async (workerId: string) => {
      const queued = service.queueRun({
        userId: 'alice',
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType: 'reflect',
        trigger: 'manual',
        requestedBy: 'alice',
      });
      return service.executeRun(queued.run.id, workerId);
    };

    for (let index = 1; index <= 3; index += 1) {
      fixture.record(
        'alice',
        `habit-before-s${index}`,
        `habit-before-t${index}`,
        `第 ${index} 次${habitValue}。`,
        `2026-08-0${index}T08:00:00.000Z`,
      );
    }
    assert.equal((await execute('habit-before-worker')).candidates.length, 1);
    const firstObservation = fixture.database.prepare(
      `SELECT claim_fingerprint
       FROM memory_pattern_observations
       WHERE observation_state = 'supporting'
       LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    const fingerprint = String(firstObservation?.claim_fingerprint || '');
    assert.ok(fingerprint);
    const observationStore = new PatternObservationStore(fixture.database);
    const identity = {
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal' as const,
      scopeKey: 'self',
      claimFingerprint: fingerprint,
      kind: 'preference' as const,
      subject: '用户',
      predicate: '稳定生活习惯',
      value: habitValue,
      negated: false,
    };

    fixture.record(
      'alice',
      'habit-stop-s1',
      'habit-stop-t1',
      `我已经停止${habitValue}。`,
      '2026-08-04T08:00:00.000Z',
    );
    const stopped = await execute('habit-stop-worker');
    assert.equal(stopped.candidates.length, 0);
    assert.ok(service.runEvents(stopped.run.id, 'alice').some((event) =>
      event.eventType === 'candidate_deferred' &&
      event.detail.reasonCode ===
        'insufficient_post_contradiction_support' &&
      event.detail.supportingTurnCount === 0 &&
      event.detail.requiredTurnCount === 3
    ));
    assert.equal(observationStore.evidenceForVerification(identity).length, 0);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(DISTINCT claim_fingerprint) AS count
         FROM memory_pattern_observations`,
      ).get()?.count,
      1,
      '停止观察必须命中原习惯 fingerprint',
    );
    assert.deepEqual(
      { ...fixture.database.prepare(
        `SELECT COUNT(DISTINCT kind) AS count, MIN(kind) AS kind
         FROM memory_pattern_observations`,
      ).get() },
      { count: 1, kind: 'preference' },
      '服务端必须纠正模型误报的习惯 kind',
    );

    const recoveredTurnIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const turn = fixture.record(
        'alice',
        `habit-after-s${index}`,
        `habit-after-t${index}`,
        `恢复后第 ${index} 次${habitValue}。`,
        `2026-08-0${index + 4}T08:00:00.000Z`,
      );
      recoveredTurnIds.push(turn.id);
      const result = await execute(`habit-after-worker-${index}`);
      assert.equal(result.candidates.length, index === 3 ? 1 : 0);
      if (index < 3) {
        assert.ok(service.runEvents(result.run.id, 'alice').some((event) =>
          event.eventType === 'candidate_deferred' &&
          event.detail.reasonCode ===
            'insufficient_post_contradiction_support' &&
          event.detail.supportingTurnCount === index &&
          event.detail.requiredTurnCount === 3
        ));
      }
    }
    assert.deepEqual(
      observationStore.evidenceForVerification(identity).map(
        (item) => item.turnId,
      ),
      recoveredTurnIds,
    );
  } finally {
    fixture.close();
  }
});

test('模型漏报强停止时服务端仍建立屏障并要求三条恢复证据', async () => {
  const fixture = createFixture();
  try {
    const habitValue = '工作日早上喝桂花乌龙';
    const candidate = (
      evidence: Array<{ turnAlias: string }>,
    ): ReflectionCandidateInput => ({
      kind: 'preference',
      subject: '用户',
      predicate: '稳定生活习惯',
      value: habitValue,
      confidence: 0.92,
      importance: 0.7,
      sensitivity: 'normal',
      negated: false,
      observationType: 'stable_pattern',
      evidence,
    });
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'deterministic-stop-barrier-v1',
      async reflect(input) {
        if (input.phase === 'verify') {
          return {
            candidates: [candidate(input.turns.map((turn) => ({
              turnAlias: turn.turnAlias,
            })))],
          };
        }
        const supporting = input.turns.filter((turn) =>
          turn.content.includes(habitValue) &&
          !turn.content.includes('先停止')
        );
        return {
          candidates: supporting.length === 0
            ? []
            : [candidate(supporting.map((turn) => ({
                turnAlias: turn.turnAlias,
              })))],
        };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        clock: fixture.now,
      },
    );
    const execute = async (workerId: string) => {
      const queued = service.queueRun({
        userId: 'alice',
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType: 'reflect',
        trigger: 'manual',
        requestedBy: 'alice',
      });
      return service.executeRun(queued.run.id, workerId);
    };

    for (let index = 1; index <= 3; index += 1) {
      fixture.record(
        'alice',
        `deterministic-stop-before-s${index}`,
        `deterministic-stop-before-t${index}`,
        `第 ${index} 次${habitValue}。`,
        `2026-08-0${index}T08:00:00.000Z`,
      );
    }
    assert.equal(
      (await execute('deterministic-stop-before-worker')).candidates.length,
      1,
    );
    const observationStore = new PatternObservationStore(fixture.database);
    const observation = fixture.database.prepare(
      `SELECT claim_fingerprint FROM memory_pattern_observations
       WHERE value_text = ? LIMIT 1`,
    ).get(habitValue) as Record<string, unknown> | undefined;
    const identity = {
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal' as const,
      scopeKey: 'self',
      claimFingerprint: String(observation?.claim_fingerprint || ''),
      kind: 'preference' as const,
      subject: '用户',
      predicate: '稳定生活习惯',
      value: habitValue,
      negated: false,
    };
    assert.ok(identity.claimFingerprint);

    fixture.record(
      'alice',
      'deterministic-stop-s1',
      'deterministic-stop-t1',
      `从今天起先停止${habitValue}，最近的安排不再继续。`,
      '2026-08-04T08:00:00.000Z',
    );
    const stopped = await execute('deterministic-stop-worker');
    assert.equal(stopped.candidates.length, 0);
    assert.equal(observationStore.clusterBlocked(identity), true);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_pattern_observations
         WHERE claim_fingerprint = ?
           AND observation_state = 'contradicting'`,
      ).get(identity.claimFingerprint)?.count,
      1,
    );
    assert.ok(service.runEvents(stopped.run.id, 'alice').some((event) =>
      event.eventType === 'deterministic_contradiction_observed'
    ));

    for (let index = 1; index <= 3; index += 1) {
      fixture.record(
        'alice',
        `deterministic-stop-after-s${index}`,
        `deterministic-stop-after-t${index}`,
        `恢复后第 ${index} 次${habitValue}。`,
        `2026-08-0${index + 4}T08:00:00.000Z`,
      );
      const result = await execute(`deterministic-stop-after-worker-${index}`);
      assert.equal(result.candidates.length, index === 3 ? 1 : 0);
      assert.equal(
        observationStore.clusterBlocked(identity),
        index < 3,
      );
    }
  } finally {
    fixture.close();
  }
});

test('否定意图、假设和停止提醒不得误建稳定习惯屏障', async () => {
  const fixture = createFixture();
  try {
    const habitValue = '工作日早上喝桂花乌龙';
    const candidate = (
      evidence: Array<{ turnAlias: string }>,
    ): ReflectionCandidateInput => ({
      kind: 'preference',
      subject: '用户',
      predicate: '稳定生活习惯',
      value: habitValue,
      confidence: 0.92,
      importance: 0.7,
      sensitivity: 'normal',
      negated: false,
      observationType: 'stable_pattern',
      evidence,
    });
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'deterministic-stop-negative-cases-v1',
      async reflect(input) {
        if (input.phase === 'verify') {
          return { candidates: [candidate(input.turns.map((turn) => ({
            turnAlias: turn.turnAlias,
          })))] };
        }
        const stopLike = input.turns.find((turn) =>
          turn.content.includes('停止')
        );
        if (stopLike) {
          return { candidates: [{
            ...candidate([{ turnAlias: stopLike.turnAlias }]),
            negated: true,
            observationType: 'possible_change',
          }] };
        }
        const supports = input.turns.filter((turn) =>
          turn.content.startsWith('第') && turn.content.includes(habitValue)
        );
        return {
          candidates: supports.length === 0
            ? []
            : [candidate(supports.map((turn) => ({
                turnAlias: turn.turnAlias,
              })))],
        };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const execute = async (workerId: string) => {
      const queued = service.queueRun({
        userId: 'alice',
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType: 'reflect',
        trigger: 'manual',
        requestedBy: 'alice',
      });
      return service.executeRun(queued.run.id, workerId);
    };
    for (let index = 1; index <= 3; index += 1) {
      fixture.record(
        'alice',
        `stop-negative-before-s${index}`,
        `stop-negative-before-t${index}`,
        `第 ${index} 次${habitValue}。`,
        `2026-08-0${index}T08:00:00.000Z`,
      );
    }
    assert.equal((await execute('stop-negative-before-worker')).candidates.length, 1);
    const fingerprint = String(fixture.database.prepare(
      `SELECT claim_fingerprint FROM memory_pattern_observations
       WHERE value_text = ? LIMIT 1`,
    ).get(habitValue)?.claim_fingerprint || '');
    assert.ok(fingerprint);

    const negativeCases = [
      `我没打算停止${habitValue}，之后还会继续。`,
      `我不会停止${habitValue}。`,
      `请停止提醒我${habitValue}，行为本身照旧。`,
      `假设停止${habitValue}，只是讨论一种可能。`,
    ];
    for (const [index, content] of negativeCases.entries()) {
      fixture.record(
        'alice',
        `stop-negative-s${index + 1}`,
        `stop-negative-t${index + 1}`,
        content,
        `2026-08-${String(index + 4).padStart(2, '0')}T08:00:00.000Z`,
      );
      const result = await execute(`stop-negative-worker-${index + 1}`);
      assert.equal(result.candidates.length, 0);
      assert.equal(result.run.rejectedCount, 1);
      assert.ok(service.runEvents(result.run.id, 'alice').some((event) =>
        event.eventType === 'candidate_rejected' &&
        event.detail.reasonCode === 'habit_change_not_explicitly_grounded'
      ));
      assert.equal(
        service.runEvents(result.run.id, 'alice').some((event) =>
          event.eventType === 'deterministic_contradiction_observed'
        ),
        false,
      );
    }
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_pattern_observations
         WHERE claim_fingerprint = ?
           AND observation_state = 'contradicting'`,
      ).get(fingerprint)?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('人工拒绝和 tombstone 在 verify 前终止且不产生候选副作用', async () => {
  for (const scenario of [
    {
      blockFuture: false,
      expectedDecision: 'rejected',
      expectedDeferral: 'permanently_blocked',
    },
    {
      blockFuture: true,
      expectedDecision: 'blocked',
      expectedDeferral: 'tombstone_blocked',
    },
  ]) {
    const fixture = createFixture();
    try {
      const habitValue = '工作日早上喝桂花乌龙';
      let verificationCalls = 0;
      const candidate = (
        evidence: Array<{ turnAlias: string }>,
      ): ReflectionCandidateInput => ({
        kind: 'preference',
        subject: '用户',
        predicate: '稳定生活习惯',
        value: habitValue,
        confidence: 0.92,
        importance: 0.7,
        sensitivity: 'normal',
        negated: false,
        observationType: 'stable_pattern',
        evidence,
      });
      const reflectionProvider: ReflectionProvider = {
        model: 'qwen2.5:14b',
        promptVersion: `governance-before-verify-${scenario.expectedDecision}`,
        async reflect(input) {
          if (input.phase === 'verify') verificationCalls += 1;
          return { candidates: [candidate(input.turns.map((turn) => ({
            turnAlias: turn.turnAlias,
          })))] };
        },
      };
      const service = new MemoryReflectionService(
        fixture.database,
        fixture.lifecycle,
        extractor,
        reflectionProvider,
        { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
      );
      const execute = async (workerId: string) => {
        const queued = service.queueRun({
          userId: 'alice',
          namespace: 'personal',
          scopeType: 'personal',
          scopeKey: 'self',
          runType: 'reflect',
          trigger: 'manual',
          requestedBy: 'alice',
        });
        return service.executeRun(queued.run.id, workerId);
      };
      for (let index = 1; index <= 3; index += 1) {
        fixture.record(
          'alice',
          `governance-before-s${index}`,
          `governance-before-t${index}`,
          `第 ${index} 次${habitValue}。`,
          `2026-08-0${index}T08:00:00.000Z`,
        );
      }
      const baseline = await execute(
        `governance-before-${scenario.expectedDecision}-worker`,
      );
      const originalCandidate = baseline.candidates[0]!;
      assert.ok(originalCandidate);
      assert.equal(verificationCalls, 1);
      new CandidateResolver(
        fixture.database,
        fixture.lifecycle,
        new MemoryStore(fixture.database),
        { mode: 'shadow' },
      ).rejectForReview(originalCandidate.id, scenario.blockFuture);
      assert.equal(
        fixture.database.prepare(
          `SELECT decision FROM memory_reflection_claims
           WHERE candidate_id = ?`,
        ).get(originalCandidate.id)?.decision,
        scenario.expectedDecision,
      );
      const candidateCountBefore = Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_candidates`,
      ).get()?.count || 0);
      const jobCountBefore = Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_jobs
         WHERE job_type = 'resolve_candidate'`,
      ).get()?.count || 0);

      fixture.record(
        'alice',
        `governance-after-${scenario.expectedDecision}-s1`,
        `governance-after-${scenario.expectedDecision}-t1`,
        `今天照常${habitValue}。`,
        '2026-08-05T08:00:00.000Z',
      );
      const result = await execute(
        `governance-after-${scenario.expectedDecision}-worker`,
      );
      assert.equal(result.candidates.length, 0);
      assert.equal(result.run.rejectedCount, 0);
      assert.equal(verificationCalls, 1, '治理阻断后不得再调用 verify');
      assert.equal(
        fixture.database.prepare(
          `SELECT COUNT(*) AS count FROM memory_candidates`,
        ).get()?.count,
        candidateCountBefore,
      );
      assert.equal(
        fixture.database.prepare(
          `SELECT COUNT(*) AS count FROM memory_jobs
           WHERE job_type = 'resolve_candidate'`,
        ).get()?.count,
        jobCountBefore,
      );
      const events = service.runEvents(result.run.id, 'alice');
      assert.ok(events.some((event) =>
        event.eventType === 'candidate_deferred' &&
        event.detail.reasonCode === scenario.expectedDeferral
      ), JSON.stringify({ scenario, events }));
    } finally {
      fixture.close();
    }
  }
});

test('明确停止旧习惯并改用新值时双观察分流，未明确旧值时不猜测', async () => {
  const fixture = createFixture();
  try {
    const oldValue = '工作日早上喝桂花乌龙';
    const newValue = '工作日早上喝黑咖啡';
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'explicit-habit-replacement-v1',
      async reflect(input) {
        const candidate = (
          value: string,
          observationType: ReflectionCandidateInput['observationType'],
          negated: boolean,
          evidenceTurns: typeof input.turns,
          kind: ReflectionCandidateInput['kind'] = 'preference',
        ): ReflectionCandidateInput => ({
          kind,
          subject: '用户',
          predicate: '稳定生活习惯',
          value,
          confidence: 0.92,
          importance: 0.7,
          sensitivity: 'normal',
          negated,
          observationType,
          evidence: evidenceTurns.map((turn) => ({
            turnAlias: turn.turnAlias,
            excerpt: turn.content,
          })),
        });
        if (input.phase === 'verify' && input.verificationClaim) {
          return {
            candidates: [candidate(
              input.verificationClaim.value,
              'stable_pattern',
              input.verificationClaim.negated,
              input.turns,
              input.verificationClaim.kind,
            )],
          };
        }
        const replacement = input.turns.find((turn) =>
          turn.content.includes('改为')
        );
        if (replacement) {
          return { candidates: [
            candidate(oldValue, 'possible_change', true, [replacement], 'event'),
            candidate(newValue, 'stable_pattern', false, [replacement], 'relationship'),
          ] };
        }
        const ambiguous = input.turns.find((turn) =>
          turn.content.includes('这个习惯我改了')
        );
        if (ambiguous) {
          return {
            candidates: [candidate(
              oldValue,
              'possible_change',
              true,
              [ambiguous],
            )],
          };
        }
        const value = input.turns.some((turn) =>
          turn.content.includes(newValue)
        ) ? newValue : oldValue;
        const evidenceTurns = input.turns.filter((turn) =>
          turn.content.includes(value)
        );
        return {
          candidates: evidenceTurns.length === 0
            ? []
            : [candidate(
                value,
                'stable_pattern',
                false,
                evidenceTurns,
              )],
        };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        clock: fixture.now,
      },
    );
    const execute = async (workerId: string) => {
      const queued = service.queueRun({
        userId: 'alice',
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType: 'reflect',
        trigger: 'manual',
        requestedBy: 'alice',
      });
      return service.executeRun(queued.run.id, workerId);
    };
    const identity = (
      value: string,
      fingerprint: string,
    ) => ({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal' as const,
      scopeKey: 'self',
      claimFingerprint: fingerprint,
      kind: 'preference' as const,
      subject: '用户',
      predicate: '稳定生活习惯',
      value,
      negated: false,
    });

    for (let index = 1; index <= 3; index += 1) {
      fixture.record(
        'alice',
        `replace-old-s${index}`,
        `replace-old-t${index}`,
        `第 ${index} 次${oldValue}。`,
        `2026-08-0${index}T08:00:00.000Z`,
      );
    }
    assert.equal((await execute('replace-old-worker')).candidates.length, 1);
    const oldFingerprint = String(fixture.database.prepare(
      `SELECT claim_fingerprint
       FROM memory_pattern_observations
       WHERE value_text = ? LIMIT 1`,
    ).get(oldValue)?.claim_fingerprint || '');
    assert.ok(oldFingerprint);

    const replacementTurn = fixture.record(
      'alice',
      'replace-explicit-s1',
      'replace-explicit-t1',
      `我不再${oldValue}，改为${newValue}。`,
      '2026-08-04T08:00:00.000Z',
    );
    assert.equal(
      (await execute('replace-explicit-worker')).candidates.length,
      0,
      '新值只有一条证据时不得提前晋升',
    );
    const newFingerprint = String(fixture.database.prepare(
      `SELECT claim_fingerprint
       FROM memory_pattern_observations
       WHERE value_text = ? LIMIT 1`,
    ).get(newValue)?.claim_fingerprint || '');
    assert.ok(newFingerprint);
    assert.notEqual(newFingerprint, oldFingerprint);
    const store = new PatternObservationStore(fixture.database);
    assert.equal(
      store.evidenceForVerification(identity(oldValue, oldFingerprint)).length,
      0,
      '明确停止后旧值必须退出可验证状态',
    );
    assert.equal(
      store.evidenceForVerification(identity(newValue, newFingerprint)).length,
      0,
    );

    const newEvidenceTurnIds = [replacementTurn.id];
    for (let index = 1; index <= 2; index += 1) {
      const turn = fixture.record(
        'alice',
        `replace-new-s${index}`,
        `replace-new-t${index}`,
        `改用后第 ${index + 1} 次${newValue}。`,
        `2026-08-0${index + 4}T08:00:00.000Z`,
      );
      newEvidenceTurnIds.push(turn.id);
      const result = await execute(`replace-new-worker-${index}`);
      assert.equal(result.candidates.length, index === 2 ? 1 : 0);
    }
    assert.deepEqual(
      store.evidenceForVerification(identity(newValue, newFingerprint)).map(
        (item) => item.turnId,
      ),
      newEvidenceTurnIds,
    );

    const observationCount = Number(fixture.database.prepare(
      'SELECT COUNT(*) AS count FROM memory_pattern_observations',
    ).get()?.count || 0);
    fixture.record(
      'alice',
      'replace-ambiguous-s1',
      'replace-ambiguous-t1',
      '这个习惯我改了。',
      '2026-08-07T08:00:00.000Z',
    );
    const ambiguousResult = await execute('replace-ambiguous-worker');
    assert.equal(ambiguousResult.candidates.length, 0);
    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_pattern_observations',
      ).get()?.count,
      observationCount,
      '未明确旧值的“改了”不得产生猜测观察',
    );
  } finally {
    fixture.close();
  }
});

test('中文全角标点证据必须保持原文并通过重提取与反思校验', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record(
        'alice',
        'fullwidth-s1',
        'fullwidth-t1',
        '时间轴第 1 天：周一早上我喝桂花乌龙。',
        '2026-08-05T08:00:00.000Z',
      ),
      fixture.record(
        'alice',
        'fullwidth-s1',
        'fullwidth-t2',
        '时间轴第 3 天：周三早上我也喝桂花乌龙。',
        '2026-08-06T08:00:00.000Z',
      ),
      fixture.record(
        'alice',
        'fullwidth-s1',
        'fullwidth-t3',
        '时间轴第 5 天：今天上班前还是桂花乌龙。',
        '2026-08-07T08:00:00.000Z',
      ),
    ];
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      {
        ...extractor,
        async extract(turn) {
          return [{
            kind: 'preference',
            subject: '用户',
            predicate: '稳定口味标记',
            value: '桂花乌龙',
            content: '',
            confidence: 1,
            importance: 0.8,
            sensitivity: 'normal',
            scopeType: 'personal',
            scopeKey: 'self',
            sourceExcerpt: turn.content,
            sourceAuthority: 'direct_user',
          }];
        },
      },
      provider({
        candidates: [{
          kind: 'preference',
          subject: '用户',
          predicate: '工作日前饮品模式',
          value: '工作日前偏好桂花乌龙',
          confidence: 0.9,
          importance: 0.7,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: turns.map((turn, index) => ({
            turnAlias: `T${index + 1}`,
            excerpt: turn.content,
          })),
        }],
      }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const run = async (runType: 'reextract' | 'reflect') => {
      const queued = service.queueRun({
        userId: 'alice',
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType,
        trigger: 'manual',
        requestedBy: 'alice',
      });
      return service.executeRun(
        queued.run.id,
        `fullwidth-${runType}-worker`,
      );
    };

    const reextract = await run('reextract');
    assert.equal(reextract.candidates.length, 1);
    assert.equal(reextract.candidates[0]?.candidateOrigin, 'history_reextract');
    assert.match(reextract.candidates[0]?.sourceExcerpt || '', /时间轴第 1 天：/u);

    const reflect = await run('reflect');
    assert.equal(reflect.candidates.length, 1);
    const evidence = fixture.database.prepare(
      `SELECT excerpt
       FROM memory_candidate_evidence
       WHERE candidate_id = ?
       ORDER BY ordinal ASC`,
    ).all(reflect.candidates[0]!.id) as Array<Record<string, unknown>>;
    assert.deepEqual(
      evidence.map((row) => String(row.excerpt)),
      turns.map((turn) => turn.content),
    );
    assert.ok(evidence.every((row) => String(row.excerpt).includes('：')));
  } finally {
    fixture.close();
  }
});

test('reflection 候选审核与 claim 决策原子同步并拒绝冲突决策', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record('alice', 's1', 'claim-t1', '周一早上我喝桂花乌龙。', '2026-08-05T08:00:00.000Z'),
      fixture.record('alice', 's1', 'claim-t2', '周三早上我也喝桂花乌龙。', '2026-08-06T08:00:00.000Z'),
      fixture.record('alice', 's1', 'claim-t3', '今天上班前还是桂花乌龙。', '2026-08-07T08:00:00.000Z'),
    ];
    const evidence = turns.map((turn, index) => ({
      turnAlias: `T${index + 1}`,
      excerpt: turn.content,
    }));
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({
        candidates: [
          {
            kind: 'preference',
            subject: '用户',
            predicate: '工作日前饮品模式',
            value: '桂花乌龙',
            confidence: 0.9,
            importance: 0.7,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence,
          },
          {
            kind: 'preference',
            subject: '用户',
            predicate: '工作日前饮品备选',
            value: '桂花乌龙',
            confidence: 0.85,
            importance: 0.6,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence,
          },
          {
            kind: 'preference',
            subject: '用户',
            predicate: '工作日前饮品禁记项',
            value: '桂花乌龙',
            confidence: 0.8,
            importance: 0.5,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence,
          },
        ],
      }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    await service.executeRun(queued.run.id, 'claim-worker');
    const candidates = fixture.lifecycle.listCandidates({
      userId: 'alice',
      namespace: 'personal',
      reflectionRunId: queued.run.id,
    });
    assert.equal(candidates.length, 3);

    fixture.lifecycle.updateCandidateState(
      candidates[0].id,
      'accepted',
      'manual_confirmed',
    );
    fixture.lifecycle.updateCandidateState(
      candidates[1].id,
      'rejected',
      'manual_rejected',
    );
    fixture.lifecycle.updateCandidateState(
      candidates[2].id,
      'rejected',
      'manual_rejected_and_tombstoned',
    );

    const decisions = fixture.database.prepare(
      `SELECT candidate_id, decision
       FROM memory_reflection_claims
       WHERE candidate_id IN (?, ?, ?)
       ORDER BY candidate_id`,
    ).all(...candidates.map((candidate) => candidate.id)) as Array<{
      candidate_id: string;
      decision: string;
    }>;
    assert.deepEqual(
      new Map(decisions.map((row) => [row.candidate_id, row.decision])),
      new Map([
        [candidates[0].id, 'confirmed'],
        [candidates[1].id, 'rejected'],
        [candidates[2].id, 'blocked'],
      ]),
    );
    assert.throws(
      () => fixture.lifecycle.updateCandidateState(
        candidates[0].id,
        'rejected',
        'manual_rejected',
      ),
      /已完成其他决策/,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT decision
         FROM memory_reflection_claims
         WHERE candidate_id = ?`,
      ).get(candidates[0].id)?.decision,
      'confirmed',
    );
  } finally {
    fixture.close();
  }
});

test('数据库拒绝把其他 role 的 turn 挂到 reflection 候选证据', async () => {
  const fixture = createFixture();
  try {
    const roleATurns = [];
    for (let index = 0; index < 3; index += 1) {
      roleATurns.push(fixture.lifecycle.recordTurn({
        userId: 'alice',
        namespace: 'personal',
        clientName: 'client',
        sessionExternalId: 'role-a-session',
        turnExternalId: `role-a-turn-${index + 1}`,
        personaId: 'persona-a',
        identitySource: 'credential',
        identityStatus: 'complete',
        roundId: `role-a-round-${index + 1}`,
        role: 'user',
        content: `第 ${index + 1} 次确认工作日前喝桂花乌龙。`,
        occurredAt: `2026-08-0${index + 5}T08:00:00.000Z`,
      }).turn);
    }
    const roleBTurn = fixture.lifecycle.recordTurn({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'role-b-session',
      turnExternalId: 'role-b-turn-1',
      personaId: 'persona-b',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'role-b-round-1',
      role: 'user',
      content: '这个角色只喝玄米茶。',
      occurredAt: '2026-08-08T09:00:00.000Z',
    }).turn;
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({
        candidates: [{
          kind: 'preference',
          subject: '用户',
          predicate: '工作日前饮品模式',
          value: '桂花乌龙',
          confidence: 0.9,
          importance: 0.7,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: roleATurns.map((turn, index) => ({
            turnAlias: `T${index + 1}`,
            excerpt: turn.content,
          })),
        }],
      }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'role',
      scopeKey: 'persona-a',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const executed = await service.executeRun(
      queued.run.id,
      'role-evidence-worker',
    );
    const candidate = executed.candidates[0]!;
    assert.equal(candidate.scopeType, 'role');
    assert.equal(candidate.scopeKey, 'persona-a');
    assert.throws(
      () => fixture.database.prepare(
        `INSERT INTO memory_candidate_evidence (
           candidate_id, turn_id, excerpt, excerpt_hash,
           evidence_type, ordinal, created_at,
           user_id, namespace, scope_type, scope_key
         ) VALUES (?, ?, ?, ?, 'pattern_support', 99, ?, ?, ?, ?, ?)`,
      ).run(
        candidate.id,
        roleBTurn.id,
        roleBTurn.content,
        'f'.repeat(64),
        '2026-08-09T12:00:00.000Z',
        'alice',
        'personal',
        'role',
        'persona-a',
      ),
      /candidate evidence owner\/scope mismatch/iu,
    );
    const updateTrigger = fixture.database.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type = 'trigger'
         AND name = 'memory_candidate_evidence_owner_update'`,
    ).get()?.sql;
    assert.equal(typeof updateTrigger, 'string');
    fixture.database.exec(
      'DROP TRIGGER memory_candidate_evidence_owner_update',
    );
    fixture.database.prepare(
      `UPDATE memory_candidate_evidence
       SET turn_id = ?
       WHERE candidate_id = ? AND ordinal = 0`,
    ).run(roleBTurn.id, candidate.id);
    fixture.database.exec(String(updateTrigger));
    fixture.database.exec(`
      DROP TRIGGER conversation_turn_ingest_order_insert;
      DROP TRIGGER memory_turn_ingest_order_owner_insert;
      DROP TRIGGER memory_turn_ingest_order_identity_immutable;
      DROP INDEX memory_turn_ingest_owner_idx;
      DROP INDEX memory_turn_ingest_session_idx;
      ALTER TABLE memory_turn_ingest_order
        RENAME TO memory_turn_ingest_order_v31;
      CREATE TABLE memory_turn_ingest_order (
        ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT NOT NULL UNIQUE
          REFERENCES conversation_turns(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );
      INSERT INTO memory_turn_ingest_order (
        ingest_seq, turn_id, user_id, namespace, ingested_at
      )
      SELECT ingest_seq, turn_id, user_id, namespace, ingested_at
      FROM memory_turn_ingest_order_v31
      ORDER BY ingest_seq;
      DROP TABLE memory_turn_ingest_order_v31;
      CREATE INDEX memory_turn_ingest_owner_idx
        ON memory_turn_ingest_order(user_id, namespace, ingest_seq ASC);
      CREATE TRIGGER conversation_turn_ingest_order_insert
      AFTER INSERT ON conversation_turns
      BEGIN
        INSERT OR IGNORE INTO memory_turn_ingest_order (
          turn_id, user_id, namespace, ingested_at
        ) VALUES (NEW.id, NEW.user_id, NEW.namespace, NEW.created_at);
      END;
      PRAGMA user_version = 30;
    `);
    assert.throws(
      () => openDatabase(fixture.filePath),
      /candidate evidence scope 校验失败/iu,
    );
    assert.equal(
      fixture.database.prepare('PRAGMA user_version').get()?.user_version,
      30,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM pragma_table_info('memory_turn_ingest_order')
         WHERE name = 'session_id'`,
      ).get()?.count,
      0,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT turn_id FROM memory_candidate_evidence
         WHERE candidate_id = ? AND ordinal = 0`,
      ).get(candidate.id)?.turn_id,
      roleBTurn.id,
    );
  } finally {
    fixture.close();
  }
});

test('阻止以后再记与候选、claim、outbox 必须在同一事务回滚', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record('alice', 'atomic-s1', 'atomic-t1', '周一早上我喝桂花乌龙。', '2026-08-05T08:00:00.000Z'),
      fixture.record('alice', 'atomic-s1', 'atomic-t2', '周三早上我也喝桂花乌龙。', '2026-08-06T08:00:00.000Z'),
      fixture.record('alice', 'atomic-s1', 'atomic-t3', '今天上班前还是桂花乌龙。', '2026-08-07T08:00:00.000Z'),
    ];
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({
        candidates: [{
          kind: 'preference',
          subject: '用户',
          predicate: '工作日前饮品模式',
          value: '桂花乌龙',
          confidence: 0.9,
          importance: 0.7,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: turns.map((turn, index) => ({
            turnAlias: `T${index + 1}`,
            excerpt: turn.content,
          })),
        }],
      }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const executed = await service.executeRun(
      queued.run.id,
      'atomic-worker',
    );
    const candidate = executed.candidates[0]!;
    fixture.database.prepare(
      `DELETE FROM memory_reflection_claims
       WHERE candidate_id = ?`,
    ).run(candidate.id);
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      { mode: 'shadow' },
    );

    assert.throws(
      () => resolver.rejectForReview(candidate.id, true),
      /缺少 claim 注册记录/u,
    );
    assert.equal(
      fixture.lifecycle.getCandidate(candidate.id)?.state,
      'pending',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_tombstones
         WHERE user_id = 'alice' AND namespace = 'personal'`,
      ).get()?.count,
      0,
      '审核事务失败时不得留下“以后不要再记”的半成品 tombstone',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM outbox_events
         WHERE aggregate_type = 'memory_candidate'
           AND aggregate_id = ?`,
      ).get(candidate.id)?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('接受候选缺少 claim 时规范记忆、版本、证据与候选必须原子回滚', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record('alice', 'accept-atomic-s1', 'accept-atomic-t1', '周一早上我喝桂花乌龙。', '2026-08-05T08:00:00.000Z'),
      fixture.record('alice', 'accept-atomic-s1', 'accept-atomic-t2', '周三早上我也喝桂花乌龙。', '2026-08-06T08:00:00.000Z'),
      fixture.record('alice', 'accept-atomic-s1', 'accept-atomic-t3', '今天上班前还是桂花乌龙。', '2026-08-07T08:00:00.000Z'),
    ];
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({
        candidates: [{
          kind: 'preference',
          subject: '用户',
          predicate: '工作日前饮品模式',
          value: '桂花乌龙',
          confidence: 0.9,
          importance: 0.7,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: turns.map((turn, index) => ({
            turnAlias: `T${index + 1}`,
            excerpt: turn.content,
          })),
        }],
      }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const candidate = (await service.executeRun(
      queued.run.id,
      'accept-atomic-worker',
    )).candidates[0]!;
    fixture.database.prepare(
      `DELETE FROM memory_reflection_claims WHERE candidate_id = ?`,
    ).run(candidate.id);
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      { mode: 'shadow' },
    );

    assert.throws(
      () => resolver.acceptForReview(candidate.id),
      /缺少 claim 注册记录/u,
    );
    for (const table of [
      'memories',
      'memory_items',
      'memory_versions',
      'memory_evidence',
    ]) {
      assert.equal(
        fixture.database.prepare(
          `SELECT COUNT(*) AS count FROM ${table}`,
        ).get()?.count,
        0,
        `${table} 不得留下审核半提交数据`,
      );
    }
    assert.equal(
      fixture.lifecycle.getCandidate(candidate.id)?.state,
      'pending',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM outbox_events
         WHERE aggregate_type = 'memory_candidate'
           AND aggregate_id = ?`,
      ).get(candidate.id)?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('接受候选前证据正文已被 TTL 擦除时必须拒绝且零规范写入', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record('alice', 'accept-ttl-s1', 'accept-ttl-t1', '周一早上我喝桂花乌龙。', '2026-08-05T08:00:00.000Z'),
      fixture.record('alice', 'accept-ttl-s1', 'accept-ttl-t2', '周三早上我也喝桂花乌龙。', '2026-08-06T08:00:00.000Z'),
      fixture.record('alice', 'accept-ttl-s1', 'accept-ttl-t3', '今天上班前还是桂花乌龙。', '2026-08-07T08:00:00.000Z'),
    ];
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({
        candidates: [{
          kind: 'preference',
          subject: '用户',
          predicate: '工作日前饮品模式',
          value: '桂花乌龙',
          confidence: 0.9,
          importance: 0.7,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: turns.map((turn, index) => ({
            turnAlias: `T${index + 1}`,
            excerpt: turn.content,
          })),
        }],
      }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const candidate = (await service.executeRun(
      queued.run.id,
      'accept-ttl-worker',
    )).candidates[0]!;
    fixture.database.prepare(
      `UPDATE conversation_turns
       SET content = '[retention-redacted]'
       WHERE id IN (?, ?, ?)`,
    ).run(...turns.map((turn) => turn.id));
    fixture.database.prepare(
      `UPDATE memory_candidate_evidence
       SET excerpt = NULL
       WHERE candidate_id = ?`,
    ).run(candidate.id);
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      new MemoryStore(fixture.database),
      { mode: 'shadow' },
    );

    assert.throws(
      () => resolver.acceptForReview(candidate.id),
      /证据正文已被擦除或不可验证/u,
    );
    for (const table of [
      'memories',
      'memory_items',
      'memory_versions',
      'memory_evidence',
    ]) {
      assert.equal(
        fixture.database.prepare(
          `SELECT COUNT(*) AS count FROM ${table}`,
        ).get()?.count,
        0,
        `${table} 不得写入失去正文证据的候选`,
      );
    }
    assert.equal(
      fixture.lifecycle.getCandidate(candidate.id)?.state,
      'pending',
    );
  } finally {
    fixture.close();
  }
});

test('Memory Doctor 诊断 schema 30 reflection 孤儿、错配、水位、租约、预算、重复与哈希', async () => {
  const fixture = createFixture();
  try {
    const turns = [
      fixture.record('alice', 'doctor-s1', 'doctor-t1', '周一早上我喝桂花乌龙。', '2026-08-05T08:00:00.000Z'),
      fixture.record('alice', 'doctor-s1', 'doctor-t2', '周三早上我也喝桂花乌龙。', '2026-08-06T08:00:00.000Z'),
      fixture.record('alice', 'doctor-s1', 'doctor-t3', '今天上班前还是桂花乌龙。', '2026-08-07T08:00:00.000Z'),
    ];
    const bobTurn = fixture.record(
      'bob',
      'doctor-bob-s1',
      'doctor-bob-t1',
      'Bob 晚上喝玄米茶。',
      '2026-08-07T09:00:00.000Z',
    );
    const evidence = turns.map((turn, index) => ({
      turnAlias: `T${index + 1}`,
      excerpt: turn.content,
    }));
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({
        candidates: [
          {
            kind: 'preference',
            subject: '用户',
            predicate: '工作日前饮品模式',
            value: '桂花乌龙',
            confidence: 0.9,
            importance: 0.7,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence,
          },
          {
            kind: 'preference',
            subject: '用户',
            predicate: '工作日前饮品备选模式',
            value: '桂花乌龙',
            confidence: 0.85,
            importance: 0.6,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence,
          },
        ],
      }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const executed = await service.executeRun(
      queued.run.id,
      'doctor-worker',
    );
    const first = executed.candidates.find(
      (candidate) => candidate.predicate === '工作日前饮品模式',
    )!;
    const second = executed.candidates.find(
      (candidate) => candidate.predicate === '工作日前饮品备选模式',
    )!;
    fixture.database.prepare(
      `UPDATE memory_candidates
       SET claim_fingerprint = ?
       WHERE id = ?`,
    ).run(first.claimFingerprint, second.id);
    fixture.database.prepare(
      `UPDATE memory_reflection_runs
       SET status = 'running', lease_until = ?, lease_owner = 'stale-worker'
       WHERE id = ?`,
    ).run('2020-01-01T00:00:00.000Z', executed.run.id);
    fixture.database.prepare(
      `UPDATE memory_reflection_model_calls
       SET status = 'reserved', completed_at = NULL
       WHERE run_id = ?`,
    ).run(executed.run.id);
    fixture.database.prepare(
      `UPDATE memory_reflection_checkpoints
       SET last_ingest_seq = 999999
       WHERE user_id = 'alice' AND namespace = 'personal'
         AND run_type = 'reflect'`,
    ).run();
    fixture.database.exec('PRAGMA foreign_keys = OFF');
    fixture.database.exec(
      'DROP TRIGGER memory_candidate_evidence_owner_update',
    );
    fixture.database.prepare(
      `UPDATE memory_candidate_evidence
       SET candidate_id = 'missing-reflection-candidate'
       WHERE candidate_id = ? AND ordinal = 0`,
    ).run(first.id);
    fixture.database.prepare(
      `UPDATE memory_reflection_run_turns
       SET run_id = 'missing-reflection-run'
       WHERE run_id = ? AND ordinal = 0`,
    ).run(executed.run.id);
    fixture.database.prepare(
      `UPDATE memory_reflection_run_turns
       SET turn_id = ?
       WHERE run_id = ? AND ordinal = 1`,
    ).run(bobTurn.id, executed.run.id);
    fixture.database.prepare(
      `UPDATE memory_reflection_run_turns
       SET content_hash = 'invalid-reflection-content-hash'
       WHERE run_id = ? AND ordinal = 2`,
    ).run(executed.run.id);
    fixture.database.exec('PRAGMA foreign_keys = ON');

    const store = new MemoryStore(fixture.database);
    const resolver = new CandidateResolver(
      fixture.database,
      fixture.lifecycle,
      store,
      { mode: 'shadow' },
    );
    const admin = new MemoryAdminService(
      fixture.database,
      store,
      fixture.lifecycle,
      resolver,
      new MemoryGovernance(
        fixture.database,
        fixture.lifecycle,
        store,
      ),
    );
    const issues = new Map(
      admin.runMemoryDoctor('alice').issues.map((issue) => [
        issue.category,
        issue.count,
      ]),
    );
    for (const category of [
      'reflection_orphan_run_turn',
      'reflection_orphan_candidate_evidence',
      'reflection_scope_mismatch',
      'reflection_checkpoint_ahead',
      'reflection_stuck_run',
      'reflection_reserved_model_call',
      'reflection_duplicate_claim',
      'reflection_invalid_content_hash',
    ]) {
      assert.ok(
        Number(issues.get(category as never) || 0) > 0,
        `${category} 应报告至少一条`,
      );
    }
  } finally {
    fixture.close();
  }
});

test('无逐字证据、credential 和诊断式推断全部拒绝', async () => {
  const fixture = createFixture();
  try {
    fixture.record('alice', 's1', 't1', '最近三次会议我都很累。', '2026-08-05T08:00:00.000Z');
    fixture.record('alice', 's1', 't2', '今天会议后也很累。', '2026-08-06T08:00:00.000Z');
    fixture.record('alice', 's1', 't3', '昨天会议结束很累。', '2026-08-07T08:00:00.000Z');
    fixture.record('alice', 's1', 't4', '临时 API key 是 sk-quality-abcdef123456。', '2026-08-07T09:00:00.000Z');
    fixture.record('alice', 's1', 't5', '测试仍在使用 sk-quality-abcdef123456。', '2026-08-07T10:00:00.000Z');
    fixture.record('alice', 's1', 't6', '请删除 sk-quality-abcdef123456。', '2026-08-07T11:00:00.000Z');
    const common = {
      kind: 'profile' as const,
      subject: '用户',
      confidence: 0.9,
      importance: 0.7,
      sensitivity: 'normal' as const,
      negated: false,
      observationType: 'stable_pattern' as const,
    };
    const evidence = [1, 2, 3].map((index) => ({
      turnAlias: `T${index}`,
      excerpt: index === 1 ? '原文里不存在的证据' : '很累',
    }));
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [
        {
          ...common,
          predicate: '心理诊断',
          value: '患有抑郁症',
          evidence: [
            { turnAlias: 'T1', excerpt: '很累' },
            { turnAlias: 'T2', excerpt: '很累' },
            { turnAlias: 'T3', excerpt: '很累' },
          ],
        },
        {
          ...common,
          predicate: 'API Key',
          value: 'sk-secret-value',
          sensitivity: 'credential',
          evidence: [
            { turnAlias: 'T1', excerpt: '很累' },
            { turnAlias: 'T2', excerpt: '很累' },
            { turnAlias: 'T3', excerpt: '很累' },
          ],
        },
        {
          ...common,
          predicate: '会议后状态',
          value: '会议后容易疲惫',
          evidence,
        },
        {
          ...common,
          predicate: '历史记录内容',
          value: '[credential-redacted]',
          evidence: [4, 5, 6].map((index) => ({
            turnAlias: `T${index}`,
            excerpt: '[credential-redacted]',
          })),
        },
      ] }),
      { minNewTurns: 1, minPatternEvidence: 3, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const result = await service.executeRun(queued.run.id, 'worker-a');
    assert.equal(result.candidates.length, 0);
    assert.equal(result.run.rejectedCount, 4);
  } finally {
    fixture.close();
  }
});

test('每个被拒反思候选必须记录稳定 reasonCode 且不写候选正文', async () => {
  const fixture = createFixture();
  try {
    const turn = fixture.record(
      'alice',
      'candidate-reason-s1',
      'candidate-reason-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const sentinel = 'candidate-secret-sentinel';
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [{
        kind: 'preference',
        subject: '用户',
        predicate: '工作日饮品',
        value: sentinel,
        confidence: 0.9,
        importance: 0.7,
        sensitivity: 'normal',
        negated: false,
        observationType: 'stable_pattern',
        evidence: [{ turnAlias: 'T1', excerpt: turn.content }],
      }] }),
      { minNewTurns: 1, minPatternEvidence: 3 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    const result = await service.executeRun(
      queued.run.id,
      'candidate-reason-worker',
    );

    assert.equal(result.run.rejectedCount, 1);
    const rejected = service.runEvents(queued.run.id, 'alice').filter(
      (event) => event.eventType === 'candidate_rejected',
    );
    assert.equal(rejected.length, 1);
    assert.match(String(rejected[0]?.detail.reasonCode), /^[a-z0-9_]+$/u);
    assert.equal(JSON.stringify(rejected[0]?.detail).includes(sentinel), false);
  } finally {
    fixture.close();
  }
});

test('取消运行不推进 checkpoint，成功反思才推进', async () => {
  const fixture = createFixture();
  try {
    fixture.record('alice', 's1', 't1', '工作日早上我会喝桂花乌龙。', '2026-08-08T08:00:00.000Z');
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1 },
    );
    const cancelled = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    service.cancelRun(cancelled.run.id, 'alice');
    const cancelledResult = await service.executeRun(
      cancelled.run.id,
      'worker-a',
    );
    assert.equal(cancelledResult.run.status, 'cancelled');
    assert.equal(service.status('alice', 'personal').checkpoints.length, 0);
    assert.deepEqual(
      service.runEvents(cancelled.run.id, 'alice').map(
        (event) => event.eventType,
      ),
      ['queued', 'cancel_requested', 'cancelled'],
    );

    const successful = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'repair',
      requestedBy: 'alice',
      implementationVersion: 'reflection-implementation-v2',
    });
    const completed = await service.executeRun(successful.run.id, 'worker-a');
    assert.equal(completed.run.status, 'completed');
    const status = service.status('alice', 'personal');
    assert.equal(status.checkpoints.length, 1);
    assert.equal(status.checkpoints[0]?.lastTurnId, successful.turnIds.at(-1));
  } finally {
    fixture.close();
  }
});

test('运行中取消必须在提交前终止并记录 cancelled 终态事件', async () => {
  const fixture = createFixture();
  let releaseProvider: (() => void) | undefined;
  try {
    fixture.record(
      'alice',
      'running-cancel-s1',
      'running-cancel-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const gatedProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-running-cancel-v1',
      async reflect() {
        markProviderStarted?.();
        await providerGate;
        return { candidates: [] };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      gatedProvider,
      { minNewTurns: 1 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const execution = service.executeRun(queued.run.id, 'worker-a');
    await providerStarted;
    service.cancelRun(queued.run.id, 'alice');
    releaseProvider?.();
    const result = await execution;

    assert.equal(result.run.status, 'cancelled');
    assert.equal(service.status('alice', 'personal').checkpoints.length, 0);
    assert.deepEqual(
      service.runEvents(queued.run.id, 'alice').map(
        (event) => event.eventType,
      ),
      [
        'queued',
        'started',
        'model_call_reserved',
        'cancel_requested',
        'model_call_completed',
        'cancelled',
      ],
    );
  } finally {
    releaseProvider?.();
    fixture.close();
  }
});

test('sweep 必须在 reflect 已追平时继续排队落后的 reextract', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'checkpoint-drift-reflect-s1',
      'checkpoint-drift-reflect-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      {
        minNewTurns: 1,
        clock: () => new Date('2026-08-09T13:00:00.000Z'),
      },
    );
    const reflect = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    await service.executeRun(reflect.run.id, 'checkpoint-reflect-worker');

    assert.deepEqual(service.runSweep('alice', 'personal'), {
      scopes: 2,
      queuedRuns: 3,
      discoveryWatermark: 1,
    });
    const sweepRuns = (fixture.database.prepare(
      `SELECT run_type, input_turn_count
       FROM memory_reflection_runs
       WHERE trigger = 'sweep' AND scope_type = 'personal'
       ORDER BY run_type`,
    ).all() as Array<{ run_type: string; input_turn_count: number }>).map(
      (row) => ({ ...row }),
    );
    assert.deepEqual(sweepRuns, [{
      run_type: 'reextract',
      input_turn_count: 1,
    }]);
  } finally {
    fixture.close();
  }
});

test('sweep 必须在 reextract 已追平时只排队落后的 reflect', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'checkpoint-drift-reextract-s1',
      'checkpoint-drift-reextract-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      {
        minNewTurns: 1,
        clock: () => new Date('2026-08-09T13:00:00.000Z'),
      },
    );
    const reextract = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reextract',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    await service.executeRun(
      reextract.run.id,
      'checkpoint-reextract-worker',
    );

    assert.deepEqual(service.runSweep('alice', 'personal'), {
      scopes: 2,
      queuedRuns: 3,
      discoveryWatermark: 1,
    });
    const sweepRuns = (fixture.database.prepare(
      `SELECT run_type, input_turn_count
       FROM memory_reflection_runs
       WHERE trigger = 'sweep' AND scope_type = 'personal'
       ORDER BY run_type`,
    ).all() as Array<{ run_type: string; input_turn_count: number }>).map(
      (row) => ({ ...row }),
    );
    assert.deepEqual(sweepRuns, [{
      run_type: 'reflect',
      input_turn_count: 1,
    }]);
  } finally {
    fixture.close();
  }
});

test('status 必须用最落后 pipeline 计算总览 lag', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'status-lag-s1',
      'status-lag-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1 },
    );
    const reflect = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    await service.executeRun(reflect.run.id, 'status-lag-worker');

    const status = service.status('alice', 'personal');
    const personalLags = status.pipelineLags.filter(
      (lag) => lag.scopeType === 'personal' && lag.scopeKey === 'self',
    );
    assert.deepEqual(
      Object.fromEntries(personalLags.map((lag) => [lag.runType, lag.lag])),
      { reextract: 1, reflect: 0 },
    );
    assert.equal(status.checkpointLag, 1);
  } finally {
    fixture.close();
  }
});

test('sweep 必须纳入有新消息的 session scope', () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'session-sweep-s1',
      'session-sweep-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      {
        minNewTurns: 1,
        clock: () => new Date('2026-08-09T13:00:00.000Z'),
      },
    );

    const result = service.runSweep('alice', 'personal');
    assert.equal(result.scopes, 2);
    const sessionRuns = fixture.database.prepare(
      `SELECT run_type, input_turn_count
       FROM memory_reflection_runs
       WHERE trigger = 'sweep'
         AND scope_type = 'session' AND scope_key = 'session-sweep-s1'
       ORDER BY run_type`,
    ).all() as Array<{ run_type: string; input_turn_count: number }>;
    assert.deepEqual(
      sessionRuns.map((row) => ({ ...row })),
      [
        { run_type: 'reextract', input_turn_count: 1 },
        { run_type: 'reflect', input_turn_count: 1 },
      ],
    );
  } finally {
    fixture.close();
  }
});

test('首次 sweep 遇到未 idle 新 session 时不得越过 scope 发现水位', () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'deferred-idle-session',
      'deferred-idle-turn',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-09T12:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      {
        minNewTurns: 1,
        idleMinutes: 30,
        clock: fixture.now,
      },
    );

    const first = service.runSweep('alice', 'personal', 0);
    assert.equal(first.discoveryWatermark, 0);
    assert.equal(first.scopes, 1);
    assert.equal(first.queuedRuns, 0);

    fixture.advance(31 * 60_000);
    const second = service.runSweep(
      'alice',
      'personal',
      first.discoveryWatermark,
    );
    assert.equal(second.discoveryWatermark, 1);
    assert.equal(second.scopes, 2);
    const sessionRuns = fixture.database.prepare(
      `SELECT run_type, input_turn_count
       FROM memory_reflection_runs
       WHERE trigger = 'sweep'
         AND scope_type = 'session'
         AND scope_key = 'deferred-idle-session'
       ORDER BY run_type`,
    ).all() as Array<{ run_type: string; input_turn_count: number }>;
    assert.deepEqual(
      sessionRuns.map((row) => ({ ...row })),
      [
        { run_type: 'reextract', input_turn_count: 1 },
        { run_type: 'reflect', input_turn_count: 1 },
      ],
    );
  } finally {
    fixture.close();
  }
});

test('首次 sweep 后 scope 目录不得因历史 turn 退出回看窗口而丢失', () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'scope-catalog-s1',
      'scope-catalog-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      {
        minNewTurns: 1,
        lookbackDays: 30,
        clock: fixture.now,
      },
    );
    fixture.advance(60 * 60_000);
    assert.equal(service.runSweep('alice', 'personal').scopes, 2);

    fixture.advance(31 * 86_400_000);
    assert.equal(service.runSweep('alice', 'personal').scopes, 2);
  } finally {
    fixture.close();
  }
});

test('自动 sweep 后继任务必须持久化 scope 发现水位', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'sweep-watermark-s1',
      'sweep-watermark-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    fixture.advance(60 * 60_000);
    fixture.database.prepare(
      "UPDATE outbox_events SET status = 'completed'",
    ).run();
    fixture.database.prepare(
      "UPDATE memory_jobs SET status = 'completed'",
    ).run();
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1, clock: fixture.now },
    );
    service.ensureSweep('alice', 'personal');
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      service,
    );

    const result = await worker.processNext('sweep-watermark-worker');
    assert.equal(result.job?.jobType, 'reflection_sweep');
    const successor = fixture.database.prepare(
      `SELECT payload_json
       FROM memory_jobs
       WHERE job_type = 'reflection_sweep' AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
    ).get() as { payload_json: string } | undefined;
    const payload = JSON.parse(successor?.payload_json || '{}') as {
      scopeDiscoveryWatermark?: number;
    };
    assert.ok(Number(payload.scopeDiscoveryWatermark || 0) > 0);
  } finally {
    fixture.close();
  }
});

test('模型重试的每次物理调用必须分别预留并记入预算账本', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'retry-ledger-s1',
      'retry-ledger-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    let providerCalls = 0;
    const retryingProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-retry-ledger-v1',
      async reflect() {
        providerCalls += 1;
        if (providerCalls === 1) {
          throw new Error('temporary provider failure');
        }
        return { candidates: [] };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      retryingProvider,
      { minNewTurns: 1, maxDailyCalls: 10 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    await assert.rejects(
      service.executeRun(queued.run.id, 'retry-ledger-worker-a'),
      /temporary provider failure/u,
    );
    const completed = await service.executeRun(
      queued.run.id,
      'retry-ledger-worker-b',
    );
    assert.equal(completed.run.status, 'completed');
    assert.equal(providerCalls, 2);
    const calls = fixture.database.prepare(
      `SELECT status
       FROM memory_reflection_model_calls
       WHERE run_id = ?
       ORDER BY reserved_at ASC, id ASC`,
    ).all(queued.run.id) as Array<{ status: string }>;
    assert.deepEqual(
      calls.map((call) => call.status).sort(),
      ['completed', 'failed'],
    );
    assert.deepEqual(
      service.runEvents(queued.run.id, 'alice').map(
        (event) => event.eventType,
      ),
      [
        'queued',
        'started',
        'model_call_reserved',
        'model_call_failed',
        'failed',
        'started',
        'model_call_reserved',
        'model_call_completed',
        'completed',
      ],
    );
    assert.deepEqual(
      service.modelCalls(queued.run.id, 'alice').map((call) => call.status)
        .sort(),
      ['completed', 'failed'],
    );
  } finally {
    fixture.close();
  }
});

test('模型派发前租约失效必须退款且不得调用 provider', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'refund-before-dispatch-s1',
      'refund-before-dispatch-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    let providerCalls = 0;
    const neverDispatchedProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-refund-v1',
      async reflect() {
        providerCalls += 1;
        return { candidates: [] };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      neverDispatchedProvider,
      {
        minNewTurns: 1,
        leaseSeconds: -1,
        clock: () => new Date('2026-08-09T12:00:00.000Z'),
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    await assert.rejects(
      service.executeRun(queued.run.id, 'refund-worker'),
      /租约失效/u,
    );
    assert.equal(providerCalls, 0);
    assert.deepEqual(
      service.modelCalls(queued.run.id, 'alice').map((call) => call.status),
      ['refunded'],
    );
    assert.deepEqual(
      service.runEvents(queued.run.id, 'alice').map(
        (event) => event.eventType,
      ),
      [
        'queued',
        'started',
        'model_call_reserved',
        'model_call_refunded',
        'failed',
      ],
    );
  } finally {
    fixture.close();
  }
});

test('模型返回后 reflection 租约已过期必须失败且不推进 checkpoint', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'lease-expired-after-model-s1',
      'lease-expired-after-model-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const expiringProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-expired-after-model-v1',
      async reflect() {
        fixture.advance(2_000);
        return { candidates: [] };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      expiringProvider,
      {
        minNewTurns: 1,
        leaseSeconds: 1,
        clock: fixture.now,
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    await assert.rejects(
      service.executeRun(queued.run.id, 'expired-after-model-worker'),
      /租约失效/u,
    );

    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_reflection_checkpoints',
      ).get()?.count,
      0,
    );
    assert.equal(service.getRun(queued.run.id, 'alice')?.status, 'failed');
  } finally {
    fixture.close();
  }
});

test('崩溃后重领 run 必须结算遗留 reserved 调用并继续推进一次 checkpoint', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'crash-recovery-s1',
      'crash-recovery-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      {
        minNewTurns: 1,
        clock: () => new Date('2026-08-09T12:00:00.000Z'),
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    fixture.database.prepare(
      `UPDATE memory_reflection_runs
       SET status = 'running', attempts = 1,
           lease_owner = 'crashed-worker',
           lease_until = '2020-01-01T00:00:00.000Z',
           started_at = '2026-08-09T11:00:00.000Z'
       WHERE id = ?`,
    ).run(queued.run.id);
    fixture.database.prepare(
      `INSERT INTO memory_reflection_model_calls (
         id, run_id, user_id, namespace, budget_day, call_type,
         model, estimated_tokens, status, reserved_at
       ) VALUES (
         'crashed-reservation', ?, 'alice', 'personal', '2026-08-09',
         'reflect', 'qwen2.5:14b', 32, 'reserved',
         '2026-08-09T11:00:00.000Z'
       )`,
    ).run(queued.run.id);

    const result = await service.executeRun(
      queued.run.id,
      'restart-worker',
    );
    assert.equal(result.run.status, 'completed');
    assert.equal(service.status('alice', 'personal').checkpoints.length, 1);
    assert.deepEqual(
      service.modelCalls(queued.run.id, 'alice').map((call) => call.status)
        .sort(),
      ['completed', 'failed'],
    );
    assert.deepEqual(
      service.runEvents(queued.run.id, 'alice').map(
        (event) => event.eventType,
      ),
      [
        'queued',
        'model_call_failed',
        'started',
        'model_call_reserved',
        'model_call_completed',
        'completed',
      ],
    );
  } finally {
    fixture.close();
  }
});

test('取消终态必须在同一事务结算遗留 reserved 模型调用', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'cancel-reserved-s1',
      'cancel-reserved-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1, clock: fixture.now },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    fixture.database.prepare(
      `UPDATE memory_reflection_runs
       SET status = 'running', attempts = 1,
           lease_owner = 'cancel-worker',
           lease_until = '2026-08-09T12:10:00.000Z'
       WHERE id = ?`,
    ).run(queued.run.id);
    fixture.database.prepare(
      `INSERT INTO memory_reflection_model_calls (
         id, run_id, user_id, namespace, budget_day, call_type,
         model, estimated_tokens, status, reserved_at
       ) VALUES (
         'cancelled-reservation', ?, 'alice', 'personal', '2026-08-09',
         'reflect', 'qwen2.5:14b', 32, 'reserved',
         '2026-08-09T12:00:00.000Z'
       )`,
    ).run(queued.run.id);

    service.cancelRun(queued.run.id, 'alice');
    const result = await service.executeRun(queued.run.id, 'cancel-worker');

    assert.equal(result.run.status, 'cancelled');
    assert.deepEqual(
      service.modelCalls(queued.run.id, 'alice').map((call) => call.status),
      ['failed'],
    );
    assert.deepEqual(
      service.runEvents(queued.run.id, 'alice').map(
        (event) => event.eventType,
      ),
      [
        'queued',
        'cancel_requested',
        'model_call_failed',
        'cancelled',
      ],
    );
  } finally {
    fixture.close();
  }
});

test('Job 先过期时新 Worker 不得失败仍由旧 Worker 持有的 run', async () => {
  const fixture = createFixture();
  let releaseProvider: (() => void) | undefined;
  let firstExecution: ReturnType<MemoryReflectionService['executeRun']> |
    undefined;
  try {
    fixture.record(
      'alice',
      'lease-fencing-s1',
      'lease-fencing-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    fixture.database.prepare(
      "UPDATE outbox_events SET status = 'completed'",
    ).run();
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const gatedProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-lease-fencing-v1',
      async reflect() {
        markProviderStarted?.();
        await providerGate;
        return { candidates: [] };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      gatedProvider,
      {
        minNewTurns: 1,
        leaseSeconds: 600,
        clock: fixture.now,
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const claimed = fixture.lifecycle.claimJob(
      'lease-worker-a',
      300,
      ['reflect_turn_window'],
    );
    assert.equal(claimed?.id, `reflection-run:${queued.run.id}`);
    firstExecution = service.executeRun(queued.run.id, 'lease-worker-a');
    await providerStarted;

    fixture.advance(301_000);
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      service,
    );
    const takeover = await worker.processNext('lease-worker-b');
    assert.match(takeover.error || '', /其他 Worker 持有/u);
    const stillOwned = service.getRun(queued.run.id)!;
    assert.equal(stillOwned.status, 'running');
    assert.equal(stillOwned.leaseOwner, 'lease-worker-a');

    releaseProvider?.();
    releaseProvider = undefined;
    assert.equal((await firstExecution).run.status, 'completed');
  } finally {
    releaseProvider?.();
    await firstExecution?.catch(() => undefined);
    fixture.close();
  }
});

test('长模型调用期间必须同步续租 Job 与 reflection run', async () => {
  const fixture = createFixture();
  let releaseProvider: (() => void) | undefined;
  let execution: ReturnType<MemoryReflectionService['executeRun']> |
    undefined;
  try {
    fixture.record(
      'alice',
      'lease-heartbeat-s1',
      'lease-heartbeat-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const gatedProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-heartbeat-v1',
      async reflect() {
        markProviderStarted?.();
        await providerGate;
        return { candidates: [] };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      gatedProvider,
      {
        minNewTurns: 1,
        leaseSeconds: 1,
        clock: fixture.now,
      },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const job = fixture.lifecycle.claimJob(
      'heartbeat-worker',
      1,
      ['reflect_turn_window'],
    )!;
    execution = service.executeRun(queued.run.id, 'heartbeat-worker', {
      leaseSeconds: 1,
      heartbeatMs: 5,
      renewJobLease: () => {
        fixture.lifecycle.renewJobLease(job.id, 'heartbeat-worker', 1);
      },
    });
    await providerStarted;

    fixture.advance(900);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fixture.advance(900);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(
      Date.parse(fixture.lifecycle.getJob(job.id)!.leaseUntil || '') >
        fixture.now().getTime(),
    );
    assert.ok(
      Date.parse(service.getRun(queued.run.id)!.leaseUntil || '') >
        fixture.now().getTime(),
    );

    releaseProvider?.();
    releaseProvider = undefined;
    assert.equal((await execution).run.status, 'completed');
    assert.equal(
      fixture.lifecycle.completeJob(job.id, 'heartbeat-worker').status,
      'completed',
    );
  } finally {
    releaseProvider?.();
    await execution?.catch(() => undefined);
    fixture.close();
  }
});

test('同一账户 namespace 的不同 reflection run 必须遵守模型并发上限', async () => {
  const fixture = createFixture();
  let releaseFirst: (() => void) | undefined;
  let firstExecution: ReturnType<MemoryReflectionService['executeRun']> |
    undefined;
  try {
    fixture.record(
      'alice',
      'concurrency-s1',
      'concurrency-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    let providerCalls = 0;
    let markFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const gatedProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-concurrency-v1',
      async reflect() {
        providerCalls += 1;
        if (providerCalls === 1) {
          markFirstEntered?.();
          await firstGate;
        }
        return { candidates: [] };
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      gatedProvider,
      { minNewTurns: 1, concurrency: 1 },
    );
    const first = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const second = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'repair',
      requestedBy: 'alice',
      implementationVersion: 'reflection-concurrency-v2',
    });
    firstExecution = service.executeRun(
      first.run.id,
      'concurrency-worker-a',
    );
    await firstEntered;

    await assert.rejects(
      service.executeRun(second.run.id, 'concurrency-worker-b'),
      /并发上限/u,
    );
    assert.equal(providerCalls, 1);
    assert.equal(service.getRun(second.run.id)?.status, 'pending');
    releaseFirst?.();
    releaseFirst = undefined;
    assert.equal((await firstExecution).run.status, 'completed');
  } finally {
    releaseFirst?.();
    await firstExecution?.catch(() => undefined);
    fixture.close();
  }
});

test('历史直接事实重提取关联 run、证据和跨版本 fingerprint', async () => {
  const fixture = createFixture();
  try {
    const turn = fixture.record(
      'alice',
      's1',
      't1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reextract',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const completed = await service.executeRun(queued.run.id, 'worker-a');
    assert.equal(completed.run.status, 'completed');
    assert.equal(completed.candidates.length, 1);
    const candidate = completed.candidates[0]!;
    assert.equal(candidate.turnId, turn.id);
    assert.equal(candidate.candidateOrigin, 'history_reextract');
    assert.equal(candidate.sourceAuthority, 'direct_user');
    assert.match(candidate.claimFingerprint || '', /^[0-9a-f]{64}$/u);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidate_evidence
           WHERE candidate_id = ? AND turn_id = ?`,
        )
        .get(candidate.id, turn.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('历史重提取窗口任一模型调用失败时不得发布半窗口候选或解析任务', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      'reextract-atomic-s1',
      'reextract-atomic-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    fixture.record(
      'alice',
      'reextract-atomic-s1',
      'reextract-atomic-t2',
      '周末早上我也会喝桂花乌龙。',
      '2026-08-08T09:00:00.000Z',
    );
    let calls = 0;
    const failOnSecond: MemoryExtractor = {
      ...extractor,
      async extract(turn) {
        calls += 1;
        if (calls === 2) throw new Error('second turn failed');
        return await extractor.extract(turn);
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      failOnSecond,
      provider({ candidates: [] }),
      { minNewTurns: 1 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reextract',
      trigger: 'manual',
      requestedBy: 'alice',
    });

    await assert.rejects(
      service.executeRun(queued.run.id, 'reextract-atomic-worker'),
      /second turn failed/u,
    );
    assert.equal(service.getRun(queued.run.id)?.status, 'failed');
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_candidates`,
      ).get()?.count,
      0,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_jobs
         WHERE job_type = 'resolve_candidate'`,
      ).get()?.count,
      0,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_reflection_checkpoints
         WHERE run_type = 'reextract'`,
      ).get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('personal 重提取运行不得发布 project 候选或跨作用域 claim', async () => {
  const fixture = createFixture();
  try {
    fixture.lifecycle.recordTurn({
      userId: 'alice',
      namespace: 'personal',
      personaId: 'persona-A',
      projectId: 'project-A',
      identitySource: 'test',
      identityStatus: 'complete',
      roundId: 'round-A',
      clientName: 'client',
      sessionExternalId: 'project-session-A',
      turnExternalId: 'project-turn-A',
      role: 'user',
      content: '项目专属：晨舟项目使用代号蓝鲸。',
      occurredAt: '2026-08-08T08:00:00.000Z',
    });
    const projectExtractor: MemoryExtractor = {
      ...extractor,
      async extract(turn) {
        return [{
          kind: 'project',
          subject: '晨舟项目',
          predicate: '代号',
          value: '蓝鲸',
          content: '',
          confidence: 1,
          importance: 0.8,
          sensitivity: 'normal',
          scopeType: 'project',
          scopeKey: 'project-A',
          sourceExcerpt: turn.content,
          sourceAuthority: 'direct_user',
        }];
      },
    };
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      projectExtractor,
      provider({ candidates: [] }),
      { minNewTurns: 1 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reextract',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const completed = await service.executeRun(
      queued.run.id,
      'scope-atomic-worker',
    );

    assert.equal(completed.run.status, 'completed');
    assert.equal(completed.candidates.length, 0);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_reflection_claims
         WHERE first_run_id = ? OR last_run_id = ?`,
      ).get(queued.run.id, queued.run.id)?.count,
      0,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_candidates
         WHERE state = 'pending'`,
      ).get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('Worker 执行窗口任务并拒绝伪造的 run 所有权', async () => {
  const fixture = createFixture();
  try {
    fixture.record(
      'alice',
      's1',
      't1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    fixture.database
      .prepare("UPDATE outbox_events SET status = 'completed'")
      .run();
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      provider({ candidates: [] }),
      { minNewTurns: 1 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      service,
    );
    const result = await worker.processNext('reflection-worker');
    assert.equal(result.error, undefined);
    assert.equal(result.job?.jobType, 'reflect_turn_window');
    assert.equal(service.getRun(queued.run.id)?.status, 'completed');

    fixture.lifecycle.enqueueJob({
      id: 'forged-reflection-owner',
      jobType: 'reflect_turn_window',
      userId: 'bob',
      namespace: 'personal',
      payload: { runId: queued.run.id },
      maxAttempts: 1,
      priority: 100,
    });
    const rejected = await worker.processNext('reflection-worker');
    assert.match(rejected.error || '', /所有权不一致/);
    assert.equal(rejected.job?.status, 'dead');
  } finally {
    fixture.close();
  }
});

test('反思 fetch 进行中遇到前台请求会归还 run 和 job 但保留模型失败账本', async () => {
  resetModelQosForTests();
  const fixture = createFixture();
  let releaseForeground: (() => void) | null = null;
  let notifyFetchStarted: (() => void) | null = null;
  const fetchStarted = new Promise<void>((resolve) => {
    notifyFetchStarted = resolve;
  });
  try {
    fixture.record(
      'alice',
      'qos-reflection-s1',
      'qos-reflection-t1',
      '工作日早上我会喝桂花乌龙。',
      '2026-08-08T08:00:00.000Z',
    );
    fixture.database
      .prepare("UPDATE outbox_events SET status = 'completed'")
      .run();
    const reflectionProvider = new OllamaReflectionProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'reflection-qos-inflight-v1',
      timeoutMs: 5_000,
      fetchImpl: async (_input, init) => {
        const signal = init?.signal;
        notifyFetchStarted?.();
        return await new Promise<Response>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('后台反思请求缺少 abort signal'));
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
    const service = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycle,
      extractor,
      reflectionProvider,
      { minNewTurns: 1 },
    );
    const queued = service.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const worker = new MemoryWorker(
      fixture.lifecycle,
      extractor,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      service,
    );
    const processing = worker.processNext('qos-reflection-worker');

    await fetchStarted;
    releaseForeground = beginForegroundActivity();
    const result = await processing;

    assert.equal(result.processed, false);
    assert.equal(result.job?.status, 'pending');
    assert.equal(result.job?.attempts, 0);
    const deferredRun = service.getRun(queued.run.id, 'alice');
    assert.equal(deferredRun?.status, 'pending');
    assert.equal(deferredRun?.attempts, 0);
    assert.deepEqual(
      service.modelCalls(queued.run.id, 'alice').map((call) => call.status),
      ['failed'],
    );
    assert.equal(
      service.runEvents(queued.run.id, 'alice').at(-1)?.eventType,
      'foreground_deferred',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_reflection_checkpoints
         WHERE user_id = 'alice'`,
      ).get()?.count,
      0,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_candidates
         WHERE reflection_run_id = ?`,
      ).get(queued.run.id)?.count,
      0,
    );
  } finally {
    releaseForeground?.();
    fixture.close();
    resetModelQosForTests();
  }
});

test('HTTP 历史重提炼要求预览确认且拒绝客户端覆盖 principal', async () => {
  const fixture = createFixture();
  const memoryStore = new MemoryStore(fixture.database);
  fixture.record(
    'default',
    's1',
    't1',
    '工作日早上我会喝桂花乌龙。',
    '2026-08-08T08:00:00.000Z',
  );
  const service = new MemoryReflectionService(
    fixture.database,
    fixture.lifecycle,
    extractor,
    provider({ candidates: [] }),
    { minNewTurns: 1 },
  );
  const server = createHttpServer(memoryStore, {
    reflectionService: service,
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const forged = await fetch(`${base}/api/reflection/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'alice' }),
    });
    assert.equal(forged.status, 400);

    const previewResponse = await fetch(
      `${base}/api/reflection/preview`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scopeType: 'personal',
          scopeKey: 'self',
        }),
      },
    );
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as {
      turnCount: number;
    };
    assert.equal(preview.turnCount, 1);

    const unconfirmed = await fetch(`${base}/api/reflection/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unconfirmed.status, 409);
    assert.equal(
      (await unconfirmed.json() as { code: string }).code,
      'REFLECTION_CONFIRMATION_REQUIRED',
    );

    const queuedResponse = await fetch(`${base}/api/reflection/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(queuedResponse.status, 202);
    const queued = await queuedResponse.json() as {
      run: { id: string; status: string };
    };
    assert.equal(queued.run.status, 'pending');

    const cancelled = await fetch(
      `${base}/api/reflection/runs/${queued.run.id}/cancel`,
      { method: 'POST' },
    );
    assert.equal(cancelled.status, 200);
    assert.equal(
      (await cancelled.json() as { status: string }).status,
      'cancelled',
    );

    const status = await fetch(`${base}/api/reflection/status`);
    assert.equal(status.status, 200);
    assert.equal(
      (await status.json() as {
        runCounts: { cancelled: number };
      }).runCounts.cancelled,
      1,
    );
    const detail = await fetch(
      `${base}/api/reflection/runs/${queued.run.id}`,
    );
    assert.equal(detail.status, 200);
    assert.deepEqual(
      (await detail.json() as {
        events: Array<{ eventType: string }>;
      }).events.map((event) => event.eventType),
      ['queued', 'cancel_requested', 'cancelled'],
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
    fixture.close();
  }
});
