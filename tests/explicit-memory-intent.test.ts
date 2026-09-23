import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryLifecycle } from '../src/server/memory-lifecycle.js';
import type {
  LifecycleRequestContext,
} from '../src/server/ollama-compat.js';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import { openDatabase } from '../src/server/database.js';
import {
  ExplicitMemoryIntentService,
  OllamaExplicitMemoryIntentProvider,
  gateAction,
  type ExplicitMemoryIntentDecision,
  type ExplicitMemoryIntentProvider,
} from '../src/server/explicit-memory-intent.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryAdminService } from '../src/server/memory-admin.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';
import {
  modelQosSnapshot,
  resetModelQosForTests,
} from '../src/server/model-qos.js';

type JsonRecord = Record<string, unknown>;

class FakeIntentProvider implements ExplicitMemoryIntentProvider {
  readonly model = 'qwen2.5:14b';
  readonly promptVersion = 'explicit-memory-intent-test-v1';
  calls = 0;

  constructor(
    private readonly decide: (
      text: string,
    ) => ExplicitMemoryIntentDecision,
  ) {}

  async classify(text: string): Promise<ExplicitMemoryIntentDecision> {
    this.calls += 1;
    return this.decide(text);
  }
}

function createFixture(provider: ExplicitMemoryIntentProvider) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-explicit-intent-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycleStore,
    memoryStore,
    { mode: 'shadow' },
  );
  const service = new ExplicitMemoryIntentService(
    database,
    lifecycleStore,
    memoryStore,
    resolver,
    provider,
  );
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
  );
  const admin = new MemoryAdminService(
    database,
    memoryStore,
    lifecycleStore,
    resolver,
    governance,
  );
  const lifecycle = new MemoryLifecycle(
    memoryStore,
    lifecycleStore,
    'default',
    'personal',
    service,
  );
  return {
    database,
    memoryStore,
    lifecycleStore,
    lifecycle,
    service,
    admin,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function request(
  content: string,
  conversationId: string,
): JsonRecord {
  return {
    model: 'qwen2.5:14b',
    conversation_id: conversationId,
    messages: [{ role: 'user', content }],
  };
}

function completion(content: string): JsonRecord {
  return {
    choices: [{
      message: { role: 'assistant', content },
    }],
  };
}

function trustedProjectIdentity(
  roundId: string,
  projectId = 'trusted-project-A',
): LifecycleRequestContext {
  return {
    principalId: 'default',
    namespace: 'personal',
    credentialId: 'credential-default',
    authSource: 'credential',
    personaId: 'persona-A',
    sessionId: 'chat-project-A',
    roundId,
    projectId,
    identityStatus: 'complete',
  };
}

function preferenceDecision(
  action: 'remember' | 'correct',
  input: {
    predicate: string;
    value: string;
    content: string;
    excerpt: string;
    sensitivity?: 'normal' | 'sensitive' | 'credential';
    confidence?: number;
  },
): ExplicitMemoryIntentDecision {
  const sensitivity = input.sensitivity || 'normal';
  const confidence = input.confidence ?? 0.99;
  return {
    action,
    confidence,
    sensitivity,
    targetQuery: '',
    candidate: {
      kind: 'preference',
      subject: '用户',
      predicate: input.predicate,
      value: input.value,
      content: input.content,
      confidence,
      importance: 0.9,
      sensitivity,
      scopeType: 'personal',
      scopeKey: 'self',
      sourceExcerpt: input.excerpt,
    },
    rationale: '用户明确表达了长期记忆动作',
  };
}

test('qwen2.5:14b 自然意图分类器使用严格结构化输出', async () => {
  let requestBody: Record<string, unknown> | null = null;
  const provider = new OllamaExplicitMemoryIntentProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'explicit-memory-intent-v1',
    timeoutMs: 10_000,
    fetchImpl: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            action: 'forget',
            confidence: 0.99,
            sensitivity: 'normal',
            targetQuery: '主要编辑器 VS Code',
            candidate: null,
            rationale: '用户明确要求遗忘',
          }),
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const decision = await provider.classify(
    '把主要编辑器偏好忘掉。',
    'forget',
  );
  assert.equal(decision.action, 'forget');
  assert.equal(requestBody?.model, 'qwen2.5:14b');
  assert.equal(requestBody?.stream, false);
  assert.equal(requestBody?.think, false);
  assert.equal(requestBody?.keep_alive, '15m');
  assert.equal(
    (requestBody?.format as { type?: string })?.type,
    'object',
  );
});

test('14B 越界 confidence/importance 只做有界归一化', async () => {
  const provider = new OllamaExplicitMemoryIntentProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'explicit-memory-intent-v1',
    timeoutMs: 10_000,
    fetchImpl: async () =>
      new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            action: 'remember',
            confidence: 1.2,
            sensitivity: 'normal',
            targetQuery: '',
            candidate: {
              kind: 'project',
              subject: '验收项目A',
              predicate: '项目代号',
              value: '青铜海燕',
              content: '验收项目A的项目代号是青铜海燕。',
              confidence: 9,
              importance: 5,
              sensitivity: 'normal',
              scopeType: 'project',
              scopeKey: '验收项目A',
              sourceExcerpt: '项目代号固定为青铜海燕',
            },
            rationale: '用户明确要求长期记住项目代号',
          }),
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });

  const decision = await provider.classify(
    '项目代号固定为青铜海燕，请长期记住。',
    'remember',
  );
  assert.equal(decision.confidence, 1);
  assert.equal(decision.candidate?.confidence, 1);
  assert.equal(decision.candidate?.importance, 1);
});

test('缺失的纠正 candidate 最多修复一次并保持原子新事实', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const provider = new OllamaExplicitMemoryIntentProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:14b',
    promptVersion: 'explicit-memory-intent-v2',
    timeoutMs: 10_000,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(
        String(init?.body),
      ) as Record<string, unknown>;
      bodies.push(body);
      const content = bodies.length === 1
        ? {
            action: 'correct',
            confidence: 1,
            sensitivity: 'normal',
            targetQuery: '项目原则',
            candidate: null,
            rationale: '用户明确改变了项目原则',
          }
        : {
            kind: 'preference',
            subject: '用户',
            predicate: '软件首次打开数据原则',
            value: '自动导入最小示例数据',
            content: '用户要求软件首次打开时自动导入最小示例数据。',
            confidence: 1,
            importance: 1,
            sensitivity: 'normal',
            scopeType: 'personal',
            scopeKey: 'self',
            sourceExcerpt: '今后应该自动导入一套最小示例数据',
          };
      return new Response(JSON.stringify({
        message: { content: JSON.stringify(content) },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const decision = await provider.classify(
    '项目原则变了：第一次打开不再要求空数据，' +
      '今后应该自动导入一套最小示例数据。',
    'correct',
  );
  assert.equal(bodies.length, 2);
  assert.equal(decision.action, 'correct');
  assert.equal(
    decision.candidate?.predicate,
    '软件首次打开数据原则',
  );
  assert.equal(
    decision.candidate?.value,
    '自动导入最小示例数据',
  );
  assert.equal(bodies[1]?.model, 'qwen2.5:14b');
  assert.equal(bodies[1]?.keep_alive, '15m');
});

test('自然变化句式进入纠正快车道', () => {
  assert.equal(
    gateAction(
      '我现在的项目原则变了：新软件第一次打开不再要求空数据，' +
      '今后应该自动导入一套最小示例数据。',
    ),
    'correct',
  );
  assert.equal(
    gateAction('我不再要求新软件第一次打开必须是空数据。'),
    'correct',
  );
});

test('显式记忆意图处理在模型工作期间持有并最终释放前台租约', async () => {
  resetModelQosForTests();
  const provider = new FakeIntentProvider(() => {
    assert.ok(modelQosSnapshot().foregroundCount >= 1);
    return preferenceDecision('remember', {
      predicate: '咖啡偏好',
      value: '无糖咖啡',
      content: '用户喜欢无糖咖啡。',
      excerpt: '我喜欢无糖咖啡',
    });
  });
  const fixture = createFixture(provider);
  try {
    const result = await fixture.service.handle({
      userId: 'default',
      namespace: 'personal',
      clientName: 'qos-test',
      sessionExternalId: 'session-qos-intent',
      userTurnExternalId: 'turn-qos-intent',
      userText: '请记住，我喜欢无糖咖啡。',
    });
    assert.equal(result.status, 'completed');
    assert.equal(modelQosSnapshot().foregroundCount, 0);
  } finally {
    fixture.close();
    resetModelQosForTests();
  }
});

test('意图 provider 失败时纠正和遗忘仍抑制当轮旧记忆召回', async () => {
  for (const scenario of [
    {
      action: 'correct',
      message: '我不再使用 VS Code 了，现在改用 Cursor。',
    },
    {
      action: 'forget',
      message: '把我主要使用 VS Code 的编辑器偏好忘掉。',
    },
  ] as const) {
    const provider: ExplicitMemoryIntentProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'explicit-memory-intent-failure-v1',
      async classify() {
        throw new Error('intent provider unavailable');
      },
    };
    const fixture = createFixture(provider);
    try {
      const memory = fixture.memoryStore.remember({
        kind: 'preference',
        content: '用户主要使用 VS Code。',
        stableKey: 'personal::self::用户::主要编辑器',
        predicateKey: '用户::主要编辑器',
        normalizedValue: 'VS Code',
        normalizedValueHash: 'editor-vscode',
        predicateCardinality: 'single',
        sourceAuthority: 'direct_user',
      }).memory;
      const chat = request(
        scenario.message,
        `provider-failure-${scenario.action}`,
      );

      const prepared = await fixture.lifecycle.beforeModel(
        chat,
        `provider-failure-${scenario.action}`,
      );
      assert.equal(
        (prepared.messages as JsonRecord[]).length,
        1,
      );
      assert.equal(
        fixture.memoryStore.get(memory.id, true)?.status,
        'active',
      );
      assert.equal(
        fixture.database
          .prepare(
            `SELECT status
             FROM memory_action_requests`,
          )
          .get()?.status,
        'failed',
      );
      assert.equal(
        fixture.admin.listMemoryActionInbox()[0]?.action,
        scenario.action,
      );
    } finally {
      fixture.close();
    }
  }
});

test('自然忘记在召回前写 tombstone，完成回复后补齐同一回合', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '主要编辑器 VS Code',
    candidate: null,
    rationale: '用户明确要求忘掉编辑器偏好',
  }));
  const fixture = createFixture(provider);
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'personal::self::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'editor-vscode',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    const chat = request(
      '把我主要使用 VS Code 的编辑器偏好忘掉。',
      'natural-forget',
    );

    const prepared = await fixture.lifecycle.beforeModel(
      chat,
      'forget-request',
    );
    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'deleted',
    );
    assert.equal((prepared.messages as JsonRecord[]).length, 1);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status
           FROM memory_action_requests`,
        )
        .get()?.status,
      'completed',
    );
    const tombstone = fixture.database
      .prepare(
        `SELECT kind, normalized_key, normalized_value,
                semantic_fingerprint
         FROM memory_tombstones
         WHERE memory_item_id = ? AND restored_at IS NULL`,
      )
      .get(memory.id);
    assert.deepEqual(
      {
        kind: tombstone?.kind,
        normalizedKey: tombstone?.normalized_key,
        normalizedValue: tombstone?.normalized_value,
      },
      {
        kind: 'preference',
        normalizedKey: '用户::主要编辑器',
        normalizedValue: 'VS Code',
      },
    );
    assert.ok(String(tombstone?.semantic_fingerprint).length > 100);
    assert.throws(
      () => fixture.memoryStore.remember({
        kind: 'preference',
        content: '用户的主要代码编辑器仍然是 vs code。',
        stableKey: 'personal::self::用户::主要编辑器',
        predicateKey: '用户::主要编辑器',
        normalizedValue: 'vs code',
        normalizedValueHash: 'editor-vscode-paraphrase',
        predicateCardinality: 'single',
      }),
      /遗忘规则阻止/,
    );
    assert.equal(
      fixture.memoryStore.remember({
        kind: 'preference',
        content: '用户现在的主要编辑器是 Zed。',
        stableKey: 'personal::self::用户::主要编辑器',
        predicateKey: '用户::主要编辑器',
        normalizedValue: 'Zed',
        normalizedValueHash: 'editor-zed',
        predicateCardinality: 'single',
      }).memory.status,
      'active',
    );

    fixture.lifecycle.afterTurn(
      chat,
      completion('好的，我已经忘掉这项偏好。'),
      'forget-request',
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      2,
    );
    const userTurn = fixture.database
      .prepare(
        `SELECT metadata_json
         FROM conversation_turns
         WHERE role = 'user'`,
      )
      .get();
    assert.equal(
      JSON.parse(String(userTurn?.metadata_json)).skipAutoExtraction,
      true,
    );
  } finally {
    fixture.close();
  }
});

test('显式忘记唯一匹配的 pending 候选并建立 tombstone', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 1,
    sensitivity: 'normal',
    targetQuery: '青禾旅店 临时住宿安排',
    candidate: null,
    rationale: '用户明确要求忘记临时住宿',
  }));
  const fixture = createFixture(provider);
  try {
    const sourceText = '这次临时出差我会住在青禾旅店。';
    const turn = fixture.lifecycleStore.recordTurn({
      clientName: 'client',
      sessionExternalId: 'pending-hotel-source',
      turnExternalId: 'pending-hotel-source-turn',
      role: 'user',
      content: sourceText,
    }).turn;
    const runId = fixture.lifecycleStore.startExtraction(
      turn.id,
      'qwen2.5:14b',
      'pending-forget-test-v1',
    );
    const candidate = fixture.lifecycleStore.completeExtraction(runId, [{
      kind: 'event',
      subject: '用户',
      predicate: '临时住宿地点',
      value: '青禾旅店',
      content:
        'atomic-memory-v1:' +
        '{"subject":"用户","predicate":"临时住宿地点",' +
        '"value":"青禾旅店","negated":false}',
      confidence: 0.95,
      importance: 0.3,
      scopeType: 'personal',
      scopeKey: 'self',
      sourceExcerpt: sourceText,
      sourceAuthority: 'direct_user',
    }])[0]!;
    assert.equal(candidate.state, 'pending');

    const result = await fixture.service.handle({
      userId: 'default',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'pending-hotel-forget',
      userTurnExternalId: 'pending-hotel-forget-turn',
      userText: '请忘记我前面说的青禾旅店临时住宿安排。',
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.memoryId, null);
    assert.equal(result.candidateId, candidate.id);
    assert.equal(result.reason, 'explicit_forget_pending_candidate_completed');
    assert.deepEqual(
      { ...fixture.database.prepare(
        `SELECT state, decision_reason
         FROM memory_candidates WHERE id = ?`,
      ).get(candidate.id) },
      {
        state: 'rejected',
        decision_reason: 'manual_rejected_and_tombstoned',
      },
    );
    const requestRow = fixture.database.prepare(
      `SELECT status, candidate_id, target_memory_id, rationale
       FROM memory_action_requests`,
    ).get();
    assert.deepEqual({ ...requestRow }, {
      status: 'completed',
      candidate_id: candidate.id,
      target_memory_id: null,
      rationale: 'explicit_forget_pending_candidate_completed',
    });
    const tombstone = fixture.database.prepare(
      `SELECT memory_item_id, normalized_key, normalized_value
       FROM memory_tombstones
       WHERE restored_at IS NULL`,
    ).get();
    assert.deepEqual({ ...tombstone }, {
      memory_item_id: null,
      normalized_key: '用户::临时住宿地点',
      normalized_value: '青禾旅店',
    });
  } finally {
    fixture.close();
  }
});

test('普通规则的 sensitive 模型误报不阻断明确遗忘', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 1,
    sensitivity: 'sensitive',
    targetQuery: '客户项目首次打开数据规则',
    candidate: null,
    rationale: '用户明确要求遗忘普通项目规则',
  }));
  const fixture = createFixture(provider);
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'instruction',
      content: '客户项目首次打开时自动导入最小示例数据。',
      stableKey: 'personal::self::客户项目::首次打开数据规则',
      predicateKey: '客户项目::首次打开数据规则',
      normalizedValue: '自动导入最小示例数据',
      normalizedValueHash: 'sample-data-rule',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;

    await fixture.lifecycle.beforeModel(
      request(
        '请把客户项目第一次打开的数据规则忘掉。',
        'forget-false-sensitive',
      ),
      'forget-false-sensitive-request',
    );

    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'deleted',
    );
    const action = fixture.database
      .prepare(
        `SELECT status, sensitivity, target_memory_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'completed');
    assert.equal(action?.sensitivity, 'normal');
    assert.equal(action?.target_memory_id, memory.id);
  } finally {
    fixture.close();
  }
});

test('遗忘目标已确认后语义召回故障仍立即 tombstone 且明确标记降级', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '主要编辑器 VS Code',
    candidate: null,
    rationale: '用户明确要求忘掉编辑器偏好',
  }));
  const fixture = createFixture(provider);
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'personal::self::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'editor-vscode',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    Object.defineProperty(
      fixture.memoryStore,
      'recallReliable',
      {
        configurable: true,
        value: async () => {
          throw new Error('semantic reranker unavailable');
        },
      },
    );

    const prepared = await fixture.lifecycle.beforeModel(
      request(
        '把我主要使用 VS Code 的编辑器偏好忘掉。',
        'forget-semantic-failure',
      ),
      'forget-semantic-failure-request',
    );

    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'deleted',
    );
    assert.equal((prepared.messages as JsonRecord[]).length, 1);
    const action = fixture.database
      .prepare(
        `SELECT status, rationale, error, target_memory_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'completed');
    assert.equal(
      action?.rationale,
      'explicit_forget_completed_local_fallback',
    );
    assert.match(
      String(action?.error),
      /semantic reranker unavailable/u,
    );
    assert.equal(action?.target_memory_id, memory.id);

    const next = await fixture.lifecycle.beforeModel(
      request(
        '我主要使用什么代码编辑器？',
        'forget-semantic-failure-next-chat',
      ),
      'forget-semantic-failure-next-request',
    );
    const nextMessages = next.messages as JsonRecord[];
    assert.equal(nextMessages.length, 2);
    assert.match(
      String(nextMessages[0]?.content),
      /召回质量状态：degraded/u,
    );
    assert.doesNotMatch(
      JSON.stringify(nextMessages),
      /用户主要使用 VS Code/u,
    );
  } finally {
    fixture.close();
  }
});

test('自然纠正同步追加版本，当前轮不会注入旧值', async () => {
  const provider = new FakeIntentProvider(() =>
    preferenceDecision('correct', {
      predicate: '主要编辑器',
      value: 'Cursor',
      content: '用户现在主要使用 Cursor。',
      excerpt: '现在改用 Cursor',
    }));
  const fixture = createFixture(provider);
  try {
    const current = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'personal::self::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'editor-vscode',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    const chat = request(
      '我不再使用 VS Code 了，现在改用 Cursor。',
      'natural-correct',
    );

    const prepared = await fixture.lifecycle.beforeModel(
      chat,
      'correct-request',
    );
    const corrected = fixture.memoryStore.get(current.id, true);
    assert.match(corrected?.content || '', /Cursor/);
    assert.doesNotMatch(corrected?.content || '', /VS Code/);
    assert.equal(fixture.memoryStore.history(current.id).length, 2);
    const preparedText = JSON.stringify(prepared);
    assert.doesNotMatch(
      preparedText,
      /用户主要使用 VS Code。/,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status
           FROM memory_action_requests`,
        )
        .get()?.status,
      'completed',
    );
  } finally {
    fixture.close();
  }
});

test('自然纠正把代号与当前代号视为同一稳定属性', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'correct',
    confidence: 1,
    sensitivity: 'normal',
    targetQuery: '星港项目代号 银鸥29',
    candidate: {
      kind: 'project',
      subject: '星港项目',
      predicate: '代号',
      value: '银鸥29',
      content: '星港项目的代号是银鸥29。',
      confidence: 1,
      importance: 0.85,
      sensitivity: 'normal',
      scopeType: 'project',
      scopeKey: 'model-guessed-project',
      sourceExcerpt:
        '星港项目刚刚调整：现在的代号改为银鸥29，之前的蓝鲸17已经作废',
    },
    rationale: '用户明确更新项目代号',
  }));
  const fixture = createFixture(provider);
  try {
    const current = fixture.memoryStore.remember({
      kind: 'project',
      content: '星港项目当前代号是蓝鲸17。',
      stableKey: 'project::trusted-project-A::星港项目::当前代号',
      predicateKey: '星港项目::当前代号',
      normalizedValue: '蓝鲸17',
      normalizedValueHash: 'starport-blue-whale-17',
      predicateCardinality: 'single',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
      sourceAuthority: 'direct_user',
    }).memory;

    await fixture.lifecycle.beforeModel(
      request(
        '星港项目刚刚调整：现在的代号改为银鸥29，' +
          '之前的蓝鲸17已经作废。',
        'project-code-correction',
      ),
      'project-code-correction-request',
      trustedProjectIdentity('round-project-code-correction'),
    );

    const corrected = fixture.memoryStore.get(current.id, true);
    assert.match(corrected?.content || '', /银鸥29/u);
    assert.doesNotMatch(corrected?.content || '', /蓝鲸17/u);
    assert.equal(fixture.memoryStore.list().total, 1);
    assert.equal(fixture.memoryStore.history(current.id).length, 2);
    const action = fixture.database
      .prepare(
        `SELECT status, target_memory_id, rationale
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'completed');
    assert.equal(action?.target_memory_id, current.id);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT state, resolved_memory_item_id
           FROM memory_candidates`,
        )
        .get()?.state,
      'accepted',
    );
  } finally {
    fixture.close();
  }
});

test('14B 遗漏或生成无效 sourceExcerpt 时用原文唯一新值完成纠正', async () => {
  const provider = new FakeIntentProvider(() => ({
    ...preferenceDecision('correct', {
      predicate: '主要编辑器',
      value: 'Cursor',
      content: '用户现在主要使用 Cursor。',
      excerpt: '这是模型改写但原文中不存在的摘录',
    }),
    targetQuery: '主要编辑器 VS Code',
  }));
  const fixture = createFixture(provider);
  try {
    const current = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'personal::self::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'editor-vscode',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;

    await fixture.lifecycle.beforeModel(
      request(
        '我不再使用 VS Code 了，现在改用 Cursor。',
        'natural-correct-missing-excerpt',
      ),
      'correct-missing-excerpt-request',
    );

    const action = fixture.database
      .prepare(
        `SELECT status, target_memory_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'completed');
    assert.equal(action?.target_memory_id, current.id);
    assert.equal(fixture.memoryStore.history(current.id).length, 2);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT source_excerpt
           FROM memory_candidates`,
        )
        .get()?.source_excerpt,
      'Cursor',
    );
  } finally {
    fixture.close();
  }
});

test('纠正证据回退拒绝重复值、第三方引述和原文不存在的值', async () => {
  const cases = [
    {
      name: 'duplicate-value',
      text: '我在比较 Cursor 和 Cursor，但这不是唯一的纠正证据。',
    },
    {
      name: 'third-party-quote',
      text: '小李说：“我不再使用 VS Code 了，现在改用 Cursor。”',
    },
    {
      name: 'missing-value',
      text: '我不再使用 VS Code 了，现在改用 Zed。',
    },
  ] as const;

  for (const entry of cases) {
    const provider = new FakeIntentProvider(() => ({
      ...preferenceDecision('correct', {
        predicate: '主要编辑器',
        value: 'Cursor',
        content: '用户现在主要使用 Cursor。',
        excerpt: '模型生成但原文不存在的摘录',
      }),
      targetQuery: '主要编辑器 VS Code',
    }));
    const fixture = createFixture(provider);
    try {
      const current = fixture.memoryStore.remember({
        kind: 'preference',
        content: '用户主要使用 VS Code。',
        stableKey: 'personal::self::用户::主要编辑器',
        predicateKey: '用户::主要编辑器',
        normalizedValue: 'VS Code',
        normalizedValueHash: 'editor-vscode',
        predicateCardinality: 'single',
        sourceAuthority: 'direct_user',
      }).memory;

      await fixture.lifecycle.beforeModel(
        request(entry.text, `correction-evidence-${entry.name}`),
        `correction-evidence-${entry.name}-request`,
      );

      const action = fixture.database
        .prepare(
          `SELECT status, target_memory_id
           FROM memory_action_requests`,
        )
        .get();
      assert.equal(action?.status, 'pending', entry.name);
      assert.equal(action?.target_memory_id, current.id, entry.name);
      assert.equal(
        fixture.memoryStore.history(current.id).length,
        1,
        entry.name,
      );
      assert.equal(
        fixture.database
          .prepare(
            `SELECT source_excerpt
             FROM memory_candidates`,
          )
          .get()?.source_excerpt,
        null,
        entry.name,
      );
    } finally {
      fixture.close();
    }
  }
});

test('14B 遗漏 remember sourceExcerpt 时用原文唯一 value 自动提交', async () => {
  const provider = new FakeIntentProvider(() =>
    preferenceDecision('remember', {
      predicate: '主要编辑器',
      value: 'Cursor',
      content: '用户现在主要使用 Cursor。',
      excerpt: '   ',
    })
  );
  const fixture = createFixture(provider);
  try {
    await fixture.lifecycle.beforeModel(
      request('请长期记住我现在主要使用 Cursor。', 'remember-missing-excerpt'),
      'remember-missing-excerpt-request',
    );

    const action = fixture.database
      .prepare(
        `SELECT status, candidate_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'completed');
    assert.ok(action?.candidate_id);
    assert.equal(fixture.memoryStore.list().total, 1);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT source_excerpt
           FROM memory_candidates`,
        )
        .get()?.source_excerpt,
      'Cursor',
    );
  } finally {
    fixture.close();
  }
});

test('自然纠正按 targetQuery 锁定旧 UUID 并继承目标作用域', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'correct',
    confidence: 1,
    sensitivity: 'normal',
    targetQuery: '项目原则 新软件首次打开 数据要求',
    candidate: {
      kind: 'project',
      subject: '新软件首次打开数据要求',
      predicate: '数据要求',
      value: '自动导入最小示例数据',
      content:
        '旧原则为要求空数据，现改为自动导入最小示例数据。' +
        '此信息已更新，感谢反馈！',
      confidence: 1,
      importance: 1,
      sensitivity: 'normal',
      scopeType: 'project',
      scopeKey: 'model-guessed-project',
      sourceExcerpt: '今后应该自动导入一套最小示例数据',
    },
    rationale: '用户明确表示项目原则已经改变',
  }));
  const fixture = createFixture(provider);
  try {
    const current = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户的软件项目原则是首次打开必须为空数据。',
      stableKey: 'personal::self::用户::软件开发原则',
      predicateKey: '用户::软件开发原则',
      normalizedValue: '首次打开为空数据',
      normalizedValueHash: 'project-empty-data',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    const chat = request(
      '我现在的项目原则变了：新软件第一次打开不再要求空数据，' +
        '今后应该自动导入一套最小示例数据。',
      'targeted-natural-correct',
    );

    await fixture.lifecycle.beforeModel(
      chat,
      'targeted-correct-request',
    );

    const corrected = fixture.memoryStore.get(current.id, true);
    assert.match(corrected?.content || '', /最小示例数据/);
    assert.equal(
      corrected?.content,
      'atomic-memory-v1:' + JSON.stringify({
        subject: '项目原则 新软件首次打开 数据要求',
        predicate: '当前值',
        value: '自动导入最小示例数据',
        negated: false,
      }),
    );
    assert.doesNotMatch(corrected?.content || '', /必须为空数据/);
    assert.doesNotMatch(corrected?.content || '', /旧原则|感谢反馈/);
    assert.equal(fixture.memoryStore.list().total, 1);
    assert.equal(fixture.memoryStore.history(current.id).length, 2);
    const item = fixture.database
      .prepare(
        `SELECT predicate_key, normalized_value
         FROM memory_items
         WHERE id = ?`,
      )
      .get(current.id);
    assert.equal(item?.predicate_key, '用户::软件开发原则');
    assert.equal(item?.normalized_value, '自动导入最小示例数据');
    const action = fixture.database
      .prepare(
        `SELECT status, target_memory_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'completed');
    assert.equal(action?.target_memory_id, current.id);
    const candidate = fixture.database
      .prepare(
        `SELECT kind, subject, predicate, scope_type, scope_key,
                explicit_correction, resolved_memory_item_id
         FROM memory_candidates`,
      )
      .get();
    assert.equal(candidate?.kind, 'preference');
    assert.equal(candidate?.subject, '新软件首次打开数据要求');
    assert.equal(candidate?.predicate, '数据要求');
    assert.equal(candidate?.scope_type, 'personal');
    assert.equal(candidate?.scope_key, 'self');
    assert.equal(candidate?.explicit_correction, 1);
    assert.equal(candidate?.resolved_memory_item_id, current.id);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'resolve_candidate'`,
        )
        .get()?.count,
      0,
    );
    const versions = fixture.database
      .prepare(
        `SELECT superseded_at
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version`,
      )
      .all(current.id);
    assert.equal(versions.length, 2);
    assert.ok(versions[0]?.superseded_at);
    assert.equal(versions[1]?.superseded_at, null);
  } finally {
    fixture.close();
  }
});

test('纠正候选继承目标 kind/scope 且不能走通用候选接受入口', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'correct',
    confidence: 0.8,
    sensitivity: 'normal',
    targetQuery: '主要编辑器 VS Code',
    candidate: {
      kind: 'project',
      subject: '用户',
      predicate: '主要编辑器',
      value: 'Cursor',
      content: '用户现在主要使用 Cursor。',
      confidence: 0.8,
      importance: 0.9,
      sensitivity: 'normal',
      scopeType: 'project',
      scopeKey: 'model-guessed-project',
      sourceExcerpt: '现在改用 Cursor',
    },
    rationale: '用户明确纠正主要编辑器',
  }));
  const fixture = createFixture(provider);
  try {
    const current = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'personal::self::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'editor-vscode',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;

    await fixture.lifecycle.beforeModel(
      request(
        '我不再使用 VS Code 了，现在改用 Cursor。',
        'scoped-correction-review',
      ),
      'scoped-correction-review',
    );

    const action = fixture.database
      .prepare(
        `SELECT id, status, target_memory_id, candidate_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'pending');
    assert.equal(action?.target_memory_id, current.id);
    assert.throws(
      () => fixture.admin.acceptCandidate(String(action?.candidate_id)),
      /纠正动作.*专用审核入口/u,
    );
    assert.equal(
      fixture.memoryStore.get(current.id)?.content,
      '用户主要使用 VS Code。',
    );

    const candidate = fixture.lifecycleStore.getCandidate(
      String(action?.candidate_id),
    );
    assert.equal(candidate?.kind, 'preference');
    assert.equal(candidate?.scopeType, 'personal');
    assert.equal(candidate?.scopeKey, 'self');

    const accepted = fixture.admin.acceptMemoryActionRequest(
      String(action?.id),
    );
    assert.equal(accepted.memoryId, current.id);
    assert.match(
      fixture.memoryStore.get(current.id)?.content || '',
      /Cursor/u,
    );
  } finally {
    fixture.close();
  }
});

test('手工纠正只能选择原会话可见的 project 目标', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'correct',
    confidence: 1,
    sensitivity: 'normal',
    targetQuery: '绝对不存在的旧目标 7f49',
    candidate: {
      kind: 'project',
      subject: '当前项目',
      predicate: '框架',
      value: 'Svelte',
      content: '当前项目使用 Svelte。',
      confidence: 1,
      importance: 0.9,
      sensitivity: 'normal',
      scopeType: 'personal',
      scopeKey: 'self',
      sourceExcerpt: '项目以后改用 Svelte',
    },
    rationale: '用户明确纠正项目框架',
  }));
  const fixture = createFixture(provider);
  try {
    await fixture.lifecycle.beforeModel(
      request(
        '项目以后改用 Svelte，旧配置不用了。',
        'manual-project-correction',
      ),
      'manual-project-correction',
      trustedProjectIdentity('round-manual-project-correction'),
    );
    const action = fixture.database
      .prepare(
        `SELECT id, status, candidate_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'pending');
    const candidate = fixture.lifecycleStore.getCandidate(
      String(action?.candidate_id),
    );
    assert.equal(candidate?.scopeType, 'project');
    assert.equal(candidate?.scopeKey, 'trusted-project-A');

    const projectB = fixture.memoryStore.remember({
      kind: 'project',
      content: '另一个项目使用 Vue。',
      stableKey: 'project-b::framework',
      predicateKey: '另一个项目::框架',
      normalizedValue: 'Vue',
      normalizedValueHash: 'project-b-vue',
      predicateCardinality: 'single',
      scopeType: 'project',
      scopeKey: 'trusted-project-B',
      sourceAuthority: 'direct_user',
    }).memory;
    assert.throws(
      () => fixture.admin.acceptMemoryActionRequest(
        String(action?.id),
        { memoryId: projectB.id },
      ),
      /原会话不可见/u,
    );
    assert.equal(
      fixture.memoryStore.get(projectB.id)?.content,
      '另一个项目使用 Vue。',
    );

    const projectA = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目使用 React。',
      stableKey: 'project-a::framework',
      predicateKey: '当前项目::框架',
      normalizedValue: 'React',
      normalizedValueHash: 'project-a-react',
      predicateCardinality: 'single',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
      sourceAuthority: 'direct_user',
    }).memory;
    const accepted = fixture.admin.acceptMemoryActionRequest(
      String(action?.id),
      { memoryId: projectA.id },
    );
    assert.equal(accepted.memoryId, projectA.id);
    assert.match(
      fixture.memoryStore.get(projectA.id)?.content || '',
      /Svelte/u,
    );
  } finally {
    fixture.close();
  }
});

test('自动纠正在提交前重验目标仍属于原会话作用域', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'correct',
    confidence: 1,
    sensitivity: 'normal',
    targetQuery: '',
    candidate: {
      kind: 'project',
      subject: '当前项目',
      predicate: '框架',
      value: 'Svelte',
      content: '当前项目使用 Svelte。',
      confidence: 1,
      importance: 0.9,
      sensitivity: 'normal',
      scopeType: 'project',
      scopeKey: 'model-guessed-project',
      sourceExcerpt: '项目框架改成 Svelte',
    },
    rationale: '用户明确纠正项目框架',
  }));
  const fixture = createFixture(provider);
  try {
    const current = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目使用 React。',
      stableKey: 'project-a::framework',
      predicateKey: '当前项目::框架',
      normalizedValue: 'React',
      normalizedValueHash: 'project-a-react',
      predicateCardinality: 'single',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
      sourceAuthority: 'direct_user',
    }).memory;
    const completeExtraction =
      fixture.lifecycleStore.completeExtraction.bind(
        fixture.lifecycleStore,
      );
    fixture.lifecycleStore.completeExtraction = ((...args: Parameters<
      typeof completeExtraction
    >) => {
      const persisted = completeExtraction(...args);
      fixture.memoryStore.update(current.id, {
        scopeType: 'project',
        scopeKey: 'trusted-project-B',
      });
      return persisted;
    }) as typeof fixture.lifecycleStore.completeExtraction;

    await fixture.lifecycle.beforeModel(
      request(
        '项目框架改成 Svelte，React 不用了。',
        'correction-target-scope-race',
      ),
      'correction-target-scope-race',
      trustedProjectIdentity('round-correction-target-scope-race'),
    );

    const action = fixture.database
      .prepare(
        `SELECT status, error
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'failed');
    assert.match(String(action?.error), /原会话不可见/u);
    const unchanged = fixture.memoryStore.get(current.id);
    assert.equal(unchanged?.content, '当前项目使用 React。');
    assert.equal(unchanged?.scopeKey, 'trusted-project-B');
  } finally {
    fixture.close();
  }
});

test('精确纠正目标在提取事务内拒绝跨 project 与双表 scope 分歧', () => {
  const provider = new FakeIntentProvider(() =>
    preferenceDecision('remember', {
      predicate: '占位',
      value: '占位',
      content: '占位事实。',
      excerpt: '占位事实',
    }));
  const fixture = createFixture(provider);
  try {
    const recorded = fixture.lifecycleStore.recordTurn({
      userId: 'default',
      namespace: 'personal',
      personaId: 'persona-A',
      projectId: 'trusted-project-A',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-exact-target-validation',
      clientName: 'client',
      sessionExternalId: 'chat-project-A',
      turnExternalId: 'user:round-exact-target-validation',
      role: 'user',
      content: '项目框架改成 Svelte。',
    });
    const candidate = {
      kind: 'project' as const,
      subject: '当前项目',
      predicate: '框架',
      value: 'Svelte',
      content: '当前项目使用 Svelte。',
      confidence: 1,
      importance: 0.9,
      scopeType: 'personal' as const,
      scopeKey: 'self',
      sourceExcerpt: '项目框架改成 Svelte',
    };
    const projectB = fixture.memoryStore.remember({
      kind: 'project',
      content: '另一个项目使用 Vue。',
      stableKey: 'exact-target-project-b',
      predicateKey: '另一个项目::框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-B',
    }).memory;
    const crossProjectRun = fixture.lifecycleStore.startExtraction(
      recorded.turn.id,
      'qwen2.5:14b',
      'exact-target-cross-project-v1',
    );
    assert.throws(
      () => fixture.lifecycleStore.completeExtraction(
        crossProjectRun,
        [candidate],
        {
          enqueueResolution: false,
          trustedCorrectionTargetId: projectB.id,
        },
      ),
      /可信纠正目标对原会话不可见/u,
    );

    const projectA = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目使用 React。',
      stableKey: 'exact-target-project-a',
      predicateKey: '当前项目::框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    }).memory;
    fixture.database
      .prepare(
        `UPDATE memory_items
         SET scope_key = 'corrupt-project'
         WHERE id = ?`,
      )
      .run(projectA.id);
    const inconsistentRun = fixture.lifecycleStore.startExtraction(
      recorded.turn.id,
      'qwen2.5:14b',
      'exact-target-inconsistent-v1',
    );
    assert.throws(
      () => fixture.lifecycleStore.completeExtraction(
        inconsistentRun,
        [candidate],
        {
          enqueueResolution: false,
          trustedCorrectionTargetId: projectA.id,
        },
      ),
      /可信纠正目标状态或规范投影不一致/u,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM memory_candidates')
        .get()?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('显式记住不能把模型猜测的 project key 送入接受快车道', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'remember',
    confidence: 1,
    sensitivity: 'normal',
    targetQuery: '',
    candidate: {
      kind: 'project',
      subject: '猜测项目',
      predicate: '数据库',
      value: 'SQLite',
      content: '猜测项目使用 SQLite。',
      confidence: 1,
      importance: 0.9,
      sensitivity: 'normal',
      scopeType: 'project',
      scopeKey: 'model-guessed-project',
      sourceExcerpt: '猜测项目使用 SQLite',
    },
    rationale: '用户明确要求记住',
  }));
  const fixture = createFixture(provider);
  try {
    await fixture.lifecycle.beforeModel(
      request(
        '请记住，猜测项目使用 SQLite。',
        'untrusted-project-remember',
      ),
      'untrusted-project-remember',
    );

    const action = fixture.database
      .prepare(
        `SELECT status, candidate_id, candidate_json, rationale
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'rejected');
    assert.equal(
      action?.rationale,
      'trusted_project_scope_required',
    );
    assert.ok(action?.candidate_id);
    assert.doesNotMatch(
      String(action?.candidate_json),
      /model-guessed-project/u,
    );
    const candidate = fixture.lifecycleStore.getCandidate(
      String(action?.candidate_id),
    );
    assert.equal(candidate?.state, 'rejected');
    assert.equal(
      candidate?.decisionReason,
      'trusted_project_scope_required',
    );
    assert.notEqual(candidate?.scopeKey, 'model-guessed-project');
    assert.match(candidate?.scopeKey || '', /^unbound:/u);
    assert.equal(fixture.memoryStore.list().total, 0);
    assert.equal(fixture.admin.listMemoryActionInbox().length, 0);
  } finally {
    fixture.close();
  }
});

test('显式纠正把 NFKC 等价 sourceExcerpt 映射回用户原文', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'correct',
    confidence: 1,
    sensitivity: 'sensitive',
    targetQuery: '项目原则 新软件首次打开 数据要求',
    candidate: {
      kind: 'project',
      subject: '新软件首次打开数据要求',
      predicate: '数据要求',
      value: '自动导入一套最小示例数据',
      content: '新软件首次打开时自动导入一套最小示例数据。',
      confidence: 1,
      importance: 1,
      sensitivity: 'sensitive',
      scopeType: 'project',
      scopeKey: 'model-guessed-project',
      sourceExcerpt:
        '项目原则变了:新软件第一次打开不再要求空数据,' +
        '今后应该自动导入一套最小示例数据,方便客户马上体验。',
    },
    rationale: '用户明确表示项目原则已经改变',
  }));
  const fixture = createFixture(provider);
  try {
    const current = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户的软件项目原则是首次打开必须为空数据。',
      stableKey: 'personal::self::用户::软件开发原则',
      predicateKey: '用户::软件开发原则',
      normalizedValue: '首次打开为空数据',
      normalizedValueHash: 'project-empty-data',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    const userText =
      '我现在的项目原则变了：新软件第一次打开不再要求空数据，' +
      '今后应该自动导入一套最小示例数据，方便客户马上体验。';

    await fixture.lifecycle.beforeModel(
      request(userText, 'nfkc-correct'),
      'nfkc-correct-request',
      trustedProjectIdentity('round-nfkc-correct'),
    );

    const action = fixture.database
      .prepare(
        `SELECT status, target_memory_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'completed');
    assert.equal(action?.target_memory_id, current.id);
    assert.equal(fixture.memoryStore.history(current.id).length, 2);
    const candidate = fixture.database
      .prepare(
        `SELECT c.source_excerpt, c.sensitivity,
                t.content AS turn_content,
                resolved_memory_item_id
         FROM memory_candidates c
         JOIN conversation_turns t ON t.id = c.turn_id`,
      )
      .get();
    assert.equal(
      candidate?.source_excerpt,
      '项目原则变了：新软件第一次打开不再要求空数据，' +
        '今后应该自动导入一套最小示例数据，方便客户马上体验。',
    );
    assert.ok(
      userText.includes(String(candidate?.source_excerpt)),
    );
    assert.equal(candidate?.sensitivity, 'normal');
    assert.equal(candidate?.resolved_memory_item_id, current.id);
    assert.equal(candidate?.turn_content, userText);
    const evidence = fixture.database
      .prepare(
        `SELECT excerpt
         FROM memory_evidence
         WHERE memory_version_id IN (
           SELECT id
           FROM memory_versions
           WHERE memory_item_id = ?
         )
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(current.id);
    assert.equal(
      evidence?.excerpt,
      candidate?.source_excerpt,
    );
    assert.match(
      JSON.stringify(fixture.admin.memoryDetail(current.id)),
      /项目原则变了：新软件第一次打开不再要求空数据，/u,
    );
  } finally {
    fixture.close();
  }
});

test('纠正目标召回失败保留候选 checkpoint 并可人工恢复', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'correct',
    confidence: 1,
    sensitivity: 'normal',
    targetQuery: '项目原则 新软件首次打开 数据要求',
    candidate: {
      kind: 'project',
      subject: '新软件首次打开数据要求',
      predicate: '数据要求',
      value: '自动导入一套最小示例数据',
      content: '新软件首次打开时自动导入一套最小示例数据。',
      confidence: 1,
      importance: 1,
      sensitivity: 'normal',
      scopeType: 'project',
      scopeKey: 'model-guessed-project',
      sourceExcerpt: '今后应该自动导入一套最小示例数据',
    },
    rationale: '用户明确表示项目原则已经改变',
  }));
  const fixture = createFixture(provider);
  try {
    const current = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户的软件项目原则是首次打开必须为空数据。',
      stableKey: 'personal::self::用户::软件开发原则',
      predicateKey: '用户::软件开发原则',
      normalizedValue: '首次打开为空数据',
      normalizedValueHash: 'project-empty-data',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    Object.defineProperty(
      fixture.memoryStore,
      'recallReliable',
      {
        configurable: true,
        value: async () => {
          throw new Error('semantic service unavailable');
        },
      },
    );

    await fixture.lifecycle.beforeModel(
      request(
        '我现在的项目原则变了：新软件第一次打开不再要求空数据，' +
          '今后应该自动导入一套最小示例数据。',
        'checkpointed-natural-correct',
      ),
      'checkpointed-correct-request',
      trustedProjectIdentity('round-checkpointed-correct'),
    );

    const action = fixture.database
      .prepare(
        `SELECT id, status, target_query, candidate_id,
                candidate_json, confidence, rationale, error
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'failed');
    assert.equal(
      action?.target_query,
      '项目原则 新软件首次打开 数据要求',
    );
    assert.ok(action?.candidate_id);
    assert.match(
      String(action?.candidate_json),
      /自动导入一套最小示例数据/u,
    );
    assert.equal(action?.confidence, 1);
    assert.equal(
      action?.rationale,
      'explicit_intent_processing_failed',
    );
    assert.match(
      String(action?.error),
      /semantic service unavailable/u,
    );
    const candidate = fixture.database
      .prepare(
        `SELECT state, resolved_memory_item_id
         FROM memory_candidates
         WHERE id = ?`,
      )
      .get(action?.candidate_id);
    assert.equal(candidate?.state, 'pending');
    assert.equal(candidate?.resolved_memory_item_id, null);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'resolve_candidate'`,
        )
        .get()?.count,
      0,
    );

    const recovered = fixture.admin.acceptMemoryActionRequest(
      String(action?.id),
      { memoryId: current.id },
    );
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.memoryId, current.id);
    assert.equal(fixture.memoryStore.list().total, 1);
    assert.equal(fixture.memoryStore.history(current.id).length, 2);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status, target_memory_id
           FROM memory_action_requests
           WHERE id = ?`,
        )
        .get(action?.id)?.status,
      'completed',
    );
  } finally {
    fixture.close();
  }
});

test('纠正目标有歧义时进入收件箱且绝不新建第三条事实', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'correct',
    confidence: 1,
    sensitivity: 'normal',
    targetQuery: '项目',
    candidate: {
      kind: 'project',
      subject: '用户',
      predicate: '项目配置变更',
      value: '使用 Svelte',
      content: '用户的项目使用 Svelte。',
      confidence: 1,
      importance: 0.9,
      sensitivity: 'normal',
      scopeType: 'personal',
      scopeKey: 'self',
      sourceExcerpt: '项目以后改用 Svelte',
    },
    rationale: '用户要求改变项目配置',
  }));
  const fixture = createFixture(provider);
  try {
    fixture.memoryStore.remember({
      kind: 'project',
      content: '用户的项目 A 使用 React。',
      stableKey: 'project-a-framework',
      predicateKey: '项目 A::框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    });
    fixture.memoryStore.remember({
      kind: 'project',
      content: '用户的项目 B 使用 Vue。',
      stableKey: 'project-b-framework',
      predicateKey: '项目 B::框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    });

    await fixture.lifecycle.beforeModel(
      request(
        '项目以后改用 Svelte，但我没说是哪个项目。',
        'ambiguous-natural-correct',
      ),
      'ambiguous-natural-correct',
      trustedProjectIdentity('round-ambiguous-natural-correct'),
    );

    assert.equal(fixture.memoryStore.list().total, 2);
    const action = fixture.database
      .prepare(
        `SELECT status, target_memory_id, rationale
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'pending');
    assert.equal(action?.target_memory_id, null);
    assert.equal(action?.rationale, 'correct_target_ambiguous');
  } finally {
    fixture.close();
  }
});

test('明确记住同步提交且同一用户回合重放不重复写入', async () => {
  const provider = new FakeIntentProvider(() =>
    preferenceDecision('remember', {
      predicate: '演示数据偏好',
      value: '不内置演示数据',
      content: '用户不希望应用内置演示数据。',
      excerpt: '不喜欢内置演示数据',
    }));
  const fixture = createFixture(provider);
  try {
    const chat = request(
      '请记住，我做应用时不喜欢内置演示数据。',
      'natural-remember',
    );
    await fixture.lifecycle.beforeModel(chat, 'remember-request-1');
    await fixture.lifecycle.beforeModel(chat, 'remember-request-2');

    assert.equal(provider.calls, 1);
    assert.equal(fixture.memoryStore.list().total, 1);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_action_requests`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates`,
        )
        .get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('模糊忘记进入收件箱且同轮不召回任何可能被删的记忆', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '项目',
    candidate: null,
    rationale: '用户未说明具体项目',
  }));
  const fixture = createFixture(provider);
  try {
    fixture.memoryStore.remember({
      kind: 'project',
      content: '项目 A 使用 React。',
      stableKey: 'project-a',
      predicateKey: '项目::技术栈',
    });
    fixture.memoryStore.remember({
      kind: 'project',
      content: '项目 B 使用 Vue。',
      stableKey: 'project-b',
      predicateKey: '项目::技术栈',
    });
    const chat = request('把项目相关的记忆忘掉。', 'ambiguous-forget');

    const prepared = await fixture.lifecycle.beforeModel(
      chat,
      'ambiguous-request',
    );
    assert.equal((prepared.messages as JsonRecord[]).length, 1);
    assert.equal(fixture.memoryStore.list().total, 2);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status, rationale
           FROM memory_action_requests`,
        )
        .get()?.status,
      'pending',
    );
  } finally {
    fixture.close();
  }
});

test('敏感记忆只进入候选收件箱，凭据不落候选或原始 turn', async () => {
  const sensitiveProvider = new FakeIntentProvider(() =>
    preferenceDecision('remember', {
      predicate: '健康状况',
      value: '需要定期复诊',
      content: '用户需要定期复诊。',
      excerpt: '需要定期复诊',
      sensitivity: 'sensitive',
    }));
  const sensitive = createFixture(sensitiveProvider);
  try {
    const chat = request(
      '请记住，我需要定期复诊。',
      'sensitive-remember',
    );
    await sensitive.lifecycle.beforeModel(chat, 'sensitive-request');
    assert.equal(sensitive.memoryStore.list().total, 0);
    assert.equal(
      sensitive.database
        .prepare(
          `SELECT status, sensitivity
           FROM memory_action_requests`,
        )
        .get()?.status,
      'pending',
    );
    assert.equal(
      sensitive.database
        .prepare(
          `SELECT sensitivity
           FROM memory_candidates`,
        )
        .get()?.sensitivity,
      'sensitive',
    );
  } finally {
    sensitive.close();
  }

  const credentialProvider = new FakeIntentProvider(() =>
    preferenceDecision('remember', {
      predicate: '验证码',
      value: '123456',
      content: '用户的验证码是 123456。',
      excerpt: '验证码是 123456',
      sensitivity: 'credential',
    }));
  const credential = createFixture(credentialProvider);
  try {
    const chat = request(
      '请记住，我的验证码是 123456。',
      'credential-remember',
    );
    await credential.lifecycle.beforeModel(
      chat,
      'credential-request',
    );
    assert.equal(credentialProvider.calls, 0);
    assert.equal(
      credential.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates`,
        )
        .get()?.count,
      0,
    );
    credential.lifecycle.afterTurn(
      chat,
      completion('我不能保存凭据。'),
      'credential-request',
    );
    const turns = credential.database
      .prepare(
        `SELECT content
         FROM conversation_turns
         ORDER BY role DESC`,
      )
      .all() as Array<{ content: string }>;
    assert.ok(
      turns.every((turn) => !turn.content.includes('123456')),
    );
    assert.equal(
      credential.database
        .prepare(
          `SELECT candidate_json
           FROM memory_action_requests`,
        )
        .get()?.candidate_json,
      null,
    );
  } finally {
    credential.close();
  }
});

test('动作收件箱可人工接受记住与纠正，并安全确认遗忘目标', async () => {
  const rememberProvider = new FakeIntentProvider(() =>
    preferenceDecision('remember', {
      predicate: '健康安排',
      value: '定期复诊',
      content: '用户需要定期复诊。',
      excerpt: '需要定期复诊',
      sensitivity: 'sensitive',
    }));
  const remember = createFixture(rememberProvider);
  try {
    await remember.lifecycle.beforeModel(
      request(
        '请记住，我需要定期复诊。',
        'review-remember',
      ),
      'review-remember',
    );
    const pending = remember.admin.listMemoryActionInbox()[0];
    assert.equal(pending?.action, 'remember');
    assert.equal(pending?.candidate?.value, '定期复诊');
    assert.equal(remember.admin.listCandidateInbox().length, 0);
    const accepted = remember.admin.acceptMemoryActionRequest(
      pending.id,
      {
        value: '每年定期复诊',
        content: '用户需要每年定期复诊。',
      },
    );
    assert.equal(accepted.status, 'completed');
    assert.match(
      remember.memoryStore.get(accepted.memoryId || '')?.content || '',
      /每年定期复诊/,
    );
    assert.equal(remember.admin.listMemoryActionInbox().length, 0);
    assert.equal(
      remember.admin.acceptMemoryActionRequest(pending.id).status,
      'completed',
    );
  } finally {
    remember.close();
  }

  const correctProvider = new FakeIntentProvider(() =>
    preferenceDecision('correct', {
      predicate: '主要编辑器',
      value: 'Cursor',
      content: '用户现在主要使用 Cursor。',
      excerpt: '现在改用 Cursor',
      confidence: 0.8,
    }));
  const correct = createFixture(correctProvider);
  try {
    const current = correct.memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'personal::self::用户::主要编辑器',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'editor-vscode',
      predicateCardinality: 'single',
      sourceAuthority: 'direct_user',
    }).memory;
    await correct.lifecycle.beforeModel(
      request(
        '我不再使用 VS Code 了，现在改用 Cursor。',
        'review-correct',
      ),
      'review-correct',
    );
    const pending = correct.admin.listMemoryActionInbox()[0];
    assert.equal(pending?.action, 'correct');
    const accepted = correct.admin.acceptMemoryActionRequest(
      pending.id,
    );
    assert.equal(accepted.memoryId, current.id);
    assert.match(
      correct.memoryStore.get(current.id)?.content || '',
      /Cursor/,
    );
    assert.equal(correct.memoryStore.history(current.id).length, 2);
  } finally {
    correct.close();
  }

  const forgetProvider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '项目',
    candidate: null,
    rationale: '用户未说明具体项目',
  }));
  const forget = createFixture(forgetProvider);
  try {
    const projectA = forget.memoryStore.remember({
      kind: 'project',
      content: '项目 A 使用 React。',
      stableKey: 'review-project-a',
      predicateKey: '项目::技术栈',
    }).memory;
    const projectB = forget.memoryStore.remember({
      kind: 'project',
      content: '项目 B 使用 Vue。',
      stableKey: 'review-project-b',
      predicateKey: '项目::技术栈',
    }).memory;
    await forget.lifecycle.beforeModel(
      request('把项目相关的记忆忘掉。', 'review-forget'),
      'review-forget',
    );
    const pending = forget.admin.listMemoryActionInbox()[0];
    assert.equal(pending?.action, 'forget');
    assert.equal(pending?.targetQuery, '项目');
    assert.throws(
      () => forget.admin.acceptMemoryActionRequest(pending.id),
      /必须选择目标记忆/,
    );
    const accepted = forget.admin.acceptMemoryActionRequest(
      pending.id,
      { memoryId: projectA.id },
    );
    assert.equal(accepted.memoryId, projectA.id);
    assert.equal(
      forget.memoryStore.get(projectA.id, true)?.status,
      'deleted',
    );
    assert.equal(
      forget.memoryStore.get(projectB.id, true)?.status,
      'active',
    );
  } finally {
    forget.close();
  }
});

test('人工确认遗忘只能选择原始会话可见的记忆', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '框架',
    candidate: null,
    rationale: '用户未说明具体框架记忆',
  }));
  const fixture = createFixture(provider);
  try {
    const visible = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目使用 React。',
      stableKey: 'forget-visible-project-a',
      predicateKey: '当前项目::框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    }).memory;
    const hidden = [
      fixture.memoryStore.remember({
        kind: 'project',
        content: '另一个项目使用 Vue。',
        stableKey: 'forget-hidden-project-b',
        predicateKey: '另一个项目::框架',
        scopeType: 'project',
        scopeKey: 'trusted-project-B',
      }).memory,
      fixture.memoryStore.remember({
        kind: 'preference',
        content: '另一个角色偏好 Emacs。',
        stableKey: 'forget-hidden-persona-b',
        predicateKey: '用户::编辑器',
        scopeType: 'role',
        scopeKey: 'persona-B',
      }).memory,
      fixture.memoryStore.remember({
        kind: 'preference',
        content: '另一个会话正在测试 Vim。',
        stableKey: 'forget-hidden-session-b',
        predicateKey: '用户::临时编辑器',
        scopeType: 'session',
        scopeKey: 'chat-project-B',
      }).memory,
    ];

    await fixture.lifecycle.beforeModel(
      request('把框架相关的记忆忘掉。', 'forget-scope-project-A'),
      'forget-scope-project-A',
      trustedProjectIdentity('round-forget-scope-project-A'),
    );
    const pending = fixture.admin.listMemoryActionInbox()[0];
    assert.equal(pending?.action, 'forget');

    for (const memory of hidden) {
      assert.throws(
        () => fixture.admin.acceptMemoryActionRequest(
          pending.id,
          { memoryId: memory.id },
        ),
        /原会话不可见/u,
      );
      assert.equal(
        fixture.memoryStore.get(memory.id, true)?.status,
        'active',
      );
    }

    const accepted = fixture.admin.acceptMemoryActionRequest(
      pending.id,
      { memoryId: visible.id },
    );
    assert.equal(accepted.memoryId, visible.id);
    assert.equal(
      fixture.memoryStore.get(visible.id, true)?.status,
      'deleted',
    );
  } finally {
    fixture.close();
  }
});

test('待确认遗忘不能通过改绑原始会话获得新的 project 可见性', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '框架',
    candidate: null,
    rationale: '用户未说明具体框架记忆',
  }));
  const fixture = createFixture(provider);
  try {
    const hidden = fixture.memoryStore.remember({
      kind: 'project',
      content: '另一个项目使用 Vue。',
      stableKey: 'forget-session-drift-project-b',
      predicateKey: '另一个项目::框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-B',
    }).memory;
    await fixture.lifecycle.beforeModel(
      request('把框架相关的记忆忘掉。', 'forget-session-drift'),
      'forget-session-drift',
      trustedProjectIdentity('round-forget-session-drift'),
    );
    const pending = fixture.admin.listMemoryActionInbox()[0];

    assert.throws(
      () => fixture.database
        .prepare(
          `UPDATE conversation_sessions
           SET project_id = 'trusted-project-B'
           WHERE external_id = 'chat-project-A'`,
        )
        .run(),
      /immutable|不可变|固定/iu,
    );
    assert.throws(
      () => fixture.admin.acceptMemoryActionRequest(
        pending.id,
        { memoryId: hidden.id },
      ),
      /原会话不可见/u,
    );
    assert.equal(
      fixture.memoryStore.get(hidden.id, true)?.status,
      'active',
    );
  } finally {
    fixture.close();
  }
});

test('人工遗忘在删除事务内重新校验目标 exact scope', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '框架',
    candidate: null,
    rationale: '用户未说明具体框架记忆',
  }));
  const fixture = createFixture(provider);
  try {
    const target = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目使用 React。',
      stableKey: 'forget-target-scope-race-project-a',
      predicateKey: '当前项目::框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    }).memory;
    await fixture.lifecycle.beforeModel(
      request('把框架相关的记忆忘掉。', 'forget-target-scope-race'),
      'forget-target-scope-race',
      trustedProjectIdentity('round-forget-target-scope-race'),
    );
    const pending = fixture.admin.listMemoryActionInbox()[0];
    const originalForget = fixture.memoryStore.forget.bind(
      fixture.memoryStore,
    );
    fixture.memoryStore.forget = ((...args: Parameters<
      MemoryStore['forget']
    >) => {
      fixture.memoryStore.update(target.id, {
        scopeType: 'project',
        scopeKey: 'trusted-project-B',
      });
      return originalForget(...args);
    }) as MemoryStore['forget'];

    assert.throws(
      () => fixture.admin.acceptMemoryActionRequest(
        pending.id,
        { memoryId: target.id },
      ),
      /原会话不可见|作用域|scope/iu,
    );
    assert.equal(
      fixture.memoryStore.get(target.id, true)?.status,
      'active',
    );
    assert.equal(
      fixture.memoryStore.get(target.id, true)?.scopeKey,
      'trusted-project-B',
    );
  } finally {
    fixture.close();
  }
});

test('人工遗忘与动作完成失败时整体回滚且同一请求只能删除一条记忆', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '框架',
    candidate: null,
    rationale: '用户未说明具体框架记忆',
  }));
  const fixture = createFixture(provider);
  try {
    const first = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目的前端框架是 React。',
      stableKey: 'forget-atomic-first',
      predicateKey: '当前项目::前端框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    }).memory;
    const second = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目的测试框架是 Vitest。',
      stableKey: 'forget-atomic-second',
      predicateKey: '当前项目::测试框架',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    }).memory;
    await fixture.lifecycle.beforeModel(
      request('把框架相关的记忆忘掉。', 'forget-atomic-review'),
      'forget-atomic-review',
      trustedProjectIdentity('round-forget-atomic-review'),
    );
    const pending = fixture.admin.listMemoryActionInbox()[0];
    fixture.database.exec(`
      CREATE TRIGGER fail_manual_forget_finish
      BEFORE UPDATE OF status ON memory_action_requests
      WHEN NEW.status = 'completed'
      BEGIN
        SELECT RAISE(ABORT, 'injected finish failure');
      END;
    `);

    assert.throws(
      () => fixture.admin.acceptMemoryActionRequest(
        pending.id,
        { memoryId: first.id },
      ),
      /injected finish failure/u,
    );
    assert.equal(
      fixture.memoryStore.get(first.id, true)?.status,
      'active',
    );
    assert.equal(
      fixture.admin.listMemoryActionInbox()[0]?.id,
      pending.id,
    );

    fixture.database.exec('DROP TRIGGER fail_manual_forget_finish;');
    const accepted = fixture.admin.acceptMemoryActionRequest(
      pending.id,
      { memoryId: second.id },
    );
    assert.equal(accepted.memoryId, second.id);
    assert.equal(
      fixture.memoryStore.get(first.id, true)?.status,
      'active',
    );
    assert.equal(
      fixture.memoryStore.get(second.id, true)?.status,
      'deleted',
    );
  } finally {
    fixture.close();
  }
});

test('自动遗忘在召回后仍会于删除事务内重新校验 exact scope', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '当前项目 前端框架 React',
    candidate: null,
    rationale: '用户明确要求遗忘当前项目框架',
  }));
  const fixture = createFixture(provider);
  try {
    const target = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目的前端框架是 React。',
      stableKey: 'automatic-forget-scope-race',
      predicateKey: '当前项目::前端框架',
      normalizedValue: 'React',
      normalizedValueHash: 'automatic-forget-react',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    }).memory;
    const originalForget = fixture.memoryStore.forget.bind(
      fixture.memoryStore,
    );
    fixture.memoryStore.forget = ((...args: Parameters<
      MemoryStore['forget']
    >) => {
      fixture.memoryStore.update(target.id, {
        scopeType: 'project',
        scopeKey: 'trusted-project-B',
      });
      return originalForget(...args);
    }) as MemoryStore['forget'];

    await fixture.lifecycle.beforeModel(
      request(
        '把当前项目的 React 前端框架记忆忘掉。',
        'automatic-forget-scope-race',
      ),
      'automatic-forget-scope-race',
      trustedProjectIdentity('round-automatic-forget-scope-race'),
    );

    const action = fixture.database
      .prepare(
        `SELECT status, error, target_memory_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'failed');
    assert.match(String(action?.error), /原会话不可见|作用域/iu);
    assert.equal(action?.target_memory_id, null);
    assert.deepEqual(
      {
        status: fixture.memoryStore.get(target.id, true)?.status,
        scopeKey: fixture.memoryStore.get(target.id, true)?.scopeKey,
      },
      { status: 'active', scopeKey: 'trusted-project-B' },
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE memory_item_id = ?`,
        )
        .get(target.id)?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('自动遗忘与动作完成失败时回滚 tombstone、事件、索引与审计', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '主要编辑器 VS Code',
    candidate: null,
    rationale: '用户明确要求遗忘编辑器偏好',
  }));
  const fixture = createFixture(provider);
  try {
    const target = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'automatic-forget-finish-rollback',
      predicateKey: '用户::主要编辑器',
      normalizedValue: 'VS Code',
      normalizedValueHash: 'automatic-forget-vscode',
    }).memory;
    const lexicalBefore = Number(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_term_index
           WHERE memory_id = ?`,
        )
        .get(target.id)?.count || 0,
    );
    assert.ok(lexicalBefore > 0);
    fixture.database.exec(`
      CREATE TRIGGER fail_automatic_forget_finish
      BEFORE UPDATE OF status ON memory_action_requests
      WHEN NEW.status = 'completed' AND NEW.action = 'forget'
      BEGIN
        SELECT RAISE(ABORT, 'injected automatic finish failure');
      END;
    `);

    await fixture.lifecycle.beforeModel(
      request(
        '把我主要使用 VS Code 的编辑器偏好忘掉。',
        'automatic-forget-finish-rollback',
      ),
      'automatic-forget-finish-rollback',
    );

    const action = fixture.database
      .prepare(
        `SELECT status, error, target_memory_id
         FROM memory_action_requests`,
      )
      .get();
    assert.equal(action?.status, 'failed');
    assert.match(
      String(action?.error),
      /injected automatic finish failure/u,
    );
    assert.equal(action?.target_memory_id, null);
    assert.equal(
      fixture.memoryStore.get(target.id, true)?.status,
      'active',
    );
    assert.equal(
      fixture.database
        .prepare('SELECT status FROM memory_items WHERE id = ?')
        .get(target.id)?.status,
      'active',
    );
    for (const [table, predicate] of [
      ['memory_tombstones', 'memory_item_id = ?'],
      ['memory_events', "memory_item_id = ? AND event_type = 'forgotten'"],
      ['audit_log', "memory_id = ? AND action = 'forget'"],
    ] as const) {
      assert.equal(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`,
          )
          .get(target.id)?.count,
        0,
      );
    }
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM outbox_events
           WHERE event_type = 'forgotten'
             AND payload_json LIKE ?`,
        )
        .get(`%${target.id}%`)?.count,
      0,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_term_index
           WHERE memory_id = ?`,
        )
        .get(target.id)?.count,
      lexicalBefore,
    );
  } finally {
    fixture.close();
  }
});

test('自动遗忘与人工审核争抢同一请求时最多删除一条记忆', async () => {
  const provider = new FakeIntentProvider(() => ({
    action: 'forget',
    confidence: 0.99,
    sensitivity: 'normal',
    targetQuery: '前端框架 React',
    candidate: null,
    rationale: '用户明确要求遗忘前端框架',
  }));
  const fixture = createFixture(provider);
  try {
    const automaticTarget = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目的前端框架是 React。',
      stableKey: 'automatic-forget-race-target',
      predicateKey: '当前项目::前端框架',
      normalizedValue: 'React',
      normalizedValueHash: 'automatic-race-react',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    }).memory;
    const manualTarget = fixture.memoryStore.remember({
      kind: 'project',
      content: '当前项目的部署区域是上海。',
      stableKey: 'manual-forget-race-target',
      predicateKey: '当前项目::部署区域',
      normalizedValue: '上海',
      normalizedValueHash: 'manual-race-shanghai',
      scopeType: 'project',
      scopeKey: 'trusted-project-A',
    }).memory;
    const originalForget = fixture.memoryStore.forget.bind(
      fixture.memoryStore,
    );
    let manuallyAcceptedMemoryId: string | null = null;
    fixture.memoryStore.forget = ((...args: Parameters<
      MemoryStore['forget']
    >) => {
      fixture.memoryStore.forget = originalForget as MemoryStore['forget'];
      const pending = fixture.admin.listMemoryActionInbox()[0];
      manuallyAcceptedMemoryId = fixture.admin.acceptMemoryActionRequest(
        pending.id,
        { memoryId: manualTarget.id },
      ).memoryId;
      return originalForget(...args);
    }) as MemoryStore['forget'];

    await fixture.lifecycle.beforeModel(
      request(
        '把当前项目的 React 前端框架记忆忘掉。',
        'automatic-manual-forget-race',
      ),
      'automatic-manual-forget-race',
      trustedProjectIdentity('round-automatic-manual-forget-race'),
    );

    assert.equal(manuallyAcceptedMemoryId, manualTarget.id);
    const action = fixture.database
      .prepare(
        `SELECT status, target_memory_id
         FROM memory_action_requests`,
      )
      .get();
    assert.deepEqual(
      { status: action?.status, memoryId: action?.target_memory_id },
      { status: 'completed', memoryId: manualTarget.id },
    );
    assert.equal(
      fixture.memoryStore.get(automaticTarget.id, true)?.status,
      'active',
    );
    assert.equal(
      fixture.memoryStore.get(manualTarget.id, true)?.status,
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
  } finally {
    fixture.close();
  }
});

test('动作收件箱拒绝候选并用审核租约阻止并发处理', async () => {
  const provider = new FakeIntentProvider(() =>
    preferenceDecision('remember', {
      predicate: '健康状况',
      value: '需要复诊',
      content: '用户需要复诊。',
      excerpt: '需要复诊',
      sensitivity: 'sensitive',
    }));
  const fixture = createFixture(provider);
  try {
    await fixture.lifecycle.beforeModel(
      request('请记住，我需要复诊。', 'review-reject'),
      'review-reject',
    );
    const pending = fixture.admin.listMemoryActionInbox()[0];
    fixture.database
      .prepare(
        `UPDATE memory_action_requests
         SET review_token = ?, review_claimed_at = ?
         WHERE id = ?`,
      )
      .run(
        'other-reviewer',
        new Date().toISOString(),
        pending.id,
      );
    assert.throws(
      () => fixture.admin.rejectMemoryActionRequest(pending.id),
      /正在被其他审核处理/,
    );
    fixture.database
      .prepare(
        `UPDATE memory_action_requests
         SET review_claimed_at = ?
         WHERE id = ?`,
      )
      .run(
        new Date(Date.now() - 6 * 60_000).toISOString(),
        pending.id,
      );
    const rejected = fixture.admin.rejectMemoryActionRequest(
      pending.id,
      true,
    );
    assert.equal(rejected.status, 'rejected');
    assert.equal(
      fixture.lifecycleStore.getCandidate(
        rejected.candidateId || '',
      )?.state,
      'rejected',
    );
    assert.equal(fixture.admin.listMemoryActionInbox().length, 0);
  } finally {
    fixture.close();
  }
});
