import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConversationService,
  ConversationServiceError,
  type ConversationTenant,
} from '../src/server/conversation-service.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';
const tenant: ConversationTenant = {
  principalId: 'alice',
  namespace: 'chat',
};

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) =>
    error instanceof ConversationServiceError && error.code === code,
  );
}

function createFixture() {
  const database = openDatabase(':memory:');
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  const principal = identity.trustPrincipal('alice');
  identity.bindPersona(principal, {
    clientType: 'airi',
    clientInstanceId: 'conversation-round-test',
    personaId: PERSONA_ID,
    displayName: '星璃',
  });
  let now = new Date('2026-08-12T00:00:00.000Z');
  const service = new ConversationService(database, {
    now: () => now,
    instanceId: 'conversation-round-test-worker',
    roundLeaseMs: 1_000,
  });
  service.putChatProfile(tenant, PERSONA_ID, {
    expectedVersion: 0,
    displayName: '星璃',
    systemPrompt: '你是可靠、简洁的本地助手。',
    greeting: '晚上好。',
    language: 'zh-Hans',
    capabilityIds: ['emotion.basic'],
  });
  const conversation = service.createConversation(tenant, {
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    personaId: PERSONA_ID,
    projectId: null,
    title: 'Round 测试',
  });
  return {
    database,
    service,
    conversation,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

function roundInput() {
  return {
    clientMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    text: '你还记得我喜欢喝什么吗？',
    attachments: [] as const,
    clientSentAt: '2026-08-12T00:00:00.000Z',
    requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  };
}

test('Round 接受原子落账，20 次同载荷重放不复制消息或执行', () => {
  const fixture = createFixture();
  try {
    const accepted = fixture.service.acceptRound(
      tenant,
      fixture.conversation.id,
      roundInput(),
    );
    assert.equal(accepted.shouldExecute, true);
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.round.status, 'accepted');
    assert.equal(accepted.round.personaProfileVersionUsed, 1);

    for (let index = 0; index < 20; index += 1) {
      const replay = fixture.service.acceptRound(
        tenant,
        fixture.conversation.id,
        roundInput(),
      );
      assert.equal(replay.round.id, accepted.round.id);
      assert.equal(replay.shouldExecute, false);
      assert.equal(replay.replayed, true);
    }

    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_rounds`,
      ).get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_round_attempts`,
      ).get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_turns
         WHERE session_id = ? AND role = 'user'`,
      ).get(fixture.conversation.id)?.count,
      1,
    );
    assert.deepEqual(
      fixture.service.listRoundEvents(
        tenant,
        fixture.conversation.id,
        accepted.round.id,
      ).map((event) => event.type),
      ['turn.accepted'],
    );

    expectCode(
      () => fixture.service.acceptRound(
        tenant,
        fixture.conversation.id,
        { ...roundInput(), text: '同一个 ID 的不同正文' },
      ),
      'IDEMPOTENCY_CONFLICT',
    );
    expectCode(
      () => fixture.service.acceptRound(
        tenant,
        fixture.conversation.id,
        {
          ...roundInput(),
          clientMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        },
      ),
      'ROUND_IN_PROGRESS',
    );
  } finally {
    fixture.database.close();
  }
});

test('Round 完成原子写入清洗正文、动作、outbox 和可恢复事件', () => {
  const fixture = createFixture();
  try {
    const accepted = fixture.service.acceptRound(
      tenant,
      fixture.conversation.id,
      roundInput(),
    );
    fixture.service.putChatProfile(tenant, PERSONA_ID, {
      expectedVersion: 1,
      displayName: '星璃 v2',
      systemPrompt: '这是更新后的角色设定。',
      greeting: '你好。',
      language: 'zh-Hans',
      capabilityIds: ['emotion.basic'],
    });
    const latest = fixture.service.getConversation(
      tenant,
      fixture.conversation.id,
    );
    fixture.service.updateConversation(tenant, fixture.conversation.id, {
      expectedVersion: latest.version,
      personaProfileVersion: 2,
    });

    const execution = fixture.service.beginRoundExecution(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    );
    assert.equal(execution.profile.profileVersion, 1);
    assert.equal(execution.messages[0]?.content, '你是可靠、简洁的本地助手。');
    assert.equal(
      fixture.service.advanceRoundStage(
        tenant,
        fixture.conversation.id,
        accepted.round.id,
        'recalling',
      ),
      true,
    );
    assert.equal(
      fixture.service.advanceRoundStage(
        tenant,
        fixture.conversation.id,
        accepted.round.id,
        'generating',
      ),
      true,
    );
    const completed = fixture.service.completeRound(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
      '我记得你喜欢桂花乌龙。<|ACT {"emotion":"happy"}|>',
    );
    assert.ok(completed);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.assistantMessage?.displayContent, '我记得你喜欢桂花乌龙。');
    assert.deepEqual(completed.assistantMessage?.actions.map((action) => ({
      type: action.type,
      payload: action.payload,
    })), [
      { type: 'emotion', payload: { name: 'happy' } },
    ]);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE aggregate_id = ? AND event_type = 'turn.completed'`,
      ).get(accepted.round.userMessage.id)?.count,
      1,
    );

    const events = fixture.service.listRoundEvents(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    );
    assert.deepEqual(events.map((event) => event.type), [
      'turn.accepted',
      'turn.stage',
      'turn.stage',
      'turn.stage',
      'assistant.delta',
      'assistant.action',
      'turn.completed',
    ]);
    assert.equal(
      events.filter((event) => event.type === 'assistant.delta')
        .map((event) => String(event.data.delta ?? ''))
        .join(''),
      completed.assistantMessage?.displayContent,
    );
    assert.deepEqual(
      fixture.service.listRoundEvents(
        tenant,
        fixture.conversation.id,
        accepted.round.id,
        { afterEventId: events[2]?.id },
      ).map((event) => event.sequence),
      [4, 5, 6, 7],
    );
    expectCode(
      () => fixture.service.listRoundEvents(
        tenant,
        fixture.conversation.id,
        accepted.round.id,
        { afterEventId: `${accepted.round.id}:99` },
      ),
      'INVALID_EVENT_CURSOR',
    );
  } finally {
    fixture.database.close();
  }
});

test('租约过期收敛为 interrupted，原请求重试复用用户消息并新建 attempt', () => {
  const fixture = createFixture();
  try {
    const accepted = fixture.service.acceptRound(
      tenant,
      fixture.conversation.id,
      roundInput(),
    );
    fixture.service.beginRoundExecution(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    );
    fixture.setNow('2026-08-12T00:00:02.000Z');
    assert.equal(fixture.service.reconcileExpiredRounds(), 1);
    const interrupted = fixture.service.getRound(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    );
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.failure?.code, 'ROUND_LEASE_EXPIRED');

    const retried = fixture.service.acceptRound(
      tenant,
      fixture.conversation.id,
      { ...roundInput(), requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    );
    assert.equal(retried.round.id, accepted.round.id);
    assert.equal(retried.round.userMessage.id, accepted.round.userMessage.id);
    assert.equal(retried.round.generation, 2);
    assert.equal(retried.round.currentAttempt?.attemptNumber, 2);
    assert.equal(retried.round.currentAttempt?.type, 'retry');
    assert.equal(retried.shouldExecute, true);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_turns
         WHERE session_id = ? AND role = 'user'`,
      ).get(fixture.conversation.id)?.count,
      1,
    );
    const eventSequences = fixture.service.listRoundEvents(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    ).map((event) => event.sequence);
    assert.deepEqual(eventSequences, [1, 2, 3, 4]);
  } finally {
    fixture.database.close();
  }
});
