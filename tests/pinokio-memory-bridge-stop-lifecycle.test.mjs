import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve(
  'packaging/pinokio/memory-bridge/bundle/scripts/memory-bridge-lifecycle.mjs',
);

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function managedFixture(root) {
  const source = path.join(root, 'source');
  const installRoot = path.join(root, 'launcher', 'app');
  const stateDir = path.join(root, 'launcher', 'state');
  const dataDir = path.join(stateDir, 'data');
  const installId = 'stop-test-install';
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  writeJson(path.join(source, 'package.json'), { name: 'memory-bridge' });
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
  return { source, installRoot, stateDir, installId };
}

async function startHealthService(cwd, identity = {
  ok: true,
  service: 'memory-bridge',
  mcpTransport: 'stdio',
}) {
  const source = `
    const http = require('node:http');
    const identity = ${JSON.stringify(identity)};
    const server = http.createServer((request, response) => {
      if (request.url !== '/api/health') {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(identity));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
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

async function startCredentialEnabledMemoryBridge(cwd, databasePath) {
  const databaseModule = new URL('../src/server/database.ts', import.meta.url).href;
  const httpServerModule = new URL('../src/server/http-server.ts', import.meta.url).href;
  const identityModule = new URL('../src/server/identity.ts', import.meta.url).href;
  const memoryStoreModule = new URL('../src/server/memory-store.ts', import.meta.url).href;
  const source = `
    import { openDatabase } from ${JSON.stringify(databaseModule)};
    import { createHttpServer } from ${JSON.stringify(httpServerModule)};
    import { IdentityService } from ${JSON.stringify(identityModule)};
    import { MemoryStore } from ${JSON.stringify(memoryStoreModule)};

    const database = openDatabase(${JSON.stringify(databasePath)});
    const identity = new IdentityService(database, { defaultPrincipalId: 'default' });
    void identity.issueCredential({
      principalId: 'default',
      label: 'stop-preflight-lifecycle',
    });
    const server = createHttpServer(new MemoryStore(database), {
      identityService: identity,
    });
    server.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ port: server.address().port }));
    });
    process.on('SIGTERM', () => {
      server.close(() => {
        database.close();
        process.exit(0);
      });
    });
  `;
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', source,
  ], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += String(data); });
  const [chunk] = await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'error').then(([error]) => Promise.reject(error)),
    once(child, 'exit').then(([code, signal]) => {
      throw new Error(
        `Memory Bridge exited before ready (code=${code}, signal=${signal}): ${stderr}`,
      );
    }),
  ]);
  const ready = JSON.parse(String(chunk).trim());
  return { child, port: Number(ready.port) };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

test('managed stop preflight accepts anonymous health after credential history', async () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-stop-credential-health-'),
  );
  const fixture = managedFixture(root);
  let child;
  try {
    const service = await startCredentialEnabledMemoryBridge(
      fixture.installRoot,
      path.join(fixture.stateDir, 'data', 'memory-bridge.sqlite3'),
    );
    child = service.child;
    const readyUrl = `http://127.0.0.1:${service.port}/`;
    const preflight = spawnSync(process.execPath, [
      cli, 'stop', '--phase', 'preflight',
      '--source', fixture.source,
      '--install-root', fixture.installRoot,
      '--state-dir', fixture.stateDir,
      '--pid', String(child.pid),
      '--cwd', fixture.installRoot,
      '--ready-url', readyUrl,
    ], { encoding: 'utf8' });

    assert.equal(preflight.status, 0, preflight.stderr);
    assert.match(preflight.stdout, /stop-preflight-passed/u);
    const authorizationPath = path.join(
      fixture.stateDir,
      'stop-authorization.json',
    );
    assert.equal(fs.statSync(authorizationPath).mode & 0o777, 0o600);
    const authorization = JSON.parse(
      fs.readFileSync(authorizationPath, 'utf8'),
    );
    assert.equal(authorization.status, 'pending');
    assert.equal(authorization.installId, fixture.installId);
    assert.equal(authorization.pid, child.pid);
    assert.equal(authorization.readyUrl, new URL(readyUrl).origin);
  } finally {
    await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed stop preflight and bounded postflight fail closed', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-stop-'));
  const fixture = managedFixture(root);
  const foreignCwd = path.join(root, 'foreign');
  fs.mkdirSync(foreignCwd);
  let child;
  let mismatchedListener;
  let spoofedCwd;
  let foreignIdentity;
  try {
    const service = await startHealthService(fixture.installRoot);
    child = service.child;
    const readyUrl = `http://127.0.0.1:${service.port}/`;
    const receiptFile = path.join(
      fixture.stateDir,
      'receipts',
      'stop-postflight.latest.json',
    );
    const base = [
      cli, 'stop', '--source', fixture.source, '--install-root', fixture.installRoot,
      '--state-dir', fixture.stateDir, '--pid', String(child.pid),
      '--cwd', fixture.installRoot, '--ready-url', readyUrl,
    ];
    const run = (phase, additions = []) => spawnSync(
      process.execPath,
      [...base, '--phase', phase, ...additions],
      { encoding: 'utf8' },
    );

    const preflight = run('preflight');
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.match(preflight.stdout, /stop-preflight-passed/u);

    mismatchedListener = await startHealthService(fixture.installRoot);
    const pidListenerMismatch = spawnSync(process.execPath, [
      ...base, '--phase', 'preflight', '--pid', String(mismatchedListener.child.pid),
    ], { encoding: 'utf8' });
    assert.equal(pidListenerMismatch.status, 1);
    assert.match(pidListenerMismatch.stderr, /listener PID.*不一致|PID.*listener/u);

    spoofedCwd = await startHealthService(foreignCwd);
    const claimedManagedCwd = spawnSync(process.execPath, [
      ...base, '--phase', 'preflight', '--pid', String(spoofedCwd.child.pid),
      '--ready-url', `http://127.0.0.1:${spoofedCwd.port}/`,
    ], { encoding: 'utf8' });
    assert.equal(claimedManagedCwd.status, 1);
    assert.match(claimedManagedCwd.stderr, /真实 cwd|process cwd/u);

    foreignIdentity = await startHealthService(fixture.installRoot, {
      ok: true,
      service: 'foreign-service',
      mcpTransport: 'stdio',
    });
    const wrongIdentity = spawnSync(process.execPath, [
      ...base, '--phase', 'preflight', '--pid', String(foreignIdentity.child.pid),
      '--ready-url', `http://127.0.0.1:${foreignIdentity.port}/`,
    ], { encoding: 'utf8' });
    assert.equal(wrongIdentity.status, 1);
    assert.match(wrongIdentity.stderr, /服务身份不是 Memory Bridge/u);

    const foreign = spawnSync(process.execPath, [
      ...base, '--phase', 'preflight', '--cwd', foreignCwd,
    ], { encoding: 'utf8' });
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /foreign owner/u);

    const nonLoopback = spawnSync(process.execPath, [
      ...base, '--phase', 'preflight', '--ready-url', `http://192.0.2.1:${service.port}/`,
    ], { encoding: 'utf8' });
    assert.equal(nonLoopback.status, 1);
    assert.match(nonLoopback.stderr, /127\.0\.0\.1/u);

    const protectedPortSample = spawnSync(process.execPath, [
      ...base, '--phase', 'preflight', '--cwd', foreignCwd,
      '--ready-url', 'http://127.0.0.1:3789/',
    ], { encoding: 'utf8' });
    assert.equal(protectedPortSample.status, 1);
    assert.match(protectedPortSample.stderr, /3789.*拒绝|受保护端口/u);
    assert.equal(child.exitCode, null);
    assert.doesNotThrow(() => process.kill(child.pid, 0));

    const missing = spawnSync(process.execPath, [cli, 'stop'], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /缺少必填参数/u);
    const unknown = run('preflight', ['--unknown']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /未知参数/u);

    const postflightArguments = ['--verify-stopped', '--receipt-file', receiptFile];
    const stillAlive = run('postflight', postflightArguments);
    assert.equal(stillAlive.status, 1);
    assert.match(stillAlive.stderr, /仍存活|postflight verify failed/u);
    assert.equal(child.exitCode, null);
    assert.equal(fs.existsSync(receiptFile), false);

    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
    const stopped = run('postflight', postflightArguments);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stop-postflight-verified/u);
    assert.equal(fs.statSync(receiptFile).mode & 0o777, 0o600);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.format, 'memory-bridge-stop-postflight:v2');
    assert.equal(receipt.package, 'memory-bridge');
    assert.equal(receipt.installId, fixture.installId);
    assert.equal(receipt.pid, child.pid);
    assert.equal(receipt.cwd, fs.realpathSync(fixture.installRoot));
    assert.equal(receipt.readyUrl, new URL(readyUrl).origin);
    assert.equal(
      receipt.databasePath,
      path.join(fixture.stateDir, 'data', 'memory-bridge.sqlite3'),
    );
    assert.equal(Number.isFinite(Date.parse(receipt.verifiedAt)), true);
    assert.equal(/^[a-f0-9]{64}$/u.test(String(receipt.nonce || '')), true);
    assert.equal(/^[a-f0-9]{64}$/u.test(String(receipt.hmacSha256 || '')), true);
    const authorization = JSON.parse(fs.readFileSync(
      path.join(fixture.stateDir, 'stop-authorization.json'),
      'utf8',
    ));
    assert.equal(authorization.status, 'issued');
    assert.equal(authorization.installId, fixture.installId);
  } finally {
    await Promise.all([
      stopChild(child),
      stopChild(mismatchedListener?.child),
      stopChild(spoofedCwd?.child),
      stopChild(foreignIdentity?.child),
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
