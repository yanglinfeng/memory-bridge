import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  openDatabase,
  SCHEMA_VERSION,
} from '../src/server/database.js';
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
import type { MemoryExtractor } from '../src/server/memory-extractor.js';
import {
  MemoryReflectionService,
  type ReflectionProvider,
} from '../src/server/memory-reflection.js';
import { MemoryStore } from '../src/server/memory-store.js';
import { PatternObservationStore } from
  '../src/server/pattern-observation-store.js';
import type {
  SemanticCandidate,
  SemanticDecision,
  SemanticRanker,
} from '../src/server/semantic-ranker.js';
import {
  NamespaceQualityService,
  NamespaceRecallCoordinator,
} from '../src/server/namespace-quality.js';

class BackupDenseRanker implements SemanticRanker {
  readonly embeddingModel = 'backup-dense-embedding-v1';
  readonly rerankModel = 'backup-dense-reranker-v1';

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => Float32Array.from([1, 0, 0]));
  }

  async rerank(
    _query: string,
    candidates: SemanticCandidate[],
  ): Promise<SemanticDecision[]> {
    return candidates.map((candidate) => ({
      id: candidate.id,
      relevant: true,
      confidence: 1,
      reason: 'deterministic full-backup fixture',
    }));
  }
}

function createFixture(semanticRanker?: SemanticRanker) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-full-backup-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycleStore = new LifecycleStore(database);
  const memoryStore = new MemoryStore(database, semanticRanker);
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
  );
  return {
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

test('schema 37 完整备份往返情景、观察和层级摘要并拒绝越权引用', async () => {
  const source = createFixture();
  const target = createFixture();
  const rejected = createFixture();
  try {
    const exchange = source.lifecycleStore.recordCompletedExchange({
      userId: 'default',
      namespace: 'personal',
      identityStatus: 'legacy',
      clientName: 'schema37-backup',
      sessionExternalId: 'schema37-backup-session',
      userTurnExternalId: 'schema37-backup-user',
      userContent: '我连续几天都在早餐后喝桂花乌龙。',
      assistantTurnExternalId: 'schema37-backup-assistant',
      assistantContent: '收到，这只是助手对用户原话的回应。',
      occurredAt: '2026-08-13T08:00:00.000Z',
    });
    const episode = new EpisodicMemoryService(source.database).materialize({
      userId: 'default',
      namespace: 'personal',
      userTurnId: exchange.userTurn.id,
      assistantTurnId: exchange.assistantTurn.id,
    });
    new PatternObservationStore(source.database).observe({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      claimFingerprint: 'schema37-backup-tea-claim',
      kind: 'preference',
      subject: '用户',
      predicate: '早餐饮品',
      value: '桂花乌龙',
      negated: false,
      turnId: exchange.userTurn.id,
      excerpt: '早餐后喝桂花乌龙',
      runId: null,
      state: 'supporting',
      timestamp: '2026-08-13T08:01:00.000Z',
    });
    const summary = await new HierarchicalSummaryService(
      source.database,
      source.memoryStore,
      {
        model: 'qwen2.5:14b',
        promptVersion: 'schema37-backup-summary-v1',
        async consolidate(_scope, sources) {
          return {
            sentences: [{
              text: '用户在早餐后喝桂花乌龙。',
              sourceVersionIds: sources.map(
                (entry) => entry.memoryVersionId,
              ),
            }],
          };
        },
        async verifySupport(_scope, _sources, sentences) {
          return sentences.map((_sentence, sentenceIndex) => ({
            sentenceIndex,
            supported: true,
            rationale: 'schema37 backup fixture',
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
    assert.equal(summary.status, 'created');

    const backup = source.memoryStore.exportAll();
    assert.equal(backup.state?.episodes.length, 1);
    assert.equal(backup.state?.episodeTurns.length, 2);
    assert.equal(backup.state?.patternObservations.length, 1);
    assert.equal(backup.state?.hierarchicalSummaries.length, 1);
    assert.equal(backup.state?.hierarchicalSummarySources.length, 1);

    target.memoryStore.importAll(backup);
    const restored = target.memoryStore.exportAll();
    assert.deepEqual(
      { ...restored, exportedAt: backup.exportedAt },
      backup,
    );
    assert.equal(
      target.database.prepare(
        'SELECT COUNT(*) AS count FROM conversation_episodes WHERE id = ?',
      ).get(episode.episodeId)?.count,
      1,
    );

    const rejectedSentinel = rejected.memoryStore.remember({
      kind: 'instruction',
      content: '失败的 schema 37 导入不得改动目标库。',
      stableKey: '用户::schema37导入回滚哨兵',
    }).memory;
    const bobRunId = '11111111-1111-4111-8111-111111111137';
    rejected.database.prepare(
      `INSERT INTO memory_reflection_runs (
         id, user_id, namespace, scope_type, scope_key,
         run_type, trigger, status, turn_set_hash, input_turn_count,
         model, prompt_version, extractor_id, extractor_version,
         implementation_version, generation_key, requested_by,
         created_at, updated_at
       ) VALUES (
         ?, 'bob', 'personal', 'personal', 'self',
         'reflect', 'manual', 'completed', ?, 0,
         'qwen2.5:14b', 'schema37-bob-run-v1', 'test-extractor', 'v1',
         'schema37-bob-run-v1', 'schema37-bob-run-v1', 'bob', ?, ?
       )`,
    ).run(
      bobRunId,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      '2026-08-13T08:02:00.000Z',
      '2026-08-13T08:02:00.000Z',
    );
    const beforeRejected = rejected.memoryStore.exportAll();

    const forgedEpisodeOwner = structuredClone(backup);
    forgedEpisodeOwner.state!.episodes[0]!.user_id = 'mallory';
    assert.throws(
      () => rejected.memoryStore.importAll(forgedEpisodeOwner),
      /episode|episodes|其他用户/u,
    );

    const forgedEpisodeTurn = structuredClone(backup);
    forgedEpisodeTurn.state!.episodeTurns[1]!.turn_id =
      exchange.userTurn.id;
    assert.throws(
      () => rejected.memoryStore.importAll(forgedEpisodeTurn),
      /episode|情景/u,
    );

    const forgedObservationTurn = structuredClone(backup);
    forgedObservationTurn.state!.patternObservations[0]!.turn_id =
      exchange.assistantTurn.id;
    assert.throws(
      () => rejected.memoryStore.importAll(forgedObservationTurn),
      /观察|observation/u,
    );

    const forgedSummarySource = structuredClone(backup);
    forgedSummarySource.state!.hierarchicalSummarySources[0]!.episode_id =
      'missing-episode';
    assert.throws(
      () => rejected.memoryStore.importAll(forgedSummarySource),
      /摘要|episode/u,
    );

    for (const field of [
      'episodes',
      'episodeTurns',
      'patternObservations',
      'hierarchicalSummaries',
      'hierarchicalSummarySources',
    ]) {
      const missingLayer = structuredClone(backup);
      delete (missingLayer.state as unknown as Record<string, unknown>)[field];
      assert.throws(
        () => rejected.memoryStore.importAll(missingLayer),
        /schema 37|分层|字段|state/u,
        `schema 37 备份缺少 ${field} 时必须在清库前失败`,
      );
    }

    const strippedEpisodes = structuredClone(backup);
    strippedEpisodes.state!.episodes = [];
    strippedEpisodes.state!.episodeTurns = [];
    assert.throws(
      () => rejected.memoryStore.importAll(strippedEpisodes),
      /episode|情景|映射/u,
    );

    const strippedSummaries = structuredClone(backup);
    strippedSummaries.state!.hierarchicalSummaries = [];
    strippedSummaries.state!.hierarchicalSummarySources = [];
    assert.throws(
      () => rejected.memoryStore.importAll(strippedSummaries),
      /摘要|映射/u,
    );

    const swappedOrdinals = structuredClone(backup);
    for (const link of swappedOrdinals.state!.episodeTurns) {
      link.ordinal = Number(link.ordinal) === 0 ? 1 : 0;
    }
    assert.throws(
      () => rejected.memoryStore.importAll(swappedOrdinals),
      /episode-turn|ordinal|绑定/u,
    );

    const forgedEpisodeHash = structuredClone(backup);
    forgedEpisodeHash.state!.episodes[0]!.content_hash = '0'.repeat(64);
    assert.throws(
      () => rejected.memoryStore.importAll(forgedEpisodeHash),
      /episode.*哈希|hash/u,
    );

    const forgedTurnHash = structuredClone(backup);
    forgedTurnHash.state!.episodeTurns[0]!.content_hash = '0'.repeat(64);
    assert.throws(
      () => rejected.memoryStore.importAll(forgedTurnHash),
      /episode-turn.*哈希|hash/u,
    );

    const forgedObservationRun = structuredClone(backup);
    forgedObservationRun.state!.patternObservations[0]!.first_run_id =
      bobRunId;
    forgedObservationRun.state!.patternObservations[0]!.last_run_id =
      bobRunId;
    assert.throws(
      () => rejected.memoryStore.importAll(forgedObservationRun),
      /observation.*run|观察.*运行|越权/u,
    );

    const afterRejected = rejected.memoryStore.exportAll();
    assert.deepEqual(
      { ...afterRejected, exportedAt: beforeRejected.exportedAt },
      beforeRejected,
    );
    assert.equal(rejected.memoryStore.get(rejectedSentinel.id)?.id,
      rejectedSentinel.id);
    assert.equal(
      rejected.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_reflection_runs WHERE id = ?',
      ).get(bobRunId)?.count,
      1,
    );
  } finally {
    source.close();
    target.close();
    rejected.close();
  }
});

test('v3 完整备份恢复账本、候选、版本、治理、任务和派生摘要', async () => {
  const source = createFixture();
  const target = createFixture();
  try {
    const turn = source.lifecycleStore.recordTurn({
      personaId: 'persona-A',
      projectId: 'Project-A',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-backup-1',
      clientName: 'client',
      sessionExternalId: 'backup-session',
      turnExternalId: 'backup-turn',
      role: 'user',
      content: '我使用 VS Code，而且不希望项目带演示数据。',
    }).turn;
    const runId = source.lifecycleStore.startExtraction(
      turn.id,
      'qwen2.5:14b',
      'extract-v1',
    );
    const candidates = source.lifecycleStore.completeExtraction(
      runId,
      [
        {
          kind: 'preference',
          subject: '用户',
          predicate: '主要编辑器',
          value: 'VS Code',
          content: '用户主要使用 VS Code。',
          confidence: 0.99,
          importance: 0.8,
        },
        {
          kind: 'preference',
          subject: '用户',
          predicate: '演示数据偏好',
          value: '不内置演示数据',
          content: '用户不希望项目内置演示数据。',
          confidence: 0.99,
          importance: 0.9,
        },
      ],
    );
    const first = source.memoryStore.remember({
      kind: 'preference',
      content: candidates[0].content,
      stableKey: candidates[0].normalizedKey,
      predicateKey: candidates[0].normalizedKey,
      normalizedValue: candidates[0].value,
      normalizedValueHash: candidates[0].normalizedHash,
      evidenceTurnId: turn.id,
      evidenceExcerpt: turn.content,
      idempotencyKey: `candidate:${candidates[0].id}`,
      source: 'automatic-extraction',
    }).memory;
    const second = source.memoryStore.remember({
      kind: 'preference',
      content: candidates[1].content,
      stableKey: candidates[1].normalizedKey,
      predicateKey: candidates[1].normalizedKey,
      normalizedValue: candidates[1].value,
      normalizedValueHash: candidates[1].normalizedHash,
      evidenceTurnId: turn.id,
      evidenceExcerpt: turn.content,
      idempotencyKey: `candidate:${candidates[1].id}`,
      source: 'automatic-extraction',
    }).memory;
    source.memoryStore.remember({
      kind: 'preference',
      content: '用户日常主要使用 VS Code。',
      stableKey: `${candidates[0].normalizedKey}::backup-observation-2`,
      predicateKey: candidates[0].normalizedKey,
      normalizedValue: candidates[0].value,
      normalizedValueHash: candidates[0].normalizedHash,
      evidenceTurnId: turn.id,
      evidenceExcerpt: turn.content,
      idempotencyKey: 'backup-redundant-editor-observation',
      source: 'automatic-extraction',
    });
    source.lifecycleStore.updateCandidateState(
      candidates[0].id,
      'accepted',
      'test',
      first.id,
      false,
      {
        relation: 'coexists',
        method: 'manual',
        confidence: 1,
        rationale: 'backup test resolution',
        targetMemoryItemId: first.id,
      },
    );
    source.lifecycleStore.updateCandidateState(
      candidates[1].id,
      'accepted',
      'test',
      second.id,
      false,
      {
        relation: 'coexists',
        method: 'manual',
        confidence: 1,
        rationale: 'backup test resolution',
        targetMemoryItemId: second.id,
      },
    );
    const provider: ConsolidationProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'consolidate-v1',
      async consolidate(_scope, sources) {
        return {
          sentences: [{
            text: '用户主要使用 VS Code。',
            sourceVersionIds: sources.map(
              (entry) => entry.memoryVersionId,
            ),
          }],
        };
      },
      async verifySupport(_scope, _sources, sentences) {
        return sentences.map((_sentence, sentenceIndex) => ({
          sentenceIndex,
          supported: true,
          rationale: 'deterministic backup fixture',
        }));
      },
    };
    const consolidation = await new MemoryConsolidator(
      source.database,
      source.lifecycleStore,
      source.memoryStore,
      provider,
    ).consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });
    source.governance.setPinned(first.id, true);
    source.governance.setTtl(
      second.id,
      '2027-07-29T00:00:00.000Z',
    );
    source.governance.upsertPolicy({
      kind: 'preference',
      evidenceTtlDays: 60,
      halfLifeDays: 730,
    });
    const purgeTarget = source.memoryStore.remember({
      kind: 'event',
      content: '这条事件已经进入待物理清除队列。',
      stableKey: '用户::待清除事件',
    }).memory;
    source.governance.queuePurge(purgeTarget.id);
    const quality = new NamespaceQualityService(source.database);
    quality.recordSnapshot({
      id: 'backup-quality-snapshot',
      userId: 'default',
      namespace: 'personal',
      metrics: {
        extractionPrecision: 1,
        candidateRecall: 1,
        credentialSaves: 0,
        conflictAccuracy: 1,
        semanticDuplicateRate: 0,
      },
      samples: {
        extractionPrecision: 100,
        candidateRecall: 100,
        credentialSafety: 20,
        conflictResolution: 50,
        semanticDuplicate: 100,
      },
      modelVersions: {
        extraction: 'qwen2.5:14b',
        relation: 'qwen2.5:14b',
        rerank: 'qwen2.5:14b',
        embedding: 'bge-m3:latest',
      },
      promptVersions: {
        extraction: 'memory-extractor-v2',
        relation: 'claim-relation-v1',
      },
      evaluatorVersion: 'backup-test-v1',
      datasetId: 'backup-test-dataset',
      datasetSha256: 'a'.repeat(64),
    });
    await new NamespaceRecallCoordinator(
      source.database,
      source.memoryStore,
      quality,
      {
        globalMode: 'shadow',
        hybridRecall: async (input) => ({
          query: input.query,
          memories: [],
          context: '',
          qualityState: 'full',
        }),
        legacyRecall: async (input) => ({
          query: input.query,
          memories: [],
          context: '',
          qualityState: 'degraded',
        }),
      },
    ).recallForLifecycle({
      query: '完整备份应保留质量灰度状态',
      userId: 'default',
      namespace: 'personal',
    });
    source.database
      .prepare(
        `INSERT INTO memory_action_requests (
           id, user_id, namespace, request_key, action, status,
           target_query, candidate_id, turn_id, confidence,
           sensitivity, model, prompt_version, rationale, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'action-backup-pending',
        'default',
        'personal',
        'backup-session:backup-turn:remember',
        'remember',
        'pending',
        '不内置演示数据',
        candidates[1].id,
        turn.id,
        0.7,
        'sensitive',
        'qwen2.5:14b',
        'explicit-intent-v1',
        '等待人工确认',
        '2026-07-29T00:00:00.000Z',
      );
    const deleted = source.memoryStore.remember({
      kind: 'preference',
      content: '这条记忆用于验证删除世代备份。',
      stableKey: '用户::备份删除世代',
      predicateKey: '用户::备份删除世代',
      normalizedValueHash: 'backup-deletion-generation',
      normalizedValue: '删除',
    }).memory;
    source.memoryStore.forget(deleted.id, '备份测试删除');

    const backup = source.memoryStore.exportAll();
    assert.equal(backup.version, 3);
    assert.equal(backup.schemaVersion, SCHEMA_VERSION);
    assert.ok(backup.state);
    assert.equal(backup.state?.sessions.length, 1);
    assert.equal(backup.state?.sessions[0]?.project_id, 'Project-A');
    assert.equal(backup.state?.turns.length, 1);
    assert.equal(backup.state?.candidates.length, 2);
    assert.ok(
      (backup.state?.candidateResolutionRuns.length || 0) > 0,
    );
    assert.equal(backup.state?.consolidations.length, 1);
    assert.equal(backup.state?.retentionPolicies.length, 1);
    assert.equal(backup.state?.purgeJobs.length, 1);
    assert.equal(backup.state?.actionRequests.length, 1);
    assert.ok((backup.state?.tombstones.length || 0) >= 1);
    const deletionTombstone = backup.state?.tombstones.find(
      (row) => row.memory_item_id === deleted.id,
    );
    assert.equal(
      deletionTombstone?.memory_item_id,
      deleted.id,
    );
    assert.equal(
      deletionTombstone?.deletion_generation,
      1,
    );
    assert.ok((backup.state?.jobs.length || 0) > 0);
    assert.equal(
      backup.state?.namespaceQualitySnapshots.length,
      1,
    );
    assert.equal(backup.state?.namespaceRolloutState.length, 1);
    assert.equal(
      backup.state?.namespaceRecallShadowComparisons.length,
      1,
    );

    // Identity-bearing backups are only trusted after the destination has
    // established the same immutable session binding through its live path.
    target.lifecycleStore.recordTurn({
      personaId: 'persona-A',
      projectId: 'Project-A',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-backup-target-anchor',
      clientName: 'client',
      sessionExternalId: 'backup-session',
      turnExternalId: 'backup-target-anchor-turn',
      role: 'user',
      content: '目标库已通过运行时建立同一身份绑定。',
    });
    const restored = target.memoryStore.importAll(backup);
    assert.equal(restored.imported, backup.memories.length);
    assert.ok((restored.stateRowCount || 0) > 0);
    const roundTrip = target.memoryStore.exportAll();
    assert.deepEqual(
      { ...roundTrip, exportedAt: backup.exportedAt },
      backup,
    );
    assert.equal(
      target.governance.get(first.id)?.pinned,
      true,
    );
    assert.equal(
      target.governance.get(second.id)?.expiresAt,
      '2027-07-29T00:00:00.000Z',
    );
    assert.equal(
      target.memoryStore.get(consolidation.memoryId!)?.source,
      'consolidation',
    );
    assert.ok(
      Number(
        target.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memory_ann_index`,
          )
          .get()?.count,
      ) > 0,
    );
    assert.ok(
      target.database
        .prepare(
          `SELECT memory_id
           FROM memories_fts
           WHERE memories_fts MATCH '"主要使用 VS Code"'`,
        )
        .get(),
    );
  } finally {
    source.close();
    target.close();
  }
});

test('schema 31 完整备份往返历史重提炼账本并拒绝伪造 session 与越权证据', async () => {
  const source = createFixture();
  const target = createFixture();
  const rejectedTarget = createFixture();
  try {
    const contents = [
      '周一早上我喝桂花乌龙。',
      '周三早上我也喝桂花乌龙。',
      '今天上班前还是桂花乌龙。',
    ];
    const turns = contents.map((content, index) =>
      source.lifecycleStore.recordTurn({
        userId: 'default',
        namespace: 'personal',
        clientName: 'client',
        sessionExternalId: 'reflection-backup-session',
        turnExternalId: `reflection-backup-${index + 1}`,
        role: 'user',
        content,
        occurredAt: `2026-08-0${index + 5}T08:00:00.000Z`,
      }).turn,
    );
    const extractor: MemoryExtractor = {
      model: 'qwen2.5:14b',
      promptVersion: 'backup-extractor-v1',
      extractorId: 'backup-extractor',
      extractorVersion: 'v1',
      async extract() {
        return [];
      },
    };
    const reflectionProvider: ReflectionProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'backup-reflection-v1',
      async reflect() {
        return {
          candidates: [{
            kind: 'preference',
            subject: '用户',
            predicate: '工作日前饮品模式',
            value: '桂花乌龙',
            confidence: 0.9,
            importance: 0.7,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence: turns.map((turn, index) => ({
              turnAlias: `T${index + 1}`,
              excerpt: turn.content,
            })),
          }],
        };
      },
    };
    const reflection = new MemoryReflectionService(
      source.database,
      source.lifecycleStore,
      extractor,
      reflectionProvider,
      {
        minNewTurns: 1,
        minPatternEvidence: 3,
        // This fixture's evidence is deliberately dated in August 2026.
        // Freeze its clock so the 30-day production lookback does not make
        // the backup round-trip test depend on the calendar date it runs.
        clock: () => new Date('2026-08-08T10:00:00.000Z'),
      },
    );
    reflection.setMode('default', 'personal', 'shadow');
    const queued = reflection.queueRun({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'default',
    });
    const executed = await reflection.executeRun(
      queued.run.id,
      'backup-reflection-worker',
    );
    assert.equal(executed.run.status, 'completed');
    assert.equal(executed.candidates.length, 1);
    const otherSessionTurn = source.lifecycleStore.recordTurn({
      userId: 'default',
      namespace: 'personal',
      clientName: 'client',
      sessionExternalId: 'reflection-backup-other-session',
      turnExternalId: 'reflection-backup-other-turn',
      role: 'user',
      content: '这是另一个真实会话的无关回合。',
      occurredAt: '2026-08-08T09:00:00.000Z',
    }).turn;

    const backup = source.memoryStore.exportAll();
    assert.equal(backup.state?.turnIngestOrder.length, 4);
    assert.ok(backup.state?.turnIngestOrder.every(
      (row) => typeof row.session_id === 'string' && row.session_id.length > 0,
    ));
    assert.equal(backup.state?.reflectionSettings.length, 1);
    assert.equal(backup.state?.reflectionRuns.length, 1);
    assert.equal(backup.state?.reflectionRunTurns.length, 3);
    assert.equal(
      backup.state?.reflectionModelCalls.length,
      2,
      'discover 与 verify 两次物理调用都必须进入备份账本',
    );
    assert.equal(backup.state?.reflectionClaims.length, 1);
    assert.ok((backup.state?.reflectionEvents.length || 0) >= 2);
    assert.equal(backup.state?.candidateEvidence.length, 3);
    assert.equal(backup.state?.reflectionCheckpoints.length, 1);

    target.memoryStore.importAll(backup);
    const restored = target.memoryStore.exportAll();
    for (const key of [
      'turnIngestOrder',
      'reflectionSettings',
      'reflectionCheckpoints',
      'reflectionRuns',
      'reflectionRunTurns',
      'reflectionModelCalls',
      'reflectionClaims',
      'reflectionEvents',
      'candidateEvidence',
    ] as const) {
      assert.deepEqual(restored.state?.[key], backup.state?.[key], key);
    }
    assert.equal(
      target.database.prepare(
        `SELECT decision
         FROM memory_reflection_claims
         WHERE candidate_id = ?`,
      ).get(executed.candidates[0].id)?.decision,
      'active',
    );

    const forged = structuredClone(backup);
    forged.state!.candidateEvidence[0].user_id = 'mallory';
    assert.throws(
      () => rejectedTarget.memoryStore.importAll(forged),
      /candidateEvidence|其他用户/u,
    );
    const forgedIngestSession = structuredClone(backup);
    forgedIngestSession.state!.turnIngestOrder[0].session_id =
      otherSessionTurn.sessionId;
    assert.throws(
      () => rejectedTarget.memoryStore.importAll(forgedIngestSession),
      /ingest ledger.*turn\/session/u,
    );
    assert.equal(
      rejectedTarget.database.prepare(
        'SELECT COUNT(*) AS count FROM memory_reflection_runs',
      ).get()?.count,
      0,
    );
  } finally {
    source.close();
    target.close();
    rejectedTarget.close();
  }
});

test('project 聚合维度与 personal access scope 可完整往返', async () => {
  const source = createFixture();
  const target = createFixture();
  try {
    source.memoryStore.remember({
      kind: 'project',
      content: '示例工程使用 TypeScript。',
      stableKey: '示例工程::语言',
      predicateKey: '示例工程::语言',
      normalizedValue: 'TypeScript',
      normalizedValueHash: 'typescript',
      scopeType: 'personal',
      scopeKey: 'self',
    });
    const provider: ConsolidationProvider = {
      model: 'qwen2.5:14b',
      promptVersion: 'project-personal-access-v1',
      async consolidate(_scope, sources) {
        return {
          sentences: [{
            text: sources[0].content,
            sourceVersionIds: [sources[0].memoryVersionId],
          }],
        };
      },
      async verifySupport(_scope, _sources, sentences) {
        return sentences.map((_sentence, sentenceIndex) => ({
          sentenceIndex,
          supported: true,
          rationale: 'exact source fixture',
        }));
      },
    };
    const result = await new MemoryConsolidator(
      source.database,
      source.lifecycleStore,
      source.memoryStore,
      provider,
      1,
      10,
      1,
    ).consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'project',
      scopeKey: '示例工程',
      accessScopeType: 'personal',
      accessScopeKey: 'self',
    });
    assert.ok(result.memoryId);
    source.lifecycleStore.enqueueJob({
      id: 'project-personal-access-job',
      jobType: 'consolidate_scope',
      userId: 'default',
      namespace: 'personal',
      payload: {
        userId: 'default',
        namespace: 'personal',
        scopeType: 'project',
        scopeKey: '示例工程',
        accessScopeType: 'personal',
        accessScopeKey: 'self',
      },
    });

    const backup = source.memoryStore.exportAll();
    const stored = backup.state!.consolidations.find(
      (row) => row.id === result.consolidationId,
    );
    assert.ok(stored);
    assert.match(String(stored.scope_key), /^access-v1:/u);

    target.memoryStore.importAll(backup);
    assert.equal(
      target.memoryStore.get(result.memoryId!)?.scopeType,
      'personal',
    );
    assert.equal(
      target.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE id = 'project-personal-access-job'`,
        )
        .get()?.count,
      1,
    );
  } finally {
    source.close();
    target.close();
  }
});

test('导入遗忘前的旧完整备份不会清除 tombstone 或重新激活投影与派生索引', async () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户只喝无糖乌龙茶。',
      stableKey: '用户::饮茶偏好',
      predicateKey: '用户::饮茶偏好',
      normalizedValue: '无糖乌龙茶',
      normalizedValueHash: 'unsweetened-oolong',
    }).memory;
    fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户喝乌龙茶时一贯选择无糖。',
      stableKey: '用户::饮茶偏好::第二观察',
      predicateKey: '用户::饮茶偏好',
      normalizedValue: '无糖乌龙茶',
      normalizedValueHash: 'unsweetened-oolong',
    });
    const consolidation = await new MemoryConsolidator(
      fixture.database,
      fixture.lifecycleStore,
      fixture.memoryStore,
      {
        model: 'qwen2.5:14b',
        promptVersion: 'backup-tombstone-regression-v1',
        async consolidate(_scope, sources) {
          return {
            sentences: [{
              text: '用户只喝无糖乌龙茶。',
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
            rationale: 'deterministic tombstone regression',
          }));
        },
      },
    ).consolidateScope({
      userId: 'default',
      namespace: 'personal',
      scopeType: 'topic',
      scopeKey: 'kind:preference',
    });
    assert.ok(consolidation.memoryId);
    const backupBeforeForget = fixture.memoryStore.exportAll();

    fixture.memoryStore.update(memory.id, {
      content: '用户现在只喝冰美式。',
      predicateKey: '用户::咖啡偏好',
      normalizedValue: '冰美式',
      normalizedValueHash: 'iced-americano',
      resolutionType: 'correction',
    });
    fixture.memoryStore.forget(memory.id, '用户要求遗忘饮茶偏好');
    const tombstoneBeforeImport = fixture.database
      .prepare(
        `SELECT *
         FROM memory_tombstones
         WHERE user_id = ? AND memory_item_id = ?
           AND restored_at IS NULL`,
      )
      .get('default', memory.id);
    assert.ok(tombstoneBeforeImport);

    fixture.memoryStore.importAll(backupBeforeForget);

    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'deleted',
    );
    const canonicalProjection = fixture.database
      .prepare(
        `SELECT i.status AS item_status, i.current_version_id,
                v.content AS current_content
         FROM memory_items i
         JOIN memory_versions v ON v.id = i.current_version_id
         WHERE i.id = ? AND i.user_id = ?`,
      )
      .get(memory.id, 'default');
    assert.equal(canonicalProjection?.item_status, 'deleted');
    assert.equal(
      canonicalProjection?.current_content,
      '用户只喝无糖乌龙茶。',
    );
    assert.ok(canonicalProjection?.current_version_id);
    assert.equal(fixture.memoryStore.get(memory.id), null);
    assert.deepEqual(
      fixture.memoryStore.recall({
        query: '用户平时喝什么茶？',
      }),
      [],
    );
    const tombstoneAfterImport = fixture.database
      .prepare(
        `SELECT *
         FROM memory_tombstones
         WHERE user_id = ? AND memory_item_id = ?
           AND restored_at IS NULL`,
      )
      .get('default', memory.id);
    assert.deepEqual(
      { ...tombstoneAfterImport },
      { ...tombstoneBeforeImport },
    );
    const restoredConsolidation = fixture.database
      .prepare(
        `SELECT status
         FROM derived_consolidations
         WHERE id = ?`,
      )
      .get(consolidation.consolidationId);
    assert.equal(restoredConsolidation?.status, 'stale');
    assert.equal(
      fixture.memoryStore.get(
        consolidation.memoryId,
        true,
      )?.status,
      'archived',
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT status
           FROM memory_items
           WHERE id = ?`,
        )
        .get(consolidation.memoryId)?.status,
      'archived',
    );
    for (const memoryId of [memory.id, consolidation.memoryId]) {
      for (const table of [
        'memory_embeddings',
        'memory_ann_index',
        'memory_term_index',
        'memory_dense_lsh',
        'memories_fts',
      ]) {
        assert.equal(
          Number(
            fixture.database
              .prepare(
                `SELECT COUNT(*) AS count
                 FROM ${table}
                 WHERE memory_id = ?`,
              )
              .get(memoryId)?.count,
          ),
          0,
          `${table} 不应保留可激活的遗忘投影`,
        );
      }
    }
  } finally {
    fixture.close();
  }
});

test('完整备份与当前 active tombstone 删除世代冲突时整体回滚', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'instruction',
      content: '发布前必须保留遗忘安全边界。',
      stableKey: '用户::遗忘安全边界',
    }).memory;
    fixture.memoryStore.forget(memory.id, '验证备份冲突回滚');
    const before = fixture.memoryStore.exportAll();
    const conflicting = structuredClone(before);
    const importedTombstone = conflicting.state?.tombstones.find(
      (row) => row.memory_item_id === memory.id,
    );
    assert.ok(importedTombstone);
    importedTombstone.id =
      '00000000-0000-4000-8000-000000000001';

    assert.throws(
      () => fixture.memoryStore.importAll(conflicting),
      /删除世代 1 冲突/,
    );

    const after = fixture.memoryStore.exportAll();
    assert.deepEqual(
      { ...after, exportedAt: before.exportedAt },
      before,
    );
    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'deleted',
    );
  } finally {
    fixture.close();
  }
});

test('旧完整备份不会重新激活已显式恢复的旧删除世代', () => {
  const fixture = createFixture();
  try {
    const memory = fixture.memoryStore.remember({
      kind: 'preference',
      content: '用户偏好浅色主题。',
      stableKey: '用户::主题偏好',
      predicateKey: '用户::主题偏好',
      normalizedValue: '浅色',
      normalizedValueHash: 'light-theme',
    }).memory;
    fixture.memoryStore.forget(memory.id, '第一次遗忘');
    const backupAfterFirstForget =
      fixture.memoryStore.exportAll();
    const restore = () =>
      fixture.memoryStore.commitRestore(memory.id, {
        relation: 'coexists',
        targetMemoryId: null,
        target: null,
        relatedTargets: [],
        method: 'manual',
        confidence: 1,
        rationale: '用户显式恢复且当前无冲突',
        model: null,
        promptVersion: null,
        cardinality: 'single',
        stableKey: '用户::主题偏好',
        reason: 'explicit restore',
        readSet: 'predicate',
      });

    assert.equal(restore().status, 'restored');
    fixture.memoryStore.forget(memory.id, '第二次遗忘');
    const ledgerBeforeImport = fixture.database
      .prepare(
        `SELECT id, deletion_generation, restored_at
         FROM memory_tombstones
         WHERE user_id = ? AND memory_item_id = ?
         ORDER BY deletion_generation ASC`,
      )
      .all('default', memory.id);
    assert.equal(ledgerBeforeImport.length, 2);
    assert.ok(ledgerBeforeImport[0].restored_at);
    assert.equal(ledgerBeforeImport[1].restored_at, null);

    fixture.memoryStore.importAll(backupAfterFirstForget);

    const ledgerAfterImport = fixture.database
      .prepare(
        `SELECT id, deletion_generation, restored_at
         FROM memory_tombstones
         WHERE user_id = ? AND memory_item_id = ?
         ORDER BY deletion_generation ASC`,
      )
      .all('default', memory.id);
    assert.deepEqual(
      ledgerAfterImport.map((row) => ({ ...row })),
      ledgerBeforeImport.map((row) => ({ ...row })),
    );
    assert.equal(
      fixture.memoryStore.get(memory.id, true)?.status,
      'deleted',
    );
    assert.equal(restore().status, 'restored');
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE user_id = ? AND memory_item_id = ?
             AND restored_at IS NULL`,
        )
        .get('default', memory.id)?.count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('schema v9 完整备份缺少后续安全字段时仍可无损导入 v18', () => {
  const source = createFixture();
  const target = createFixture();
  try {
    const turn = source.lifecycleStore.recordTurn({
      clientName: 'client',
      sessionExternalId: 'legacy-backup-session',
      turnExternalId: 'legacy-backup-turn',
      role: 'user',
      content: '我主要使用 VS Code。',
    }).turn;
    const runId = source.lifecycleStore.startExtraction(
      turn.id,
      'qwen2.5:14b',
      'extract-v1',
    );
    source.lifecycleStore.completeExtraction(runId, [{
      kind: 'preference',
      subject: '用户',
      predicate: '主要编辑器',
      value: 'VS Code',
      content: '用户主要使用 VS Code。',
      confidence: 0.99,
      importance: 0.8,
      sourceExcerpt: '我主要使用 VS Code',
    }]);

    const legacy = structuredClone(source.memoryStore.exportAll());
    legacy.schemaVersion = 9;
    for (const row of legacy.state?.sessions || []) {
      row.project_id = 'forged-project';
    }
    delete legacy.state?.candidateResolutionRuns;
    for (const row of legacy.state?.outbox || []) {
      delete row.user_id;
      delete row.namespace;
    }
    for (const row of legacy.state?.extractionRuns || []) {
      row.prompt_version = 'extract-v1';
      delete row.extractor_id;
      delete row.extractor_version;
      delete row.prompt_contract_version;
    }
    for (const row of legacy.state?.candidates || []) {
      for (const column of [
        'stable_key',
        'negated',
        'scope_type',
        'scope_key',
        'claim_occurred_at',
        'claim_valid_from',
        'claim_valid_to',
        'source_excerpt',
        'source_authority',
        'extractor_id',
        'extractor_version',
        'extraction_model',
        'extraction_prompt_version',
      ]) {
        delete row[column];
      }
    }

    const restored = target.memoryStore.importAll(legacy);
    assert.ok((restored.stateRowCount || 0) > 0);
    const run = target.database
      .prepare(
        `SELECT extractor_id, extractor_version,
                prompt_contract_version
         FROM extraction_runs`,
      )
      .get();
    assert.deepEqual({ ...run }, {
      extractor_id: 'memory-extractor',
      extractor_version: 'v1',
      prompt_contract_version: 'extract-v1',
    });
    const candidate = target.lifecycleStore.listCandidates({})[0];
    assert.equal(candidate.scopeType, 'personal');
    assert.equal(candidate.scopeKey, 'self');
    assert.equal(candidate.sensitivity, 'normal');
    assert.equal(candidate.sourceAuthority, 'legacy_unknown');
    assert.equal(
      target.database
        .prepare(
          `SELECT project_id
           FROM conversation_sessions
           WHERE external_id = 'legacy-backup-session'`,
        )
        .get()?.project_id,
      null,
    );
    assert.equal(
      candidate.stableKey,
      `personal::self::${candidate.normalizedKey}`,
    );
    assert.deepEqual(
      target.database
        .prepare(
          `SELECT DISTINCT user_id, namespace
           FROM outbox_events`,
        )
        .all()
        .map((row) => ({ ...row })),
      [{ user_id: 'default', namespace: 'personal' }],
    );
  } finally {
    source.close();
    target.close();
  }
});

test('schema v26 完整备份拒绝缺失、非法或身份状态冲突的 project 绑定', () => {
  const source = createFixture();
  const target = createFixture();
  try {
    source.lifecycleStore.recordTurn({
      personaId: 'persona-A',
      projectId: 'Project-A',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-project-backup',
      clientName: 'client',
      sessionExternalId: 'project-backup-session',
      turnExternalId: 'project-backup-turn',
      role: 'user',
      content: '项目备份必须保留可信绑定。',
    });
    const sentinel = target.memoryStore.remember({
      kind: 'preference',
      content: '目标库哨兵记忆不能被失败导入修改。',
      stableKey: '用户::备份失败哨兵',
    }).memory;
    const backup = source.memoryStore.exportAll();
    assert.equal(backup.schemaVersion, SCHEMA_VERSION);

    const missing = structuredClone(backup);
    delete missing.state!.sessions[0].project_id;
    assert.throws(
      () => target.memoryStore.importAll(missing),
      /缺少 project_id 绑定字段/u,
    );

    const invalid = structuredClone(backup);
    invalid.state!.sessions[0].project_id = 'project with spaces';
    assert.throws(
      () => target.memoryStore.importAll(invalid),
      /无效 project_id/u,
    );

    const conflicting = structuredClone(backup);
    conflicting.state!.sessions[0].identity_status = 'legacy';
    conflicting.state!.sessions[0].persona_id = null;
    assert.throws(
      () => target.memoryStore.importAll(conflicting),
      /非完整身份会话不能携带 persona\/project/u,
    );
    assert.equal(target.memoryStore.get(sentinel.id)?.id, sentinel.id);
    assert.equal(target.memoryStore.list().total, 1);
  } finally {
    source.close();
    target.close();
  }
});

test('完整备份拒绝 outbox payload 跨账户引用且不改动任一账户', () => {
  const fixture = createFixture();
  try {
    const aliceTurn = fixture.lifecycleStore.recordTurn({
      userId: 'alice',
      namespace: 'shared-fixture',
      clientName: 'client',
      sessionExternalId: 'alice-backup-security-session',
      turnExternalId: 'alice-backup-security-turn',
      role: 'user',
      content: 'Alice 的私密原始回合。',
    }).turn;
    const bobTurn = fixture.lifecycleStore.recordTurn({
      userId: 'bob',
      namespace: 'shared-fixture',
      clientName: 'client',
      sessionExternalId: 'bob-backup-security-session',
      turnExternalId: 'bob-backup-security-turn',
      role: 'user',
      content: 'Bob 的私密原始回合。',
    }).turn;
    fixture.memoryStore.remember({
      userId: 'alice',
      namespace: 'shared-fixture',
      kind: 'preference',
      content: 'Alice 偏好海蓝色。',
      stableKey: '用户::颜色偏好',
    });
    fixture.memoryStore.remember({
      userId: 'bob',
      namespace: 'shared-fixture',
      kind: 'preference',
      content: 'Bob 偏好海蓝色。',
      stableKey: '用户::颜色偏好',
    });

    const beforeAlice = fixture.memoryStore.exportAll('alice');
    const beforeBob = fixture.memoryStore.exportAll('bob');
    const poisoned = structuredClone(beforeAlice);
    const turnOutbox = poisoned.state?.outbox.find(
      (row) =>
        row.aggregate_type === 'turn' &&
        row.aggregate_id === aliceTurn.id,
    );
    assert.ok(turnOutbox);
    turnOutbox.payload_json = JSON.stringify({
      turnId: bobTurn.id,
    });

    assert.throws(
      () => fixture.memoryStore.importAll(poisoned, 'alice'),
      /outbox.*(?:payload|turn|作用域|账户)/u,
    );

    const afterAlice = fixture.memoryStore.exportAll('alice');
    const afterBob = fixture.memoryStore.exportAll('bob');
    assert.deepEqual(
      { ...afterAlice, exportedAt: beforeAlice.exportedAt },
      beforeAlice,
    );
    assert.deepEqual(
      { ...afterBob, exportedAt: beforeBob.exportedAt },
      beforeBob,
    );
  } finally {
    fixture.close();
  }
});

test('完整导入按 outbox principal 清理且仅为 legacy NULL owner 回退聚合', () => {
  const fixture = createFixture();
  try {
    const aliceTurn = fixture.lifecycleStore.recordTurn({
      userId: 'alice',
      namespace: 'shared-fixture',
      clientName: 'client',
      sessionExternalId: 'alice-import-owner-session',
      turnExternalId: 'alice-import-owner-turn',
      role: 'user',
      content: 'Alice 的导入边界回合。',
    }).turn;
    const bobTurn = fixture.lifecycleStore.recordTurn({
      userId: 'bob',
      namespace: 'shared-fixture',
      clientName: 'client',
      sessionExternalId: 'bob-import-owner-session',
      turnExternalId: 'bob-import-owner-turn',
      role: 'user',
      content: 'Bob 的导入边界回合。',
    }).turn;
    const aliceBackup = fixture.memoryStore.exportAll('alice');
    const bobOutboxId = `turn:${bobTurn.id}:recorded`;
    fixture.database
      .prepare(
        `UPDATE outbox_events
         SET aggregate_id = ?, event_type = ?
         WHERE id = ?`,
      )
      .run(
        aliceTurn.id,
        'turn.cross-principal-corrupt',
        bobOutboxId,
      );
    const timestamp = '2026-07-31T00:00:00.000Z';
    fixture.database
      .prepare(
        `INSERT INTO outbox_events (
           id, aggregate_type, aggregate_id, event_type,
           payload_json, available_at, created_at, user_id, namespace
         ) VALUES (?, 'turn', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'alice-owned-cross-aggregate',
        bobTurn.id,
        'turn.alice-owned-cross-aggregate',
        JSON.stringify({ turnId: bobTurn.id }),
        timestamp,
        timestamp,
        'alice',
        'shared-fixture',
      );
    fixture.database
      .prepare(
        `INSERT INTO outbox_events (
           id, aggregate_type, aggregate_id, event_type,
           payload_json, available_at, created_at, user_id, namespace
         ) VALUES (?, 'turn', ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        'legacy-null-alice-aggregate',
        aliceTurn.id,
        'turn.legacy-null-owner',
        JSON.stringify({ turnId: aliceTurn.id }),
        timestamp,
        timestamp,
      );

    fixture.memoryStore.importAll(aliceBackup, 'alice');

    assert.deepEqual(
      {
        ...fixture.database
          .prepare(
            `SELECT id, user_id, aggregate_type, aggregate_id,
                    event_type
             FROM outbox_events
             WHERE id = ?`,
          )
          .get(bobOutboxId),
      },
      {
        id: bobOutboxId,
        user_id: 'bob',
        aggregate_type: 'turn',
        aggregate_id: aliceTurn.id,
        event_type: 'turn.cross-principal-corrupt',
      },
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM outbox_events
           WHERE id IN (
             'alice-owned-cross-aggregate',
             'legacy-null-alice-aggregate'
           )`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      fixture.lifecycleStore.getTurn(
        bobTurn.id,
        'bob',
        'shared-fixture',
      )?.content,
      'Bob 的导入边界回合。',
    );
  } finally {
    fixture.close();
  }
});

test('缺少可信会话的 v2 非个人 scope 与旧 project scope 在替换前失败关闭', () => {
  const source = createFixture();
  const v2Target = createFixture();
  const v3Target = createFixture();
  try {
    source.memoryStore.remember({
      kind: 'project',
      content: '旧备份中的项目记忆不能获得新身份权威。',
      stableKey: '项目::旧备份作用域',
      scopeType: 'project',
      scopeKey: 'Project-A',
    });
    const current = source.memoryStore.exportAll();
    const legacyV3 = structuredClone(current);
    legacyV3.schemaVersion = 25;
    const legacyV2 = structuredClone(current);
    legacyV2.version = 2;
    delete legacyV2.schemaVersion;
    delete legacyV2.state;
    const legacyV2Role = structuredClone(legacyV2);
    legacyV2Role.memories[0].scopeType = 'role';
    legacyV2Role.memories[0].scopeKey = 'persona-orphan';
    const legacyV2Session = structuredClone(legacyV2);
    legacyV2Session.memories[0].scopeType = 'session';
    legacyV2Session.memories[0].scopeKey = 'session-orphan';
    const legacyV2InvalidPersonal = structuredClone(legacyV2);
    legacyV2InvalidPersonal.memories[0].scopeType = 'personal';
    legacyV2InvalidPersonal.memories[0].scopeKey = 'not-self';

    const v2Sentinel = v2Target.memoryStore.remember({
      kind: 'knowledge',
      content: 'v2 失败导入不能删除这条哨兵。',
      stableKey: '备份::v2 哨兵',
    }).memory;
    const v3Sentinel = v3Target.memoryStore.remember({
      kind: 'knowledge',
      content: 'v3 失败导入不能删除这条哨兵。',
      stableKey: '备份::v3 哨兵',
    }).memory;

    assert.throws(
      () => v2Target.memoryStore.importAll(legacyV2),
      /旧版.*project scope.*(?:quarantine|rebind|隔离|重绑)/u,
    );
    assert.throws(
      () => v3Target.memoryStore.importAll(legacyV3),
      /旧版.*project scope.*(?:quarantine|rebind|隔离|重绑)/u,
    );
    assert.throws(
      () => v2Target.memoryStore.importAll(legacyV2Role),
      /v2.*(?:role|非个人).*可信会话/u,
    );
    assert.throws(
      () => v2Target.memoryStore.importAll(legacyV2Session),
      /v2.*(?:session|非个人).*可信会话/u,
    );
    assert.throws(
      () => v2Target.memoryStore.importAll(legacyV2InvalidPersonal),
      /v2.*personal\/self.*可信会话/u,
    );
    assert.equal(
      v2Target.memoryStore.get(v2Sentinel.id)?.id,
      v2Sentinel.id,
    );
    assert.equal(
      v3Target.memoryStore.get(v3Sentinel.id)?.id,
      v3Sentinel.id,
    );
  } finally {
    source.close();
    v2Target.close();
    v3Target.close();
  }
});

test('普通 JSON 不能凭 schemaVersion 伪造 complete persona/project 绑定', () => {
  const source = createFixture();
  const target = createFixture();
  try {
    source.lifecycleStore.recordTurn({
      personaId: 'persona-A',
      projectId: 'Project-A',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-provenance-source',
      clientName: 'client',
      sessionExternalId: 'provenance-session',
      turnExternalId: 'provenance-source-turn',
      role: 'user',
      content: '来源 JSON 自称属于 Project-A。',
    });
    target.lifecycleStore.recordTurn({
      personaId: 'persona-B',
      projectId: 'Project-B',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-provenance-target',
      clientName: 'client',
      sessionExternalId: 'provenance-session',
      turnExternalId: 'provenance-target-turn',
      role: 'user',
      content: '目标库的可信绑定属于 Project-B。',
    });
    const sentinel = target.memoryStore.remember({
      kind: 'knowledge',
      content: '身份来源校验失败不能替换目标库。',
      stableKey: '备份::身份来源哨兵',
    }).memory;
    const forged = structuredClone(source.memoryStore.exportAll());

    assert.throws(
      () => target.memoryStore.importAll(forged),
      /身份绑定.*(?:未经信任|quarantine|rebind|隔离|重绑|不一致)/u,
    );
    assert.equal(target.memoryStore.get(sentinel.id)?.id, sentinel.id);
  } finally {
    source.close();
    target.close();
  }
});

test('完整备份拒绝投影、记忆项和当前版本的 owner/namespace/kind/status/scope 错配', () => {
  const source = createFixture();
  const target = createFixture();
  try {
    const first = source.memoryStore.remember({
      kind: 'preference',
      content: '用户偏好深色主题。',
      stableKey: '用户::主题偏好',
    }).memory;
    const second = source.memoryStore.remember({
      kind: 'knowledge',
      content: '第二条记忆只用于交叉指针测试。',
      stableKey: '备份::交叉指针',
    }).memory;
    const backup = source.memoryStore.exportAll();
    const sentinel = target.memoryStore.remember({
      kind: 'knowledge',
      content: '投影校验失败不能删除目标哨兵。',
      stableKey: '备份::投影哨兵',
    }).memory;

    const projectionScope = structuredClone(backup);
    const firstProjection = projectionScope.memories.find(
      (memory) => memory.id === first.id,
    )!;
    firstProjection.scopeType = 'project';
    firstProjection.scopeKey = 'Project-A';

    const itemNamespace = structuredClone(backup);
    itemNamespace.state!.items.find(
      (row) => row.id === first.id,
    )!.namespace = 'forged-namespace';

    const itemStatus = structuredClone(backup);
    itemStatus.state!.items.find(
      (row) => row.id === first.id,
    )!.status = 'archived';

    const crossItemVersion = structuredClone(backup);
    const secondCurrentVersionId = crossItemVersion.state!.items.find(
      (row) => row.id === second.id,
    )!.current_version_id;
    crossItemVersion.state!.items.find(
      (row) => row.id === first.id,
    )!.current_version_id = secondCurrentVersionId;

    for (const [poisoned, expected] of [
      [projectionScope, /投影.*scope.*不一致/u],
      [itemNamespace, /投影.*namespace.*不一致/u],
      [itemStatus, /投影.*status.*不一致/u],
      [crossItemVersion, /当前版本.*不属于.*记忆项/u],
    ] as const) {
      assert.throws(
        () => target.memoryStore.importAll(poisoned),
        expected,
      );
      assert.equal(target.memoryStore.get(sentinel.id)?.id, sentinel.id);
    }
  } finally {
    source.close();
    target.close();
  }
});

test('完整备份拒绝 candidate/action/evidence 越过 turn→session→project 边界', () => {
  const source = createFixture();
  const target = createFixture();
  try {
    const turnA = source.lifecycleStore.recordTurn({
      personaId: 'persona-A',
      projectId: 'Project-A',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-chain-A',
      clientName: 'client',
      sessionExternalId: 'chain-session-A',
      turnExternalId: 'chain-turn-A',
      role: 'user',
      content: 'Project-A 使用深色主题。',
    }).turn;
    const turnB = source.lifecycleStore.recordTurn({
      personaId: 'persona-B',
      projectId: 'Project-B',
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: 'round-chain-B',
      clientName: 'client',
      sessionExternalId: 'chain-session-B',
      turnExternalId: 'chain-turn-B',
      role: 'user',
      content: 'Project-B 使用浅色主题。',
    }).turn;
    const runId = source.lifecycleStore.startExtraction(
      turnA.id,
      'qwen2.5:14b',
      'chain-v1',
    );
    const [candidate] = source.lifecycleStore.completeExtraction(
      runId,
      [{
        kind: 'preference',
        subject: 'Project-A',
        predicate: '主题',
        value: '深色',
        content: 'Project-A 使用深色主题。',
        confidence: 0.99,
        importance: 0.8,
        scopeType: 'project',
        scopeKey: 'attacker-value-is-overridden',
      }],
    );
    const memory = source.memoryStore.remember({
      kind: 'preference',
      content: candidate.content,
      stableKey: candidate.stableKey,
      scopeType: 'project',
      scopeKey: 'Project-A',
      evidenceTurnId: turnA.id,
      evidenceExcerpt: turnA.content,
      source: 'automatic-extraction',
    }).memory;
    source.memoryStore.update(memory.id, {
      content: 'Project-A 现在使用纯黑主题。',
    });
    const projectBMemory = source.memoryStore.remember({
      kind: 'preference',
      content: 'Project-B 使用浅色主题。',
      stableKey: 'project-b::theme',
      scopeType: 'project',
      scopeKey: 'Project-B',
    }).memory;
    source.lifecycleStore.updateCandidateState(
      candidate.id,
      'accepted',
      '生成 candidate outbox fixture',
      memory.id,
    );
    source.database
      .prepare(
        `INSERT INTO memory_action_requests (
           id, user_id, namespace, request_key, action, status,
           target_query, target_memory_id, candidate_id, turn_id,
           confidence, sensitivity, model, prompt_version, rationale,
           created_at
         ) VALUES (
           'chain-action', 'default', 'personal', 'chain-action-key',
           'correct', 'pending', '主题', ?, ?, ?, 0.9, 'normal',
           'qwen2.5:14b', 'chain-v1', '等待确认', ?
         )`,
      )
      .run(
        memory.id,
        candidate.id,
        turnA.id,
        '2026-08-01T00:00:00.000Z',
      );
    const backup = source.memoryStore.exportAll();

    for (const input of [
      {
        personaId: 'persona-A',
        projectId: 'Project-A',
        roundId: 'round-target-chain-A',
        sessionExternalId: 'chain-session-A',
      },
      {
        personaId: 'persona-B',
        projectId: 'Project-B',
        roundId: 'round-target-chain-B',
        sessionExternalId: 'chain-session-B',
      },
    ]) {
      target.lifecycleStore.recordTurn({
        ...input,
        identitySource: 'credential',
        identityStatus: 'complete',
        clientName: 'client',
        turnExternalId: `${input.sessionExternalId}-anchor-turn`,
        role: 'user',
        content: '目标库可信身份锚。',
      });
    }
    const sentinel = target.memoryStore.remember({
      kind: 'knowledge',
      content: '链路校验失败不能删除目标哨兵。',
      stableKey: '备份::链路哨兵',
    }).memory;

    const candidateCrossProject = structuredClone(backup);
    candidateCrossProject.state!.candidates.find(
      (row) => row.id === candidate.id,
    )!.scope_key = 'Project-B';

    const actionCrossProject = structuredClone(backup);
    actionCrossProject.state!.actionRequests.find(
      (row) => row.id === 'chain-action',
    )!.turn_id = turnB.id;

    const evidenceCrossProject = structuredClone(backup);
    const evidence = evidenceCrossProject.state!.evidence.find(
      (row) => row.turn_id === turnA.id,
    );
    assert.ok(evidence);
    evidence.turn_id = turnB.id;

    const historicalVersionOrphan = structuredClone(backup);
    const historicalItem = historicalVersionOrphan.state!.items.find(
      (row) => row.id === memory.id,
    )!;
    const historicalVersion = historicalVersionOrphan.state!.versions.find(
      (row) =>
        row.memory_item_id === memory.id &&
        row.id !== historicalItem.current_version_id,
    );
    assert.ok(historicalVersion);
    historicalVersion.scope_type = 'project';
    historicalVersion.scope_key = 'Project-Orphan';

    const historicalEvidenceCrossProject = structuredClone(backup);
    const evidenceItem = historicalEvidenceCrossProject.state!.items.find(
      (row) => row.id === memory.id,
    )!;
    const evidenceVersion = historicalEvidenceCrossProject.state!.versions.find(
      (row) =>
        row.memory_item_id === memory.id &&
        row.id !== evidenceItem.current_version_id,
    );
    assert.ok(evidenceVersion);
    evidenceVersion.scope_type = 'project';
    evidenceVersion.scope_key = 'Project-B';

    const actionCandidateJsonCrossProject = structuredClone(backup);
    actionCandidateJsonCrossProject.state!.actionRequests.find(
      (row) => row.id === 'chain-action',
    )!.candidate_json = JSON.stringify({
      scopeType: 'project',
      scopeKey: 'Project-B',
      accessScopeType: 'personal',
      accessScopeKey: 'self',
    });

    const turnOutboxCrossProject = structuredClone(backup);
    const turnOutbox = turnOutboxCrossProject.state!.outbox.find(
      (row) =>
        row.aggregate_type === 'turn' &&
        row.aggregate_id === turnA.id,
    );
    assert.ok(turnOutbox);
    turnOutbox.payload_json = JSON.stringify({
      turnId: turnA.id,
      action: {
        scopeType: 'project',
        scopeKey: 'Project-B',
      },
    });

    const candidateOutboxCrossProject = structuredClone(backup);
    const candidateOutbox = candidateOutboxCrossProject.state!.outbox.find(
      (row) =>
        row.aggregate_type === 'memory_candidate' &&
        row.aggregate_id === candidate.id,
    );
    assert.ok(candidateOutbox);
    candidateOutbox.payload_json = JSON.stringify({
      candidateId: candidate.id,
      resolvedMemoryItemId: projectBMemory.id,
    });

    for (const [poisoned, expected] of [
      [candidateCrossProject, /候选.*project.*会话.*不一致/u],
      [actionCrossProject, /自然意图请求.*(?:候选|目标).*会话.*不一致/u],
      [evidenceCrossProject, /证据.*project.*会话.*不一致/u],
      [historicalVersionOrphan, /历史版本.*project.*可信会话/u],
      [historicalEvidenceCrossProject, /证据.*project.*会话.*不一致/u],
      [actionCandidateJsonCrossProject, /自然意图请求.*JSON.*project.*会话.*不一致/u],
      [turnOutboxCrossProject, /outbox.*project.*会话.*不一致/u],
      [candidateOutboxCrossProject, /candidate outbox.*解析目标.*会话.*不一致/u],
    ] as const) {
      assert.throws(
        () => target.memoryStore.importAll(poisoned),
        expected,
      );
      assert.equal(target.memoryStore.get(sentinel.id)?.id, sentinel.id);
    }
  } finally {
    source.close();
    target.close();
  }
});

test('低层直写的 role/session/project、tombstone、derived 和任务 scope 都必须映射可信会话', () => {
  const source = createFixture();
  const target = createFixture();
  try {
    const memory = source.memoryStore.remember({
      kind: 'preference',
      content: '这条记忆用于验证所有低层 scope 入口。',
      stableKey: '备份::低层 scope 入口',
    }).memory;
    source.memoryStore.forget(memory.id, '生成 tombstone fixture');
    const backup = source.memoryStore.exportAll();
    const sentinel = target.memoryStore.remember({
      kind: 'knowledge',
      content: '低层 scope 校验失败不能删除目标哨兵。',
      stableKey: '备份::低层 scope 哨兵',
    }).memory;
    const timestamp = '2026-08-01T00:00:00.000Z';
    const variants: Array<[
      typeof backup,
      RegExp,
    ]> = [];

    for (const [scopeType, scopeKey] of [
      ['role', 'persona-orphan'],
      ['session', 'session-orphan'],
      ['project', 'Project-Orphan'],
    ] as const) {
      const poisoned = structuredClone(backup);
      const projection = poisoned.memories.find(
        (row) => row.id === memory.id,
      )!;
      projection.scopeType = scopeType;
      projection.scopeKey = scopeKey;
      const item = poisoned.state!.items.find(
        (row) => row.id === memory.id,
      )!;
      item.scope_type = scopeType;
      item.scope_key = scopeKey;
      const version = poisoned.state!.versions.find(
        (row) => row.id === item.current_version_id,
      )!;
      version.scope_type = scopeType;
      version.scope_key = scopeKey;
      for (const tombstone of poisoned.state!.tombstones) {
        if (tombstone.memory_item_id === memory.id) {
          tombstone.scope_type = scopeType;
          tombstone.scope_key = scopeKey;
        }
      }
      variants.push([
        poisoned,
        new RegExp(`投影.*${scopeType}.*可信会话`, 'u'),
      ]);
    }

    const tombstoneProject = structuredClone(backup);
    const tombstone = tombstoneProject.state!.tombstones.find(
      (row) => row.memory_item_id === memory.id,
    )!;
    tombstone.scope_type = 'project';
    tombstone.scope_key = 'Project-Orphan';
    variants.push([
      tombstoneProject,
      /tombstone.*(?:scope.*不一致|project.*可信会话)/u,
    ]);

    const derivedProject = structuredClone(backup);
    derivedProject.state!.consolidations.push({
      id: 'unbound-project-consolidation',
      memory_id: null,
      user_id: 'default',
      namespace: 'personal',
      scope_type: 'project',
      scope_key: 'Project-Orphan',
      source_set_hash: 'unbound-project-source-set',
      model: 'qwen2.5:14b',
      prompt_version: 'test-v1',
      status: 'quarantined',
      generated_at: timestamp,
      stale_at: null,
      last_error: null,
      revision: 1,
    });
    variants.push([
      derivedProject,
      /派生摘要.*project.*可信会话/u,
    ]);

    const derivedSourceCrossNamespace = structuredClone(backup);
    const sourceItem = derivedSourceCrossNamespace.state!.items.find(
      (row) => row.id === memory.id,
    )!;
    derivedSourceCrossNamespace.state!.consolidations.push({
      id: 'cross-namespace-consolidation',
      memory_id: null,
      user_id: 'default',
      namespace: 'other-namespace',
      scope_type: 'topic',
      scope_key: 'kind:preference',
      source_set_hash: 'cross-namespace-source-set',
      model: 'qwen2.5:14b',
      prompt_version: 'test-v1',
      status: 'quarantined',
      generated_at: timestamp,
      stale_at: null,
      last_error: null,
      revision: 1,
    });
    derivedSourceCrossNamespace.state!.consolidationSources.push({
      consolidation_id: 'cross-namespace-consolidation',
      memory_version_id: sourceItem.current_version_id,
    });
    variants.push([
      derivedSourceCrossNamespace,
      /派生来源.*namespace.*不一致/u,
    ]);

    const jobProject = structuredClone(backup);
    const job = jobProject.state!.jobs[0];
    assert.ok(job);
    job.payload_json = JSON.stringify({
      scopeType: 'project',
      scopeKey: 'Project-Orphan',
    });
    variants.push([jobProject, /任务.*project.*可信会话/u]);

    const jobMissingScopeKey = structuredClone(backup);
    jobMissingScopeKey.state!.jobs[0].payload_json = JSON.stringify({
      scopeType: 'project',
    });
    variants.push([
      jobMissingScopeKey,
      /任务.*project scope.*缺少 key/u,
    ]);

    const jobInvalidPersonal = structuredClone(backup);
    jobInvalidPersonal.state!.jobs[0].payload_json = JSON.stringify({
      scopeType: 'personal',
      scopeKey: 'not-self',
    });
    variants.push([
      jobInvalidPersonal,
      /任务.*personal scope 无效/u,
    ]);

    const deadLetterProject = structuredClone(backup);
    deadLetterProject.state!.deadLetters.push({
      job_id: 'unbound-project-dead-letter',
      job_type: 'consolidate_scope',
      user_id: 'default',
      namespace: 'personal',
      payload_json: JSON.stringify({
        accessScopeType: 'project',
        accessScopeKey: 'Project-Orphan',
      }),
      attempts: 5,
      last_error: 'fixture',
      failed_at: timestamp,
    });
    variants.push([
      deadLetterProject,
      /dead letter.*project.*可信会话/u,
    ]);

    const deadLetterUnknownScope = structuredClone(deadLetterProject);
    deadLetterUnknownScope.state!.deadLetters[0].payload_json =
      JSON.stringify({
        accessScopeType: 'unknown',
        accessScopeKey: 'attacker-value',
      });
    variants.push([
      deadLetterUnknownScope,
      /dead letter.*无效 scope/u,
    ]);

    for (const [poisoned, expected] of variants) {
      assert.throws(
        () => target.memoryStore.importAll(poisoned),
        expected,
      );
      assert.equal(target.memoryStore.get(sentinel.id)?.id, sentinel.id);
    }
  } finally {
    source.close();
    target.close();
  }
});

test('Dense 重建任务插入失败时完整导入与替换事务一起回滚', () => {
  const source = createFixture();
  const target = createFixture(new BackupDenseRanker());
  try {
    source.memoryStore.remember({
      kind: 'preference',
      content: '导入后需要重建 Dense 索引。',
      stableKey: '备份::Dense 原子性来源',
    });
    const backup = source.memoryStore.exportAll();
    const sentinel = target.memoryStore.remember({
      kind: 'knowledge',
      content: 'Dense 排队失败时必须保留这条哨兵。',
      stableKey: '备份::Dense 原子性哨兵',
    }).memory;
    target.database.exec(`
      CREATE TRIGGER fail_dense_rebuild_enqueue
      BEFORE INSERT ON memory_jobs
      WHEN NEW.job_type = 'backfill_dense_index'
      BEGIN
        SELECT RAISE(ABORT, 'dense rebuild fault');
      END;
    `);

    assert.throws(
      () => target.memoryStore.importAll(backup),
      /dense rebuild fault/u,
    );
    assert.equal(target.memoryStore.get(sentinel.id)?.id, sentinel.id);
    assert.equal(target.memoryStore.list().total, 1);
  } finally {
    source.close();
    target.close();
  }
});
