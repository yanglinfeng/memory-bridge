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

function createFixture() {
  const database = openDatabase(':memory:');
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identity.bindPersona(identity.trustPrincipal('alice'), {
    clientType: 'airi',
    clientInstanceId: 'conversation-regenerate-test',
    personaId: PERSONA_ID,
    displayName: '星璃',
  });
  let currentTime = '2026-08-12T00:00:00.000Z';
  const service = new ConversationService(database, {
    now: () => new Date(currentTime),
    instanceId: 'conversation-regenerate-worker',
    roundLeaseMs: 1_000,
  });
  service.putChatProfile(tenant, PERSONA_ID, {
    expectedVersion: 0,
    displayName: '星璃',
    systemPrompt: '你是可靠的本地助手。',
    greeting: '',
    language: 'zh-Hans',
    capabilityIds: [],
  });
  const conversation = service.createConversation(tenant, {
    idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    personaId: PERSONA_ID,
    projectId: null,
    title: '重新生成测试',
  });
  return {
    database,
    service,
    conversation,
    setTime(value: string) {
      currentTime = value;
    },
  };
}

function completeRound(
  fixture: ReturnType<typeof createFixture>,
  clientMessageId: string,
  text: string,
  answer: string,
) {
  const accepted = fixture.service.acceptRound(
    tenant,
    fixture.conversation.id,
    { clientMessageId, text, attachments: [] },
  );
  fixture.service.beginRoundExecution(
    tenant,
    fixture.conversation.id,
    accepted.round.id,
  );
  const completed = fixture.service.completeRound(
    tenant,
    fixture.conversation.id,
    accepted.round.id,
    answer,
  );
  assert.ok(completed?.assistantMessage);
  return completed;
}

test('regenerate 幂等创建新变体，成功后才原子切换 active', () => {
  const fixture = createFixture();
  try {
    const original = completeRound(
      fixture,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '今天喝什么？',
      '旧回复',
    );
    const source = original.assistantMessage!;
    const input = {
      clientRequestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      sourceAssistantMessageId: source.id,
    };
    const accepted = fixture.service.regenerate(
      tenant,
      fixture.conversation.id,
      input,
    );
    assert.equal(accepted.shouldExecute, true);
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.round.currentAttempt?.type, 'regenerate');
    assert.equal(
      fixture.service.listMessages(tenant, fixture.conversation.id)
        .items.at(-1)?.id,
      source.id,
    );

    for (let index = 0; index < 20; index += 1) {
      const replay = fixture.service.regenerate(
        tenant,
        fixture.conversation.id,
        input,
      );
      assert.equal(replay.round.currentAttempt?.id, accepted.round.currentAttempt?.id);
      assert.equal(replay.shouldExecute, false);
      assert.equal(replay.replayed, true);
    }

    fixture.service.beginRoundExecution(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    );
    const regenerated = fixture.service.completeRound(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
      '新回复',
    );
    assert.ok(regenerated?.assistantMessage);
    const replacement = regenerated.assistantMessage!;
    assert.equal(replacement.displayContent, '新回复');
    assert.equal(replacement.generationGroupId, source.generationGroupId);
    assert.equal(replacement.variantIndex, 2);
    assert.equal(replacement.isActiveVariant, true);

    const rows = fixture.database
      .prepare(
        `SELECT id, variant_index, is_active_variant, message_version
         FROM conversation_turns
         WHERE round_id = ? AND role = 'assistant'
         ORDER BY variant_index ASC`,
      )
      .all(original.id);
    assert.deepEqual(
      rows.map((row) => ({
        id: String(row.id),
        variantIndex: Number(row.variant_index),
        active: Number(row.is_active_variant),
        version: Number(row.message_version),
      })),
      [
        { id: source.id, variantIndex: 1, active: 0, version: 2 },
        { id: replacement.id, variantIndex: 2, active: 1, version: 1 },
      ],
    );
    assert.deepEqual(
      fixture.service.listMessages(tenant, fixture.conversation.id)
        .items.map((message) => message.displayContent),
      ['今天喝什么？', '新回复'],
    );
    assert.equal(
      fixture.service.getConversation(tenant, fixture.conversation.id)
        .messageCount,
      2,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE aggregate_id = ? AND event_type = 'turn.completed'`,
      ).get(original.userMessage.id)?.count,
      1,
    );
    assert.equal(
      fixture.service.listChanges(tenant).items
        .some((change) => change.type === 'message.active_variant'),
      true,
    );
  } finally {
    fixture.database.close();
  }
});

test('regenerate 失败保留旧 active，且只允许最新 completed round', () => {
  const fixture = createFixture();
  try {
    const first = completeRound(
      fixture,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '第一问',
      '第一答',
    );
    const accepted = fixture.service.regenerate(
      tenant,
      fixture.conversation.id,
      {
        clientRequestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        sourceAssistantMessageId: first.assistantMessage!.id,
      },
    );
    fixture.service.beginRoundExecution(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    );
    assert.equal(
      fixture.service.failRound(
        tenant,
        fixture.conversation.id,
        accepted.round.id,
        {
          code: 'MODEL_FAILED',
          message: 'fake provider failure',
          retryable: true,
          stage: 'generating',
        },
      ),
      true,
    );
    const afterFailure = fixture.service.getRound(
      tenant,
      fixture.conversation.id,
      first.id,
    );
    assert.equal(afterFailure.status, 'completed');
    assert.equal(afterFailure.assistantMessage?.id, first.assistantMessage?.id);

    const second = completeRound(
      fixture,
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '第二问',
      '第二答',
    );
    assert.throws(
      () => fixture.service.regenerate(
        tenant,
        fixture.conversation.id,
        {
          clientRequestId: '99999999-9999-4999-8999-999999999999',
          sourceAssistantMessageId: first.assistantMessage!.id,
        },
      ),
      (error) =>
        error instanceof ConversationServiceError &&
        error.code === 'REGENERATION_NOT_LATEST',
    );
    assert.equal(second.assistantMessage?.displayContent, '第二答');
  } finally {
    fixture.database.close();
  }
});

test('regenerate 租约过期收敛 attempt，但 Round 保持旧 completed 结果', () => {
  const fixture = createFixture();
  try {
    const original = completeRound(
      fixture,
      '12121212-1212-4212-8212-121212121212',
      '需要稳定恢复',
      '原始可用回复',
    );
    const accepted = fixture.service.regenerate(
      tenant,
      fixture.conversation.id,
      {
        clientRequestId: '13131313-1313-4313-8313-131313131313',
        sourceAssistantMessageId: original.assistantMessage!.id,
      },
    );
    fixture.service.beginRoundExecution(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    );
    fixture.setTime('2026-08-12T00:00:02.000Z');
    assert.equal(fixture.service.reconcileExpiredRounds(), 1);
    const recovered = fixture.service.getRound(
      tenant,
      fixture.conversation.id,
      accepted.round.id,
    );
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.currentAttempt?.status, 'interrupted');
    assert.equal(
      recovered.assistantMessage?.id,
      original.assistantMessage?.id,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT status FROM conversation_regeneration_requests
         WHERE attempt_id = ?`,
      ).get(accepted.round.currentAttempt!.id)?.status,
      'interrupted',
    );
  } finally {
    fixture.database.close();
  }
});
