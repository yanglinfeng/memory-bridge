import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AssistantProtocolQuarantineError,
  REDACTED_ASSISTANT_CREDENTIAL,
} from '../src/server/assistant-protocol.js';
import {
  ConversationService,
  ConversationServiceError,
  type ConversationTenant,
} from '../src/server/conversation-service.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';

const ALICE_PERSONA = '11111111-1111-4111-8111-111111111111';
const BOB_PERSONA = '22222222-2222-4222-8222-222222222222';
const ALICE_PROJECT = '33333333-3333-4333-8333-333333333333';
const UNPROFILED_PERSONA = '44444444-4444-4444-8444-444444444444';

const aliceScope: ConversationTenant = {
  principalId: 'alice',
  namespace: 'chat',
};
const bobScope: ConversationTenant = {
  principalId: 'bob',
  namespace: 'chat',
};

function expectServiceCode(
  action: () => unknown,
  code: string,
): void {
  assert.throws(action, (error) => {
    assert.equal(error instanceof ConversationServiceError, true);
    return error instanceof ConversationServiceError && error.code === code;
  });
}

function profileInput(
  expectedVersion: number,
  displayName: string,
) {
  return {
    expectedVersion,
    displayName,
    systemPrompt: `${displayName} 的安全角色设定`,
    greeting: `${displayName}：晚上好。`,
    language: 'zh-Hans',
    capabilityIds: ['emotion.basic'],
  };
}

function createFixture(filePath = ':memory:') {
  const database = openDatabase(filePath);
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
  const alice = identity.trustPrincipal('alice');
  const bob = identity.trustPrincipal('bob');
  identity.bindPersona(alice, {
    clientType: 'airi',
    clientInstanceId: 'alice-desktop',
    personaId: ALICE_PERSONA,
    displayName: '星璃',
  });
  identity.bindPersona(bob, {
    clientType: 'airi',
    clientInstanceId: 'bob-desktop',
    personaId: BOB_PERSONA,
    displayName: '小北',
  });
  let now = new Date('2026-08-12T00:01:00.000Z');
  const service = new ConversationService(database, {
    now: () => now,
  });
  service.putChatProfile(
    aliceScope,
    ALICE_PERSONA,
    profileInput(0, '星璃'),
  );
  service.putChatProfile(
    bobScope,
    BOB_PERSONA,
    profileInput(0, '小北'),
  );
  service.bindProject(aliceScope, ALICE_PROJECT, {
    expectedVersion: 0,
    displayName: '忆桥项目',
  });
  return {
    database,
    identity,
    alice,
    service,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

test('chat profile 追加版本快照且 persona 所有权 fail closed', () => {
  const { database, service } = createFixture();
  try {
    const version1 = service.getChatProfile(aliceScope, ALICE_PERSONA);
    assert.equal(version1.profileVersion, 1);
    assert.deepEqual(version1.availableVersions, [
      {
        profileVersion: 1,
        updatedAt: '2026-08-12T00:01:00.000Z',
      },
    ]);
    const oldConversation = service.createConversation(aliceScope, {
      idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      personaId: ALICE_PERSONA,
      projectId: null,
      title: '旧档案会话',
    });

    const version2 = service.putChatProfile(
      aliceScope,
      ALICE_PERSONA,
      profileInput(1, '星璃 v2'),
    );
    assert.equal(version2.profileVersion, 2);
    assert.equal(
      service.getConversation(aliceScope, oldConversation.id)
        .personaProfileVersion,
      1,
    );
    const newConversation = service.createConversation(aliceScope, {
      idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      personaId: ALICE_PERSONA,
      projectId: null,
      title: '新档案会话',
    });
    assert.equal(newConversation.personaProfileVersion, 2);

    expectServiceCode(
      () =>
        service.putChatProfile(
          bobScope,
          ALICE_PERSONA,
          profileInput(0, '越权'),
        ),
      'PERSONA_NOT_FOUND',
    );
    expectServiceCode(
      () => service.getChatProfile(bobScope, ALICE_PERSONA),
      'PERSONA_NOT_FOUND',
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE persona_chat_profiles
             SET display_name = '覆盖历史'
             WHERE principal_id = 'alice'
               AND persona_id = ? AND profile_version = 1`,
          )
          .run(ALICE_PERSONA),
      /profile snapshot is immutable/iu,
    );
  } finally {
    database.close();
  }
});

test('ProjectBinding 使用乐观版本并严格隔离 principal/namespace', () => {
  const { database, service } = createFixture();
  try {
    assert.deepEqual(
      service.listProjects(aliceScope).map((project) => ({
        projectId: project.projectId,
        displayName: project.displayName,
        version: project.version,
      })),
      [
        {
          projectId: ALICE_PROJECT,
          displayName: '忆桥项目',
          version: 1,
        },
      ],
    );
    assert.deepEqual(service.listProjects(bobScope), []);
    const updated = service.bindProject(aliceScope, ALICE_PROJECT, {
      expectedVersion: 1,
      displayName: '忆桥项目 v2',
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.displayName, '忆桥项目 v2');
    expectServiceCode(
      () =>
        service.bindProject(aliceScope, ALICE_PROJECT, {
          expectedVersion: 1,
          displayName: '过期写入',
        }),
      'VERSION_CONFLICT',
    );
  } finally {
    database.close();
  }
});

test('已绑定 persona 没有 profile 时拒绝创建 conversation', () => {
  const { database, identity, alice, service } = createFixture();
  try {
    identity.bindPersona(alice, {
      clientType: 'airi',
      clientInstanceId: 'alice-secondary',
      personaId: UNPROFILED_PERSONA,
      displayName: '未建档角色',
    });
    expectServiceCode(
      () =>
        service.createConversation(aliceScope, {
          idempotencyKey: '45454545-4545-4545-8545-454545454545',
          personaId: UNPROFILED_PERSONA,
          projectId: null,
          title: null,
        }),
      'PERSONA_PROFILE_NOT_FOUND',
    );
  } finally {
    database.close();
  }
});

test('conversation 创建幂等、绑定不可变且严格隔离 principal/project', () => {
  const { database, service } = createFixture();
  try {
    const input = {
      idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      personaId: ALICE_PERSONA,
      projectId: ALICE_PROJECT,
      title: '项目夜聊',
    };
    const created = service.createConversation(aliceScope, input);
    assert.deepEqual(service.createConversation(aliceScope, input), created);
    expectServiceCode(
      () =>
        service.createConversation(aliceScope, {
          ...input,
          title: '同键不同载荷',
        }),
      'IDEMPOTENCY_CONFLICT',
    );
    expectServiceCode(
      () => service.getConversation(bobScope, created.id),
      'CONVERSATION_NOT_FOUND',
    );
    expectServiceCode(
      () =>
        service.createConversation(bobScope, {
          idempotencyKey: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          personaId: BOB_PERSONA,
          projectId: ALICE_PROJECT,
          title: null,
        }),
      'PROJECT_NOT_FOUND',
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE conversation_sessions SET project_id = NULL
             WHERE id = ?`,
          )
          .run(created.id),
      /identity is immutable/iu,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `UPDATE conversation_sessions
             SET persona_profile_version = 999
             WHERE id = ?`,
          )
          .run(created.id),
      /profile snapshot mismatch/iu,
    );

    expectServiceCode(
      () =>
        service.updateConversation(aliceScope, created.id, {
          expectedVersion: created.version + 1,
          title: '错误版本',
        }),
      'VERSION_CONFLICT',
    );
    const archived = service.updateConversation(aliceScope, created.id, {
      expectedVersion: created.version,
      title: '归档后的项目夜聊',
      status: 'archived',
    });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.title, '归档后的项目夜聊');
  } finally {
    database.close();
  }
});

test('conversation cursor 绑定 tenant/filter，错配与畸形输入 fail closed', () => {
  const { database, service, setNow } = createFixture();
  try {
    const olderConversation = service.createConversation(aliceScope, {
      idempotencyKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      personaId: ALICE_PERSONA,
      projectId: null,
      title: '较早会话',
    });
    setNow('2026-08-12T00:02:00.000Z');
    service.createConversation(aliceScope, {
      idempotencyKey: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      personaId: ALICE_PERSONA,
      projectId: null,
      title: '较新会话',
    });
    const first = service.listConversations(aliceScope, { limit: 1 });
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0]?.title, '较新会话');
    assert.equal(first.hasMore, true);
    assert.equal(typeof first.nextCursor, 'string');
    const cursor = first.nextCursor;
    if (!cursor) assert.fail('expected conversation cursor');
    const second = service.listConversations(aliceScope, {
      limit: 1,
      cursor,
    });
    assert.equal(second.items[0]?.title, '较早会话');
    service.rotateCursorKey();
    assert.equal(
      service.listConversations(aliceScope, { limit: 1, cursor })
        .items[0]?.title,
      '较早会话',
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT status, length(secret) AS bytes
           FROM conversation_cursor_keys ORDER BY key_version ASC`,
        )
        .all()
        .map((row) => ({ status: row.status, bytes: row.bytes })),
      [
        { status: 'previous', bytes: 32 },
        { status: 'current', bytes: 32 },
      ],
    );
    expectServiceCode(
      () =>
        service.listConversations(bobScope, {
          limit: 1,
          cursor,
        }),
      'INVALID_CURSOR',
    );
    expectServiceCode(
      () =>
        service.listConversations(aliceScope, {
          limit: 1,
          status: 'archived',
          cursor,
        }),
      'INVALID_CURSOR',
    );
    expectServiceCode(
      () =>
        service.listMessages(aliceScope, olderConversation.id, {
          before: cursor,
        }),
      'INVALID_CURSOR',
    );
    const separator = cursor.lastIndexOf('.');
    const mac = cursor.slice(separator + 1);
    const tampered =
      cursor.slice(0, separator + 1) +
      (mac[0] === 'A' ? 'B' : 'A') +
      mac.slice(1);
    expectServiceCode(
      () => service.listConversations(aliceScope, { cursor: tampered }),
      'INVALID_CURSOR',
    );
    expectServiceCode(
      () =>
        service.listConversations(aliceScope, {
          cursor: 'not-a-valid-cursor',
        }),
      'INVALID_CURSOR',
    );
    setNow('2026-08-13T00:02:01.000Z');
    expectServiceCode(
      () => service.listConversations(aliceScope, { cursor }),
      'INVALID_CURSOR',
    );
  } finally {
    database.close();
  }
});

test('message 在入库前清洗、单调排序、幂等并稳定分页', () => {
  const { database, service } = createFixture();
  try {
    const conversation = service.createConversation(aliceScope, {
      idempotencyKey: '12121212-1212-4212-8212-121212121212',
      personaId: ALICE_PERSONA,
      projectId: null,
      title: '消息测试',
    });
    const user = service.appendMessage(aliceScope, conversation.id, {
      clientMessageId: '13131313-1313-4313-8313-131313131313',
      role: 'user',
      content: '  用户原话保持不变。  ',
      normalizedContent: '用户原话保持不变。',
    });
    assert.equal(user.sequence, 1);
    assert.equal(user.displayContent, '  用户原话保持不变。  ');
    assert.deepEqual(user.actions, []);
    const assistantInput = {
      clientMessageId: '14141414-1414-4414-8414-141414141414',
      role: 'assistant' as const,
      content: '当然记得。<|ACT {"emotion":"happy"}|>',
    };
    const assistant = service.appendMessage(
      aliceScope,
      conversation.id,
      assistantInput,
    );
    assert.equal(assistant.sequence, 2);
    assert.equal(assistant.displayContent, '当然记得。');
    assert.deepEqual(
      assistant.actions.map((action) => ({
        type: action.type,
        payload: action.payload,
      })),
      [{ type: 'emotion', payload: { name: 'happy' } }],
    );
    assert.deepEqual(
      service.appendMessage(
        aliceScope,
        conversation.id,
        assistantInput,
      ),
      assistant,
    );
    const lifecycleOutbox = database.prepare(
      `SELECT aggregate_id, payload_json
       FROM outbox_events
       WHERE aggregate_type = 'turn' AND event_type = 'turn.completed'`,
    ).all() as Array<Record<string, unknown>>;
    assert.equal(lifecycleOutbox.length, 1);
    assert.equal(lifecycleOutbox[0]?.aggregate_id, user.id);
    assert.deepEqual(
      JSON.parse(String(lifecycleOutbox[0]?.payload_json)),
      { userTurnId: user.id, assistantTurnId: assistant.id },
    );
    expectServiceCode(
      () =>
        service.appendMessage(aliceScope, conversation.id, {
          ...assistantInput,
          content: '同一 ID 的不同正文',
        }),
      'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () =>
        service.appendMessage(aliceScope, conversation.id, {
          clientMessageId: '15151515-1515-4515-8515-151515151515',
          role: 'assistant',
          content: '<|ACT {"type":"unknown"}|>',
        }),
      AssistantProtocolQuarantineError,
    );
    assert.throws(
      () =>
        service.appendMessage(aliceScope, conversation.id, {
          clientMessageId: '19191919-1919-4919-8919-191919191919',
          role: 'assistant',
          content: '<|ACT {"motion":"wave"}|>',
        }),
      (error) =>
        error instanceof AssistantProtocolQuarantineError &&
        error.code === 'unauthorized_action',
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM conversation_turns
           WHERE session_id = ?`,
        )
        .get(conversation.id)?.count,
      2,
    );
    const storedAssistant = database
      .prepare(
        `SELECT content, display_content FROM conversation_turns
         WHERE id = ?`,
      )
      .get(assistant.id);
    assert.equal(storedAssistant?.content, '当然记得。');
    assert.equal(storedAssistant?.display_content, '当然记得。');

    const latestPage = service.listMessages(aliceScope, conversation.id, {
      limit: 1,
    });
    assert.deepEqual(
      latestPage.items.map((message) => message.sequence),
      [2],
    );
    assert.equal(latestPage.hasMore, true);
    service.appendMessage(aliceScope, conversation.id, {
      clientMessageId: '16161616-1616-4616-8616-161616161616',
      role: 'user',
      content: '分页期间新增',
    });
    const olderPage = service.listMessages(aliceScope, conversation.id, {
      limit: 1,
      before: latestPage.nextCursor,
    });
    assert.deepEqual(
      olderPage.items.map((message) => message.sequence),
      [1],
    );
    const caughtUp = service.listMessages(aliceScope, conversation.id, {
      afterSequence: 1,
      limit: 10,
    });
    assert.deepEqual(
      caughtUp.items.map((message) => message.sequence),
      [2, 3],
    );
    expectServiceCode(
      () =>
        service.listMessages(aliceScope, conversation.id, {
          before: latestPage.nextCursor,
          afterSequence: 1,
        }),
      'INVALID_REQUEST',
    );
    expectServiceCode(
      () => service.listMessages(bobScope, conversation.id),
      'CONVERSATION_NOT_FOUND',
    );

    const credentialSentinel =
      'sk-proj-conversation-user-sentinel-1234567890';
    const redactedUser = service.appendMessage(
      aliceScope,
      conversation.id,
      {
        clientMessageId: '20202020-2020-4020-8020-202020202020',
        role: 'user',
        content: `Bearer ${credentialSentinel}`,
        normalizedContent: `token=${credentialSentinel}`,
      },
    );
    assert.equal(
      redactedUser.displayContent,
      REDACTED_ASSISTANT_CREDENTIAL,
    );
    assert.deepEqual(redactedUser.actions, []);
    const storedCredentialTurn = database
      .prepare(
        `SELECT content, display_content, normalized_content,
                content_hash, message_payload_hash, metadata_json
         FROM conversation_turns WHERE id = ?`,
      )
      .get(redactedUser.id);
    assert.equal(
      storedCredentialTurn?.content,
      REDACTED_ASSISTANT_CREDENTIAL,
    );
    assert.equal(
      storedCredentialTurn?.display_content,
      REDACTED_ASSISTANT_CREDENTIAL,
    );
    assert.equal(
      storedCredentialTurn?.normalized_content,
      REDACTED_ASSISTANT_CREDENTIAL,
    );
    for (const rows of [
      database
        .prepare(
          `SELECT content, display_content, normalized_content,
                  content_hash, message_payload_hash, metadata_json
           FROM conversation_turns`,
        )
        .all(),
      database
        .prepare('SELECT payload_json FROM conversation_message_actions')
        .all(),
      database.prepare('SELECT detail_json FROM audit_log').all(),
      database.prepare('SELECT detail_json FROM identity_audit_log').all(),
    ]) {
      assert.equal(JSON.stringify(rows).includes(credentialSentinel), false);
    }
  } finally {
    database.close();
  }
});

test('文件数据库重启后恢复 profile、conversation、message 和分页 cursor', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-conversation-restart-'),
  );
  const filePath = path.join(directory, 'memory.sqlite3');
  try {
    const fixture = createFixture(filePath);
    const conversation = fixture.service.createConversation(aliceScope, {
      idempotencyKey: '17171717-1717-4717-8717-171717171717',
      personaId: ALICE_PERSONA,
      projectId: null,
      title: '重启恢复',
    });
    const messageIds = [
      '18181818-1818-4818-8818-181818181810',
      '18181818-1818-4818-8818-181818181811',
      '18181818-1818-4818-8818-181818181812',
    ];
    for (const [index, content] of ['第一条', '第二条', '第三条'].entries()) {
      fixture.service.appendMessage(aliceScope, conversation.id, {
        clientMessageId: messageIds[index]!,
        role: index === 1 ? 'assistant' : 'user',
        content,
      });
    }
    const firstPage = fixture.service.listMessages(
      aliceScope,
      conversation.id,
      { limit: 1 },
    );
    fixture.database.close();

    const reopened = openDatabase(filePath);
    try {
      const service = new ConversationService(reopened, {
        // This is an immediate-restart contract. Keep the reopened process on
        // the fixture clock so the test does not start failing one day after
        // its fixed 2026-08-12 seed timestamp because the cursor legitimately
        // crossed the production 24-hour TTL.
        now: () => new Date('2026-08-12T00:01:00.000Z'),
      });
      assert.equal(
        service.getChatProfile(aliceScope, ALICE_PERSONA).profileVersion,
        1,
      );
      assert.equal(
        service.getConversation(aliceScope, conversation.id).messageCount,
        3,
      );
      const nextPage = service.listMessages(aliceScope, conversation.id, {
        limit: 2,
        before: firstPage.nextCursor,
      });
      assert.deepEqual(
        nextPage.items.map((message) => message.displayContent),
        ['第一条', '第二条'],
      );
    } finally {
      reopened.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
