import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../dist/server/database.js';
import { LifecycleStore } from '../dist/server/lifecycle-store.js';
import { MemoryReflectionService } from '../dist/server/memory-reflection.js';

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-bridge-crash-recovery-'),
);
const databasePath = path.join(directory, 'recovery.sqlite3');
const workerPath = fileURLToPath(
  new URL('./soak-worker.mjs', import.meta.url),
);
const keepArtifacts =
  process.env.MEMORY_BRIDGE_KEEP_CRASH_RECOVERY === '1';
let database = openDatabase(databasePath);
let worker = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function count(sql, ...values) {
  return Number(
    database.prepare(sql).get(...values)?.count || 0,
  );
}

function spawnWorker(workerId, killDelayMs = 0, reflection = false) {
  const child = fork(
    workerPath,
    [databasePath, workerId],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        MEMORY_BRIDGE_SOAK_KILL_DELAY_MS:
          String(killDelayMs),
        MEMORY_BRIDGE_SOAK_REFLECTION: reflection ? '1' : '0',
      },
    },
  );
  const messages = [];
  const logs = [];
  child.on('message', (message) => messages.push(message));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => logs.push(String(chunk)));
  }
  return { child, messages, logs, workerId };
}

async function waitForMessage(target, type, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = target.messages.find(
      (item) => item?.type === type,
    );
    if (message) return message;
    if (target.child.exitCode !== null) {
      throw new Error(
        `${target.workerId} 在等待 ${type} 时退出：` +
        target.logs.join('').slice(-2_000),
      );
    }
    await delay(10);
  }
  throw new Error(`等待 ${target.workerId} 的 ${type} 超时`);
}

async function waitForExit(target, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (
    Date.now() < deadline &&
    target.child.exitCode === null &&
    target.child.signalCode === null
  ) {
    await delay(10);
  }
  if (
    target.child.exitCode === null &&
    target.child.signalCode === null
  ) {
    throw new Error(`等待 ${target.workerId} 退出超时`);
  }
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

const recoveryExtractor = {
  model: 'qwen2.5:14b',
  promptVersion: 'crash-recovery-extractor-v1',
  extractorId: 'crash-recovery-extractor',
  extractorVersion: 'v1',
  async extract() {
    return [];
  },
};

const recoveryReflectionProvider = {
  model: 'qwen2.5:14b',
  promptVersion: 'crash-recovery-reflection-v1',
  async reflect() {
    return { candidates: [] };
  },
};

async function drain(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = backlog();
    if (current.outbox === 0 && current.jobs === 0) return;
    await delay(25);
  }
  throw new Error(
    `crash recovery drain 超时：${JSON.stringify(backlog())}`,
  );
}

async function stopWorker(target) {
  if (
    !target ||
    target.child.exitCode !== null ||
    target.child.signalCode !== null
  ) {
    return;
  }
  target.child.send({ type: 'stop' });
  await waitForExit(target, 10_000);
}

try {
  const lifecycle = new LifecycleStore(database);
  const exchange = {
    clientName: 'crash-airi',
    sessionExternalId: 'soak-session-0',
    userTurnExternalId: 'crash-user-1',
    userContent:
      'soak-session-0：我长期保持偏好值0。SOAK_KILL_TARGET。',
    assistantTurnExternalId: 'crash-assistant-1',
    assistantContent: '已理解你的稳定偏好。',
    userMetadata: { crashRecovery: true },
    assistantMetadata: { crashRecovery: true },
  };
  lifecycle.recordCompletedExchange(exchange);
  const committedBeforeKill = {
    sessions: count(
      'SELECT COUNT(*) AS count FROM conversation_sessions',
    ),
    turns: count(
      'SELECT COUNT(*) AS count FROM conversation_turns',
    ),
    outbox: count(
      'SELECT COUNT(*) AS count FROM outbox_events',
    ),
  };

  worker = spawnWorker('crash-worker', 60_000);
  await waitForMessage(worker, 'ready');
  const killPoint = await waitForMessage(
    worker,
    'kill-point',
    30_000,
  );
  const runningBeforeKill = database
    .prepare(
      `SELECT status, attempts, lease_owner, lease_until
       FROM memory_jobs
       WHERE job_type = 'extract_turn'`,
    )
    .get();
  const extractionBeforeKill = database
    .prepare(
      `SELECT status
       FROM extraction_runs
       WHERE turn_id = ?`,
    )
    .get(killPoint.turnId);
  worker.child.kill('SIGKILL');
  await waitForExit(worker);
  const killSignal = worker.child.signalCode;

  database.close();
  database = openDatabase(databasePath);
  const committedAfterRestart = {
    sessions: count(
      'SELECT COUNT(*) AS count FROM conversation_sessions',
    ),
    turns: count(
      'SELECT COUNT(*) AS count FROM conversation_turns',
    ),
    outbox: count(
      'SELECT COUNT(*) AS count FROM outbox_events',
    ),
    candidates: count(
      'SELECT COUNT(*) AS count FROM memory_candidates',
    ),
  };
  database
    .prepare(
      `UPDATE memory_jobs
       SET lease_until = '2000-01-01T00:00:00.000Z'
       WHERE job_type = 'extract_turn'
         AND status = 'running'`,
    )
    .run();

  worker = spawnWorker('restart-worker');
  await waitForMessage(worker, 'ready');
  await drain();
  const beforeReplay = {
    turns: count(
      'SELECT COUNT(*) AS count FROM conversation_turns',
    ),
    extractionRuns: count(
      'SELECT COUNT(*) AS count FROM extraction_runs',
    ),
    candidates: count(
      'SELECT COUNT(*) AS count FROM memory_candidates',
    ),
    memories: count(
      `SELECT COUNT(*) AS count
       FROM memory_items
       WHERE status = 'active'`,
    ),
    versions: count(
      'SELECT COUNT(*) AS count FROM memory_versions',
    ),
    evidence: count(
      'SELECT COUNT(*) AS count FROM memory_evidence',
    ),
  };

  database
    .prepare(
      `UPDATE outbox_events
       SET status = 'pending', attempts = 0,
           available_at = '2000-01-01T00:00:00.000Z',
           lease_until = NULL, lease_owner = NULL,
           processed_at = NULL
       WHERE aggregate_type = 'turn'`,
    )
    .run();
  await drain();
  new LifecycleStore(database).recordCompletedExchange(exchange);
  await drain();
  const afterReplay = {
    turns: count(
      'SELECT COUNT(*) AS count FROM conversation_turns',
    ),
    extractionRuns: count(
      'SELECT COUNT(*) AS count FROM extraction_runs',
    ),
    candidates: count(
      'SELECT COUNT(*) AS count FROM memory_candidates',
    ),
    memories: count(
      `SELECT COUNT(*) AS count
       FROM memory_items
       WHERE status = 'active'`,
    ),
    versions: count(
      'SELECT COUNT(*) AS count FROM memory_versions',
    ),
    evidence: count(
      'SELECT COUNT(*) AS count FROM memory_evidence',
    ),
  };
  await stopWorker(worker);

  const reflectionLifecycle = new LifecycleStore(database);
  const reflectionService = new MemoryReflectionService(
    database,
    reflectionLifecycle,
    recoveryExtractor,
    recoveryReflectionProvider,
    { minNewTurns: 1 },
  );
  const queuedReflection = reflectionService.queueRun({
    userId: 'default',
    namespace: 'personal',
    scopeType: 'personal',
    scopeKey: 'self',
    runType: 'reflect',
    trigger: 'manual',
    requestedBy: 'crash-recovery-verifier',
  });
  worker = spawnWorker(
    'crashed-reflection-worker',
    60_000,
    true,
  );
  await waitForMessage(worker, 'ready');
  await waitForMessage(worker, 'reflection-kill-point', 30_000);
  const reflectionBeforeKill = {
    run: database.prepare(
      `SELECT status, attempts, lease_owner, lease_until
       FROM memory_reflection_runs WHERE id = ?`,
    ).get(queuedReflection.run.id),
    job: database.prepare(
      `SELECT status, attempts, lease_owner, lease_until
       FROM memory_jobs WHERE id = ?`,
    ).get(`reflection-run:${queuedReflection.run.id}`),
    reservedCalls: count(
      `SELECT COUNT(*) AS count
       FROM memory_reflection_model_calls
       WHERE run_id = ? AND status = 'reserved'`,
      queuedReflection.run.id,
    ),
  };
  worker.child.kill('SIGKILL');
  await waitForExit(worker);
  const reflectionKillSignal = worker.child.signalCode;

  database.close();
  database = openDatabase(databasePath);
  const expiredLease = '2000-01-01T00:00:00.000Z';
  database.prepare(
    `UPDATE memory_reflection_runs
     SET lease_until = ?
     WHERE id = ? AND status = 'running'
       AND lease_owner = 'crashed-reflection-worker'`,
  ).run(expiredLease, queuedReflection.run.id);
  database.prepare(
    `UPDATE memory_jobs
     SET lease_until = ?
     WHERE id = ? AND status = 'running'
       AND lease_owner = 'crashed-reflection-worker'`,
  ).run(expiredLease, `reflection-run:${queuedReflection.run.id}`);
  worker = spawnWorker('reflection-restart-worker', 0, true);
  await waitForMessage(worker, 'ready');
  await drain();
  await stopWorker(worker);
  const recoveredReflectionLifecycle = new LifecycleStore(database);
  const recoveredReflectionService = new MemoryReflectionService(
    database,
    recoveredReflectionLifecycle,
    recoveryExtractor,
    recoveryReflectionProvider,
    { minNewTurns: 1 },
  );
  const recoveredReflection = recoveredReflectionService.getRun(
    queuedReflection.run.id,
    'default',
  );
  if (!recoveredReflection) {
    throw new Error('Reflection 崩溃恢复后 run 丢失');
  }
  const reflectionRecovery = {
    killSignal: reflectionKillSignal,
    beforeKill: reflectionBeforeKill,
    runStatus: recoveredReflection.status,
    jobStatus: recoveredReflectionLifecycle.getJob(
      `reflection-run:${queuedReflection.run.id}`,
    )?.status,
    jobAttempts: recoveredReflectionLifecycle.getJob(
      `reflection-run:${queuedReflection.run.id}`,
    )?.attempts,
    checkpointCount: recoveredReflectionService.status(
      'default',
      'personal',
    ).checkpoints.length,
    modelCallStatuses: recoveredReflectionService.modelCalls(
      queuedReflection.run.id,
      'default',
    ).map((call) => call.status).sort(),
    eventTypes: recoveredReflectionService.runEvents(
      queuedReflection.run.id,
      'default',
    ).map((event) => event.eventType),
  };

  const finalCounts = {
    incompleteOutbox: count(
      `SELECT COUNT(*) AS count
       FROM outbox_events
       WHERE status != 'completed'`,
    ),
    incompleteJobs: count(
      `SELECT COUNT(*) AS count
       FROM memory_jobs
       WHERE status != 'completed'`,
    ),
    deadLetters: count(
      'SELECT COUNT(*) AS count FROM dead_letter_jobs',
    ),
    duplicateStableKeys: count(
      `SELECT COUNT(*) AS count
       FROM (
         SELECT stable_key
         FROM memory_items
         WHERE status = 'active'
         GROUP BY stable_key
         HAVING COUNT(*) > 1
       )`,
    ),
  };
  const extractJob = database
    .prepare(
      `SELECT status, attempts
       FROM memory_jobs
       WHERE job_type = 'extract_turn'`,
    )
    .get();
  const integrity = String(
    database.prepare('PRAGMA integrity_check').get()
      ?.integrity_check || '',
  );
  const foreignKeyViolations =
    database.prepare('PRAGMA foreign_key_check').all().length;
  const passed =
    committedBeforeKill.sessions === 1 &&
    committedBeforeKill.turns === 2 &&
    committedBeforeKill.outbox === 1 &&
    runningBeforeKill?.status === 'running' &&
    Number(runningBeforeKill?.attempts) === 1 &&
    runningBeforeKill?.lease_owner === 'crash-worker' &&
    Date.parse(String(runningBeforeKill?.lease_until)) > Date.now() &&
    extractionBeforeKill?.status === 'running' &&
    killSignal === 'SIGKILL' &&
    committedAfterRestart.sessions === 1 &&
    committedAfterRestart.turns === 2 &&
    committedAfterRestart.outbox === 1 &&
    committedAfterRestart.candidates === 0 &&
    JSON.stringify(beforeReplay) === JSON.stringify(afterReplay) &&
    afterReplay.turns === 2 &&
    afterReplay.extractionRuns === 1 &&
    afterReplay.candidates === 1 &&
    afterReplay.memories === 1 &&
    afterReplay.versions === 1 &&
    afterReplay.evidence === 1 &&
    extractJob?.status === 'completed' &&
    Number(extractJob?.attempts) === 2 &&
    finalCounts.incompleteOutbox === 0 &&
    finalCounts.incompleteJobs === 0 &&
    finalCounts.deadLetters === 0 &&
    finalCounts.duplicateStableKeys === 0 &&
    reflectionRecovery.killSignal === 'SIGKILL' &&
    reflectionRecovery.beforeKill.run?.status === 'running' &&
    reflectionRecovery.beforeKill.run?.lease_owner ===
      'crashed-reflection-worker' &&
    reflectionRecovery.beforeKill.job?.status === 'running' &&
    reflectionRecovery.beforeKill.job?.lease_owner ===
      'crashed-reflection-worker' &&
    reflectionRecovery.beforeKill.reservedCalls === 1 &&
    reflectionRecovery.runStatus === 'completed' &&
    reflectionRecovery.jobStatus === 'completed' &&
    reflectionRecovery.jobAttempts === 2 &&
    reflectionRecovery.checkpointCount === 1 &&
    JSON.stringify(reflectionRecovery.modelCallStatuses) ===
      JSON.stringify(['completed', 'failed']) &&
    JSON.stringify(reflectionRecovery.eventTypes) === JSON.stringify([
      'queued',
      'started',
      'model_call_reserved',
      'model_call_failed',
      'started',
      'model_call_reserved',
      'model_call_completed',
      'completed',
    ]) &&
    integrity === 'ok' &&
    foreignKeyViolations === 0;
  const report = {
    passed,
    killSignal,
    leaseFastForwardedAfterObservedFutureLease: true,
    committedBeforeKill,
    runningBeforeKill,
    extractionBeforeKill,
    committedAfterRestart,
    beforeReplay,
    afterReplay,
    extractJob,
    reflectionRecovery,
    finalCounts,
    integrity,
    foreignKeyViolations,
    isolatedDatabaseRemovedOnExit: !keepArtifacts,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await stopWorker(worker);
  database.close();
  if (!keepArtifacts) {
    fs.rmSync(directory, { recursive: true, force: true });
  } else {
    console.error(`保留 crash recovery 隔离目录：${directory}`);
  }
}
