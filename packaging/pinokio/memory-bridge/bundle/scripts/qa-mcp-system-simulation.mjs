#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  buildQaImplementationEvidence,
  createPrivateQaRunRoot,
  createQaRunId,
  writeImmutableQaFile,
} from './qa-receipt-lib.mjs';
import { compareExpectedErrorEvidence } from './qa-mcp-system-simulation-gates.mjs';

const REQUIRED_TOOLS = Object.freeze([
  'memory_forget',
  'memory_get_context',
  'memory_list',
  'memory_recall',
  'memory_remember',
  'memory_stats',
  'memory_update',
]);
const REQUIRED_TRACE_STAGES = Object.freeze([
  'request',
  'rewrite',
  'channels',
  'fusion',
  'semantic',
  'rerank',
  'selection',
  'context',
  'result',
]);
const MCP_META = Symbol('mcpMeta');
const CHAT_MODEL = 'qwen2.5:14b';
const EMBEDDING_MODEL = 'bge-m3:latest';
const PROFILE_DEFAULTS = Object.freeze({
  smoke: {
    users: 4,
    memoriesPerUser: 20,
    concurrency: 2,
    soakSeconds: 0,
    sampleIntervalSeconds: 2,
  },
  full: {
    users: 8,
    memoriesPerUser: 75,
    concurrency: 4,
    soakSeconds: 30 * 60,
    sampleIntervalSeconds: 60,
  },
});

function boundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum}–${maximum} 的整数`);
  }
  return value;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  )];
}

function latencySummary(values) {
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    average: values.length
      ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
      : null,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : null,
  };
}

function fileSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeError(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]')
    .replace(/(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .slice(0, 500);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(limit, items.length) },
    () => consume(),
  ));
  return results;
}

async function ollamaPreflight(baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/api/tags`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Ollama /api/tags HTTP ${response.status}`);
  const body = await response.json();
  const available = new Set((body.models || []).map((item) => String(item.name)));
  const missing = [CHAT_MODEL, EMBEDDING_MODEL].filter((model) => !available.has(model));
  if (missing.length > 0) throw new Error(`Ollama 缺少固定模型：${missing.join(', ')}`);
  return { baseUrl, models: [CHAT_MODEL, EMBEDDING_MODEL] };
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

function scalar(database, sql, ...parameters) {
  return Number(Object.values(database.prepare(sql).get(...parameters) || {})[0] || 0);
}

function groupedCounts(database, sql) {
  return Object.fromEntries(
    database.prepare(sql).all().map((row) => [
      String(row.key),
      Number(row.count),
    ]),
  );
}

function databaseSnapshot(databasePath, principalIds) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = String(Object.values(
      database.prepare('PRAGMA integrity_check').get() || {},
    )[0] || '');
    const byPrincipal = Object.fromEntries(principalIds.map((principalId) => [
      principalId,
      {
        active: scalar(
          database,
          `SELECT COUNT(*) FROM memory_items WHERE user_id = ? AND status = 'active'`,
          principalId,
        ),
        deleted: scalar(
          database,
          `SELECT COUNT(*) FROM memory_items WHERE user_id = ? AND status = 'deleted'`,
          principalId,
        ),
        versions: scalar(
          database,
          `SELECT COUNT(*) FROM memory_versions v
           JOIN memory_items i ON i.id = v.memory_item_id
           WHERE i.user_id = ?`,
          principalId,
        ),
      },
    ]));
    const traceStageCounts = tableExists(database, 'retrieval_trace_events')
      ? groupedCounts(
          database,
          `SELECT stage AS key, COUNT(*) AS count
           FROM retrieval_trace_events
           GROUP BY stage
           ORDER BY stage`,
        )
      : {};
    const traceCoverage = tableExists(database, 'retrieval_trace_events')
      ? database.prepare(
          `SELECT t.trace_id, t.error_code, t.quality_state,
                  COUNT(DISTINCT e.stage) AS distinct_stages
           FROM retrieval_traces t
           LEFT JOIN retrieval_trace_events e ON e.trace_id = t.trace_id
           GROUP BY t.trace_id, t.error_code, t.quality_state
           ORDER BY t.started_at ASC`,
        ).all().map((row) => ({
          traceId: String(row.trace_id),
          errorCode: row.error_code === null ? null : String(row.error_code),
          qualityState:
            row.quality_state === null ? null : String(row.quality_state),
          distinctStages: Number(row.distinct_stages),
        }))
      : [];
    const observedModels = new Set();
    const observedModelsByStage = {};
    const providerCallsByStage = {};
    let providerCalls = 0;
    if (tableExists(database, 'retrieval_trace_events')) {
      for (const row of database.prepare(
        `SELECT stage, event_json FROM retrieval_trace_events
         WHERE stage IN ('rewrite', 'semantic', 'rerank')`,
      ).all()) {
        try {
          const detail = JSON.parse(String(row.event_json));
          const stage = String(row.stage);
          if (!observedModelsByStage[stage]) {
            observedModelsByStage[stage] = new Set();
          }
          for (const key of ['model', 'embeddingModel']) {
            if (typeof detail[key] === 'string' && detail[key]) {
              observedModels.add(detail[key]);
              observedModelsByStage[stage].add(detail[key]);
            }
          }
          const stageProviderCalls = Number(detail.providerCalls) || 0;
          providerCalls += stageProviderCalls;
          providerCallsByStage[stage] =
            (providerCallsByStage[stage] || 0) + stageProviderCalls;
        } catch {
          // A malformed trace event is caught by the trace coverage gate below.
        }
      }
    }
    return {
      schemaVersion: scalar(database, 'PRAGMA user_version'),
      integrity,
      journalMode: String(Object.values(
        database.prepare('PRAGMA journal_mode').get() || {},
      )[0] || ''),
      foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all().length,
      duplicateStableKeys: scalar(
        database,
        `SELECT COUNT(*) FROM (
           SELECT user_id, namespace, stable_key, COUNT(*) AS count
           FROM memory_items
           GROUP BY user_id, namespace, stable_key
           HAVING COUNT(*) > 1
         )`,
      ),
      orphanVersions: scalar(
        database,
        `SELECT COUNT(*) FROM memory_versions v
         LEFT JOIN memory_items i ON i.id = v.memory_item_id
         WHERE i.id IS NULL`,
      ),
      orphanEvidence: tableExists(database, 'memory_evidence')
        ? scalar(
            database,
            `SELECT COUNT(*) FROM memory_evidence e
             LEFT JOIN memory_versions v ON v.id = e.memory_version_id
             WHERE v.id IS NULL`,
          )
        : 0,
      openOutbox: tableExists(database, 'outbox_events')
        ? scalar(database, `SELECT COUNT(*) FROM outbox_events WHERE status != 'completed'`)
        : 0,
      outboxByStatus: tableExists(database, 'outbox_events')
        ? groupedCounts(
            database,
            `SELECT status AS key, COUNT(*) AS count
             FROM outbox_events GROUP BY status`,
          )
        : {},
      retryingJobs: tableExists(database, 'memory_jobs')
        ? scalar(database, `SELECT COUNT(*) FROM memory_jobs WHERE status IN ('failed', 'running')`)
        : 0,
      deadJobs: tableExists(database, 'memory_jobs')
        ? scalar(database, `SELECT COUNT(*) FROM memory_jobs WHERE status = 'dead'`)
        : 0,
      jobsByStatus: tableExists(database, 'memory_jobs')
        ? groupedCounts(
            database,
            `SELECT status AS key, COUNT(*) AS count
             FROM memory_jobs GROUP BY status`,
          )
        : {},
      deadLetterJobs: tableExists(database, 'dead_letter_jobs')
        ? scalar(database, 'SELECT COUNT(*) FROM dead_letter_jobs')
        : 0,
      quarantinedConsolidations: tableExists(database, 'derived_consolidations')
        ? scalar(
            database,
            `SELECT COUNT(*) FROM derived_consolidations
             WHERE status = 'quarantined'`,
          )
        : 0,
      reflectionRunsByStatus: tableExists(database, 'memory_reflection_runs')
        ? groupedCounts(
            database,
            `SELECT status AS key, COUNT(*) AS count
             FROM memory_reflection_runs GROUP BY status`,
          )
        : {},
      consolidationCount: tableExists(database, 'derived_consolidations')
        ? scalar(database, 'SELECT COUNT(*) FROM derived_consolidations')
        : 0,
      retrievalTraces: tableExists(database, 'retrieval_traces')
        ? scalar(database, 'SELECT COUNT(*) FROM retrieval_traces')
        : 0,
      traceErrors: traceCoverage.filter((trace) => trace.errorCode !== null).length,
      nonFullQualityTraces: traceCoverage.filter(
        (trace) => trace.qualityState !== 'full',
      ).map((trace) => ({
        traceId: trace.traceId,
        qualityState: trace.qualityState,
      })),
      traceStageCounts,
      tracesWithAllDistinctStages: traceCoverage.filter(
        (trace) => trace.distinctStages === REQUIRED_TRACE_STAGES.length,
      ).length,
      tracesMissingStages: traceCoverage.filter(
        (trace) => trace.distinctStages !== REQUIRED_TRACE_STAGES.length,
      ),
      provider: {
        name: 'ollama',
        providerCalls,
        providerCallsByStage,
        observedModels: [...observedModels].sort(),
        observedModelsByStage: Object.fromEntries(
          Object.entries(observedModelsByStage).map(([stage, models]) => [
            stage,
            [...models].sort(),
          ]),
        ),
      },
      byPrincipal,
    };
  } finally {
    database.close();
  }
}

function directoryBytes(directory) {
  let total = 0;
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) total += fs.statSync(absolutePath).size;
    }
  };
  visit(directory);
  return total;
}

function runtimeRssSnapshot() {
  const roles = new Map([[process.pid, 'harness']]);
  if (workerRuntime?.child.pid) roles.set(workerRuntime.child.pid, 'worker');
  for (const connection of connections) {
    if (connection.transport.pid) {
      roles.set(connection.transport.pid, connection.label);
    }
  }
  const pids = [...roles.keys()];
  if (pids.length === 0) return { available: false, processes: [], totalBytes: 0 };
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'pid=,rss=', '-p', pids.join(',')],
      { encoding: 'utf8', timeout: 5_000 },
    );
    const processes = output.trim().split(/\r?\n/u).flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/u);
      if (!match) return [];
      const pid = Number(match[1]);
      return [{
        role: roles.get(pid) || 'unknown',
        pid,
        rssBytes: Number(match[2]) * 1_024,
      }];
    });
    return {
      available: processes.length > 0,
      processes,
      totalBytes: processes.reduce((sum, item) => sum + item.rssBytes, 0),
    };
  } catch {
    return { available: false, processes: [], totalBytes: 0 };
  }
}

function captureSystemSample(label) {
  const snapshot = databaseSnapshot(
    databasePath,
    connections.map((connection) => connection.principalId),
  );
  const sample = {
    at: new Date().toISOString(),
    label,
    calls: {
      completed: operations.filter((event) => event.event === 'mcp.call.completed').length,
      expectedErrors: operations.filter(
        (event) => event.event === 'mcp.call.expected_error',
      ).length,
      unexpectedErrors: operations.filter((event) => event.event === 'mcp.call.failed').length,
      latencyMs: latencySummary(operationLatencies()),
      recallLatencyMs: latencySummary(operationLatencies('memory_recall')),
      maximumGlobalInFlight,
    },
    quality: {
      recall: { ...recallCounters },
      crossTenant: { ...leakageCounters },
    },
    trace: {
      total: snapshot.retrievalTraces,
      errors: snapshot.traceErrors,
      stageCounts: snapshot.traceStageCounts,
      tracesWithAllDistinctStages: snapshot.tracesWithAllDistinctStages,
      missingStageTraceCount: snapshot.tracesMissingStages.length,
    },
    provider: snapshot.provider,
    queues: {
      outboxByStatus: snapshot.outboxByStatus,
      jobsByStatus: snapshot.jobsByStatus,
      openOutbox: snapshot.openOutbox,
      retryingJobs: snapshot.retryingJobs,
      deadJobs: snapshot.deadJobs,
      deadLetterJobs: snapshot.deadLetterJobs,
      quarantinedConsolidations: snapshot.quarantinedConsolidations,
    },
    sqlite: {
      integrity: snapshot.integrity,
      foreignKeyViolations: snapshot.foreignKeyViolations,
      journalMode: snapshot.journalMode,
    },
    resourceObservation: {
      observedOnly: true,
      releaseGate: false,
      limitation:
        'RSS、WAL 字节和磁盘字节是离散时点观测，不能单独证明不存在内存或磁盘泄漏。',
      databaseBytes: fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0,
      walBytes: fs.existsSync(`${databasePath}-wal`)
        ? fs.statSync(`${databasePath}-wal`).size
        : 0,
      rss: runtimeRssSnapshot(),
      diskBytes: directoryBytes(runRoot),
    },
  };
  fs.writeSync(sampleDescriptor, `${JSON.stringify(sample)}\n`);
  samples.push(sample);
  return sample;
}

const profileName = process.env.MEMORY_BRIDGE_QA_PROFILE || 'smoke';
const profileDefaults = PROFILE_DEFAULTS[profileName];
if (!profileDefaults) throw new Error('MEMORY_BRIDGE_QA_PROFILE 只支持 smoke 或 full');

const projectRoot = path.resolve(process.cwd());
const serverPath = path.resolve(
  process.env.MEMORY_BRIDGE_QA_MCP_SERVER ||
  path.join(projectRoot, 'dist', 'server', 'mcp-stdio.js'),
);
if (!fs.existsSync(serverPath)) throw new Error(`MCP 构建产物不存在：${serverPath}`);
const runId = createQaRunId();
const parentRoot = path.resolve(
  process.env.MEMORY_BRIDGE_QA_ROOT ||
  path.join(projectRoot, '.memory-bridge-private', 'system-simulation'),
);
const runRoot = createPrivateQaRunRoot(parentRoot, `mcp-${profileName}-${runId}-`);
const dataDir = path.join(runRoot, 'data');
const logsDir = path.join(runRoot, 'logs');
const receiptsDir = path.join(runRoot, 'receipts');
for (const directory of [dataDir, logsDir, receiptsDir]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}
const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
const operationsPath = path.join(logsDir, 'mcp-operations.jsonl');
const operationDescriptor = fs.openSync(operationsPath, 'wx', 0o600);
const samplesPath = path.join(logsDir, 'system-samples.jsonl');
const sampleDescriptor = fs.openSync(samplesPath, 'wx', 0o600);
let operationDescriptorClosed = false;
let sampleDescriptorClosed = false;
const ollamaUrl = process.env.MEMORY_BRIDGE_OLLAMA_URL || 'http://127.0.0.1:11434';
const requestedSemanticMode = process.env.MEMORY_BRIDGE_QA_SEMANTIC_MODE;
if (
  requestedSemanticMode !== undefined &&
  !['required', 'off'].includes(requestedSemanticMode)
) {
  throw new Error('MEMORY_BRIDGE_QA_SEMANTIC_MODE 只支持 required 或 off');
}
const semanticMode = requestedSemanticMode === 'off' ? 'off' : 'required';
const users = boundedInteger(
  'MEMORY_BRIDGE_QA_USERS',
  profileDefaults.users,
  2,
  32,
);
const memoriesPerUser = boundedInteger(
  'MEMORY_BRIDGE_QA_MEMORIES_PER_USER',
  profileDefaults.memoriesPerUser,
  3,
  1_000,
);
const concurrency = boundedInteger(
  'MEMORY_BRIDGE_QA_CONCURRENCY',
  profileDefaults.concurrency,
  1,
  16,
);
const soakSeconds = process.env.MEMORY_BRIDGE_QA_SOAK_SECONDS !== undefined
  ? boundedInteger(
      'MEMORY_BRIDGE_QA_SOAK_SECONDS',
      profileDefaults.soakSeconds,
      0,
      86_400,
    )
  : boundedInteger(
      'MEMORY_BRIDGE_QA_SOAK_MINUTES',
      Math.floor(profileDefaults.soakSeconds / 60),
      0,
      1_440,
    ) * 60;
const sampleIntervalSeconds = boundedInteger(
  'MEMORY_BRIDGE_QA_SAMPLE_INTERVAL_SECONDS',
  profileDefaults.sampleIntervalSeconds,
  1,
  3_600,
);
if (profileName === 'full') {
  const exact = PROFILE_DEFAULTS.full;
  if (
    users !== exact.users ||
    memoriesPerUser !== exact.memoriesPerUser ||
    concurrency !== exact.concurrency ||
    soakSeconds !== exact.soakSeconds
  ) {
    throw new Error(
      'full profile 固定为 8 用户 × 每用户 75 条、全局并发 4、稳态 1800 秒，禁止覆盖',
    );
  }
  if (semanticMode !== 'required') {
    throw new Error(
      'full profile 固定使用 semantic mode=required，禁止关闭或降级真实 provider',
    );
  }
}
const requestedRecallP95LimitMs = boundedInteger(
  'MEMORY_BRIDGE_QA_RECALL_P95_LIMIT_MS',
  profileName === 'full' ? 1_500 : 2_500,
  1,
  600_000,
);
if (profileName === 'full' && requestedRecallP95LimitMs > 1_500) {
  throw new Error(
    'full profile 可靠召回 P95 发布门槛固定不高于 1500ms，禁止调高或关闭',
  );
}
const recallP95LimitMs = requestedRecallP95LimitMs;
const profileGates = Object.freeze({
  source: profileName === 'full'
    ? 'full-release-contract-v1'
    : 'smoke-development-config',
  workload: {
    users,
    memoriesPerUser,
    concurrency,
    soakSeconds,
    stdioProcesses: users,
    immutable: profileName === 'full',
  },
  semantic: {
    mode: semanticMode,
    queryRewriteMode: 'llm',
    queryUnderstandingMode: 'auto',
    realProviderRequired: profileName === 'full',
    degradedAllowed: false,
  },
  reliableRecallP95: {
    effectiveLimitMs: recallP95LimitMs,
    fullReleaseMaximumMs: 1_500,
    environmentMayRaise: false,
  },
});
const namespaceBase = `qa-system-${runId}`;
const startedAt = new Date().toISOString();
const operations = [];
const checks = [];
const connections = [];
const samples = [];
const retrievalTraceIds = new Set();
const recallCounters = { attempted: 0, hit: 0 };
const leakageCounters = { attempted: 0, leaked: 0 };
const stderrBytesByPrincipal = new Map();
let credentials = [];
let workerRuntime = null;
let globalInFlight = 0;
let maximumGlobalInFlight = 0;
let stderrCredentialLeakDetected = false;

console.log(`[qa] 保留目录：${runRoot}`);

function appendOperation(event) {
  const safe = { at: new Date().toISOString(), ...event };
  if (!operationDescriptorClosed) {
    fs.writeSync(operationDescriptor, `${JSON.stringify(safe)}\n`);
  }
  operations.push(safe);
}

function recordCheck(id, passed, details = {}) {
  checks.push({ id, ...details, passed: Boolean(passed) });
  console.log(`[check] ${passed ? 'PASS' : 'FAIL'} ${id}`);
}

async function provisionCredentials() {
  const [{ openDatabase }, { IdentityService }] = await Promise.all([
    import('../dist/server/database.js'),
    import('../dist/server/identity.js'),
  ]);
  const database = openDatabase(databasePath);
  try {
    const firstPrincipalId = `qa-principal-${runId}-00`;
    const identity = new IdentityService(database, {
      defaultPrincipalId: firstPrincipalId,
    });
    const first = identity.initializeFirstAccount({
      principalId: firstPrincipalId,
      displayName: 'System QA user-00',
      label: 'system-qa-mcp-00',
    });
    const issued = [{
      principalId: first.principal.id,
      token: first.token,
      credentialId: first.credential.id,
    }];
    for (let index = 1; index < users; index += 1) {
      const principalId = `qa-principal-${runId}-${String(index).padStart(2, '0')}`;
      identity.createPrincipal({
        id: principalId,
        displayName: `System QA user-${String(index).padStart(2, '0')}`,
      });
      const credential = identity.issueCredential({
        principalId,
        label: `system-qa-mcp-${String(index).padStart(2, '0')}`,
      });
      issued.push({
        principalId,
        token: credential.token,
        credentialId: credential.credential.id,
      });
    }
    return issued;
  } finally {
    database.close();
  }
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startWorkerRuntime() {
  const port = await availablePort();
  const child = spawn(process.execPath, [path.join(projectRoot, 'dist', 'server', 'index.js')], {
    cwd: projectRoot,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MEMORY_BRIDGE_HOST: '127.0.0.1',
      MEMORY_BRIDGE_PORT: String(port),
      MEMORY_BRIDGE_DATA_DIR: dataDir,
      MEMORY_BRIDGE_USER_ID: `qa-worker-${runId}`,
      MEMORY_BRIDGE_NAMESPACE: `${namespaceBase}-worker`,
      MEMORY_BRIDGE_SEMANTIC_MODE: semanticMode,
      MEMORY_BRIDGE_OLLAMA_URL: ollamaUrl,
      MEMORY_BRIDGE_AIRI_CHAT_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_EMBED_MODEL: EMBEDDING_MODEL,
      MEMORY_BRIDGE_QUERY_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_RERANK_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_QUERY_REWRITE_MODE: 'llm',
      MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE: 'auto',
      MEMORY_BRIDGE_EXTRACTION_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_RELATION_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_CONSOLIDATION_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_AUTOMATION_MODE: 'shadow',
      MEMORY_BRIDGE_WORKER_POLL_MS: '100',
      MEMORY_BRIDGE_CONSOLIDATION_IDLE_MINUTES: '1',
      MEMORY_BRIDGE_RETRIEVAL_JSONL: 'off',
    },
  });
  const runtime = { child, port, stdoutBytes: 0, stderrBytes: 0, stopped: false };
  const started = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('后台 Worker 启动超时')), 30_000);
    child.stdout.on('data', (chunk) => {
      runtime.stdoutBytes += Buffer.byteLength(chunk);
      output = `${output}${String(chunk)}`.slice(-8_192);
      if (output.includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.stderr.on('data', (chunk) => {
      runtime.stderrBytes += Buffer.byteLength(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (!runtime.stopped) {
        clearTimeout(timer);
        reject(new Error(`后台 Worker 提前退出 code=${String(code)} signal=${String(signal)}`));
      }
    });
  });
  assert.equal(started, true);
  appendOperation({ event: 'worker.started', port });
  return runtime;
}

async function stopWorkerRuntime(runtime) {
  if (!runtime || runtime.stopped) return;
  runtime.stopped = true;
  const exited = new Promise((resolve) => runtime.child.once('exit', resolve));
  runtime.child.kill('SIGTERM');
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000));
  if (await Promise.race([exited, timeout]) === 'timeout') {
    runtime.child.kill('SIGKILL');
    await exited;
  }
  appendOperation({
    event: 'worker.stopped',
    stdoutBytes: runtime.stdoutBytes,
    stderrBytes: runtime.stderrBytes,
  });
}

async function waitForWorkerIdle(maximumMs = 180_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    let openOutbox;
    let dueJobs;
    try {
      openOutbox = scalar(
        database,
        `SELECT COUNT(*) FROM outbox_events
         WHERE status IN ('pending', 'processing', 'failed')`,
      );
      dueJobs = scalar(
        database,
        `SELECT COUNT(*) FROM memory_jobs
         WHERE status IN ('running', 'failed', 'dead')
            OR (
              status = 'pending'
              AND julianday(available_at) <= julianday('now')
              ${semanticMode === 'off' ? "AND job_type != 'index_memory'" : ''}
            )`,
      );
    } finally {
      database.close();
    }
    if (openOutbox === 0 && dueJobs === 0) return { openOutbox, dueJobs };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('后台 Worker 队列未在 180 秒内收敛');
}

function createConnection(index) {
  const label = `user-${String(index).padStart(2, '0')}`;
  const credential = credentials[index];
  if (!credential) throw new Error(`缺少 ${label} 的测试凭据`);
  const principalId = credential.principalId;
  const client = new Client({
    name: `memory-bridge-system-qa-${label}`,
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH || '',
      MEMORY_BRIDGE_DATA_DIR: dataDir,
      MEMORY_BRIDGE_USER_ID: `conflicting-startup-${label}`,
      MEMORY_BRIDGE_MCP_TOKEN: credential.token,
      MEMORY_BRIDGE_NAMESPACE: `${namespaceBase}-role-a`,
      MEMORY_BRIDGE_SEMANTIC_MODE: semanticMode,
      MEMORY_BRIDGE_OLLAMA_URL: ollamaUrl,
      MEMORY_BRIDGE_AIRI_CHAT_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_EMBED_MODEL: EMBEDDING_MODEL,
      MEMORY_BRIDGE_QUERY_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_RERANK_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_QUERY_REWRITE_MODE: 'llm',
      MEMORY_BRIDGE_QUERY_UNDERSTANDING_MODE: 'auto',
      MEMORY_BRIDGE_EXTRACTION_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_RELATION_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_CONSOLIDATION_MODEL: CHAT_MODEL,
      MEMORY_BRIDGE_RETRIEVAL_LOG_MODE: 'metadata',
      MEMORY_BRIDGE_RETRIEVAL_JSONL: 'on',
      MEMORY_BRIDGE_RETRIEVAL_JSONL_PATH: path.join(logsDir, `${label}-retrieval.jsonl`),
    },
    stderr: 'pipe',
  });
  const connection = {
    index,
    label,
    principalId,
    credentialId: credential.credentialId,
    client,
    transport,
    stderrBytes: 0,
    stderrCredentialLeak: false,
    stderrTail: '',
    inFlight: 0,
    maximumInFlight: 0,
    connectedAt: null,
  };
  transport.stderr?.on('data', (chunk) => {
    const text = `${connection.stderrTail}${String(chunk)}`;
    const chunkBytes = Buffer.byteLength(chunk);
    connection.stderrBytes += chunkBytes;
    stderrBytesByPrincipal.set(
      connection.label,
      (stderrBytesByPrincipal.get(connection.label) || 0) + chunkBytes,
    );
    if (text.includes(credential.token)) {
      connection.stderrCredentialLeak = true;
      stderrCredentialLeakDetected = true;
    }
    connection.stderrTail = text.slice(-512);
  });
  return connection;
}

async function callMcp(connection, tool, args, phase) {
  assert.equal(
    connection.inFlight,
    0,
    `${connection.label} 同一 stdio 连接不允许多个在途调用`,
  );
  const callId = randomUUID();
  const before = Date.now();
  connection.inFlight += 1;
  connection.maximumInFlight = Math.max(
    connection.maximumInFlight,
    connection.inFlight,
  );
  globalInFlight += 1;
  maximumGlobalInFlight = Math.max(maximumGlobalInFlight, globalInFlight);
  assert.ok(globalInFlight <= concurrency, 'MCP 全局在途数超过并发门槛');
  appendOperation({
    event: 'mcp.call.started',
    callId,
    principal: connection.label,
    tool,
    phase,
  });
  try {
    const result = await connection.client.callTool({ name: tool, arguments: args });
    const text = result.content.find((item) => item.type === 'text');
    assert.ok(text && text.type === 'text', `${tool} 缺少文本响应`);
    if (result.isError === true) throw new Error(`${tool} 返回非预期 MCP error`);
    const parsed = JSON.parse(text.text);
    const traceId = String(
      result._meta?.retrievalTraceId || parsed?.traceId || '',
    );
    if (/^[0-9a-f-]{36}$/u.test(traceId)) retrievalTraceIds.add(traceId);
    if (parsed && typeof parsed === 'object') {
      Object.defineProperty(parsed, MCP_META, {
        value: result._meta || result.structuredContent || {},
        enumerable: false,
      });
    }
    const durationMs = Date.now() - before;
    appendOperation({
      event: 'mcp.call.completed',
      callId,
      principal: connection.label,
      tool,
      phase,
      durationMs,
      resultCount: Array.isArray(parsed)
        ? parsed.length
        : Array.isArray(parsed?.items)
          ? parsed.items.length
          : Array.isArray(parsed?.memories)
            ? parsed.memories.length
            : null,
    });
    return parsed;
  } catch (error) {
    appendOperation({
      event: 'mcp.call.failed',
      callId,
      principal: connection.label,
      tool,
      phase,
      durationMs: Date.now() - before,
      error: safeError(error),
    });
    throw error;
  } finally {
    connection.inFlight -= 1;
    globalInFlight -= 1;
  }
}

function stableMcpErrorCode(result, error) {
  const candidates = [
    result?._meta?.errorCode,
    result?.structuredContent?.errorCode,
    error && typeof error === 'object' ? error.code : null,
  ];
  for (const candidate of candidates) {
    if (Number.isInteger(candidate)) return String(candidate);
    if (
      typeof candidate === 'string' &&
      /^[A-Z][A-Z0-9_.-]{1,63}$/u.test(candidate)
    ) return candidate;
  }
  return null;
}

async function callMcpExpectError(connection, tool, args, phase) {
  assert.equal(
    connection.inFlight,
    0,
    `${connection.label} 同一 stdio 连接不允许多个在途调用`,
  );
  const callId = randomUUID();
  const before = Date.now();
  connection.inFlight += 1;
  connection.maximumInFlight = Math.max(
    connection.maximumInFlight,
    connection.inFlight,
  );
  globalInFlight += 1;
  maximumGlobalInFlight = Math.max(maximumGlobalInFlight, globalInFlight);
  assert.ok(globalInFlight <= concurrency, 'MCP 全局在途数超过并发门槛');
  appendOperation({
    event: 'mcp.call.started',
    callId,
    principal: connection.label,
    tool,
    phase,
    expectedError: true,
  });
  try {
    let errorText = '';
    let result = null;
    let thrownError = null;
    try {
      result = await connection.client.callTool({ name: tool, arguments: args });
    } catch (error) {
      thrownError = error;
      errorText = error instanceof Error ? error.message : String(error);
    }
    if (result) {
      const text = result.content.find((item) => item.type === 'text');
      assert.equal(result.isError, true, `${tool} 应拒绝跨账户 UUID`);
      assert.ok(
        text && text.type === 'text' && text.text.trim(),
        `${tool} 预期错误响应不得为空`,
      );
      errorText = text.text;
    }
    assert.ok(result || thrownError, `${tool} 未返回也未抛出预期错误`);
    assert.ok(errorText.trim(), `${tool} 预期错误消息不得为空`);
    const fingerprint = createHash('sha256').update(errorText).digest('hex');
    const errorCode = stableMcpErrorCode(result, thrownError);
    appendOperation({
      event: 'mcp.call.expected_error',
      callId,
      principal: connection.label,
      tool,
      phase,
      durationMs: Date.now() - before,
      errorFingerprint: fingerprint,
      errorCode,
      comparisonEvidence: errorCode ? 'stable-code' : 'message-sha256-fallback',
    });
    return { fingerprint, errorCode, observed: true };
  } finally {
    connection.inFlight -= 1;
    globalInFlight -= 1;
  }
}

function roleNamespace(memoryIndex) {
  return `${namespaceBase}-role-${memoryIndex % 2 === 0 ? 'a' : 'b'}`;
}

function marker(connection, memoryIndex) {
  return `MBQA-${runId}-${connection.label}-M${String(memoryIndex).padStart(4, '0')}`;
}

function memoryClass(memoryIndex) {
  return memoryIndex % 2 === 0 ? 'exact' : 'semantic';
}

function semanticLabel(connection, memoryIndex) {
  return `晨岚${String(memoryIndex).padStart(3, '0')}-${connection.label}`;
}

function rememberInput(connection, memoryIndex) {
  const type = memoryClass(memoryIndex);
  const token = marker(connection, memoryIndex);
  const label = semanticLabel(connection, memoryIndex);
  return {
    namespace: roleNamespace(memoryIndex),
    kind: memoryIndex % 3 === 0 ? 'preference' : memoryIndex % 3 === 1 ? 'knowledge' : 'event',
    title: type === 'exact' ? token : `${label} 出行偏好`,
    content: type === 'exact'
      ? `系统仿真精确记忆 ${token}：该用户在第 ${memoryIndex} 个场景选择方案 ${memoryIndex % 7}。`
      : `系统仿真语义记忆：在 ${label} 周末行程中，用户更愿意先乘坐慢速渡轮，再到安静的旧书店停留。`,
    tags: ['system-qa', connection.label, type, `slot-${memoryIndex % 7}`],
    importance: 0.7,
    confidence: 1,
    source: 'mcp-system-qa',
    idempotencyKey: `${runId}:${connection.label}:memory:${memoryIndex}`,
  };
}

function recallQuery(connection, memoryIndex) {
  return memoryClass(memoryIndex) === 'exact'
    ? `请查找唯一标识 ${marker(connection, memoryIndex)}`
    : `${semanticLabel(connection, memoryIndex)} 行程出发时偏爱哪种交通方式？`;
}

function recallContainsId(result, memoryId) {
  return Array.isArray(result) && result.some(
    (item) => item?.memory?.id === memoryId,
  );
}

async function reconnectAll() {
  await Promise.allSettled(connections.map((connection) => connection.client.close()));
  const replacements = connections.map((connection) => createConnection(connection.index));
  await Promise.all(replacements.map(async (connection) => {
    await connection.client.connect(connection.transport);
    connection.connectedAt = new Date().toISOString();
  }));
  connections.splice(0, connections.length, ...replacements);
  return replacements;
}

function operationLatencies(tool) {
  return operations
    .filter((event) => event.event === 'mcp.call.completed' && (!tool || event.tool === tool))
    .map((event) => event.durationMs);
}

function regularFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`QA 保留目录不允许符号链接：${absolutePath}`);
      }
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  };
  visit(directory);
  return files.sort();
}

function makePrivateTree(directory) {
  const visit = (current) => {
    fs.chmodSync(current, 0o700);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`QA 保留目录不允许符号链接：${absolutePath}`);
      }
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) fs.chmodSync(absolutePath, 0o600);
    }
  };
  visit(directory);
}

function scanPrivateArtifacts(plannedReportText = '') {
  const rawTokenHits = [];
  for (const filePath of regularFiles(runRoot)) {
    const bytes = fs.readFileSync(filePath);
    for (const credential of credentials) {
      if (bytes.indexOf(Buffer.from(credential.token)) !== -1) {
        rawTokenHits.push(path.relative(runRoot, filePath));
        break;
      }
    }
  }

  const secretPatterns = [
    ['bearer', /\bBearer\s+(?!\[REDACTED\])[^\s"']{8,}/giu],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
    [
      'json-secret-value',
      /"(?:token|secret|password|api[_-]?key)"\s*:\s*"(?!\[REDACTED\])[^"\r\n]{4,}"/giu,
    ],
  ];
  const bodyPatterns = [
    '系统仿真精确记忆',
    '系统仿真语义记忆',
    '系统仿真修正后的唯一事实',
    '青杉计划的交付暗号是',
    '云雀计划的交付暗号是',
  ];
  const textArtifacts = regularFiles(runRoot)
    .filter((filePath) => {
      const relative = path.relative(runRoot, filePath);
      return relative.startsWith(`logs${path.sep}`) ||
        relative.startsWith(`receipts${path.sep}`);
    })
    .map((filePath) => ({
      label: path.relative(runRoot, filePath),
      text: fs.readFileSync(filePath, 'utf8'),
    }));
  if (plannedReportText) {
    textArtifacts.push({ label: 'receipts/system-report.json(planned)', text: plannedReportText });
  }
  const secretPatternHits = [];
  const rawBodyHits = [];
  for (const artifact of textArtifacts) {
    for (const [name, pattern] of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(artifact.text)) {
        secretPatternHits.push({ file: artifact.label, pattern: name });
      }
    }
    for (const bodyPattern of bodyPatterns) {
      if (artifact.text.includes(bodyPattern)) {
        rawBodyHits.push({ file: artifact.label, pattern: bodyPattern });
      }
    }
  }
  return {
    passed:
      rawTokenHits.length === 0 &&
      secretPatternHits.length === 0 &&
      rawBodyHits.length === 0 &&
      !stderrCredentialLeakDetected,
    rawTokenHits,
    secretPatternHits,
    rawBodyHits,
    stderrCredentialLeakDetected,
  };
}

function evidenceInventory(excluded = new Set()) {
  return Object.fromEntries(regularFiles(runRoot).flatMap((filePath) => {
    const relativePath = path.relative(runRoot, filePath).split(path.sep).join('/');
    if (excluded.has(relativePath)) return [];
    const stat = fs.statSync(filePath);
    return [[relativePath, {
      path: filePath,
      bytes: stat.size,
      mode: (stat.mode & 0o777).toString(8).padStart(3, '0'),
      sha256: fileSha256(filePath),
    }]];
  }));
}

async function run() {
  const modelPreflight = semanticMode === 'required'
    ? await ollamaPreflight(ollamaUrl)
    : { skipped: true, reason: 'semantic mode off test profile' };
  const implementation = buildQaImplementationEvidence({
    projectRoot,
    schemaVersion: 31,
    relativeFiles: [
      'package-lock.json',
      'scripts/qa-mcp-system-simulation.mjs',
      'scripts/qa-mcp-system-simulation-gates.mjs',
      'src/server/mcp-stdio.ts',
      'src/server/mcp-server.ts',
    ],
    runtimeDirectories: ['dist/server'],
  });
  const manifest = {
    format: 'memory-bridge-mcp-system-manifest:v1',
    runId,
    startedAt,
    profile: profileName,
    isolated: true,
    preserved: true,
    paths: { runRoot, dataDir, logsDir, receiptsDir, databasePath },
    workload: {
      users,
      memoriesPerUser,
      concurrency,
      soakSeconds,
      sampleIntervalSeconds,
      stdioProcesses: users,
      perConnectionMaximumInFlight: 1,
    },
    profileGates,
    runtime: {
      nodeVersion: process.version,
      semanticMode,
      chatModel: CHAT_MODEL,
      embeddingModel: EMBEDDING_MODEL,
      serverPath,
    },
    modelPreflight,
    implementation,
  };
  const manifestPath = path.join(receiptsDir, 'run-manifest.json');
  writeImmutableQaFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  credentials = await provisionCredentials();
  recordCheck('credential-provisioning', credentials.length === users, {
    principals: credentials.map((credential) => credential.principalId),
    tokenValuesPersisted: false,
  });
  for (let index = 0; index < users; index += 1) {
    connections.push(createConnection(index));
  }
  const coldBarrierStartedAt = Date.now();
  await Promise.all(connections.map(async (connection) => {
    await connection.client.connect(connection.transport);
    connection.connectedAt = new Date().toISOString();
  }));
  const coldBarrierDurationMs = Date.now() - coldBarrierStartedAt;
  recordCheck('cold-start-barrier',
    connections.length === users &&
    new Set(connections.map((connection) => connection.transport.pid)).size === users,
    {
      stdioProcesses: connections.length,
      uniquePids: new Set(
        connections.map((connection) => connection.transport.pid),
      ).size,
      durationMs: coldBarrierDurationMs,
    },
  );
  await mapLimit(connections, concurrency, async (connection) => {
    const tools = await connection.client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    recordCheck(
      `${connection.label}.tools`,
      JSON.stringify(names) === JSON.stringify(REQUIRED_TOOLS),
      { tools: names },
    );
  });
  workerRuntime = await startWorkerRuntime();
  captureSystemSample('cold-start-complete');

  const remembered = [];
  for (let memoryIndex = 0; memoryIndex < memoriesPerUser; memoryIndex += 1) {
    const round = await mapLimit(connections, concurrency, async (connection) => {
      const input = rememberInput(connection, memoryIndex);
      const result = await callMcp(connection, 'memory_remember', input, 'bulk-write');
      assert.equal(result.memory.userId, connection.principalId);
      return { connectionIndex: connection.index, memoryIndex, id: result.memory.id };
    });
    remembered.push(...round);
  }
  const rememberedByKey = new Map(remembered.map((item) => [
    `${item.connectionIndex}:${item.memoryIndex}`,
    item.id,
  ]));
  recordCheck('bulk-write.count', remembered.length === users * memoriesPerUser, {
    expected: users * memoriesPerUser,
    actual: remembered.length,
  });

  const replayConnection = connections[0];
  const replayIndex = 0;
  const replayInput = rememberInput(replayConnection, replayIndex);
  const replayResults = [
    await callMcp(replayConnection, 'memory_remember', replayInput, 'idempotency-replay'),
    await callMcp(replayConnection, 'memory_remember', replayInput, 'idempotency-replay'),
  ];
  const originalReplayId = rememberedByKey.get(`${replayConnection.index}:${replayIndex}`);
  recordCheck(
    'sequential-idempotency',
    replayResults.every((result) => result.memory.id === originalReplayId),
    { returnedSameId: replayResults.map((result) => result.memory.id === originalReplayId) },
  );

  await waitForWorkerIdle(profileName === 'full' ? 600_000 : 180_000);
  await callMcp(connections[0], 'memory_recall', {
    namespace: roleNamespace(0),
    query: marker(connections[0], 0),
    minScore: 0,
  }, 'warmup');

  const probeIndexes = [...new Set([
    0,
    Math.min(1, memoriesPerUser - 1),
    Math.floor(memoriesPerUser / 2),
    memoriesPerUser - 1,
  ])];
  const recallChecks = [];
  for (const memoryIndex of probeIndexes) {
    const round = await mapLimit(connections, concurrency, async (connection) => {
      const memoryId = rememberedByKey.get(`${connection.index}:${memoryIndex}`);
      const result = await callMcp(connection, 'memory_recall', {
        namespace: roleNamespace(memoryIndex),
        query: recallQuery(connection, memoryIndex),
        minScore: 0,
        limit: 5,
      }, 'positive-recall');
      const hit = recallContainsId(result, memoryId);
      recallCounters.attempted += 1;
      if (hit) recallCounters.hit += 1;
      return {
        principal: connection.label,
        memoryIndex,
        type: memoryClass(memoryIndex),
        hit,
      };
    });
    recallChecks.push(...round);
  }
  recordCheck('positive-recall', recallChecks.every((item) => item.hit), {
    probes: recallChecks.length,
    passedProbes: recallChecks.filter((item) => item.hit).length,
    byType: Object.fromEntries(['exact', 'semantic'].map((type) => [
      type,
      {
        probes: recallChecks.filter((item) => item.type === type).length,
        hits: recallChecks.filter((item) => item.type === type && item.hit).length,
      },
    ])),
    failedProbes: recallChecks.filter((item) => !item.hit),
  });

  const contextChecks = await mapLimit(connections, concurrency, async (connection) => {
    const memoryId = rememberedByKey.get(`${connection.index}:0`);
    const result = await callMcp(connection, 'memory_get_context', {
      namespace: roleNamespace(0),
      query: recallQuery(connection, 0),
      minScore: 0,
      limit: 5,
    }, 'positive-context');
    return result.memories.some((item) => item.memory.id === memoryId);
  });
  recordCheck('positive-context', contextChecks.every(Boolean), {
    probes: contextChecks.length,
    hits: contextChecks.filter(Boolean).length,
  });

  const attacker = connections[0];
  const foreignOwner = connections[1];
  const foreignId = rememberedByKey.get('1:0');
  const absentId = '00000000-0000-4000-8000-000000000000';
  const crossToken = marker(foreignOwner, 0);
  const crossGet = await callMcp(attacker, 'memory_get_context', {
    namespace: roleNamespace(0),
    query: foreignId,
    minScore: 0,
  }, 'cross-principal-get');
  const crossRecall = await callMcp(attacker, 'memory_recall', {
    namespace: roleNamespace(0),
    query: foreignId,
    minScore: 0,
  }, 'cross-principal-recall');
  const crossList = await callMcp(attacker, 'memory_list', {
    namespace: roleNamespace(0),
    query: foreignId,
    limit: 20,
    offset: 0,
  }, 'cross-principal-list');
  const foreignUpdate = await callMcpExpectError(attacker, 'memory_update', {
    id: foreignId,
    content: '跨账户 UUID 更新必须失败。',
  }, 'cross-principal-update');
  const absentUpdate = await callMcpExpectError(attacker, 'memory_update', {
    id: absentId,
    content: '不存在 UUID 更新必须同样失败。',
  }, 'absent-update');
  const foreignForget = await callMcpExpectError(attacker, 'memory_forget', {
    id: foreignId,
    reason: '跨账户 UUID 遗忘必须失败',
  }, 'cross-principal-forget');
  const absentForget = await callMcpExpectError(attacker, 'memory_forget', {
    id: absentId,
    reason: '不存在 UUID 遗忘必须同样失败',
  }, 'absent-forget');
  const foreignOwnerAfter = await callMcp(foreignOwner, 'memory_list', {
    namespace: roleNamespace(0),
    query: crossToken,
    limit: 20,
    offset: 0,
  }, 'cross-principal-owner-verify');
  const updateErrorComparison = compareExpectedErrorEvidence(
    foreignUpdate,
    absentUpdate,
  );
  const forgetErrorComparison = compareExpectedErrorEvidence(
    foreignForget,
    absentForget,
  );
  const crossPrincipalChecks = {
    get: !crossGet.memories.some((item) => item.memory.id === foreignId),
    recall: !recallContainsId(crossRecall, foreignId),
    list: !crossList.items.some((item) => item.id === foreignId),
    update: updateErrorComparison.passed,
    forget: forgetErrorComparison.passed,
    ownerUnchanged: foreignOwnerAfter.items.some(
      (item) => item.id === foreignId && item.status === 'active',
    ),
  };
  leakageCounters.attempted += 5;
  leakageCounters.leaked += Object.entries(crossPrincipalChecks)
    .filter(([key, passed]) => key !== 'ownerUnchanged' && !passed).length;
  recordCheck('cross-principal-uuid-zero-leakage',
    Object.values(crossPrincipalChecks).every(Boolean),
    {
      ...crossPrincipalChecks,
      expectedErrorComparison: {
        update: updateErrorComparison,
        forget: forgetErrorComparison,
      },
    },
  );

  const otherNamespaceIndex = 1;
  const otherNamespaceToken = marker(connections[0], otherNamespaceIndex);
  const crossNamespace = await callMcp(connections[0], 'memory_get_context', {
    namespace: roleNamespace(0),
    query: `请查找唯一标识 ${otherNamespaceToken}`,
    minScore: 0,
  }, 'cross-namespace');
  recordCheck(
    'cross-namespace-zero-leakage',
    !crossNamespace.context.includes(otherNamespaceToken),
    { returnedMemories: crossNamespace.memories.length },
  );

  const updatedIndex = Math.min(2, memoriesPerUser - 1);
  const updatedId = rememberedByKey.get(`0:${updatedIndex}`);
  const oldToken = marker(connections[0], updatedIndex);
  const newToken = `MBQA-CORRECTED-${runId}-user-00`;
  await callMcp(connections[0], 'memory_update', {
    id: updatedId,
    title: newToken,
    content: `系统仿真修正后的唯一事实为 ${newToken}，旧版本已经作废。`,
  }, 'correction');
  await waitForWorkerIdle();
  const corrected = await callMcp(connections[0], 'memory_recall', {
    namespace: roleNamespace(updatedIndex),
    query: `修正后的唯一事实 ${newToken}`,
    minScore: 0,
  }, 'correction-recall');
  const correctedList = await callMcp(connections[0], 'memory_list', {
    namespace: roleNamespace(updatedIndex),
    limit: 200,
    offset: 0,
  }, 'correction-current-version');
  const oldRecall = await callMcp(connections[0], 'memory_recall', {
    namespace: roleNamespace(updatedIndex),
    query: oldToken,
    minScore: 0,
  }, 'correction-old-version');
  const currentUpdated = correctedList.items.find((item) => item.id === updatedId);
  const oldQueryTargetResults = oldRecall.filter(
    (item) => item?.memory?.id === updatedId,
  );
  const correctedChecks = {
    newVersionRecalled: recallContainsId(corrected, updatedId),
    currentValueUpdated:
      currentUpdated?.title === newToken &&
      currentUpdated?.content.includes(newToken) &&
      !currentUpdated?.content.includes(oldToken),
    oldValueNeverSurfacedAsCurrent: oldQueryTargetResults.every(
      (item) =>
        item.memory.title === newToken &&
        item.memory.content.includes(newToken) &&
        !item.memory.content.includes(oldToken),
    ),
  };
  recallCounters.attempted += 1;
  recallCounters.hit += correctedChecks.newVersionRecalled ? 1 : 0;
  recordCheck('correction-version-semantics',
    Object.values(correctedChecks).every(Boolean),
    correctedChecks,
  );

  const forgottenIndex = Math.min(2, memoriesPerUser - 1);
  const forgottenConnection = connections[1];
  const forgottenId = rememberedByKey.get(`1:${forgottenIndex}`);
  const forgottenToken = marker(forgottenConnection, forgottenIndex);
  await callMcp(forgottenConnection, 'memory_forget', {
    id: forgottenId,
    reason: '系统仿真遗忘验证',
  }, 'forget');
  const forgotten = await callMcp(forgottenConnection, 'memory_recall', {
    namespace: roleNamespace(forgottenIndex),
    query: forgottenToken,
    minScore: 0,
  }, 'forget-recall');
  const deletedList = await callMcp(forgottenConnection, 'memory_list', {
    namespace: roleNamespace(forgottenIndex),
    status: 'deleted',
    limit: 200,
    offset: 0,
  }, 'forget-tombstone-list');
  const forgotChecks = {
    immediatelyNotRecalled: !recallContainsId(forgotten, forgottenId),
    tombstoneVisible: deletedList.items.some(
      (item) => item.id === forgottenId && item.status === 'deleted',
    ),
  };
  recordCheck('forgotten-immediate-tombstone',
    Object.values(forgotChecks).every(Boolean),
    forgotChecks,
  );

  const disambiguationConnection = connections[0];
  const disambiguationA = await callMcp(disambiguationConnection, 'memory_remember', {
    namespace: `${namespaceBase}-recent-turns`,
    kind: 'knowledge',
    content: `青杉计划的交付暗号是 ${marker(disambiguationConnection, 0)}-PINE。`,
    idempotencyKey: `${runId}:recent-turns:pine`,
  }, 'recent-turns-seed');
  await callMcp(disambiguationConnection, 'memory_remember', {
    namespace: `${namespaceBase}-recent-turns`,
    kind: 'knowledge',
    content: `云雀计划的交付暗号是 ${marker(disambiguationConnection, 0)}-LARK。`,
    idempotencyKey: `${runId}:recent-turns:lark`,
  }, 'recent-turns-seed');
  const disambiguated = await callMcp(disambiguationConnection, 'memory_get_context', {
    namespace: `${namespaceBase}-recent-turns`,
    query: '它的交付暗号是什么？',
    recentTurns: [
      { role: 'user', content: '我们现在继续讨论青杉计划。' },
      { role: 'assistant', content: '好的，继续讨论青杉计划。' },
    ],
    minScore: 0,
  }, 'recent-turns-disambiguation');
  recordCheck(
    'recent-turns-disambiguation',
    disambiguated.memories.some((item) => item.memory.id === disambiguationA.memory.id),
    { returnedMemories: disambiguated.memories.length },
  );

  await reconnectAll();
  const restartChecks = await mapLimit(connections, concurrency, async (connection) => {
    const memoryId = rememberedByKey.get(`${connection.index}:0`);
    const result = await callMcp(connection, 'memory_recall', {
      namespace: roleNamespace(0),
      query: recallQuery(connection, 0),
      minScore: 0,
    }, 'restart-persistence');
    const hit = recallContainsId(result, memoryId);
    recallCounters.attempted += 1;
    if (hit) recallCounters.hit += 1;
    return { principal: connection.label, hit };
  });
  const updatedAfterRestart = await callMcp(connections[0], 'memory_recall', {
    namespace: roleNamespace(updatedIndex),
    query: newToken,
    minScore: 0,
  }, 'restart-updated-version');
  const forgottenAfterRestart = await callMcp(connections[1], 'memory_recall', {
    namespace: roleNamespace(forgottenIndex),
    query: forgottenToken,
    minScore: 0,
  }, 'restart-forgotten-version');
  const restartSemantics = {
    eachPrincipalPersisted: restartChecks.every((item) => item.hit),
    updatedVersionPersisted: recallContainsId(updatedAfterRestart, updatedId),
    forgottenVersionNotResurrected: !recallContainsId(forgottenAfterRestart, forgottenId),
  };
  recallCounters.attempted += 1;
  recallCounters.hit += restartSemantics.updatedVersionPersisted ? 1 : 0;
  recordCheck('restart-persistence',
    Object.values(restartSemantics).every(Boolean),
    restartSemantics,
  );

  const soakStarted = Date.now();
  const soakDeadline = soakStarted + soakSeconds * 1_000;
  let nextSampleAt = soakStarted;
  let soakRound = 0;
  while (Date.now() < soakDeadline) {
    const currentConnections = [...connections];
    await mapLimit(currentConnections, concurrency, async (connection) => {
      const selector = (soakRound + connection.index) % 8;
      let memoryIndex = (soakRound * 7 + connection.index) % memoriesPerUser;
      if (
        (connection.index === 0 && memoryIndex === updatedIndex) ||
        (connection.index === 1 && memoryIndex === forgottenIndex)
      ) memoryIndex = 0;
      if (selector < 4 || selector === 7) {
        const memoryId = rememberedByKey.get(`${connection.index}:${memoryIndex}`);
        const result = await callMcp(connection, 'memory_recall', {
          namespace: roleNamespace(memoryIndex),
          query: recallQuery(connection, memoryIndex),
          minScore: 0,
        }, 'soak-recall');
        const hit = recallContainsId(result, memoryId);
        recallCounters.attempted += 1;
        if (hit) recallCounters.hit += 1;
        assert.ok(hit, 'soak recall 未命中目标');
      } else if (selector === 4) {
        const memoryId = rememberedByKey.get(`${connection.index}:${memoryIndex}`);
        const result = await callMcp(connection, 'memory_get_context', {
          namespace: roleNamespace(memoryIndex),
          query: recallQuery(connection, memoryIndex),
          minScore: 0,
        }, 'soak-context');
        assert.ok(
          result.memories.some((item) => item.memory.id === memoryId),
          'soak context 未命中目标',
        );
      } else if (selector === 5) {
        await callMcp(connection, 'memory_stats', {}, 'soak-stats');
      } else {
        await callMcp(connection, 'memory_list', {
          namespace: roleNamespace(memoryIndex),
          limit: 20,
          offset: 0,
        }, 'soak-list');
      }
    });
    if (soakRound % 20 === 0) {
      const periodicCross = await callMcp(connections[0], 'memory_recall', {
        namespace: roleNamespace(0),
        query: foreignId,
        minScore: 0,
      }, 'soak-cross-principal');
      const leaked = recallContainsId(periodicCross, foreignId);
      leakageCounters.attempted += 1;
      leakageCounters.leaked += leaked ? 1 : 0;
      assert.equal(leaked, false, '稳态期间出现跨账户召回');
    }
    soakRound += 1;
    if (Date.now() >= nextSampleAt) {
      captureSystemSample(`soak-${String(soakRound).padStart(5, '0')}`);
      nextSampleAt = Date.now() + sampleIntervalSeconds * 1_000;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (soakSeconds > 0) captureSystemSample('soak-complete');
  recordCheck('soak-duration', soakSeconds === 0 || Date.now() >= soakDeadline, {
    requestedSeconds: soakSeconds,
    actualMs: Date.now() - soakStarted,
    rounds: soakRound,
  });

  await mapLimit(connections, concurrency, async (connection) => {
    const stats = await callMcp(connection, 'memory_stats', {}, 'final-stats');
    const listed = await callMcp(connection, 'memory_list', {
      namespace: roleNamespace(0),
      limit: 200,
      offset: 0,
    }, 'final-list');
    recordCheck(`${connection.label}.ownership`,
      stats.userId === connection.principalId &&
      listed.items.every((item) => item.userId === connection.principalId),
      { listed: listed.items.length },
    );
  });

  const idleState = await waitForWorkerIdle();
  recordCheck('worker-queues-converged', true, idleState);

  captureSystemSample('pre-shutdown');
  await Promise.allSettled(connections.map((connection) => connection.client.close()));
  await stopWorkerRuntime(workerRuntime);
  fs.fsyncSync(operationDescriptor);
  fs.closeSync(operationDescriptor);
  operationDescriptorClosed = true;
  fs.fsyncSync(sampleDescriptor);
  fs.closeSync(sampleDescriptor);
  sampleDescriptorClosed = true;
  makePrivateTree(runRoot);
  const snapshot = databaseSnapshot(
    databasePath,
    connections.map((connection) => connection.principalId),
  );
  recordCheck('sqlite-integrity',
    snapshot.integrity === 'ok' &&
    snapshot.foreignKeyViolations === 0 &&
    snapshot.journalMode === 'wal',
    {
      integrity: snapshot.integrity,
      foreignKeyViolations: snapshot.foreignKeyViolations,
      journalMode: snapshot.journalMode,
    },
  );
  recordCheck('no-duplicate-or-orphan',
    snapshot.duplicateStableKeys === 0 &&
    snapshot.orphanVersions === 0 &&
    snapshot.orphanEvidence === 0,
    {
      duplicateStableKeys: snapshot.duplicateStableKeys,
      orphanVersions: snapshot.orphanVersions,
      orphanEvidence: snapshot.orphanEvidence,
    },
  );
  const unhealthyReflectionRuns =
    (snapshot.reflectionRunsByStatus.failed || 0) +
    (snapshot.reflectionRunsByStatus.dead || 0);
  recordCheck('jobs-observed',
    snapshot.openOutbox === 0 &&
    snapshot.retryingJobs === 0 &&
    snapshot.deadJobs === 0 &&
    snapshot.deadLetterJobs === 0 &&
    snapshot.quarantinedConsolidations === 0 &&
    unhealthyReflectionRuns === 0,
    {
      openOutbox: snapshot.openOutbox,
      retryingJobs: snapshot.retryingJobs,
      deadJobs: snapshot.deadJobs,
      deadLetterJobs: snapshot.deadLetterJobs,
      quarantinedConsolidations: snapshot.quarantinedConsolidations,
      reflectionRunsByStatus: snapshot.reflectionRunsByStatus,
    },
  );
  recordCheck('retrieval-traces-present', snapshot.retrievalTraces > 0, {
    retrievalTraces: snapshot.retrievalTraces,
  });
  const allTraceStagesPresent = REQUIRED_TRACE_STAGES.every(
    (stage) => Number(snapshot.traceStageCounts[stage] || 0) > 0,
  );
  recordCheck('retrieval-trace-nine-distinct-stages',
    allTraceStagesPresent &&
    snapshot.traceErrors === 0 &&
    snapshot.tracesMissingStages.length === 0 &&
    snapshot.tracesWithAllDistinctStages === snapshot.retrievalTraces &&
    retrievalTraceIds.size === snapshot.retrievalTraces,
    {
      requiredStages: REQUIRED_TRACE_STAGES,
      stageCounts: snapshot.traceStageCounts,
      traceErrors: snapshot.traceErrors,
      totalTraces: snapshot.retrievalTraces,
      tracesWithAllDistinctStages: snapshot.tracesWithAllDistinctStages,
      tracesMissingStages: snapshot.tracesMissingStages,
      mcpReturnedTraceIds: retrievalTraceIds.size,
      duplicateStageEventsAllowed: true,
    },
  );
  const requiredProviderStages = ['rewrite', 'semantic', 'rerank'];
  const fullProviderStagesObserved = requiredProviderStages.every(
    (stage) => Number(snapshot.provider.providerCallsByStage[stage] || 0) > 0,
  );
  recordCheck('fixed-provider-models-observed',
    (semanticMode === 'off' && profileName !== 'full') || (
      snapshot.provider.providerCalls > 0 &&
      snapshot.provider.observedModels.includes(CHAT_MODEL) &&
      snapshot.provider.observedModels.includes(EMBEDDING_MODEL) &&
      (
        profileName !== 'full' || (
          fullProviderStagesObserved &&
          snapshot.nonFullQualityTraces.length === 0
        )
      )
    ),
    {
      configured: { provider: 'ollama', chat: CHAT_MODEL, embedding: EMBEDDING_MODEL },
      observed: snapshot.provider,
      requiredProviderStages,
      fullProviderStagesObserved,
      nonFullQualityTraces: snapshot.nonFullQualityTraces,
      gateSource: profileGates.source,
    },
  );
  recordCheck('version-and-tombstone-counts',
    snapshot.byPrincipal[connections[0].principalId].versions >= memoriesPerUser + 1 &&
    snapshot.byPrincipal[connections[1].principalId].deleted >= 1,
    {
      updatedPrincipal: snapshot.byPrincipal[connections[0].principalId],
      forgottenPrincipal: snapshot.byPrincipal[connections[1].principalId],
    },
  );
  recordCheck('recall-reliability',
    recallCounters.attempted > 0 && recallCounters.hit === recallCounters.attempted,
    recallCounters,
  );
  recordCheck('cross-tenant-leakage-zero',
    leakageCounters.attempted >= 5 && leakageCounters.leaked === 0,
    leakageCounters,
  );
  recordCheck('mcp-process-concurrency-topology',
    maximumGlobalInFlight === Math.min(concurrency, users) &&
    connections.every((connection) => connection.maximumInFlight <= 1),
    {
      configuredGlobalConcurrency: concurrency,
      maximumGlobalInFlight,
      perConnectionMaximumInFlight: Object.fromEntries(
        connections.map((connection) => [connection.label, connection.maximumInFlight]),
      ),
    },
  );
  recordCheck('periodic-health-samples',
    samples.length > 0 && samples.every((sample) =>
      sample.sqlite.integrity === 'ok' &&
      sample.sqlite.foreignKeyViolations === 0 &&
      sample.sqlite.journalMode === 'wal' &&
      sample.queues.deadJobs === 0 &&
      sample.queues.deadLetterJobs === 0 &&
      sample.queues.quarantinedConsolidations === 0 &&
      sample.quality.crossTenant.leaked === 0 &&
      sample.resourceObservation.observedOnly === true &&
      sample.resourceObservation.releaseGate === false),
    {
      samples: samples.length,
      firstAt: samples.at(0)?.at || null,
      lastAt: samples.at(-1)?.at || null,
      resourceObservation: {
        observedOnly: true,
        releaseGate: false,
        limitation: samples.at(-1)?.resourceObservation.limitation || null,
        rssAvailableSamples: samples.filter(
          (sample) => sample.resourceObservation.rss.available,
        ).length,
      },
    },
  );
  recordCheck('mcp-scope-capability-disclosed', true, {
    coveredByThisRun: ['principal credential isolation', 'namespace isolation'],
    notExposedByMcpToolSchema: [
      'persona binding',
      'session binding',
      'role scope binding',
      'project scope binding',
    ],
    independentRealEvaluations: [
      'npm run evaluate:namespace-quality',
      'npm run evaluate:context-reflection',
      'docs/acceptance-report-schema31-context-reflection.md',
    ],
    claimedCoveredByThisRun: false,
  });
  const permissionFailures = regularFiles(runRoot).filter(
    (filePath) => (fs.statSync(filePath).mode & 0o777) !== 0o600,
  );
  recordCheck('private-artifact-permissions', permissionFailures.length === 0, {
    requiredMode: '600',
    checkedFiles: regularFiles(runRoot).length,
    failureCount: permissionFailures.length,
  });

  const positiveRecallLatencies = operations
    .filter((event) =>
      event.event === 'mcp.call.completed' &&
      [
        'positive-recall',
        'correction-recall',
        'restart-persistence',
        'restart-updated-version',
        'soak-recall',
      ].includes(event.phase))
    .map((event) => event.durationMs);
  const recallLatency = latencySummary(positiveRecallLatencies);
  recordCheck('reliable-recall-p95',
    semanticMode === 'off' ||
    (recallLatency.p95 !== null && recallLatency.p95 <= recallP95LimitMs),
    {
      limitMs: recallP95LimitMs,
      gateSource: profileGates.source,
      fullReleaseMaximumMs: profileGates.reliableRecallP95.fullReleaseMaximumMs,
      ...recallLatency,
    },
  );

  const completedOperations = operations.filter(
    (event) => event.event === 'mcp.call.completed',
  );
  const failedOperations = operations.filter(
    (event) => event.event === 'mcp.call.failed',
  );
  const expectedErrorOperations = operations.filter(
    (event) => event.event === 'mcp.call.expected_error',
  );
  recordCheck('mcp-error-rate-zero', failedOperations.length === 0, {
    completed: completedOperations.length,
    failed: failedOperations.length,
    expectedErrors: expectedErrorOperations.length,
  });

  const toolInvocationCounts = Object.fromEntries(REQUIRED_TOOLS.map((tool) => [
    tool,
    operations.filter(
      (event) => event.event === 'mcp.call.started' && event.tool === tool,
    ).length,
  ]));
  recordCheck('all-seven-tools-invoked',
    REQUIRED_TOOLS.every((tool) => toolInvocationCounts[tool] > 0),
    { toolInvocationCounts },
  );
  const latencyByTool = Object.fromEntries(REQUIRED_TOOLS.map((tool) => [
    tool,
    latencySummary(operationLatencies(tool)),
  ]));
  const maintenanceCoverage = {
    consolidation: {
      observedRows: snapshot.consolidationCount,
      qualityClaimedByThisRun: false,
    },
    reflection: {
      observedRunsByStatus: snapshot.reflectionRunsByStatus,
      qualityClaimedByThisRun: false,
    },
    reason:
      'MCP 七工具没有 conversation turn/reflection 输入面；本仿真不直接写数据库伪造 turn。',
    independentRealEvaluations: [
      'npm run evaluate:consolidation-quality',
      'npm run evaluate:context-reflection',
      'docs/acceptance-report-schema31-context-reflection.md',
    ],
  };
  const preliminaryReport = {
    runId,
    checks,
    toolInvocationCounts,
    latencyByTool,
    database: snapshot,
    maintenanceCoverage,
    profileGates,
  };
  const security = scanPrivateArtifacts(JSON.stringify(preliminaryReport));
  recordCheck('artifact-secret-and-body-scan', security.passed, security);
  const failedChecks = checks.filter((item) => !item.passed);
  const report = {
    format: 'memory-bridge-mcp-system-report:v1',
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    runRoot,
    preserved: true,
    summary: {
      passed: failedChecks.length === 0,
      checks: checks.length,
      passedChecks: checks.length - failedChecks.length,
      failedChecks: failedChecks.length,
      completedMcpCalls: completedOperations.length,
      failedMcpCalls: failedOperations.length,
      expectedErrorMcpCalls: expectedErrorOperations.length,
      workload: {
        users,
        memoriesPerUser,
        concurrency,
        soakSeconds,
        soakRounds: soakRound,
        stdioProcesses: users,
      },
      latencyOverallMs: latencySummary(operationLatencies()),
      reliableRecallLatencyMs: recallLatency,
      recallReliability: recallCounters,
      crossTenant: leakageCounters,
    },
    checks,
    toolInvocationCounts,
    latencyByTool,
    database: snapshot,
    samples: {
      path: samplesPath,
      count: samples.length,
      first: samples.at(0) || null,
      last: samples.at(-1) || null,
    },
    security,
    maintenanceCoverage,
    profileGates,
    implementation,
    stderrBytesByPrincipal: Object.fromEntries(stderrBytesByPrincipal),
  };
  const reportPath = path.join(receiptsDir, 'system-report.json');
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const finalSecurity = scanPrivateArtifacts(reportText);
  assert.equal(finalSecurity.passed, true, '最终回执计划文本包含秘密或测试正文');
  const reportReceipt = writeImmutableQaFile(
    reportPath,
    reportText,
  );
  makePrivateTree(runRoot);
  const evidenceRelativePath = 'receipts/evidence-index.json';
  const evidence = {
    format: 'memory-bridge-mcp-system-evidence:v1',
    runId,
    generatedAt: new Date().toISOString(),
    implementationFingerprintSha256: implementation.fingerprintSha256,
    manifest: { path: manifestPath, sha256: fileSha256(manifestPath) },
    report: { path: reportPath, sha256: reportReceipt.sha256 },
    files: evidenceInventory(new Set([evidenceRelativePath])),
  };
  const evidencePath = path.join(receiptsDir, 'evidence-index.json');
  writeImmutableQaFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  makePrivateTree(runRoot);
  assert.ok(
    regularFiles(runRoot).every(
      (filePath) => (fs.statSync(filePath).mode & 0o777) === 0o600,
    ),
    'QA 数据、日志和回执必须保持 0600',
  );
  console.log(`[qa] 报告：${reportPath}`);
  console.log(`[qa] 证据索引：${evidencePath}`);
  console.log(JSON.stringify(report.summary));
  if (failedChecks.length > 0) process.exitCode = 2;
}

try {
  await run();
} catch (error) {
  appendOperation({ event: 'simulation.failed', error: safeError(error) });
  console.error(`[qa] FAILED：${safeError(error)}`);
  console.error(`[qa] 失败数据已保留：${runRoot}`);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(connections.map((connection) => connection.client.close()));
  await stopWorkerRuntime(workerRuntime).catch(() => undefined);
  try {
    if (!operationDescriptorClosed) {
      fs.fsyncSync(operationDescriptor);
      fs.closeSync(operationDescriptor);
      operationDescriptorClosed = true;
    }
  } catch {
    // The successful path already closed the immutable operation log.
  }
  try {
    if (!sampleDescriptorClosed) {
      fs.fsyncSync(sampleDescriptor);
      fs.closeSync(sampleDescriptor);
      sampleDescriptorClosed = true;
    }
  } catch {
    // The successful path already closed the immutable sample log.
  }
}
