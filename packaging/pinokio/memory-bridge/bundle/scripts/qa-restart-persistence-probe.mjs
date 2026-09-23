import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { retrievalQueryHash } from '../dist/server/retrieval-observability.js';
import {
  completeRetrievalTraceStages,
  evaluateCompatAudit,
  evaluateProbeAnswer,
  finitePositiveNumber,
  parseCompatAuditLog,
  reliableRecallLatency,
} from './qa-restart-persistence-probe-lib.mjs';
import {
  buildQaImplementationEvidence,
  createQaRunId,
  immutableQaPath,
  writeImmutableQaFile,
} from './qa-receipt-lib.mjs';
import { verifyModelPreflight } from './qa-model-preflight-lib.mjs';

const acceptanceRoot = process.env.MEMORY_BRIDGE_ACCEPTANCE_ROOT;
const bridgeBaseUrl = process.env.MEMORY_BRIDGE_QA_BASE_URL || 'http://127.0.0.1:3791';
const compatAuditLogPath =
  process.env.MEMORY_BRIDGE_QA_COMPAT_AUDIT_LOG || '';
const timeoutMs = Number(process.env.MEMORY_BRIDGE_QA_TIMEOUT_MS || 180_000);
const reliableRecallP95ThresholdMs = finitePositiveNumber(
  process.env.MEMORY_BRIDGE_QA_RELIABLE_RECALL_P95_MS ?? 2_500,
);

if (reliableRecallP95ThresholdMs === null) {
  throw new Error('MEMORY_BRIDGE_QA_RELIABLE_RECALL_P95_MS 必须是有限正数');
}

if (!acceptanceRoot) {
  throw new Error('必须设置 MEMORY_BRIDGE_ACCEPTANCE_ROOT');
}

const secretsPath = path.join(acceptanceRoot, 'acceptance-secrets.json');
const manifestPath = path.join(acceptanceRoot, 'acceptance-manifest.json');
const databasePath = path.join(acceptanceRoot, 'memory-data', 'memory-bridge.sqlite3');
const receiptsDir = path.join(acceptanceRoot, 'receipts');
const runId = createQaRunId();
const reportPath = immutableQaPath(
  receiptsDir,
  'restart-persistence-probe',
  runId,
  'json',
);
const compatAuditSnapshotPath = immutableQaPath(
  receiptsDir,
  'compat-audit-events',
  runId,
  'jsonl',
);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const manifestModels = manifest.models;
const chatModel = process.env.MEMORY_BRIDGE_QA_CHAT_MODEL === undefined
  ? manifestModels?.chat
  : process.env.MEMORY_BRIDGE_QA_CHAT_MODEL.trim();
const probes = [];

async function verifyAcceptanceModelPreflight() {
  const response = await fetch(`${bridgeBaseUrl}/api/config`, {
    headers: {
      Authorization: `Bearer ${secrets.alice.token}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`AIRI 模型预检失败：/api/config HTTP ${response.status}`);
  }
  const runtime = await response.json();
  return verifyModelPreflight({
    manifestModels,
    runtime,
    requestedChatModel: chatModel,
  });
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  return Number(sorted[index].toFixed(3));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function implementationEvidence(schemaVersion) {
  return buildQaImplementationEvidence({
    projectRoot,
    schemaVersion,
    relativeFiles: [
      'package.json',
      'package-lock.json',
      'scripts/qa-restart-persistence-probe.mjs',
      'scripts/qa-restart-persistence-probe-lib.mjs',
      'scripts/qa-receipt-lib.mjs',
      'scripts/qa-model-preflight-lib.mjs',
    ],
    runtimeDirectories: ['dist/server'],
  });
}

const cases = [
  {
    id: 'alice-corrected-project-persists',
    actor: 'alice',
    personaId: 'alice-star',
    projectId: 'alice-starport',
    question: '星港项目现在的代号是什么？',
    expectedResult: 'grounded',
    expected: ['银鸥29'],
    forbidden: ['蓝鲸17'],
  },
  {
    id: 'alice-role-address-persists',
    actor: 'alice',
    personaId: 'alice-star',
    projectId: 'alice-starport',
    question: '你在这个角色里应该怎么称呼我？',
    expectedResult: 'grounded',
    expected: ['小枫'],
    forbidden: [],
  },
  {
    id: 'bob-project-persists',
    actor: 'bob',
    personaId: 'bob-boat',
    projectId: 'bob-greenmist',
    question: '青岚项目现在的代号是什么？',
    expectedResult: 'grounded',
    expected: ['绿松石33'],
    forbidden: [],
  },
  {
    id: 'bob-forgotten-memory-stays-forgotten',
    actor: 'bob',
    personaId: 'bob-boat',
    projectId: 'bob-greenmist',
    question: '我以前给香菜起过什么特别称呼？',
    expectedResult: 'abstain',
    expected: [],
    forbidden: ['翠叶禁区'],
  },
  {
    id: 'alice-personal-memory-cross-role',
    actor: 'alice',
    personaId: 'alice-ink',
    projectId: 'alice-morningboat',
    question: '我工作日早上一般喝什么？',
    expectedResult: 'grounded',
    expected: ['桂花乌龙'],
    forbidden: [],
  },
  {
    id: 'alice-role-isolation',
    actor: 'alice',
    personaId: 'alice-ink',
    projectId: 'alice-morningboat',
    question: '星璃那个角色平时怎么称呼我？',
    expectedResult: 'clarify',
    expected: [],
    forbidden: ['小枫'],
  },
  {
    id: 'bob-role-isolation',
    actor: 'bob',
    personaId: 'bob-pine',
    projectId: 'bob-northlight',
    question: '小舟那个角色平时怎么称呼我？',
    expectedResult: 'clarify',
    expected: [],
    forbidden: ['阿北'],
  },
  {
    id: 'alice-project-isolation',
    actor: 'alice',
    personaId: 'alice-ink',
    projectId: 'alice-morningboat',
    question: '星港项目现在的代号是什么？',
    expectedResult: 'abstain',
    expected: [],
    forbidden: ['银鸥29', '蓝鲸17'],
  },
  {
    id: 'alice-cannot-read-bob',
    actor: 'alice',
    personaId: 'alice-star',
    projectId: 'alice-starport',
    question: 'Bob 的青岚项目现在代号是什么？',
    expectedResult: 'abstain',
    expected: [],
    forbidden: ['绿松石33'],
  },
  {
    id: 'bob-cannot-read-alice',
    actor: 'bob',
    personaId: 'bob-boat',
    projectId: 'bob-greenmist',
    question: 'Alice 的星港项目现在代号是什么？',
    expectedResult: 'abstain',
    expected: [],
    forbidden: ['银鸥29', '蓝鲸17'],
  },
  {
    id: 'alice-explicit-missing-memory',
    actor: 'alice',
    personaId: 'alice-star',
    projectId: 'alice-starport',
    question: '请查询长期记忆：我是否说过“银河鳗鱼90817”？',
    expectedResult: 'abstain',
    expectedAuditReason: 'explicit_query',
    expected: [],
    forbidden: [],
  },
  {
    id: 'alice-world-knowledge-hard-negative',
    actor: 'alice',
    personaId: 'alice-star',
    projectId: 'alice-starport',
    question: '什么是向量数据库？',
    expectedResult: 'passthrough',
    expected: [],
    forbidden: [],
  },
  {
    id: 'bob-advice-hard-negative',
    actor: 'bob',
    personaId: 'bob-boat',
    projectId: 'bob-greenmist',
    question: '如何为一个新项目选择代号？',
    expectedResult: 'passthrough',
    expected: [],
    forbidden: [],
  },
];

async function chat(testCase) {
  const actor = secrets[testCase.actor];
  const sessionId = `restart-${runId}-${testCase.id}`;
  const started = Date.now();
  const response = await fetch(`${bridgeBaseUrl}/ollama-compat/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${actor.token}`,
      'Content-Type': 'application/json',
      'x-memory-bridge-context-version': '1',
      'x-airi-character-id': testCase.personaId,
      'x-airi-session-id': sessionId,
      'x-airi-round-id': `${sessionId}-round-1`,
      'x-airi-project-id': testCase.projectId,
    },
    body: JSON.stringify({
      model: chatModel,
      stream: false,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `你是角色 ${testCase.personaId}。普通知识和建议可以使用模型知识回答；涉及用户、角色或项目的私有事实，只能使用允许注入的长期记忆，不知道就明确说不知道。`,
        },
        { role: 'user', content: testCase.question },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`${testCase.id} HTTP ${response.status}: ${responseText.slice(0, 500)}`);
  }
  const body = JSON.parse(responseText);
  const answer = String(body?.choices?.[0]?.message?.content || '');
  const assertion = evaluateProbeAnswer(testCase, answer);
  const passed = assertion.passed;
  const completed = Date.now();
  const receipt = {
    id: testCase.id,
    passed,
    actor: testCase.actor,
    personaId: testCase.personaId,
    projectId: testCase.projectId,
    sessionId,
    question: testCase.question,
    expectedResult: testCase.expectedResult,
    expectedAuditReason: testCase.expectedAuditReason || null,
    expected: testCase.expected,
    forbidden: testCase.forbidden,
    assertion,
    answer,
    requestId: response.headers.get('x-memory-bridge-request-id'),
    traceId: response.headers.get('x-memory-bridge-trace-id'),
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    durationMs: completed - started,
    queryHash: retrievalQueryHash(testCase.question),
  };
  probes.push(receipt);
  console.log(`[restart-probe] ${passed ? 'PASS' : 'FAIL'} ${testCase.id} ${receipt.durationMs}ms`);
}

function attachCompatAuditEvidence() {
  if (!compatAuditLogPath || !fs.existsSync(compatAuditLogPath)) {
    for (const probe of probes) {
      probe.compatAudit = evaluateCompatAudit(
        {
          ...probe,
          expectedAuditReason:
            probe.expectedAuditReason ||
            (probe.expectedResult === 'grounded' ||
              probe.expectedResult === 'abstain'
              ? 'private_fact_query'
              : null),
          expectedTraceId: probe.trace?.trace_id || null,
        },
        probe.requestId,
        [],
      );
    }
    return {
      configured: Boolean(compatAuditLogPath),
      available: false,
      sourceSha256: null,
      sourceAuditBytes: 0,
      parsedEventCount: 0,
      invalidPrefixedLineCount: 0,
      snapshotPath: null,
      snapshotSha256: null,
      snapshotBytes: 0,
      hashScope: 'parsed_compat_audit_events_canonical_jsonl',
      coveragePassed: false,
    };
  }
  const raw = fs.readFileSync(compatAuditLogPath);
  if (raw.length > 50 * 1024 * 1024) {
    throw new Error('兼容层审计日志超过 50 MB，拒绝无界读取');
  }
  const parsedAudit = parseCompatAuditLog(raw.toString('utf8'));
  const events = parsedAudit.events;
  const snapshotReceipt = writeImmutableQaFile(
    compatAuditSnapshotPath,
    parsedAudit.canonicalJsonl,
  );
  for (const probe of probes) {
    probe.compatAudit = evaluateCompatAudit(
      {
        ...probe,
        expectedAuditReason:
          probe.expectedAuditReason ||
          (probe.expectedResult === 'grounded' ||
            probe.expectedResult === 'abstain'
            ? 'private_fact_query'
            : null),
        expectedTraceId: probe.trace?.trace_id || null,
      },
      probe.requestId,
      events,
    );
  }
  return {
    configured: true,
    available: true,
    sourceSha256: sha256(parsedAudit.canonicalJsonl),
    sourceAuditBytes: Buffer.byteLength(parsedAudit.canonicalJsonl),
    parsedEventCount: events.length,
    invalidPrefixedLineCount: parsedAudit.invalidPrefixedLineCount,
    snapshotPath: compatAuditSnapshotPath,
    snapshotSha256: snapshotReceipt.sha256,
    snapshotBytes: snapshotReceipt.bytes,
    hashScope: 'parsed_compat_audit_events_canonical_jsonl',
    coveragePassed:
      parsedAudit.invalidPrefixedLineCount === 0 &&
      probes.every((probe) => probe.compatAudit.passed),
  };
}

function attachDatabaseEvidence() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (const probe of probes) {
      const trace = database.prepare(
        `SELECT trace_id, quality_state, result_count, total_duration_ms,
                started_at, completed_at
         FROM retrieval_traces
         WHERE trace_id = ? AND user_id = ? AND query_hash = ?
           AND started_at >= ? AND started_at <= ?
         LIMIT 1`,
      ).get(
        probe.traceId,
        secrets[probe.actor].principalId,
        probe.queryHash,
        probe.startedAt,
        probe.completedAt,
      );
      if (!trace) continue;
      const events = database.prepare(
        `SELECT stage, event_json
         FROM retrieval_trace_events
         WHERE trace_id = ?
         ORDER BY sequence`,
      ).all(trace.trace_id);
      const parsedEvents = events.map((event) => ({
        stage: event.stage,
        details: JSON.parse(event.event_json),
      }));
      const rewrite = parsedEvents.find((event) => event.stage === 'rewrite');
      probe.trace = {
        ...trace,
        events: parsedEvents,
      };
      probe.traceStagesPassed = completeRetrievalTraceStages(parsedEvents);
      probe.latency = reliableRecallLatency(
        rewrite?.details,
        trace.total_duration_ms,
      );
    }

    const integrity = String(
      Object.values(database.prepare('PRAGMA integrity_check').get() || {})[0] || '',
    );
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all().length;
    const openOutbox = Number(database.prepare(
      `SELECT COUNT(*) AS count FROM outbox_events
       WHERE status IN ('pending', 'processing', 'failed')`,
    ).get().count);
    const unhealthyJobs = Number(database.prepare(
      `SELECT COUNT(*) AS count FROM memory_jobs
       WHERE status IN ('running', 'failed', 'dead')`,
    ).get().count);
    const userVersion = Number(
      Object.values(database.prepare('PRAGMA user_version').get() || {})[0],
    );
    return {
      integrity,
      foreignKeyViolations,
      openOutbox,
      unhealthyJobs,
      userVersion,
    };
  } finally {
    database.close();
  }
}

async function main() {
  fs.mkdirSync(receiptsDir, { recursive: true });
  const modelPreflight = await verifyAcceptanceModelPreflight();
  for (const testCase of cases) await chat(testCase);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const database = attachDatabaseEvidence();
  const compatAudit = attachCompatAuditEvidence();
  const implementation = implementationEvidence(database.userVersion);
  const passed = probes.filter((probe) => probe.passed).length;
  const latencySamples = probes
    .map((probe) => probe.latency)
    .filter(Boolean);
  const completeTraceSamples = probes.filter(
    (probe) => probe.traceStagesPassed === true,
  ).length;
  const traceCoveragePassed =
    latencySamples.length === probes.length &&
    probes.every((probe) => probe.traceStagesPassed === true);
  const reliableRecallP95Ms = percentile(
    latencySamples.map((sample) => sample.reliableRecallMs),
    0.95,
  );
  const latencyGatePassed =
    traceCoveragePassed &&
    reliableRecallP95Ms !== null &&
    reliableRecallP95Ms <= reliableRecallP95ThresholdMs;
  const answerChecksPassed = passed === probes.length;
  const functionalPassed =
    answerChecksPassed && compatAudit.coveragePassed;
  const databasePassed =
    database.integrity === 'ok' &&
    database.foreignKeyViolations === 0 &&
    database.openOutbox === 0 &&
    database.unhealthyJobs === 0;
  const releasePassed = functionalPassed && databasePassed && latencyGatePassed;
  const failureReasons = [];
  if (!answerChecksPassed) failureReasons.push('answer_checks_failed');
  if (!compatAudit.coveragePassed) {
    failureReasons.push('compat_audit_coverage_incomplete');
  }
  if (!databasePassed) failureReasons.push('database_health_failed');
  if (!traceCoveragePassed) failureReasons.push('retrieval_trace_coverage_incomplete');
  if (
    reliableRecallP95Ms === null ||
    reliableRecallP95Ms > reliableRecallP95ThresholdMs
  ) {
    failureReasons.push('reliable_recall_p95_exceeded');
  }
  const report = {
    format: 'memory-bridge-restart-persistence-probe:v7',
    runId,
    completedAt: new Date().toISOString(),
    acceptanceRoot,
    bridgeBaseUrl,
    chatModel,
    modelPreflight,
    summary: {
      passed: releasePassed,
      releaseVerdict: releasePassed ? 'PASS' : 'FAIL',
      functionalPassed,
      answerChecksPassed,
      compatAuditPassed: compatAudit.coveragePassed,
      databasePassed,
      latencyGatePassed,
      checks: probes.length,
      passedChecks: passed,
      failedChecks: probes.length - passed,
      failureReasons,
    },
    latency: {
      sampleCount: latencySamples.length,
      expectedSamples: probes.length,
      traceCoverage: probes.length === 0
        ? 0
        : Number((latencySamples.length / probes.length).toFixed(4)),
      completeTraceSamples,
      completeTraceCoverage: probes.length === 0
        ? 0
        : Number((completeTraceSamples / probes.length).toFixed(4)),
      queryUnderstandingP50Ms: percentile(
        latencySamples.map((sample) => sample.queryUnderstandingMs),
        0.5,
      ),
      queryUnderstandingP95Ms: percentile(
        latencySamples.map((sample) => sample.queryUnderstandingMs),
        0.95,
      ),
      retrievalTraceP50Ms: percentile(
        latencySamples.map((sample) => sample.retrievalTraceMs),
        0.5,
      ),
      retrievalTraceP95Ms: percentile(
        latencySamples.map((sample) => sample.retrievalTraceMs),
        0.95,
      ),
      reliableRecallP50Ms: percentile(
        latencySamples.map((sample) => sample.reliableRecallMs),
        0.5,
      ),
      reliableRecallP95Ms,
      thresholdP95Ms: reliableRecallP95ThresholdMs,
      passed: latencyGatePassed,
      measurement: 'query_understanding_ms + retrieval_trace_total_duration_ms',
      excludesChatGeneration: true,
    },
    database,
    implementation,
    compatAudit,
    probes,
  };
  const reportReceipt = writeImmutableQaFile(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify({
    reportPath,
    reportSha256: reportReceipt.sha256,
    reportBytes: reportReceipt.bytes,
    summary: report.summary,
    database,
    compatAudit,
  }, null, 2));
  process.exitCode = releasePassed ? 0 : 1;
}

await main();
