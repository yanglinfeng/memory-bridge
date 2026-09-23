import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  createDatabaseBackup,
  installProject,
  restoreDatabaseBackup,
  uninstallProject,
  verifyStopLifecycle,
} from '../scripts/memory-bridge-lifecycle-lib.mjs';

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function managedFixture(root) {
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'launcher', 'app');
  const stateDir = path.join(root, 'launcher', 'state');
  const dataDir = path.join(stateDir, 'data');
  const receiptDir = path.join(stateDir, 'receipts');
  const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
  const installId = 'restore-trust-install';
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.join(source, 'dist', 'server'), { recursive: true });
  fs.mkdirSync(path.join(source, 'dist', 'web'), { recursive: true });
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(receiptDir, { recursive: true });
  writeJson(path.join(source, 'package.json'), { name: 'memory-bridge', version: '1.0.0' });
  writeJson(path.join(source, 'package-lock.json'), {
    name: 'memory-bridge',
    version: '1.0.0',
    lockfileVersion: 3,
  });
  fs.writeFileSync(path.join(source, 'dist', 'server', 'index.js'), 'fixture');
  fs.writeFileSync(path.join(source, 'dist', 'server', 'mcp-stdio.js'), 'fixture');
  fs.writeFileSync(path.join(source, 'dist', 'web', 'index.html'), 'fixture');
  fs.writeFileSync(path.join(source, 'src', 'index.ts'), 'fixture');
  writeJson(path.join(installRoot, 'package.json'), { name: 'memory-bridge' });
  writeJson(path.join(installRoot, '.memory-bridge-managed.json'), {
    format: 'memory-bridge-managed-install:v1',
    package: 'memory-bridge',
    installId,
  });
  writeJson(path.join(stateDir, 'install.json'), {
    format: 'memory-bridge-install:v1',
    status: 'installed',
    installId,
    installRoot,
    dataDir,
  });
  fs.writeFileSync(path.join(stateDir, 'lifecycle-auth.key'), randomBytes(32), {
    mode: 0o600,
    flag: 'wx',
  });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA user_version = 31;
    CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO proof (id, value) VALUES (1, 'restore-candidate');
  `);
  database.close();
  return { source, installRoot, stateDir, databasePath, receiptDir, installId };
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function startHealthService(cwd, port = 0) {
  const source = `
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, service: 'memory-bridge', mcpTransport: 'stdio' }));
    });
    server.listen(${port}, '127.0.0.1', () => console.log(server.address().port));
    process.on('SIGTERM', () => process.exit(0));
  `;
  const child = spawn(process.execPath, ['-e', source], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [chunk] = await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'error').then(([error]) => Promise.reject(error)),
    once(child, 'exit').then(([code, signal]) => Promise.reject(
      new Error(`health service exited before ready (code=${code}, signal=${signal})`),
    )),
  ]);
  return { child, port: Number(String(chunk).trim()) };
}

async function startDatabaseHolder(cwd, databasePath) {
  const source = `
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(process.argv[1]);
    console.log('ready');
    setInterval(() => database.prepare('SELECT 1').get(), 1000);
    process.on('SIGTERM', () => { database.close(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['-e', source, databasePath], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'error').then(([error]) => Promise.reject(error)),
    once(child, 'exit').then(([code, signal]) => Promise.reject(
      new Error(`database holder exited before ready (code=${code}, signal=${signal})`),
    )),
  ]);
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

async function createFreshStopReceipt(fixture) {
  const service = await startHealthService(fixture.installRoot);
  const pid = service.child.pid;
  const readyUrl = `http://127.0.0.1:${service.port}/`;
  const identity = {
    source: fixture.source,
    installRoot: fixture.installRoot,
    stateDir: fixture.stateDir,
    pid,
    cwd: fixture.installRoot,
    readyUrl,
  };
  await verifyStopLifecycle({ ...identity, phase: 'preflight' });
  await stopChild(service.child);
  const receiptFile = path.join(fixture.receiptDir, 'stop-postflight.latest.json');
  await verifyStopLifecycle({
    ...identity,
    phase: 'postflight',
    verifyStopped: true,
    receiptFile,
  });
  return { receiptFile, pid, readyUrl, port: service.port };
}

function signStopReceipt(receipt, key) {
  const canonical = JSON.stringify({
    format: receipt.format,
    package: receipt.package,
    verifiedAt: receipt.verifiedAt,
    installId: receipt.installId,
    pid: receipt.pid,
    cwd: receipt.cwd,
    readyUrl: receipt.readyUrl,
    databasePath: receipt.databasePath,
    nonce: receipt.nonce,
  });
  return createHmac('sha256', key).update(canonical).digest('hex');
}

test('fresh verified Stop receipt permits an already-stopped restore', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-restore-receipt-'));
  try {
    const fixture = managedFixture(root);
    const backup = await createDatabaseBackup(fixture);
    const changed = new DatabaseSync(fixture.databasePath);
    changed.prepare('UPDATE proof SET value = ? WHERE id = 1').run('current-value');
    changed.close();
    const stopped = await createFreshStopReceipt(fixture);
    assert.equal(fs.existsSync(stopped.receiptFile), true);

    await restoreDatabaseBackup({
      ...fixture,
      backupPath: backup.backupPath,
      stopReceipt: stopped.receiptFile,
    });
    const restored = new DatabaseSync(fixture.databasePath, { readOnly: true });
    assert.equal(restored.prepare('SELECT value FROM proof WHERE id = 1').get().value, 'restore-candidate');
    restored.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects fake or stale receipt, live listener, and database holder without mutation', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-restore-reject-'));
  let listener;
  let holder;
  try {
    const fixture = managedFixture(root);
    const backup = await createDatabaseBackup(fixture);
    const changed = new DatabaseSync(fixture.databasePath);
    changed.prepare('UPDATE proof SET value = ? WHERE id = 1').run('must-remain');
    changed.close();
    const stopped = await createFreshStopReceipt(fixture);
    const before = sha256(fixture.databasePath);
    const validReceipt = JSON.parse(fs.readFileSync(stopped.receiptFile, 'utf8'));

    const fakeReceipt = path.join(fixture.receiptDir, 'fake.json');
    writeJson(fakeReceipt, { ...validReceipt, installId: 'foreign-install' });
    await assert.rejects(
      restoreDatabaseBackup({ ...fixture, backupPath: backup.backupPath, stopReceipt: fakeReceipt }),
      /receipt|installId|所有权/u,
    );
    assert.equal(sha256(fixture.databasePath), before);

    const staleReceipt = stopped.receiptFile;
    const stale = { ...validReceipt, verifiedAt: '2000-01-01T00:00:00.000Z' };
    stale.hmacSha256 = signStopReceipt(
      stale,
      fs.readFileSync(path.join(fixture.stateDir, 'lifecycle-auth.key')),
    );
    writeJson(staleReceipt, stale);
    const authorizationPath = path.join(fixture.stateDir, 'stop-authorization.json');
    const authorization = JSON.parse(fs.readFileSync(authorizationPath, 'utf8'));
    authorization.issuedAt = stale.verifiedAt;
    writeJson(authorizationPath, authorization);
    await assert.rejects(
      restoreDatabaseBackup({ ...fixture, backupPath: backup.backupPath, stopReceipt: staleReceipt }),
      /receipt.*过期|过期.*receipt/u,
    );
    assert.equal(sha256(fixture.databasePath), before);

    const listenerReceipt = await createFreshStopReceipt(fixture);
    listener = await startHealthService(fixture.installRoot, listenerReceipt.port);
    await assert.rejects(
      restoreDatabaseBackup({
        ...fixture,
        backupPath: backup.backupPath,
        stopReceipt: listenerReceipt.receiptFile,
      }),
      /listener|ready URL|仍在监听/u,
    );
    assert.equal(sha256(fixture.databasePath), before);
    await stopChild(listener.child);
    listener = null;

    holder = await startDatabaseHolder(fixture.installRoot, fixture.databasePath);
    await assert.rejects(
      restoreDatabaseBackup({
        ...fixture,
        backupPath: backup.backupPath,
        stopReceipt: listenerReceipt.receiptFile,
      }),
      /数据库.*holder|持有.*数据库|占用/u,
    );
    assert.equal(sha256(fixture.databasePath), before);
  } finally {
    await Promise.all([stopChild(listener?.child), stopChild(holder)]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserved-state reinstall keeps backup lineage and permits verified restore', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-reinstall-restore-'));
  try {
    const fixture = managedFixture(root);
    const backup = await createDatabaseBackup(fixture);
    await uninstallProject(fixture);
    assert.equal(fs.existsSync(fixture.databasePath), true);
    await installProject({
      ...fixture,
      skipDependencies: true,
      skipBuild: true,
    });
    const reinstalled = JSON.parse(fs.readFileSync(
      path.join(fixture.stateDir, 'install.json'),
      'utf8',
    ));
    assert.equal(reinstalled.installId, fixture.installId);

    const changed = new DatabaseSync(fixture.databasePath);
    changed.prepare('UPDATE proof SET value = ? WHERE id = 1').run('after-reinstall');
    changed.close();
    const stopped = await createFreshStopReceipt(fixture);
    await restoreDatabaseBackup({
      ...fixture,
      backupPath: backup.backupPath,
      stopReceipt: stopped.receiptFile,
    });
    const restored = new DatabaseSync(fixture.databasePath, { readOnly: true });
    assert.equal(restored.prepare('SELECT value FROM proof WHERE id = 1').get().value, 'restore-candidate');
    restored.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
