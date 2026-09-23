import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDatabase } from '../dist/server/database.js';
import { embedText, vectorToBuffer } from '../dist/server/embedding.js';
import { HybridRetrievalIndex } from '../dist/server/hybrid-retrieval.js';
import { LifecycleStore } from '../dist/server/lifecycle-store.js';
import { MemoryReflectionService } from '../dist/server/memory-reflection.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import {
  parseScaleBenchmarkArgs,
  writeScaleBenchmarkReceipt,
} from './benchmark-scale-lib.mjs';

const options = parseScaleBenchmarkArgs(process.argv.slice(2));

const MEMORY_COUNT = 100_000;
const TURN_COUNT = 1_000_000;
const SESSION_COUNT = 100;
const MEMORY_CHUNK_SIZE = 10_000;
const TURN_CHUNK_SIZE = 50_000;
const SAMPLE_COUNT = 40;

const semanticTargets = [
  {
    queryMarker: '玄鹤',
    contentMarker: '日出前整理',
    content: '用户习惯在日出前整理当天的任务。',
  },
  {
    queryMarker: '赤狐',
    contentMarker: '空白数据',
    content: '用户在编写新程序时坚持从空白数据开始。',
  },
  {
    queryMarker: '蓝鲸',
    contentMarker: '纸质版本',
    content: '用户阅读长文时更喜欢纸质版本。',
  },
];

function targetIndex(text) {
  return semanticTargets.findIndex(
    (target) =>
      text.includes(target.queryMarker) ||
      text.includes(target.contentMarker),
  );
}

function controlledVector(index) {
  if (index < 0) {
    return Float32Array.from(
      { length: 96 },
      (_, dimension) => (dimension % 3 === 0 ? -1 : -0.25),
    );
  }
  return Float32Array.from(
    { length: 96 },
    (_, dimension) =>
      Math.sin((dimension + 1) * (index + 1) * 0.71) +
      Math.cos((dimension + 3) * (index + 2) * 0.37),
  );
}

const ranker = {
  embeddingModel: 'scale-deterministic-embedding-v1',
  rerankModel: 'scale-deterministic-reranker-v1',
  async embed(texts) {
    return texts.map((text) => controlledVector(targetIndex(text)));
  },
  async rerank(query, candidates) {
    const expected = targetIndex(query);
    return candidates.map((candidate) => {
      const relevant = targetIndex(candidate.memory) === expected;
      return {
        id: candidate.id,
        relevant,
        confidence: relevant ? 1 : 0,
        reason: relevant ? '规模目标一致' : '规模填充项',
      };
    });
  },
};

const scaleExtractor = {
  model: 'qwen2.5:14b',
  promptVersion: 'scale-extractor-prompt-v1',
  extractorId: 'scale-extractor',
  extractorVersion: 'v1',
  async extract() {
    return [];
  },
};

const scaleReflectionProvider = {
  model: 'qwen2.5:14b',
  promptVersion: 'scale-reflection-prompt-v1',
  async reflect() {
    return { candidates: [] };
  },
};

function percentile(values, percentileValue) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.ceil(ordered.length * percentileValue) - 1,
  );
  return ordered[index] || 0;
}

async function measure(samples, operation) {
  const values = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation(index);
    values.push(performance.now() - started);
  }
  return {
    samples,
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-bridge-scale-'),
);
const databasePath = path.join(directory, 'benchmark.sqlite3');
const database = openDatabase(databasePath);
const store = new MemoryStore(database, ranker);
const targetPositions = [1_000, 10_000, MEMORY_COUNT - 1];
const targetByPosition = new Map(
  targetPositions.map((position, index) => [
    position,
    {
      id: `scale-boundary-${position + 1}`,
      ...semanticTargets[index],
    },
  ]),
);
const timings = {};

try {
  const memoryInsert = database.prepare(
    `INSERT INTO memories (
       id, user_id, namespace, kind, title, content, summary,
       tags_json, importance, confidence, status, source, source_ref,
       occurred_at, valid_from, valid_to, created_at, updated_at,
       last_seen_at, access_count, checksum, embedding
     ) VALUES (
       ?, 'default', 'personal', 'knowledge', ?, ?, '', '[]',
       0.8, 1, 'active', 'scale-benchmark', NULL,
       NULL, NULL, NULL, ?, ?, ?, 0, ?, ?
     )`,
  );
  const fillerVector = vectorToBuffer(embedText('普通规模填充记录'));
  const memoryBase = Date.parse('2026-07-29T12:00:00.000Z');
  let started = performance.now();
  for (
    let chunkStart = 0;
    chunkStart < MEMORY_COUNT;
    chunkStart += MEMORY_CHUNK_SIZE
  ) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const chunkEnd = Math.min(
        MEMORY_COUNT,
        chunkStart + MEMORY_CHUNK_SIZE,
      );
      for (let index = chunkStart; index < chunkEnd; index += 1) {
        const target = targetByPosition.get(index);
        const timestamp = new Date(
          memoryBase - index * 1_000,
        ).toISOString();
        memoryInsert.run(
          target?.id || `scale-memory-${index}`,
          `规模记录 ${index}`,
          target?.content || `普通规模填充记录 ${index}。`,
          timestamp,
          timestamp,
          timestamp,
          String(index).padStart(64, '0').slice(-64),
          fillerVector,
        );
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  timings.seedMemoriesMs = Number(
    (performance.now() - started).toFixed(3),
  );

  const sessionInsert = database.prepare(
    `INSERT INTO conversation_sessions (
       id, user_id, namespace, client_name, external_id,
       started_at, metadata_json
     ) VALUES (?, 'default', 'personal', 'scale-benchmark', ?, ?, '{}')`,
  );
  const sessionTimestamp = '2026-07-29T12:00:00.000Z';
  database.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < SESSION_COUNT; index += 1) {
      sessionInsert.run(
        `scale-session-${index}`,
        `scale-session-${index}`,
        sessionTimestamp,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  const turnInsert = database.prepare(
    `INSERT INTO conversation_turns (
       id, session_id, user_id, namespace, external_id, role,
       content, content_hash, occurred_at, created_at, metadata_json
     ) VALUES (
       ?, ?, 'default', 'personal', ?, ?, ?, ?, ?, ?, '{}'
     )`,
  );
  started = performance.now();
  for (
    let chunkStart = 0;
    chunkStart < TURN_COUNT;
    chunkStart += TURN_CHUNK_SIZE
  ) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const chunkEnd = Math.min(
        TURN_COUNT,
        chunkStart + TURN_CHUNK_SIZE,
      );
      for (let index = chunkStart; index < chunkEnd; index += 1) {
        const sessionIndex = Math.floor(
          index / (TURN_COUNT / SESSION_COUNT),
        );
        const role = index % 2 === 0 ? 'user' : 'assistant';
        const timestamp = new Date(
          memoryBase + index,
        ).toISOString();
        turnInsert.run(
          `scale-turn-${index}`,
          `scale-session-${sessionIndex}`,
          `turn-${index}`,
          role,
          `规模回合 ${index}`,
          String(index).padStart(64, 'a').slice(-64),
          timestamp,
          timestamp,
        );
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  timings.seedTurnsMs = Number(
    (performance.now() - started).toFixed(3),
  );

  started = performance.now();
  let backfill = await store.backfillDenseIndex(256);
  while (!backfill.complete) {
    assert.ok(backfill.processed > 0, 'Dense 回填必须持续前进');
    backfill = await store.backfillDenseIndex(256);
  }
  timings.denseBackfillMs = Number(
    (performance.now() - started).toFixed(3),
  );
  assert.equal(backfill.eligible, MEMORY_COUNT);
  assert.equal(backfill.indexed, MEMORY_COUNT);

  const memoryCount = Number(
    database
      .prepare('SELECT COUNT(*) AS count FROM memories')
      .get().count,
  );
  const turnCount = Number(
    database
      .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
      .get().count,
  );
  assert.equal(memoryCount, MEMORY_COUNT);
  assert.equal(turnCount, TURN_COUNT);

  for (const target of targetByPosition.values()) {
    const recalled = await store.recallReliable({
      query: `${target.queryMarker}问题的答案是什么？`,
      limit: 3,
    });
    assert.equal(recalled[0]?.memory.id, target.id);
  }

  const retrievalIndex = new HybridRetrievalIndex(database);
  const queryTarget = targetByPosition.get(MEMORY_COUNT - 1);
  const query = `${queryTarget.queryMarker}问题的答案是什么？`;
  const queryVector = controlledVector(
    targetIndex(query),
  );
  const searchInput = {
    query,
    userId: 'default',
    namespace: 'personal',
    scopeType: 'personal',
    scopeKey: 'self',
    allowedSensitivities: ['normal'],
    limit: 120,
    timestamp: new Date().toISOString(),
    denseVector: queryVector,
    denseModel: backfill.model,
    denseGenerationKey: backfill.generationKey,
    denseGenerationId: backfill.generationId,
  };
  for (let index = 0; index < 5; index += 1) {
    retrievalIndex.search(searchInput);
    await store.getContextReliable({ query, limit: 8 });
  }
  const candidateGeneration = await measure(
    SAMPLE_COUNT,
    () => retrievalIndex.search(searchInput),
  );
  const nonLlmRetrieval = await measure(
    SAMPLE_COUNT,
    () => store.getContextReliable({ query, limit: 8 }),
  );
  const reflectionClock = () => new Date('2026-08-10T12:00:00.000Z');
  const reflectionService = new MemoryReflectionService(
    database,
    new LifecycleStore(database, reflectionClock),
    scaleExtractor,
    scaleReflectionProvider,
    {
      maxTurns: 40,
      tokenBudget: 8_000,
      lookbackDays: 30,
      minNewTurns: 1,
      clock: reflectionClock,
    },
  );
  const reflectionScope = {
    userId: 'default',
    namespace: 'personal',
    scopeType: 'personal',
    scopeKey: 'self',
  };
  const initialReflectionPreview = await reflectionService.preview(
    reflectionScope,
  );
  started = performance.now();
  const initialReflectionSweep = reflectionService.runSweep(
    'default',
    'personal',
    0,
  );
  timings.initialReflectionSweepMs = Number(
    (performance.now() - started).toFixed(3),
  );
  assert.equal(initialReflectionSweep.scopes, SESSION_COUNT + 1);
  assert.equal(initialReflectionSweep.queuedRuns, (SESSION_COUNT + 1) * 2);
  assert.equal(initialReflectionSweep.discoveryWatermark, TURN_COUNT);
  const initialPendingRuns = database.prepare(
    `SELECT id
     FROM memory_reflection_runs
     WHERE status = 'pending'
     ORDER BY id`,
  ).all();
  assert.equal(initialPendingRuns.length, (SESSION_COUNT + 1) * 2);
  for (const run of initialPendingRuns) {
    reflectionService.cancelRun(String(run.id), 'default');
  }
  const activeRunsAfterInitialDrain = Number(database.prepare(
    `SELECT COUNT(*) AS count
     FROM memory_reflection_runs
     WHERE status IN ('pending', 'running')`,
  ).get().count);
  assert.equal(activeRunsAfterInitialDrain, 0);
  const checkpointIngestSeq = TURN_COUNT - 80;
  const checkpointTurn = database.prepare(
    `SELECT o.turn_id, t.occurred_at
     FROM memory_turn_ingest_order o
     JOIN conversation_turns t ON t.id = o.turn_id
     WHERE o.ingest_seq = ?`,
  ).get(checkpointIngestSeq);
  assert.ok(checkpointTurn, '百万 turn checkpoint 必须存在');
  const checkpointInsert = database.prepare(
    `INSERT INTO memory_reflection_checkpoints (
       id, user_id, namespace, scope_type, scope_key,
       run_type, generation_key, last_ingest_seq,
       last_turn_occurred_at, last_turn_id,
       extractor_id, extractor_version, extraction_prompt_version,
       reflection_model, reflection_prompt_version,
       implementation_version, last_success_at, created_at, updated_at
     ) VALUES (
       ?, 'default', 'personal', ?, ?,
       ?, ?, ?, ?, ?,
       'scale-extractor', 'v1', 'scale-extractor-prompt-v1',
       'qwen2.5:14b', 'scale-reflection-prompt-v1',
       'scale-reflection-v1', ?, ?, ?
     )`,
  );
  for (const runType of ['reextract', 'reflect']) {
    checkpointInsert.run(
      `scale-checkpoint-${runType}`,
      'personal',
      'self',
      runType,
      initialReflectionPreview.generationKeys[runType],
      checkpointIngestSeq,
      checkpointTurn.occurred_at,
      checkpointTurn.turn_id,
      reflectionClock().toISOString(),
      reflectionClock().toISOString(),
      reflectionClock().toISOString(),
    );
  }
  const turnsPerSession = TURN_COUNT / SESSION_COUNT;
  for (let sessionIndex = 0; sessionIndex < SESSION_COUNT; sessionIndex += 1) {
    const lastUserTurnIndex =
      (sessionIndex + 1) * turnsPerSession - 2;
    const lastUserIngestSeq = lastUserTurnIndex + 1;
    const lastUserOccurredAt = new Date(
      memoryBase + lastUserTurnIndex,
    ).toISOString();
    for (const runType of ['reextract', 'reflect']) {
      checkpointInsert.run(
        `scale-session-checkpoint-${sessionIndex}-${runType}`,
        'session',
        `scale-session-${sessionIndex}`,
        runType,
        initialReflectionPreview.generationKeys[runType],
        lastUserIngestSeq,
        lastUserOccurredAt,
        `scale-turn-${lastUserTurnIndex}`,
        reflectionClock().toISOString(),
        reflectionClock().toISOString(),
        reflectionClock().toISOString(),
      );
    }
  }
  const incrementalQueryPlan = database.prepare(
    `EXPLAIN QUERY PLAN
     SELECT t.*, o.ingest_seq, s.persona_id, s.project_id,
            s.external_id AS session_external_id
     FROM memory_turn_ingest_order o
     JOIN conversation_turns t ON t.id = o.turn_id
     JOIN conversation_sessions s ON s.id = t.session_id
     WHERE o.user_id = ? AND o.namespace = ?
       AND o.ingest_seq > ?
       AND t.user_id = o.user_id AND t.namespace = o.namespace
       AND t.role = 'user'
       AND t.occurred_at >= ?
     ORDER BY o.ingest_seq ASC
     LIMIT ?`,
  ).all(
    'default',
    'personal',
    checkpointIngestSeq,
    '2026-07-11T12:00:00.000Z',
    40,
  ).map((row) => String(row.detail));
  const usesIngestOwnerIndex = incrementalQueryPlan.some(
    (detail) => detail.includes('memory_turn_ingest_owner_idx'),
  );
  const sweepDiscoveryQueryPlan = database.prepare(
    `EXPLAIN QUERY PLAN
     SELECT DISTINCT s.persona_id, s.project_id, s.external_id
     FROM memory_turn_ingest_order o
       INDEXED BY memory_turn_ingest_owner_idx
     CROSS JOIN conversation_turns t
     CROSS JOIN conversation_sessions s
     WHERE o.user_id = ? AND o.namespace = ?
       AND o.ingest_seq > ? AND o.ingest_seq <= ?
       AND t.id = o.turn_id
       AND s.id = t.session_id
       AND s.user_id = o.user_id AND s.namespace = o.namespace
       AND t.user_id = s.user_id AND t.namespace = s.namespace
       AND t.role = 'user' AND t.occurred_at >= ?
       AND t.created_at <= ?`,
  ).all(
    'default',
    'personal',
    initialReflectionSweep.discoveryWatermark,
    TURN_COUNT,
    '2026-07-11T12:00:00.000Z',
    '2026-08-10T11:30:00.000Z',
  ).map((row) => String(row.detail));
  const sweepDiscoveryUsesIngestOwnerIndex = sweepDiscoveryQueryPlan.some(
    (detail) => detail.includes('memory_turn_ingest_owner_idx'),
  );
  const sessionWindowQueryPlan = database.prepare(
    `EXPLAIN QUERY PLAN
     SELECT t.*, o.ingest_seq, s.persona_id, s.project_id,
            s.external_id AS session_external_id
     FROM conversation_sessions s
     CROSS JOIN memory_turn_ingest_order o
       INDEXED BY memory_turn_ingest_session_idx
     CROSS JOIN conversation_turns t
     WHERE s.user_id = ? AND s.namespace = ?
       AND s.external_id = ?
       AND o.user_id = s.user_id AND o.namespace = s.namespace
       AND o.session_id = s.id AND o.ingest_seq > ?
       AND t.id = o.turn_id AND t.session_id = s.id
       AND t.user_id = s.user_id AND t.namespace = s.namespace
       AND t.role = 'user' AND t.occurred_at >= ?
       AND t.created_at <= ?
     ORDER BY o.ingest_seq ASC
     LIMIT ?`,
  ).all(
    'default',
    'personal',
    'scale-session-0',
    turnsPerSession - 1,
    '2026-07-11T12:00:00.000Z',
    '2026-08-10T11:30:00.000Z',
    40,
  ).map((row) => String(row.detail));
  const sessionWindowUsesIngestIndex = sessionWindowQueryPlan.some(
    (detail) => detail.includes('memory_turn_ingest_session_idx'),
  );
  const incrementalReflectionPreview = await measure(
    SAMPLE_COUNT,
    () => reflectionService.preview(reflectionScope),
  );
  const finalReflectionPreview = await reflectionService.preview(
    reflectionScope,
  );
  assert.equal(finalReflectionPreview.turnCount, 40);
  assert.equal(finalReflectionPreview.pipelines.reextract.turnCount, 40);
  assert.equal(finalReflectionPreview.pipelines.reflect.turnCount, 40);
  assert.ok(finalReflectionPreview.turns.every(
    (turn) => turn.ingestSeq > checkpointIngestSeq,
  ));
  const latestUserTurnIndex = TURN_COUNT - 2;
  const latestUserIngestSeq = latestUserTurnIndex + 1;
  const checkpointCatchup = database.prepare(
    `UPDATE memory_reflection_checkpoints
     SET last_ingest_seq = ?, last_turn_occurred_at = ?, last_turn_id = ?,
         last_success_at = ?, updated_at = ?
     WHERE user_id = 'default' AND namespace = 'personal'
       AND scope_type = 'personal' AND scope_key = 'self'
       AND run_type = ? AND generation_key = ?`,
  );
  for (const runType of ['reextract', 'reflect']) {
    const caughtUp = checkpointCatchup.run(
      latestUserIngestSeq,
      new Date(memoryBase + latestUserTurnIndex).toISOString(),
      `scale-turn-${latestUserTurnIndex}`,
      reflectionClock().toISOString(),
      reflectionClock().toISOString(),
      runType,
      initialReflectionPreview.generationKeys[runType],
    );
    assert.equal(caughtUp.changes, 1);
  }
  const caughtUpPreview = await reflectionService.preview(reflectionScope);
  assert.equal(caughtUpPreview.turnCount, 0);
  assert.equal(caughtUpPreview.pipelines.reextract.turnCount, 0);
  assert.equal(caughtUpPreview.pipelines.reflect.turnCount, 0);
  const activeRunsBeforeStableSweep = Number(database.prepare(
    `SELECT COUNT(*) AS count
     FROM memory_reflection_runs
     WHERE status IN ('pending', 'running')`,
  ).get().count);
  assert.equal(activeRunsBeforeStableSweep, 0);
  const steadyStateReflectionSweep = await measure(
    SAMPLE_COUNT,
    () => {
      const sweep = reflectionService.runSweep(
        'default',
        'personal',
        initialReflectionSweep.discoveryWatermark,
      );
      assert.equal(sweep.scopes, SESSION_COUNT + 1);
      assert.equal(sweep.queuedRuns, 0);
      assert.equal(sweep.discoveryWatermark, TURN_COUNT);
      return sweep;
    },
  );
  const finalReflectionSweep = reflectionService.runSweep(
    'default',
    'personal',
    initialReflectionSweep.discoveryWatermark,
  );
  assert.equal(usesIngestOwnerIndex, true);
  assert.equal(sweepDiscoveryUsesIngestOwnerIndex, true);
  assert.equal(sessionWindowUsesIngestIndex, true);
  assert.equal(finalReflectionSweep.scopes, SESSION_COUNT + 1);
  assert.equal(finalReflectionSweep.queuedRuns, 0);
  assert.equal(finalReflectionSweep.discoveryWatermark, TURN_COUNT);
  const boundaryIds = [...targetByPosition.values()].map(
    (target) => target.id,
  );
  database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const report = {
    format: 'memory-bridge-scale-benchmark-v1',
    completedAt: new Date().toISOString(),
    passed:
      candidateGeneration.p95Ms <= 200 &&
      nonLlmRetrieval.p95Ms <= 350 &&
      incrementalReflectionPreview.p95Ms <= 200 &&
      steadyStateReflectionSweep.p95Ms <= 300 &&
      usesIngestOwnerIndex &&
      sweepDiscoveryUsesIngestOwnerIndex &&
      sessionWindowUsesIngestIndex,
    dataset: {
      memories: memoryCount,
      conversationTurns: turnCount,
      sessions: SESSION_COUNT,
      boundaryPositions: [1_001, 10_001, MEMORY_COUNT],
      boundaryIds,
    },
    thresholds: {
      candidateGenerationP95Ms: 200,
      nonLlmRetrievalP95Ms: 350,
      incrementalReflectionPreviewP95Ms: 200,
      steadyStateReflectionSweepP95Ms: 300,
    },
    measurements: {
      candidateGeneration,
      nonLlmRetrieval,
      incrementalReflectionPreview,
      steadyStateReflectionSweep,
      reflectionIncrementalWindow: {
        checkpointIngestSeq,
        returnedTurns: finalReflectionPreview.turnCount,
        maxTurns: 40,
        minimumReturnedIngestSeq: Math.min(
          ...finalReflectionPreview.turns.map((turn) => turn.ingestSeq),
        ),
        usesIngestOwnerIndex,
        queryPlan: incrementalQueryPlan,
      },
      reflectionSweepDiscovery: {
        initial: initialReflectionSweep,
        cancelledInitialRuns: initialPendingRuns.length,
        activeRunsAfterInitialDrain,
        activeRunsBeforeStableSweep,
        caughtUpPreviewTurns: caughtUpPreview.turnCount,
        steadyState: finalReflectionSweep,
        usesIngestOwnerIndex: sweepDiscoveryUsesIngestOwnerIndex,
        queryPlan: sweepDiscoveryQueryPlan,
      },
      reflectionSessionWindow: {
        usesSessionIngestIndex: sessionWindowUsesIngestIndex,
        queryPlan: sessionWindowQueryPlan,
      },
    },
    setup: {
      ...timings,
      databaseBytes: fs.statSync(databasePath).size,
      denseGenerationId: backfill.generationId,
      denseGenerationKey: backfill.generationKey,
      denseDimensions: backfill.dimensions,
      deterministicProvider: true,
    },
    isolatedDatabaseRemovedOnExit:
      process.env.MEMORY_BRIDGE_KEEP_BENCHMARK !== '1',
  };
  console.log(JSON.stringify(report, null, 2));
  if (options.receipt) {
    const receiptPath = writeScaleBenchmarkReceipt(options.receipt, report);
    console.error(`规模基准回执：${receiptPath}`);
  }
  if (!report.passed) process.exitCode = 1;
} finally {
  database.close();
  if (process.env.MEMORY_BRIDGE_KEEP_BENCHMARK !== '1') {
    fs.rmSync(directory, { recursive: true, force: true });
  } else {
    console.error(`保留隔离基准库：${databasePath}`);
  }
}
