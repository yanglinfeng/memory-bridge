import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../dist/server/database.js';
import { LifecycleStore } from '../dist/server/lifecycle-store.js';

const ACCEPTANCE_DURATION_MS = 30 * 60 * 1_000;
const SESSION_COUNT = 10;
const WORKER_COUNT = 2;
const durationMs = Math.max(
  5_000,
  Number(process.env.MEMORY_BRIDGE_SOAK_DURATION_MS) ||
    ACCEPTANCE_DURATION_MS,
);
const intervalMs = Math.max(
  50,
  Number(process.env.MEMORY_BRIDGE_SOAK_INTERVAL_MS) || 1_000,
);
const allowShort =
  process.env.MEMORY_BRIDGE_SOAK_ALLOW_SHORT === '1';
const keepArtifacts =
  process.env.MEMORY_BRIDGE_KEEP_SOAK === '1';
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-bridge-soak-'),
);
const databasePath = path.join(directory, 'soak.sqlite3');
const workerPath = fileURLToPath(
  new URL('./soak-worker.mjs', import.meta.url),
);
const database = openDatabase(databasePath);
const lifecycle = new LifecycleStore(database);
const workers = [];
const workerStats = new Map();
const workerLogs = new Map();
let stopped = false;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function count(sql, ...values) {
  return Number(
    database.prepare(sql).get(...values)?.count || 0,
  );
}

async function writeExchange(sessionIndex, round) {
  const input = {
    clientName: 'soak-airi',
    sessionExternalId: `soak-session-${sessionIndex}`,
    userTurnExternalId: `user-${round}`,
    userContent:
      `soak-session-${sessionIndex}：` +
      `我长期保持偏好值${sessionIndex}。第${round}次自然陈述。`,
    assistantTurnExternalId: `assistant-${round}`,
    assistantContent: `已理解第${round}轮对话。`,
    userMetadata: {
      soak: true,
      sessionIndex,
      round,
    },
    assistantMetadata: {
      soak: true,
      sessionIndex,
      round,
    },
  };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      lifecycle.recordCompletedExchange(input);
      return attempt;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !/database is locked|SQLITE_BUSY/iu.test(error.message) ||
        attempt === 19
      ) {
        throw error;
      }
      await delay(10 * (attempt + 1));
    }
  }
  throw new Error('写入重试意外退出');
}

function spawnWorker(index) {
  const workerId = `soak-worker-${index}`;
  const child = fork(
    workerPath,
    [databasePath, workerId],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  const logs = [];
  workerLogs.set(workerId, logs);
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      logs.push(String(chunk));
      if (logs.length > 20) logs.shift();
    });
  }
  child.on('message', (message) => {
    if (
      message?.type === 'stats' ||
      message?.type === 'stopped'
    ) {
      workerStats.set(workerId, message);
    }
    if (message?.type === 'ready') {
      workerStats.set(workerId, {
        type: 'ready',
        workerId,
        processed: 0,
        errors: 0,
        candidateCount: 0,
        lastError: null,
      });
    }
  });
  workers.push({ workerId, child });
}

async function waitForWorkers() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      workers.every(({ workerId }) =>
        workerStats.has(workerId),
      )
    ) {
      return;
    }
    if (
      workers.some(({ child }) =>
        child.exitCode !== null,
      )
    ) {
      throw new Error('soak worker 在 ready 前退出');
    }
    await delay(25);
  }
  throw new Error('等待 soak worker ready 超时');
}

function backlog() {
  return {
    outbox: count(
      `SELECT COUNT(*) AS count
       FROM outbox_events
       WHERE status != 'completed'`,
    ),
    jobs: count(
      `SELECT COUNT(*) AS count
       FROM memory_jobs
       WHERE status NOT IN ('completed', 'dead')`,
    ),
  };
}

async function drain() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const current = backlog();
    if (current.outbox === 0 && current.jobs === 0) return;
    await delay(100);
  }
  throw new Error(
    `soak drain 超时：${JSON.stringify(backlog())}`,
  );
}

async function stopWorkers() {
  if (stopped) return;
  stopped = true;
  for (const { child } of workers) {
    if (child.exitCode === null) child.send({ type: 'stop' });
  }
  const deadline = Date.now() + 15_000;
  while (
    Date.now() < deadline &&
    workers.some(({ child }) => child.exitCode === null)
  ) {
    await delay(25);
  }
  for (const { child } of workers) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

try {
  for (let index = 0; index < WORKER_COUNT; index += 1) {
    spawnWorker(index);
  }
  await waitForWorkers();

  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  let round = 0;
  let exchangeCount = 0;
  let retryWrites = 0;
  let busyRetries = 0;
  let nextProgressAt = startedAt + 60_000;
  while (Date.now() < deadline) {
    const tickStarted = Date.now();
    for (
      let sessionIndex = 0;
      sessionIndex < SESSION_COUNT;
      sessionIndex += 1
    ) {
      busyRetries += await writeExchange(sessionIndex, round);
      exchangeCount += 1;
      if (round > 0 && round % 10 === 0) {
        busyRetries += await writeExchange(sessionIndex, round);
        retryWrites += 1;
      }
    }
    round += 1;
    if (Date.now() >= nextProgressAt) {
      console.error(JSON.stringify({
        phase: 'soak',
        elapsedSeconds: Math.floor(
          (Date.now() - startedAt) / 1_000,
        ),
        exchangeCount,
        retryWrites,
        busyRetries,
        backlog: backlog(),
        workerStats: [...workerStats.values()],
      }));
      nextProgressAt += 60_000;
    }
    const remaining = intervalMs - (Date.now() - tickStarted);
    if (remaining > 0) await delay(remaining);
  }
  const producedDurationMs = Date.now() - startedAt;
  await drain();
  await stopWorkers();

  const counts = {
    sessions: count(
      `SELECT COUNT(*) AS count FROM conversation_sessions`,
    ),
    turns: count(
      `SELECT COUNT(*) AS count FROM conversation_turns`,
    ),
    outbox: count(
      `SELECT COUNT(*) AS count FROM outbox_events`,
    ),
    incompleteOutbox: count(
      `SELECT COUNT(*) AS count
       FROM outbox_events
       WHERE status != 'completed'`,
    ),
    extractionRuns: count(
      `SELECT COUNT(*) AS count FROM extraction_runs`,
    ),
    completedExtractions: count(
      `SELECT COUNT(*) AS count
       FROM extraction_runs
       WHERE status = 'completed'`,
    ),
    candidates: count(
      `SELECT COUNT(*) AS count FROM memory_candidates`,
    ),
    acceptedCandidates: count(
      `SELECT COUNT(*) AS count
       FROM memory_candidates
       WHERE state = 'accepted'`,
    ),
    memories: count(
      `SELECT COUNT(*) AS count
       FROM memory_items
       WHERE status = 'active'`,
    ),
    versions: count(
      `SELECT COUNT(*) AS count FROM memory_versions`,
    ),
    evidence: count(
      `SELECT COUNT(*) AS count FROM memory_evidence`,
    ),
    jobs: count(
      `SELECT COUNT(*) AS count FROM memory_jobs`,
    ),
    incompleteJobs: count(
      `SELECT COUNT(*) AS count
       FROM memory_jobs
       WHERE status != 'completed'`,
    ),
    deadLetters: count(
      `SELECT COUNT(*) AS count FROM dead_letter_jobs`,
    ),
    duplicateStableKeys: count(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT user_id, namespace, scope_type, scope_key, stable_key
         FROM memory_items
         WHERE status = 'active'
         GROUP BY user_id, namespace, scope_type, scope_key, stable_key
         HAVING COUNT(*) > 1
       )`,
    ),
    orphanCandidates: count(
      `SELECT COUNT(*) AS count
       FROM memory_candidates c
       LEFT JOIN conversation_turns t ON t.id = c.turn_id
       WHERE t.id IS NULL`,
    ),
    orphanEvidence: count(
      `SELECT COUNT(*) AS count
       FROM memory_evidence e
       LEFT JOIN memory_versions v
         ON v.id = e.memory_version_id
       WHERE v.id IS NULL`,
    ),
  };
  const integrity = String(
    database.prepare('PRAGMA integrity_check').get()
      ?.integrity_check || '',
  );
  const foreignKeyViolations =
    database.prepare('PRAGMA foreign_key_check').all().length;
  const workerErrors = [...workerStats.values()].reduce(
    (total, item) => total + Number(item.errors || 0),
    0,
  );
  const workerExitedUnexpectedly = workers.some(
    ({ child }) =>
      child.exitCode !== 0 && child.signalCode !== 'SIGTERM',
  );
  const invariantsPassed =
    counts.sessions === SESSION_COUNT &&
    counts.turns === exchangeCount * 2 &&
    counts.incompleteOutbox === 0 &&
    counts.extractionRuns === exchangeCount &&
    counts.completedExtractions === exchangeCount &&
    counts.candidates === exchangeCount &&
    counts.acceptedCandidates === exchangeCount &&
    counts.memories === SESSION_COUNT &&
    counts.versions === SESSION_COUNT &&
    counts.evidence === exchangeCount &&
    counts.incompleteJobs === 0 &&
    counts.deadLetters === 0 &&
    counts.duplicateStableKeys === 0 &&
    counts.orphanCandidates === 0 &&
    counts.orphanEvidence === 0 &&
    integrity === 'ok' &&
    foreignKeyViolations === 0 &&
    workerErrors === 0 &&
    !workerExitedUnexpectedly;
  const acceptanceDurationReached =
    producedDurationMs >= ACCEPTANCE_DURATION_MS;
  const report = {
    passed:
      invariantsPassed &&
      (acceptanceDurationReached || allowShort),
    acceptancePassed:
      invariantsPassed && acceptanceDurationReached,
    mode: acceptanceDurationReached
      ? '30-minute-acceptance'
      : 'short-smoke',
    configured: {
      sessions: SESSION_COUNT,
      workers: WORKER_COUNT,
      durationMs,
      intervalMs,
    },
    observed: {
      producedDurationMs,
      rounds: round,
      exchangeCount,
      retryWrites,
      busyRetries,
      workerErrors,
      workerExitedUnexpectedly,
      workerStats: [...workerStats.values()],
    },
    counts,
    integrity,
    foreignKeyViolations,
    acceptanceDurationReached,
    isolatedDatabaseRemovedOnExit: !keepArtifacts,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await stopWorkers();
  database.close();
  if (!keepArtifacts) {
    fs.rmSync(directory, { recursive: true, force: true });
  } else {
    console.error(`保留 soak 隔离目录：${directory}`);
  }
}
