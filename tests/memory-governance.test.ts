import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { EpisodicMemoryService } from
  '../src/server/episodic-memory-service.js';
import { HierarchicalSummaryService } from
  '../src/server/hierarchical-summary-service.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import {
  MemoryConsolidator,
  type ConsolidationProvider,
} from '../src/server/memory-consolidator.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import {
  MemoryReflectionService,
  type ReflectionProvider,
} from '../src/server/memory-reflection.js';
import type { MemoryExtractor } from '../src/server/memory-extractor.js';
import { MemoryStore } from '../src/server/memory-store.js';
import { MemoryWorker } from '../src/server/memory-worker.js';
import { PatternObservationStore } from
  '../src/server/pattern-observation-store.js';
import {
  backfillTombstoneSemanticFingerprints,
  createSemanticFingerprint,
  findBlockingTombstone,
} from '../src/server/tombstone-policy.js';

function createFixture(
  current = new Date('2026-07-29T00:00:00.000Z'),
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-governance-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycleStore = new LifecycleStore(
    database,
    () => current,
  );
  const memoryStore = new MemoryStore(database);
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
    () => current,
  );
  return {
    directory,
    database,
    lifecycleStore,
    memoryStore,
    governance,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function textVariants(value: string): string[] {
  return [
    ...new Set([
      value,
      value.normalize('NFKC'),
      value.toLowerCase(),
      value.normalize('NFKC').toLowerCase(),
    ]),
  ];
}

function fileContainsTextIgnoringCompatibilityAndCase(
  filePath: string,
  value: string,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  const decoded = fs.readFileSync(filePath).toString('utf8');
  return decoded
    .normalize('NFKC')
    .toLowerCase()
    .includes(value.normalize('NFKC').toLowerCase());
}

function assertArtifactsExcludeTextVariants(
  filePaths: string[],
  value: string,
): void {
  const variants = textVariants(value);
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;
    const bytes = fs.readFileSync(filePath);
    const normalizedLower = bytes
      .toString('utf8')
      .normalize('NFKC')
      .toLowerCase();
    for (const variant of variants) {
      assert.equal(
        bytes.includes(Buffer.from(variant)),
        false,
        `${path.basename(filePath)} 不应残留 ${variant}`,
      );
      assert.equal(
        normalizedLower.includes(
          variant.normalize('NFKC').toLowerCase(),
        ),
        false,
        `${path.basename(filePath)} 不应残留兼容或大小写变体`,
      );
    }
  }
}

function assertArtifactsExcludeFtsTrigrams(
  filePaths: string[],
  value: string,
): void {
  const characters = [
    ...value.normalize('NFKC').toLowerCase(),
  ];
  const trigrams = [
    ...new Set(
      characters
        .slice(0, -2)
        .map((_character, index) =>
          characters.slice(index, index + 3).join(''),
        ),
    ),
  ];
  assert.ok(trigrams.length > 0);
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;
    const bytes = fs.readFileSync(filePath);
    const normalizedLower = bytes
      .toString('utf8')
      .normalize('NFKC')
      .toLowerCase();
    for (const trigram of trigrams) {
      assert.equal(
        bytes.includes(Buffer.from(trigram)),
        false,
        `${path.basename(filePath)} 不应残留 FTS trigram ${trigram}`,
      );
      assert.equal(
        normalizedLower.includes(trigram),
        false,
        `${path.basename(filePath)} 不应残留规范化 FTS trigram`,
      );
    }
  }
}

test('Pin 和长期类型不衰减，过期普通事件只归档不删除', () => {
  const fixture = createFixture();
  try {
    const pinned = fixture.memoryStore.remember({
      kind: 'event',
      content: '用户有一个需要长期保留的里程碑。',
      stableKey: '用户::长期里程碑',
    }).memory;
    const expiring = fixture.memoryStore.remember({
      kind: 'event',
      content: '用户有一个已经过期的临时计划。',
      stableKey: '用户::临时计划',
    }).memory;
    const profile = fixture.memoryStore.remember({
      kind: 'profile',
      content: '用户的常用称呼是林风。',
      stableKey: '用户::称呼',
    }).memory;

    fixture.governance.setPinned(pinned.id, true);
    fixture.governance.setTtl(
      pinned.id,
      '2026-07-28T00:00:00.000Z',
    );
    fixture.governance.setTtl(
      expiring.id,
      '2026-07-28T00:00:00.000Z',
    );
    const result = fixture.governance.runRetentionSweep({
      at: '2026-07-29T00:00:00.000Z',
    });

    assert.equal(result.scanned, 3);
    assert.equal(result.archived, 1);
    assert.equal(result.protected, 2);
    assert.equal(
      fixture.memoryStore.get(pinned.id)?.status,
      'active',
    );
    assert.equal(
      fixture.memoryStore.get(profile.id)?.status,
      'active',
    );
    assert.equal(
      fixture.memoryStore.get(expiring.id)?.status,
      'archived',
    );
    assert.equal(
      fixture.governance.get(expiring.id)?.archiveReason,
      'ttl_expired',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_versions
           WHERE memory_item_id = ?`,
        )
        .get(expiring.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('旧 Episode 只卸载可重建热索引，摘要失效后自动恢复', async () => {
  const fixture = createFixture();
  try {
    const episodic = new EpisodicMemoryService(
      fixture.database,
      () => new Date('2026-07-29T00:00:00.000Z'),
    );
    const seedEpisode = (
      key: string,
      occurredAt: string,
      content: string,
    ) => {
      const exchange = fixture.lifecycleStore.recordCompletedExchange({
        clientName: 'episode-refinement-test',
        sessionExternalId: `refinement-${key}`,
        userTurnExternalId: `refinement-${key}-user`,
        userContent: content,
        assistantTurnExternalId: `refinement-${key}-assistant`,
        assistantContent: `已记录：${content}`,
        occurredAt,
      });
      return episodic.materialize({
        userId: 'default',
        namespace: 'personal',
        userTurnId: exchange.userTurn.id,
        assistantTurnId: exchange.assistantTurn.id,
      });
    };

    const compactable = seedEpisode(
      'compactable',
      '2026-05-25T08:00:00.000Z',
      '旧情景中的精确检索暗号是青黛纸鸢。',
    );
    const pinned = seedEpisode(
      'pinned',
      '2026-05-26T08:00:00.000Z',
      '这条旧情景被用户固定保留。',
    );
    const uncovered = seedEpisode(
      'uncovered',
      '2026-05-18T08:00:00.000Z',
      '这条旧情景还没有周摘要覆盖。',
    );
    const recent = seedEpisode(
      'recent',
      '2026-07-20T08:00:00.000Z',
      '这条情景仍位于热窗口。',
    );
    fixture.governance.setPinned(pinned.memoryId, true);

    const summaryProvider: ConsolidationProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'episode-refinement-summary-v1',
      async consolidate(_scope, sources) {
        return {
          sentences: [{
            text: '这些对话情景已经形成可追溯的周摘要。',
            sourceVersionIds: sources.map(
              (source) => source.memoryVersionId,
            ),
          }],
        };
      },
      async verifySupport(_scope, _sources, sentences) {
        return sentences.map((_sentence, sentenceIndex) => ({
          sentenceIndex,
          supported: true,
          rationale: 'deterministic episode refinement fixture',
        }));
      },
    };
    const summaries = new HierarchicalSummaryService(
      fixture.database,
      fixture.memoryStore,
      summaryProvider,
    );
    const oldWeek = await summaries.summarizeBucket({
      userId: 'default',
      namespace: 'personal',
      summaryType: 'week',
      bucketKey: '2026-W22',
      scopeType: 'personal',
      scopeKey: 'self',
      timezoneOffsetMinutes: 480,
    });
    const recentWeek = await summaries.summarizeBucket({
      userId: 'default',
      namespace: 'personal',
      summaryType: 'week',
      bucketKey: '2026-W30',
      scopeType: 'personal',
      scopeKey: 'self',
      timezoneOffsetMinutes: 480,
    });
    assert.equal(oldWeek.status, 'created');
    assert.equal(recentWeek.status, 'created');

    const rankedStore = new MemoryStore(fixture.database, {
      embeddingModel: 'episode-refinement-embedding',
      rerankModel: 'episode-refinement-reranker',
      async embed(texts) {
        return texts.map((_text, index) =>
          Float32Array.from([1, index % 2]),
        );
      },
      async rerank(_query, candidates) {
        return candidates.map((candidate) => ({
          id: candidate.id,
          relevant: true,
          confidence: 1,
          reason: 'deterministic episode refinement fixture',
        }));
      },
    });
    let dense = await rankedStore.backfillDenseIndex(
      256,
      undefined,
      'default',
      'personal',
    );
    while (!dense.complete) {
      dense = await rankedStore.backfillDenseIndex(
        256,
        undefined,
        'default',
        'personal',
      );
    }
    const rowCount = (table: string, memoryId: string) => Number(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE memory_id = ?`,
      ).get(memoryId)?.count || 0,
    );
    const before = {
      embedding: rowCount('memory_embeddings', compactable.memoryId),
      dense: rowCount('memory_dense_lsh', compactable.memoryId),
      ann: rowCount('memory_ann_index', compactable.memoryId),
      term: rowCount('memory_term_index', compactable.memoryId),
    };
    assert.ok(before.embedding > 0);
    assert.ok(before.dense > 0);
    assert.ok(before.ann > 0);
    assert.ok(before.term > 0);

    const refined = fixture.governance.refineEpisodeIndexes({
      userId: 'default',
      namespace: 'personal',
      at: '2026-07-29T00:00:00.000Z',
      hotDays: 30,
      batchSize: 50,
    });
    assert.equal(refined.compacted, 1);
    assert.equal(refined.rehydrated, 0);
    assert.equal(refined.removedEmbeddingRows, before.embedding);
    assert.equal(refined.removedDenseRows, before.dense);
    assert.equal(refined.removedAnnRows, before.ann);
    assert.equal(refined.removedTermRows, before.term);
    assert.deepEqual(
      fixture.database.prepare(
        `SELECT memory_id FROM conversation_episode_compactions
         ORDER BY memory_id`,
      ).all().map((row) => String(row.memory_id)),
      [compactable.memoryId],
    );
    for (const retained of [pinned, uncovered, recent]) {
      assert.equal(
        Number(fixture.database.prepare(
          `SELECT COUNT(*) AS count
           FROM conversation_episode_compactions
           WHERE memory_id = ?`,
        ).get(retained.memoryId)?.count),
        0,
      );
    }
    assert.equal(
      rowCount('memories_fts', compactable.memoryId),
      1,
      '冷却后仍必须支持精确文字检索',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memories_fts
         WHERE memory_id = ? AND memories_fts MATCH '青黛纸鸢'`,
      ).get(compactable.memoryId)?.count,
      1,
    );
    for (const table of [
      'memory_embeddings',
      'memory_dense_lsh',
      'memory_ann_index',
      'memory_term_index',
    ]) {
      assert.equal(rowCount(table, compactable.memoryId), 0, table);
    }
    assert.equal(
      fixture.database.prepare(
        'SELECT COUNT(*) AS count FROM conversation_turns',
      ).get()?.count,
      8,
      '精炼不得删除原始对话',
    );
    assert.equal(rankedStore.denseIndexWatermark(
      'default',
      'personal',
    ).complete, true);
    new MemoryStore(fixture.database);
    assert.equal(rowCount('memory_ann_index', compactable.memoryId), 0);
    assert.equal(rowCount('memory_term_index', compactable.memoryId), 0);

    fixture.database.prepare(
      "UPDATE memory_jobs SET status = 'completed', lease_until = NULL, lease_owner = NULL",
    ).run();
    fixture.database.prepare(
      "UPDATE outbox_events SET status = 'completed', processed_at = ?",
    ).run('2026-07-29T00:00:00.000Z');
    fixture.database.prepare(
      `UPDATE conversation_memory_summaries
       SET status = 'superseded', updated_at = ?
       WHERE id = ?`,
    ).run('2026-07-29T00:00:00.000Z', oldWeek.summaryId);

    const restored = fixture.governance.refineEpisodeIndexes({
      userId: 'default',
      namespace: 'personal',
      at: '2026-07-29T00:00:00.000Z',
      hotDays: 30,
      batchSize: 50,
    });
    assert.equal(restored.compacted, 0);
    assert.equal(restored.rehydrated, 1);
    assert.equal(rowCount('memory_ann_index', compactable.memoryId), before.ann);
    assert.equal(rowCount('memory_term_index', compactable.memoryId), before.term);
    assert.equal(rowCount('memory_embeddings', compactable.memoryId), 0);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM outbox_events
         WHERE event_type = 'episode_rehydrated'
           AND status = 'pending'`,
      ).get()?.count,
      1,
      'Dense 恢复必须通过持久 outbox 交给后台 Worker',
    );

    fixture.lifecycleStore.dispatchNextOutbox('episode-rehydrate-dispatcher');
    const noOpExtractor: MemoryExtractor = {
      extractorId: 'episode-refinement-extractor',
      extractorVersion: '1',
      model: 'qwen2.5:14b',
      promptVersion: 'episode-refinement-extractor-v1',
      async extract() {
        return [];
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycleStore,
      noOpExtractor,
      undefined,
      undefined,
      fixture.governance,
      false,
      rankedStore,
    );
    const indexed = await worker.processNext('episode-rehydrate-worker');
    assert.equal(indexed.job?.jobType, 'index_memory');
    assert.equal(indexed.job?.status, 'completed');
    assert.ok(rowCount('memory_embeddings', compactable.memoryId) > 0);
    assert.ok(rowCount('memory_dense_lsh', compactable.memoryId) > 0);
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM conversation_episode_compactions
         WHERE memory_id = ?`,
      ).get(compactable.memoryId)?.count,
      0,
    );
    assert.deepEqual(fixture.database.prepare(
      'PRAGMA foreign_key_check',
    ).all(), []);
  } finally {
    fixture.close();
  }
});

test('retention 归档情景时同步归档 L1 并隔离引用摘要', () => {
  const fixture = createFixture();
  try {
    const userTurn = fixture.lifecycleStore.recordTurn({
      clientName: 'client',
      sessionExternalId: 'retention-episode-session',
      turnExternalId: 'retention-episode-user',
      role: 'user',
      content: '我今天聊了情景记忆保留策略。',
    });
    const assistantTurn = fixture.lifecycleStore.recordTurn({
      clientName: 'client',
      sessionExternalId: 'retention-episode-session',
      turnExternalId: 'retention-episode-assistant',
      role: 'assistant',
      content: '收到，会让摘要跟随来源失效。',
    });
    const episodeMemory = fixture.memoryStore.remember({
      kind: 'event',
      source: 'conversation_episode',
      content: '情景记录：用户讨论情景记忆保留策略。',
    }).memory;
    fixture.database.prepare(
      `INSERT INTO conversation_episodes (
         id, memory_id, user_id, namespace, session_id,
         user_turn_id, assistant_turn_id, scope_type, scope_key,
         occurred_at, content_hash, status, created_at, updated_at
       ) VALUES (
         'retention-layered-episode', ?, 'default', 'personal', ?, ?, ?,
         'personal', 'self', ?, ?, 'active', ?, ?
       )`,
    ).run(
      episodeMemory.id,
      userTurn.sessionId,
      userTurn.turn.id,
      assistantTurn.turn.id,
      userTurn.turn.occurredAt,
      'b'.repeat(64),
      userTurn.turn.occurredAt,
      userTurn.turn.occurredAt,
    );
    const summaryMemory = fixture.memoryStore.remember({
      kind: 'knowledge',
      source: 'hierarchical_summary',
      content: '本会话讨论了情景记忆的保留策略。',
    }).memory;
    fixture.database.prepare(
      `INSERT INTO conversation_memory_summaries (
         id, memory_id, user_id, namespace, summary_type, bucket_key,
         scope_type, scope_key, source_fingerprint, source_count,
         status, model, prompt_version, created_at, updated_at
       ) VALUES (
         'retention-layered-summary', ?, 'default', 'personal', 'session', ?,
         'personal', 'self', ?, 1, 'active', 'test', 'test-v1', ?, ?
       )`,
    ).run(
      summaryMemory.id,
      userTurn.sessionId,
      'c'.repeat(64),
      userTurn.turn.occurredAt,
      userTurn.turn.occurredAt,
    );
    fixture.database.prepare(
      `INSERT INTO conversation_memory_summary_sources (
         summary_id, episode_id, ordinal
       ) VALUES ('retention-layered-summary', 'retention-layered-episode', 0)`,
    ).run();
    fixture.governance.setTtl(
      episodeMemory.id,
      '2026-07-28T00:00:00.000Z',
    );

    const result = fixture.governance.runRetentionSweep({
      at: '2026-07-29T00:00:00.000Z',
    });

    assert.equal(result.archived, 1);
    assert.equal(
      fixture.database.prepare(
        `SELECT status FROM conversation_episodes
         WHERE id = 'retention-layered-episode'`,
      ).get()?.status,
      'archived',
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT status FROM conversation_memory_summaries
         WHERE id = 'retention-layered-summary'`,
      ).get()?.status,
      'quarantined',
    );
    assert.equal(
      fixture.memoryStore.get(summaryMemory.id)?.status,
      'archived',
    );
    assert.equal(
      fixture.governance.get(summaryMemory.id)?.archiveReason,
      'episode_source_archived',
    );
  } finally {
    fixture.close();
  }
});

test('启动时把同账户同 namespace 的重复 retention 链收敛为一条', () => {
  const fixture = createFixture();
  try {
    const first = fixture.governance.enqueueRetentionSweep(
      '2026-07-30T01:00:00.000Z',
      'alice',
      'acceptance',
    );
    const second = fixture.governance.enqueueRetentionSweep(
      '2026-07-30T02:00:00.000Z',
      'alice',
      'acceptance',
    );
    const third = fixture.governance.enqueueRetentionSweep(
      '2026-07-30T03:00:00.000Z',
      'alice',
      'acceptance',
    );

    const keeper = fixture.governance.ensureRetentionSweep(
      '2026-07-29T00:00:00.000Z',
      'alice',
      'acceptance',
    );
    const replayed = fixture.governance.ensureRetentionSweep(
      '2026-07-29T00:00:00.000Z',
      'alice',
      'acceptance',
    );

    assert.equal(keeper.id, first.id);
    assert.equal(replayed.id, first.id);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'retention_sweep'
             AND user_id = 'alice' AND namespace = 'acceptance'
             AND status IN ('pending', 'failed', 'running')`,
        )
        .get()?.count,
      1,
    );
    for (const duplicate of [second, third]) {
      const retired = fixture.lifecycleStore.getJob(duplicate.id);
      assert.equal(retired?.status, 'completed');
      assert.match(
        retired?.lastError || '',
        /唯一 retention sweep 链接管/u,
      );
    }
  } finally {
    fixture.close();
  }
});

test('启动时也收敛没有活跃记忆但仍有 retention 任务的遗留 scope', () => {
  const fixture = createFixture();
  try {
    for (const hour of [1, 2, 3]) {
      fixture.governance.enqueueRetentionSweep(
        `2026-07-30T0${hour}:00:00.000Z`,
        'legacy-default',
        'acceptance',
      );
    }
    fixture.governance.enqueueRetentionSweep(
      '2026-07-30T01:00:00.000Z',
      'alice',
      'acceptance',
    );
    fixture.governance.enqueueRetentionSweep(
      '2026-07-30T02:00:00.000Z',
      'alice',
      'acceptance',
    );

    fixture.governance.ensureRetentionSweepChains(
      '2026-07-29T00:00:00.000Z',
      [{ userId: 'alice', namespace: 'acceptance' }],
    );

    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT user_id, namespace, COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'retention_sweep'
             AND status IN ('pending', 'failed', 'running')
           GROUP BY user_id, namespace
           ORDER BY user_id, namespace`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { user_id: 'alice', namespace: 'acceptance', count: 1 },
        {
          user_id: 'legacy-default',
          namespace: 'acceptance',
          count: 1,
        },
      ],
    );
  } finally {
    fixture.close();
  }
});

test('手动归档与恢复原子同步真相层、兼容投影、事件和全通道可见性', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      title: '咖啡偏好',
      content: '用户偏好手冲咖啡。',
      stableKey: '用户::咖啡偏好',
    }).memory;
    const indexCounts = () => ({
      fts: Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memories_fts
             WHERE memory_id = ?`,
          )
          .get(memory.id)?.count,
      ),
      ann: Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_ann_index
             WHERE memory_id = ?`,
          )
          .get(memory.id)?.count,
      ),
      term: Number(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_term_index
             WHERE memory_id = ?`,
          )
          .get(memory.id)?.count,
      ),
    });
    const before = indexCounts();
    assert.ok(before.fts > 0);
    assert.ok(before.ann > 0);
    assert.ok(before.term > 0);

    const archived = fixture.governance.archiveMemory(
      memory.id,
      '用户暂时不用这条偏好',
    );
    assert.equal(archived.status, 'archived');
    assert.equal(archived.archiveReason, '用户暂时不用这条偏好');
    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'archived',
    );
    assert.deepEqual(indexCounts(), before);
    assert.equal(
      fixture.memoryStore.recall({
        query: '手冲咖啡',
        limit: 5,
      }).some((entry) => entry.memory.id === memory.id),
      false,
    );
    const archivedRecall = fixture.memoryStore.recall({
      query: '手冲咖啡',
      includeArchived: true,
      limit: 5,
    });
    assert.equal(
      archivedRecall.some((entry) => entry.memory.id === memory.id),
      true,
    );
    const archiveEvent = fixture.database
      .prepare(
        `SELECT id
         FROM memory_events
         WHERE memory_item_id = ? AND event_type = 'archived'`,
      )
      .get(memory.id);
    assert.ok(archiveEvent?.id);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM outbox_events
           WHERE aggregate_id = ? AND event_type = 'archived'`,
        )
        .get(archiveEvent.id)?.count,
      1,
    );

    const restored = fixture.governance.unarchiveMemory(memory.id);
    assert.equal(restored.status, 'active');
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.archiveReason, null);
    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'active',
    );
    assert.deepEqual(indexCounts(), before);
    assert.equal(
      fixture.memoryStore.recall({
        query: '手冲咖啡',
        limit: 5,
      }).some((entry) => entry.memory.id === memory.id),
      true,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_events
           WHERE memory_item_id = ? AND event_type = 'unarchived'`,
        )
        .get(memory.id)?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('证据 TTL 会擦除旧原文，但保留被 Pin 记忆的证据', () => {
  const fixture = createFixture();
  try {
    const oldTurn = fixture.lifecycleStore.recordTurn({
      clientName: 'client',
      sessionExternalId: 'evidence-old-session',
      turnExternalId: 'evidence-old-turn',
      role: 'user',
      content: '这是一条超过 TTL 的原始用户证据。',
      occurredAt: '2026-01-01T00:00:00.000Z',
    }).turn;
    const pinnedTurn = fixture.lifecycleStore.recordTurn({
      clientName: 'client',
      sessionExternalId: 'evidence-pinned-session',
      turnExternalId: 'evidence-pinned-turn',
      role: 'user',
      content: '这是一条被 Pin 记忆引用的原始证据。',
      occurredAt: '2026-01-01T00:00:00.000Z',
    }).turn;
    fixture.memoryStore.remember({
      kind: 'event',
      content: '用户曾记录一条普通旧事件。',
      stableKey: '用户::普通旧事件',
      evidenceTurnId: oldTurn.id,
      evidenceExcerpt: oldTurn.content,
    });
    const pinned = fixture.memoryStore.remember({
      kind: 'event',
      content: '用户曾记录一条长期保留事件。',
      stableKey: '用户::长期保留事件',
      evidenceTurnId: pinnedTurn.id,
      evidenceExcerpt: pinnedTurn.content,
    }).memory;
    fixture.governance.setPinned(pinned.id, true);
    fixture.governance.upsertPolicy({
      evidenceTtlDays: 30,
      halfLifeDays: 365,
    });

    const result = fixture.governance.runRetentionSweep({
      at: '2026-07-29T00:00:00.000Z',
    });
    assert.equal(result.evidenceRedacted, 1);
    assert.equal(
      fixture.lifecycleStore.getTurn(oldTurn.id)?.content,
      '[retention-redacted]',
    );
    assert.equal(
      fixture.lifecycleStore.getTurn(pinnedTurn.id)?.content,
      pinnedTurn.content,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT excerpt
           FROM memory_evidence
           WHERE turn_id = ?`,
        )
        .get(oldTurn.id)?.excerpt,
      null,
    );
  } finally {
    fixture.close();
  }
});

test('reflection 证据 TTL 只擦正文并保留哈希、计数、claim 与 Pin 保护', async () => {
  const current = new Date('2026-07-29T00:00:00.000Z');
  const fixture = createFixture(current);
  try {
    const turns = [
      ['reflection-ttl-1', '周一早上我喝桂花乌龙。'],
      ['reflection-ttl-2', '周三早上我也喝桂花乌龙。'],
      ['reflection-ttl-3', '今天上班前还是桂花乌龙。'],
      ['reflection-pin-1', '周一晚上我阅读科幻小说。'],
      ['reflection-pin-2', '周三晚上我也阅读科幻小说。'],
      ['reflection-pin-3', '周末晚上仍然阅读科幻小说。'],
    ].map(([turnExternalId, content], index) =>
      fixture.lifecycleStore.recordTurn({
        userId: 'alice',
        namespace: 'personal',
        clientName: 'client',
        sessionExternalId: 'reflection-retention-session',
        turnExternalId: turnExternalId!,
        role: 'user',
        content: content!,
        occurredAt: `2026-01-0${index + 1}T08:00:00.000Z`,
      }).turn
    );
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'governance-reflection-v1',
      async reflect(input) {
        const evidence = (
          start: number,
          end: number,
        ) => input.turns.slice(start, end).map((turn) => ({
          turnAlias: turn.turnAlias,
          excerpt: turn.content,
        }));
        if (input.phase === 'verify' && input.verificationClaim) {
          return {
            candidates: [{
              ...input.verificationClaim,
              confidence: 0.9,
              importance: 0.7,
              sensitivity: 'normal',
              observationType: 'stable_pattern',
              evidence: evidence(0, input.turns.length),
            }],
          };
        }
        return {
          candidates: [
            {
              kind: 'preference',
              subject: '用户',
              predicate: '工作日前饮品模式',
              value: '桂花乌龙',
              confidence: 0.9,
              importance: 0.7,
              sensitivity: 'normal',
              negated: false,
              observationType: 'stable_pattern',
              evidence: evidence(0, 3),
            },
            {
              kind: 'preference',
              subject: '用户',
              predicate: '晚间阅读模式',
              value: '科幻小说',
              confidence: 0.9,
              importance: 0.7,
              sensitivity: 'normal',
              negated: false,
              observationType: 'stable_pattern',
              evidence: evidence(3, 6),
            },
          ],
        };
      },
    };
    const reflection = new MemoryReflectionService(
      fixture.database,
      fixture.lifecycleStore,
      {
        model: 'qwen2.5:14b',
        promptVersion: 'governance-extractor-v1',
        async extract() {
          return [];
        },
      },
      reflectionProvider,
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        lookbackDays: 365,
        clock: () => current,
      },
    );
    const queued = reflection.queueRun({
      userId: 'alice',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'alice',
    });
    const executed = await reflection.executeRun(
      queued.run.id,
      'reflection-retention-worker',
    );
    const unpinnedCandidate = executed.candidates.find(
      (candidate) => candidate.predicate === '工作日前饮品模式',
    )!;
    const pinnedCandidate = executed.candidates.find(
      (candidate) => candidate.predicate === '晚间阅读模式',
    )!;
    const pinnedMemory = fixture.memoryStore.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'preference',
      content: '用户晚间偏好阅读科幻小说。',
      stableKey: '用户::晚间阅读模式',
      evidenceTurnId: turns[3]!.id,
      evidenceExcerpt: turns[3]!.content,
    }).memory;
    fixture.governance.setPinned(pinnedMemory.id, true, 'alice');
    fixture.lifecycleStore.updateCandidateState(
      pinnedCandidate.id,
      'accepted',
      'manual_confirmed',
      pinnedMemory.id,
    );
    const beforeHashes = fixture.database.prepare(
      `SELECT excerpt_hash
       FROM memory_candidate_evidence
       WHERE candidate_id = ?
       ORDER BY ordinal`,
    ).all(unpinnedCandidate.id).map((row) => row.excerpt_hash);
    fixture.governance.upsertPolicy({
      userId: 'alice',
      namespace: 'personal',
      evidenceTtlDays: 30,
      halfLifeDays: 365,
    });

    const result = fixture.governance.runRetentionSweep({
      userId: 'alice',
      namespace: 'personal',
      at: current.toISOString(),
    });

    assert.equal(result.evidenceRedacted, 3);
    assert.ok(turns.slice(0, 3).every((turn) =>
      fixture.lifecycleStore.getTurn(turn.id)?.content ===
        '[retention-redacted]'
    ));
    assert.ok(turns.slice(3).every((turn) =>
      fixture.lifecycleStore.getTurn(turn.id)?.content === turn.content
    ));
    const redactedEvidence = fixture.database.prepare(
      `SELECT excerpt, excerpt_hash
       FROM memory_candidate_evidence
       WHERE candidate_id = ?
       ORDER BY ordinal`,
    ).all(unpinnedCandidate.id) as Array<Record<string, unknown>>;
    assert.equal(redactedEvidence.length, 3);
    assert.ok(redactedEvidence.every((row) => row.excerpt === null));
    assert.deepEqual(
      redactedEvidence.map((row) => row.excerpt_hash),
      beforeHashes,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_candidate_evidence
         WHERE candidate_id = ? AND excerpt IS NOT NULL`,
      ).get(pinnedCandidate.id)?.count,
      3,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_candidates
         WHERE id IN (?, ?)`,
      ).get(unpinnedCandidate.id, pinnedCandidate.id)?.count,
      2,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM memory_reflection_claims
         WHERE candidate_id IN (?, ?)`,
      ).get(unpinnedCandidate.id, pinnedCandidate.id)?.count,
      2,
    );
    assert.deepEqual(
      { ...fixture.database.prepare(
        `SELECT observation_state, excerpt
         FROM memory_pattern_observations
         WHERE turn_id = ?`,
      ).get(turns[0]!.id) },
      {
        observation_state: 'superseded',
        excerpt: '[retention-redacted]',
      },
    );
    assert.deepEqual(
      { ...fixture.database.prepare(
        `SELECT observation_state, excerpt
         FROM memory_pattern_observations
         WHERE turn_id = ?`,
      ).get(turns[3]!.id) },
      {
        observation_state: 'supporting',
        excerpt: turns[3]!.content,
      },
    );
  } finally {
    fixture.close();
  }
});

test('物理清除同步删除主库与受管备份的关联 reflection 账本且保持租户隔离', async () => {
  const current = new Date('2026-07-29T00:00:00.000Z');
  const fixture = createFixture(current);
  try {
    const createReflectionRun = async (
      userId: string,
      sessionExternalId: string,
      value: string,
    ) => {
      const turns = [
        `${value} 是这次需要追踪的明确值。`,
        '第二次对话继续支持同一个稳定模式。',
        '第三次对话仍然支持这个稳定模式。',
      ].map((content, index) =>
        fixture.lifecycleStore.recordTurn({
          userId,
          namespace: 'personal',
          clientName: 'client',
          sessionExternalId,
          turnExternalId: `${sessionExternalId}-turn-${index + 1}`,
          role: 'user',
          content,
          occurredAt: `2026-07-0${index + 1}T08:00:00.000Z`,
        }).turn
      );
      const reflection = new MemoryReflectionService(
        fixture.database,
        fixture.lifecycleStore,
        {
          model: 'qwen2.5:14b',
          promptVersion: 'purge-extractor-v1',
          async extract() {
            return [];
          },
        },
        {
          model: 'qwen2.5:14b',
          promptVersion: 'purge-reflection-v1',
          async reflect(input) {
            return {
              candidates: [{
                kind: 'preference',
                subject: '用户',
                predicate: '治理清除稳定模式',
                value,
                confidence: 0.9,
                importance: 0.7,
                sensitivity: 'normal',
                negated: false,
                observationType: 'stable_pattern',
                evidence: input.turns.map((turn) => ({
                  turnAlias: turn.turnAlias,
                  excerpt: turn.content,
                })),
              }],
            };
          },
        },
        {
          minNewTurns: 1,
          minPatternEvidence: 3,
          lookbackDays: 365,
          clock: () => current,
        },
      );
      const queued = reflection.queueRun({
        userId,
        namespace: 'personal',
        scopeType: 'personal',
        scopeKey: 'self',
        runType: 'reflect',
        trigger: 'manual',
        requestedBy: userId,
      });
      const executed = await reflection.executeRun(
        queued.run.id,
        `${userId}-purge-worker`,
      );
      return { turns, run: executed.run, candidate: executed.candidates[0]! };
    };

    const secretText = '反思清除密文-霁虹-9137';
    const alice = await createReflectionRun(
      'alice',
      'alice-reflection-purge',
      secretText,
    );
    const bob = await createReflectionRun(
      'bob',
      'bob-reflection-safe',
      '鲲鹏安全值-2048',
    );
    const memory = fixture.memoryStore.remember({
      userId: 'alice',
      namespace: 'personal',
      kind: 'preference',
      content: `用户的治理清除稳定模式是 ${secretText}。`,
      stableKey: '用户::治理清除稳定模式',
      evidenceTurnId: alice.turns[0]!.id,
      evidenceExcerpt: alice.turns[0]!.content,
    }).memory;
    fixture.lifecycleStore.updateCandidateState(
      alice.candidate.id,
      'accepted',
      'manual_confirmed',
      memory.id,
    );
    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const managedBackupPath = path.join(
      backupDirectory,
      'test-schema-29-to-30-reflection-purge.sqlite3',
    );
    const queuedPurge = fixture.governance.queuePurge(
      memory.id,
      `清除 ${secretText}`,
      'alice',
    );
    fixture.database.prepare('VACUUM INTO ?').run(managedBackupPath);

    const completed = fixture.governance.processPurgeJob(
      queuedPurge.id,
      'reflection-purge-worker',
    );

    assert.equal(completed.status, 'completed');
    const assertReflectionClosure = (
      database: DatabaseSync,
      removedRunId: string,
      retainedRunId: string,
    ) => {
      for (const [table, column] of [
        ['memory_reflection_runs', 'id'],
        ['memory_reflection_run_turns', 'run_id'],
        ['memory_reflection_model_calls', 'run_id'],
        ['memory_reflection_events', 'run_id'],
      ] as const) {
        assert.equal(
          database.prepare(
            `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
          ).get(removedRunId)?.count,
          0,
          `${table} 必须删除关联 reflection run`,
        );
        assert.ok(
          Number(database.prepare(
            `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
          ).get(retainedRunId)?.count || 0) > 0,
          `${table} 不得删除其他账户的 reflection run`,
        );
      }
      assert.equal(
        database.prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates
           WHERE id = ?`,
        ).get(alice.candidate.id)?.count,
        0,
      );
      assert.equal(
        database.prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidate_evidence
           WHERE candidate_id = ?`,
        ).get(alice.candidate.id)?.count,
        0,
      );
      assert.equal(
        database.prepare(
          `SELECT COUNT(*) AS count
           FROM memory_reflection_claims
           WHERE first_run_id = ? OR last_run_id = ?`,
        ).get(removedRunId, removedRunId)?.count,
        0,
      );
      assert.equal(
        database.prepare('PRAGMA foreign_key_check').all().length,
        0,
      );
    };
    assertReflectionClosure(
      fixture.database,
      alice.run.id,
      bob.run.id,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT last_ingest_seq
         FROM memory_reflection_checkpoints
         WHERE user_id = 'alice' AND namespace = 'personal'
           AND run_type = 'reflect'`,
      ).get()?.last_ingest_seq,
      0,
    );
    const managedBackup = new DatabaseSync(managedBackupPath, {
      readOnly: true,
    });
    try {
      assertReflectionClosure(
        managedBackup,
        alice.run.id,
        bob.run.id,
      );
      assert.equal(
        managedBackup.prepare(
          `SELECT last_ingest_seq
           FROM memory_reflection_checkpoints
           WHERE user_id = 'alice' AND namespace = 'personal'
             AND run_type = 'reflect'`,
        ).get()?.last_ingest_seq,
        0,
      );
    } finally {
      managedBackup.close();
    }
    const mainDatabasePath = path.join(
      fixture.directory,
      'test.sqlite3',
    );
    assertArtifactsExcludeTextVariants(
      [
        mainDatabasePath,
        `${mainDatabasePath}-wal`,
        `${mainDatabasePath}-shm`,
        managedBackupPath,
        `${managedBackupPath}-wal`,
        `${managedBackupPath}-shm`,
      ],
      secretText,
    );
  } finally {
    fixture.close();
  }
});

test('物理清除覆盖正文、候选、版本、证据、索引和派生摘要', async () => {
  const fixture = createFixture();
  try {
    const secretText = '罅燚龘靐齉麤爩鱻麷';
    const exchange = fixture.lifecycleStore.recordCompletedExchange({
      clientName: 'client',
      sessionExternalId: 'purge-session',
      userTurnExternalId: 'purge-turn',
      userContent: `用户自然提到了 ${secretText}。`,
      assistantTurnExternalId: 'purge-assistant-turn',
      assistantContent: `收到，用户自然提到了 ${secretText}。`,
      assistantMetadata: { respondsTo: 'purge-turn' },
    });
    const turn = exchange.userTurn;
    const episode = new EpisodicMemoryService(
      fixture.database,
    ).materialize({
      userId: 'default',
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });
    new PatternObservationStore(fixture.database).observe({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      claimFingerprint: 'physical-purge-observation',
      kind: 'preference',
      subject: '用户',
      predicate: '物理清除测试',
      value: secretText,
      negated: false,
      turnId: turn.id,
      excerpt: secretText,
      runId: null,
      state: 'supporting',
      timestamp: '2026-07-29T00:00:00.000Z',
    });
    const hierarchicalSummary = await new HierarchicalSummaryService(
      fixture.database,
      fixture.memoryStore,
      {
        model: 'qwen2.5:14b',
        promptVersion: 'physical-purge-summary-v1',
        async consolidate(_scope, sources) {
          return {
            sentences: [{
              text: `用户曾提到 ${secretText}。`,
              sourceVersionIds: sources.map(
                (source) => source.memoryVersionId,
              ),
            }],
          };
        },
        async verifySupport(_scope, _sources, sentences) {
          return sentences.map((_sentence, sentenceIndex) => ({
            sentenceIndex,
            supported: true,
            rationale: 'physical purge hierarchical fixture',
          }));
        },
      },
    ).summarizeBucket({
      userId: 'default',
      namespace: 'personal',
      summaryType: 'session',
      bucketKey: exchange.sessionId,
      scopeType: 'personal',
      scopeKey: 'self',
      timezoneOffsetMinutes: 480,
    });
    assert.equal(hierarchicalSummary.status, 'created');
    const extractionRunId = fixture.lifecycleStore.startExtraction(
      turn.id,
      'qwen2.5:14b',
      'extract-v1',
    );
    const candidate = fixture.lifecycleStore.completeExtraction(
      extractionRunId,
      [{
        kind: 'preference',
        subject: '用户',
        predicate: '物理清除测试',
        value: secretText,
        content: `用户的物理清除测试值是 ${secretText}。`,
        confidence: 0.99,
        importance: 0.9,
      }],
    )[0];
    const target = fixture.memoryStore.remember({
      kind: 'preference',
      content: `用户的物理清除测试值是 ${secretText}。`,
      stableKey: candidate.normalizedKey,
      predicateKey: candidate.normalizedKey,
      normalizedValue: secretText,
      normalizedValueHash: candidate.normalizedHash,
      evidenceTurnId: turn.id,
      evidenceExcerpt: turn.content,
      source: 'automatic-extraction',
    }).memory;
    fixture.lifecycleStore.updateCandidateState(
      candidate.id,
      'accepted',
      'test',
      target.id,
    );
    const actionRequestId =
      '11111111-1111-4111-8111-111111111190';
    fixture.database
      .prepare(
        `INSERT INTO memory_action_requests (
           id, user_id, namespace, request_key, action, status,
           target_query, target_memory_id, candidate_id, turn_id,
           candidate_json, confidence, sensitivity, model,
           prompt_version, rationale, error, created_at
         ) VALUES (
           ?, 'default', 'personal', ?, 'correct', 'failed',
           ?, ?, ?, ?, ?, 0.99, 'normal', 'qwen2.5:14b',
           'explicit-memory-intent-v2', ?, ?, ?
         )`,
      )
      .run(
        actionRequestId,
        `purge-action:${candidate.id}`,
        `纠正 ${secretText}`,
        target.id,
        candidate.id,
        turn.id,
        JSON.stringify({
          content: `候选正文 ${secretText}`,
          value: secretText,
          sourceExcerpt: `来源片段 ${secretText}`,
        }),
        `动作理由 ${secretText}`,
        `失败详情 ${secretText}`,
        new Date().toISOString(),
      );
    fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户还偏好本地优先的软件。',
      stableKey: '用户::软件部署偏好',
      predicateKey: '用户::软件部署偏好',
      source: 'automatic-extraction',
    });
    const provider: ConsolidationProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'consolidate-v1',
      async consolidate(_scope, sources) {
        return {
          sentences: [{
            text: `用户的偏好包含 ${secretText} 和本地优先。`,
            sourceVersionIds: sources.map(
              (source) => source.memoryVersionId,
            ),
          }],
        };
      },
      async verifySupport(_scope, _sources, sentences) {
        return sentences.map((_sentence, sentenceIndex) => ({
          sentenceIndex,
          supported: true,
          rationale: 'deterministic governance fixture',
        }));
      },
    };
    const consolidator = new MemoryConsolidator(
      fixture.database,
      fixture.lifecycleStore,
      fixture.memoryStore,
      provider,
    );
    const derived = await consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });
    const semanticStore = new MemoryStore(fixture.database, {
      embeddingModel: 'test-model',
      rerankModel: 'test-reranker',
      async embed(texts) {
        return texts.map(() => Float32Array.of(1));
      },
      async rerank(_query, candidates) {
        return candidates.map((candidate) => ({
          id: candidate.id,
          relevant: true,
          confidence: 1,
          reason: 'governance fixture',
        }));
      },
    });
    let denseBackfill = await semanticStore.backfillDenseIndex();
    while (!denseBackfill.complete) {
      denseBackfill = await semanticStore.backfillDenseIndex();
    }
    const managedBackupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(managedBackupDirectory);
    const managedBackupPath = path.join(
      managedBackupDirectory,
      'test-schema-22-to-23-governance.sqlite3',
    );

    const purge = fixture.governance.queuePurge(
      target.id,
      `清除 ${secretText}`,
    );
    fixture.database
      .prepare('VACUUM INTO ?')
      .run(managedBackupPath);
    assert.equal(
      fileContainsTextIgnoringCompatibilityAndCase(
        managedBackupPath,
        secretText,
      ),
      true,
      '清除前的受管备份必须实际包含测试明文',
    );
    assert.equal(
      purge.purgeBoundary.managedMigrationBackups,
      true,
    );
    assert.equal(
      purge.purgeBoundary.externalExportCopies,
      false,
    );
    assert.match(purge.purgeBoundary.notice, /自行下载/u);
    const completed = fixture.governance.processPurgeJob(
      purge.id,
      'purge-worker',
    );

    assert.equal(completed.status, 'completed');
    assert.match(completed.reason, /^purged:/u);
    assert.equal(fixture.memoryStore.get(target.id, true), null);
    assert.equal(
      fixture.memoryStore.get(derived.memoryId!, true),
      null,
    );
    assert.equal(fixture.memoryStore.get(episode.memoryId, true), null);
    assert.equal(
      fixture.memoryStore.get(hierarchicalSummary.memoryId!, true),
      null,
    );
    assert.equal(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count FROM memory_pattern_observations
         WHERE turn_id = ? OR value_text LIKE ? OR excerpt LIKE ?`,
      ).get(turn.id, `%${secretText}%`, `%${secretText}%`)?.count,
      0,
    );
    const clearedQueries = [
      {
        label: 'memories',
        sql: 'SELECT COUNT(*) AS count FROM memories WHERE id IN (?, ?)',
        values: [target.id, derived.memoryId!],
      },
      {
        label: 'memory_items',
        sql:
          'SELECT COUNT(*) AS count FROM memory_items WHERE id IN (?, ?)',
        values: [target.id, derived.memoryId!],
      },
      {
        label: 'memory_versions',
        sql:
          'SELECT COUNT(*) AS count FROM memory_versions ' +
          'WHERE memory_item_id IN (?, ?)',
        values: [target.id, derived.memoryId!],
      },
      {
        label: 'memory_evidence',
        sql:
          'SELECT COUNT(*) AS count FROM memory_evidence WHERE turn_id = ?',
        values: [turn.id],
      },
      {
        label: 'memory_embeddings',
        sql:
          'SELECT COUNT(*) AS count FROM memory_embeddings ' +
          'WHERE memory_id IN (?, ?)',
        values: [target.id, derived.memoryId!],
      },
      {
        label: 'memory_ann_index',
        sql:
          'SELECT COUNT(*) AS count FROM memory_ann_index ' +
          'WHERE memory_id IN (?, ?)',
        values: [target.id, derived.memoryId!],
      },
      {
        label: 'memory_term_index',
        sql:
          'SELECT COUNT(*) AS count FROM memory_term_index ' +
          'WHERE memory_id IN (?, ?)',
        values: [target.id, derived.memoryId!],
      },
      {
        label: 'derived_consolidations',
        sql:
          'SELECT COUNT(*) AS count FROM derived_consolidations ' +
          'WHERE memory_id IN (?, ?)',
        values: [target.id, derived.memoryId!],
      },
    ];
    for (const query of clearedQueries) {
      assert.equal(
        fixture.database
          .prepare(query.sql)
          .get(...query.values)?.count,
        0,
        query.label,
      );
    }
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates
           WHERE id = ?`,
        )
        .get(candidate.id)?.count,
      0,
    );
    assert.equal(
      fixture.lifecycleStore.getTurn(turn.id)?.content,
      '[purged]',
    );
    assert.equal(
      fixture.lifecycleStore.getTurn(exchange.assistantTurn.id)
        ?.content,
      '[purged]',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memories_fts
           WHERE memory_id IN (?, ?)`,
        )
        .get(target.id, derived.memoryId!)?.count,
      0,
    );
    const tombstone = fixture.database
      .prepare(
        `SELECT memory_item_id, stable_key, content_hash, kind,
                normalized_key, normalized_value,
                semantic_fingerprint, reason
         FROM memory_tombstones
         WHERE content_hash = ? AND restored_at IS NULL`,
      )
      .get(target.checksum);
    assert.ok(tombstone);
    assert.equal(tombstone.memory_item_id, null);
    assert.equal(tombstone.stable_key, null);
    assert.equal(tombstone.normalized_key, null);
    assert.equal(tombstone.normalized_value, null);
    assert.equal(tombstone.content_hash, target.checksum);
    assert.equal(tombstone.kind, 'preference');
    assert.ok(tombstone.semantic_fingerprint);
    assert.match(String(tombstone.reason), /^purged:[0-9a-f]{64}$/u);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM audit_log
           WHERE detail_json LIKE ?`,
        )
        .get(`%${secretText}%`)?.count,
      0,
    );
    const actionRequest = fixture.database
      .prepare(
        `SELECT *
         FROM memory_action_requests
         WHERE id = ?`,
      )
      .get(actionRequestId);
    assert.equal(actionRequest?.status, 'rejected');
    assert.equal(actionRequest?.target_query, '[purged]');
    assert.equal(actionRequest?.target_memory_id, null);
    assert.equal(actionRequest?.candidate_id, null);
    assert.equal(actionRequest?.turn_id, null);
    assert.equal(actionRequest?.candidate_json, null);
    assert.equal(actionRequest?.rationale, 'physical_purge');
    assert.equal(actionRequest?.error, null);
    for (const table of [
      ['memory_events', 'payload_json'],
      ['outbox_events', 'payload_json'],
      ['purge_jobs', 'reason'],
    ] as const) {
      assert.equal(
        fixture.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM ${table[0]}
             WHERE ${table[1]} LIKE ?`,
          )
          .get(`%${secretText}%`)?.count,
        0,
        `${table[0]}.${table[1]}`,
      );
    }
    const purgeAudit = fixture.database
      .prepare(
        `SELECT detail_json
         FROM audit_log
         WHERE action = 'physical_purge'
         ORDER BY row_id DESC
         LIMIT 1`,
      )
      .get();
    const purgeAuditDetail = JSON.parse(
      String(purgeAudit?.detail_json || '{}'),
    ) as Record<string, unknown>;
    assert.equal(purgeAuditDetail.managedBackupsScanned, 1);
    assert.equal(purgeAuditDetail.managedBackupsSanitized, 1);
    assert.equal(
      purgeAuditDetail.externalExportCopiesCovered,
      false,
    );

    const managedBackup = new DatabaseSync(
      managedBackupPath,
      { readOnly: true },
    );
    try {
      assert.equal(
        managedBackup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memories
             WHERE id IN (?, ?)`,
          )
          .get(target.id, derived.memoryId!)?.count,
        0,
      );
      assert.equal(
        managedBackup.prepare(
          `SELECT COUNT(*) AS count FROM memories
           WHERE id IN (?, ?)`,
        ).get(episode.memoryId, hierarchicalSummary.memoryId!)?.count,
        0,
      );
      assert.equal(
        managedBackup.prepare(
          `SELECT COUNT(*) AS count FROM memory_pattern_observations
           WHERE turn_id = ? OR value_text LIKE ? OR excerpt LIKE ?`,
        ).get(turn.id, `%${secretText}%`, `%${secretText}%`)?.count,
        0,
      );
      assert.equal(
        managedBackup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_items
             WHERE id IN (?, ?)`,
          )
          .get(target.id, derived.memoryId!)?.count,
        0,
      );
      assert.equal(
        managedBackup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memories_fts
             WHERE memory_id IN (?, ?)`,
          )
          .get(target.id, derived.memoryId!)?.count,
        0,
      );
      const backupAction = managedBackup
        .prepare(
          `SELECT target_query, target_memory_id, candidate_id,
                  turn_id, candidate_json, rationale, error
           FROM memory_action_requests
           WHERE id = ?`,
        )
        .get(actionRequestId);
      assert.equal(backupAction?.target_query, '[purged]');
      assert.equal(backupAction?.target_memory_id, null);
      assert.equal(backupAction?.candidate_id, null);
      assert.equal(backupAction?.turn_id, null);
      assert.equal(backupAction?.candidate_json, null);
      assert.equal(backupAction?.rationale, 'physical_purge');
      assert.equal(backupAction?.error, null);
      assert.equal(
        managedBackup
          .prepare(
            `SELECT content
             FROM conversation_turns
             WHERE id = ?`,
          )
          .get(turn.id)?.content,
        '[purged]',
      );
      assert.equal(
        managedBackup
          .prepare(
            `SELECT content
             FROM conversation_turns
             WHERE id = ?`,
          )
          .get(exchange.assistantTurn.id)?.content,
        '[purged]',
      );
      const backupTombstone = managedBackup
        .prepare(
          `SELECT memory_item_id, stable_key, content_hash, kind,
                  normalized_key, normalized_value,
                  semantic_fingerprint, reason
           FROM memory_tombstones
           WHERE content_hash = ? AND restored_at IS NULL`,
        )
        .get(target.checksum);
      assert.ok(backupTombstone);
      assert.equal(backupTombstone.memory_item_id, null);
      assert.equal(backupTombstone.stable_key, null);
      assert.equal(backupTombstone.normalized_key, null);
      assert.equal(backupTombstone.normalized_value, null);
      assert.equal(backupTombstone.kind, 'preference');
      assert.ok(backupTombstone.semantic_fingerprint);
      assert.match(
        String(backupTombstone.reason),
        /^purged:[0-9a-f]{64}$/u,
      );
      assert.equal(
        managedBackup
          .prepare('PRAGMA foreign_key_check')
          .all().length,
        0,
      );
    } finally {
      managedBackup.close();
    }
    const mainDatabasePath = path.join(
      fixture.directory,
      'test.sqlite3',
    );
    assertArtifactsExcludeTextVariants(
      [
        mainDatabasePath,
        `${mainDatabasePath}-wal`,
        `${mainDatabasePath}-shm`,
        managedBackupPath,
        `${managedBackupPath}-wal`,
        `${managedBackupPath}-shm`,
      ],
      secretText,
    );
    assertArtifactsExcludeFtsTrigrams(
      [
        mainDatabasePath,
        `${mainDatabasePath}-wal`,
        `${mainDatabasePath}-shm`,
        managedBackupPath,
        `${managedBackupPath}-wal`,
        `${managedBackupPath}-shm`,
      ],
      secretText,
    );
  } finally {
    fixture.close();
  }
});

function probeManagedBackupPrincipalIsolation() {
  const fixture = createFixture();
  const actionId = '22222222-2222-4222-8222-222222222222';
  const eventId = '33333333-3333-4333-8333-333333333333';
  const auditId = 9_001;
  const readRows = (database: DatabaseSync) => ({
    action: {
      ...database
        .prepare(
          `SELECT user_id, namespace, status, target_memory_id,
                  candidate_json
           FROM memory_action_requests
           WHERE id = ?`,
        )
        .get(actionId),
    },
    event: {
      ...database
        .prepare(
          `SELECT user_id, memory_item_id, payload_json
           FROM memory_events
           WHERE id = ?`,
        )
        .get(eventId),
    },
    audit: {
      ...database
        .prepare(
          `SELECT user_id, memory_id, detail_json
           FROM audit_log
           WHERE user_id = 'bob' AND id = ?`,
        )
        .get(auditId),
    },
  });

  try {
    const alice = fixture.memoryStore.remember({
      userId: 'alice',
      namespace: 'shared-fixture',
      kind: 'preference',
      content: 'Alice 的待清除记忆。',
      stableKey: 'alice::managed-backup-boundary',
    }).memory;
    const bob = fixture.memoryStore.remember({
      userId: 'bob',
      namespace: 'shared-fixture',
      kind: 'preference',
      content: 'Bob 的独立记忆。',
      stableKey: 'bob::managed-backup-boundary',
    }).memory;
    const timestamp = new Date('2026-07-29T00:00:00.000Z')
      .toISOString();
    fixture.database
      .prepare(
        `INSERT INTO memory_action_requests (
           id, user_id, namespace, request_key, action, status,
           target_query, target_memory_id, candidate_json,
           confidence, sensitivity, model, prompt_version,
           rationale, created_at
         ) VALUES (
           ?, 'bob', 'shared-fixture', ?, 'forget', 'pending',
           ?, ?, ?, 0.99, 'normal', 'qwen2.5:14b',
           'principal-isolation-v1', ?, ?
         )`,
      )
      .run(
        actionId,
        `bob-action:${actionId}`,
        'Bob 的合法动作只引用 Alice UUID 作为普通文本。',
        bob.id,
        JSON.stringify({ quotedMemoryId: alice.id }),
        'Bob 动作不属于 Alice。',
        timestamp,
      );
    fixture.database
      .prepare(
        `INSERT INTO memory_events (
           id, memory_item_id, user_id, event_type, payload_json,
           created_at
         ) VALUES (?, ?, 'bob', 'bob_note', ?, ?)`,
      )
      .run(
        eventId,
        bob.id,
        JSON.stringify({
          note: `Bob 的合法事件只引用 ${alice.id} 作为普通文本。`,
        }),
        timestamp,
      );
    fixture.database
      .prepare(
        `INSERT INTO audit_log (
           id, action, memory_id, user_id, detail_json, created_at
         ) VALUES (?, 'bob_note', ?, 'bob', ?, ?)`,
      )
      .run(
        auditId,
        bob.id,
        JSON.stringify({
          note: `Bob 的合法审计只引用 ${alice.id} 作为普通文本。`,
        }),
        timestamp,
      );
    const before = readRows(fixture.database);
    const purge = fixture.governance.queuePurge(
      alice.id,
      'Alice 主动清除自己的记忆。',
      'alice',
    );
    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const backupPath = path.join(
      backupDirectory,
      'test-schema-non-outbox-principal-boundary.sqlite3',
    );
    fixture.database.prepare('VACUUM INTO ?').run(backupPath);

    const completed = fixture.governance.processPurgeJob(
      purge.id,
      'non-outbox-principal-worker',
    );
    assert.equal(completed.status, 'completed');
    const main = readRows(fixture.database);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      return {
        before,
        main,
        managedBackup: readRows(backup),
      };
    } finally {
      backup.close();
    }
  } finally {
    fixture.close();
  }
}

test('物理清除不会改写其他账户的合法 action request', () => {
  const rows = probeManagedBackupPrincipalIsolation();
  assert.deepEqual(
    rows.main.action,
    rows.before.action,
    '主库不得改写 Bob action request',
  );
  assert.deepEqual(
    rows.managedBackup.action,
    rows.before.action,
    '受管备份不得改写 Bob action request',
  );
});

test('物理清除不会改写其他账户的合法 memory event', () => {
  const rows = probeManagedBackupPrincipalIsolation();
  assert.deepEqual(
    rows.main.event,
    rows.before.event,
    '主库不得改写 Bob memory event',
  );
  assert.deepEqual(
    rows.managedBackup.event,
    rows.before.event,
    '受管备份不得改写 Bob memory event',
  );
});

test('物理清除不会改写其他账户的合法 audit log', () => {
  const rows = probeManagedBackupPrincipalIsolation();
  assert.deepEqual(
    rows.main.audit,
    rows.before.audit,
    '主库不得改写 Bob audit log',
  );
  assert.deepEqual(
    rows.managedBackup.audit,
    rows.before.audit,
    '受管备份不得改写 Bob audit log',
  );
});

test('物理清除不会完成其他账户的合法 outbox，受管备份同样隔离', () => {
  const fixture = createFixture();
  try {
    const alice = fixture.memoryStore.remember({
      userId: 'alice',
      namespace: 'shared-fixture',
      kind: 'preference',
      content: 'Alice 的待清除记忆。',
      stableKey: 'alice::purge-boundary',
    }).memory;
    const bob = fixture.memoryStore.remember({
      userId: 'bob',
      namespace: 'shared-fixture',
      kind: 'preference',
      content: 'Bob 的独立记忆。',
      stableKey: 'bob::purge-boundary',
    }).memory;
    fixture.memoryStore.forget(
      bob.id,
      `Bob 的删除理由仅将 ${alice.id} 当作普通文本。`,
      'bob',
    );
    const bobOutboxBefore = fixture.database
      .prepare(
        `SELECT id, user_id, namespace, status, payload_json
         FROM outbox_events
         WHERE user_id = 'bob' AND payload_json LIKE ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(`%${alice.id}%`);
    assert.ok(bobOutboxBefore);

    const purge = fixture.governance.queuePurge(
      alice.id,
      'Alice 主动清除自己的记忆。',
      'alice',
    );
    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const backupPath = path.join(
      backupDirectory,
      'test-schema-outbox-principal-boundary.sqlite3',
    );
    fixture.database.prepare('VACUUM INTO ?').run(backupPath);

    const completed = fixture.governance.processPurgeJob(
      purge.id,
      'outbox-principal-worker',
    );
    assert.equal(completed.status, 'completed');
    const mainOutboxAfter = fixture.database
      .prepare(
        `SELECT id, user_id, namespace, status, payload_json
         FROM outbox_events
         WHERE id = ?`,
      )
      .get(bobOutboxBefore.id);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const backupOutboxAfter = backup
        .prepare(
          `SELECT id, user_id, namespace, status, payload_json
           FROM outbox_events
           WHERE id = ?`,
        )
        .get(bobOutboxBefore.id);
      assert.deepEqual(
        {
          main: { ...mainOutboxAfter },
          managedBackup: { ...backupOutboxAfter },
        },
        {
          main: { ...bobOutboxBefore },
          managedBackup: { ...bobOutboxBefore },
        },
      );
    } finally {
      backup.close();
    }
  } finally {
    fixture.close();
  }
});

test('物理清除候选匹配严格限定任务 user_id 与 namespace', () => {
  const fixture = createFixture();
  const createCandidate = (
    userId: string,
    namespace: string,
    suffix: string,
  ) => {
    const exchange = fixture.lifecycleStore.recordCompletedExchange({
      userId,
      namespace,
      clientName: `candidate-scope-${suffix}`,
      sessionExternalId: `session-${suffix}`,
      userTurnExternalId: `user-${suffix}`,
      userContent: `用户候选隔离测试 ${suffix}。`,
      assistantTurnExternalId: `assistant-${suffix}`,
      assistantContent: `收到候选隔离测试 ${suffix}。`,
    });
    const runId = fixture.lifecycleStore.startExtraction(
      exchange.userTurn.id,
      'qwen2.5:14b',
      `candidate-scope-${suffix}`,
    );
    return fixture.lifecycleStore.completeExtraction(runId, [{
      kind: 'preference',
      subject: '用户',
      predicate: '共享候选键',
      value: `候选值-${suffix}`,
      content: `候选正文-${suffix}`,
      confidence: 0.99,
      importance: 0.9,
    }])[0];
  };
  try {
    const targetCandidate =
      createCandidate('default', 'personal', 'target');
    const otherUserCandidate =
      createCandidate('other-user', 'personal', 'other-user');
    const otherNamespaceCandidate =
      createCandidate('default', 'other-space', 'other-namespace');
    const target = fixture.memoryStore.remember({
      userId: 'default',
      namespace: 'personal',
      kind: 'preference',
      content: '用户的共享候选键需要被清除。',
      stableKey: targetCandidate.stableKey,
      predicateKey: targetCandidate.normalizedKey,
      normalizedValue: targetCandidate.value,
      normalizedValueHash: targetCandidate.normalizedHash,
      source: 'automatic-extraction',
    }).memory;
    fixture.lifecycleStore.updateCandidateState(
      targetCandidate.id,
      'accepted',
      'candidate scope purge fixture',
      target.id,
    );
    const queued = fixture.governance.queuePurge(target.id);
    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const backupPath = path.join(
      backupDirectory,
      'test-schema-candidate-scope.sqlite3',
    );
    fixture.database.prepare('VACUUM INTO ?').run(backupPath);

    const completed = fixture.governance.processPurgeJob(
      queued.id,
      'candidate-scope-worker',
    );
    assert.equal(completed.status, 'completed');
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_candidates
           WHERE id = ?`,
        )
        .get(targetCandidate.id)?.count,
      0,
    );
    assert.deepEqual(
      (
        fixture.database
        .prepare(
          `SELECT id, user_id, namespace, content
           FROM memory_candidates
           WHERE id IN (?, ?)
           ORDER BY id`,
        )
        .all(
          otherUserCandidate.id,
          otherNamespaceCandidate.id,
        ),
      ).map((row) => ({ ...row })),
      [otherUserCandidate, otherNamespaceCandidate]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((candidate) => ({
          id: candidate.id,
          user_id: candidate.userId,
          namespace: candidate.namespace,
          content: candidate.content,
        })),
    );

    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(
        backup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_candidates
             WHERE id = ?`,
          )
          .get(targetCandidate.id)?.count,
        0,
      );
      assert.deepEqual(
        (
          backup
          .prepare(
            `SELECT id, user_id, namespace, content
             FROM memory_candidates
             WHERE id IN (?, ?)
             ORDER BY id`,
          )
          .all(
            otherUserCandidate.id,
            otherNamespaceCandidate.id,
          ),
        ).map((row) => ({ ...row })),
        [otherUserCandidate, otherNamespaceCandidate]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((candidate) => ({
            id: candidate.id,
            user_id: candidate.userId,
            namespace: candidate.namespace,
            content: candidate.content,
          })),
      );
    } finally {
      backup.close();
    }
  } finally {
    fixture.close();
  }
});

test('级联清除会擦除全部目标 tombstone 明文并保留不可逆指纹', async () => {
  const fixture = createFixture();
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-cascade-tombstone-v1',
    async consolidate(_scope, sources) {
      return {
        sentences: [{
          text: sources.map((source) => source.content).join(' '),
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic cascade tombstone fixture',
      }));
    },
  };
  try {
    const source = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户偏好本地优先。',
      stableKey: '用户::部署方式',
      predicateKey: '用户::部署方式',
      normalizedValue: '本地优先',
      normalizedValueHash: 'cascade-local-first',
      source: 'automatic-extraction',
    }).memory;
    fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户部署服务时始终选择本地优先。',
      stableKey: '用户::部署方式::第二观察',
      predicateKey: '用户::部署方式',
      normalizedValue: '本地优先',
      normalizedValueHash: 'cascade-local-first',
      source: 'automatic-extraction',
    });
    const consolidator = new MemoryConsolidator(
      fixture.database,
      fixture.lifecycleStore,
      fixture.memoryStore,
      provider,
    );
    const derived = await consolidator.consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });
    assert.equal(derived.status, 'created');
    fixture.memoryStore.forget(
      derived.memoryId!,
      '先忘记派生摘要以生成第二个 tombstone',
    );
    const queued = fixture.governance.queuePurge(
      source.id,
      '级联 tombstone 明文清除',
    );
    const targetIds = [source.id, derived.memoryId!];
    const tombstoneRows = fixture.database
      .prepare(
        `SELECT id, memory_item_id
         FROM memory_tombstones
         WHERE memory_item_id IN (?, ?)
         ORDER BY id`,
      )
      .all(...targetIds) as Array<Record<string, unknown>>;
    assert.equal(tombstoneRows.length, 2);
    const markers = tombstoneRows.map(
      (_row, index) => `罕见墓碑明文-${index}-燚龘靐`,
    );
    for (const [index, row] of tombstoneRows.entries()) {
      fixture.database
        .prepare(
          `UPDATE memory_tombstones
           SET stable_key = ?,
               normalized_key = ?,
               normalized_value = ?,
               semantic_fingerprint = NULL
           WHERE id = ?`,
        )
        .run(
          `personal::self::用户::${markers[index]}`,
          `用户::${markers[index]}`,
          markers[index],
          row.id,
        );
    }
    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const backupPath = path.join(
      backupDirectory,
      'test-schema-cascade-tombstones.sqlite3',
    );
    fixture.database.prepare('VACUUM INTO ?').run(backupPath);

    const completed = fixture.governance.processPurgeJob(
      queued.id,
      'cascade-tombstone-worker',
    );
    assert.equal(completed.status, 'completed');
    const tombstoneIds = tombstoneRows.map((row) => String(row.id));
    const assertSanitizedTombstones = (database: DatabaseSync) => {
      const rows = database
        .prepare(
          `SELECT id, memory_item_id, stable_key, normalized_key,
                  normalized_value, semantic_fingerprint
           FROM memory_tombstones
           WHERE id IN (?, ?)
           ORDER BY id`,
        )
        .all(...tombstoneIds) as Array<Record<string, unknown>>;
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.memory_item_id, null);
        assert.equal(row.stable_key, null);
        assert.equal(row.normalized_key, null);
        assert.equal(row.normalized_value, null);
        const fingerprint = JSON.parse(
          String(row.semantic_fingerprint),
        ) as Record<string, unknown>;
        assert.equal(fingerprint.version, 1);
        for (const marker of markers) {
          assert.equal(
            String(row.semantic_fingerprint).includes(marker),
            false,
          );
        }
      }
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_items
             WHERE id IN (?, ?)`,
          )
          .get(...targetIds)?.count,
        0,
      );
    };
    assertSanitizedTombstones(fixture.database);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assertSanitizedTombstones(backup);
    } finally {
      backup.close();
    }
    const mainPath = path.join(fixture.directory, 'test.sqlite3');
    for (const marker of markers) {
      assertArtifactsExcludeTextVariants(
        [
          mainPath,
          `${mainPath}-wal`,
          `${mainPath}-shm`,
          backupPath,
          `${backupPath}-wal`,
          `${backupPath}-shm`,
        ],
        marker,
      );
    }
  } finally {
    fixture.close();
  }
});

test('来源完全退出 source-set 后物理清除共享派生记忆的全部历史且可重建剩余来源', async () => {
  const fixture = createFixture();
  const historicalMarker = '罕见派生历史标记燚龘靐';
  const provider: ConsolidationProvider = {
    model: 'qwen2.5:14b',
    promptVersion: 'consolidate-purge-history-v1',
    async consolidate(scope, sources) {
      return {
        sentences: [{
          text: [
            scope.namespace === 'unrelated'
              ? '保留无关派生标记'
              : '',
            sources
              .map((source) => source.content)
              .join(' '),
          ].filter(Boolean).join(' '),
          sourceVersionIds: sources.map(
            (source) => source.memoryVersionId,
          ),
        }],
      };
    },
    async verifySupport(_scope, _sources, sentences) {
      return sentences.map((_sentence, sentenceIndex) => ({
        sentenceIndex,
        supported: true,
        rationale: 'deterministic historical purge fixture',
      }));
    },
  };
  try {
    const changedSource = fixture.memoryStore.remember({
      kind: 'preference',
      content: `用户偏好简洁回答，${historicalMarker}。`,
      stableKey: '用户::回答风格',
      predicateKey: '用户::回答风格',
      normalizedValue: '简洁回答',
      normalizedValueHash: 'concise-answer-style',
      source: 'automatic-extraction',
    }).memory;
    const retainedSource = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户一直偏好简洁回答。',
      stableKey: '用户::回答风格::第二观察',
      predicateKey: '用户::回答风格',
      normalizedValue: '简洁回答',
      normalizedValueHash: 'concise-answer-style',
      source: 'automatic-extraction',
    }).memory;
    const scope = {
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic' as const,
      scopeKey: 'kind:preference',
    };
    const firstConsolidator = new MemoryConsolidator(
      fixture.database,
      fixture.lifecycleStore,
      fixture.memoryStore,
      provider,
    );
    const initial = await firstConsolidator.consolidateScope(scope);
    const initialSourceVersionIds = (
      fixture.database
        .prepare(
          `SELECT memory_version_id
           FROM derived_consolidation_sources
           WHERE consolidation_id = ?
           ORDER BY memory_version_id`,
        )
        .all(initial.consolidationId!) as Array<Record<string, unknown>>
    ).map((row) => String(row.memory_version_id));
    fixture.governance.archiveMemory(
      changedSource.id,
      '来源完全退出巩固集合',
    );
    const addedSource = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户要求回答保持简洁。',
      stableKey: '用户::回答风格::第三观察',
      predicateKey: '用户::回答风格',
      normalizedValue: '简洁回答',
      normalizedValueHash: 'concise-answer-style',
      source: 'automatic-extraction',
    }).memory;
    const upgraded = await firstConsolidator.consolidateScope(scope);
    assert.equal(initial.status, 'created');
    assert.equal(upgraded.status, 'rebuilt');
    assert.equal(upgraded.memoryId, initial.memoryId);
    assert.notEqual(
      upgraded.consolidationId,
      initial.consolidationId,
    );
    const upgradedSourceVersionIds = (
      fixture.database
        .prepare(
          `SELECT memory_version_id
           FROM derived_consolidation_sources
           WHERE consolidation_id = ?
           ORDER BY memory_version_id`,
        )
        .all(upgraded.consolidationId!) as Array<Record<string, unknown>>
    ).map((row) => String(row.memory_version_id));
    assert.notDeepEqual(
      upgradedSourceVersionIds,
      initialSourceVersionIds,
    );
    const retiredVersionIds = (
      fixture.database
        .prepare(
          `SELECT id
           FROM memory_versions
           WHERE memory_item_id = ?`,
        )
        .all(changedSource.id) as Array<Record<string, unknown>>
    ).map((row) => String(row.id));
    assert.ok(
      initialSourceVersionIds.some((id) =>
        retiredVersionIds.includes(id),
      ),
    );
    assert.equal(
      upgradedSourceVersionIds.some((id) =>
        retiredVersionIds.includes(id),
      ),
      false,
      '已归档来源必须完全退出新一代 source-set',
    );
    assert.deepEqual(
      (
        fixture.database
          .prepare(
            `SELECT memory_version_id
             FROM derived_consolidation_sources
             WHERE consolidation_id = ?
             ORDER BY memory_version_id`,
          )
          .all(initial.consolidationId!) as Array<Record<string, unknown>>
      ).map((row) => String(row.memory_version_id)),
      initialSourceVersionIds,
      '同 provider 重建后旧 projection 的来源代次必须不可覆盖',
    );

    fixture.memoryStore.remember({
      userId: 'default',
      namespace: 'unrelated',
      kind: 'preference',
      content: '无关用户偏好使用键盘操作。',
      stableKey: '无关用户::输入方式',
      predicateKey: '无关用户::输入方式',
      normalizedValue: '键盘操作',
      normalizedValueHash: 'unrelated-keyboard-input',
      source: 'automatic-extraction',
    });
    fixture.memoryStore.remember({
      userId: 'default',
      namespace: 'unrelated',
      kind: 'preference',
      content: '无关用户一直偏好使用键盘操作。',
      stableKey: '无关用户::输入方式::第二观察',
      predicateKey: '无关用户::输入方式',
      normalizedValue: '键盘操作',
      normalizedValueHash: 'unrelated-keyboard-input',
      source: 'automatic-extraction',
    });
    const unrelated = await firstConsolidator.consolidateScope({
      ...scope,
      namespace: 'unrelated',
    });
    assert.equal(unrelated.status, 'created');

    const historicalSentenceIds = (
      fixture.database
        .prepare(
          `SELECT id
           FROM derived_consolidation_sentences
           WHERE consolidation_id IN (?, ?)
           ORDER BY id`,
        )
        .all(
          initial.consolidationId!,
          upgraded.consolidationId!,
        ) as Array<Record<string, unknown>>
    ).map((row) => String(row.id));
    assert.equal(historicalSentenceIds.length, 2);
    assert.deepEqual(
      {
        ...fixture.database
        .prepare(
          `SELECT memory_id, status
           FROM derived_consolidations
           WHERE id = ?`,
        )
        .get(initial.consolidationId!),
      },
      { memory_id: null, status: 'stale' },
    );
    assert.deepEqual(
      {
        ...fixture.database
        .prepare(
          `SELECT memory_id, status
           FROM derived_consolidations
           WHERE id = ?`,
        )
        .get(upgraded.consolidationId!),
      },
      { memory_id: upgraded.memoryId, status: 'active' },
    );
    const sharedDerivedVersions = fixture.database
      .prepare(
        `SELECT version, content, source_ref
         FROM memory_versions
         WHERE memory_item_id = ?
         ORDER BY version`,
      )
      .all(upgraded.memoryId!) as Array<Record<string, unknown>>;
    assert.equal(sharedDerivedVersions.length, 2);
    assert.match(
      String(sharedDerivedVersions[0]?.content),
      new RegExp(historicalMarker, 'u'),
    );
    assert.equal(
      sharedDerivedVersions[0]?.source_ref,
      `consolidation:${initial.consolidationId}`,
    );
    assert.doesNotMatch(
      String(sharedDerivedVersions[1]?.content),
      new RegExp(historicalMarker, 'u'),
    );
    assert.equal(
      sharedDerivedVersions[1]?.source_ref,
      `consolidation:${upgraded.consolidationId}`,
    );

    const managedBackupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(managedBackupDirectory);
    const managedBackupPath = path.join(
      managedBackupDirectory,
      'test-schema-derived-history.sqlite3',
    );
    const queued = fixture.governance.queuePurge(
      changedSource.id,
      '清除旧来源及其全部派生摘要历史',
    );
    fixture.database
      .prepare('VACUUM INTO ?')
      .run(managedBackupPath);
    const retryBackup = new DatabaseSync(managedBackupPath);
    try {
      retryBackup.exec(`
        CREATE TRIGGER fail_shared_projection_purge_once
        BEFORE DELETE ON derived_consolidations
        BEGIN
          SELECT RAISE(ABORT, 'shared projection retry fixture');
        END;
      `);
    } finally {
      retryBackup.close();
    }
    assert.throws(
      () => fixture.governance.processPurgeJob(
        queued.id,
        'historical-purge-worker',
      ),
      /shared projection retry fixture/u,
    );
    const failedBackup = new DatabaseSync(managedBackupPath);
    try {
      assert.equal(
        failedBackup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM derived_consolidations
             WHERE id IN (?, ?)`,
          )
          .get(
            initial.consolidationId!,
            upgraded.consolidationId!,
          )?.count,
        2,
        '备份闭包失败必须回滚全部 projection 删除',
      );
      failedBackup.exec(
        'DROP TRIGGER fail_shared_projection_purge_once',
      );
    } finally {
      failedBackup.close();
    }
    const completed = fixture.governance.processPurgeJob(
      queued.id,
      'historical-purge-worker',
    );
    assert.equal(completed.status, 'completed');
    assert.equal(
      fixture.governance.processPurgeJob(
        queued.id,
        'historical-purge-worker',
      ).status,
      'completed',
      '已完成物理清除必须幂等',
    );

    const assertHistoricalRowsCleared = (
      database: DatabaseSync,
    ) => {
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM derived_consolidations
             WHERE id IN (?, ?)`,
          )
          .get(
            initial.consolidationId!,
            upgraded.consolidationId!,
          )?.count,
        0,
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM derived_consolidation_sources
             WHERE consolidation_id IN (?, ?)`,
          )
          .get(
            initial.consolidationId!,
            upgraded.consolidationId!,
          )?.count,
        0,
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM derived_consolidation_sentences
             WHERE consolidation_id IN (?, ?)`,
          )
          .get(
            initial.consolidationId!,
            upgraded.consolidationId!,
          )?.count,
        0,
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM derived_sentence_sources
             WHERE sentence_id IN (?, ?)`,
          )
          .get(...historicalSentenceIds)?.count,
        0,
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM derived_consolidations
             WHERE id = ?`,
          )
          .get(unrelated.consolidationId!)?.count,
        1,
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM derived_consolidation_sentences
             WHERE consolidation_id = ?`,
          )
          .get(unrelated.consolidationId!)?.count,
        1,
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_versions
             WHERE content LIKE ?`,
          )
          .get(`%${historicalMarker}%`)?.count,
        0,
        '所有派生历史版本必须清除退出来源的正文',
      );
      assert.equal(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_versions v
             WHERE v.source = 'consolidation'
               AND v.source_ref LIKE 'consolidation:%'
               AND NOT EXISTS (
                 SELECT 1
                 FROM derived_consolidations d
                 WHERE v.source_ref = 'consolidation:' || d.id
               )`,
          )
          .get()?.count,
        0,
        '不得留下指向已删除 projection 的 source_ref',
      );
      assert.equal(
        database
          .prepare('PRAGMA foreign_key_check')
          .all().length,
        0,
      );
    };
    assertHistoricalRowsCleared(fixture.database);
    assert.ok(
      fixture.memoryStore.get(unrelated.memoryId!, true),
    );

    const managedBackup = new DatabaseSync(
      managedBackupPath,
      { readOnly: true },
    );
    try {
      assertHistoricalRowsCleared(managedBackup);
      assert.equal(
        managedBackup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_items
             WHERE id = ?`,
          )
          .get(unrelated.memoryId!)?.count,
        1,
      );
    } finally {
      managedBackup.close();
    }
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_items
           WHERE id IN (?, ?)`,
        )
        .get(retainedSource.id, addedSource.id)?.count,
      2,
      '未被清除的 B+C 原子来源必须保留',
    );
    const rebuildJob = fixture.database
      .prepare(
        `SELECT payload_json
         FROM memory_jobs
         WHERE job_type = 'consolidate_scope'
           AND id LIKE 'consolidate-purge:%'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get();
    assert.ok(rebuildJob, '清除共享派生记忆后必须安排 scope 重建');
    const rebuilt = await firstConsolidator.consolidateScope(
      MemoryConsolidator.scopeFromJobPayload(
        JSON.parse(String(rebuildJob.payload_json)) as
          Record<string, unknown>,
      ),
    );
    assert.equal(rebuilt.status, 'created');
    assert.match(
      fixture.memoryStore.get(rebuilt.memoryId!)?.content || '',
      /一直偏好简洁回答/u,
    );
    assert.match(
      fixture.memoryStore.get(rebuilt.memoryId!)?.content || '',
      /要求回答保持简洁/u,
    );
    assert.doesNotMatch(
      fixture.memoryStore.get(rebuilt.memoryId!)?.content || '',
      new RegExp(historicalMarker, 'u'),
    );
    assertHistoricalRowsCleared(fixture.database);
    const mainDatabasePath = path.join(
      fixture.directory,
      'test.sqlite3',
    );
    assertArtifactsExcludeTextVariants(
      [
        mainDatabasePath,
        `${mainDatabasePath}-wal`,
        `${mainDatabasePath}-shm`,
        managedBackupPath,
        `${managedBackupPath}-wal`,
        `${managedBackupPath}-shm`,
      ],
      historicalMarker,
    );
  } finally {
    fixture.close();
  }
});

test('legacy NULL 指纹在主库和 v23 受管备份清除前回填且清除后仍阻止同义复活', () => {
  const fixture = createFixture();
  try {
    const predicateKey = '用户::软件首次数据';
    const originalValue = '第一次启动不能内置演示数据';
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户要求新软件第一次启动不能内置演示数据。',
      stableKey: `personal::self::${predicateKey}`,
      predicateKey,
      normalizedValue: originalValue,
      normalizedValueHash: 'legacy-first-run-value',
    }).memory;
    const purge = fixture.governance.queuePurge(
      memory.id,
      'legacy 指纹清除测试',
    );
    fixture.database
      .prepare(
        `UPDATE memory_tombstones
         SET semantic_fingerprint = NULL
         WHERE content_hash = ? AND restored_at IS NULL`,
      )
      .run(memory.checksum);

    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const backupPath = path.join(
      backupDirectory,
      'test-schema-23-to-24-legacy-fingerprint.sqlite3',
    );
    fixture.database.prepare('VACUUM INTO ?').run(backupPath);
    const legacyBackup = new DatabaseSync(backupPath);
    try {
      legacyBackup.exec(`
        ALTER TABLE memory_tombstones
          DROP COLUMN semantic_fingerprint;
        PRAGMA user_version = 23;
      `);
    } finally {
      legacyBackup.close();
    }

    const completed = fixture.governance.processPurgeJob(
      purge.id,
      'legacy-fingerprint-worker',
    );
    assert.equal(completed.status, 'completed');
    const mainTombstone = fixture.database
      .prepare(
        `SELECT kind, normalized_key, normalized_value,
                semantic_fingerprint
         FROM memory_tombstones
         WHERE content_hash = ? AND restored_at IS NULL`,
      )
      .get(memory.checksum);
    assert.equal(mainTombstone?.kind, 'preference');
    assert.equal(mainTombstone?.normalized_key, null);
    assert.equal(mainTombstone?.normalized_value, null);
    assert.ok(mainTombstone?.semantic_fingerprint);
    assert.equal(
      String(mainTombstone?.semantic_fingerprint)
        .includes(originalValue),
      false,
    );

    const synonymClaim = {
      userId: 'default',
      namespace: 'personal',
      scopeType: 'personal' as const,
      scopeKey: 'self',
      kind: 'preference' as const,
      content:
        '用户要求新软件首次打开保持为空数据，并且不放演示内容。',
      stableKey: `personal::self::${predicateKey}`,
      normalizedKey: predicateKey,
      normalizedValue: '首次打开为空数据，不放演示内容',
    };
    assert.ok(
      findBlockingTombstone(
        fixture.database,
        synonymClaim,
      ),
    );
    assert.equal(
      findBlockingTombstone(fixture.database, {
        ...synonymClaim,
        content: '用户要求首次打开自动导入最小示例数据。',
        normalizedValue: '首次打开自动导入最小示例数据',
      }),
      null,
    );
    assert.equal(
      findBlockingTombstone(fixture.database, {
        ...synonymClaim,
        scopeType: 'project',
        scopeKey: 'other-project',
        stableKey: `project::other-project::${predicateKey}`,
      }),
      null,
    );

    const sanitizedBackup = new DatabaseSync(
      backupPath,
      { readOnly: true },
    );
    try {
      const backupTombstone = sanitizedBackup
        .prepare(
          `SELECT kind, normalized_key, normalized_value,
                  semantic_fingerprint
           FROM memory_tombstones
           WHERE content_hash = ? AND restored_at IS NULL`,
        )
        .get(memory.checksum);
      assert.equal(backupTombstone?.kind, 'preference');
      assert.equal(backupTombstone?.normalized_key, null);
      assert.equal(backupTombstone?.normalized_value, null);
      assert.ok(backupTombstone?.semantic_fingerprint);
      assert.ok(
        findBlockingTombstone(
          sanitizedBackup,
          synonymClaim,
        ),
      );
      assert.equal(
        findBlockingTombstone(sanitizedBackup, {
          ...synonymClaim,
          content: '用户要求首次打开自动导入最小示例数据。',
          normalizedValue: '首次打开自动导入最小示例数据',
        }),
        null,
      );
      assert.equal(
        findBlockingTombstone(sanitizedBackup, {
          ...synonymClaim,
          scopeType: 'project',
          scopeKey: 'other-project',
          stableKey:
            `project::other-project::${predicateKey}`,
        }),
        null,
      );
    } finally {
      sanitizedBackup.close();
    }
  } finally {
    fixture.close();
  }
});

test('无法重建 active tombstone 指纹时物理清除 fail closed', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户要求物理清除必须保留防复活规则。',
      stableKey:
        'personal::self::用户::物理清除防复活规则',
      predicateKey: '用户::物理清除防复活规则',
      normalizedValue: '必须保留',
      normalizedValueHash: 'fail-closed-value',
    }).memory;
    const purge = fixture.governance.queuePurge(memory.id);
    fixture.database
      .prepare(
        `UPDATE memory_tombstones
         SET memory_item_id = NULL,
             normalized_key = NULL,
             normalized_value = NULL,
             semantic_fingerprint = 'corrupted-fingerprint'
         WHERE content_hash = ? AND restored_at IS NULL`,
      )
      .run(memory.checksum);

    assert.throws(
      () => fixture.governance.processPurgeJob(
        purge.id,
        'fail-closed-worker',
      ),
      /tombstone 指纹回填失败/u,
    );
    assert.ok(fixture.memoryStore.get(memory.id, true));
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_items
           WHERE id = ?`,
        )
        .get(memory.id)?.count,
      1,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT semantic_fingerprint
           FROM memory_tombstones
           WHERE content_hash = ? AND restored_at IS NULL`,
        )
        .get(memory.checksum)?.semantic_fingerprint,
      'corrupted-fingerprint',
    );
  } finally {
    fixture.close();
  }
});

test('tombstone 指纹严格拒绝错误版本、非法摘要、重复 token 和超限数组，并会覆盖与明文不一致的伪造指纹', () => {
  const fixture = createFixture();
  try {
    const predicateKey = '用户::指纹完整性';
    const normalizedValue = '必须校验真实语义';
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户要求 tombstone 指纹必须校验真实语义。',
      stableKey: `personal::self::${predicateKey}`,
      predicateKey,
      normalizedValue,
      normalizedValueHash: 'strict-fingerprint-value',
    }).memory;
    fixture.memoryStore.forget(memory.id, '严格指纹测试');
    const tombstone = fixture.database
      .prepare(
        `SELECT id
         FROM memory_tombstones
         WHERE content_hash = ? AND restored_at IS NULL`,
      )
      .get(memory.checksum);
    const tombstoneId = String(tombstone?.id || '');
    assert.ok(tombstoneId);

    const expectedFingerprint = createSemanticFingerprint(
      predicateKey,
      normalizedValue,
    );
    const forgedFingerprint = createSemanticFingerprint(
      '用户::其他谓词',
      '完全不同的值',
    );
    assert.ok(expectedFingerprint);
    assert.ok(forgedFingerprint);
    fixture.database
      .prepare(
        `UPDATE memory_tombstones
         SET semantic_fingerprint = ?
         WHERE id = ?`,
      )
      .run(forgedFingerprint, tombstoneId);
    backfillTombstoneSemanticFingerprints(fixture.database, {
      tombstoneIds: [tombstoneId],
      requireComplete: true,
    });
    assert.equal(
      fixture.database
        .prepare(
          `SELECT semantic_fingerprint
           FROM memory_tombstones
           WHERE id = ?`,
        )
        .get(tombstoneId)?.semantic_fingerprint,
      expectedFingerprint,
    );

    fixture.database
      .prepare(
        `UPDATE memory_tombstones
         SET memory_item_id = NULL,
             stable_key = NULL,
             normalized_key = NULL,
             normalized_value = NULL
         WHERE id = ?`,
      )
      .run(tombstoneId);
    const valid = JSON.parse(
      expectedFingerprint!,
    ) as Record<string, unknown>;
    const token = 'a'.repeat(64);
    const invalidFingerprints = [
      { ...valid, version: 2 },
      { ...valid, predicateDigest: 'b'.repeat(63) },
      { ...valid, valueDigest: 'G'.repeat(64) },
      { ...valid, valueTokens: [token, token] },
      {
        ...valid,
        valueTokens: Array.from(
          { length: 257 },
          (_unused, index) =>
            index.toString(16).padStart(64, '0'),
        ),
      },
    ];
    for (const invalid of invalidFingerprints) {
      fixture.database
        .prepare(
          `UPDATE memory_tombstones
           SET semantic_fingerprint = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(invalid), tombstoneId);
      assert.throws(
        () => backfillTombstoneSemanticFingerprints(
          fixture.database,
          {
            tombstoneIds: [tombstoneId],
            requireComplete: true,
          },
        ),
        /tombstone 指纹回填失败/u,
      );
    }
  } finally {
    fixture.close();
  }
});

test('不可逆 tombstone 语义草图区分对立具体值并识别通用编辑器别名', () => {
  const fixture = createFixture();
  try {
    const coffeePredicate = '用户::每日饮品';
    const coffee = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户每天早上喝热咖啡。',
      stableKey: `personal::self::${coffeePredicate}`,
      predicateKey: coffeePredicate,
      normalizedValue: '每天早上喝热咖啡',
      normalizedValueHash: 'hot-coffee-value',
    }).memory;
    fixture.memoryStore.forget(coffee.id, '忘记热咖啡偏好');
    const coffeeClaim = {
      userId: 'default',
      namespace: 'personal',
      scopeType: 'personal' as const,
      scopeKey: 'self',
      kind: 'preference' as const,
      stableKey: `personal::self::${coffeePredicate}`,
      normalizedKey: coffeePredicate,
    };
    assert.ok(
      findBlockingTombstone(fixture.database, {
        ...coffeeClaim,
        content: '用户每日清晨会喝热咖啡。',
        normalizedValue: '每日清晨喝热咖啡',
      }),
    );
    assert.equal(
      findBlockingTombstone(fixture.database, {
        ...coffeeClaim,
        content: '用户每天早上喝冰咖啡。',
        normalizedValue: '每天早上喝冰咖啡',
      }),
      null,
    );
    assert.equal(
      findBlockingTombstone(fixture.database, {
        ...coffeeClaim,
        content: '用户每天早上喝摩卡咖啡。',
        normalizedValue: '每天早上喝摩卡咖啡',
      }),
      null,
      '同一咖啡大类中的不同具体值不能靠上下文重叠误拦',
    );

    const editorPredicate = '用户::主要编辑器';
    const editor = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户使用 VS Code。',
      stableKey: `personal::self::${editorPredicate}`,
      predicateKey: editorPredicate,
      normalizedValue: 'VS Code',
      normalizedValueHash: 'vscode-value',
    }).memory;
    fixture.memoryStore.forget(editor.id, '忘记编辑器偏好');
    const editorClaim = {
      userId: 'default',
      namespace: 'personal',
      scopeType: 'personal' as const,
      scopeKey: 'self',
      kind: 'preference' as const,
      stableKey: `personal::self::${editorPredicate}`,
      normalizedKey: editorPredicate,
    };
    assert.ok(
      findBlockingTombstone(fixture.database, {
        ...editorClaim,
        content: '用户使用 Visual Studio Code。',
        normalizedValue: 'Visual Studio Code',
      }),
    );
    assert.equal(
      findBlockingTombstone(fixture.database, {
        ...editorClaim,
        content: '用户使用 IntelliJ IDEA。',
        normalizedValue: 'IntelliJ IDEA',
      }),
      null,
    );
    assert.equal(
      findBlockingTombstone(fixture.database, {
        ...editorClaim,
        scopeType: 'project',
        scopeKey: 'project-b',
        stableKey: `project::project-b::${editorPredicate}`,
        content: '项目 B 使用 Visual Studio Code。',
        normalizedValue: 'Visual Studio Code',
      }),
      null,
    );
  } finally {
    fixture.close();
  }
});

test('主库物理清除在 tombstone 清空触发 SQL ABORT 时删除、引用和指纹回填全部回滚', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户要求主库物理清除必须原子提交。',
      stableKey: 'personal::self::用户::主库清除原子性',
      predicateKey: '用户::主库清除原子性',
      normalizedValue: '必须原子提交',
      normalizedValueHash: 'main-purge-atomicity',
    }).memory;
    const purge = fixture.governance.queuePurge(memory.id);
    fixture.database.exec(`
      UPDATE memory_tombstones
      SET semantic_fingerprint = NULL
      WHERE content_hash = '${memory.checksum}'
        AND restored_at IS NULL;

      CREATE TRIGGER abort_main_tombstone_clear
      BEFORE UPDATE OF stable_key ON memory_tombstones
      WHEN OLD.content_hash = '${memory.checksum}'
        AND NEW.stable_key IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected main tombstone clear failure');
      END;
    `);

    assert.throws(
      () => fixture.governance.processPurgeJob(
        purge.id,
        'main-atomicity-worker',
      ),
      /injected main tombstone clear failure/u,
    );
    assert.ok(fixture.memoryStore.get(memory.id, true));
    const afterFailure = fixture.database
      .prepare(
        `SELECT memory_item_id, stable_key, normalized_key,
                normalized_value, semantic_fingerprint
         FROM memory_tombstones
         WHERE content_hash = ? AND restored_at IS NULL`,
      )
      .get(memory.checksum);
    assert.equal(afterFailure?.memory_item_id, memory.id);
    assert.ok(afterFailure?.stable_key);
    assert.ok(afterFailure?.normalized_key);
    assert.ok(afterFailure?.normalized_value);
    assert.equal(afterFailure?.semantic_fingerprint, null);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_items
           WHERE id = ?`,
        )
        .get(memory.id)?.count,
      1,
    );

    fixture.database.exec('DROP TRIGGER abort_main_tombstone_clear');
    const completed = fixture.governance.processPurgeJob(
      purge.id,
      'main-atomicity-worker',
    );
    assert.equal(completed.status, 'completed');
    assert.equal(fixture.memoryStore.get(memory.id, true), null);
  } finally {
    fixture.close();
  }
});

test('受管备份清除在 SQL ABORT 时破坏性变更全回滚，已提交指纹回填可幂等重试', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户要求受管备份清除必须原子提交。',
      stableKey: 'personal::self::用户::备份清除原子性',
      predicateKey: '用户::备份清除原子性',
      normalizedValue: '必须原子提交',
      normalizedValueHash: 'backup-purge-atomicity',
    }).memory;
    const purge = fixture.governance.queuePurge(memory.id);
    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const backupPath = path.join(
      backupDirectory,
      'test-schema-23-to-24-atomicity.sqlite3',
    );
    fixture.database.prepare('VACUUM INTO ?').run(backupPath);
    const injected = new DatabaseSync(backupPath);
    try {
      injected.exec(`
        UPDATE memory_tombstones
        SET semantic_fingerprint = NULL
        WHERE content_hash = '${memory.checksum}'
          AND restored_at IS NULL;

        CREATE TRIGGER abort_backup_memory_delete
        BEFORE DELETE ON memories
        WHEN OLD.id = '${memory.id}'
        BEGIN
          SELECT RAISE(ABORT, 'injected backup memory delete failure');
        END;
      `);
    } finally {
      injected.close();
    }

    assert.throws(
      () => fixture.governance.processPurgeJob(
        purge.id,
        'backup-atomicity-worker',
      ),
      /injected backup memory delete failure/u,
    );
    assert.ok(fixture.memoryStore.get(memory.id, true));
    const failedBackup = new DatabaseSync(backupPath);
    try {
      assert.equal(
        failedBackup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memories
             WHERE id = ?`,
          )
          .get(memory.id)?.count,
        1,
      );
      const tombstone = failedBackup
        .prepare(
          `SELECT memory_item_id, stable_key, normalized_key,
                  normalized_value, semantic_fingerprint
           FROM memory_tombstones
           WHERE content_hash = ? AND restored_at IS NULL`,
        )
        .get(memory.checksum);
      assert.equal(tombstone?.memory_item_id, memory.id);
      assert.ok(tombstone?.stable_key);
      assert.ok(tombstone?.normalized_key);
      assert.ok(tombstone?.normalized_value);
      assert.ok(
        tombstone?.semantic_fingerprint,
        '非破坏性的指纹回填可先提交并供重试复用',
      );
      failedBackup.exec('DROP TRIGGER abort_backup_memory_delete');
    } finally {
      failedBackup.close();
    }

    const completed = fixture.governance.processPurgeJob(
      purge.id,
      'backup-atomicity-worker',
    );
    assert.equal(completed.status, 'completed');
    const sanitizedBackup = new DatabaseSync(
      backupPath,
      { readOnly: true },
    );
    try {
      assert.equal(
        sanitizedBackup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memories
             WHERE id = ?`,
          )
          .get(memory.id)?.count,
        0,
      );
    } finally {
      sanitizedBackup.close();
    }
  } finally {
    fixture.close();
  }
});

test('真实 MemoryWorker 路径会重试物理清除并在五分钟门限内完成', async () => {
  const current = new Date('2026-07-29T08:00:00.000Z');
  const fixture = createFixture(current);
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'event',
      content: '这条记忆验证物理清除 Worker 的失败重试。',
      stableKey: '用户::物理清除Worker重试',
    }).memory;
    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const managedBackupPath = path.join(
      backupDirectory,
      'test-schema-22-to-23-retry.sqlite3',
    );
    fixture.database
      .prepare('VACUUM INTO ?')
      .run(managedBackupPath);

    const queued = fixture.governance.queuePurge(memory.id);
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        throw new Error('本测试不应执行提取');
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycleStore,
      extractor,
      undefined,
      undefined,
      fixture.governance,
      false,
    );
    const wallStartedAt = Date.now();
    const checkpointBlocker = new DatabaseSync(
      path.join(fixture.directory, 'test.sqlite3'),
    );
    checkpointBlocker.exec(`
      PRAGMA journal_mode = WAL;
      BEGIN;
    `);
    checkpointBlocker
      .prepare('SELECT COUNT(*) AS count FROM memory_items')
      .get();
    const failed = await (async () => {
      try {
        return await worker.processNext('purge-retry-worker');
      } finally {
        checkpointBlocker.exec('COMMIT');
        checkpointBlocker.close();
      }
    })();
    assert.equal(failed.job?.jobType, 'purge_memory');
    assert.equal(failed.job?.status, 'failed');
    assert.match(failed.error || '', /WAL 截断未完成/u);
    assert.equal(
      fixture.governance.getPurgeJob(queued.id)?.status,
      'failed',
    );
    assert.equal(
      fixture.governance.getPurgeJob(queued.id)?.attempts,
      1,
      'WAL checkpoint 失败发生在真实清除尝试内',
    );
    assert.equal(
      fixture.governance.getPurgeJob(queued.id)?.completedAt,
      null,
      'checkpoint 失败时不得提前标记 completed',
    );

    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET available_at = ?
         WHERE id = ?`,
      )
      .run(current.toISOString(), `physical-purge:${queued.id}`);
    const completed = await worker.processNext(
      'purge-retry-worker',
    );
    assert.equal(completed.job?.jobType, 'purge_memory');
    assert.equal(completed.job?.status, 'completed');
    const finalJob = fixture.governance.getPurgeJob(queued.id);
    assert.equal(finalJob?.status, 'completed');
    assert.equal(finalJob?.attempts, 2);
    assert.ok(finalJob?.completedAt);
    assert.ok(
      Date.parse(finalJob!.completedAt!) -
        Date.parse(finalJob!.createdAt) <
        5 * 60_000,
      '入队到完成必须小于五分钟',
    );
    assert.ok(
      Date.now() - wallStartedAt < 5 * 60_000,
      '真实 Worker 测试墙钟耗时必须小于五分钟',
    );
    assert.equal(fixture.memoryStore.get(memory.id, true), null);
    const sanitizedBackup = new DatabaseSync(
      managedBackupPath,
      { readOnly: true },
    );
    try {
      assert.equal(
        sanitizedBackup
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memories
             WHERE id = ?`,
          )
          .get(memory.id)?.count,
        0,
      );
    } finally {
      sanitizedBackup.close();
    }
  } finally {
    fixture.close();
  }
});

test('受管备份 WAL 被读者占用时清除不得完成且释放后可彻底重试', async () => {
  const current = new Date('2026-07-29T08:30:00.000Z');
  const fixture = createFixture(current);
  try {
    const secretText = '罍爨鸞虋钃饕鬻蠿';
    const memory = fixture.memoryStore.remember({
      kind: 'event',
      content: `受管备份 WAL 清除标记 ${secretText}`,
      stableKey: '用户::受管备份WAL清除',
    }).memory;
    const backupDirectory = path.join(
      fixture.directory,
      'migration-backups',
    );
    fs.mkdirSync(backupDirectory);
    const managedBackupPath = path.join(
      backupDirectory,
      'test-schema-23-to-24-wal-busy.sqlite3',
    );
    fixture.database
      .prepare('VACUUM INTO ?')
      .run(managedBackupPath);
    const queued = fixture.governance.queuePurge(memory.id);
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'extract-v1',
      async extract() {
        throw new Error('本测试不应执行提取');
      },
    };
    const worker = new MemoryWorker(
      fixture.lifecycleStore,
      extractor,
      undefined,
      undefined,
      fixture.governance,
      false,
    );
    const backupReader = new DatabaseSync(managedBackupPath);
    backupReader.exec('PRAGMA journal_mode = WAL; BEGIN;');
    backupReader
      .prepare('SELECT COUNT(*) AS count FROM memories')
      .get();
    const failed = await worker.processNext(
      'purge-backup-busy-worker',
    );
    assert.equal(failed.job?.status, 'failed');
    assert.match(
      failed.error || '',
      /系统受管迁移备份 WAL 截断未完成/u,
    );
    assert.equal(
      fixture.governance.getPurgeJob(queued.id)?.completedAt,
      null,
    );
    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'deleted',
      '主库保持 tombstone 删除态且不得重新召回',
    );
    backupReader.exec('COMMIT');
    backupReader.close();

    fixture.database
      .prepare(
        `UPDATE memory_jobs
         SET available_at = ?
         WHERE id = ?`,
      )
      .run(current.toISOString(), `physical-purge:${queued.id}`);
    const completed = await worker.processNext(
      'purge-backup-busy-worker',
    );
    assert.equal(completed.job?.status, 'completed');
    assert.equal(
      fixture.governance.getPurgeJob(queued.id)?.status,
      'completed',
    );
    assert.equal(fixture.memoryStore.get(memory.id, true), null);
    const backupArtifacts = [
      managedBackupPath,
      `${managedBackupPath}-wal`,
      `${managedBackupPath}-shm`,
    ];
    assertArtifactsExcludeTextVariants(
      backupArtifacts,
      secretText,
    );
    assertArtifactsExcludeFtsTrigrams(
      backupArtifacts,
      secretText,
    );
  } finally {
    fixture.close();
  }
});
