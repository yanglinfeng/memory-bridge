import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  FORBIDDEN_PORTS,
  LIFECYCLE_PHASES,
  assertSafeLoopbackPort,
  buildVNextBundle,
  createLifecycleRunLayout,
  publicLifecycleSummary,
  queueActivitySnapshot,
  runWithWatchdog,
  transactionResidueCount,
} from '../scripts/qa-pinokio-lifecycle.mjs';
import { assertOwnedPinokioBundle } from '../scripts/build-pinokio-bundle-lib.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const runnerPath = path.join(projectRoot, 'scripts', 'qa-pinokio-lifecycle.mjs');
const canonicalBundle = path.join(
  projectRoot,
  'packaging',
  'pinokio',
  'memory-bridge',
  'bundle',
);

test('lifecycle QA runner 保持可执行 JavaScript', () => {
  const result = spawnSync(process.execPath, ['--check', runnerPath], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('合同固定完整阶段顺序并禁止生产与已知夹具端口', () => {
  assert.deepEqual(LIFECYCLE_PHASES, [
    'install',
    'start-v1',
    'doctor-v1',
    'mcp-data',
    'seven-tool-smoke',
    'business-hash-before',
    'backup',
    'stop-v1',
    'local-update-vnext',
    'start-vnext',
    'doctor-vnext',
    'stop-vnext',
    'uninstall-preserve-data',
    'reinstall-lineage',
    'restore-one-shot',
    'start-restored',
    'doctor-restored',
    'verify-restored',
    'stop-restored',
  ]);
  assert.deepEqual([...FORBIDDEN_PORTS].sort((a, b) => a - b), [3789, 42003]);
  assert.throws(() => assertSafeLoopbackPort(3789), /forbidden/u);
  assert.throws(() => assertSafeLoopbackPort(42003), /forbidden/u);
  assert.equal(assertSafeLoopbackPort(43177), 43177);
});

test('run layout 为 0700 且 receipts 为 0600', () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lifecycle-layout-'));
  try {
    const layout = createLifecycleRunLayout(parent);
    assert.equal(fs.statSync(layout.runRoot).mode & 0o777, 0o700);
    for (const directory of [layout.launcherRoot, layout.receiptsDir, layout.workDir]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
    fs.writeFileSync(path.join(layout.receiptsDir, 'probe.json'), '{}\n', {
      mode: 0o600,
    });
    assert.equal(
      fs.statSync(path.join(layout.receiptsDir, 'probe.json')).mode & 0o777,
      0o600,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('watchdog 有界终止子进程并执行 finally cleanup', async () => {
  let cleaned = false;
  await assert.rejects(
    runWithWatchdog(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        cwd: projectRoot,
        timeoutMs: 50,
        cleanup: async () => { cleaned = true; },
      },
    ),
    /watchdog timeout/u,
  );
  assert.equal(cleaned, true);
});

test('vNext canonical source marker 有效且 fingerprint 必须变化', () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lifecycle-vnext-'));
  try {
    const destination = path.join(parent, 'bundle');
    const before = assertOwnedPinokioBundle(canonicalBundle).fingerprint;
    const created = buildVNextBundle(canonicalBundle, destination, 'contract-test');
    const after = assertOwnedPinokioBundle(destination).fingerprint;
    assert.equal(created.beforeFingerprint, before);
    assert.equal(created.afterFingerprint, after);
    assert.notEqual(after, before);
    assert.equal(
      fs.existsSync(path.join(destination, '.memory-bridge-vnext.json')),
      false,
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('public summary 只允许 status/count/hash/P95，拒绝秘密和正文', () => {
  const summary = publicLifecycleSummary({
    status: 'blocked',
    phaseStatuses: { install: 'pass', 'restore-one-shot': 'blocked' },
    counts: { principals: 2, memories: 4 },
    hashes: { before: 'a'.repeat(64), after: 'a'.repeat(64) },
    p95Ms: { mcp: 123 },
  });
  assert.deepEqual(Object.keys(summary).sort(), [
    'counts', 'hashes', 'p95Ms', 'phaseStatuses', 'status',
  ]);
  for (const unsafe of [
    { token: 'secret' },
    { nonce: 'a'.repeat(64) },
    { hmacSha256: 'b'.repeat(64) },
    { chatContents: ['private body'] },
  ]) {
    assert.throws(
      () => publicLifecycleSummary({ ...summary, ...unsafe }),
      /unsafe summary field/u,
    );
  }
});

test('queue idle gate 忽略未来 scheduled pending，只阻塞已到期任务', () => {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lifecycle-queue-'));
  try {
    const databasePath = path.join(parent, 'queue.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE outbox_events (status TEXT NOT NULL);
      CREATE TABLE memory_jobs (status TEXT NOT NULL, available_at TEXT NOT NULL);
      INSERT INTO outbox_events VALUES ('completed');
      INSERT INTO memory_jobs VALUES ('completed', datetime('now'));
      INSERT INTO memory_jobs VALUES ('pending', datetime('now', '+1 hour'));
    `);
    database.close();
    assert.deepEqual(queueActivitySnapshot(databasePath), {
      openOutbox: 0,
      activeJobs: 0,
    });
    const changed = new DatabaseSync(databasePath);
    changed.exec("INSERT INTO memory_jobs VALUES ('pending', datetime('now', '-1 second'))");
    changed.close();
    assert.deepEqual(queueActivitySnapshot(databasePath), {
      openOutbox: 0,
      activeJobs: 1,
    });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('transaction residue gate counts restore and backup SQLite sidecars', () => {
  const parent = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'lifecycle-sidecar-residue-'),
  );
  try {
    const dataDir = path.join(parent, 'launcher', 'state', 'data');
    const backupsDir = path.join(parent, 'launcher', 'state', 'backups');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    const uuid = '11111111-1111-4111-8111-111111111111';
    const residue = [
      path.join(dataDir, `.memory-bridge.restore-stage-${uuid}.sqlite3`),
      path.join(dataDir, `.memory-bridge.restore-stage-${uuid}.sqlite3-wal`),
      path.join(dataDir, `.memory-bridge.restore-stage-${uuid}.sqlite3-shm`),
      path.join(
        dataDir,
        `.memory-bridge.pre-restore-rollback-${uuid}.sqlite3-wal`,
      ),
      path.join(
        backupsDir,
        `backup-20260812000000000-${uuid}.sqlite3-shm`,
      ),
      path.join(
        backupsDir,
        `pre-restore-20260812000000000-${uuid}.sqlite3-wal`,
      ),
    ];
    for (const filePath of residue) fs.writeFileSync(filePath, 'fixture');
    fs.writeFileSync(
      path.join(dataDir, 'memory-bridge.sqlite3-wal'),
      'current database sidecar is not transaction residue',
    );

    assert.equal(transactionResidueCount(parent), residue.length);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
