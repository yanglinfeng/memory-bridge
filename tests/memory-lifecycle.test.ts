import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MemoryLifecycle,
  memoryGroundingReason,
  REDACTED_CREDENTIAL_TURN,
} from '../src/server/memory-lifecycle.js';
import type {
  ContextualQueryUnderstandingService,
} from '../src/server/contextual-query-understanding.js';
import type {
  LifecycleRequestContext,
} from '../src/server/ollama-compat.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';
import {
  modelQosSnapshot,
  resetModelQosForTests,
} from '../src/server/model-qos.js';
import type {
  NamespaceRecallCoordinator,
} from '../src/server/namespace-quality.js';
import type { RecallInput } from '../src/server/types.js';

type JsonRecord = Record<string, unknown>;

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-airi-lifecycle-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const lifecycle = new MemoryLifecycle(
    memoryStore,
    lifecycleStore,
  );
  return {
    database,
    memoryStore,
    lifecycleStore,
    lifecycle,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function completion(content: string): JsonRecord {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content,
        },
      },
    ],
  };
}

function toolCompletion(
  callId: string,
  name: string,
  args: string,
): JsonRecord {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: callId,
              type: 'function',
              function: { name, arguments: args },
            },
          ],
        },
      },
    ],
  };
}

function completeIdentity(
  overrides: Partial<LifecycleRequestContext> = {},
): LifecycleRequestContext {
  return {
    principalId: 'alice',
    namespace: 'personal',
    credentialId: 'credential-alice',
    authSource: 'credential',
    personaId: 'persona-A',
    sessionId: 'chat-A1',
    roundId: 'round-1',
    projectId: null,
    identityStatus: 'complete',
    ...overrides,
  };
}

test('AIRI 只把私有稳定事实和显式记忆查询纳入答案门禁', () => {
  for (const query of [
    '我最喜欢什么饮料？',
    '星港项目现在的代号是什么？',
    'Alice 的星港项目现在代号是什么？',
    '这个项目的发布窗口怎么安排的？',
    '我以前给香菜起过什么特别称呼？',
    '你在这个角色里应该怎么称呼我？',
    'Where do I live?',
  ]) {
    assert.equal(
      memoryGroundingReason(query),
      'private_fact_query',
      query,
    );
  }
  assert.equal(
    memoryGroundingReason('请只根据长期记忆给我做一个计划。'),
    'explicit_query',
  );
  for (const query of [
    '如何给项目起名字？',
    '什么是向量数据库？',
    '我应该用什么编辑器入门？',
    '星港项目应该怎么部署？',
    'Linux 项目现在的负责人是谁？',
    '哪个开源项目现在状态最好？',
    'What is the AIRI project?',
  ]) {
    assert.equal(memoryGroundingReason(query), null, query);
  }
});

test('全新会话没有历史上下文时不启动无效的模型质量补救', async () => {
  const fixture = createFixture();
  let understandingCalls = 0;
  let receivedQualityFallback: unknown = Symbol('unset');
  const queryUnderstandingService = {
    async understand(input: { originalQuery: string }) {
      understandingCalls += 1;
      return {
        status: 'not_needed',
        originalQuery: input.originalQuery,
        standaloneQuery: null,
        rankingQuery: input.originalQuery,
        variants: [],
        resolvedReferences: [],
        triggerReasons: [],
        confidence: 0,
      };
    },
  } as unknown as ContextualQueryUnderstandingService;
  const coordinator = {
    async recallForLifecycle(
      input: RecallInput,
      options: { qualityFallback?: unknown },
    ) {
      receivedQualityFallback = options.qualityFallback;
      return {
        query: input.query,
        memories: [],
        context: '没有找到与当前问题相关的长期记忆。',
        qualityState: 'full',
        queryUnderstanding: {
          status: 'not_needed',
          originalQuery: input.query,
          standaloneQuery: null,
          rankingQuery: input.query,
          variants: [],
          resolvedReferences: [],
          triggerReasons: [],
          confidence: 0,
        },
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    fixture.memoryStore,
    fixture.lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
    undefined,
    queryUnderstandingService,
  );

  try {
    await lifecycle.beforeModel({
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '什么是向量数据库？' }],
    }, 'standalone-no-fallback', completeIdentity());

    assert.equal(understandingCalls, 1);
    assert.equal(receivedQualityFallback, undefined);
  } finally {
    lifecycle.cancelTurn('standalone-no-fallback');
    fixture.close();
  }
});

test('beforeModel 只召回；最终回复完成后才原子落账并排提取任务', async () => {
  const fixture = createFixture();
  try {
    const remembered = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户开发应用时不喜欢内置演示数据。',
      importance: 0.9,
    }).memory;
    const request = {
      model: 'qwen2.5:14b',
      messages: [
        {
          role: 'user',
          content: '新应用首次启动时的数据应该怎么设计？',
        },
      ],
    };

    const prepared = await fixture.lifecycle.beforeModel(
      request,
      'request-1',
    );
    const messages = prepared.messages as JsonRecord[];
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.match(String(messages[0].content), /不可信的记忆数据/);
    assert.match(String(messages[0].content), /不喜欢内置演示数据/);
    assert.match(
      String(messages[0].content),
      /不要为了读取、验证或补全这些记忆而调用/u,
    );
    assert.doesNotMatch(
      String(messages[0].content),
      /memory_id|version_id|来源摘要/u,
    );
    assert.doesNotMatch(
      String(messages[0].content),
      new RegExp(remembered.id, 'u'),
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      0,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'extract_turn'`,
        )
        .get()?.count,
      0,
    );

    fixture.lifecycle.afterTurn(
      request,
      completion('首次启动应保持空数据。'),
      'request-1',
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      2,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'extract_turn'`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT event_type
           FROM outbox_events
           WHERE aggregate_type = 'turn'`,
        )
        .get()?.event_type,
      'turn.completed',
    );
    fixture.lifecycleStore.dispatchNextOutbox('dispatcher-1');
    fixture.lifecycleStore.dispatchNextOutbox('dispatcher-1');
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'extract_turn'`,
        )
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'materialize_episode'`,
        )
        .get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('AIRI 注入当前版本的证据数量、时间和有界用户原文', async () => {
  const fixture = createFixture();
  try {
    const exchange = fixture.lifecycleStore.recordCompletedExchange({
      userId: 'default',
      namespace: 'personal',
      clientName: 'airi-proof-test',
      sessionExternalId: 'proof-history-session',
      userTurnExternalId: 'proof-history-user',
      userContent: '我起床后会先喝一杯温水。',
      assistantTurnExternalId: 'proof-history-assistant',
      assistantContent: '收到。',
      occurredAt: '2026-08-11T07:00:00.000Z',
    });
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户起床后先喝温水。',
      stableKey: 'default::habit::morning-water',
      predicateKey: '用户::稳定生活习惯',
      normalizedValue: '起床后先喝温水',
      normalizedValueHash: 'default-habit-morning-water',
      predicateCardinality: 'set',
      evidenceTurnId: exchange.userTurn.id,
      evidenceExcerpt: exchange.userTurn.content,
      sourceAuthority: 'direct_user',
    }).memory;
    const prepared = await fixture.lifecycle.beforeModel({
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '我起床后先做什么？' }],
    }, 'proof-context-request');
    const messages = prepared.messages as JsonRecord[];
    const context = String(messages[0].content);
    assert.match(context, /独立用户证据 1 条/u);
    assert.match(context, /2026-08-11T07:00:00.000Z/u);
    assert.match(context, /用户原文证据: 我起床后会先喝一杯温水。/u);
    assert.doesNotMatch(context, /memory_id|version_id/u);
    assert.doesNotMatch(context, new RegExp(memory.id, 'u'));
  } finally {
    fixture.lifecycle.cancelTurn('proof-context-request');
    fixture.close();
  }
});

test('AIRI 把情景标为过往对话且不把助手回答放入已验证事实门禁', async () => {
  const fixture = createFixture();
  const episode = fixture.memoryStore.remember({
    kind: 'event',
    source: 'conversation_episode',
    sourceAuthority: 'assistant_inference',
    content:
      '情景记录（不是已验证的用户事实）\n' +
      '用户说：我最近在了解咖啡。\n' +
      '助手回答：你最喜欢的是拿铁。',
  }).memory;
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      return {
        query: input.query,
        memories: [{
          memory: episode,
          score: 0.9,
          reasons: ['test'],
          explanation: {
            lexicalRank: 1,
            annRank: null,
            termRank: null,
            graphRank: null,
            semanticSimilarity: 1,
            rerankConfidence: 1,
            feedbackPrior: 0,
            importance: episode.importance,
            memoryConfidence: episode.confidence,
            recency: 1,
            status: episode.status,
            conflictState: 'none',
            diversityPenalty: 0,
          },
        }],
        context: episode.content,
        qualityState: 'full',
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    fixture.memoryStore,
    fixture.lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
  );
  try {
    const prepared = await lifecycle.beforeModel({
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '我以前聊过什么咖啡？' }],
    }, 'episode-context');
    const system = String((prepared.messages as JsonRecord[])[0].content);
    assert.match(system, /过往对话情景/u);
    assert.match(system, /不等于已验证的用户事实/u);
    assert.doesNotMatch(system, /已验证事实 1/u);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        prepared,
        '_airiMemoryGroundedFacts',
      ),
      false,
    );
  } finally {
    lifecycle.cancelTurn('episode-context');
    fixture.close();
  }
});

test('召回 unavailable 且零结果时仍向 AIRI 注入明确质量状态', async () => {
  const fixture = createFixture();
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      return {
        query: input.query,
        memories: [],
        context: '长期记忆语义服务当前不可用，本轮未注入记忆。',
        qualityState: 'unavailable',
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    fixture.memoryStore,
    fixture.lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
  );
  const request = {
    model: 'qwen2.5:14b',
    messages: [{ role: 'user', content: '我以前提过什么偏好？' }],
  };
  try {
    const prepared = await lifecycle.beforeModel(
      request,
      'unavailable-recall',
    );
    const messages = prepared.messages as JsonRecord[];
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.match(String(messages[0].content), /unavailable/u);
    assert.match(
      String(messages[0].content),
      /未注入任何长期记忆/u,
    );
    assert.match(
      String(messages[0].content),
      /不能据此断言.*没有相关记忆/u,
    );
    assert.deepEqual(request.messages, [
      { role: 'user', content: '我以前提过什么偏好？' },
    ]);
  } finally {
    lifecycle.cancelTurn('unavailable-recall');
    fixture.close();
  }
});

test('无会话 ID 时，同首句的两个独立聊天不会合并', async () => {
  const fixture = createFixture();
  try {
    const request = {
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '你好' }],
    };
    await fixture.lifecycle.beforeModel(request, 'chat-a');
    fixture.lifecycle.afterTurn(
      request,
      completion('你好，有什么可以帮你？'),
      'chat-a',
    );
    await fixture.lifecycle.beforeModel(request, 'chat-b');
    fixture.lifecycle.afterTurn(
      request,
      completion('你好，有什么可以帮你？'),
      'chat-b',
    );

    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_sessions')
        .get()?.count,
      2,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      4,
    );
  } finally {
    fixture.close();
  }
});

test('AIRI 传输时间戳不会污染召回、证据或会话 lineage', async () => {
  const fixture = createFixture();
  try {
    const first = {
      model: 'qwen2.5:14b',
      messages: [
        {
          role: 'user',
          content:
            '[2026-07-31 06:48] 我做新软件时第一次打开必须是空数据。',
        },
      ],
    };
    await fixture.lifecycle.beforeModel(first, 'timestamp-first');
    fixture.lifecycle.afterTurn(
      first,
      completion('了解，这是你的长期原则。'),
      'timestamp-first',
    );

    const persisted = fixture.database
      .prepare(
        `SELECT content
         FROM conversation_turns
         WHERE role = 'user'`,
      )
      .get();
    assert.equal(
      persisted?.content,
      '我做新软件时第一次打开必须是空数据。',
    );

    const second = {
      model: 'qwen2.5:14b',
      messages: [
        {
          role: 'user',
          content:
            '[2026-07-31 06:48] 我做新软件时第一次打开必须是空数据。',
        },
        {
          role: 'assistant',
          content:
            '[2026-07-31 06:49] 了解，这是你的长期原则。',
        },
        {
          role: 'user',
          content: '[2026-07-31 06:50] 继续聊交付节奏。',
        },
      ],
    };
    await fixture.lifecycle.beforeModel(second, 'timestamp-second');
    fixture.lifecycle.afterTurn(
      second,
      completion('可以，我们继续。'),
      'timestamp-second',
    );

    assert.equal(
      fixture.database
        .prepare(
          'SELECT COUNT(*) AS count FROM conversation_sessions',
        )
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT content
           FROM conversation_turns
           WHERE role = 'user'
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get()?.content,
      '继续聊交付节奏。',
    );
  } finally {
    fixture.close();
  }
});

test('AIRI 会话账本保留用户与助手原始 Unicode 标点', async () => {
  const fixture = createFixture();
  try {
    const userContent =
      '项目原则变了：首次打开不再要求空数据，改为导入示例。';
    const assistantContent =
      '收到：以后会导入示例，不再保持空数据。';
    const request = {
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: userContent }],
    };

    await fixture.lifecycle.beforeModel(request, 'raw-unicode');
    fixture.lifecycle.afterTurn(
      request,
      completion(assistantContent),
      'raw-unicode',
    );

    const turns = fixture.database
      .prepare(
        `SELECT role, content
         FROM conversation_turns
         ORDER BY role DESC`,
      )
      .all();
    assert.equal(turns[0]?.role, 'user');
    assert.equal(turns[0]?.content, userContent);
    assert.equal(turns[1]?.role, 'assistant');
    assert.equal(turns[1]?.content, assistantContent);
  } finally {
    fixture.close();
  }
});

test('完整历史续聊复用会话，已经延伸的旧分支不会复用原会话', async () => {
  const fixture = createFixture();
  try {
    const first = {
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '第一轮' }],
    };
    await fixture.lifecycle.beforeModel(first, 'first');
    fixture.lifecycle.afterTurn(first, completion('第一答'), 'first');

    const second = {
      model: 'qwen2.5:14b',
      messages: [
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '第二轮' },
      ],
    };
    await fixture.lifecycle.beforeModel(second, 'second');
    fixture.lifecycle.afterTurn(second, completion('第二答'), 'second');
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_sessions')
        .get()?.count,
      1,
    );

    const fork = {
      model: 'qwen2.5:14b',
      messages: [
        { role: 'user', content: '第一轮' },
        { role: 'assistant', content: '第一答' },
        { role: 'user', content: '分支问题' },
      ],
    };
    await fixture.lifecycle.beforeModel(fork, 'fork');
    fixture.lifecycle.afterTurn(fork, completion('分支回答'), 'fork');
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_sessions')
        .get()?.count,
      2,
    );
  } finally {
    fixture.close();
  }
});

test('工具循环仅在最终文本后落账，工具正文只保存哈希', async () => {
  const fixture = createFixture();
  try {
    const initial = {
      model: 'qwen2.5:14b',
      messages: [
        {
          role: 'user',
          content: '查一下项目状态。',
        },
      ],
    };
    await fixture.lifecycle.beforeModel(initial, 'tool-request');
    fixture.lifecycle.afterTurn(
      initial,
      toolCompletion(
        'call-1',
        'project_status',
        '{"token":"raw-argument-secret"}',
      ),
      'tool-request',
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      0,
    );

    const final = {
      model: 'qwen2.5:14b',
      messages: [
        { role: 'user', content: '查一下项目状态。' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: {
                name: 'project_status',
                arguments: '{"token":"raw-argument-secret"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          content: '{"secret":"raw-result-secret","status":"ok"}',
        },
      ],
    };
    await fixture.lifecycle.beforeModel(final, 'final-request');
    fixture.lifecycle.afterTurn(
      final,
      completion('项目状态正常。'),
      'final-request',
    );

    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT role
           FROM conversation_turns
           ORDER BY created_at ASC, role DESC`,
        )
        .all()
        .map((row) => row.role),
      ['user', 'assistant'],
    );
    const event = fixture.database
      .prepare('SELECT * FROM turn_tool_events')
      .get();
    assert.equal(event?.call_id, 'call-1');
    assert.equal(event?.tool_name, 'project_status');
    assert.equal(event?.result_status, 'completed');
    const serialized = JSON.stringify(event);
    assert.doesNotMatch(serialized, /raw-argument-secret/);
    assert.doesNotMatch(serialized, /raw-result-secret/);
  } finally {
    fixture.close();
  }
});

test('取消、空回复和凭据内容不会形成可提取的原始账本', async () => {
  const fixture = createFixture();
  try {
    const cancelled = {
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '这个请求会中断' }],
    };
    await fixture.lifecycle.beforeModel(cancelled, 'cancelled');
    fixture.lifecycle.cancelTurn('cancelled');
    fixture.lifecycle.afterTurn(
      cancelled,
      completion('不应落账'),
      'cancelled',
    );

    const empty = {
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '空回复请求' }],
    };
    await fixture.lifecycle.beforeModel(empty, 'empty');
    fixture.lifecycle.afterTurn(empty, completion(''), 'empty');
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      0,
    );

    const credential = {
      model: 'qwen2.5:14b',
      conversation_id: 'credential-session',
      messages: [
        {
          role: 'user',
          content: '我的 API Key 是 raw-user-secret。',
        },
      ],
    };
    await fixture.lifecycle.beforeModel(credential, 'credential');
    fixture.lifecycle.afterTurn(
      credential,
      completion('我不会保存你的 API Key raw-user-secret。'),
      'credential',
    );
    const rows = fixture.database
      .prepare(
        `SELECT content, metadata_json
         FROM conversation_turns
         ORDER BY role DESC`,
      )
      .all();
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every((row) => row.content === REDACTED_CREDENTIAL_TURN),
    );
    assert.ok(
      rows.every((row) => /credentialRedacted/.test(
        String(row.metadata_json),
      )),
    );
    assert.doesNotMatch(JSON.stringify(rows), /raw-user-secret/);
  } finally {
    fixture.close();
  }
});

test('AIRI 取消请求会立即且幂等释放前台模型租约', async () => {
  resetModelQosForTests();
  const fixture = createFixture();
  try {
    const request = {
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '这个请求会被取消' }],
    };
    await fixture.lifecycle.beforeModel(request, 'cancel-qos');
    assert.equal(modelQosSnapshot().foregroundCount, 1);

    fixture.lifecycle.cancelTurn('cancel-qos');
    fixture.lifecycle.cancelTurn('cancel-qos');
    assert.equal(modelQosSnapshot().foregroundCount, 0);
  } finally {
    fixture.close();
    resetModelQosForTests();
  }
});

test('显式会话的完成回放保持幂等', async () => {
  const fixture = createFixture();
  try {
    const request = {
      model: 'qwen2.5:14b',
      session_id: 'stable-session',
      messages: [{ role: 'user', content: '我主要用 VS Code。' }],
    };
    for (const requestId of ['attempt-1', 'attempt-2']) {
      await fixture.lifecycle.beforeModel(request, requestId);
      fixture.lifecycle.afterTurn(
        request,
        completion('了解。'),
        requestId,
      );
    }
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_sessions')
        .get()?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      2,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM memory_jobs')
        .get()?.count,
      0,
    );
    fixture.lifecycleStore.dispatchNextOutbox('dispatcher-replay');
    for (const jobType of ['extract_turn', 'materialize_episode']) {
      assert.equal(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count FROM memory_jobs
             WHERE job_type = ?`,
          )
          .get(jobType)?.count,
        1,
      );
    }
  } finally {
    fixture.close();
  }
});

test('降级身份只召回 personal/self 且不会形成任何生命周期写入', async () => {
  const fixture = createFixture();
  let captured: RecallInput | null = null;
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      captured = input;
      return {
        query: input.query,
        memories: [],
        context: '没有找到与当前问题相关的长期记忆。',
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    fixture.memoryStore,
    fixture.lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
  );
  const request = {
    model: 'qwen2.5:14b',
    session_id: 'untrusted-body-session',
    messages: [{ role: 'user', content: '记住我的新偏好。' }],
  };
  const degraded = completeIdentity({
    personaId: null,
    sessionId: null,
    roundId: null,
    identityStatus: 'degraded',
  });
  try {
    await lifecycle.beforeModel(request, 'degraded-request', degraded);
    lifecycle.afterTurn(
      request,
      completion('好的。'),
      'degraded-request',
      degraded,
    );
    assert.deepEqual(captured?.scopes, [
      { scopeType: 'personal', scopeKey: 'self' },
    ]);
    for (const table of [
      'conversation_sessions',
      'conversation_turns',
      'outbox_events',
      'memory_action_requests',
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

test('完整身份使用可信 project/session/round 联合召回并固化项目绑定', async () => {
  const fixture = createFixture();
  const captured: RecallInput[] = [];
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      captured.push(input);
      return {
        query: input.query,
        memories: [],
        context: '没有找到与当前问题相关的长期记忆。',
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    fixture.memoryStore,
    fixture.lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
  );
  const request = {
    model: 'qwen2.5:14b',
    session_id: 'body-spoofed-session',
    messages: [{ role: 'user', content: '这一轮使用可信身份。' }],
  };
  const identity = completeIdentity({ projectId: 'project-A' });
  try {
    await lifecycle.beforeModel(request, 'complete-1', identity);
    lifecycle.afterTurn(
      request,
      completion('已完成。'),
      'complete-1',
      identity,
    );
    assert.deepEqual(captured[0]?.scopes, [
      { scopeType: 'personal', scopeKey: 'self' },
      { scopeType: 'role', scopeKey: 'persona-A' },
      { scopeType: 'session', scopeKey: 'chat-A1' },
      { scopeType: 'project', scopeKey: 'project-A' },
    ]);
    const session = fixture.database
      .prepare(
        `SELECT external_id, persona_id, project_id, identity_source,
                identity_status
         FROM conversation_sessions`,
      )
      .get();
    assert.equal(session?.external_id, 'chat-A1');
    assert.equal(session?.persona_id, 'persona-A');
    assert.equal(session?.project_id, 'project-A');
    assert.equal(session?.identity_source, 'credential');
    assert.equal(session?.identity_status, 'complete');
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT role, round_id
           FROM conversation_turns
           ORDER BY role DESC`,
        )
        .all()
        .map((row) => [row.role, row.round_id]),
      [
        ['user', 'round-1'],
        ['assistant', 'round-1'],
      ],
    );
    const userMetadata = JSON.parse(String(
      fixture.database
        .prepare(
          `SELECT metadata_json
           FROM conversation_turns
           WHERE role = 'user'`,
        )
        .get()?.metadata_json,
    ));
    assert.equal(userMetadata.trustedProjectId, 'project-A');

    await lifecycle.beforeModel(request, 'complete-replay', identity);
    lifecycle.afterTurn(
      request,
      completion('已完成。'),
      'complete-replay',
      identity,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      2,
    );

    await lifecycle.beforeModel(
      request,
      'project-context-switch',
      identity,
    );
    assert.throws(
      () => lifecycle.afterTurn(
        request,
        completion('不应落账。'),
        'project-context-switch',
        completeIdentity({ projectId: 'project-B' }),
      ),
      /身份上下文在请求期间发生变化/,
    );

    const changedPersona = completeIdentity({
      personaId: 'persona-B',
      roundId: 'round-2',
      projectId: 'project-A',
    });
    const recallCountBeforeConflict = captured.length;
    await assert.rejects(
      lifecycle.beforeModel(
        request,
        'persona-switch',
        changedPersona,
      ),
      /不能切换 persona/,
    );
    assert.equal(captured.length, recallCountBeforeConflict);
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      2,
    );
  } finally {
    fixture.close();
  }
});

test('AIRI 稳定 persona 绑定按账户隔离且同名角色可以跨账户复用', async () => {
  const fixture = createFixture();
  const identityService = new IdentityService(fixture.database);
  identityService.createPrincipal({
    id: 'alice',
    displayName: 'Alice',
  });
  identityService.createPrincipal({
    id: 'bob',
    displayName: 'Bob',
  });
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      return {
        query: input.query,
        memories: [],
        context: '没有找到与当前问题相关的长期记忆。',
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    fixture.memoryStore,
    fixture.lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
    identityService,
  );
  const request = {
    model: 'qwen2.5:14b',
    messages: [
      { role: 'system', content: '你是星璃，温柔、耐心的陪伴型角色。' },
      { role: 'user', content: '测试 persona 绑定。' },
    ],
  };
  const alice = completeIdentity({
    trustedPrincipal: identityService.trustPrincipal('alice'),
  });
  try {
    await lifecycle.beforeModel(request, 'bind-alice', alice);
    lifecycle.cancelTurn('bind-alice');
    const binding = fixture.database
      .prepare(
        `SELECT principal_id, client_type, client_instance_id,
                persona_id, display_name
         FROM client_persona_bindings`,
      )
      .get();
    assert.equal(binding?.principal_id, 'alice');
    assert.equal(binding?.client_type, 'lifecycle');
    assert.equal(binding?.client_instance_id, 'local-lifecycle-v1');
    assert.equal(binding?.persona_id, 'persona-A');
    assert.equal(binding?.display_name, '星璃');

    await lifecycle.beforeModel(
      {
        model: 'qwen2.5:14b',
        messages: [{ role: 'user', content: '不带 system 的后续请求。' }],
      },
      'bind-alice-without-system',
      alice,
    );
    lifecycle.cancelTurn('bind-alice-without-system');
    assert.equal(
      fixture.database
        .prepare(
          `SELECT display_name
           FROM client_persona_bindings
           WHERE principal_id = 'alice'`,
        )
        .get()?.display_name,
      '星璃',
    );

    const bob = completeIdentity({
      principalId: 'bob',
      credentialId: 'credential-bob',
      roundId: 'round-bob',
      trustedPrincipal: identityService.trustPrincipal('bob'),
    });
    await lifecycle.beforeModel(request, 'bind-bob', bob);
    lifecycle.cancelTurn('bind-bob');
    const bindings = fixture.database
      .prepare(
        `SELECT principal_id, client_type, client_instance_id,
                persona_id, display_name
         FROM client_persona_bindings
         ORDER BY principal_id`,
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(bindings, [
      {
        principal_id: 'alice',
        client_type: 'lifecycle',
        client_instance_id: 'local-lifecycle-v1',
        persona_id: 'persona-A',
        display_name: '星璃',
      },
      {
        principal_id: 'bob',
        client_type: 'lifecycle',
        client_instance_id: 'local-lifecycle-v1',
        persona_id: 'persona-A',
        display_name: '星璃',
      },
    ]);
  } finally {
    fixture.close();
  }
});
