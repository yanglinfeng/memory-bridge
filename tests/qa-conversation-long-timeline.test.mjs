import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../dist/server/database.js';
import {
  convergenceSnapshot,
  databaseSnapshot,
  parseRunnerConfig,
  persistenceFingerprint,
} from '../scripts/qa-conversation-long-timeline.mjs';

test('长期会话 runner CLI 只接受无参数或绝对 resume root', () => {
  assert.deepEqual(parseRunnerConfig([]), { resumeRoot: null });
  assert.deepEqual(
    parseRunnerConfig(['--resume', '/private/tmp/run-safe']),
    { resumeRoot: '/private/tmp/run-safe' },
  );
  assert.throws(
    () => parseRunnerConfig(['--resume', 'relative/run']),
    /绝对/u,
  );
  assert.throws(() => parseRunnerConfig(['--unknown']), /用法/u);
});

test('空 schema 37 可执行收敛快照并在关闭重开后保持指纹', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'long-timeline-runner-contract-'),
  );
  const databasePath = path.join(directory, 'memory-bridge.sqlite3');
  let database = openDatabase(databasePath);
  try {
    const convergence = convergenceSnapshot(database);
    assert.equal(convergence.nonFutureOpenOutbox, 0);
    assert.equal(convergence.nonFutureOpenJobs, 0);
    assert.deepEqual(convergence.outboxByStatus, []);
    assert.deepEqual(convergence.jobsByTypeAndStatus, []);

    const before = databaseSnapshot(database, databasePath);
    const beforeFingerprint = persistenceFingerprint(before);
    assert.equal(before.integrity, 'ok');
    assert.equal(before.foreignKeyViolations, 0);
    database.close();
    database = null;

    database = openDatabase(databasePath);
    const after = databaseSnapshot(database, databasePath);
    assert.equal(persistenceFingerprint(after), beforeFingerprint);
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('收敛快照区分未来周期任务、重试和未到期租约', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'long-timeline-convergence-leases-'),
  );
  const databasePath = path.join(directory, 'memory-bridge.sqlite3');
  const database = openDatabase(databasePath);
  const at = '2026-01-01T00:00:00.000Z';
  const future = '2026-01-02T00:00:00.000Z';
  const insertJob = database.prepare(
    `INSERT INTO memory_jobs (
       id, job_type, user_id, namespace, status, available_at, lease_until,
       created_at, updated_at
     ) VALUES (?, ?, 'lease-user', 'lease-test', ?, ?, ?, ?, ?)`,
  );
  const insertOutbox = database.prepare(
    `INSERT INTO outbox_events (
       id, aggregate_type, aggregate_id, event_type, status, available_at,
       lease_until, created_at
     ) VALUES (?, 'lease-test', ?, 'lease-event', ?, ?, ?, ?)`,
  );
  try {
    insertJob.run(
      'future-recurring',
      'reflection_sweep',
      'pending',
      future,
      null,
      at,
      at,
    );
    let snapshot = convergenceSnapshot(database, at);
    assert.equal(snapshot.totalOpenJobs, 1);
    assert.equal(snapshot.nonFutureOpenJobs, 0);
    assert.equal(snapshot.blockingOpenJobs, 0);
    database.prepare('DELETE FROM memory_jobs').run();

    insertJob.run(
      'future-ordinary',
      'extract_memory',
      'pending',
      future,
      null,
      at,
      at,
    );
    snapshot = convergenceSnapshot(database, at);
    assert.equal(snapshot.nonFutureOpenJobs, 0);
    assert.equal(snapshot.blockingOpenJobs, 1);
    database.prepare('DELETE FROM memory_jobs').run();

    insertJob.run(
      'future-failed',
      'extract_memory',
      'failed',
      future,
      null,
      at,
      at,
    );
    snapshot = convergenceSnapshot(database, at);
    assert.equal(snapshot.nonFutureOpenJobs, 0);
    assert.equal(snapshot.blockingOpenJobs, 1);
    assert.equal(snapshot.retryingJobs, 1);
    database.prepare('DELETE FROM memory_jobs').run();

    insertJob.run(
      'leased-running',
      'extract_memory',
      'running',
      at,
      future,
      at,
      at,
    );
    insertOutbox.run(
      'leased-processing',
      'leased-processing',
      'processing',
      at,
      future,
      at,
    );
    snapshot = convergenceSnapshot(database, at);
    assert.equal(snapshot.nonFutureOpenJobs, 0);
    assert.equal(snapshot.nonFutureOpenOutbox, 0);
    assert.equal(snapshot.blockingOpenJobs, 1);
    assert.equal(snapshot.blockingOpenOutbox, 1);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
