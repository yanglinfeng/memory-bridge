import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherRoot = path.join(projectRoot, 'packaging', 'pinokio', 'memory-bridge');
const requireFromTest = createRequire(import.meta.url);

function launcherPath(relativePath) {
  return path.join(launcherRoot, relativePath);
}

function readLauncherSource(relativePath) {
  const filePath = launcherPath(relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

const lifecycleLibrary = readLauncherSource(
  path.join('bundle', 'scripts', 'memory-bridge-lifecycle-lib.mjs'),
);
const lifecycleCli = readLauncherSource(
  path.join('bundle', 'scripts', 'memory-bridge-lifecycle.mjs'),
);

test('release tree and Pinokio menus expose the managed lifecycle selectors', () => {
  const pinokioSource = fs.readFileSync(launcherPath('pinokio.js'), 'utf8');
  const requiredSelectors = [
    'stop.js',
    'backup.js',
    'restore.js',
  ];
  const requiredMenuTargets = [
    'stop.js',
    'doctor.js',
    'backup.js',
    'update.js',
    'uninstall.js',
    'restore.js',
    'install.js',
  ];

  const missingSelectors = requiredSelectors.filter(
    (selector) => !fs.existsSync(launcherPath(selector)),
  );
  const missingMenuTargets = requiredMenuTargets.filter(
    (selector) => !new RegExp(`href:\\s*["']${selector.replace('.', '\\.')}["']`, 'u')
      .test(pinokioSource),
  );

  assert.deepEqual(
    { missingSelectors, missingMenuTargets },
    { missingSelectors: [], missingMenuTargets: [] },
    'reset.js is not a restore selector; release and menu entries must name restore.js explicitly',
  );
});

test('stop uses a managed Pinokio stop path with ownership verification', () => {
  const stopSource = readLauncherSource('stop.js');
  const lifecycleSource = `${lifecycleLibrary}\n${lifecycleCli}`;
  const usesLifecycleStop = /memory-bridge-lifecycle\.mjs\s+stop/u.test(stopSource);
  const usesOfficialStop = /method:\s*["']shell\.stop["']/u.test(stopSource) ||
    usesLifecycleStop;
  const ownershipPreflight = /(?:ownership|installId|assertManaged|preflight)/iu
    .test(usesLifecycleStop ? lifecycleSource : stopSource);
  const stopVerification = /(?:verify|postflight|stopped|assertServiceStopped)/iu
    .test(usesLifecycleStop ? lifecycleSource : stopSource);
  const killsProtectedPort = /(?:lsof|fuser|p?kill)[^\n]{0,120}\b3789\b|\b3789\b[^\n]{0,120}p?kill/iu
    .test(stopSource);
  const violations = [];

  if (!stopSource) violations.push('stop.js is missing');
  if (!usesOfficialStop) {
    violations.push('stop does not call shell.stop or the managed lifecycle stop command');
  }
  if (!ownershipPreflight) violations.push('stop lacks an ownership preflight');
  if (!stopVerification) violations.push('stop lacks post-stop verification');
  if (killsProtectedPort) violations.push('stop targets protected port 3789 with a port kill');

  assert.deepEqual(violations, []);
});

test('Pinokio factories persist one runtime identity and stop the exact managed group', async () => {
  const startPath = launcherPath('start.js');
  const stopPath = launcherPath('stop.js');
  const updatePath = launcherPath('update.js');
  const appRoot = launcherPath('app');
  const runtimePort = 45678;
  const startFactory = requireFromTest(startPath);
  const stopFactory = requireFromTest(stopPath);
  const updateFactory = requireFromTest(updatePath);
  const start = await startFactory({ port: async () => runtimePort });
  const shellRun = start.run.find((step) => step.method === 'shell.run');
  const localSet = start.run.find((step) => step.method === 'local.set');

  assert.equal(shellRun.params.group, startPath);
  assert.equal(localSet.params.pid, '{{input.pid}}');
  assert.equal(localSet.params.cwd, appRoot);
  assert.equal(localSet.params.group, shellRun.params.group);
  assert.equal(localSet.params.port, runtimePort);

  const runtime = {
    pid: 4242,
    cwd: appRoot,
    group: shellRun.params.group,
    port: runtimePort,
    url: `http://127.0.0.1:${runtimePort}/`,
  };
  const stop = await stopFactory({
    running: async () => true,
    memory: { local: { [startPath]: runtime } },
  });
  const shellStop = stop.run.find((step) => step.method === 'shell.stop');
  const preflight = stop.run.find((step) =>
    step.method === 'shell.run' && /--phase preflight/u.test(step.params.message[0]));
  assert.equal(shellStop.params.group, shellRun.params.group);
  assert.match(preflight.params.message[0], /--pid 4242/u);
  assert.match(preflight.params.message[0], /--ready-url/u);

  await assert.rejects(
    stopFactory({
      running: async () => true,
      memory: { local: { [startPath]: { ...runtime, group: 'foreign-group' } } },
    }),
    /group.*不匹配|未知 owner/u,
  );
  await assert.rejects(
    updateFactory({ running: async () => true }),
    /运行中.*拒绝升级/u,
  );
});

test('source and bundled lifecycle entrypoints remain byte-identical', () => {
  assert.equal(
    fs.readFileSync(path.join(projectRoot, 'scripts', 'memory-bridge-lifecycle.mjs'), 'utf8'),
    lifecycleCli,
  );
  assert.equal(
    fs.readFileSync(path.join(projectRoot, 'scripts', 'memory-bridge-lifecycle-lib.mjs'), 'utf8'),
    lifecycleLibrary,
  );
});

test('backup and restore lock the integrity and atomic recovery contract', () => {
  const backupSelector = readLauncherSource('backup.js');
  const restoreSelector = readLauncherSource('restore.js');
  const source = `${backupSelector}\n${restoreSelector}\n${lifecycleLibrary}\n${lifecycleCli}`;
  const violations = [];

  if (!backupSelector) violations.push('backup.js is missing');
  if (!restoreSelector) violations.push('restore.js is missing');
  if (!/memory-bridge-lifecycle\.mjs\s+backup/u.test(backupSelector)) {
    violations.push('backup selector is not wired to the managed lifecycle CLI');
  }
  if (!/memory-bridge-lifecycle\.mjs\s+restore/u.test(restoreSelector)) {
    violations.push('restore selector is not wired to the managed lifecycle CLI');
  }
  if (!/(?:backup[^\n]{0,120}manifest|manifest[^\n]{0,120}backup)/iu.test(source)) {
    violations.push('backup lacks a dedicated manifest');
  }
  if (!/(?:flag:\s*["']wx["']|openSync\([^\n]+["']wx["'])/u.test(source)) {
    violations.push('backup manifest is not exclusively created');
  }
  if (!/(?:sha256|sha-256)/iu.test(source)) violations.push('backup lacks SHA-256');
  if (!/(?:0o600|0600)/u.test(source)) violations.push('backup lacks mode 0600');
  if (!/(?:await\s+backup\(|VACUUM\s+INTO)/iu.test(source)) {
    violations.push('backup is not SQLite-consistent');
  }
  if (!/(?:assertServiceStopped|requireServiceStopped|service[^\n]{0,80}stopped|服务[^\n]{0,80}停止)/iu
    .test(source)) {
    violations.push('restore does not require a stopped service');
  }
  if (!/pre-restore|preRestore/iu.test(source)) {
    violations.push('restore lacks a pre-restore backup');
  }
  if (!/PRAGMA\s+integrity_check/iu.test(source)) {
    violations.push('restore lacks SQLite integrity_check');
  }
  if (!/PRAGMA\s+foreign_key_check/iu.test(source)) {
    violations.push('restore lacks SQLite foreign_key_check');
  }
  if (!/(?:verify[^\n]{0,100}(?:sha|hash)|(?:sha|hash)[^\n]{0,100}(?:verify|mismatch|match))/iu
    .test(source)) {
    violations.push('restore does not verify the backup hash');
  }
  if (!/(?:pre-restore[^\n]{0,160}rollback|rollback[^\n]{0,160}pre-restore|BEGIN\s+IMMEDIATE)/iu
    .test(source)) {
    violations.push('restore lacks atomic failure rollback');
  }

  assert.deepEqual(violations, []);
});

test('update stops or fails closed while running and rejects fake upgrades', () => {
  const updateSelector = readLauncherSource('update.js');
  const updateSource = readLauncherSource('update-source.js');
  const updateContract = `${updateSelector}\n${lifecycleLibrary}\n${lifecycleCli}`;
  const safeRunningPolicy = /(?:stop\.js|shell\.stop|assertServiceStopped|requireServiceStopped|failIfServiceRunning|serviceRunning|服务运行中[^\n]{0,80}拒绝|运行中[^\n]{0,80}(?:停止|拒绝))/iu
    .test(updateContract);
  const noSourceFailsClosed = /没有(?:可用更新源|可信 Git origin)[^\n]{0,120}拒绝升级/iu
    .test(updateSource);
  const sameFingerprintFailsClosed = /fingerprint/iu.test(updateSource) &&
    /(?:完全相同|没有新版本|没有带来新的 bundle|拒绝伪升级)/iu.test(updateSource);

  assert.deepEqual(
    { safeRunningPolicy, noSourceFailsClosed, sameFingerprintFailsClosed },
    {
      safeRunningPolicy: true,
      noSourceFailsClosed: true,
      sameFingerprintFailsClosed: true,
    },
  );
});
