import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CandidateResolver } from '../dist/server/candidate-resolver.js';
import { ConversationService } from '../dist/server/conversation-service.js';
import { openDatabase, SCHEMA_VERSION } from '../dist/server/database.js';
import { DenseIndexEvaluator } from '../dist/server/dense-index-evaluator.js';
import { EpisodicMemoryService } from '../dist/server/episodic-memory-service.js';
import { HybridRetrievalIndex } from '../dist/server/hybrid-retrieval.js';
import {
  HierarchicalSummaryService,
} from '../dist/server/hierarchical-summary-service.js';
import { IdentityService } from '../dist/server/identity.js';
import { LifecycleStore } from '../dist/server/lifecycle-store.js';
import { MemoryConsolidator } from '../dist/server/memory-consolidator.js';
import {
  MemoryReflectionService,
  OllamaReflectionProvider,
} from '../dist/server/memory-reflection.js';
import { MemoryStore } from '../dist/server/memory-store.js';
import { MemoryWorker } from '../dist/server/memory-worker.js';
import {
  buildQaImplementationEvidence,
  createPrivateQaRunRoot,
  createQaRunId,
  immutableQaPath,
  writeImmutableQaFile,
} from './qa-receipt-lib.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(scriptPath));
const privateParent = path.join(
  projectRoot,
  '.memory-bridge-private',
  'conversation-long-timeline',
);
const USER_COUNT = 8;
const MESSAGES_PER_USER = 10_000;
const USER_TURNS_PER_USER = MESSAGES_PER_USER / 2;
const CONVERSATIONS_PER_USER = 4;
const WRITE_CONCURRENCY = 4;
const TIMELINE_DAYS = 180;
const ACTIVE_DAYS = TIMELINE_DAYS + 1;
const REFLECTION_MAX_TURNS = 200;
const REFLECTION_BATCH_LIMIT = Math.ceil(
  USER_TURNS_PER_USER / REFLECTION_MAX_TURNS,
) + 1;
const NAMESPACE = 'qa-long-timeline-v1';
const QWEN_SAMPLE_NAMESPACE = 'qa-long-timeline-qwen-v1';
const REQUIRED_GENERATION_MODEL = 'qwen2.5:14b';
const REQUIRED_EMBEDDING_MODEL = 'bge-m3:latest';
const OLLAMA_URL = 'http://127.0.0.1:11434';
const MODEL_TIMEOUT_MS = 180_000;
const CONVERGENCE_MAX_ITERATIONS = 1_000_000;
const CONVERGENCE_TIMEOUT_MS = 604_800_000;
const CONVERGENCE_NO_PROGRESS_TIMEOUT_MS = 1_200_000;
const CONVERGENCE_PROGRESS_INTERVAL = 1_000;
const FTS_PERFORMANCE_SAMPLES = 200;
const FTS_PERFORMANCE_P95_LIMIT_MS = 150;
const MANIFEST_FORMAT = 'memory-bridge-long-timeline-manifest:v2';
const SCALE_PIPELINE_PROVENANCE = Object.freeze({
  worker: 'production-memory-worker',
  storage: 'real-sqlite-schema37',
  queueAndLeases: 'real-outbox-and-memory-jobs',
  fts: 'real-sqlite-fts5',
  denseStateMachine: 'deterministic-bge-m3-compatible-v1',
  extractionStateMachine: 'deterministic-long-timeline-extractor-v2',
  reflectionStateMachine: 'deterministic-long-timeline-reflection-v2',
  summaryStateMachine: 'deterministic-long-timeline-summary-v2',
  boundedRealModels: ['qwen2.5:14b', 'bge-m3:latest'],
  fullScaleGenerationProviderCalls: 0,
});
const REQUIRED_MCP_TOOLS = [
  'memory_forget',
  'memory_get_context',
  'memory_list',
  'memory_recall',
  'memory_remember',
  'memory_stats',
  'memory_update',
].sort();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return Number(sorted[index].toFixed(3));
}

function latencySummary(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length > 0
      ? Number(Math.max(...values).toFixed(3))
      : null,
  };
}

function scalar(database, sql, ...parameters) {
  const row = database.prepare(sql).get(...parameters) || {};
  return Number(Object.values(row)[0] || 0);
}

function safeFileSize(filePath) {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

function currentImplementationEvidence() {
  return buildQaImplementationEvidence({
    projectRoot,
    schemaVersion: SCHEMA_VERSION,
    relativeFiles: [
      'package-lock.json',
      'package.json',
      'scripts/qa-conversation-long-timeline.mjs',
      'scripts/qa-receipt-lib.mjs',
      'src/server/candidate-resolver.ts',
      'src/server/config.ts',
      'src/server/conversation-service.ts',
      'src/server/database.ts',
      'src/server/dense-index-evaluator.ts',
      'src/server/episodic-memory-service.ts',
      'src/server/hierarchical-summary-service.ts',
      'src/server/identity.ts',
      'src/server/lifecycle-store.ts',
      'src/server/mcp-server.ts',
      'src/server/memory-consolidator.ts',
      'src/server/memory-extractor.ts',
      'src/server/memory-reflection.ts',
      'src/server/memory-store.ts',
      'src/server/memory-worker.ts',
      'src/server/semantic-ranker.ts',
    ],
    runtimeDirectories: ['dist/server'],
  });
}

function parseRunnerConfig(argv) {
  if (argv.length === 0) return { resumeRoot: null };
  if (argv.length === 2 && argv[0] === '--resume') {
    if (!path.isAbsolute(argv[1])) {
      throw new Error('--resume 必须使用绝对 run root 路径');
    }
    return { resumeRoot: path.resolve(argv[1]) };
  }
  throw new Error(
    '用法: node scripts/qa-conversation-long-timeline.mjs ' +
    '[--resume /absolute/private/run-root]',
  );
}

function ordinaryPath(target, kind, label) {
  const stat = fs.lstatSync(target);
  const valid = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  if (!valid || stat.isSymbolicLink()) {
    throw new Error(`${label} 必须是非符号链接普通${
      kind === 'directory' ? '目录' : '文件'
    }`);
  }
}

function readJsonFile(filePath, label) {
  ordinaryPath(filePath, 'file', label);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON`, { cause: error });
  }
}

function validateResumeManifest(resumeRoot, implementation) {
  ordinaryPath(privateParent, 'directory', 'QA 私有父目录');
  ordinaryPath(resumeRoot, 'directory', 'resume run root');
  const parent = path.resolve(privateParent);
  const root = path.resolve(resumeRoot);
  const realParent = fs.realpathSync(parent);
  const realRoot = fs.realpathSync(root);
  if (
    realRoot !== root ||
    !realRoot.startsWith(`${realParent}${path.sep}`) ||
    !path.basename(root).startsWith('run-')
  ) {
    throw new Error('resume run root 必须严格位于长期会话 QA 私有目录内');
  }
  const dataDir = path.join(root, 'data');
  const receiptsDir = path.join(root, 'receipts');
  const workerDir = path.join(root, 'workers');
  ordinaryPath(dataDir, 'directory', 'resume data directory');
  ordinaryPath(receiptsDir, 'directory', 'resume receipts directory');
  ordinaryPath(workerDir, 'directory', 'resume workers directory');
  const manifestPath = path.join(receiptsDir, 'run-manifest.json');
  const manifest = readJsonFile(manifestPath, 'resume manifest');
  const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
  ordinaryPath(databasePath, 'file', 'resume database');
  const required = {
    format: MANIFEST_FORMAT,
    userCount: USER_COUNT,
    messagesPerUser: MESSAGES_PER_USER,
    totalMessages: USER_COUNT * MESSAGES_PER_USER,
    timelineDays: TIMELINE_DAYS,
    namespace: NAMESPACE,
    requiredGenerationModel: REQUIRED_GENERATION_MODEL,
    requiredEmbeddingModel: REQUIRED_EMBEDDING_MODEL,
    schemaVersion: SCHEMA_VERSION,
    productionPortUsed: false,
    productionDatabaseUsed: false,
  };
  for (const [field, expected] of Object.entries(required)) {
    if (manifest[field] !== expected) {
      throw new Error(
        `resume manifest ${field} 不匹配: ` +
        `${JSON.stringify(manifest[field])} != ${JSON.stringify(expected)}`,
      );
    }
  }
  if (
    typeof manifest.runId !== 'string' || !manifest.runId ||
    path.resolve(String(manifest.databasePath)) !== databasePath ||
    manifest.runRoot !== root
  ) {
    throw new Error('resume manifest runId/runRoot/databasePath 不一致');
  }
  if (
    manifest.implementation?.fingerprintSha256 !==
      implementation.fingerprintSha256 ||
    JSON.stringify(manifest.implementation) !== JSON.stringify(implementation)
  ) {
    throw new Error('resume implementation fingerprint 不匹配');
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schemaVersion = Number(
      database.prepare('PRAGMA user_version').get()?.user_version || 0,
    );
    const messageCount = scalar(
      database,
      'SELECT COUNT(*) FROM conversation_turns WHERE namespace = ?',
      NAMESPACE,
    );
    const expectedPrincipalIds = Array.from(
      { length: USER_COUNT },
      (_, index) => userLabel(index),
    );
    const expectedPrincipalCounts = expectedPrincipalIds.map((principalId) => ({
      principalId,
      messages: MESSAGES_PER_USER,
    }));
    const principalCounts = database.prepare(
      `SELECT user_id, COUNT(*) AS count
       FROM conversation_turns
       WHERE namespace = ?
       GROUP BY user_id
       ORDER BY user_id`,
    ).all(NAMESPACE).map((row) => ({
      principalId: String(row.user_id),
      messages: Number(row.count),
    }));
    const expectedRoleCounts = expectedPrincipalIds.flatMap((principalId) => [
      { principalId, role: 'assistant', messages: USER_TURNS_PER_USER },
      { principalId, role: 'user', messages: USER_TURNS_PER_USER },
    ]);
    const roleCounts = database.prepare(
      `SELECT user_id, role, COUNT(*) AS count
       FROM conversation_turns
       WHERE namespace = ?
       GROUP BY user_id, role
       ORDER BY user_id, role`,
    ).all(NAMESPACE).map((row) => ({
      principalId: String(row.user_id),
      role: String(row.role),
      messages: Number(row.count),
    }));
    const expectedSessionCounts = expectedPrincipalIds.map((principalId) => ({
      principalId,
      sessions: CONVERSATIONS_PER_USER,
    }));
    const sessionCounts = database.prepare(
      `SELECT user_id, COUNT(*) AS count
       FROM conversation_sessions
       WHERE namespace = ?
       GROUP BY user_id
       ORDER BY user_id`,
    ).all(NAMESPACE).map((row) => ({
      principalId: String(row.user_id),
      sessions: Number(row.count),
    }));
    if (schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`resume database schema ${schemaVersion} 不受支持`);
    }
    if (messageCount !== USER_COUNT * MESSAGES_PER_USER) {
      throw new Error(
        `resume database 只接受完整 80K 写入，实际 ${messageCount}`,
      );
    }
    if (
      JSON.stringify(principalCounts) !==
        JSON.stringify(expectedPrincipalCounts) ||
      JSON.stringify(roleCounts) !== JSON.stringify(expectedRoleCounts) ||
      JSON.stringify(sessionCounts) !== JSON.stringify(expectedSessionCounts)
    ) {
      throw new Error(
        'resume database principal/role/session 分布不满足完整 80K 合同',
      );
    }
  } finally {
    database.close();
  }
  const writerSummaryPath = path.join(receiptsDir, 'writer-summary.json');
  const writerSummary = readJsonFile(writerSummaryPath, 'resume writer summary');
  const expectedWriterPrincipalIds = Array.from(
    { length: USER_COUNT },
    (_, index) => userLabel(index),
  );
  const writerPrincipalIds = Array.isArray(writerSummary.workers)
    ? writerSummary.workers.map((item) => String(item?.principalId)).sort()
    : [];
  if (
    writerSummary.format !== 'memory-bridge-long-timeline-writers:v1' ||
    writerSummary.runId !== manifest.runId ||
    writerSummary.totalMessages !== USER_COUNT * MESSAGES_PER_USER ||
    writerSummary.observedMaxConcurrency !== WRITE_CONCURRENCY ||
    !Array.isArray(writerSummary.workers) ||
    writerSummary.workers.length !== USER_COUNT ||
    JSON.stringify(writerPrincipalIds) !==
      JSON.stringify(expectedWriterPrincipalIds) ||
    !writerSummary.workers.every((item) =>
      item?.counters?.messagesWritten === MESSAGES_PER_USER &&
      item.counters.userMessagesWritten === USER_TURNS_PER_USER &&
      item.counters.assistantMessagesWritten === USER_TURNS_PER_USER)
  ) {
    throw new Error('resume writer summary 不满足完整并发 80K 合同');
  }
  const completedReport = path.join(
    receiptsDir,
    `conversation-long-timeline.${manifest.runId}.json`,
  );
  if (fs.existsSync(completedReport)) {
    throw new Error('resume run 已有最终回执，拒绝重复执行');
  }
  return {
    manifest,
    runId: manifest.runId,
    runRoot: root,
    dataDir,
    receiptsDir,
    workerDir,
    databasePath,
    writerSummary,
  };
}

function groupedCounts(database, sql, ...parameters) {
  return database.prepare(sql).all(...parameters).map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'number' ? Number(value) : String(value ?? ''),
    ])));
}

function diagnosticRows(database, sql, ...parameters) {
  return database.prepare(sql).all(...parameters).map((row) => ({
    id: String(row.id),
    type: String(row.type),
    status: String(row.status),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: String(row.available_at),
    leaseUntil: row.lease_until === null ? null : String(row.lease_until),
    lastErrorFingerprint: row.last_error
      ? sha256(String(row.last_error))
      : null,
  }));
}

function convergenceSnapshot(database, at = new Date().toISOString()) {
  const outboxByStatus = groupedCounts(
    database,
    `SELECT status, COUNT(*) AS count FROM outbox_events
     GROUP BY status ORDER BY status`,
  );
  const jobsByTypeAndStatus = groupedCounts(
    database,
    `SELECT job_type AS type, status, COUNT(*) AS count
     FROM memory_jobs
     GROUP BY job_type, status ORDER BY job_type, status`,
  );
  const nonFutureOpenOutbox = scalar(
    database,
    `SELECT COUNT(*) FROM outbox_events
     WHERE status IN ('pending', 'processing', 'failed')
       AND (
         (status IN ('pending', 'failed') AND available_at <= ?)
         OR (status = 'processing' AND (lease_until IS NULL OR lease_until <= ?))
       )`,
    at,
    at,
  );
  const totalOpenOutbox = scalar(
    database,
    `SELECT COUNT(*) FROM outbox_events
     WHERE status IN ('pending', 'processing', 'failed')`,
  );
  const blockingOpenOutbox = scalar(
    database,
    `SELECT COUNT(*) FROM outbox_events
     WHERE status IN ('processing', 'failed')
        OR (status = 'pending' AND available_at <= ?)`,
    at,
  );
  const retryingOutbox = scalar(
    database,
    `SELECT COUNT(*) FROM outbox_events
     WHERE status IN ('processing', 'failed')`,
  );
  const nonFutureOpenJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status IN ('pending', 'running', 'failed')
       AND (
         (status IN ('pending', 'failed') AND available_at <= ?)
         OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
       )`,
    at,
    at,
  );
  const totalOpenJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status IN ('pending', 'running', 'failed')`,
  );
  const blockingOpenJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status IN ('pending', 'running', 'failed')
       AND NOT (
         status = 'pending' AND available_at > ?
         AND job_type IN (
           'consolidation_sweep', 'reflection_sweep', 'retention_sweep'
         )
       )`,
    at,
  );
  const retryingJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status IN ('running', 'failed')`,
  );
  const deadJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status = 'dead'`,
  );
  const deadLetterJobs = scalar(
    database,
    'SELECT COUNT(*) FROM dead_letter_jobs',
  );
  const nextLeaseOrRetryAt = String(
    database.prepare(
      `SELECT MIN(next_at) AS next_at FROM (
         SELECT CASE WHEN status = 'processing' THEN lease_until ELSE available_at END
                AS next_at
         FROM outbox_events
         WHERE status IN ('pending', 'processing', 'failed')
         UNION ALL
         SELECT CASE WHEN status = 'running' THEN lease_until ELSE available_at END
                AS next_at
         FROM memory_jobs
         WHERE status IN ('pending', 'running', 'failed')
       ) WHERE next_at IS NOT NULL`,
    ).get()?.next_at || '',
  ) || null;
  const completedOutbox = scalar(
    database,
    `SELECT COUNT(*) FROM outbox_events
     WHERE status = 'completed'`,
  );
  const completedJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status = 'completed'`,
  );
  const totalOutboxAttempts = scalar(
    database,
    `SELECT COALESCE(SUM(attempts), 0) FROM outbox_events
    `,
  );
  const totalJobAttempts = scalar(
    database,
    `SELECT COALESCE(SUM(attempts), 0) FROM memory_jobs
    `,
  );
  const episodeCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes
     WHERE namespace = ? AND status = 'active'`,
    NAMESPACE,
  );
  const summaryCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_memory_summaries
     WHERE namespace = ? AND status = 'active'`,
    NAMESPACE,
  );
  const observationCount = scalar(
    database,
    `SELECT COUNT(*) FROM memory_pattern_observations
     WHERE namespace = ?`,
    NAMESPACE,
  );
  const openSummaryJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE namespace = ? AND job_type = 'summarize_memory_bucket'
       AND status IN ('pending', 'running', 'failed')`,
    NAMESPACE,
  );
  const diagnosticSamples = {
    outbox: diagnosticRows(
      database,
      `SELECT id, aggregate_type AS type, status, attempts, max_attempts,
              available_at, lease_until, last_error
       FROM outbox_events
       WHERE status IN ('pending', 'processing', 'failed')
       ORDER BY available_at, id LIMIT 12`,
    ),
    jobs: diagnosticRows(
      database,
      `SELECT id, job_type AS type, status, attempts, max_attempts,
              available_at, lease_until, last_error
       FROM memory_jobs
       WHERE status IN ('pending', 'running', 'failed', 'dead')
       ORDER BY available_at, id LIMIT 12`,
    ),
  };
  const progressFingerprint = sha256(JSON.stringify({
    completedOutbox,
    completedJobs,
    totalOutboxAttempts,
    totalJobAttempts,
    totalOpenOutbox,
    totalOpenJobs,
    blockingOpenOutbox,
    blockingOpenJobs,
    retryingOutbox,
    retryingJobs,
    deadJobs,
    deadLetterJobs,
    episodeCount,
    summaryCount,
    observationCount,
    openSummaryJobs,
    outboxByStatus,
    jobsByTypeAndStatus,
  }));
  return {
    at,
    nonFutureOpenOutbox,
    nonFutureOpenJobs,
    completedOutbox,
    completedJobs,
    totalOutboxAttempts,
    totalJobAttempts,
    totalOpenOutbox,
    totalOpenJobs,
    blockingOpenOutbox,
    blockingOpenJobs,
    retryingOutbox,
    retryingJobs,
    deadJobs,
    deadLetterJobs,
    episodeCount,
    summaryCount,
    observationCount,
    openSummaryJobs,
    outboxByStatus,
    jobsByTypeAndStatus,
    diagnosticSamples,
    nextLeaseOrRetryAt,
    progressFingerprint,
  };
}

function convergenceFailure(reason, snapshot, counters, startedAt) {
  const error = new Error(
    `long timeline convergence ${reason}: ` +
    `${JSON.stringify({
      elapsedMs: Math.round(performance.now() - startedAt),
      counters,
      ...snapshot,
    })}`,
  );
  error.convergence = { reason, counters, snapshot };
  return error;
}

function deterministicEmbedding(text, dimensions = 64) {
  const values = new Float32Array(dimensions);
  const normalized = String(text).normalize('NFKC');
  for (let offset = 0; offset < normalized.length; offset += 1) {
    const codePoint = normalized.codePointAt(offset) || 0;
    const digest = createHash('sha256')
      .update(`${offset}:${codePoint}:${normalized.slice(offset, offset + 3)}`)
      .digest();
    values[digest[0] % dimensions] += digest[1] % 2 === 0 ? 1 : -1;
  }
  let norm = Math.sqrt(
    [...values].reduce((sum, value) => sum + value * value, 0),
  );
  if (norm === 0) {
    values[0] = 1;
    norm = 1;
  }
  return Float32Array.from(values, (value) => value / norm);
}

function deterministicScaleRanker() {
  return {
    embeddingModel: REQUIRED_EMBEDDING_MODEL,
    rerankModel: REQUIRED_GENERATION_MODEL,
    async embed(texts) {
      return texts.map((text) => deterministicEmbedding(text));
    },
    async rerank(query, candidates) {
      const normalizedQuery = String(query).normalize('NFKC');
      return candidates.map((candidate) => {
        const relevant = normalizedQuery.includes('QA') &&
          candidate.memory.includes('QA');
        return {
          id: candidate.id,
          relevant,
          confidence: relevant ? 1 : 0,
          reason: 'qa_long_timeline_deterministic_scale_rerank',
        };
      });
    },
  };
}

function scalePipeline(database) {
  const lifecycle = new LifecycleStore(database);
  const ranker = deterministicScaleRanker();
  const store = new MemoryStore(database, ranker);
  const extractor = deterministicExtractor();
  const reflectionProvider = deterministicReflectionProvider();
  const consolidationProvider = deterministicConsolidationProvider();
  const resolver = new CandidateResolver(database, lifecycle, store, {
    mode: 'shadow',
    embeddingProvider: ranker,
  });
  const consolidator = new MemoryConsolidator(
    database,
    lifecycle,
    store,
    consolidationProvider,
  );
  const reflection = new MemoryReflectionService(
    database,
    lifecycle,
    extractor,
    reflectionProvider,
    {
      mode: 'shadow',
      maxTurns: REFLECTION_MAX_TURNS,
      tokenBudget: 32_000,
      lookbackDays: 365,
      minNewTurns: 1,
      minPatternEvidence: 3,
      maxDailyCalls: 100_000,
    },
  );
  const worker = new MemoryWorker(
    lifecycle,
    extractor,
    resolver,
    consolidator,
    undefined,
    true,
    store,
    new DenseIndexEvaluator(store),
    reflection,
    new EpisodicMemoryService(database),
    new HierarchicalSummaryService(
      database,
      store,
      consolidationProvider,
    ),
  );
  return { lifecycle, store, worker };
}

function endTimelineSessions(database) {
  const lifecycle = new LifecycleStore(database);
  const sessions = database.prepare(
    `SELECT user_id, client_name, external_id
     FROM conversation_sessions
     WHERE namespace = ? AND ended_at IS NULL
     ORDER BY user_id, external_id`,
  ).all(NAMESPACE);
  for (const session of sessions) {
    lifecycle.endSession(
      String(session.user_id),
      String(session.client_name),
      String(session.external_id),
    );
  }
  return sessions.length;
}

async function drainToConvergence(database, options = {}) {
  const maximumIterations = options.maximumIterations ||
    CONVERGENCE_MAX_ITERATIONS;
  const timeoutMs = options.timeoutMs || CONVERGENCE_TIMEOUT_MS;
  const noProgressTimeoutMs = options.noProgressTimeoutMs ||
    CONVERGENCE_NO_PROGRESS_TIMEOUT_MS;
  const { store, worker } = scalePipeline(database);
  await store.prepareDenseIndexScopes();
  const startedAt = performance.now();
  let lastProgressAt = startedAt;
  let snapshot = convergenceSnapshot(database);
  let previousFingerprint = snapshot.progressFingerprint;
  const counters = {
    iterations: 0,
    processedCalls: 0,
    idlePolls: 0,
    candidates: 0,
    retryableErrors: 0,
    errorFingerprints: {},
    jobsByType: {},
  };

  while (
    snapshot.blockingOpenOutbox > 0 ||
    snapshot.blockingOpenJobs > 0
  ) {
    const now = performance.now();
    if (counters.iterations >= maximumIterations) {
      throw convergenceFailure(
        'maximum_iterations_exceeded',
        snapshot,
        counters,
        startedAt,
      );
    }
    if (now - startedAt > timeoutMs) {
      throw convergenceFailure(
        'wall_clock_timeout',
        snapshot,
        counters,
        startedAt,
      );
    }
    if (now - lastProgressAt > noProgressTimeoutMs) {
      throw convergenceFailure(
        'no_progress_timeout',
        snapshot,
        counters,
        startedAt,
      );
    }

    const result = await worker.processNext(
      `qa-long-timeline-convergence-${counters.iterations % 4}`,
      { backgroundModelAllowed: true },
    );
    counters.iterations += 1;
    counters.candidates += result.candidateCount;
    if (result.error) {
      const errorFingerprint = sha256(result.error);
      counters.retryableErrors += 1;
      counters.errorFingerprints[errorFingerprint] =
        (counters.errorFingerprints[errorFingerprint] || 0) + 1;
      snapshot = convergenceSnapshot(database);
      if (snapshot.deadJobs > 0 || snapshot.deadLetterJobs > 0) {
        throw convergenceFailure(
          `worker_error_became_dead:${errorFingerprint}`,
          snapshot,
          counters,
          startedAt,
        );
      }
    }
    if (result.processed || result.job) {
      counters.processedCalls += 1;
      if (result.job) {
        counters.jobsByType[result.job.jobType] =
          (counters.jobsByType[result.job.jobType] || 0) + 1;
      }
    } else {
      counters.idlePolls += 1;
    }

    snapshot = convergenceSnapshot(database);
    if (snapshot.progressFingerprint !== previousFingerprint) {
      previousFingerprint = snapshot.progressFingerprint;
      lastProgressAt = performance.now();
    }
    if (
      counters.iterations % CONVERGENCE_PROGRESS_INTERVAL === 0 ||
      (!result.processed && !result.job)
    ) {
      console.log(JSON.stringify({
        type: 'long-timeline-convergence-progress',
        elapsedMs: Math.round(performance.now() - startedAt),
        counters,
        remaining: {
          outbox: snapshot.nonFutureOpenOutbox,
          jobs: snapshot.nonFutureOpenJobs,
          blockingOutbox: snapshot.blockingOpenOutbox,
          blockingJobs: snapshot.blockingOpenJobs,
        },
        progressFingerprint: snapshot.progressFingerprint,
        nextLeaseOrRetryAt: snapshot.nextLeaseOrRetryAt,
      }));
    }
    if (!result.processed && !result.job) {
      const nextAt = Date.parse(snapshot.nextLeaseOrRetryAt || '');
      const waitMs = Number.isFinite(nextAt)
        ? Math.max(100, Math.min(1_000, nextAt - Date.now()))
        : 250;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return {
    durationMs: Number((performance.now() - startedAt).toFixed(3)),
    counters,
    snapshot,
  };
}

function userLabel(index) {
  return `timeline-user-${String(index + 1).padStart(2, '0')}`;
}

function personaId(userIndex, personaIndex) {
  return `${userLabel(userIndex)}-persona-${personaIndex + 1}`;
}

function projectId(userIndex) {
  return `${userLabel(userIndex)}-project`;
}

function stableFlavorMarker(userIndex) {
  return `QAFLAVOR${String(userIndex + 1).padStart(2, '0')}X7`;
}

function mcpMarker(userIndex) {
  return `QAMCP${String(userIndex + 1).padStart(2, '0')}Z9`;
}

function timelineTimestamp(userTurnIndex, assistant = false) {
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const dayIndex = Math.min(
    TIMELINE_DAYS,
    Math.floor(userTurnIndex * ACTIVE_DAYS / USER_TURNS_PER_USER),
  );
  const firstTurnOfDay = Math.ceil(
    dayIndex * USER_TURNS_PER_USER / ACTIVE_DAYS,
  );
  const firstTurnOfNextDay = Math.ceil(
    (dayIndex + 1) * USER_TURNS_PER_USER / ACTIVE_DAYS,
  );
  const turnsOnDay = firstTurnOfNextDay - firstTurnOfDay;
  const positionOnDay = userTurnIndex - firstTurnOfDay;
  const awakeStartMs = 7.5 * 60 * 60 * 1_000;
  const awakeWindowMs = 15 * 60 * 60 * 1_000;
  const positionFraction = turnsOnDay <= 1
    ? 0.5
    : positionOnDay / (turnsOnDay - 1);
  const offset = dayIndex * 86_400_000 + awakeStartMs +
    Math.round(positionFraction * awakeWindowMs);
  return new Date(start + offset + (assistant ? 30_000 : 0)).toISOString();
}

function timelineUserContent(userIndex, userTurnIndex) {
  const day = Math.floor(
    userTurnIndex * TIMELINE_DAYS / USER_TURNS_PER_USER,
  ) + 1;
  const marker = stableFlavorMarker(userIndex);
  if (userTurnIndex % 60 === 0) {
    return `时间轴第 ${day} 天：我今天点餐仍选择清淡少辣，稳定口味标记 ${marker}。`;
  }
  if (userTurnIndex === 510) {
    return `时间轴第 ${day} 天：修正一下，以前记录的晚间咖啡已过期，我现在晚上只喝温水。`;
  }
  if (userTurnIndex === 920) {
    return `时间轴第 ${day} 天：请忘记我之前提到的临时出差酒店，它不再有用。`;
  }
  if (userTurnIndex % 71 === 0) {
    return `时间轴第 ${day} 天：项目评审决定第 ${userTurnIndex} 轮先做离线能力，再做云端同步。`;
  }
  const variants = [
    `时间轴第 ${day} 天：今天通勤后完成了二十分钟拉伸，晚上准备读两章书。`,
    `时间轴第 ${day} 天：午餐在公司附近解决，下午继续处理普通工作事项。`,
    `时间轴第 ${day} 天：今天没有新的长期决定，只是记录一次日常对话。`,
    `时间轴第 ${day} 天：我看了一段技术视频，内容与当前项目没有直接关系。`,
    `时间轴第 ${day} 天：周末计划可能会变，这条只是临时想法，不要当成稳定偏好。`,
    `时间轴第 ${day} 天：今天讨论了书、健身和饮食，但没有需要长期保存的新结论。`,
  ];
  return variants[(userTurnIndex + userIndex) % variants.length];
}

function timelineAssistantContent(userIndex, userTurnIndex) {
  const variants = [
    '明白，我会把这条内容仅作为当前对话的一部分处理。',
    '收到；若它只是临时安排，我不会把它误写成稳定事实。',
    '好的，我会保留时间语境，并区分日常噪音和长期偏好。',
    '了解。涉及修正或遗忘时，应以较新的明确表达为准。',
  ];
  return `${variants[(userTurnIndex + userIndex) % variants.length]} 轮次 ${userTurnIndex + 1}。`;
}

function isBusyError(error) {
  return /SQLITE_BUSY|database is locked|database is busy/iu.test(
    error instanceof Error ? error.message : String(error),
  );
}

async function retryBusy(operation, counters) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error) || attempt === 19) throw error;
      counters.busyRetries += 1;
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(250, 5 * 2 ** attempt));
      });
    }
  }
  throw new Error('SQLite busy retry exhausted');
}

async function runWorker(specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const database = openDatabase(spec.databasePath);
  let currentTime = timelineTimestamp(0);
  const service = new ConversationService(database, {
    now: () => currentTime,
    instanceId: `timeline-writer-${spec.userIndex}`,
  });
  const counters = {
    busyRetries: 0,
    messagesWritten: 0,
    userMessagesWritten: 0,
    assistantMessagesWritten: 0,
  };
  const latencies = [];
  const started = performance.now();
  try {
    for (let userTurnIndex = 0;
      userTurnIndex < USER_TURNS_PER_USER;
      userTurnIndex += 1) {
      const conversation = spec.conversations[
        userTurnIndex % spec.conversations.length
      ];
      currentTime = timelineTimestamp(userTurnIndex);
      const userStarted = performance.now();
      await retryBusy(
        () => service.appendMessage(
          { principalId: spec.principalId, namespace: spec.namespace },
          conversation.id,
          {
            clientMessageId: `${spec.principalId}-u-${userTurnIndex + 1}`,
            role: 'user',
            content: timelineUserContent(spec.userIndex, userTurnIndex),
          },
        ),
        counters,
      );
      latencies.push(performance.now() - userStarted);
      counters.messagesWritten += 1;
      counters.userMessagesWritten += 1;

      currentTime = timelineTimestamp(userTurnIndex, true);
      const assistantStarted = performance.now();
      await retryBusy(
        () => service.appendMessage(
          { principalId: spec.principalId, namespace: spec.namespace },
          conversation.id,
          {
            clientMessageId: `${spec.principalId}-a-${userTurnIndex + 1}`,
            role: 'assistant',
            content: timelineAssistantContent(
              spec.userIndex,
              userTurnIndex,
            ),
          },
        ),
        counters,
      );
      latencies.push(performance.now() - assistantStarted);
      counters.messagesWritten += 1;
      counters.assistantMessagesWritten += 1;
    }
    const result = {
      format: 'memory-bridge-long-timeline-writer:v1',
      principalId: spec.principalId,
      userIndex: spec.userIndex,
      counters,
      latency: latencySummary(latencies),
      durationMs: Number((performance.now() - started).toFixed(3)),
    };
    writeImmutableQaFile(
      spec.resultPath,
      `${JSON.stringify(result, null, 2)}\n`,
    );
  } finally {
    database.close();
  }
}

function spawnWriter(specPath, concurrencyState) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--worker', specPath], {
      cwd: projectRoot,
      env: { PATH: process.env.PATH || '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let countedActive = false;
    const releaseActive = () => {
      if (!countedActive) return;
      countedActive = false;
      concurrencyState.active -= 1;
    };
    child.once('spawn', () => {
      countedActive = true;
      concurrencyState.active += 1;
      concurrencyState.maximum = Math.max(
        concurrencyState.maximum,
        concurrencyState.active,
      );
    });
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-4_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });
    child.once('error', (error) => {
      releaseActive();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      releaseActive();
      if (code !== 0) {
        reject(new Error(
          `timeline writer failed code=${code} signal=${signal || ''} ` +
          `stdout=${stdout} stderr=${stderr}`,
        ));
        return;
      }
      resolve();
    });
  });
}

function deterministicExtractor() {
  return {
    model: 'qwen2.5:14b',
    promptVersion: 'qa-long-timeline-extractor-v1',
    extractorId: 'qa-long-timeline-extractor',
    extractorVersion: 'v1',
    async extract(turn) {
      const marker = /QAFLAVOR\d{2}X7/u.exec(turn.content)?.[0];
      if (!marker) return [];
      return [{
        kind: 'preference',
        subject: '用户',
        predicate: '稳定口味标记',
        value: marker,
        content: '',
        confidence: 0.95,
        importance: 0.75,
        sensitivity: 'normal',
        scopeType: 'personal',
        scopeKey: 'self',
        sourceExcerpt: turn.content,
        sourceAuthority: 'direct_user',
      }];
    },
  };
}

function deterministicReflectionProvider() {
  return {
    model: 'qwen2.5:14b',
    promptVersion: 'qa-long-timeline-reflection-v1',
    async reflect(input) {
      const matches = input.turns.flatMap((turn) => {
        const marker = /QAFLAVOR\d{2}X7/u.exec(turn.content)?.[0];
        return marker ? [{ turn, marker }] : [];
      });
      const groups = new Map();
      for (const match of matches) {
        const items = groups.get(match.marker) || [];
        items.push(match.turn);
        groups.set(match.marker, items);
      }
      const candidates = [];
      for (const [marker, turns] of groups) {
        if (turns.length < 3) continue;
        candidates.push({
          kind: 'preference',
          subject: '用户',
          predicate: '跨时间稳定口味',
          value: marker,
          confidence: 0.9,
          importance: 0.8,
          sensitivity: 'normal',
          negated: false,
          observationType: 'stable_pattern',
          evidence: turns.slice(0, 3).map((turn) => ({
            turnAlias: turn.turnAlias,
            excerpt: turn.content,
          })),
        });
      }
      return { candidates };
    },
  };
}

function validationReflectionProvider() {
  return {
    model: 'qa-deterministic-reflection-v1',
    promptVersion: 'qa-long-timeline-reflection-v2',
    async reflect(input) {
      const marker = /QAFLAVOR\d{2}X7/u.exec(
        input.turns.map((turn) => turn.content).join('\n'),
      )?.[0];
      if (!marker) return { candidates: [] };
      const evidence = input.turns
        .filter((turn) => turn.content.includes(marker))
        .slice(0, 3)
        .map((turn) => ({
          turnAlias: turn.turnAlias,
          excerpt: turn.content,
        }));
      return evidence.length < 3
        ? { candidates: [] }
        : {
          candidates: [{
            kind: 'preference',
            subject: '用户',
            predicate: '跨时间稳定口味验证',
            value: marker,
            confidence: 0.9,
            importance: 0.8,
            sensitivity: 'normal',
            negated: false,
            observationType: 'stable_pattern',
            evidence,
          }],
        };
    },
  };
}

async function runReflectionValidationSample(database, principals) {
  const lifecycle = new LifecycleStore(database);
  const service = new MemoryReflectionService(
    database,
    lifecycle,
    deterministicExtractor(),
    validationReflectionProvider(),
    {
      mode: 'shadow',
      maxTurns: REFLECTION_MAX_TURNS,
      tokenBudget: 32_000,
      lookbackDays: 365,
      minNewTurns: 1,
      minPatternEvidence: 3,
      maxDailyCalls: 100_000,
      clock: () => new Date('2026-07-01T00:00:00.000Z'),
    },
  );
  const executions = [];
  for (const principalId of principals) {
    const queued = service.queueRun({
      userId: principalId,
      namespace: NAMESPACE,
      scopeType: 'personal',
      scopeKey: 'self',
      runType: 'reflect',
      trigger: 'manual',
      requestedBy: 'qa-long-timeline-validation',
    });
    const executed = await service.executeRun(
      queued.run.id,
      `qa-validation-${principalId}`,
    );
    executions.push({
      principalId,
      runId: executed.run.id,
      inputTurnCount: executed.run.inputTurnCount,
      candidateCount: executed.run.candidateCount,
      candidates: executed.candidates.map((candidate) => ({
        id: candidate.id,
        state: candidate.state,
        evidenceTurns: scalar(
          database,
          `SELECT COUNT(DISTINCT turn_id)
           FROM memory_candidate_evidence WHERE candidate_id = ?`,
          candidate.id,
        ),
      })),
    });
  }
  return executions;
}

async function runReflectionCoverage(database, principals) {
  const lifecycle = new LifecycleStore(database);
  const service = new MemoryReflectionService(
    database,
    lifecycle,
    deterministicExtractor(),
    deterministicReflectionProvider(),
    {
      mode: 'shadow',
      maxTurns: REFLECTION_MAX_TURNS,
      tokenBudget: 32_000,
      lookbackDays: 365,
      minNewTurns: 1,
      minPatternEvidence: 3,
      maxDailyCalls: 100_000,
      clock: () => new Date('2026-07-01T00:00:00.000Z'),
    },
  );
  const executions = [];
  for (const principalId of principals) {
    for (const runType of ['reextract', 'reflect']) {
      for (let batch = 0; batch < REFLECTION_BATCH_LIMIT; batch += 1) {
        const preview = await service.preview({
          userId: principalId,
          namespace: NAMESPACE,
          scopeType: 'personal',
          scopeKey: 'self',
        });
        if (preview.pipelines[runType].turnCount === 0) break;
        const queued = service.queueRun({
          userId: principalId,
          namespace: NAMESPACE,
          scopeType: 'personal',
          scopeKey: 'self',
          runType,
          trigger: 'manual',
          requestedBy: 'qa-long-timeline',
        });
        const started = performance.now();
        const executed = await service.executeRun(
          queued.run.id,
          `qa-reflection-${principalId}-${runType}`,
        );
        executions.push({
          principalId,
          runType,
          inputTurnCount: executed.run.inputTurnCount,
          candidateCount: executed.run.candidateCount,
          status: executed.run.status,
          durationMs: Number((performance.now() - started).toFixed(3)),
        });
      }
    }
  }
  const remaining = [];
  for (const principalId of principals) {
    const preview = await service.preview({
      userId: principalId,
      namespace: NAMESPACE,
      scopeType: 'personal',
      scopeKey: 'self',
    });
    remaining.push({
      principalId,
      reextract: preview.pipelines.reextract.turnCount,
      reflect: preview.pipelines.reflect.turnCount,
    });
  }
  return { executions, remaining };
}

function createMcpConnection(input) {
  const client = new Client({
    name: `memory-bridge-long-timeline-${input.label}`,
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, 'dist/server/mcp-stdio.js')],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH || '',
      MEMORY_BRIDGE_DATA_DIR: input.dataDir,
      MEMORY_BRIDGE_MCP_TOKEN: input.token,
      MEMORY_BRIDGE_NAMESPACE: NAMESPACE,
      MEMORY_BRIDGE_SEMANTIC_MODE: 'off',
      MEMORY_BRIDGE_QUERY_REWRITE_MODE: 'off',
      MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE: 'off',
      MEMORY_BRIDGE_RETRIEVAL_LOG_MODE: 'metadata',
      MEMORY_BRIDGE_RETRIEVAL_JSONL: 'off',
    },
    stderr: 'pipe',
  });
  const state = {
    ...input,
    client,
    transport,
    stderrTail: '',
    tokenLeakedToStderr: false,
  };
  transport.stderr?.on('data', (chunk) => {
    const text = `${state.stderrTail}${String(chunk)}`;
    state.tokenLeakedToStderr ||= text.includes(input.token);
    state.stderrTail = text.slice(-1_000);
  });
  return state;
}

async function callMcp(connection, name, args, latencies) {
  const started = performance.now();
  const result = await connection.client.callTool({
    name,
    arguments: args,
  });
  const durationMs = performance.now() - started;
  latencies.push({
    principalId: connection.principalId,
    tool: name,
    durationMs,
  });
  const item = result.content.find((content) => content.type === 'text');
  assert.ok(item && item.type === 'text', `${name} 缺少文本结果`);
  if (result.isError) {
    throw new Error(`${name} failed: ${item.text}`);
  }
  return JSON.parse(item.text);
}

function recallContains(result, memoryId) {
  return Array.isArray(result) && result.some(
    (item) => item?.memory?.id === memoryId,
  );
}

async function runMcpChecks(credentials, dataDir, operationId = 'fresh') {
  const connections = credentials.map((credential, index) =>
    createMcpConnection({
      label: userLabel(index),
      principalId: credential.principalId,
      token: credential.token,
      dataDir,
    }));
  const latencies = [];
  const checks = [];
  const record = (name, passed, details = {}) => {
    checks.push({ name, passed: Boolean(passed), ...details });
  };
  const remembered = [];
  try {
    await Promise.all(connections.map((connection) =>
      connection.client.connect(connection.transport)));
    const toolLists = await Promise.all(connections.map((connection) =>
      connection.client.listTools()));
    toolLists.forEach((result, index) => {
      const names = result.tools.map((tool) => tool.name).sort();
      record(
        `${connections[index].label}.tool-contract`,
        JSON.stringify(names) === JSON.stringify(REQUIRED_MCP_TOOLS),
        { tools: names },
      );
    });

    const writes = await Promise.all(connections.map((connection, index) =>
      callMcp(connection, 'memory_remember', {
        namespace: NAMESPACE,
        kind: 'preference',
        title: `长期时间轴偏好 ${index + 1}`,
        content: `该账户的长期时间轴验证标记是 ${mcpMarker(index)}。`,
        tags: ['qa-long-timeline'],
        importance: 0.8,
        confidence: 1,
        source: 'qa-long-timeline',
        idempotencyKey:
          `qa-long-timeline-${operationId}-${index}-remember`,
      }, latencies)));
    writes.forEach((result, index) => {
      assert.equal(result.memory.userId, connections[index].principalId);
      remembered.push(result.memory);
    });
    record('mcp-concurrent-writes', remembered.length === USER_COUNT, {
      expected: USER_COUNT,
      actual: remembered.length,
    });

    const replay = await callMcp(connections[0], 'memory_remember', {
      namespace: NAMESPACE,
      kind: 'preference',
      title: '长期时间轴偏好 1',
      content: `该账户的长期时间轴验证标记是 ${mcpMarker(0)}。`,
      tags: ['qa-long-timeline'],
      importance: 0.8,
      confidence: 1,
      source: 'qa-long-timeline',
      idempotencyKey: `qa-long-timeline-${operationId}-0-remember`,
    }, latencies);
    record(
      'mcp-idempotency',
      replay.memory.id === remembered[0].id,
      { sameMemoryId: replay.memory.id === remembered[0].id },
    );

    const recalls = await Promise.all(connections.map((connection, index) =>
      callMcp(connection, 'memory_recall', {
        namespace: NAMESPACE,
        query: mcpMarker(index),
        minScore: 0,
        limit: 5,
      }, latencies)));
    record(
      'mcp-own-account-recall',
      recalls.every((result, index) =>
        recallContains(result, remembered[index].id)),
      {
        probes: recalls.length,
        hits: recalls.filter((result, index) =>
          recallContains(result, remembered[index].id)).length,
      },
    );

    const crossRecalls = await Promise.all(connections.map(
      (connection, index) => {
        const foreignIndex = (index + 1) % connections.length;
        return callMcp(connection, 'memory_recall', {
          namespace: NAMESPACE,
          query: mcpMarker(foreignIndex),
          minScore: 0,
          limit: 10,
        }, latencies).then((result) => ({ result, foreignIndex }));
      },
    ));
    const leakageCount = crossRecalls.filter(({ result, foreignIndex }) =>
      recallContains(result, remembered[foreignIndex].id)).length;
    record('mcp-ring-cross-account-zero-leakage', leakageCount === 0, {
      probes: crossRecalls.length,
      leakageCount,
    });

    const correctedMarker = 'QAMCP01CORRECTEDZ9';
    await callMcp(connections[0], 'memory_update', {
      id: remembered[0].id,
      title: '修正后的长期时间轴偏好',
      content: `该账户修正后的长期时间轴验证标记是 ${correctedMarker}。`,
    }, latencies);
    const corrected = await callMcp(connections[0], 'memory_recall', {
      namespace: NAMESPACE,
      query: correctedMarker,
      minScore: 0,
      limit: 5,
    }, latencies);
    record(
      'mcp-correction-current-version',
      recallContains(corrected, remembered[0].id),
      { recalledCurrentId: recallContains(corrected, remembered[0].id) },
    );

    await callMcp(connections[1], 'memory_forget', {
      id: remembered[1].id,
      reason: 'qa long timeline tombstone verification',
    }, latencies);
    const forgotten = await callMcp(connections[1], 'memory_recall', {
      namespace: NAMESPACE,
      query: mcpMarker(1),
      minScore: 0,
      limit: 5,
    }, latencies);
    const deleted = await callMcp(connections[1], 'memory_list', {
      namespace: NAMESPACE,
      status: 'deleted',
      limit: 200,
      offset: 0,
    }, latencies);
    record(
      'mcp-forget-tombstone',
      !recallContains(forgotten, remembered[1].id) &&
        deleted.items.some((item) =>
          item.id === remembered[1].id && item.status === 'deleted'),
      {
        immediatelyNotRecalled: !recallContains(
          forgotten,
          remembered[1].id,
        ),
        tombstoneVisible: deleted.items.some((item) =>
          item.id === remembered[1].id && item.status === 'deleted'),
      },
    );
  } finally {
    await Promise.allSettled(connections.map(async (connection) => {
      await connection.transport.close();
    }));
  }
  record(
    'mcp-token-not-in-stderr',
    connections.every((connection) => !connection.tokenLeakedToStderr),
    {
      leakedConnections: connections
        .filter((connection) => connection.tokenLeakedToStderr)
        .map((connection) => connection.label),
    },
  );
  return {
    checks,
    latency: Object.fromEntries(REQUIRED_MCP_TOOLS.map((tool) => [
      tool,
      latencySummary(
        latencies
          .filter((item) => item.tool === tool)
          .map((item) => item.durationMs),
      ),
    ])),
    rememberedIds: remembered.map((memory) => memory.id),
  };
}

function deterministicConsolidationProvider() {
  return {
    model: 'qwen2.5:14b',
    promptVersion: 'qa-long-timeline-consolidation-v1',
    async consolidate(_scope, sources) {
      return {
        sentences: [{
          text: `用户的长期时间轴验证标记包括 ${sources
            .map((source) => source.normalizedValue || source.content)
            .join('、')}。`,
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
        rationale: 'qa deterministic source coverage',
      }));
    },
  };
}

async function runConsolidationCheck(database, principalId) {
  const lifecycle = new LifecycleStore(database);
  const memoryStore = new MemoryStore(database);
  const sources = [];
  for (let index = 0; index < 3; index += 1) {
    sources.push(memoryStore.remember({
      userId: principalId,
      namespace: NAMESPACE,
      kind: 'preference',
      content: `用户多次确认长期时间轴整理偏好 CONSOLIDATE-QA-01，证据 ${index + 1}。`,
      stableKey: `qa-consolidation-source-${index + 1}`,
      predicateKey: '用户::长期时间轴整理偏好',
      normalizedValue: 'CONSOLIDATE-QA-01',
      normalizedValueHash: `qa-consolidation-${index + 1}`,
      source: 'qa-long-timeline',
      idempotencyKey: `qa-consolidation-${index + 1}`,
    }).memory);
  }
  const consolidator = new MemoryConsolidator(
    database,
    lifecycle,
    memoryStore,
    deterministicConsolidationProvider(),
    2,
    20,
    2,
  );
  const result = await consolidator.consolidateScope({
    userId: principalId,
    namespace: NAMESPACE,
    scopeType: 'topic',
    scopeKey: 'kind:preference',
    accessScopeType: 'personal',
    accessScopeKey: 'self',
  });
  return {
    status: result.status,
    sourceCount: result.sourceCount,
    sentenceCount: result.sentenceCount,
    memoryId: result.memoryId,
    sourceIds: sources.map((source) => source.id),
  };
}

async function requiredModelsPreflight() {
  const started = performance.now();
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return {
        available: false,
        requiredModels: [
          REQUIRED_GENERATION_MODEL,
          REQUIRED_EMBEDDING_MODEL,
        ],
        reason: `ollama_http_${response.status}`,
        durationMs: Number((performance.now() - started).toFixed(3)),
      };
    }
    const payload = await response.json();
    const names = (payload.models || []).map((model) => String(model.name));
    const generationAvailable = names.some((name) =>
      name === REQUIRED_GENERATION_MODEL ||
      name.startsWith(`${REQUIRED_GENERATION_MODEL}-`));
    const embeddingAvailable = names.some((name) =>
      name === REQUIRED_EMBEDDING_MODEL ||
      name.startsWith(`${REQUIRED_EMBEDDING_MODEL}-`));
    return {
      available: generationAvailable && embeddingAvailable,
      requiredModels: [
        REQUIRED_GENERATION_MODEL,
        REQUIRED_EMBEDDING_MODEL,
      ],
      generationAvailable,
      embeddingAvailable,
      reason: generationAvailable && embeddingAvailable
        ? null
        : 'required_models_missing',
      durationMs: Number((performance.now() - started).toFixed(3)),
    };
  } catch (error) {
    return {
      available: false,
      requiredModels: [
        REQUIRED_GENERATION_MODEL,
        REQUIRED_EMBEDDING_MODEL,
      ],
      reason: 'ollama_unreachable',
      errorClass: error instanceof Error ? error.name : 'Error',
      durationMs: Number((performance.now() - started).toFixed(3)),
    };
  }
}

async function runQwenReflectionSample(database, principalId) {
  const lifecycle = new LifecycleStore(database);
  const sampleTurns = [
    '周一午餐我选择清淡少辣，真实模型口味标记是 QWENFLAVOR01。',
    '今天只是记录一次普通通勤，没有新的长期结论。',
    '周三午餐我仍然选择清淡少辣，真实模型口味标记是 QWENFLAVOR01。',
    '下午看了一段技术视频，这只是一次性活动。',
    '周五午餐我还是选择清淡少辣，真实模型口味标记是 QWENFLAVOR01。',
    '周末安排可能变化，不要把这条临时计划当成稳定偏好。',
  ];
  for (const [index, content] of sampleTurns.entries()) {
    lifecycle.recordTurn({
      userId: principalId,
      namespace: QWEN_SAMPLE_NAMESPACE,
      clientName: 'qa-long-timeline-qwen',
      sessionExternalId: 'qa-qwen-reflection-sample',
      turnExternalId: `qa-qwen-reflection-turn-${index + 1}`,
      role: 'user',
      content,
      occurredAt: new Date(
        Date.parse('2026-06-01T08:00:00.000Z') + index * 86_400_000,
      ).toISOString(),
    });
  }
  const service = new MemoryReflectionService(
    database,
    lifecycle,
    deterministicExtractor(),
    new OllamaReflectionProvider({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen2.5:14b',
      promptVersion: 'qa-long-timeline-qwen-reflection-v1',
      timeoutMs: 180_000,
    }),
    {
      mode: 'shadow',
      maxTurns: 12,
      tokenBudget: 32_000,
      lookbackDays: 365,
      minNewTurns: 1,
      minPatternEvidence: 3,
      maxDailyCalls: 100_000,
      clock: () => new Date('2026-07-01T00:00:00.000Z'),
    },
  );
  const queued = service.queueRun({
    userId: principalId,
    namespace: QWEN_SAMPLE_NAMESPACE,
    scopeType: 'personal',
    scopeKey: 'self',
    runType: 'reflect',
    trigger: 'manual',
    requestedBy: 'qa-long-timeline-qwen',
  });
  const started = performance.now();
  const executed = await service.executeRun(
    queued.run.id,
    'qa-long-timeline-qwen-worker',
  );
  const evidenceCounts = executed.candidates.map((candidate) => ({
    candidateId: candidate.id,
    distinctTurnCount: scalar(
      database,
      `SELECT COUNT(DISTINCT turn_id)
       FROM memory_candidate_evidence
       WHERE candidate_id = ?`,
      candidate.id,
    ),
  }));
  return {
    model: 'qwen2.5:14b',
    principalId,
    runId: executed.run.id,
    status: executed.run.status,
    inputTurnCount: executed.run.inputTurnCount,
    expectedInputTurnCount: sampleTurns.length,
    candidateCount: executed.run.candidateCount,
    pendingCount: executed.run.pendingCount,
    rejectedCount: executed.run.rejectedCount,
    evidenceCounts,
    durationMs: Number((performance.now() - started).toFixed(3)),
  };
}

function databaseSnapshot(
  database,
  databasePath,
  snapshotAt = new Date().toISOString(),
) {
  const integrity = String(
    Object.values(database.prepare('PRAGMA integrity_check').get() || {})[0]
      || '',
  );
  const userCounts = database.prepare(
    `SELECT user_id, COUNT(*) AS count
     FROM conversation_turns
     WHERE namespace = ?
     GROUP BY user_id
     ORDER BY user_id`,
  ).all(NAMESPACE).map((row) => ({
    principalId: String(row.user_id),
    messages: Number(row.count),
  }));
  const roleCounts = database.prepare(
    `SELECT user_id, role, COUNT(*) AS count
     FROM conversation_turns
     WHERE namespace = ?
     GROUP BY user_id, role
     ORDER BY user_id, role`,
  ).all(NAMESPACE).map((row) => ({
    principalId: String(row.user_id),
    role: String(row.role),
    messages: Number(row.count),
  }));
  const personaCounts = database.prepare(
    `SELECT t.user_id, s.persona_id, COUNT(*) AS count
     FROM conversation_turns t
     JOIN conversation_sessions s ON s.id = t.session_id
     WHERE t.namespace = ?
     GROUP BY t.user_id, s.persona_id
     ORDER BY t.user_id, s.persona_id`,
  ).all(NAMESPACE).map((row) => ({
    principalId: String(row.user_id),
    personaId: String(row.persona_id),
    messages: Number(row.count),
  }));
  const timelineByPrincipal = database.prepare(
    `SELECT user_id, MIN(occurred_at) AS first_message_at,
            MAX(occurred_at) AS last_message_at,
            COUNT(DISTINCT substr(occurred_at, 1, 10)) AS active_days,
            julianday(MAX(occurred_at)) - julianday(MIN(occurred_at))
              AS span_days
     FROM conversation_turns
     WHERE namespace = ?
     GROUP BY user_id
     ORDER BY user_id`,
  ).all(NAMESPACE).map((row) => ({
    principalId: String(row.user_id),
    firstMessageAt: String(row.first_message_at),
    lastMessageAt: String(row.last_message_at),
    activeDays: Number(row.active_days),
    spanDays: Number(Number(row.span_days).toFixed(6)),
  }));
  const convergence = convergenceSnapshot(database, snapshotAt);
  const episodeCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes
     WHERE namespace = ? AND status = 'active'`,
    NAMESPACE,
  );
  const completeEpisodeCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN conversation_turns u ON u.id = e.user_turn_id
     JOIN conversation_turns a ON a.id = e.assistant_turn_id
     WHERE e.namespace = ? AND e.status = 'active'
       AND u.role = 'user' AND a.role = 'assistant'
       AND u.session_id = e.session_id AND a.session_id = e.session_id
       AND u.user_id = e.user_id AND a.user_id = e.user_id
       AND u.namespace = e.namespace AND a.namespace = e.namespace
       AND (SELECT COUNT(*) FROM conversation_episode_turns et
            WHERE et.episode_id = e.id) = 2
       AND EXISTS (
         SELECT 1 FROM conversation_episode_turns et
         WHERE et.episode_id = e.id
           AND et.turn_id = e.user_turn_id
           AND et.role = 'user'
           AND et.ordinal = 0
           AND et.content_hash = u.content_hash
       )
       AND EXISTS (
         SELECT 1 FROM conversation_episode_turns et
         WHERE et.episode_id = e.id
           AND et.turn_id = e.assistant_turn_id
           AND et.role = 'assistant'
           AND et.ordinal = 1
           AND et.content_hash = a.content_hash
       )`,
    NAMESPACE,
  );
  const episodeFtsCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_episodes e
     JOIN memories_fts f ON f.memory_id = e.memory_id
     WHERE e.namespace = ? AND e.status = 'active'`,
    NAMESPACE,
  );
  const activeMemoryCount = scalar(
    database,
    `SELECT COUNT(*) FROM memories
     WHERE namespace = ? AND status = 'active'`,
    NAMESPACE,
  );
  const activeMemoryFtsCount = scalar(
    database,
    `SELECT COUNT(*) FROM memories memory
     JOIN memories_fts f ON f.memory_id = memory.id
     WHERE memory.namespace = ? AND memory.status = 'active'`,
    NAMESPACE,
  );
  const episodeDenseCount = scalar(
    database,
    `SELECT COUNT(DISTINCT e.id) FROM conversation_episodes e
     JOIN memories memory ON memory.id = e.memory_id
     JOIN dense_index_aliases a
       ON a.user_id = e.user_id AND a.namespace = e.namespace
     JOIN dense_index_generations generation
       ON generation.generation_id = a.active_generation_id
     JOIN memory_embeddings d
       ON d.memory_id = e.memory_id
      AND d.generation_id = a.active_generation_id
      AND d.model = ?
      AND d.memory_revision = memory.semantic_revision
      AND d.generation_key = generation.generation_key
      AND d.dimensions = generation.dimensions
      AND length(d.embedding) =
        generation.dimensions * ${Float32Array.BYTES_PER_ELEMENT}
     WHERE e.namespace = ? AND e.status = 'active'
       AND generation.embedding_model = ?
       AND generation.status = 'active'
       AND (SELECT COUNT(DISTINCT lsh.band) FROM memory_dense_lsh lsh
            WHERE lsh.memory_id = e.memory_id
              AND lsh.generation_id = generation.generation_id
              AND lsh.embedding_model = generation.embedding_model
              AND lsh.index_version = generation.index_version
              AND lsh.dimensions = generation.dimensions
              AND lsh.generation_key = generation.generation_key
              AND lsh.memory_revision = memory.semantic_revision) = 32`,
    REQUIRED_EMBEDDING_MODEL,
    NAMESPACE,
    REQUIRED_EMBEDDING_MODEL,
  );
  const activeMemoryDenseCount = scalar(
    database,
    `SELECT COUNT(DISTINCT memory.id) FROM memories memory
     JOIN dense_index_aliases alias
       ON alias.user_id = memory.user_id
      AND alias.namespace = memory.namespace
     JOIN dense_index_generations generation
       ON generation.generation_id = alias.active_generation_id
     JOIN memory_embeddings embedding
       ON embedding.memory_id = memory.id
      AND embedding.generation_id = alias.active_generation_id
      AND embedding.model = ?
      AND embedding.memory_revision = memory.semantic_revision
      AND embedding.generation_key = generation.generation_key
      AND embedding.dimensions = generation.dimensions
      AND length(embedding.embedding) =
        generation.dimensions * ${Float32Array.BYTES_PER_ELEMENT}
     WHERE memory.namespace = ? AND memory.status = 'active'
       AND generation.embedding_model = ?
       AND generation.status = 'active'
       AND (SELECT COUNT(DISTINCT lsh.band) FROM memory_dense_lsh lsh
            WHERE lsh.memory_id = memory.id
              AND lsh.generation_id = generation.generation_id
              AND lsh.embedding_model = generation.embedding_model
              AND lsh.index_version = generation.index_version
              AND lsh.dimensions = generation.dimensions
              AND lsh.generation_key = generation.generation_key
              AND lsh.memory_revision = memory.semantic_revision) = 32`,
    REQUIRED_EMBEDDING_MODEL,
    NAMESPACE,
    REQUIRED_EMBEDDING_MODEL,
  );
  const summaryCounts = Object.fromEntries(
    ['session', 'day', 'week'].map((summaryType) => [
      summaryType,
      scalar(
        database,
        `SELECT COUNT(*) FROM conversation_memory_summaries
         WHERE namespace = ? AND summary_type = ? AND status = 'active'`,
        NAMESPACE,
        summaryType,
      ),
    ]),
  );
  const summaryCount = Object.values(summaryCounts)
    .reduce((total, count) => total + count, 0);
  const supportedSummaryCount = scalar(
    database,
    `SELECT COUNT(*) FROM conversation_memory_summaries summary
     WHERE summary.namespace = ? AND summary.status = 'active'
       AND summary.source_count > 0
       AND summary.source_count = (
         SELECT COUNT(*) FROM conversation_memory_summary_sources source
         JOIN conversation_episodes episode ON episode.id = source.episode_id
         JOIN memories memory ON memory.id = episode.memory_id
         JOIN memory_items item ON item.id = episode.memory_id
         WHERE source.summary_id = summary.id
           AND episode.status = 'active'
           AND memory.status = 'active'
           AND item.status = 'active'
           AND memory.source = 'conversation_episode'
       )
       AND EXISTS (
         SELECT 1 FROM memory_evidence evidence
         JOIN memory_versions version
           ON version.id = evidence.memory_version_id
         JOIN memory_items summary_item
           ON summary_item.current_version_id = version.id
         WHERE summary_item.id = summary.memory_id
           AND evidence.evidence_type = 'hierarchical_summary_sentence'
       )
       AND NOT EXISTS (
         SELECT 1 FROM conversation_memory_summary_sources source
         JOIN conversation_episodes episode ON episode.id = source.episode_id
         JOIN memory_items episode_item ON episode_item.id = episode.memory_id
         WHERE source.summary_id = summary.id
           AND NOT EXISTS (
             SELECT 1 FROM memory_evidence evidence
             JOIN memory_versions version
               ON version.id = evidence.memory_version_id
             JOIN memory_items summary_item
               ON summary_item.current_version_id = version.id
             WHERE summary_item.id = summary.memory_id
               AND evidence.evidence_type = 'hierarchical_summary_sentence'
               AND evidence.source_ref LIKE
                 '%episode:' || episode.id || '%'
               AND evidence.source_ref LIKE
                 '%version:' || episode_item.current_version_id || '%'
           )
       )`,
    NAMESPACE,
  );
  const openSummaryJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE namespace = ? AND job_type = 'summarize_memory_bucket'
       AND status IN ('pending', 'running', 'failed')`,
    NAMESPACE,
  );
  const observationCount = scalar(
    database,
    `SELECT COUNT(*) FROM memory_pattern_observations
     WHERE namespace = ? AND observation_state = 'supporting'`,
    NAMESPACE,
  );
  const invalidObservationOwnership = scalar(
    database,
    `SELECT COUNT(*) FROM memory_pattern_observations observation
     JOIN conversation_turns turn ON turn.id = observation.turn_id
     JOIN conversation_sessions session ON session.id = observation.session_id
     WHERE observation.namespace = ? AND (
       observation.user_id != turn.user_id
       OR observation.namespace != turn.namespace
       OR observation.user_id != session.user_id
       OR observation.namespace != session.namespace
       OR observation.session_id != turn.session_id
     )`,
    NAMESPACE,
  );
  const failedReflectionRuns = scalar(
    database,
    `SELECT COUNT(*) FROM memory_reflection_runs
     WHERE status IN ('failed', 'dead')`,
  );
  const deadJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status = 'dead'`,
  );
  const unhealthyJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status IN ('running', 'failed', 'dead')
        OR (
          status = 'pending' AND available_at <= ?
        )`,
    snapshotAt,
  );
  const unexpectedFutureJobs = scalar(
    database,
    `SELECT COUNT(*) FROM memory_jobs
     WHERE status = 'pending' AND available_at > ?
       AND job_type NOT IN (
         'consolidation_sweep', 'reflection_sweep', 'retention_sweep'
       )`,
    snapshotAt,
  );
  const deadLetterJobs = scalar(
    database,
    'SELECT COUNT(*) FROM dead_letter_jobs',
  );
  return {
    integrity,
    foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all()
      .length,
    schemaVersion: Number(
      database.prepare('PRAGMA user_version').get()?.user_version || 0,
    ),
    principals: scalar(
      database,
      `SELECT COUNT(*) FROM account_principals
       WHERE id LIKE 'timeline-user-%'`,
    ),
    conversations: scalar(
      database,
      'SELECT COUNT(*) FROM conversation_sessions WHERE namespace = ?',
      NAMESPACE,
    ),
    openSessions: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_sessions
       WHERE namespace = ? AND ended_at IS NULL`,
      NAMESPACE,
    ),
    messages: scalar(
      database,
      'SELECT COUNT(*) FROM conversation_turns WHERE namespace = ?',
      NAMESPACE,
    ),
    userMessages: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_turns
       WHERE namespace = ? AND role = 'user'`,
      NAMESPACE,
    ),
    assistantMessages: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_turns
       WHERE namespace = ? AND role = 'assistant'`,
      NAMESPACE,
    ),
    userCounts,
    roleCounts,
    personaCounts,
    timelineByPrincipal,
    convergence,
    nonFutureOpenOutbox: convergence.nonFutureOpenOutbox,
    nonFutureOpenJobs: convergence.nonFutureOpenJobs,
    episodeCount,
    completeEpisodeCount,
    episodeFtsCount,
    activeMemoryCount,
    activeMemoryFtsCount,
    episodeDenseCount,
    activeMemoryDenseCount,
    summaryCounts,
    summaryCount,
    supportedSummaryCount,
    openSummaryJobs,
    observationCount,
    invalidObservationOwnership,
    failedReflectionRuns,
    deadJobs,
    unexpectedFutureJobs,
    timelineOrderViolations: scalar(
      database,
      `SELECT COUNT(*) FROM (
         SELECT occurred_at,
                LAG(occurred_at) OVER (
                  PARTITION BY session_id ORDER BY message_sequence
                ) AS previous_occurred_at
         FROM conversation_turns
         WHERE namespace = ?
       )
       WHERE previous_occurred_at IS NOT NULL
         AND occurred_at <= previous_occurred_at`,
      NAMESPACE,
    ),
    outsideAwakeWindow: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_turns
       WHERE namespace = ? AND (
         substr(occurred_at, 12, 8) < '07:30:00'
         OR substr(occurred_at, 12, 8) > '22:31:00'
       )`,
      NAMESPACE,
    ),
    sequenceGaps: scalar(
      database,
      `SELECT COUNT(*) FROM (
         SELECT session_id, COUNT(*) AS message_count,
                MIN(message_sequence) AS minimum_sequence,
                MAX(message_sequence) AS maximum_sequence,
                COUNT(DISTINCT message_sequence) AS unique_sequences
         FROM conversation_turns
         WHERE namespace = ?
         GROUP BY session_id
         HAVING minimum_sequence != 1
            OR maximum_sequence != message_count
            OR unique_sequences != message_count
       )`,
      NAMESPACE,
    ),
    sessionRollupMismatches: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_sessions s
       WHERE s.namespace = ? AND s.message_count != (
         SELECT COUNT(*) FROM conversation_turns t
         WHERE t.session_id = s.id
       )`,
      NAMESPACE,
    ),
    tenantMismatches: scalar(
      database,
      `SELECT COUNT(*) FROM conversation_turns t
       JOIN conversation_sessions s ON s.id = t.session_id
       WHERE t.namespace = ? AND (
         t.user_id != s.user_id OR t.namespace != s.namespace
       )`,
      NAMESPACE,
    ),
    reflectionRunsByStatus: database.prepare(
      `SELECT status, COUNT(*) AS count
       FROM memory_reflection_runs
       WHERE namespace = ? GROUP BY status ORDER BY status`,
    ).all(NAMESPACE).map((row) => ({
      status: String(row.status),
      count: Number(row.count),
    })),
    reflectionCandidates: scalar(
      database,
      `SELECT COUNT(*) FROM memory_candidates
       WHERE namespace = ? AND candidate_origin = 'reflection'`,
      NAMESPACE,
    ),
    crossTenantReflectionEvidence: scalar(
      database,
      `SELECT COUNT(*)
       FROM memory_candidate_evidence e
       JOIN memory_candidates c ON c.id = e.candidate_id
       JOIN conversation_turns t ON t.id = e.turn_id
       WHERE c.namespace = ? AND (
         c.user_id != t.user_id OR c.namespace != t.namespace
       )`,
      NAMESPACE,
    ),
    memoryVersions: scalar(
      database,
      `SELECT COUNT(*) FROM memory_versions WHERE namespace = ?`,
      NAMESPACE,
    ),
    tombstones: scalar(
      database,
      `SELECT COUNT(*) FROM memory_tombstones WHERE namespace = ?`,
      NAMESPACE,
    ),
    openOutbox: convergence.totalOpenOutbox,
    unhealthyJobs,
    deadLetterJobs,
    bytes: {
      database: safeFileSize(databasePath),
      wal: safeFileSize(`${databasePath}-wal`),
      shm: safeFileSize(`${databasePath}-shm`),
    },
  };
}

function persistenceFingerprint(snapshot) {
  return sha256(JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    integrity: snapshot.integrity,
    foreignKeyViolations: snapshot.foreignKeyViolations,
    principals: snapshot.principals,
    conversations: snapshot.conversations,
    openSessions: snapshot.openSessions,
    messages: snapshot.messages,
    userMessages: snapshot.userMessages,
    assistantMessages: snapshot.assistantMessages,
    userCounts: snapshot.userCounts,
    roleCounts: snapshot.roleCounts,
    personaCounts: snapshot.personaCounts,
    timelineByPrincipal: snapshot.timelineByPrincipal,
    episodeCount: snapshot.episodeCount,
    completeEpisodeCount: snapshot.completeEpisodeCount,
    episodeFtsCount: snapshot.episodeFtsCount,
    activeMemoryCount: snapshot.activeMemoryCount,
    activeMemoryFtsCount: snapshot.activeMemoryFtsCount,
    episodeDenseCount: snapshot.episodeDenseCount,
    activeMemoryDenseCount: snapshot.activeMemoryDenseCount,
    summaryCounts: snapshot.summaryCounts,
    summaryCount: snapshot.summaryCount,
    supportedSummaryCount: snapshot.supportedSummaryCount,
    openSummaryJobs: snapshot.openSummaryJobs,
    observationCount: snapshot.observationCount,
    invalidObservationOwnership: snapshot.invalidObservationOwnership,
    failedReflectionRuns: snapshot.failedReflectionRuns,
    deadJobs: snapshot.deadJobs,
    unexpectedFutureJobs: snapshot.unexpectedFutureJobs,
    unhealthyJobs: snapshot.unhealthyJobs,
    deadLetterJobs: snapshot.deadLetterJobs,
    convergence: {
      nonFutureOpenOutbox: snapshot.convergence.nonFutureOpenOutbox,
      nonFutureOpenJobs: snapshot.convergence.nonFutureOpenJobs,
      outboxByStatus: snapshot.convergence.outboxByStatus,
      jobsByTypeAndStatus: snapshot.convergence.jobsByTypeAndStatus,
    },
  }));
}

function benchmarkEpisodeFts(database, principals, at) {
  const index = new HybridRetrievalIndex(database);
  const durations = [];
  const resultCounts = [];
  for (let sample = 0; sample < FTS_PERFORMANCE_SAMPLES; sample += 1) {
    const principalId = principals[sample % principals.length];
    const query = sample % 2 === 0
      ? '稳定口味标记 QAFLAVOR'
      : '时间轴 通勤 拉伸';
    const started = performance.now();
    const results = index.search({
      query,
      userId: principalId,
      namespace: NAMESPACE,
      scopes: [{ scopeType: 'personal', scopeKey: 'self' }],
      timestamp: at,
      limit: 40,
    });
    durations.push(performance.now() - started);
    resultCounts.push(results.length);
  }
  return {
    samples: FTS_PERFORMANCE_SAMPLES,
    minimumEpisodeCorpus: 10_000,
    latency: latencySummary(durations),
    nonEmptySamples: resultCounts.filter((count) => count > 0).length,
  };
}

export {
  convergenceSnapshot,
  databaseSnapshot,
  parseRunnerConfig,
  persistenceFingerprint,
  validateResumeManifest,
};

async function runParent() {
  const runnerConfig = parseRunnerConfig(process.argv.slice(2));
  const implementation = currentImplementationEvidence();
  const resume = runnerConfig.resumeRoot
    ? validateResumeManifest(runnerConfig.resumeRoot, implementation)
    : null;
  const runId = resume?.runId || createQaRunId();
  const runRoot = resume?.runRoot ||
    createPrivateQaRunRoot(privateParent, 'run-');
  const dataDir = resume?.dataDir || path.join(runRoot, 'data');
  const receiptsDir = resume?.receiptsDir || path.join(runRoot, 'receipts');
  const workerDir = resume?.workerDir || path.join(runRoot, 'workers');
  if (!resume) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  }
  const databasePath = resume?.databasePath ||
    path.join(dataDir, 'memory-bridge.sqlite3');
  const reportPath = immutableQaPath(
    receiptsDir,
    'conversation-long-timeline',
    runId,
    'json',
  );
  const checks = [];
  const record = (name, passed, details = {}) => {
    const check = { name, passed: Boolean(passed), ...details };
    checks.push(check);
    console.log(`[check] ${check.passed ? 'PASS' : 'FAIL'} ${name}`);
  };
  const startedAt = new Date().toISOString();
  if (!resume) {
    writeImmutableQaFile(
      path.join(receiptsDir, 'run-manifest.json'),
      `${JSON.stringify({
        format: MANIFEST_FORMAT,
        runId,
        runRoot,
        startedAt,
        databasePath,
        userCount: USER_COUNT,
        messagesPerUser: MESSAGES_PER_USER,
        totalMessages: USER_COUNT * MESSAGES_PER_USER,
        timelineDays: TIMELINE_DAYS,
        namespace: NAMESPACE,
        requiredGenerationModel: REQUIRED_GENERATION_MODEL,
        requiredEmbeddingModel: REQUIRED_EMBEDDING_MODEL,
        schemaVersion: SCHEMA_VERSION,
        productionPortUsed: false,
        productionDatabaseUsed: false,
        scalePipelineProvenance: SCALE_PIPELINE_PROVENANCE,
        implementation,
      }, null, 2)}\n`,
    );
  }

  const credentials = [];
  const principals = [];
  const workerSpecs = [];
  let setupDatabase = openDatabase(databasePath);
  try {
    const identity = new IdentityService(setupDatabase);
    if (resume) {
      for (let userIndex = 0; userIndex < USER_COUNT; userIndex += 1) {
        const principalId = userLabel(userIndex);
        principals.push(principalId);
        const issued = identity.issueCredential({
          principalId,
          label: `qa-long-timeline-resume-${startedAt}`,
        });
        credentials.push({
          principalId,
          credentialId: issued.credential.id,
          token: issued.token,
        });
      }
    }
    let setupTime = timelineTimestamp(0);
    const service = new ConversationService(setupDatabase, {
      now: () => setupTime,
      instanceId: 'timeline-setup',
    });
    for (let userIndex = 0;
      !resume && userIndex < USER_COUNT;
      userIndex += 1) {
      const principalId = userLabel(userIndex);
      principals.push(principalId);
      identity.createPrincipal({
        id: principalId,
        displayName: `时间轴用户 ${userIndex + 1}`,
      });
      const trusted = identity.trustPrincipal(principalId);
      const tenant = { principalId, namespace: NAMESPACE };
      for (let personaIndex = 0; personaIndex < 2; personaIndex += 1) {
        const id = personaId(userIndex, personaIndex);
        const role = personaIndex === 0
          ? {
              displayName: '陪伴角色',
              systemPrompt: '温和倾听并回应日常生活，只使用当前账户的记忆。',
            }
          : {
              displayName: '工作角色',
              systemPrompt: '先给结论再给依据，只使用当前账户和项目的记忆。',
            };
        identity.bindPersona(trusted, {
          clientType: 'qa-long-timeline',
          clientInstanceId: `${principalId}-device`,
          personaId: id,
          displayName: role.displayName,
        });
        service.putChatProfile(tenant, id, {
          expectedVersion: 0,
          displayName: role.displayName,
          systemPrompt: role.systemPrompt,
          greeting: '你好。',
          language: 'zh-Hans',
          capabilityIds: [],
        });
      }
      service.bindProject(tenant, projectId(userIndex), {
        expectedVersion: 0,
        displayName: `长期项目 ${userIndex + 1}`,
      });
      const conversations = [];
      for (let conversationIndex = 0;
        conversationIndex < CONVERSATIONS_PER_USER;
        conversationIndex += 1) {
        const conversation = service.createConversation(tenant, {
          idempotencyKey: `${principalId}-conversation-${conversationIndex}`,
          personaId: personaId(userIndex, conversationIndex % 2),
          projectId: conversationIndex < 2
            ? projectId(userIndex)
            : null,
          title: `长期时间轴会话 ${conversationIndex + 1}`,
        });
        conversations.push({
          id: conversation.id,
          personaId: conversation.personaId,
          projectId: conversation.projectId,
        });
      }
      const issued = identity.issueCredential({
        principalId,
        label: 'qa-long-timeline-mcp',
      });
      credentials.push({
        principalId,
        credentialId: issued.credential.id,
        token: issued.token,
      });
      const resultPath = path.join(
        workerDir,
        `${principalId}-result.json`,
      );
      const specPath = path.join(workerDir, `${principalId}-spec.json`);
      writeImmutableQaFile(specPath, `${JSON.stringify({
        databasePath,
        namespace: NAMESPACE,
        principalId,
        userIndex,
        conversations,
        resultPath,
      }, null, 2)}\n`);
      workerSpecs.push({ specPath, resultPath });
    }
  } finally {
    setupDatabase.close();
    setupDatabase = null;
  }
  record('isolated-database-path', databasePath.startsWith(
    `${path.resolve(privateParent)}${path.sep}`,
  ), { databasePath });
  record('credential-provisioning', credentials.length === USER_COUNT, {
    principals: credentials.map((item) => item.principalId),
    tokensPersistedInReport: false,
  });

  const writerStarted = performance.now();
  const concurrencyState = {
    active: 0,
    maximum: resume?.writerSummary.observedMaxConcurrency || 0,
  };
  if (!resume) {
    for (let offset = 0;
      offset < workerSpecs.length;
      offset += WRITE_CONCURRENCY) {
      const batch = workerSpecs.slice(offset, offset + WRITE_CONCURRENCY);
      await Promise.all(batch.map((spec) =>
        spawnWriter(spec.specPath, concurrencyState)));
    }
  }
  const writerResults = resume
    ? resume.writerSummary.workers
    : workerSpecs.map((spec) =>
      readJsonFile(spec.resultPath, 'timeline writer result'));
  const writerDurationMs = resume
    ? Number(resume.writerSummary.durationMs)
    : performance.now() - writerStarted;
  if (!resume) {
    writeImmutableQaFile(
      path.join(receiptsDir, 'writer-summary.json'),
      `${JSON.stringify({
        format: 'memory-bridge-long-timeline-writers:v1',
        runId,
        totalMessages: USER_COUNT * MESSAGES_PER_USER,
        observedMaxConcurrency: concurrencyState.maximum,
        durationMs: Number(writerDurationMs.toFixed(3)),
        workers: writerResults,
      }, null, 2)}\n`,
    );
  }
  record(
    'concurrent-authoritative-write-count',
    writerResults.every((item) =>
      item.counters.messagesWritten === MESSAGES_PER_USER) &&
      writerResults.reduce(
        (total, item) => total + item.counters.messagesWritten,
        0,
      ) === USER_COUNT * MESSAGES_PER_USER,
    {
      users: writerResults.length,
      expectedPerUser: MESSAGES_PER_USER,
      actualPerUser: writerResults.map((item) => ({
        principalId: item.principalId,
        messages: item.counters.messagesWritten,
      })),
      busyRetries: writerResults.reduce(
        (total, item) => total + item.counters.busyRetries,
        0,
      ),
      durationMs: Number(writerDurationMs.toFixed(3)),
    },
  );
  record('observed-write-concurrency',
    concurrencyState.maximum === WRITE_CONCURRENCY,
    {
      expected: WRITE_CONCURRENCY,
      observedMaximum: concurrencyState.maximum,
    },
  );

  let database = openDatabase(databasePath);
  let reflection;
  let mcp;
  let consolidation;
  let initialConvergence;
  let finalConvergence;
  let endedSessions = 0;
  try {
    reflection = await runReflectionCoverage(database, principals);
    record(
      'reflection-checkpoints-caught-up',
      reflection.remaining.every((item) =>
        item.reextract === 0 && item.reflect === 0),
      { remaining: reflection.remaining },
    );
    const reflectionValidation = await runReflectionValidationSample(
      database,
      principals,
    );
    record(
      'reflection-stable-pattern-candidates',
      reflectionValidation.every((item) =>
        item.candidateCount >= 1 &&
        item.candidates.every((candidate) =>
          candidate.state === 'pending' && candidate.evidenceTurns >= 3)),
      {
        validationRuns: reflectionValidation,
      },
    );
    record(
      'reflection-evidence-minimum-three-turns',
      scalar(
        database,
        `SELECT COUNT(*) FROM (
           SELECT c.id
           FROM memory_candidates c
           JOIN memory_candidate_evidence e ON e.candidate_id = c.id
           WHERE c.namespace = ? AND c.candidate_origin = 'reflection'
           GROUP BY c.id
           HAVING COUNT(DISTINCT e.turn_id) < 3
         )`,
        NAMESPACE,
      ) === 0,
    );

    mcp = await runMcpChecks(
      credentials,
      dataDir,
      resume ? `resume-${startedAt}` : 'fresh',
    );
    for (const check of mcp.checks) {
      record(`mcp.${check.name}`, check.passed, check);
    }

    consolidation = await runConsolidationCheck(database, principals[0]);
    record(
      'deterministic-consolidation-created',
      ['created', 'rebuilt', 'unchanged'].includes(consolidation.status) &&
        consolidation.sourceCount >= 2 &&
        consolidation.sentenceCount >= 1,
      consolidation,
    );

    const modelPreflight = await requiredModelsPreflight();
    record(
      'qwen2.5-14b-and-bge-m3-preflight',
      modelPreflight.available,
      modelPreflight,
    );
    let realModelSample = {
      model: 'qwen2.5:14b',
      status: 'skipped',
      reason: modelPreflight.reason,
    };
    if (modelPreflight.available) {
      try {
        realModelSample = await runQwenReflectionSample(
          database,
          principals[0],
        );
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);
        realModelSample = {
          model: 'qwen2.5:14b',
          status: 'failed',
          reason: 'real_model_reflection_failed',
          errorClass: error instanceof Error ? error.name : 'Error',
          errorFingerprint: sha256(message),
          error: message.slice(0, 500),
        };
      }
    }
    record(
      'qwen2.5-14b-real-reflection-sample',
      realModelSample.status === 'completed' &&
        realModelSample.inputTurnCount === 6 &&
        realModelSample.candidateCount >= 1 &&
        realModelSample.evidenceCounts?.every((item) =>
          item.distinctTurnCount >= 3),
      realModelSample,
    );
    record(
      'scale-pipeline-provenance-explicit',
      SCALE_PIPELINE_PROVENANCE.worker === 'production-memory-worker' &&
        SCALE_PIPELINE_PROVENANCE.storage === 'real-sqlite-schema37' &&
        SCALE_PIPELINE_PROVENANCE.fullScaleGenerationProviderCalls === 0 &&
        SCALE_PIPELINE_PROVENANCE.boundedRealModels.includes(
          REQUIRED_GENERATION_MODEL,
        ) &&
        SCALE_PIPELINE_PROVENANCE.boundedRealModels.includes(
          REQUIRED_EMBEDDING_MODEL,
        ),
      SCALE_PIPELINE_PROVENANCE,
    );

    if (!modelPreflight.available) {
      throw new Error(
        `严格收敛要求真实 ${REQUIRED_GENERATION_MODEL} 与 ` +
        `${REQUIRED_EMBEDDING_MODEL}: ${modelPreflight.reason}`,
      );
    }
    initialConvergence = await drainToConvergence(database);
    endedSessions = endTimelineSessions(database);
    finalConvergence = await drainToConvergence(database);

    const persistenceSnapshotAt = new Date().toISOString();
    let snapshot = databaseSnapshot(
      database,
      databasePath,
      persistenceSnapshotAt,
    );
    record('database-integrity', snapshot.integrity === 'ok', {
      integrity: snapshot.integrity,
    });
    record('database-foreign-keys', snapshot.foreignKeyViolations === 0, {
      violations: snapshot.foreignKeyViolations,
    });
    record(
      'database-message-counts',
      snapshot.messages === USER_COUNT * MESSAGES_PER_USER &&
        snapshot.userMessages === USER_COUNT * USER_TURNS_PER_USER &&
        snapshot.assistantMessages === USER_COUNT * USER_TURNS_PER_USER &&
        snapshot.userCounts.every((item) =>
          item.messages === MESSAGES_PER_USER),
      {
        messages: snapshot.messages,
        userMessages: snapshot.userMessages,
        assistantMessages: snapshot.assistantMessages,
        perPrincipal: snapshot.userCounts,
      },
    );
    record('database-persona-message-counts',
      snapshot.personaCounts.length === USER_COUNT * 2 &&
        snapshot.personaCounts.every((item) =>
          item.messages === MESSAGES_PER_USER / 2),
      {
        expectedPersonas: USER_COUNT * 2,
        expectedPerPersona: MESSAGES_PER_USER / 2,
        actual: snapshot.personaCounts,
      },
    );
    record('database-role-message-counts',
      snapshot.roleCounts.length === USER_COUNT * 2 &&
        snapshot.roleCounts.every((item) =>
          item.messages === USER_TURNS_PER_USER),
      {
        expectedRows: USER_COUNT * 2,
        expectedPerRoleAndUser: USER_TURNS_PER_USER,
        actual: snapshot.roleCounts,
      },
    );
    record('database-timeline-coverage',
      snapshot.timelineByPrincipal.length === USER_COUNT &&
        snapshot.timelineByPrincipal.every((item) =>
          item.activeDays === ACTIVE_DAYS &&
          item.spanDays >= TIMELINE_DAYS &&
          item.spanDays < TIMELINE_DAYS + 1) &&
        snapshot.outsideAwakeWindow === 0,
      {
        expectedActiveDays: ACTIVE_DAYS,
        expectedMinimumSpanDays: TIMELINE_DAYS,
        outsideAwakeWindow: snapshot.outsideAwakeWindow,
        actual: snapshot.timelineByPrincipal,
      },
    );
    record('database-timeline-order',
      snapshot.timelineOrderViolations === 0,
      { violations: snapshot.timelineOrderViolations },
    );
    record('database-sequence-continuity', snapshot.sequenceGaps === 0, {
      sequenceGaps: snapshot.sequenceGaps,
    });
    record(
      'database-session-rollups',
      snapshot.sessionRollupMismatches === 0,
      { mismatches: snapshot.sessionRollupMismatches },
    );
    record(
      'database-tenant-boundaries',
      snapshot.tenantMismatches === 0 &&
        snapshot.crossTenantReflectionEvidence === 0,
      {
        tenantMismatches: snapshot.tenantMismatches,
        crossTenantReflectionEvidence:
          snapshot.crossTenantReflectionEvidence,
      },
    );
    record('database-outbox-convergence',
      snapshot.nonFutureOpenOutbox === 0 &&
        snapshot.nonFutureOpenJobs === 0,
      snapshot.convergence,
    );
    record('database-episode-convergence',
      snapshot.episodeCount === USER_COUNT * USER_TURNS_PER_USER &&
        snapshot.completeEpisodeCount === snapshot.episodeCount,
      {
        expected: USER_COUNT * USER_TURNS_PER_USER,
        actual: snapshot.episodeCount,
        complete: snapshot.completeEpisodeCount,
      },
    );
    record('database-fts-convergence',
      snapshot.episodeFtsCount === snapshot.episodeCount &&
        snapshot.activeMemoryFtsCount === snapshot.activeMemoryCount,
      {
        episodes: snapshot.episodeCount,
        episodeFts: snapshot.episodeFtsCount,
        activeMemories: snapshot.activeMemoryCount,
        activeMemoryFts: snapshot.activeMemoryFtsCount,
      },
    );
    const ftsPerformance = benchmarkEpisodeFts(
      database,
      principals,
      persistenceSnapshotAt,
    );
    record(
      'database-episode-fts-p95',
      snapshot.episodeCount >= ftsPerformance.minimumEpisodeCorpus &&
        ftsPerformance.nonEmptySamples === ftsPerformance.samples &&
        ftsPerformance.latency.p95Ms < FTS_PERFORMANCE_P95_LIMIT_MS,
      {
        ...ftsPerformance,
        thresholdP95Ms: FTS_PERFORMANCE_P95_LIMIT_MS,
      },
    );
    record('database-dense-convergence',
      snapshot.episodeDenseCount === snapshot.episodeCount &&
        snapshot.activeMemoryDenseCount === snapshot.activeMemoryCount,
      {
        episodes: snapshot.episodeCount,
        episodeDense: snapshot.episodeDenseCount,
        activeMemories: snapshot.activeMemoryCount,
        activeMemoryDense: snapshot.activeMemoryDenseCount,
        requiredEmbeddingModel: REQUIRED_EMBEDDING_MODEL,
      },
    );
    record('database-summary-convergence',
      snapshot.summaryCounts.session > 0 &&
        snapshot.summaryCounts.day > 0 &&
        snapshot.summaryCounts.week > 0 &&
        snapshot.supportedSummaryCount === snapshot.summaryCount &&
        snapshot.openSummaryJobs === 0 &&
        snapshot.openSessions === 0,
      {
        summaryCounts: snapshot.summaryCounts,
        total: snapshot.summaryCount,
        supported: snapshot.supportedSummaryCount,
        openJobs: snapshot.openSummaryJobs,
        openSessions: snapshot.openSessions,
      },
    );
    record('database-observation-convergence',
      snapshot.observationCount > 0 &&
        snapshot.invalidObservationOwnership === 0,
      {
        observations: snapshot.observationCount,
        invalidOwnership: snapshot.invalidObservationOwnership,
      },
    );
    record(
      'database-no-dead-or-unhealthy-job',
        snapshot.failedReflectionRuns === 0 &&
        snapshot.deadJobs === 0 &&
        snapshot.unexpectedFutureJobs === 0 &&
        snapshot.unhealthyJobs === 0 &&
        snapshot.deadLetterJobs === 0,
      {
        failedReflectionRuns: snapshot.failedReflectionRuns,
        deadJobs: snapshot.deadJobs,
        unexpectedFutureJobs: snapshot.unexpectedFutureJobs,
        unhealthyJobs: snapshot.unhealthyJobs,
        deadLetterJobs: snapshot.deadLetterJobs,
      },
    );

    const beforeRestartFingerprint = persistenceFingerprint(snapshot);
    database.close();
    database = null;
    database = openDatabase(databasePath);
    const restartedSnapshot = databaseSnapshot(
      database,
      databasePath,
      persistenceSnapshotAt,
    );
    const afterRestartFingerprint = persistenceFingerprint(restartedSnapshot);
    record(
      'database-restart-persistence',
      restartedSnapshot.integrity === 'ok' &&
        restartedSnapshot.foreignKeyViolations === 0 &&
        beforeRestartFingerprint === afterRestartFingerprint,
      {
        beforeFingerprint: beforeRestartFingerprint,
        afterFingerprint: afterRestartFingerprint,
        integrity: restartedSnapshot.integrity,
        foreignKeyViolations: restartedSnapshot.foreignKeyViolations,
      },
    );
    snapshot = restartedSnapshot;

    const failedChecks = checks.filter((check) => !check.passed);
    const report = {
      format: 'memory-bridge-conversation-long-timeline-report:v1',
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: failedChecks.length === 0 ? 'PASS' : 'FAIL',
      scope: {
        userCount: USER_COUNT,
        personasPerUser: 2,
        conversationsPerUser: CONVERSATIONS_PER_USER,
        projectAndNullProjectCovered: true,
        messagesPerUser: MESSAGES_PER_USER,
        userMessagesPerUser: USER_TURNS_PER_USER,
        assistantMessagesPerUser: USER_TURNS_PER_USER,
        totalMessages: USER_COUNT * MESSAGES_PER_USER,
        timelineDays: TIMELINE_DAYS,
        writeConcurrency: WRITE_CONCURRENCY,
      },
      safety: {
        isolatedDatabase: true,
        productionDatabaseUsed: false,
        productionPort3789Used: false,
        credentialTokensPersisted: false,
        dataRetained: true,
      },
      checks,
      failedChecks: failedChecks.map((check) => check.name),
      writer: {
        durationMs: Number(writerDurationMs.toFixed(3)),
        observedMaxConcurrency: concurrencyState.maximum,
        workers: writerResults,
        latencyAcrossUsers: {
          medianUserP50Ms: percentile(
            writerResults.map((item) => item.latency.p50Ms),
            0.5,
          ),
          maximumUserP95Ms: Math.max(
            ...writerResults.map((item) => item.latency.p95Ms),
          ),
          maximumUserP99Ms: Math.max(
            ...writerResults.map((item) => item.latency.p99Ms),
          ),
          globalMaximumMs: Math.max(
            ...writerResults.map((item) => item.latency.maxMs),
          ),
        },
      },
      reflection: {
        executions: reflection.executions,
        remaining: reflection.remaining,
        validation: reflectionValidation,
      },
      mcp: {
        latency: mcp.latency,
        rememberedMemoryCount: mcp.rememberedIds.length,
      },
      consolidation,
      requiredModelPreflight: modelPreflight,
      realModelSample,
      scalePipelineProvenance: SCALE_PIPELINE_PROVENANCE,
      convergence: {
        initial: initialConvergence,
        endedSessions,
        final: finalConvergence,
      },
      database: snapshot,
      artifacts: {
        runRoot,
        databasePath,
        reportPath,
        retained: true,
      },
      implementation,
    };
    const receipt = writeImmutableQaFile(
      reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(JSON.stringify({
      status: report.status,
      runId,
      runRoot,
      databasePath,
      reportPath,
      reportSha256: receipt.sha256,
      failedChecks: report.failedChecks,
    }, null, 2));
    if (report.status !== 'PASS') process.exitCode = 1;
  } finally {
    database?.close();
  }
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (invokedDirectly) {
  if (process.argv[2] === '--worker') {
    if (process.argv.length !== 4 || !path.isAbsolute(process.argv[3])) {
      throw new Error('--worker 必须且只能接收绝对 spec 路径');
    }
    await runWorker(process.argv[3]);
  } else {
    await runParent();
  }
}
