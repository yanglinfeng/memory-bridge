import assert from 'node:assert/strict';
import test from 'node:test';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import {
  ConversationService,
  ConversationServiceError,
  type ConversationTenant,
} from '../src/server/conversation-service.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';
const BOB_PERSONA_ID = '22222222-2222-4222-8222-222222222222';
const tenant: ConversationTenant = {
  principalId: 'alice',
  namespace: 'chat',
};
const bobTenant: ConversationTenant = {
  principalId: 'bob',
  namespace: 'chat',
};

function createFixture() {
  const database = openDatabase(':memory:');
  let currentTime = '2026-08-12T00:00:00.000Z';
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identity.bindPersona(identity.trustPrincipal('alice'), {
    clientType: 'airi',
    clientInstanceId: 'conversation-import-delete-test',
    personaId: PERSONA_ID,
    displayName: '星璃',
  });
  const service = new ConversationService(database, {
    now: () => new Date(currentTime),
    instanceId: 'conversation-import-delete-worker',
  });
  service.putChatProfile(tenant, PERSONA_ID, {
    expectedVersion: 0,
    displayName: '星璃',
    systemPrompt: '',
    greeting: '',
    language: 'zh-Hans',
    capabilityIds: [],
  });
  return {
    database,
    service,
    setTime(value: string) {
      currentTime = value;
    },
  };
}

async function commitPreference(
  fixture: ReturnType<typeof createFixture>,
  turnId: string,
  sourceExcerpt: string,
): Promise<string> {
  const lifecycle = new LifecycleStore(fixture.database);
  const memoryStore = new MemoryStore(fixture.database);
  const resolver = new CandidateResolver(
    fixture.database,
    lifecycle,
    memoryStore,
    {
      mode: 'auto',
      autoCommitMinConfidence: 0.95,
      autoCommitMinImportance: 0.5,
    },
  );
  const runId = lifecycle.startExtraction(
    turnId,
    'qwen2.5:14b',
    'conversation-delete-test',
  );
  const candidate = lifecycle.completeExtraction(runId, [{
    kind: 'preference',
    subject: '用户',
    predicate: '饮品偏好',
    value: '桂花乌龙',
    content: '用户喜欢桂花乌龙。',
    sourceExcerpt,
    confidence: 0.99,
    importance: 0.8,
  }])[0];
  assert.ok(candidate);
  const resolution = await resolver.resolve(candidate.id);
  assert.equal(resolution.state, 'accepted');
  assert.ok(resolution.memoryId);
  return resolution.memoryId;
}

function importPayload(dryRun: boolean, importId: string) {
  return {
    dryRun,
    importId,
    batchCursor: null,
    isLastBatch: true,
    conversations: [
      {
        externalSessionId: 'client-session-1',
        personaId: PERSONA_ID,
        projectId: null,
        title: '客户端历史',
        messages: [
          {
            externalMessageId: 'client-message-user-1',
            externalRoundId: 'client-round-1',
            role: 'user' as const,
            displayContent: '我喜欢桂花乌龙',
            occurredAt: '2026-08-01T01:00:00.000Z',
          },
          {
            externalMessageId: 'airi-message-assistant-1',
            externalRoundId: 'client-round-1',
            role: 'assistant' as const,
            displayContent: '记住了。',
            occurredAt: '2026-08-01T01:00:01.000Z',
          },
        ],
      },
    ],
  };
}

test('AIRI import dry-run 不写业务数据，commit 幂等形成完整轮次', () => {
  const fixture = createFixture();
  try {
    const dryRun = fixture.service.importConversations(
      tenant,
      importPayload(true, 'airi-import-dry-run'),
    );
    assert.equal(dryRun.stats.created, 3);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_sessions`,
      ).get()?.count),
      0,
    );

    const payload = importPayload(false, 'airi-import-commit');
    const committed = fixture.service.importConversations(tenant, payload);
    assert.equal(committed.stats.created, 3);
    assert.equal(committed.replayed, false);
    const replay = fixture.service.importConversations(tenant, payload);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.stats, committed.stats);

    const conversation = fixture.database.prepare(
      `SELECT * FROM conversation_sessions WHERE external_id = ?`,
    ).get('client-session-1');
    assert.ok(conversation);
    const messages = fixture.service.listMessages(
      tenant,
      String(conversation.id),
    ).items;
    assert.deepEqual(messages.map((message) => message.displayContent), [
      '我喜欢桂花乌龙',
      '记住了。',
    ]);
    const round = fixture.database.prepare(
      `SELECT * FROM conversation_rounds WHERE conversation_id = ?`,
    ).get(String(conversation.id));
    assert.equal(round?.status, 'completed');
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events`,
      ).get()?.count),
      0,
    );
    const metadata = JSON.parse(String(fixture.database.prepare(
      `SELECT metadata_json FROM conversation_turns WHERE role = 'user'`,
    ).get()?.metadata_json)) as Record<string, unknown>;
    assert.equal(metadata.lifecycleSuppressed, true);
    assert.equal(metadata.skipAutoExtraction, true);
  } finally {
    fixture.database.close();
  }
});

test('AIRI import 多批 cursor 与 dry-run/commit lane 相互独立', () => {
  const fixture = createFixture();
  try {
    const firstPayload = importPayload(false, 'airi-import-multi-batch');
    firstPayload.isLastBatch = false;
    const first = fixture.service.importConversations(tenant, firstPayload);
    assert.equal(first.batchIndex, 0);
    assert.equal(first.isLastBatch, false);

    const secondPayload = importPayload(false, 'airi-import-multi-batch');
    secondPayload.conversations[0]!.externalSessionId = 'airi-session-2';
    secondPayload.conversations[0]!.messages[0]!.externalMessageId =
      'airi-message-user-2';
    secondPayload.conversations[0]!.messages[0]!.externalRoundId =
      'airi-round-2';
    secondPayload.conversations[0]!.messages[1]!.externalMessageId =
      'airi-message-assistant-2';
    secondPayload.conversations[0]!.messages[1]!.externalRoundId =
      'airi-round-2';
    const second = fixture.service.importConversations(tenant, {
      ...secondPayload,
      batchCursor: first.batchCursor,
    });
    assert.equal(second.batchIndex, 1);
    assert.equal(second.isLastBatch, true);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_sessions`,
      ).get()?.count),
      2,
    );

    const beforeDryRun = Number(fixture.database.prepare(
      `SELECT COUNT(*) AS count FROM conversation_turns`,
    ).get()?.count);
    const dryRun = fixture.service.importConversations(
      tenant,
      importPayload(true, 'airi-import-multi-batch'),
    );
    assert.equal(dryRun.lane, 'dry_run');
    assert.equal(dryRun.batchIndex, 0);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_turns`,
      ).get()?.count),
      beforeDryRun,
    );
  } finally {
    fixture.database.close();
  }
});

test('AIRI import 拒绝同批异载荷与终批后追加', () => {
  const fixture = createFixture();
  try {
    const importId = 'airi-import-cursor-guards';
    const completed = fixture.service.importConversations(
      tenant,
      importPayload(false, importId),
    );
    const conflict = importPayload(false, importId);
    conflict.conversations[0]!.messages[0]!.displayContent = '载荷已改变';
    assert.throws(
      () => fixture.service.importConversations(tenant, conflict),
      (error) => error instanceof ConversationServiceError &&
        error.code === 'IDEMPOTENCY_CONFLICT',
    );

    const append = importPayload(false, importId);
    append.conversations[0]!.externalSessionId = 'airi-session-after-last';
    assert.throws(
      () => fixture.service.importConversations(tenant, {
        ...append,
        batchCursor: completed.batchCursor,
      }),
      (error) => error instanceof ConversationServiceError &&
        error.code === 'INVALID_CURSOR',
    );
  } finally {
    fixture.database.close();
  }
});

test('AIRI import 所有权错误整批回滚且 cursor 不能跨账户使用', () => {
  const fixture = createFixture();
  try {
    const invalid = importPayload(false, 'airi-import-atomic-rollback');
    invalid.conversations.push({
      externalSessionId: 'airi-session-invalid-owner',
      personaId: '99999999-9999-4999-8999-999999999999',
      projectId: null,
      title: null,
      messages: [{
        externalMessageId: 'airi-message-invalid-owner',
        externalRoundId: 'airi-round-invalid-owner',
        role: 'user',
        displayContent: '这批必须完整回滚',
        occurredAt: '2026-08-01T02:00:00.000Z',
      }],
    });
    assert.throws(
      () => fixture.service.importConversations(tenant, invalid),
      (error) => error instanceof ConversationServiceError &&
        error.code === 'PERSONA_NOT_FOUND',
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_sessions`,
      ).get()?.count),
      0,
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_import_states`,
      ).get()?.count),
      0,
    );

    const identity = new IdentityService(fixture.database);
    identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
    identity.bindPersona(identity.trustPrincipal('bob'), {
      clientType: 'airi',
      clientInstanceId: 'bob-import-test',
      personaId: BOB_PERSONA_ID,
      displayName: '小北',
    });
    fixture.service.putChatProfile(bobTenant, BOB_PERSONA_ID, {
      expectedVersion: 0,
      displayName: '小北',
      systemPrompt: '',
      greeting: '',
      language: 'zh-Hans',
      capabilityIds: [],
    });
    const alicePayload = importPayload(false, 'airi-import-tenant-isolation');
    alicePayload.isLastBatch = false;
    const aliceBatch = fixture.service.importConversations(
      tenant,
      alicePayload,
    );
    const bobPayload = importPayload(false, 'airi-import-tenant-isolation');
    bobPayload.conversations[0]!.personaId = BOB_PERSONA_ID;
    assert.throws(
      () => fixture.service.importConversations(bobTenant, {
        ...bobPayload,
        batchCursor: aliceBatch.batchCursor,
      }),
      (error) => error instanceof ConversationServiceError &&
        error.code === 'INVALID_CURSOR',
    );
    const bobBatch = fixture.service.importConversations(
      bobTenant,
      bobPayload,
    );
    assert.equal(bobBatch.stats.created, 3);
    assert.deepEqual(
      fixture.database.prepare(
        `SELECT user_id, COUNT(*) AS count FROM conversation_sessions
         GROUP BY user_id ORDER BY user_id`,
      ).all().map((row) => ({ ...row })),
      [
        { user_id: 'alice', count: 1 },
        { user_id: 'bob', count: 1 },
      ],
    );
  } finally {
    fixture.database.close();
  }
});

test('AIRI import 匹配已有 compat turn 且不重复排生命周期任务', () => {
  const fixture = createFixture();
  try {
    const lifecycle = new LifecycleStore(
      fixture.database,
      () => new Date('2026-08-01T00:00:00.000Z'),
    );
    const recorded = lifecycle.recordTurn({
      userId: tenant.principalId,
      namespace: tenant.namespace,
      personaId: PERSONA_ID,
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'compat-round-1',
      clientName: 'client',
      sessionExternalId: 'compat-session-1',
      turnExternalId: 'compat-user-1',
      role: 'user',
      content: '这是兼容代理已经写入的消息',
    });
    const outboxBefore = Number(fixture.database.prepare(
      `SELECT COUNT(*) AS count FROM outbox_events`,
    ).get()?.count);
    const result = fixture.service.importConversations(tenant, {
      dryRun: false,
      importId: 'airi-import-compat-match',
      batchCursor: null,
      isLastBatch: true,
      conversations: [{
        externalSessionId: 'compat-session-1',
        personaId: PERSONA_ID,
        projectId: null,
        title: null,
        messages: [
          {
            externalMessageId: 'compat-user-1',
            externalRoundId: 'compat-round-1',
            role: 'user',
            displayContent: '这是兼容代理已经写入的消息',
            occurredAt: '2026-08-01T00:00:00.000Z',
          },
          {
            externalMessageId: 'compat-assistant-1',
            externalRoundId: 'compat-round-1',
            role: 'assistant',
            displayContent: '这是补齐的助手消息。',
            occurredAt: '2026-08-01T00:00:01.000Z',
          },
        ],
      }],
    });
    assert.equal(result.stats.conversations.matched, 1);
    assert.equal(result.stats.messages.matched, 1);
    assert.equal(result.stats.messages.created, 1);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_turns
         WHERE session_id = ?`,
      ).get(recorded.sessionId)?.count),
      2,
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events`,
      ).get()?.count),
      outboxBefore,
    );
  } finally {
    fixture.database.close();
  }
});

test('删除整轮会清除正文并保持回执幂等和策略冲突', () => {
  const fixture = createFixture();
  try {
    const committed = fixture.service.importConversations(
      tenant,
      importPayload(false, 'airi-import-for-delete'),
    );
    assert.equal(committed.stats.created, 3);
    const conversation = fixture.database.prepare(
      `SELECT * FROM conversation_sessions WHERE external_id = ?`,
    ).get('client-session-1');
    const message = fixture.database.prepare(
      `SELECT * FROM conversation_turns
       WHERE session_id = ? AND role = 'assistant'`,
    ).get(String(conversation?.id));
    assert.ok(message);
    const request = {
      clientRequestId: 'delete-round-request-1',
      reason: '用户删除这轮聊天',
      memoryPolicy: 'retain_derived_memories' as const,
    };
    const receipt = fixture.service.deleteMessage(
      tenant,
      String(message.id),
      request,
    );
    assert.equal(receipt.affectedMessageIds.length, 2);
    assert.deepEqual(
      fixture.database.prepare(
        `SELECT content, display_content, message_status
         FROM conversation_turns WHERE round_id = ? ORDER BY role`,
      ).all(String(message.round_id)).map((row) => ({ ...row })),
      [
        {
          content: '[deleted]',
          display_content: '[deleted]',
          message_status: 'deleted',
        },
        {
          content: '[deleted]',
          display_content: '[deleted]',
          message_status: 'deleted',
        },
      ],
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_changes
         WHERE conversation_id = ? AND resource_json LIKE '%桂花乌龙%'`,
      ).get(String(conversation?.id))?.count),
      0,
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_round_events
         WHERE round_id = ? AND data_json LIKE '%桂花乌龙%'`,
      ).get(String(message.round_id))?.count),
      0,
    );
    assert.equal(
      fixture.service.deleteMessage(
        tenant,
        String(message.id),
        request,
      ).id,
      receipt.id,
    );
    assert.throws(
      () => fixture.service.deleteMessage(
        tenant,
        String(message.id),
        {
          ...request,
          clientRequestId: 'delete-round-request-2',
          memoryPolicy: 'forget_derived_memories',
        },
      ),
      (error) => error instanceof ConversationServiceError &&
        error.code === 'DELETE_POLICY_CONFLICT',
    );
  } finally {
    fixture.database.close();
  }
});

test('删除消息立即阻断关联情景和层级摘要召回', () => {
  const fixture = createFixture();
  try {
    fixture.service.importConversations(
      tenant,
      importPayload(false, 'airi-import-layered-delete'),
    );
    const turns = fixture.database.prepare(
      `SELECT * FROM conversation_turns ORDER BY occurred_at ASC`,
    ).all() as Array<Record<string, unknown>>;
    const userTurn = turns.find((turn) => turn.role === 'user')!;
    const assistantTurn = turns.find((turn) => turn.role === 'assistant')!;
    const store = new MemoryStore(fixture.database);
    const episodeMemory = store.remember({
      userId: 'alice',
      namespace: 'chat',
      kind: 'event',
      source: 'conversation_episode',
      content: '用户原话：我喜欢桂花乌龙。\n助手回应（非用户事实）：收到。',
    }).memory;
    const episodeId = 'delete-layered-episode';
    fixture.database.prepare(
      `INSERT INTO conversation_episodes (
         id, memory_id, user_id, namespace, session_id,
         user_turn_id, assistant_turn_id, scope_type, scope_key,
         occurred_at, content_hash, status, created_at, updated_at
       ) VALUES (?, ?, 'alice', 'chat', ?, ?, ?, 'personal', 'self',
                 ?, ?, 'active', ?, ?)`,
    ).run(
      episodeId,
      episodeMemory.id,
      String(userTurn.session_id),
      String(userTurn.id),
      String(assistantTurn.id),
      String(userTurn.occurred_at),
      'a'.repeat(64),
      String(userTurn.occurred_at),
      String(userTurn.occurred_at),
    );
    const summaryMemory = store.remember({
      userId: 'alice',
      namespace: 'chat',
      kind: 'event',
      source: 'hierarchical_summary',
      content: '用户在本会话聊过桂花乌龙。',
    }).memory;
    fixture.database.prepare(
      `INSERT INTO conversation_memory_summaries (
         id, memory_id, user_id, namespace, summary_type, bucket_key,
         scope_type, scope_key, source_fingerprint, source_count,
         status, model, prompt_version, created_at, updated_at
       ) VALUES (
         'delete-layered-summary', ?, 'alice', 'chat', 'session', ?,
         'personal', 'self', ?, 1, 'active', 'test', 'test-v1', ?, ?
       )`,
    ).run(
      summaryMemory.id,
      String(userTurn.session_id),
      'b'.repeat(64),
      String(userTurn.occurred_at),
      String(userTurn.occurred_at),
    );
    fixture.database.prepare(
      `INSERT INTO conversation_memory_summary_sources (
         summary_id, episode_id, ordinal
       ) VALUES ('delete-layered-summary', ?, 0)`,
    ).run(episodeId);

    fixture.service.deleteMessage(tenant, String(userTurn.id), {
      clientRequestId: 'delete-layered-memory-request',
      reason: '用户删除原始对话',
      memoryPolicy: 'retain_derived_memories',
    });

    assert.equal(
      fixture.database.prepare(
        'SELECT status FROM conversation_episodes WHERE id = ?',
      ).get(episodeId)?.status,
      'deleted',
    );
    assert.equal(
      store.get(episodeMemory.id, false, 'alice', 'chat')?.status,
      'archived',
    );
    assert.equal(Number(fixture.database.prepare(
      'SELECT COUNT(*) AS count FROM memories_fts WHERE memory_id = ?',
    ).get(episodeMemory.id)?.count), 0);
    assert.equal(
      fixture.database.prepare(
        `SELECT status FROM conversation_memory_summaries
         WHERE id = 'delete-layered-summary'`,
      ).get()?.status,
      'quarantined',
    );
    assert.equal(
      store.get(summaryMemory.id, false, 'alice', 'chat')?.status,
      'archived',
    );
    assert.equal(Number(fixture.database.prepare(
      'SELECT COUNT(*) AS count FROM memories_fts WHERE memory_id = ?',
    ).get(summaryMemory.id)?.count), 0);
  } finally {
    fixture.database.close();
  }
});

test('retain 和 forget 删除都立即使关联观察退出跨窗口累计', () => {
  for (const memoryPolicy of [
    'retain_derived_memories',
    'forget_derived_memories',
  ] as const) {
    const fixture = createFixture();
    try {
      fixture.service.importConversations(
        tenant,
        importPayload(false, `airi-import-observation-${memoryPolicy}`),
      );
      const turn = fixture.database.prepare(
        `SELECT * FROM conversation_turns WHERE role = 'user'`,
      ).get() as Record<string, unknown>;
      fixture.database.prepare(
        `INSERT INTO memory_pattern_observations (
           id, user_id, namespace, scope_type, scope_key,
           claim_fingerprint, kind, subject, predicate, value_text,
           negated, turn_id, session_id, excerpt, excerpt_hash,
           occurred_at, observation_state, first_run_id, last_run_id,
           created_at, updated_at
         ) VALUES (?, 'alice', 'chat', 'personal', 'self', ?,
           'preference', '用户', '饮品偏好', '桂花乌龙', 0, ?, ?, ?, ?, ?,
           'supporting', NULL, NULL, ?, ?)`,
      ).run(
        `delete-observation-${memoryPolicy}`,
        `${memoryPolicy}-claim`,
        String(turn.id),
        String(turn.session_id),
        '我喜欢桂花乌龙',
        'a'.repeat(64),
        String(turn.occurred_at),
        String(turn.occurred_at),
        String(turn.occurred_at),
      );

      fixture.service.deleteMessage(tenant, String(turn.id), {
        clientRequestId: `delete-observation-request-${memoryPolicy}`,
        reason: '用户删除观察来源',
        memoryPolicy,
      });

      assert.deepEqual(
        {
          ...fixture.database.prepare(
            `SELECT observation_state, excerpt
             FROM memory_pattern_observations WHERE turn_id = ?`,
          ).get(String(turn.id)),
        },
        {
          observation_state: 'superseded',
          excerpt: '[deleted]',
        },
      );
    } finally {
      fixture.database.close();
    }
  }
});

test('forget 删除唯一证据时 tombstone 记忆并完成索引维护', async () => {
  const fixture = createFixture();
  try {
    fixture.service.importConversations(
      tenant,
      importPayload(false, 'airi-import-for-single-evidence-forget'),
    );
    const turn = fixture.database.prepare(
      `SELECT * FROM conversation_turns
       WHERE external_id = 'client-message-user-1'`,
    ).get();
    assert.ok(turn);
    const memoryId = await commitPreference(
      fixture,
      String(turn.id),
      '我喜欢桂花乌龙',
    );

    const receipt = fixture.service.deleteMessage(
      tenant,
      String(turn.id),
      {
        clientRequestId: 'forget-single-evidence-request',
        reason: '用户要求同时忘记派生记忆',
        memoryPolicy: 'forget_derived_memories',
      },
    );
    assert.equal(receipt.memoryActionRequestIds.length, 1);
    assert.equal(
      fixture.database.prepare(
        `SELECT status FROM memory_items WHERE id = ?`,
      ).get(memoryId)?.status,
      'deleted',
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_evidence
         WHERE memory_version_id IN (
           SELECT id FROM memory_versions WHERE memory_item_id = ?
         )`,
      ).get(memoryId)?.count),
      0,
    );
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_tombstones
         WHERE memory_item_id = ? AND restored_at IS NULL`,
      ).get(memoryId)?.count),
      1,
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(
          `SELECT action, status, remaining_evidence_count
           FROM conversation_memory_recomputations
           WHERE deletion_receipt_id = ?`,
        ).get(receipt.id),
      },
      {
        action: 'tombstoned',
        status: 'completed',
        remaining_evidence_count: 0,
      },
    );
    assert.equal(fixture.service.processConversationMaintenanceJobs(), 1);
    assert.equal(
      fixture.database.prepare(
        `SELECT status FROM conversation_maintenance_jobs
         WHERE deletion_receipt_id = ? AND job_type = 'memory_recompute'`,
      ).get(receipt.id)?.status,
      'completed',
    );
    fixture.setTime('2026-09-12T00:00:00.000Z');
    assert.equal(fixture.service.processConversationMaintenanceJobs(), 1);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_maintenance_jobs
         WHERE deletion_receipt_id = ? AND status != 'completed'`,
      ).get(receipt.id)?.count),
      0,
    );
  } finally {
    fixture.database.close();
  }
});

test('forget 删除多证据之一时生成新版本并保留其他证据', async () => {
  const fixture = createFixture();
  try {
    const payload = importPayload(
      false,
      'airi-import-for-multi-evidence-forget',
    );
    payload.conversations[0]!.messages.push(
      {
        externalMessageId: 'airi-message-user-2',
        externalRoundId: 'airi-round-2',
        role: 'user',
        displayContent: '平时点饮料我还是喜欢桂花乌龙',
        occurredAt: '2026-08-02T01:00:00.000Z',
      },
      {
        externalMessageId: 'airi-message-assistant-2',
        externalRoundId: 'airi-round-2',
        role: 'assistant',
        displayContent: '好的。',
        occurredAt: '2026-08-02T01:00:01.000Z',
      },
    );
    fixture.service.importConversations(tenant, payload);
    const turns = fixture.database.prepare(
      `SELECT * FROM conversation_turns
       WHERE role = 'user' ORDER BY occurred_at ASC`,
    ).all();
    assert.equal(turns.length, 2);
    const firstMemoryId = await commitPreference(
      fixture,
      String(turns[0]!.id),
      '我喜欢桂花乌龙',
    );
    const secondMemoryId = await commitPreference(
      fixture,
      String(turns[1]!.id),
      '平时点饮料我还是喜欢桂花乌龙',
    );
    assert.equal(secondMemoryId, firstMemoryId);

    const oldVersionId = String(fixture.database.prepare(
      `SELECT current_version_id FROM memory_items WHERE id = ?`,
    ).get(firstMemoryId)?.current_version_id);
    const receipt = fixture.service.deleteMessage(
      tenant,
      String(turns[0]!.id),
      {
        clientRequestId: 'forget-one-of-two-evidence-request',
        reason: '只删除第一轮及其证据',
        memoryPolicy: 'forget_derived_memories',
      },
    );
    const item = fixture.database.prepare(
      `SELECT current_version_id, status, revision
       FROM memory_items WHERE id = ?`,
    ).get(firstMemoryId);
    assert.equal(item?.status, 'active');
    assert.notEqual(item?.current_version_id, oldVersionId);
    assert.equal(Number(item?.revision), 2);
    assert.equal(
      Number(fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_evidence
         WHERE memory_version_id = ?`,
      ).get(String(item?.current_version_id))?.count),
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT turn_id FROM memory_evidence
         WHERE memory_version_id = ?`,
      ).get(String(item?.current_version_id))?.turn_id,
      turns[1]!.id,
    );
    assert.deepEqual(
      {
        ...fixture.database.prepare(
          `SELECT action, status, remaining_evidence_count,
                  new_memory_version_id
           FROM conversation_memory_recomputations
           WHERE deletion_receipt_id = ?`,
        ).get(receipt.id),
      },
      {
        action: 'recomputed',
        status: 'completed',
        remaining_evidence_count: 1,
        new_memory_version_id: item?.current_version_id,
      },
    );
    assert.equal(fixture.service.processConversationMaintenanceJobs(), 1);
  } finally {
    fixture.database.close();
  }
});
