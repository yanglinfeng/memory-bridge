import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import {
  HierarchicalSummaryService,
  type HierarchicalSummaryInput,
} from '../src/server/hierarchical-summary-service.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import type {
  ConsolidationProvider,
  ConsolidationSource,
} from '../src/server/memory-consolidator.js';
import { MemoryStore } from '../src/server/memory-store.js';

interface Fixture {
  database: DatabaseSync;
  lifecycleStore: LifecycleStore;
  memoryStore: MemoryStore;
  close(): void;
}

interface SeededEpisode {
  episodeId: string;
  memoryId: string;
  memoryVersionId: string;
  sessionId: string;
  occurredAt: string;
}

function createFixture(): Fixture {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-hierarchical-summary-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycleStore = new LifecycleStore(database);
  const memoryStore = new MemoryStore(database);
  return {
    database,
    lifecycleStore,
    memoryStore,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function summaryInput(
  summaryType: HierarchicalSummaryInput['summaryType'],
  bucketKey: string,
): HierarchicalSummaryInput {
  return {
    userId: 'user-a',
    namespace: 'default',
    summaryType,
    bucketKey,
    scopeType: 'role',
    scopeKey: 'role-a',
    timezoneOffsetMinutes: 480,
  };
}

function provider(options: {
  fail?: boolean;
  calls?: { consolidate: number; verify: number };
} = {}): ConsolidationProvider {
  return {
    model: 'qwen2.5:14b',
    promptVersion: 'hierarchical-summary-v1',
    async consolidate(_scope, sources) {
      if (options.calls) options.calls.consolidate += 1;
      if (options.fail) throw new Error('deterministic provider failure');
      return {
        sentences: sources.map((source) => ({
          text: `摘要：${source.content}`,
          sourceVersionIds: [source.memoryVersionId],
        })),
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      if (options.calls) options.calls.verify += 1;
      if (options.fail) throw new Error('deterministic verifier failure');
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic fixture',
      }));
    },
  };
}

function seedEpisode(
  fixture: Fixture,
  input: {
    sessionExternalId: string;
    ordinal: number;
    occurredAt: string;
    content?: string;
  },
): SeededEpisode {
  const exchange = fixture.lifecycleStore.recordCompletedExchange({
    userId: 'user-a',
    namespace: 'default',
    personaId: 'role-a',
    projectId: null,
    identitySource: 'credential',
    identityStatus: 'complete',
    roundId: `${input.sessionExternalId}-round-${input.ordinal}`,
    clientName: 'hierarchical-summary-test',
    sessionExternalId: input.sessionExternalId,
    userTurnExternalId: `${input.sessionExternalId}-u-${input.ordinal}`,
    userContent: input.content || `用户在第 ${input.ordinal} 轮讨论旅行安排。`,
    assistantTurnExternalId: `${input.sessionExternalId}-a-${input.ordinal}`,
    assistantContent: `助手在第 ${input.ordinal} 轮给出答复。`,
    occurredAt: input.occurredAt,
  });
  const episodeId = randomUUID();
  const content = [
    `用户说：${input.content || `用户在第 ${input.ordinal} 轮讨论旅行安排。`}`,
    `助手回答：助手在第 ${input.ordinal} 轮给出答复。`,
  ].join('\n');
  const memory = fixture.memoryStore.remember({
    userId: 'user-a',
    namespace: 'default',
    kind: 'event',
    title: `对话情景 ${input.ordinal}`,
    content,
    source: 'conversation_episode',
    sourceRef: `episode:${episodeId}`,
    occurredAt: input.occurredAt,
    scopeType: 'role',
    scopeKey: 'role-a',
    stableKey: `episode:${exchange.userTurn.id}:${exchange.assistantTurn.id}`,
    idempotencyKey: `episode:${exchange.userTurn.id}:${exchange.assistantTurn.id}`,
    predicateKey: `episode::${episodeId}`,
    normalizedValueHash: createHash('sha256').update(content).digest('hex'),
    normalizedValue: content,
    predicateCardinality: 'event',
  }).memory;
  const current = fixture.database.prepare(
    `SELECT current_version_id
     FROM memory_items
     WHERE id = ?`,
  ).get(memory.id) as Record<string, unknown>;
  fixture.database.prepare(
    `INSERT INTO conversation_episodes (
       id, memory_id, user_id, namespace, session_id,
       user_turn_id, assistant_turn_id, scope_type, scope_key,
       occurred_at, content_hash, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    episodeId,
    memory.id,
    'user-a',
    'default',
    exchange.sessionId,
    exchange.userTurn.id,
    exchange.assistantTurn.id,
    'role',
    'role-a',
    input.occurredAt,
    createHash('sha256').update(content).digest('hex'),
    input.occurredAt,
    input.occurredAt,
  );
  fixture.database.prepare(
    `INSERT INTO conversation_episode_turns (
       episode_id, turn_id, role, ordinal, content_hash
     ) VALUES (?, ?, 'user', 0, ?), (?, ?, 'assistant', 1, ?)`,
  ).run(
    episodeId,
    exchange.userTurn.id,
    createHash('sha256').update(exchange.userTurn.content).digest('hex'),
    episodeId,
    exchange.assistantTurn.id,
    createHash('sha256').update(exchange.assistantTurn.content).digest('hex'),
  );
  return {
    episodeId,
    memoryId: memory.id,
    memoryVersionId: String(current.current_version_id),
    sessionId: exchange.sessionId,
    occurredAt: input.occurredAt,
  };
}

function activeSummary(
  database: DatabaseSync,
  summaryType: string,
  bucketKey: string,
): Record<string, unknown> {
  const row = database.prepare(
    `SELECT s.*, m.source AS memory_source, m.status AS memory_status
     FROM conversation_memory_summaries s
     JOIN memories m ON m.id = s.memory_id
     WHERE s.user_id = 'user-a'
       AND s.namespace = 'default'
       AND s.summary_type = ?
       AND s.bucket_key = ?
       AND s.status = 'active'`,
  ).get(summaryType, bucketKey) as Record<string, unknown> | undefined;
  assert.ok(row);
  return row;
}

test('session/day/ISO-week 摘要进入 FTS 且每句可回溯 episode/version', async () => {
  const fixture = createFixture();
  try {
    const first = seedEpisode(fixture, {
      sessionExternalId: 'session-a',
      ordinal: 1,
      occurredAt: '2026-08-10T16:30:00.000Z',
    });
    const second = seedEpisode(fixture, {
      sessionExternalId: 'session-a',
      ordinal: 2,
      occurredAt: '2026-08-10T17:30:00.000Z',
    });
    seedEpisode(fixture, {
      sessionExternalId: 'session-b',
      ordinal: 3,
      occurredAt: '2026-08-12T01:00:00.000Z',
    });
    const service = new HierarchicalSummaryService(
      fixture.database,
      fixture.memoryStore,
      provider(),
    );

    const session = await service.summarizeBucket(
      summaryInput('session', first.sessionId),
    );
    const day = await service.summarizeBucket(
      summaryInput('day', '2026-08-11'),
    );
    const week = await service.summarizeBucket(
      summaryInput('week', '2026-W33'),
    );

    assert.equal(session.status, 'created');
    assert.equal(session.sourceCount, 2);
    assert.equal(day.status, 'created');
    assert.equal(day.sourceCount, 2);
    assert.equal(week.status, 'created');
    assert.equal(week.sourceCount, 3);
    for (const result of [session, day, week]) {
      assert.ok(result.memoryId);
      const memory = fixture.memoryStore.get(
        result.memoryId!,
        false,
        'user-a',
        'default',
      );
      assert.equal(memory?.source, 'hierarchical_summary');
      assert.equal(Number(fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM memories_fts WHERE memory_id = ?',
      ).get(result.memoryId)?.count), 1);
    }

    const sessionRow = activeSummary(
      fixture.database,
      'session',
      first.sessionId,
    );
    const sourceRows = fixture.database.prepare(
      `SELECT episode_id
       FROM conversation_memory_summary_sources
       WHERE summary_id = ?
       ORDER BY ordinal`,
    ).all(String(sessionRow.id)) as Array<Record<string, unknown>>;
    assert.deepEqual(
      sourceRows.map((row) => String(row.episode_id)),
      [first.episodeId, second.episodeId],
    );
    const evidence = fixture.database.prepare(
      `SELECT source_ref
       FROM memory_evidence e
       JOIN memory_items i ON i.current_version_id = e.memory_version_id
       WHERE i.id = ?
       ORDER BY source_ref`,
    ).all(session.memoryId) as Array<Record<string, unknown>>;
    assert.equal(evidence.length, 2);
    assert.ok(evidence.some((row) =>
      String(row.source_ref).includes(first.episodeId) &&
      String(row.source_ref).includes(first.memoryVersionId),
    ));
    assert.ok(evidence.some((row) =>
      String(row.source_ref).includes(second.episodeId) &&
      String(row.source_ref).includes(second.memoryVersionId),
    ));
  } finally {
    fixture.close();
  }
});

test('输入 fingerprint 幂等，来源增加时新摘要 supersede 旧摘要', async () => {
  const fixture = createFixture();
  try {
    const calls = { consolidate: 0, verify: 0 };
    const first = seedEpisode(fixture, {
      sessionExternalId: 'session-idempotent',
      ordinal: 1,
      occurredAt: '2026-08-11T02:00:00.000Z',
    });
    seedEpisode(fixture, {
      sessionExternalId: 'session-idempotent',
      ordinal: 2,
      occurredAt: '2026-08-11T02:10:00.000Z',
    });
    const service = new HierarchicalSummaryService(
      fixture.database,
      fixture.memoryStore,
      provider({ calls }),
    );
    const input = summaryInput('session', first.sessionId);

    const created = await service.summarizeBucket(input);
    const unchanged = await service.summarizeBucket(input);
    assert.equal(unchanged.status, 'unchanged');
    assert.equal(unchanged.memoryId, created.memoryId);
    assert.equal(calls.consolidate, 1);
    assert.equal(calls.verify, 1);

    seedEpisode(fixture, {
      sessionExternalId: 'session-idempotent',
      ordinal: 3,
      occurredAt: '2026-08-11T02:20:00.000Z',
    });
    const rebuilt = await service.summarizeBucket(input);
    assert.equal(rebuilt.status, 'rebuilt');
    assert.notEqual(rebuilt.memoryId, created.memoryId);
    assert.equal(rebuilt.sourceCount, 3);
    assert.equal(fixture.memoryStore.get(
      created.memoryId!,
      true,
      'user-a',
      'default',
    )?.status, 'superseded');
    assert.equal(String(fixture.database.prepare(
      'SELECT status FROM conversation_memory_summaries WHERE memory_id = ?',
    ).get(created.memoryId)?.status), 'superseded');
  } finally {
    fixture.close();
  }
});

test('模型失败保留上一版仍有效摘要，不写入半成品', async () => {
  const fixture = createFixture();
  try {
    const first = seedEpisode(fixture, {
      sessionExternalId: 'session-provider-failure',
      ordinal: 1,
      occurredAt: '2026-08-11T03:00:00.000Z',
    });
    seedEpisode(fixture, {
      sessionExternalId: 'session-provider-failure',
      ordinal: 2,
      occurredAt: '2026-08-11T03:10:00.000Z',
    });
    const input = summaryInput('session', first.sessionId);
    const created = await new HierarchicalSummaryService(
      fixture.database,
      fixture.memoryStore,
      provider(),
    ).summarizeBucket(input);

    seedEpisode(fixture, {
      sessionExternalId: 'session-provider-failure',
      ordinal: 3,
      occurredAt: '2026-08-11T03:20:00.000Z',
    });
    const failed = await new HierarchicalSummaryService(
      fixture.database,
      fixture.memoryStore,
      provider({ fail: true }),
    ).summarizeBucket(input);

    assert.equal(failed.status, 'failed_preserved');
    assert.equal(failed.memoryId, created.memoryId);
    assert.equal(fixture.memoryStore.get(
      created.memoryId!,
      false,
      'user-a',
      'default',
    )?.status, 'active');
    assert.equal(Number(fixture.database.prepare(
      `SELECT COUNT(*) AS count
       FROM conversation_memory_summaries
       WHERE summary_type = 'session' AND bucket_key = ?`,
    ).get(first.sessionId)?.count), 1);
  } finally {
    fixture.close();
  }
});

test('来源删除立即阻断摘要召回，且摘要记忆不能成为摘要来源', async () => {
  const fixture = createFixture();
  try {
    const first = seedEpisode(fixture, {
      sessionExternalId: 'session-source-deleted',
      ordinal: 1,
      occurredAt: '2026-08-11T04:00:00.000Z',
    });
    seedEpisode(fixture, {
      sessionExternalId: 'session-source-deleted',
      ordinal: 2,
      occurredAt: '2026-08-11T04:10:00.000Z',
    });
    const service = new HierarchicalSummaryService(
      fixture.database,
      fixture.memoryStore,
      provider(),
    );
    const created = await service.summarizeBucket(
      summaryInput('session', first.sessionId),
    );

    fixture.database.prepare(
      `UPDATE conversation_episodes
       SET status = 'deleted', updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), first.episodeId);
    const invalidated = service.invalidateSources([first.episodeId]);
    assert.equal(invalidated.invalidated, 1);
    assert.equal(fixture.memoryStore.get(
      created.memoryId!,
      false,
      'user-a',
      'default',
    )?.status, 'archived');
    assert.equal(Number(fixture.database.prepare(
      'SELECT COUNT(*) AS count FROM memories_fts WHERE memory_id = ?',
    ).get(created.memoryId)?.count), 0);
    assert.equal(String(fixture.database.prepare(
      'SELECT status FROM conversation_memory_summaries WHERE memory_id = ?',
    ).get(created.memoryId)?.status), 'quarantined');

    const loopExchange = fixture.lifecycleStore.recordCompletedExchange({
      userId: 'user-a',
      namespace: 'default',
      personaId: 'role-a',
      projectId: null,
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'session-summary-loop-round-1',
      clientName: 'hierarchical-summary-test',
      sessionExternalId: 'session-summary-loop',
      userTurnExternalId: 'session-summary-loop-u-1',
      userContent: '这组新 turn 只用于循环来源攻击夹具。',
      assistantTurnExternalId: 'session-summary-loop-a-1',
      assistantContent: '收到。',
      occurredAt: '2026-08-18T02:00:00.000Z',
    });
    fixture.database.prepare(
      `UPDATE memories SET status = 'active' WHERE id = ?`,
    ).run(created.memoryId);
    fixture.database.prepare(
      `UPDATE memory_items SET status = 'active' WHERE id = ?`,
    ).run(created.memoryId);
    const summaryAsEpisodeId = randomUUID();
    fixture.database.prepare(
      `INSERT INTO conversation_episodes (
         id, memory_id, user_id, namespace, session_id,
         user_turn_id, assistant_turn_id, scope_type, scope_key,
         occurred_at, content_hash, status, created_at, updated_at
       ) VALUES (?, ?, 'user-a', 'default', ?, ?, ?, 'role', 'role-a',
                 ?, ?, 'active', ?, ?)`,
    ).run(
      summaryAsEpisodeId,
      created.memoryId,
      loopExchange.sessionId,
      loopExchange.userTurn.id,
      loopExchange.assistantTurn.id,
      '2026-08-18T02:00:00.000Z',
      createHash('sha256').update('loop').digest('hex'),
      '2026-08-18T02:00:00.000Z',
      '2026-08-18T02:00:00.000Z',
    );
    const loop = await service.summarizeBucket(
      summaryInput('day', '2026-08-18'),
    );
    assert.equal(loop.status, 'blocked');
    assert.equal(loop.sourceCount, 0);
    assert.equal(loop.memoryId, null);
  } finally {
    fixture.close();
  }
});
