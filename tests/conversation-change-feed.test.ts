import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConversationService,
  ConversationServiceError,
  type ConversationTenant,
} from '../src/server/conversation-service.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';

const ALICE_PERSONA = '11111111-1111-4111-8111-111111111111';
const BOB_PERSONA = '22222222-2222-4222-8222-222222222222';
const alice: ConversationTenant = { principalId: 'alice', namespace: 'chat' };
const bob: ConversationTenant = { principalId: 'bob', namespace: 'chat' };

function createFixture() {
  const database = openDatabase(':memory:');
  let currentTime = '2026-08-12T00:00:00.000Z';
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
  identity.bindPersona(identity.trustPrincipal('alice'), {
    clientType: 'airi',
    clientInstanceId: 'alice-change-test',
    personaId: ALICE_PERSONA,
    displayName: '星璃',
  });
  identity.bindPersona(identity.trustPrincipal('bob'), {
    clientType: 'airi',
    clientInstanceId: 'bob-change-test',
    personaId: BOB_PERSONA,
    displayName: '小北',
  });
  const service = new ConversationService(database, {
    now: () => new Date(currentTime),
  });
  for (const [scope, personaId, name] of [
    [alice, ALICE_PERSONA, '星璃'],
    [bob, BOB_PERSONA, '小北'],
  ] as const) {
    service.putChatProfile(scope, personaId, {
      expectedVersion: 0,
      displayName: name,
      systemPrompt: '',
      greeting: '',
      language: 'zh-Hans',
      capabilityIds: [],
    });
  }
  return {
    database,
    service,
    setTime(value: string) {
      currentTime = value;
    },
  };
}

test('change feed 分页返回可直接应用的资源并严格隔离 tenant', () => {
  const fixture = createFixture();
  try {
    const conversation = fixture.service.createConversation(alice, {
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      personaId: ALICE_PERSONA,
      projectId: null,
      title: '同步测试',
    });
    const message = fixture.service.appendMessage(
      alice,
      conversation.id,
      {
        clientMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        role: 'user',
        content: '第一条同步消息',
      },
    );
    const current = fixture.service.getConversation(alice, conversation.id);
    fixture.service.updateConversation(alice, conversation.id, {
      expectedVersion: current.version,
      title: '同步测试 v2',
    });

    const first = fixture.service.listChanges(alice, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(typeof first.nextCursor, 'string');
    assert.deepEqual(first.items.map((item) => item.type), [
      'conversation.upsert',
      'message.upsert',
    ]);
    assert.equal(first.items[0]?.conversationId, conversation.id);
    assert.equal(first.items[0]?.resource?.id, conversation.id);
    assert.equal(first.items[1]?.resourceId, message.id);
    assert.equal(first.items[1]?.resource?.displayContent, '第一条同步消息');

    const second = fixture.service.listChanges(alice, {
      cursor: first.nextCursor,
      limit: 2,
    });
    assert.equal(second.items.length, 2);
    assert.equal(second.hasMore, false);
    assert.equal(second.items[0]?.type, 'conversation.upsert');
    assert.equal(second.items[0]?.resource?.messageCount, 1);
    assert.equal(second.items[1]?.type, 'conversation.upsert');
    assert.equal(second.items[1]?.resource?.title, '同步测试 v2');
    assert.equal(typeof second.nextCursor, 'string');
    assert.deepEqual(fixture.service.listChanges(bob).items, []);

    const conversations = fixture.service.listConversations(alice);
    assert.equal(typeof conversations.syncCursor, 'string');
    assert.deepEqual(
      fixture.service.listChanges(alice, {
        cursor: conversations.syncCursor,
      }).items,
      [],
    );

    assert.throws(
      () => fixture.service.listChanges(bob, {
        cursor: second.nextCursor,
      }),
      (error) =>
        error instanceof ConversationServiceError &&
        error.code === 'INVALID_CURSOR',
    );
  } finally {
    fixture.database.close();
  }
});

test('权威 Round 完成时同步发布用户和助手消息资源', () => {
  const fixture = createFixture();
  try {
    const conversation = fixture.service.createConversation(alice, {
      idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      personaId: ALICE_PERSONA,
      projectId: null,
      title: 'Round 同步',
    });
    const accepted = fixture.service.acceptRound(alice, conversation.id, {
      clientMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      text: '请回复我。',
      attachments: [],
    });
    fixture.service.beginRoundExecution(
      alice,
      conversation.id,
      accepted.round.id,
    );
    fixture.service.completeRound(
      alice,
      conversation.id,
      accepted.round.id,
      '已经收到。',
    );

    const changes = fixture.service.listChanges(alice).items;
    assert.deepEqual(changes.map((item) => item.type), [
      'conversation.upsert',
      'message.upsert',
      'conversation.upsert',
      'message.upsert',
      'conversation.upsert',
    ]);
    assert.deepEqual(
      changes
        .filter((item) => item.type === 'message.upsert')
        .map((item) => item.resource?.role),
      ['user', 'assistant'],
    );
    assert.equal(changes[3]?.resource?.displayContent, '已经收到。');
  } finally {
    fixture.database.close();
  }
});

test('change cursor 超过保留期后返回可恢复的专用错误码', () => {
  const fixture = createFixture();
  try {
    const cursor = fixture.service.listChanges(alice).nextCursor;
    assert.equal(typeof cursor, 'string');
    fixture.setTime('2026-09-12T00:00:00.001Z');
    assert.throws(
      () => fixture.service.listChanges(alice, { cursor }),
      (error) =>
        error instanceof ConversationServiceError &&
        error.code === 'SYNC_CURSOR_EXPIRED',
    );
  } finally {
    fixture.database.close();
  }
});
