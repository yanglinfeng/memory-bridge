import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConversationService } from '../src/server/conversation-service.js';
import { openDatabase } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { IdentityService } from '../src/server/identity.js';
import { MemoryStore } from '../src/server/memory-store.js';

const ALICE_PERSONA = '11111111-1111-4111-8111-111111111111';
const BOB_PERSONA = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const HTTP_NAMESPACE = 'personal';

function tokenHeaders(
  token: string,
  json = false,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

async function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-conversation-http-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
  const alicePrincipal = identity.trustPrincipal('alice');
  const bobPrincipal = identity.trustPrincipal('bob');
  identity.bindPersona(alicePrincipal, {
    clientType: 'airi',
    clientInstanceId: 'alice-http',
    personaId: ALICE_PERSONA,
    displayName: '星璃',
  });
  identity.bindPersona(bobPrincipal, {
    clientType: 'airi',
    clientInstanceId: 'bob-http',
    personaId: BOB_PERSONA,
    displayName: '小北',
  });
  const alice = identity.issueCredential({
    principalId: 'alice',
    label: 'Alice HTTP test',
  });
  const bob = identity.issueCredential({
    principalId: 'bob',
    label: 'Bob HTTP test',
  });
  const conversations = new ConversationService(database);
  conversations.putChatProfile(
    { principalId: 'alice', namespace: HTTP_NAMESPACE },
    ALICE_PERSONA,
    profile('星璃', 0),
  );
  conversations.putChatProfile(
    { principalId: 'bob', namespace: HTTP_NAMESPACE },
    BOB_PERSONA,
    profile('小北', 0),
  );
  const server = createHttpServer(new MemoryStore(database), {
    identityService: identity,
    conversationService: conversations,
    conversationNamespace: HTTP_NAMESPACE,
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
    database,
    conversations,
    baseUrl: `http://127.0.0.1:${address.port}`,
    aliceToken: alice.token,
    bobToken: bob.token,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function profile(displayName: string, expectedVersion = 1) {
  return {
    expectedVersion,
    displayName,
    systemPrompt: `${displayName} 的安全角色设定`,
    greeting: `${displayName}：晚上好。`,
    language: 'zh-Hans',
    capabilityIds: ['emotion.basic'],
  };
}

test('角色档案与项目绑定 HTTP 契约使用可信 principal 并统一隐藏越权资源', async () => {
  const fixture = await createFixture();
  try {
    const putProfile = await fetch(
      `${fixture.baseUrl}/api/personas/${ALICE_PERSONA}/chat-profile`,
      {
        method: 'PUT',
        headers: tokenHeaders(fixture.aliceToken, true),
        body: JSON.stringify(profile('星璃 v2')),
      },
    );
    assert.equal(putProfile.status, 200);
    const savedProfile = await json<{
      profileVersion: number;
      displayName: string;
    }>(putProfile);
    assert.equal(savedProfile.profileVersion, 2);
    assert.equal(savedProfile.displayName, '星璃 v2');

    const getProfile = await fetch(
      `${fixture.baseUrl}/api/personas/${ALICE_PERSONA}/chat-profile?version=1`,
      { headers: tokenHeaders(fixture.aliceToken) },
    );
    assert.equal(getProfile.status, 200);
    assert.equal(
      (await json<{ profileVersion: number }>(getProfile)).profileVersion,
      1,
    );

    const hidden = await fetch(
      `${fixture.baseUrl}/api/personas/${ALICE_PERSONA}/chat-profile`,
      { headers: tokenHeaders(fixture.bobToken) },
    );
    assert.equal(hidden.status, 404);
    const hiddenError = await json<{
      code: string;
      retryable: boolean;
      requestId: string;
    }>(hidden);
    assert.equal(hiddenError.code, 'PERSONA_NOT_FOUND');
    assert.equal(hiddenError.retryable, false);
    assert.match(hiddenError.requestId, /^[0-9a-f-]{36}$/u);

    const putProject = await fetch(
      `${fixture.baseUrl}/api/projects/${PROJECT_ID}/binding`,
      {
        method: 'PUT',
        headers: tokenHeaders(fixture.aliceToken, true),
        body: JSON.stringify({
          expectedVersion: 0,
          displayName: '本地记忆产品',
        }),
      },
    );
    assert.equal(putProject.status, 200);
    assert.equal(
      (await json<{ projectId: string }>(putProject)).projectId,
      PROJECT_ID,
    );
    const projects = await fetch(`${fixture.baseUrl}/api/projects`, {
      headers: tokenHeaders(fixture.aliceToken),
    });
    assert.equal(projects.status, 200);
    assert.deepEqual(
      (await json<{ items: Array<{ projectId: string }> }>(projects))
        .items.map((item) => item.projectId),
      [PROJECT_ID],
    );
  } finally {
    await fixture.close();
  }
});

test('conversation CRUD、幂等、版本和列表 cursor 通过 HTTP 保持租户隔离', async () => {
  const fixture = await createFixture();
  try {
    await fetch(`${fixture.baseUrl}/api/projects/${PROJECT_ID}/binding`, {
      method: 'PUT',
      headers: tokenHeaders(fixture.aliceToken, true),
      body: JSON.stringify({
        expectedVersion: 0,
        displayName: '本地记忆产品',
      }),
    });
    const idempotencyKey = randomUUID();
    const createBody = {
      idempotencyKey,
      personaId: ALICE_PERSONA,
      projectId: PROJECT_ID,
      title: '第一次聊天',
    };
    const createdResponse = await fetch(
      `${fixture.baseUrl}/api/conversations`,
      {
        method: 'POST',
        headers: tokenHeaders(fixture.aliceToken, true),
        body: JSON.stringify(createBody),
      },
    );
    assert.equal(createdResponse.status, 201);
    const created = await json<{
      id: string;
      title: string;
      version: number;
    }>(createdResponse);
    assert.equal(created.title, '第一次聊天');

    const replay = await fetch(`${fixture.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: tokenHeaders(fixture.aliceToken, true),
      body: JSON.stringify(createBody),
    });
    assert.equal(replay.status, 201);
    assert.equal((await json<{ id: string }>(replay)).id, created.id);

    const conflict = await fetch(`${fixture.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: tokenHeaders(fixture.aliceToken, true),
      body: JSON.stringify({ ...createBody, title: '冲突标题' }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      (await json<{ code: string }>(conflict)).code,
      'IDEMPOTENCY_CONFLICT',
    );

    const bobCannotBorrowProject = await fetch(
      `${fixture.baseUrl}/api/conversations`,
      {
        method: 'POST',
        headers: tokenHeaders(fixture.bobToken, true),
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          personaId: BOB_PERSONA,
          projectId: PROJECT_ID,
          title: '越权项目',
        }),
      },
    );
    assert.equal(bobCannotBorrowProject.status, 404);
    assert.equal(
      (await json<{ code: string }>(bobCannotBorrowProject)).code,
      'PROJECT_NOT_FOUND',
    );

    const detail = await fetch(
      `${fixture.baseUrl}/api/conversations/${created.id}`,
      { headers: tokenHeaders(fixture.aliceToken) },
    );
    assert.equal(detail.status, 200);
    const updated = await fetch(
      `${fixture.baseUrl}/api/conversations/${created.id}`,
      {
        method: 'PATCH',
        headers: tokenHeaders(fixture.aliceToken, true),
        body: JSON.stringify({
          expectedVersion: created.version,
          title: '归档聊天',
          status: 'archived',
        }),
      },
    );
    assert.equal(updated.status, 200);
    const updatedConversation = await json<{
      status: string;
      version: number;
    }>(updated);
    assert.equal(updatedConversation.status, 'archived');

    const list = await fetch(
      `${fixture.baseUrl}/api/conversations?status=archived&limit=1`,
      { headers: tokenHeaders(fixture.aliceToken) },
    );
    assert.equal(list.status, 200);
    const page = await json<{
      items: Array<{ id: string }>;
      syncCursor: string;
    }>(list);
    assert.deepEqual(page.items.map((item) => item.id), [created.id]);
    assert.equal(typeof page.syncCursor, 'string');

    const noChanges = await fetch(
      `${fixture.baseUrl}/api/conversations/changes?cursor=` +
        encodeURIComponent(page.syncCursor),
      { headers: tokenHeaders(fixture.aliceToken) },
    );
    assert.equal(noChanges.status, 200);
    assert.deepEqual(
      (await json<{ items: unknown[] }>(noChanges)).items,
      [],
    );

    const reactivated = await fetch(
      `${fixture.baseUrl}/api/conversations/${created.id}`,
      {
        method: 'PATCH',
        headers: tokenHeaders(fixture.aliceToken, true),
        body: JSON.stringify({
          expectedVersion: updatedConversation.version,
          status: 'active',
        }),
      },
    );
    assert.equal(reactivated.status, 200);
    const changes = await fetch(
      `${fixture.baseUrl}/api/conversations/changes?cursor=` +
        encodeURIComponent(page.syncCursor),
      { headers: tokenHeaders(fixture.aliceToken) },
    );
    assert.equal(changes.status, 200);
    const changePage = await json<{
      items: Array<{
        type: string;
        resource: { status: string };
      }>;
    }>(changes);
    assert.deepEqual(
      changePage.items.map((item) => [item.type, item.resource.status]),
      [['conversation.upsert', 'active']],
    );

    const bobCursorReuse = await fetch(
      `${fixture.baseUrl}/api/conversations/changes?cursor=` +
        encodeURIComponent(page.syncCursor),
      { headers: tokenHeaders(fixture.bobToken) },
    );
    assert.equal(bobCursorReuse.status, 400);
    assert.equal(
      (await json<{ code: string }>(bobCursorReuse)).code,
      'INVALID_CURSOR',
    );

    const bobHidden = await fetch(
      `${fixture.baseUrl}/api/conversations/${created.id}`,
      { headers: tokenHeaders(fixture.bobToken) },
    );
    assert.equal(bobHidden.status, 404);
    assert.equal(
      (await json<{ code: string }>(bobHidden)).code,
      'CONVERSATION_NOT_FOUND',
    );
  } finally {
    await fixture.close();
  }
});

test('消息分页 HTTP 不泄露 normalized content，拒绝 cursor 错配和身份覆盖', async () => {
  const fixture = await createFixture();
  try {
    const conversation = fixture.conversations.createConversation(
      { principalId: 'alice', namespace: HTTP_NAMESPACE },
      {
        idempotencyKey: randomUUID(),
        personaId: ALICE_PERSONA,
        projectId: null,
        title: '消息恢复',
      },
    );
    fixture.conversations.appendMessage(
      { principalId: 'alice', namespace: HTTP_NAMESPACE },
      conversation.id,
      {
        clientMessageId: randomUUID(),
        role: 'user',
        content: '  用户原话  ',
        normalizedContent: '用户原话',
      },
    );
    fixture.conversations.appendMessage(
      { principalId: 'alice', namespace: HTTP_NAMESPACE },
      conversation.id,
      {
        clientMessageId: randomUUID(),
        role: 'assistant',
        content: '好的。<|ACT {"emotion":"happy"}|>',
      },
    );

    const response = await fetch(
      `${fixture.baseUrl}/api/conversations/${conversation.id}/messages?limit=1`,
      { headers: tokenHeaders(fixture.aliceToken) },
    );
    assert.equal(response.status, 200);
    const page = await json<{
      items: Array<Record<string, unknown>>;
      nextCursor: string;
    }>(response);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0]?.displayContent, '好的。');
    assert.equal('normalizedContent' in page.items[0]!, false);

    const bobCursorReuse = await fetch(
      `${fixture.baseUrl}/api/conversations/${conversation.id}/messages` +
        `?before=${encodeURIComponent(page.nextCursor)}`,
      { headers: tokenHeaders(fixture.bobToken) },
    );
    assert.equal(bobCursorReuse.status, 404);

    const override = await fetch(
      `${fixture.baseUrl}/api/conversations`,
      {
        method: 'POST',
        headers: tokenHeaders(fixture.aliceToken, true),
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          personaId: ALICE_PERSONA,
          projectId: null,
          principalId: 'bob',
        }),
      },
    );
    assert.equal(override.status, 400);
    assert.equal(
      (await json<{ code: string }>(override)).code,
      'FORBIDDEN_IDENTITY_OVERRIDE',
    );

    const queryOverride = await fetch(
      `${fixture.baseUrl}/api/conversations?namespace=other`,
      { headers: tokenHeaders(fixture.aliceToken) },
    );
    assert.equal(queryOverride.status, 400);
    assert.equal(
      (await json<{ code: string }>(queryOverride)).code,
      'FORBIDDEN_IDENTITY_OVERRIDE',
    );
  } finally {
    await fixture.close();
  }
});
