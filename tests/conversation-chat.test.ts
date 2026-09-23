import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConversationChatEngine,
  ConversationChatProviderError,
  OllamaConversationChatProvider,
  type ConversationChatProvider,
} from '../src/server/conversation-chat.js';
import {
  ConversationService,
  type ConversationTenant,
} from '../src/server/conversation-service.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';
const tenant: ConversationTenant = {
  principalId: 'alice',
  namespace: 'chat',
};

function createFixture(provider: ConversationChatProvider) {
  const database = openDatabase(':memory:');
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  const principal = identity.trustPrincipal('alice');
  identity.bindPersona(principal, {
    clientType: 'airi',
    clientInstanceId: 'conversation-chat-test',
    personaId: PERSONA_ID,
    displayName: '星璃',
  });
  const service = new ConversationService(database, {
    instanceId: 'conversation-chat-test-worker',
  });
  service.putChatProfile(tenant, PERSONA_ID, {
    expectedVersion: 0,
    displayName: '星璃',
    systemPrompt: '只给出可靠回答。',
    greeting: '你好。',
    language: 'zh-Hans',
    capabilityIds: ['emotion.basic'],
  });
  const conversation = service.createConversation(tenant, {
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    personaId: PERSONA_ID,
    projectId: null,
    title: 'Chat Engine 测试',
  });
  const audit: Array<Record<string, unknown>> = [];
  const engine = new ConversationChatEngine(service, {
    model: 'qwen2.5:14b',
    provider,
    heartbeatMs: 100,
    reconcileMs: 1_000,
    audit: (event) => audit.push({ ...event }),
  });
  const accepted = service.acceptRound(tenant, conversation.id, {
    clientMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    text: '请回答这个问题。',
    attachments: [],
    requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  });
  return {
    database,
    service,
    conversation,
    engine,
    accepted,
    audit,
    close() {
      engine.close();
      database.close();
    },
  };
}

test('ConversationChatEngine 使用单消息权威上下文并通过 fake provider 完成', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const provider: ConversationChatProvider = {
    async generate(input, _signal, onDelta) {
      calls.push({
        model: input.model,
        requestId: input.requestId,
        messages: input.messages,
      });
      await onDelta?.('这是第一句。<|A');
      await onDelta?.('CT {"emotion":"calm"}|>这是第二句。');
      return '这是第一句。<|ACT {"emotion":"calm"}|>这是第二句。';
    },
  };
  const fixture = createFixture(provider);
  try {
    await fixture.engine.start(
      tenant,
      fixture.conversation.id,
      fixture.accepted.round.id,
      { credentialId: null, authSource: 'test' },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.model, 'qwen2.5:14b');
    const messages = calls[0]?.messages as Array<{
      role: string;
      content: string;
    }>;
    assert.deepEqual(messages.map((message) => message.role), [
      'system',
      'user',
    ]);
    assert.equal(messages[1]?.content, '请回答这个问题。');
    const round = fixture.service.getRound(
      tenant,
      fixture.conversation.id,
      fixture.accepted.round.id,
    );
    assert.equal(round.status, 'completed');
    assert.equal(
      round.assistantMessage?.displayContent,
      '这是第一句。这是第二句。',
    );
    assert.deepEqual(round.assistantMessage?.actions.map((action) =>
      action.payload.name,
    ), ['calm']);
    const deltas = fixture.service.listRoundEvents(
      tenant,
      fixture.conversation.id,
      fixture.accepted.round.id,
    ).filter((event) => event.type === 'assistant.delta');
    assert.deepEqual(
      deltas.map((event) => event.data.delta),
      ['这是第一句。', '这是第二句。'],
    );
    assert.deepEqual(fixture.audit.map((event) => event.action), [
      'started',
      'completed',
    ]);
    const persistedAudit = fixture.database.prepare(
      `SELECT action, detail_json FROM audit_log
       WHERE user_id = 'alice' AND action LIKE 'conversation_chat_%'
       ORDER BY id ASC`,
    ).all();
    assert.deepEqual(
      persistedAudit.map((row) => row.action),
      ['conversation_chat_started', 'conversation_chat_completed'],
    );
    const completedAudit = JSON.parse(
      String(persistedAudit[1]?.detail_json),
    ) as Record<string, unknown>;
    assert.equal(completedAudit.conversationId, fixture.conversation.id);
    assert.equal(completedAudit.model, 'qwen2.5:14b');
    assert.equal(typeof completedAudit.firstTokenMs, 'number');
    assert.equal(typeof completedAudit.providerDurationMs, 'number');
    assert.equal(
      JSON.stringify(persistedAudit).includes('这是第一句'),
      false,
    );
  } finally {
    fixture.close();
  }
});

test('流式协议后段畸形时保留安全 partial 并以 failed 终止', async () => {
  const provider: ConversationChatProvider = {
    async generate(_input, _signal, onDelta) {
      await onDelta?.('这句可以安全展示。');
      await onDelta?.('<|ACT {bad}|>');
      return '这句可以安全展示。<|ACT {bad}|>';
    },
  };
  const fixture = createFixture(provider);
  try {
    await fixture.engine.start(
      tenant,
      fixture.conversation.id,
      fixture.accepted.round.id,
      { credentialId: null, authSource: 'test' },
    );
    const round = fixture.service.getRound(
      tenant,
      fixture.conversation.id,
      fixture.accepted.round.id,
    );
    assert.equal(round.status, 'failed');
    assert.equal(round.failure?.code, 'ASSISTANT_PROTOCOL_INVALID');
    assert.equal(round.assistantMessage, null);
    const events = fixture.service.listRoundEvents(
      tenant,
      fixture.conversation.id,
      fixture.accepted.round.id,
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === 'assistant.delta')
        .map((event) => event.data.delta),
      ['这句可以安全展示。'],
    );
    assert.equal(events.at(-1)?.type, 'turn.failed');
    assert.equal(
      JSON.stringify(events).includes('<|ACT'),
      false,
    );
  } finally {
    fixture.close();
  }
});

test('ConversationChatEngine 将 provider 故障收敛为可查询 failed round', async () => {
  const provider: ConversationChatProvider = {
    async generate() {
      throw new ConversationChatProviderError('PROVIDER_TIMEOUT', true);
    },
  };
  const fixture = createFixture(provider);
  try {
    await fixture.engine.start(
      tenant,
      fixture.conversation.id,
      fixture.accepted.round.id,
      { credentialId: null, authSource: 'test' },
    );
    const round = fixture.service.getRound(
      tenant,
      fixture.conversation.id,
      fixture.accepted.round.id,
    );
    assert.equal(round.status, 'failed');
    assert.equal(round.failure?.code, 'MODEL_UNAVAILABLE');
    assert.equal(round.failure?.retryable, true);
    assert.equal(round.assistantMessage, null);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE event_type = 'turn.completed'`,
      ).get()?.count,
      0,
    );
    assert.deepEqual(fixture.audit.map((event) => event.action), [
      'started',
      'failed',
    ]);
  } finally {
    fixture.close();
  }
});

test('Ollama JSON 响应没有助手正文时显式报 PROVIDER_EMPTY_RESPONSE', async () => {
  const provider = new OllamaConversationChatProvider({
    baseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 1_000,
    fetchImpl: async () => new Response(
      JSON.stringify({ message: { content: '' }, done: true }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  });
  await assert.rejects(
    () => provider.generate(
      {
        model: 'qwen2.5:14b',
        messages: [{ role: 'user', content: '你好' }],
        requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
      new AbortController().signal,
    ),
    (error) =>
      error instanceof ConversationChatProviderError &&
      error.code === 'PROVIDER_EMPTY_RESPONSE',
  );
});

test('Ollama NDJSON 将 provider 增量逐块交给安全流式层', async () => {
  const encoder = new TextEncoder();
  const provider = new OllamaConversationChatProvider({
    baseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 1_000,
    fetchImpl: async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            '{"message":{"content":"第一句。"},"done":false}\n',
          ));
          controller.enqueue(encoder.encode(
            '{"message":{"content":"第二句。"},"done":true}\n',
          ));
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/x-ndjson' },
      },
    ),
  });
  const deltas: string[] = [];
  const content = await provider.generate(
    {
      model: 'qwen2.5:14b',
      messages: [{ role: 'user', content: '你好' }],
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    },
    new AbortController().signal,
    (delta) => deltas.push(delta),
  );
  assert.equal(content, '第一句。第二句。');
  assert.deepEqual(deltas, ['第一句。', '第二句。']);
});
