import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REDACTED_ASSISTANT_CREDENTIAL } from '../src/server/assistant-protocol.js';
import { openDatabase } from '../src/server/database.js';
import {
  EpisodicMemoryService,
} from '../src/server/episodic-memory-service.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import type { MemoryExtractor } from '../src/server/memory-extractor.js';
import { MemoryWorker } from '../src/server/memory-worker.js';

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-episode-'),
  );
  let current = new Date('2026-08-13T00:00:00.000Z');
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycle = new LifecycleStore(database, () => current);
  const episodic = new EpisodicMemoryService(database, () => current);
  const extractor: MemoryExtractor = {
    extractorId: 'episode-test-extractor',
    extractorVersion: '1',
    model: 'qwen2.5:14b',
    promptVersion: 'episode-test-v1',
    async extract() {
      throw new Error('materialize_episode 不得调用模型提取器');
    },
  };
  return {
    database,
    lifecycle,
    episodic,
    extractor,
    advance(milliseconds: number) {
      current = new Date(current.getTime() + milliseconds);
    },
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('turn.completed 在前台 QoS 压力下仍幂等物化完整 exchange', async () => {
  const fixture = createFixture();
  try {
    const exchange = fixture.lifecycle.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'episode-session',
      userTurnExternalId: 'episode-user-1',
      userContent: '周末我去了西湖骑行。',
      assistantTurnExternalId: 'episode-assistant-1',
      assistantContent: '听起来这是一次很放松的周末活动。',
      occurredAt: '2026-08-12T08:30:00.000Z',
    });
    const worker = new MemoryWorker(
      fixture.lifecycle,
      fixture.extractor,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      fixture.episodic,
    );

    const result = await worker.processNext('episode-worker', {
      backgroundModelAllowed: false,
    });
    assert.equal(result.job?.jobType, 'materialize_episode');
    assert.equal(result.job?.status, 'completed');
    assert.equal(result.candidateCount, 1);

    const memory = fixture.database.prepare(
      `SELECT * FROM memories WHERE source = 'conversation_episode'`,
    ).get();
    assert.equal(memory?.kind, 'event');
    assert.equal(memory?.user_id, 'alice');
    assert.equal(memory?.namespace, 'personal');
    assert.equal(memory?.scope_type, 'personal');
    assert.equal(memory?.scope_key, 'self');
    assert.match(String(memory?.content), /周末我去了西湖骑行/u);
    assert.match(String(memory?.content), /这是一次很放松的周末活动/u);

    const episode = fixture.database.prepare(
      `SELECT * FROM conversation_episodes WHERE memory_id = ?`,
    ).get(memory?.id);
    assert.equal(episode?.user_turn_id, exchange.userTurn.id);
    assert.equal(episode?.assistant_turn_id, exchange.assistantTurn.id);
    assert.equal(episode?.occurred_at, exchange.userTurn.occurredAt);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM conversation_episode_turns WHERE episode_id = ?`,
      ).get(episode?.id)?.count,
      2,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_evidence e
         JOIN memory_items i ON i.current_version_id = e.memory_version_id
         WHERE i.id = ?`,
      ).get(memory?.id)?.count,
      2,
    );
    assert.equal(
      fixture.database.prepare(
         `SELECT COUNT(*) AS count
         FROM memories_fts
         WHERE memory_id = ? AND memories_fts MATCH '西湖骑行'`,
      ).get(memory?.id)?.count,
      1,
      'episode 必须在物化事务提交时即可被 FTS 检索',
    );

    fixture.database.prepare(
      `UPDATE memory_jobs
       SET status = 'failed', lease_owner = NULL, lease_until = NULL,
           available_at = '2000-01-01T00:00:00.000Z'
       WHERE job_type = 'materialize_episode'`,
    ).run();
    const replay = await worker.processNext('episode-replay-worker', {
      backgroundModelAllowed: false,
    });
    assert.equal(replay.job?.status, 'completed');
    assert.equal(replay.candidateCount, 0);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_episodes`,
      ).get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memories WHERE source = 'conversation_episode'`,
      ).get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('episode FTS 写入不依赖后续 memory_event outbox 调度', async () => {
  const fixture = createFixture();
  try {
    fixture.lifecycle.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'episode-outbox-delay-session',
      userTurnExternalId: 'episode-outbox-delay-user',
      userContent: '延迟调度时仍要立即检索到青城山徒步。',
      assistantTurnExternalId: 'episode-outbox-delay-assistant',
      assistantContent: '收到，这是一次过往对话情景。',
    });
    const worker = new MemoryWorker(
      fixture.lifecycle,
      fixture.extractor,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      fixture.episodic,
    );

    await worker.processNext('episode-outbox-delay-worker', {
      backgroundModelAllowed: false,
    });

    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memories_fts
         WHERE memories_fts MATCH '青城山徒步'`,
      ).get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM outbox_events
         WHERE aggregate_type = 'memory_event' AND status = 'pending'`,
      ).get()?.count,
      1,
      'Dense fan-out 可以异步，但不得成为 FTS 可见性的前置条件',
    );
  } finally {
    fixture.close();
  }
});

test('episode scope 由可信 project、persona、personal 绑定决定且租户隔离', () => {
  const fixture = createFixture();
  try {
    const cases = [
      {
        userId: 'alice',
        sessionExternalId: 'episode-project-session',
        personaId: 'persona-A',
        projectId: 'project-A',
        expectedType: 'project',
        expectedKey: 'project-A',
      },
      {
        userId: 'alice',
        sessionExternalId: 'episode-role-session',
        personaId: 'persona-B',
        projectId: null,
        expectedType: 'role',
        expectedKey: 'persona-B',
      },
      {
        userId: 'bob',
        sessionExternalId: 'episode-personal-session',
        personaId: null,
        projectId: null,
        expectedType: 'personal',
        expectedKey: 'self',
      },
    ] as const;
    const materialized: Array<{
      memoryId: string;
      userId: string;
      scopeType: string;
      scopeKey: string;
    }> = [];
    for (const [index, item] of cases.entries()) {
      const exchange = fixture.lifecycle.recordCompletedExchange({
        userId: item.userId,
        namespace: 'personal',
        personaId: item.personaId,
        projectId: item.projectId,
        identitySource: item.personaId ? 'credential' : 'legacy',
        identityStatus: item.personaId ? 'complete' : 'legacy',
        roundId: item.personaId ? `round-${index}` : null,
        clientName: 'client',
        sessionExternalId: item.sessionExternalId,
        userTurnExternalId: `scope-user-${index}`,
        userContent: `scope case ${index}`,
        assistantTurnExternalId: `scope-assistant-${index}`,
        assistantContent: `scope response ${index}`,
      });
      const result = fixture.episodic.materialize({
        userId: item.userId,
        namespace: 'personal',
        userTurnId: exchange.userTurn.id,
        assistantTurnId: exchange.assistantTurn.id,
      });
      const row = fixture.database.prepare(
        `SELECT user_id, scope_type, scope_key
         FROM memories WHERE id = ?`,
      ).get(result.memoryId);
      assert.deepEqual(
        {
          userId: row?.user_id,
          scopeType: row?.scope_type,
          scopeKey: row?.scope_key,
        },
        {
          userId: item.userId,
          scopeType: item.expectedType,
          scopeKey: item.expectedKey,
        },
      );
      materialized.push({
        memoryId: result.memoryId,
        userId: item.userId,
        scopeType: item.expectedType,
        scopeKey: item.expectedKey,
      });
    }

    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memories
         WHERE user_id = 'alice' AND scope_type = 'project'
           AND scope_key = 'project-A'`,
      ).get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memories
         WHERE user_id = 'alice' AND scope_type = 'role'
           AND scope_key = 'persona-B'`,
      ).get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memories
         WHERE user_id = 'bob' AND scope_type = 'personal'
           AND scope_key = 'self'`,
      ).get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memories
         WHERE user_id = 'alice' AND id = ?`,
      ).get(materialized[2].memoryId)?.count,
      0,
      '同 scope key 也不得跨 principal 可见',
    );
    const bobEpisode = fixture.database.prepare(
      `SELECT user_turn_id, assistant_turn_id
       FROM conversation_episodes WHERE memory_id = ?`,
    ).get(materialized[2].memoryId);
    assert.throws(
      () => fixture.episodic.materialize({
        userId: 'alice',
        namespace: 'personal',
        userTurnId: String(bobEpisode?.user_turn_id),
        assistantTurnId: String(bobEpisode?.assistant_turn_id),
      }),
      /同一 principal\/namespace\/session/u,
      '不能用 Alice 任务物化 Bob 的 exchange',
    );
  } finally {
    fixture.close();
  }
});

test('episode 映射与 evidence 任一步失败都会全量回滚并可安全重试', () => {
  const fixture = createFixture();
  try {
    const exchange = fixture.lifecycle.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'episode-rollback-session',
      userTurnExternalId: 'episode-rollback-user',
      userContent: '这条 exchange 用于验证事务回滚。',
      assistantTurnExternalId: 'episode-rollback-assistant',
      assistantContent: '收到。',
    });
    fixture.database.exec(`
      CREATE TRIGGER test_abort_assistant_episode_evidence
      BEFORE INSERT ON memory_evidence
      WHEN new.evidence_type = 'assistant_response'
      BEGIN
        SELECT RAISE(ABORT, 'injected episode evidence failure');
      END;
    `);
    assert.throws(
      () => fixture.episodic.materialize({
        userId: 'alice',
        namespace: 'personal',
        userTurnId: exchange.userTurn.id,
        assistantTurnId: exchange.assistantTurn.id,
      }),
      /injected episode evidence failure/u,
    );
    for (const table of [
      'conversation_episodes',
      'conversation_episode_turns',
      'memory_evidence',
      'memory_versions',
      'memory_items',
    ]) {
      assert.equal(
        fixture.database.prepare(
          `SELECT COUNT(*) AS count FROM ${table}`,
        ).get()?.count,
        0,
      );
    }
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memories
         WHERE source = 'conversation_episode'`,
      ).get()?.count,
      0,
    );

    fixture.database.exec(
      'DROP TRIGGER test_abort_assistant_episode_evidence;',
    );
    const retried = fixture.episodic.materialize({
      userId: 'alice',
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });
    assert.equal(retried.created, true);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM conversation_episodes`,
      ).get()?.count,
      1,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_evidence`,
      ).get()?.count,
      2,
    );
  } finally {
    fixture.close();
  }
});

test('episode 凭据先替换，assistant 仅作为响应证据且不触发用户事实巩固', () => {
  const fixture = createFixture();
  try {
    const secret = 'sk-proj-episode-sentinel-1234567890';
    const exchange = fixture.lifecycle.recordCompletedExchange({
      userId: 'alice',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'episode-secret-session',
      userTurnExternalId: 'episode-secret-user',
      userContent: `我刚才误贴了 Bearer ${secret}`,
      assistantTurnExternalId: 'episode-secret-assistant',
      assistantContent: '以后用户都喜欢黑色主题。',
    });
    fixture.lifecycle.dispatchNextOutbox('episode-dispatcher');
    const job = fixture.database.prepare(
      `SELECT id FROM memory_jobs WHERE job_type = 'materialize_episode'`,
    ).get();
    const claimed = fixture.lifecycle.claimJob(
      'episode-direct-worker',
      60,
      ['materialize_episode'],
    );
    assert.equal(claimed?.id, job?.id);
    const materialized = fixture.episodic.materialize({
      userId: 'alice',
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });
    fixture.lifecycle.completeJob(claimed!.id, 'episode-direct-worker');
    assert.equal(materialized.created, true);

    const memory = fixture.database.prepare(
      `SELECT id, content, source_authority
       FROM memories WHERE id = ?`,
    ).get(materialized.memoryId);
    assert.doesNotMatch(String(memory?.content), new RegExp(secret, 'u'));
    assert.match(
      String(memory?.content),
      new RegExp(REDACTED_ASSISTANT_CREDENTIAL.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    );
    assert.equal(
      memory?.source_authority,
      'legacy_unknown',
      '混合 exchange 不能把整段助手回应提升成用户事实',
    );
    const evidence = fixture.database.prepare(
      `SELECT e.turn_id, e.evidence_type, e.source_authority
       FROM memory_evidence e
       JOIN memory_items i ON i.current_version_id = e.memory_version_id
       WHERE i.id = ? ORDER BY e.created_at ASC, e.id ASC`,
    ).all(materialized.memoryId);
    assert.deepEqual(
      new Set(evidence.map((row) => String(row.evidence_type))),
      new Set(['user_utterance', 'assistant_response']),
    );
    assert.equal(
      evidence.find((row) => row.turn_id === exchange.userTurn.id)
        ?.source_authority,
      'direct_user',
    );
    assert.equal(
      evidence.find((row) => row.turn_id === exchange.assistantTurn.id)
        ?.source_authority,
      'assistant_inference',
    );
    const extractJob = fixture.database.prepare(
      `SELECT payload_json FROM memory_jobs WHERE job_type = 'extract_turn'`,
    ).get();
    assert.equal(
      JSON.parse(String(extractJob?.payload_json)).turnId,
      exchange.userTurn.id,
      'assistant 内容不得成为用户事实提取输入',
    );

    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_jobs
         WHERE job_type = 'consolidate_memory_change'`,
      ).get()?.count,
      0,
      'conversation_episode 不得触发事实巩固',
    );
    const memoryEvent = fixture.database.prepare(
      `SELECT id FROM outbox_events
       WHERE aggregate_type = 'memory_event' AND status != 'completed'`,
    ).get();
    assert.ok(memoryEvent?.id);
    fixture.lifecycle.dispatchNextOutbox('episode-memory-dispatcher');
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_jobs
         WHERE job_type = 'consolidate_memory_change'`,
      ).get()?.count,
      0,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_jobs
         WHERE job_type = 'index_memory'`,
      ).get()?.count,
      1,
      'episode 仍复用既有 index_memory Dense fan-out',
    );

    fixture.advance(15 * 60_000);
    assert.equal(
      fixture.lifecycle.runConsolidationSweep({
        at: '2026-08-13T00:15:00.000Z',
        idleMinutes: 15,
      }).enqueued,
      0,
      '会话 sweep 必须排除 conversation_episode 与分层摘要',
    );
  } finally {
    fixture.close();
  }
});
