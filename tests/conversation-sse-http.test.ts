import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ConversationChatEngine,
  type ConversationChatProvider,
} from '../src/server/conversation-chat.js';
import { ConversationService } from '../src/server/conversation-service.js';
import { openDatabase } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { IdentityService } from '../src/server/identity.js';
import { MemoryStore } from '../src/server/memory-store.js';

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';
const namespace = 'personal';

function parseSse(value: string): Array<{
  id: string;
  type: string;
  data: Record<string, unknown>;
}> {
  return value.trim().split(/\n\n/u).filter((block) =>
    block && !block.startsWith(':'),
  ).map((block) => {
    const lines = block.split('\n');
    const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
    const type = lines.find((line) => line.startsWith('event: '))?.slice(7);
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
    assert.ok(id);
    assert.ok(type);
    assert.ok(data);
    return {
      id,
      type,
      data: JSON.parse(data) as Record<string, unknown>,
    };
  });
}

async function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-conversation-sse-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  const principal = identity.trustPrincipal('alice');
  identity.bindPersona(principal, {
    clientType: 'airi',
    clientInstanceId: 'conversation-sse-test',
    personaId: PERSONA_ID,
    displayName: '星璃',
  });
  const credential = identity.issueCredential({
    principalId: 'alice',
    label: 'Conversation SSE test',
  });
  const service = new ConversationService(database, {
    instanceId: 'conversation-sse-test-worker',
  });
  service.putChatProfile(
    { principalId: 'alice', namespace },
    PERSONA_ID,
    {
      expectedVersion: 0,
      displayName: '星璃',
      systemPrompt: '可靠回答。',
      greeting: '你好。',
      language: 'zh-Hans',
      capabilityIds: ['emotion.basic'],
    },
  );
  const conversation = service.createConversation(
    { principalId: 'alice', namespace },
    {
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      personaId: PERSONA_ID,
      projectId: null,
      title: 'SSE 测试',
    },
  );
  let providerCalls = 0;
  const provider: ConversationChatProvider = {
    async generate() {
      providerCalls += 1;
      return 'SSE 权威回复。<|ACT {"emotion":"happy"}|>';
    },
  };
  const engine = new ConversationChatEngine(service, {
    model: 'qwen2.5:14b',
    provider,
    heartbeatMs: 100,
    reconcileMs: 1_000,
    audit: () => undefined,
  });
  const server = createHttpServer(new MemoryStore(database), {
    identityService: identity,
    conversationService: service,
    conversationChatEngine: engine,
    conversationNamespace: namespace,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('测试 HTTP server 未监听 TCP 端口');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    conversation,
    token: credential.token,
    providerCalls: () => providerCalls,
    async close() {
      engine.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()),
      );
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('POST SSE 完成后可按 Last-Event-ID 重放且幂等重试不再次调用模型', async () => {
  const fixture = await createFixture();
  try {
    const body = {
      clientMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      text: '请通过 SSE 回答。',
      attachments: [],
      clientSentAt: '2026-08-12T00:00:00.000Z',
    };
    const send = () => fetch(
      `${fixture.baseUrl}/api/conversations/${fixture.conversation.id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      },
    );
    const response = await send();
    assert.equal(response.status, 200);
    const events = parseSse(await response.text());
    assert.deepEqual(events.map((event) => event.type), [
      'turn.accepted',
      'turn.stage',
      'turn.stage',
      'turn.stage',
      'assistant.delta',
      'assistant.action',
      'turn.completed',
    ]);
    assert.equal(fixture.providerCalls(), 1);
    const roundId = String(events[0]?.data.roundId);
    assert.match(events[0]?.id ?? '', new RegExp(`^${roundId}:1$`, 'u'));

    const replay = await fetch(
      `${fixture.baseUrl}/api/conversations/${fixture.conversation.id}/rounds/${roundId}/events`,
      {
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          Accept: 'text/event-stream',
          'Last-Event-ID': `${roundId}:4`,
        },
      },
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(parseSse(await replay.text()).map((event) => event.type), [
      'assistant.delta',
      'assistant.action',
      'turn.completed',
    ]);

    const duplicate = await send();
    assert.equal(duplicate.status, 200);
    assert.equal(
      parseSse(await duplicate.text()).at(-1)?.type,
      'turn.completed',
    );
    assert.equal(fixture.providerCalls(), 1);

    const round = await fetch(
      `${fixture.baseUrl}/api/conversations/${fixture.conversation.id}/rounds/${roundId}`,
      { headers: { Authorization: `Bearer ${fixture.token}` } },
    );
    assert.equal(round.status, 200);
    assert.equal((await round.json() as { status: string }).status, 'completed');
  } finally {
    await fixture.close();
  }
});

test('regenerate HTTP 使用同一 Round 新 attempt 并保持请求幂等', async () => {
  const fixture = await createFixture();
  try {
    const sent = await fetch(
      `${fixture.baseUrl}/api/conversations/${fixture.conversation.id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          clientMessageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          text: '请重新生成。',
          attachments: [],
        }),
      },
    );
    const completedEvent = parseSse(await sent.text()).at(-1);
    assert.equal(completedEvent?.type, 'turn.completed');
    const roundId = String(completedEvent?.data.roundId);
    const assistant = completedEvent?.data.assistantMessage as {
      id: string;
    };
    const requestBody = {
      clientRequestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sourceAssistantMessageId: assistant.id,
    };
    const regenerate = () => fetch(
      `${fixture.baseUrl}/api/conversations/${fixture.conversation.id}/regenerate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      },
    );
    const accepted = await regenerate();
    assert.equal(accepted.status, 202);
    const acceptedBody = await accepted.json() as {
      round: { currentAttempt: { id: string; type: string } };
      replayed: boolean;
    };
    assert.equal(acceptedBody.round.currentAttempt.type, 'regenerate');
    assert.equal(acceptedBody.replayed, false);

    let round: {
      status: string;
      currentAttempt: { id: string; status: string };
      assistantMessage: { variantIndex: number };
    } | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const response = await fetch(
        `${fixture.baseUrl}/api/conversations/${fixture.conversation.id}` +
          `/rounds/${roundId}`,
        { headers: { Authorization: `Bearer ${fixture.token}` } },
      );
      round = await response.json() as typeof round;
      if (round?.status === 'completed' &&
          round.currentAttempt.status === 'completed') {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(round?.status, 'completed');
    assert.equal(round?.assistantMessage.variantIndex, 2);
    assert.equal(fixture.providerCalls(), 2);

    const replay = await regenerate();
    assert.equal(replay.status, 202);
    const replayBody = await replay.json() as {
      round: { currentAttempt: { id: string } };
      replayed: boolean;
    };
    assert.equal(replayBody.replayed, true);
    assert.equal(
      replayBody.round.currentAttempt.id,
      acceptedBody.round.currentAttempt.id,
    );
    assert.equal(fixture.providerCalls(), 2);
  } finally {
    await fixture.close();
  }
});
