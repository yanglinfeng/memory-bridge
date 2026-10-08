import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DATA_PURGE_CONFIRMATION,
  EXPECTED_SCHEMA,
  assertManagedLayout,
  createDatabaseBackup,
  diagnoseInstallation,
  installProject,
  removeManagedSqliteTransactionFiles,
  restoreDatabaseBackup,
  uninstallProject,
  upgradeProject,
  verifyStopLifecycle,
} from '../scripts/memory-bridge-lifecycle-lib.mjs';

test('lifecycle Doctor schema gate stays synchronized with production schema', () => {
  const databaseSource = fs.readFileSync(
    new URL('../src/server/database.ts', import.meta.url),
    'utf8',
  );
  const productionSchema = databaseSource.match(
    /export const SCHEMA_VERSION = (\d+);/u,
  );
  assert.ok(productionSchema);
  assert.equal(EXPECTED_SCHEMA, Number(productionSchema[1]));
});

const requireFromTest = createRequire(import.meta.url);
const MCP_TOOL_NAMES = [
  'memory_forget',
  'memory_get_context',
  'memory_list',
  'memory_recall',
  'memory_remember',
  'memory_stats',
  'memory_update',
];

test('generated Pinokio MCP config binds the bootstrap default principal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bridge-mcp-config-'));
  try {
    const appRoot = path.join(root, 'app');
    const stateDir = path.join(root, 'state');
    const output = path.join(stateDir, 'receipts', 'mcp-config.json');
    const server = path.join(appRoot, 'dist', 'server', 'mcp-stdio.js');
    fs.mkdirSync(path.dirname(server), { recursive: true });
    fs.writeFileSync(server, '// fixture\n');

    const result = spawnSync(process.execPath, [
      fileURLToPath(
        new URL('../scripts/generate-mcp-config.mjs', import.meta.url),
      ),
      '--app-root',
      appRoot,
      '--state-dir',
      stateDir,
      '--output',
      output,
    ], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const configText = fs.readFileSync(output, 'utf8');
    const config = JSON.parse(configText);
    const environment = config.mcpServers['memory-bridge'].env;
    assert.equal(environment.MEMORY_BRIDGE_USER_ID, 'default');
    assert.equal(configText.includes('local-default'), false);
    assert.equal(
      environment.MEMORY_BRIDGE_DATA_DIR,
      path.join(stateDir, 'data'),
    );
    assert.equal(fs.statSync(path.dirname(output)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sourceBundleFingerprint(directory) {
  const hash = createHash('sha256');
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (relative === '.memory-bridge-source-bundle.json') continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(relative).update('\0').update(fs.readFileSync(absolute)).update('\n');
      }
    }
  }
  visit(directory);
  return hash.digest('hex');
}

function successfulMcpSmokeResult() {
  return {
    stdout: `${JSON.stringify({
      passed: true,
      isolated: true,
      cleanupComplete: true,
      tools: MCP_TOOL_NAMES,
      calledTools: MCP_TOOL_NAMES,
      runId: 'fixture-run',
    })}\n`,
    stderr: '',
  };
}

function createFixture(root, version, marker) {
  const source = path.join(root, `source-${version}`);
  fs.mkdirSync(path.join(source, 'dist', 'server'), { recursive: true });
  fs.mkdirSync(path.join(source, 'dist', 'web'), { recursive: true });
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'data'), { recursive: true });
  fs.mkdirSync(path.join(source, '.memory-bridge-private'), {
    recursive: true,
  });
  for (const excluded of ['.firecrawl', 'docs', 'examples', 'tests']) {
    fs.mkdirSync(path.join(source, excluded), { recursive: true });
    fs.writeFileSync(path.join(source, excluded, 'must-not-copy.txt'), marker);
  }
  for (const excluded of [
    'action-game',
    'side-scroller-game',
    'third-person-rpg',
    'unknown-large-project',
  ]) {
    fs.mkdirSync(path.join(source, excluded), { recursive: true });
    fs.writeFileSync(path.join(source, excluded, 'must-not-copy.txt'), marker);
  }
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: 'mcp-memory-bridge',
    version,
    engines: { node: '>=24' },
  }));
  fs.writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({
    name: 'mcp-memory-bridge',
    version,
    lockfileVersion: 3,
  }));
  fs.writeFileSync(path.join(source, 'dist', 'server', 'index.js'), marker);
  fs.writeFileSync(
    path.join(source, 'dist', 'server', 'mcp-stdio.js'),
    marker,
  );
  fs.writeFileSync(path.join(source, 'dist', 'web', 'index.html'), marker);
  fs.writeFileSync(path.join(source, 'src', 'marker.txt'), marker);
  fs.writeFileSync(path.join(source, 'scripts', 'mcp-doctor-smoke.mjs'), marker);
  fs.writeFileSync(path.join(source, '.env'), 'MEMORY_BRIDGE_TOKEN=must-not-copy');
  fs.writeFileSync(path.join(source, 'private.key'), 'must-not-copy');
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'must-not-copy');
  fs.writeFileSync(path.join(source, '.DS_Store'), 'must-not-copy');
  fs.writeFileSync(path.join(source, 'src', '.DS_Store'), 'must-not-copy');
  fs.writeFileSync(path.join(source, 'data', 'must-not-copy.sqlite3'), marker);
  fs.writeFileSync(
    path.join(source, '.memory-bridge-private', 'secret.txt'),
    marker,
  );
  return source;
}

function testOptions(root) {
  return {
    installRoot: path.join(root, 'launcher', 'app'),
    stateDir: path.join(root, 'launcher', 'state'),
    skipDependencies: true,
    skipBuild: true,
  };
}

async function createVerifiedStopReceipt({ source, installRoot, stateDir }) {
  const service = spawn(process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      if (request.url !== '/api/health') return response.writeHead(404).end();
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ok: true,
        service: 'memory-bridge',
        mcpTransport: 'stdio',
      }));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `], {
    cwd: installRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [chunk] = await Promise.race([
    once(service.stdout, 'data'),
    once(service, 'error').then(([error]) => Promise.reject(error)),
    once(service, 'exit').then(([code, signal]) => Promise.reject(
      new Error(`stop fixture exited before ready (code=${code}, signal=${signal})`),
    )),
  ]);
  const port = Number(String(chunk).trim());
  const receiptFile = path.join(stateDir, 'receipts', 'stop-postflight.latest.json');
  const identity = {
    source,
    installRoot,
    stateDir,
    pid: service.pid,
    cwd: installRoot,
    readyUrl: `http://127.0.0.1:${port}/`,
  };
  await verifyStopLifecycle({ ...identity, phase: 'preflight' });
  const exited = once(service, 'exit');
  service.kill('SIGTERM');
  await exited;
  await verifyStopLifecycle({
    ...identity,
    phase: 'postflight',
    verifyStopped: true,
    receiptFile,
  });
  return receiptFile;
}

function databaseSha256(databasePath) {
  return createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
}

function initializeWalProofDatabase(databasePath, value) {
  const database = new DatabaseSync(databasePath);
  assert.equal(
    database.prepare('PRAGMA journal_mode = WAL').get().journal_mode,
    'wal',
  );
  database.exec(`
    PRAGMA user_version = ${EXPECTED_SCHEMA};
    PRAGMA foreign_keys = ON;
    CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `);
  database.prepare('INSERT INTO proof (id, value) VALUES (1, ?)').run(value);
  database.close();
}

function sqliteFamilySnapshot(databasePath) {
  return Object.fromEntries(['', '-wal', '-shm'].map((suffix) => {
    const candidate = `${databasePath}${suffix}`;
    return [suffix || 'main', fs.existsSync(candidate)
      ? databaseSha256(candidate)
      : null];
  }));
}

function materializeClosedWalSidecars(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  database.prepare('PRAGMA integrity_check').get();
  database.close();
  assert.equal(fs.existsSync(`${databasePath}-wal`), true);
  assert.equal(fs.existsSync(`${databasePath}-shm`), true);
}

function assertNoSqliteSidecars(databasePath) {
  assert.equal(fs.existsSync(`${databasePath}-wal`), false);
  assert.equal(fs.existsSync(`${databasePath}-shm`), false);
}

function managedRestoreResidue(stateDir) {
  const uuid = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
  const dataPattern = new RegExp(
    `^\\.memory-bridge\\.(?:restore-stage|pre-restore-rollback)-${uuid}` +
      '\\.sqlite3(?:-(?:wal|shm))?$',
    'u',
  );
  const backupSidecarPattern = new RegExp(
    `^(?:backup|pre-restore|pre-upgrade)-[0-9]{17}-${uuid}` +
      '\\.sqlite3-(?:wal|shm)$',
    'u',
  );
  const dataDir = path.join(stateDir, 'data');
  const backupsDir = path.join(stateDir, 'backups');
  return [
    ...(fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [])
      .filter((name) => dataPattern.test(name))
      .map((name) => path.join(dataDir, name)),
    ...(fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : [])
      .filter((name) => backupSidecarPattern.test(name))
      .map((name) => path.join(backupsDir, name)),
  ].sort();
}

function assertNoManagedRestoreResidue(stateDir) {
  assert.deepEqual(managedRestoreResidue(stateDir), []);
}

function canonicalStopReceipt(receipt) {
  return JSON.stringify({
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
}

function signStopReceipt(receipt, key) {
  return createHmac('sha256', key)
    .update(canonicalStopReceipt(receipt))
    .digest('hex');
}

test('SQLite transaction cleanup is UUID-owned and never removes the current WAL family', () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-sqlite-cleanup-'),
  );
  try {
    const stateDir = path.join(root, 'state');
    const dataDir = path.join(stateDir, 'data');
    const backupsDir = path.join(stateDir, 'backups');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(backupsDir, { recursive: true });
    const uuid = '11111111-1111-4111-8111-111111111111';
    const backupPath = path.join(
      backupsDir,
      `backup-20260812000000000-${uuid}.sqlite3`,
    );
    for (const suffix of ['', '-wal', '-shm']) {
      fs.writeFileSync(`${backupPath}${suffix}`, 'owned backup fixture');
    }
    removeManagedSqliteTransactionFiles({
      stateDir,
      basePath: backupPath,
      preserveBase: true,
    });
    assert.equal(fs.existsSync(backupPath), true);
    assertNoSqliteSidecars(backupPath);

    const stagePath = path.join(
      dataDir,
      `.memory-bridge.restore-stage-${uuid}.sqlite3`,
    );
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      fs.writeFileSync(`${stagePath}${suffix}`, 'owned stage fixture');
    }
    removeManagedSqliteTransactionFiles({ stateDir, basePath: stagePath });
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(fs.existsSync(`${stagePath}${suffix}`), false);
    }
    assert.equal(fs.existsSync(`${stagePath}-journal`), true);

    const currentPath = path.join(dataDir, 'memory-bridge.sqlite3');
    for (const suffix of ['', '-wal', '-shm']) {
      fs.writeFileSync(`${currentPath}${suffix}`, 'must remain');
    }
    assert.throws(
      () => removeManagedSqliteTransactionFiles({
        stateDir,
        basePath: currentPath,
      }),
      /transaction|受管|路径|owned/iu,
    );
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(fs.readFileSync(`${currentPath}${suffix}`, 'utf8'), 'must remain');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install stages code, excludes private/runtime data, and creates state', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-install-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    const result = await installProject({ source, ...options });

    assert.equal(result.status, 'installed');
    assert.equal(
      fs.readFileSync(path.join(options.installRoot, 'src', 'marker.txt'), 'utf8'),
      'version-one',
    );
    assert.equal(fs.existsSync(path.join(options.installRoot, 'data')), false);
    assert.equal(
      fs.existsSync(path.join(options.installRoot, '.memory-bridge-private')),
      false,
    );
    assert.equal(fs.existsSync(path.join(options.installRoot, '.env')), false);
    assert.equal(fs.existsSync(path.join(options.installRoot, 'private.key')), false);
    for (const excluded of [
      '.firecrawl',
      'docs',
      'examples',
      'tests',
      'AGENTS.md',
      '.DS_Store',
      path.join('src', '.DS_Store'),
      'action-game',
      'side-scroller-game',
      'third-person-rpg',
      'unknown-large-project',
    ]) {
      assert.equal(fs.existsSync(path.join(options.installRoot, excluded)), false);
    }
    assert.equal(fs.statSync(path.join(options.stateDir, 'data')).mode & 0o777, 0o700);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(options.stateDir, 'install.json'),
      'utf8',
    ));
    assert.equal(manifest.status, 'installed');
    assert.equal(manifest.version, '1.0.0');
    assert.ok(manifest.installId);
    assert.equal(typeof manifest.artifacts['dist/server/index.js'], 'string');
    const marker = JSON.parse(fs.readFileSync(
      path.join(options.installRoot, '.memory-bridge-managed.json'),
      'utf8',
    ));
    assert.equal(marker.installId, manifest.installId);
    const lifecycleKey = path.join(options.stateDir, 'lifecycle-auth.key');
    const keyStat = fs.lstatSync(lifecycleKey);
    assert.equal(keyStat.isFile(), true);
    assert.equal(keyStat.isSymbolicLink(), false);
    assert.equal(keyStat.mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(lifecycleKey).length, 32);
    assert.equal(fs.existsSync(path.join(options.installRoot, 'lifecycle-auth.key')), false);
    assert.equal(fs.existsSync(path.join(source, 'lifecycle-auth.key')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed upgrade leaves current install untouched; success keeps rollback', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-upgrade-test-'));
  try {
    const v1 = createFixture(root, '1.0.0', 'version-one');
    const v2 = createFixture(root, '2.0.0', 'version-two');
    const options = testOptions(root);
    await installProject({ source: v1, ...options });
    const databasePath = path.join(options.stateDir, 'data', 'memory-bridge.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL); " +
      "INSERT INTO memories VALUES ('memory-upgrade-proof', 'fixture-value')",
    );
    database.close();

    await assert.rejects(
      upgradeProject({
        source: v2,
        ...options,
        skipDependencies: false,
        commandRunner: async () => {
          throw new Error('simulated npm failure');
        },
      }),
      /simulated npm failure/u,
    );
    assert.equal(
      fs.readFileSync(path.join(options.installRoot, 'src', 'marker.txt'), 'utf8'),
      'version-one',
    );
    const afterFailedBuild = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      afterFailedBuild.prepare('SELECT content FROM memories').get().content,
      'fixture-value',
    );
    afterFailedBuild.close();

    const result = await upgradeProject({ source: v2, ...options });
    assert.equal(result.status, 'upgraded');
    assert.equal(
      fs.readFileSync(path.join(options.installRoot, 'src', 'marker.txt'), 'utf8'),
      'version-two',
    );
    assert.equal(
      fs.readFileSync(
        path.join(result.rollbackRoot, 'src', 'marker.txt'),
        'utf8',
      ),
      'version-one',
    );
    const afterUpgrade = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      afterUpgrade.prepare('SELECT content FROM memories').get().content,
      'fixture-value',
    );
    afterUpgrade.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserved reinstall retains lifecycle lineage; purge removes and rotates it', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-uninstall-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const keyPath = path.join(options.stateDir, 'lifecycle-auth.key');
    const originalKey = fs.readFileSync(keyPath);
    const originalInstall = JSON.parse(fs.readFileSync(
      path.join(options.stateDir, 'install.json'),
      'utf8',
    ));
    const databasePath = path.join(options.stateDir, 'data', 'memory-bridge.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA user_version = ${EXPECTED_SCHEMA};
      CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO proof (id, value) VALUES (1, 'preserved-backup');
    `);
    database.close();
    const candidate = await createDatabaseBackup({ source, ...options });
    const changed = new DatabaseSync(databasePath);
    changed.prepare('UPDATE proof SET value = ? WHERE id = 1').run('before-reinstall');
    changed.close();
    const stopReceipt = await createVerifiedStopReceipt({ source, ...options });

    const preserved = await uninstallProject(options);
    assert.equal(preserved.dataPreserved, true);
    assert.equal(fs.existsSync(options.installRoot), false);
    assert.deepEqual(fs.readFileSync(keyPath), originalKey);
    assert.equal(fs.existsSync(stopReceipt), true);
    assert.equal(
      JSON.parse(fs.readFileSync(
        path.join(options.stateDir, 'stop-authorization.json'),
        'utf8',
      )).status,
      'issued',
    );

    await assert.rejects(
      uninstallProject({
        ...options,
        purgeData: true,
        purgeConfirmation: 'wrong',
      }),
      /确认串/u,
    );
    assert.equal(fs.existsSync(databasePath), true);

    await installProject({ source, ...options });
    const reinstalled = JSON.parse(fs.readFileSync(
      path.join(options.stateDir, 'install.json'),
      'utf8',
    ));
    assert.equal(reinstalled.installId, originalInstall.installId);
    assert.deepEqual(fs.readFileSync(keyPath), originalKey);
    assert.equal(fs.existsSync(stopReceipt), true);
    await restoreDatabaseBackup({
      source,
      ...options,
      backupPath: candidate.backupPath,
      stopReceipt,
    });
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(restored.prepare('SELECT value FROM proof WHERE id = 1').get().value, 'preserved-backup');
    restored.close();
    assert.equal(fs.existsSync(stopReceipt), false);
    assert.equal(
      JSON.parse(fs.readFileSync(
        path.join(options.stateDir, 'stop-authorization.json'),
        'utf8',
      )).status,
      'consumed',
    );

    const afterConsumedUninstall = await uninstallProject(options);
    assert.equal(afterConsumedUninstall.dataPreserved, true);
    assert.equal(fs.existsSync(path.join(options.stateDir, 'stop-authorization.json')), false);
    assert.equal(fs.existsSync(path.join(options.stateDir, 'receipts')), false);
    await installProject({ source, ...options });
    assert.equal(fs.existsSync(stopReceipt), false);

    const purged = await uninstallProject({
      ...options,
      purgeData: true,
      purgeConfirmation: DATA_PURGE_CONFIRMATION,
    });
    assert.equal(purged.dataPreserved, false);
    assert.equal(fs.existsSync(path.join(options.stateDir, 'data')), false);
    assert.equal(fs.existsSync(keyPath), false);
    assert.equal(fs.existsSync(path.join(options.stateDir, 'stop-authorization.json')), false);
    assert.equal(fs.existsSync(path.join(options.stateDir, 'receipts')), false);

    await installProject({ source, ...options });
    const rotatedInstall = JSON.parse(fs.readFileSync(
      path.join(options.stateDir, 'install.json'),
      'utf8',
    ));
    assert.notEqual(rotatedInstall.installId, originalInstall.installId);
    assert.notDeepEqual(fs.readFileSync(keyPath), originalKey);
    assert.equal(fs.readFileSync(keyPath).length, 32);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserve-data uninstall clears invalid or expired Stop proof instead of reviving it', async (t) => {
  for (const proofKind of ['invalid-hmac', 'expired']) {
    await t.test(proofKind, async () => {
      const root = fs.mkdtempSync(path.join(
        fs.realpathSync(os.tmpdir()),
        `memory-bridge-stop-proof-${proofKind}-`,
      ));
      try {
        const source = createFixture(root, '1.0.0', 'version-one');
        const options = testOptions(root);
        await installProject({ source, ...options });
        const receiptPath = await createVerifiedStopReceipt({ source, ...options });
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        if (proofKind === 'invalid-hmac') {
          receipt.hmacSha256 = '0'.repeat(64);
        } else {
          receipt.verifiedAt = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
          receipt.hmacSha256 = signStopReceipt(
            receipt,
            fs.readFileSync(path.join(options.stateDir, 'lifecycle-auth.key')),
          );
          const authorizationPath = path.join(
            options.stateDir,
            'stop-authorization.json',
          );
          const authorization = JSON.parse(fs.readFileSync(authorizationPath, 'utf8'));
          authorization.issuedAt = receipt.verifiedAt;
          fs.writeFileSync(authorizationPath, `${JSON.stringify(authorization)}\n`, {
            mode: 0o600,
          });
        }
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });

        await uninstallProject(options);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(
          fs.existsSync(path.join(options.stateDir, 'stop-authorization.json')),
          false,
        );
        await installProject({ source, ...options });
        assert.equal(fs.existsSync(receiptPath), false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test('doctor reports artifacts and fresh data state without exposing content', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-doctor-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const report = await diagnoseInstallation({
      ...options,
      checkOllama: false,
      checkPort: false,
      mcpSmoke: false,
    });
    assert.equal(report.checks.find((item) => item.id === 'install.ownership').status, 'pass');
    assert.equal(report.checks.find((item) => item.id === 'install.fingerprints').status, 'pass');
    assert.equal(report.checks.find((item) => item.id === 'install.permissions').status, 'pass');
    assert.equal(report.checks.find((item) => item.id === 'install.artifacts').status, 'pass');
    assert.equal(report.checks.find((item) => item.id === 'database.state').status, 'info');
    assert.equal(JSON.stringify(report).includes('version-one'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor trusts only the MCP smoke result and fails on a missing tool', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-mcp-doctor-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const report = await diagnoseInstallation({
      ...options,
      checkOllama: false,
      checkPort: false,
      mcpSmoke: true,
      mcpSmokeRunner: async () => ({
        stdout: `${JSON.stringify({
          passed: true,
          isolated: true,
          cleanupComplete: true,
          tools: ['memory_stats'],
          calledTools: ['memory_stats'],
          runId: 'fixture-run',
        })}\n`,
        stderr: '',
      }),
    });
    const result = report.checks.find((item) => item.id === 'mcp.stdio');
    assert.equal(result.status, 'fail');
    assert.ok(result.missing.includes('memory_recall'));
    assert.equal(report.passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor smoke calls and validates all seven real MCP tools in isolation', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-real-mcp-doctor-test-'));
  try {
    const options = testOptions(root);
    await installProject({
      source: path.resolve('.'),
      ...options,
      skipDependencies: false,
    });
    const report = await diagnoseInstallation({
      ...options,
      checkOllama: false,
      checkPort: false,
      mcpSmoke: true,
    });
    const smoke = report.checks.find((item) => item.id === 'mcp.stdio');
    assert.equal(smoke.status, 'pass', JSON.stringify(smoke));
    assert.equal(smoke.isolated, true);
    assert.equal(smoke.cleanupComplete, true);
    assert.equal(new Set(smoke.calledTools).size, 7);
    assert.match(smoke.smokeRunId, /^[0-9a-f-]{36}$/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle lock rejects overlapping operations', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-lock-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    fs.mkdirSync(options.stateDir, { recursive: true });
    fs.writeFileSync(path.join(options.stateDir, 'lifecycle.lock'), 'occupied\n');
    await assert.rejects(
      installProject({ source, ...options }),
      (error) => error?.code === 'EEXIST',
    );
    assert.equal(fs.existsSync(options.installRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upgrade restores the old release when manifest switching fails', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-switch-test-'));
  try {
    const v1 = createFixture(root, '1.0.0', 'version-one');
    const v2 = createFixture(root, '2.0.0', 'version-two');
    const options = testOptions(root);
    await installProject({ source: v1, ...options });
    const databasePath = path.join(options.stateDir, 'data', 'memory-bridge.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE turns (id TEXT PRIMARY KEY, body TEXT NOT NULL); " +
      "INSERT INTO turns VALUES ('turn-rollback-proof', 'fixture-turn')",
    );
    database.close();
    await assert.rejects(upgradeProject({
      source: v2,
      ...options,
      testOnlyAfterSwitch: async () => {
        throw new Error('simulated manifest switching failure');
      },
    }), /simulated manifest switching failure/u);
    assert.equal(
      fs.readFileSync(path.join(options.installRoot, 'src', 'marker.txt'), 'utf8'),
      'version-one',
    );
    const afterRollback = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      afterRollback.prepare('SELECT body FROM turns').get().body,
      'fixture-turn',
    );
    afterRollback.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upgrade creates a readable SQLite backup before code switching', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-backup-test-'));
  try {
    const v1 = createFixture(root, '1.0.0', 'version-one');
    const v2 = createFixture(root, '2.0.0', 'version-two');
    const options = testOptions(root);
    await installProject({ source: v1, ...options });
    const databasePath = path.join(options.stateDir, 'data', 'memory-bridge.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE proof (value TEXT NOT NULL); INSERT INTO proof VALUES (\'kept\')');
    database.close();

    const result = await upgradeProject({ source: v2, ...options });
    assert.ok(result.databaseBackup);
    assert.equal(fs.existsSync(result.databaseBackup), true);
    const restored = new DatabaseSync(result.databaseBackup, { readOnly: true });
    assert.equal(restored.prepare('SELECT value FROM proof').get().value, 'kept');
    restored.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle CLI rejects unknown commands and missing required paths', () => {
  const cli = path.resolve('scripts/memory-bridge-lifecycle.mjs');
  const unknown = spawnSync(process.execPath, [cli, 'unknown'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /用法/u);
  const missing = spawnSync(process.execPath, [cli, 'install'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--install-root 必填/u);
  const unsafeSkip = spawnSync(process.execPath, [
    cli,
    'install',
    '--install-root',
    path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-cli-skip-app'),
    '--skip-build',
  ], { encoding: 'utf8' });
  assert.equal(unsafeSkip.status, 1);
  assert.match(unsafeSkip.stderr, /未知参数.*--skip-build/u);
  const strictBypass = spawnSync(process.execPath, [
    cli,
    'doctor',
    '--install-root',
    path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-cli-strict-app'),
    '--strict',
    '--no-port',
    '--no-ollama',
    '--no-mcp-smoke',
  ], { encoding: 'utf8' });
  assert.equal(strictBypass.status, 1);
  assert.match(strictBypass.stderr, /--strict 禁止搭配/u);
});

test('doctor fails when a managed artifact is changed after install', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-tamper-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    fs.appendFileSync(path.join(options.installRoot, 'dist', 'server', 'index.js'), 'tampered');
    const report = await diagnoseInstallation({
      ...options,
      checkOllama: false,
      checkPort: false,
      mcpSmoke: false,
    });
    assert.equal(
      report.checks.find((item) => item.id === 'install.fingerprints').status,
      'fail',
    );
    assert.equal(report.passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed layout rejects broad and overlapping destructive targets', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-layout-test-'));
  try {
    const source = path.join(root, 'source');
    fs.mkdirSync(source);
    assert.throws(() => assertManagedLayout({
      source,
      installRoot: source,
      stateDir: path.join(root, 'state'),
    }), /不能相同|重叠/u);
    assert.throws(() => assertManagedLayout({
      source,
      installRoot: path.parse(root).root,
      stateDir: path.join(root, 'state'),
    }), /根目录/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall rejects an arbitrary directory without matching ownership', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-ownership-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    fs.mkdirSync(options.installRoot, { recursive: true });
    fs.writeFileSync(path.join(options.installRoot, 'user-file.txt'), 'do-not-delete');
    await assert.rejects(
      uninstallProject({ source, ...options }),
      /受管|Memory Bridge/u,
    );
    assert.equal(
      fs.readFileSync(path.join(options.installRoot, 'user-file.txt'), 'utf8'),
      'do-not-delete',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed layout rejects a symlink in any existing target ancestor', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-symlink-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const real = path.join(root, 'real-target');
    const linked = path.join(root, 'linked-target');
    fs.mkdirSync(real);
    fs.symlinkSync(real, linked);
    assert.throws(() => assertManagedLayout({
      source,
      installRoot: path.join(linked, 'launcher', 'app'),
      stateDir: path.join(root, 'safe', 'state'),
    }), /符号链接/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor verifies the HTTP service identity on the configured port', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-service-test-'));
  let serviceName = 'memory-bridge';
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      service: serviceName,
      mcpTransport: 'stdio',
    }));
  });
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const healthy = await diagnoseInstallation({
      ...options,
      checkOllama: false,
      mcpSmoke: false,
      host: '127.0.0.1',
      port: address.port,
    });
    assert.equal(
      healthy.checks.find((item) => item.id === 'service.identity').status,
      'pass',
    );

    serviceName = 'different-service';
    const wrongService = await diagnoseInstallation({
      ...options,
      checkOllama: false,
      mcpSmoke: false,
      host: '127.0.0.1',
      port: address.port,
    });
    assert.equal(
      wrongService.checks.find((item) => item.id === 'service.identity').status,
      'fail',
    );
    assert.equal(wrongService.passed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor warnings and skipped checks never claim release readiness', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-strict-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const database = new DatabaseSync(
      path.join(options.stateDir, 'data', 'memory-bridge.sqlite3'),
    );
    database.exec(`
      PRAGMA user_version = ${EXPECTED_SCHEMA};
      CREATE TABLE outbox_events (status TEXT NOT NULL);
      INSERT INTO outbox_events VALUES ('pending');
      CREATE TABLE memory_jobs (status TEXT NOT NULL);
      INSERT INTO memory_jobs VALUES ('failed');
    `);
    database.close();

    const daily = await diagnoseInstallation({
      ...options,
      checkOllama: false,
      checkPort: false,
      mcpSmoke: false,
    });
    assert.equal(daily.checks.find((item) => item.id === 'jobs.health').status, 'warn');
    assert.equal(daily.passed, true);
    assert.equal(daily.releaseReady, false);

    for (const disabled of ['checkOllama', 'checkPort', 'mcpSmoke']) {
      await assert.rejects(
        diagnoseInstallation({
          ...options,
          strict: true,
          [disabled]: false,
        }),
        /strict Doctor 禁止跳过/u,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict doctor fails release gate when the configured service is offline', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-offline-strict-test-'));
  const ollama = http.createServer((request, response) => {
    if (request.url !== '/api/tags') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      models: [{ name: 'qwen2.5:14b' }, { name: 'bge-m3:latest' }],
    }));
  });
  const reserved = http.createServer();
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const database = new DatabaseSync(
      path.join(options.stateDir, 'data', 'memory-bridge.sqlite3'),
    );
    database.exec(`
      PRAGMA user_version = ${EXPECTED_SCHEMA};
      CREATE TABLE outbox_events (status TEXT NOT NULL);
      CREATE TABLE memory_jobs (status TEXT NOT NULL);
    `);
    database.close();
    await new Promise((resolve, reject) => {
      ollama.once('error', reject);
      ollama.listen(0, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => {
      reserved.once('error', reject);
      reserved.listen(0, '127.0.0.1', resolve);
    });
    const ollamaAddress = ollama.address();
    const reservedAddress = reserved.address();
    assert.ok(ollamaAddress && typeof ollamaAddress === 'object');
    assert.ok(reservedAddress && typeof reservedAddress === 'object');
    const offlinePort = reservedAddress.port;
    await new Promise((resolve) => reserved.close(resolve));

    const daily = await diagnoseInstallation({
      ...options,
      ollamaUrl: `http://127.0.0.1:${ollamaAddress.port}`,
      host: '127.0.0.1',
      port: offlinePort,
      mcpSmokeRunner: async () => successfulMcpSmokeResult(),
    });
    assert.equal(daily.checks.find((item) => item.id === 'service.identity').status, 'info');
    assert.equal(daily.passed, true);
    assert.equal(daily.releaseReady, false);

    const strict = await diagnoseInstallation({
      ...options,
      strict: true,
      ollamaUrl: `http://127.0.0.1:${ollamaAddress.port}`,
      host: '127.0.0.1',
      port: offlinePort,
      mcpSmokeRunner: async () => successfulMcpSmokeResult(),
    });
    assert.equal(strict.checks.find((item) => item.id === 'service.identity').status, 'info');
    const gate = strict.checks.find((item) => item.id === 'release.gate');
    assert.equal(gate.status, 'fail');
    assert.ok(gate.blockingChecks.includes('service.identity'));
    assert.equal(strict.releaseReady, false);
    assert.equal(strict.passed, false);
  } finally {
    if (reserved.listening) await new Promise((resolve) => reserved.close(resolve));
    if (ollama.listening) await new Promise((resolve) => ollama.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor fingerprints all runtime source and dist files', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-full-hash-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    fs.writeFileSync(path.join(source, 'dist', 'web', 'runtime-chunk.js'), 'runtime-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    fs.appendFileSync(path.join(options.installRoot, 'scripts', 'mcp-doctor-smoke.mjs'), 'changed');
    fs.appendFileSync(path.join(options.installRoot, 'dist', 'web', 'runtime-chunk.js'), 'changed');
    const report = await diagnoseInstallation({
      ...options,
      checkOllama: false,
      checkPort: false,
      mcpSmoke: false,
    });
    const fingerprints = report.checks.find((item) => item.id === 'install.fingerprints');
    assert.equal(fingerprints.status, 'fail');
    assert.equal(fingerprints.sourceFingerprintMatch, false);
    assert.equal(fingerprints.artifactFingerprintsMatch, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upgrade refuses to delete an unowned rollback directory', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-rollback-owner-test-'));
  try {
    const v1 = createFixture(root, '1.0.0', 'version-one');
    const v2 = createFixture(root, '2.0.0', 'version-two');
    const options = testOptions(root);
    await installProject({ source: v1, ...options });
    const rollbackRoot = path.join(path.dirname(options.installRoot), '.app.rollback');
    fs.mkdirSync(rollbackRoot, { recursive: true });
    fs.writeFileSync(path.join(rollbackRoot, 'user-file.txt'), 'keep');
    await assert.rejects(
      upgradeProject({ source: v2, ...options }),
      /回滚.*所有权|所有权.*回滚/u,
    );
    assert.equal(fs.readFileSync(path.join(rollbackRoot, 'user-file.txt'), 'utf8'), 'keep');
    assert.equal(
      fs.readFileSync(path.join(options.installRoot, 'src', 'marker.txt'), 'utf8'),
      'version-one',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall with a missing install root still requires a managed manifest', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-missing-root-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    const rollbackRoot = path.join(path.dirname(options.installRoot), '.app.rollback');
    fs.mkdirSync(rollbackRoot, { recursive: true });
    fs.writeFileSync(path.join(rollbackRoot, 'user-file.txt'), 'keep');
    await assert.rejects(uninstallProject({ source, ...options }), /manifest/u);
    assert.equal(fs.readFileSync(path.join(rollbackRoot, 'user-file.txt'), 'utf8'), 'keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update source fails closed without origin and supports explicit local sync', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-update-source-test-'));
  try {
    const launcher = path.join(root, 'launcher');
    const bundle = path.join(launcher, 'bundle');
    const localSource = path.join(root, 'local-source');
    fs.mkdirSync(path.join(bundle, 'src'), { recursive: true });
    fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(localSource, 'src'), { recursive: true });
    fs.mkdirSync(path.join(localSource, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(localSource, '.firecrawl'), { recursive: true });
    fs.mkdirSync(path.join(localSource, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(localSource, 'tests'), { recursive: true });
    fs.copyFileSync(
      path.resolve('packaging/pinokio/memory-bridge/update-source.js'),
      path.join(launcher, 'update-source.js'),
    );
    fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({
      name: 'mcp-memory-bridge',
      version: '1.0.0',
    }));
    fs.writeFileSync(path.join(bundle, 'package-lock.json'), JSON.stringify({
      name: 'mcp-memory-bridge',
      version: '1.0.0',
      lockfileVersion: 3,
    }));
    fs.writeFileSync(path.join(bundle, 'scripts', 'memory-bridge-lifecycle.mjs'), 'old');
    fs.writeFileSync(path.join(bundle, 'scripts', 'memory-bridge-lifecycle-lib.mjs'), 'old');
    fs.writeFileSync(path.join(bundle, 'src', 'old.txt'), 'old');
    fs.writeFileSync(path.join(bundle, '.memory-bridge-source-bundle.json'), JSON.stringify({
      format: 'memory-bridge-source-bundle:v1',
      package: 'mcp-memory-bridge',
      fingerprint: sourceBundleFingerprint(bundle),
    }));
    fs.writeFileSync(path.join(localSource, 'package.json'), JSON.stringify({
      name: 'mcp-memory-bridge',
      version: '2.0.0',
    }));
    fs.writeFileSync(path.join(localSource, 'package-lock.json'), JSON.stringify({
      name: 'mcp-memory-bridge',
      version: '2.0.0',
      lockfileVersion: 3,
    }));
    fs.writeFileSync(path.join(localSource, 'src', 'new.txt'), 'new');
    fs.writeFileSync(path.join(localSource, 'scripts', 'memory-bridge-lifecycle.mjs'), 'new');
    fs.writeFileSync(path.join(localSource, 'scripts', 'memory-bridge-lifecycle-lib.mjs'), 'new');
    fs.writeFileSync(path.join(localSource, '.firecrawl', 'excluded.txt'), 'excluded');
    fs.writeFileSync(path.join(localSource, 'docs', 'excluded.md'), 'excluded');
    fs.writeFileSync(path.join(localSource, 'tests', 'excluded.test.js'), 'excluded');
    fs.writeFileSync(path.join(localSource, 'AGENTS.md'), 'excluded');

    const withoutSource = spawnSync(process.execPath, [path.join(launcher, 'update-source.js')], {
      cwd: launcher,
      encoding: 'utf8',
    });
    assert.notEqual(withoutSource.status, 0);
    assert.match(withoutSource.stderr, /没有可用更新源|拒绝升级/u);
    assert.equal(fs.readFileSync(path.join(bundle, 'src', 'old.txt'), 'utf8'), 'old');

    const unmarked = spawnSync(process.execPath, [
      path.join(launcher, 'update-source.js'),
      '--local-source',
      localSource,
    ], { cwd: launcher, encoding: 'utf8' });
    assert.notEqual(unmarked.status, 0);
    assert.match(unmarked.stderr, /所有权标记|marker|bundle/u);
    assert.equal(fs.readFileSync(path.join(bundle, 'src', 'old.txt'), 'utf8'), 'old');

    for (const excluded of ['.firecrawl', 'docs', 'tests', 'AGENTS.md']) {
      fs.rmSync(path.join(localSource, excluded), { recursive: true, force: true });
    }
    fs.writeFileSync(
      path.join(localSource, '.memory-bridge-source-bundle.json'),
      JSON.stringify({
        format: 'memory-bridge-source-bundle:v1',
        package: 'mcp-memory-bridge',
        fingerprint: sourceBundleFingerprint(localSource),
      }),
    );

    const explicit = spawnSync(process.execPath, [
      path.join(launcher, 'update-source.js'),
      '--local-source',
      localSource,
    ], { cwd: launcher, encoding: 'utf8' });
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.match(explicit.stdout, /source-synced/u);
    assert.equal(fs.readFileSync(path.join(bundle, 'src', 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(bundle, '.firecrawl')), false);
    assert.equal(fs.existsSync(path.join(bundle, 'docs')), false);
    assert.equal(fs.existsSync(path.join(bundle, 'tests')), false);
    assert.equal(fs.existsSync(path.join(bundle, 'AGENTS.md')), false);
    assert.equal(fs.existsSync(path.join(bundle, '.memory-bridge-source-bundle.json')), true);
    const marker = JSON.parse(fs.readFileSync(
      path.join(bundle, '.memory-bridge-source-bundle.json'),
      'utf8',
    ));
    assert.equal(marker.fingerprint, sourceBundleFingerprint(bundle));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Pinokio start and doctor pass the same dynamic runtime port', async () => {
  const startPath = path.resolve('packaging/pinokio/memory-bridge/start.js');
  const doctorPath = path.resolve('packaging/pinokio/memory-bridge/doctor.js');
  const startFactory = requireFromTest(startPath);
  const doctorFactory = requireFromTest(doctorPath);
  const runtimePort = 45678;
  const start = await startFactory({ port: async () => runtimePort });
  const shell = start.run.find((step) => step.method === 'shell.run');
  const localSet = start.run.find((step) => step.method === 'local.set');
  assert.equal(shell.params.env.MEMORY_BRIDGE_PORT, runtimePort);
  assert.equal(localSet.params.host, '127.0.0.1');
  assert.equal(localSet.params.port, runtimePort);

  const localKey = path.resolve(path.dirname(startPath), 'start.js');
  const doctor = await doctorFactory({
    memory: {
      local: {
        [localKey]: {
          url: `http://127.0.0.1:${runtimePort}`,
          host: localSet.params.host,
          port: localSet.params.port,
        },
      },
    },
  });
  const command = doctor.run.find((step) => step.method === 'shell.run').params.message[0];
  assert.match(command, new RegExp(`--port ${runtimePort}(?:\\s|$)`, 'u'));
  assert.doesNotMatch(command, /--port 3789(?:\s|$)/u);
  assert.match(command, /--host 127\.0\.0\.1/u);

  const legacy = await doctorFactory({
    memory: { local: { [localKey]: { url: 'http://127.0.0.1:45679' } } },
  });
  assert.match(
    legacy.run.find((step) => step.method === 'shell.run').params.message[0],
    /--port 45679(?:\s|$)/u,
  );
  await assert.rejects(
    doctorFactory({ memory: { local: {} } }),
    /找不到当前 Memory Bridge 实例端口/u,
  );
});

test('Pinokio backup and restore selectors enforce the stopped-service contract', async () => {
  const backupSelector = requireFromTest(
    path.resolve('packaging/pinokio/memory-bridge/backup.js'),
  );
  const restoreFactory = requireFromTest(
    path.resolve('packaging/pinokio/memory-bridge/restore.js'),
  );
  const backupCommand = backupSelector.run
    .find((step) => step.method === 'shell.run').params.message[0];
  assert.match(backupCommand, /memory-bridge-lifecycle\.mjs backup/u);
  await assert.rejects(
    restoreFactory({ running: async () => true }),
    /仍在运行|拒绝/u,
  );
  const startScript = path.resolve('packaging/pinokio/memory-bridge/start.js');
  const appRoot = path.resolve('packaging/pinokio/memory-bridge/app');
  const restore = await restoreFactory({
    running: async () => false,
    memory: {
      local: {
        [startScript]: {
          pid: 2_147_483_647,
          cwd: appRoot,
          port: 45_679,
          url: 'http://127.0.0.1:45679/',
        },
      },
    },
  });
  assert.equal(restore.run[0].method, 'shell.run');
  assert.match(restore.run[0].params.message[0], /stop --phase postflight/u);
  assert.match(restore.run[0].params.message[0], /--verify-stopped/u);
  assert.match(restore.run[0].params.message[0], /--receipt-file/u);
  assert.equal(restore.run[1].method, 'filepicker.open');
  const shell = restore.run.find(
    (step) => step.params?.env?.MEMORY_BRIDGE_RESTORE_BACKUP,
  );
  assert.equal(
    shell.params.env.MEMORY_BRIDGE_RESTORE_BACKUP,
    '{{input.paths[0]}}',
  );
  assert.match(shell.params.message[0], /memory-bridge-lifecycle\.mjs restore/u);
  assert.match(shell.params.message[0], /--stop-receipt/u);
  assert.doesNotMatch(shell.params.message[0], /--service-stopped/u);
});

test('source and state overlap is rejected before chmod, lock, or purge', async () => {
  const outer = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-source-state-test-'));
  try {
    const sourceParent = path.join(outer, 'source-parent');
    fs.mkdirSync(sourceParent, { recursive: true });
    const source = createFixture(sourceParent, '1.0.0', 'version-one');
    const installRoot = path.join(outer, 'launcher', 'app');
    const cases = [
      { label: 'same', stateDir: source },
      { label: 'state-child', stateDir: path.join(source, 'nested-state') },
      { label: 'state-parent', stateDir: sourceParent },
    ];
    for (const entry of cases) {
      const dataDir = path.join(entry.stateDir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const sentinel = path.join(dataDir, `purge-sentinel-${entry.label}`);
      fs.writeFileSync(sentinel, 'keep');
      fs.chmodSync(entry.stateDir, 0o755);
      const beforeMode = fs.statSync(entry.stateDir).mode & 0o777;
      await assert.rejects(
        uninstallProject({
          source,
          installRoot,
          stateDir: entry.stateDir,
          purgeData: true,
          purgeConfirmation: DATA_PURGE_CONFIRMATION,
        }),
        /源码与状态目录不能相同或重叠/u,
      );
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
      assert.equal(fs.statSync(entry.stateDir).mode & 0o777, beforeMode);
      assert.equal(fs.existsSync(path.join(entry.stateDir, 'lifecycle.lock')), false);
    }
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('restore rejects unsigned, tampered, wrong-key, and stale Stop receipts without changing the database', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-receipt-auth-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const databasePath = path.join(options.stateDir, 'data', 'memory-bridge.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA user_version = ${EXPECTED_SCHEMA};
      CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO proof (id, value) VALUES (1, 'receipt-auth-current');
    `);
    database.close();
    const candidate = await createDatabaseBackup({ source, ...options });
    const unchangedSha = databaseSha256(databasePath);
    const install = JSON.parse(fs.readFileSync(
      path.join(options.stateDir, 'install.json'),
      'utf8',
    ));
    const unsignedReceipt = path.join(options.stateDir, 'receipts', 'unsigned.json');
    fs.writeFileSync(unsignedReceipt, `${JSON.stringify({
      format: 'memory-bridge-stop-postflight:v2',
      package: 'mcp-memory-bridge',
      verifiedAt: new Date().toISOString(),
      installId: install.installId,
      pid: 999_999_999,
      cwd: options.installRoot,
      readyUrl: 'http://127.0.0.1:49151',
      databasePath,
      nonce: randomBytes(32).toString('hex'),
    })}\n`, { mode: 0o600 });
    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt: unsignedReceipt,
      }),
      /HMAC|签名|认证|receipt/u,
    );
    assert.equal(databaseSha256(databasePath), unchangedSha);

    const tamperedReceiptPath = await createVerifiedStopReceipt({ source, ...options });
    const tamperedReceipt = JSON.parse(fs.readFileSync(tamperedReceiptPath, 'utf8'));
    tamperedReceipt.readyUrl = 'http://127.0.0.1:49152';
    fs.writeFileSync(tamperedReceiptPath, `${JSON.stringify(tamperedReceipt)}\n`);
    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt: tamperedReceiptPath,
      }),
      /HMAC|签名|认证/u,
    );
    assert.equal(databaseSha256(databasePath), unchangedSha);

    const wrongKeyReceiptPath = await createVerifiedStopReceipt({ source, ...options });
    const wrongKeyReceipt = JSON.parse(fs.readFileSync(wrongKeyReceiptPath, 'utf8'));
    wrongKeyReceipt.hmacSha256 = signStopReceipt(wrongKeyReceipt, randomBytes(32));
    fs.writeFileSync(wrongKeyReceiptPath, `${JSON.stringify(wrongKeyReceipt)}\n`);
    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt: wrongKeyReceiptPath,
      }),
      /HMAC|签名|认证/u,
    );
    assert.equal(databaseSha256(databasePath), unchangedSha);

    const staleReceiptPath = await createVerifiedStopReceipt({ source, ...options });
    const staleReceipt = JSON.parse(fs.readFileSync(staleReceiptPath, 'utf8'));
    staleReceipt.verifiedAt = new Date(Date.now() - 11 * 60 * 1_000).toISOString();
    staleReceipt.hmacSha256 = signStopReceipt(
      staleReceipt,
      fs.readFileSync(path.join(options.stateDir, 'lifecycle-auth.key')),
    );
    fs.writeFileSync(staleReceiptPath, `${JSON.stringify(staleReceipt)}\n`);
    const authorizationPath = path.join(options.stateDir, 'stop-authorization.json');
    const authorization = JSON.parse(fs.readFileSync(authorizationPath, 'utf8'));
    authorization.issuedAt = staleReceipt.verifiedAt;
    fs.writeFileSync(authorizationPath, `${JSON.stringify(authorization)}\n`);
    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt: staleReceiptPath,
      }),
      /过期|stale/u,
    );
    assert.equal(databaseSha256(databasePath), unchangedSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('backup creates a private SHA-256 manifest and restore preserves a pre-restore snapshot', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-restore-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const databasePath = path.join(options.stateDir, 'data', 'memory-bridge.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA user_version = ${EXPECTED_SCHEMA};
      PRAGMA foreign_keys = ON;
      CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO proof (id, value) VALUES (1, 'backup-value');
    `);
    database.close();

    const created = await createDatabaseBackup({ source, ...options });
    assert.equal(created.status, 'backed-up');
    assert.equal(fs.statSync(created.backupPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(created.manifestPath).mode & 0o777, 0o600);
    assert.equal(
      fs.existsSync(path.join(options.stateDir, 'backups', 'lifecycle-auth.key')),
      false,
    );
    const manifest = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'));
    assert.equal(manifest.format, 'memory-bridge-backup-manifest:v1');
    assert.equal(manifest.sha256, createHash('sha256')
      .update(fs.readFileSync(created.backupPath)).digest('hex'));
    assert.throws(
      () => fs.writeFileSync(created.manifestPath, 'overwrite', { flag: 'wx' }),
      (error) => error?.code === 'EEXIST',
    );

    const changed = new DatabaseSync(databasePath);
    changed.prepare('UPDATE proof SET value = ? WHERE id = 1').run('pre-restore-value');
    changed.close();
    await assert.rejects(
      restoreDatabaseBackup({ source, ...options, backupPath: created.backupPath }),
      /Stop.*receipt|receipt.*Stop/u,
    );
    const stopReceipt = await createVerifiedStopReceipt({ source, ...options });
    const issuedReceiptBytes = fs.readFileSync(stopReceipt);
    const restored = await restoreDatabaseBackup({
      source,
      ...options,
      backupPath: created.backupPath,
      stopReceipt,
    });
    const current = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(current.prepare('SELECT value FROM proof WHERE id = 1').get().value, 'backup-value');
    current.close();
    const preRestore = new DatabaseSync(restored.preRestoreBackup, { readOnly: true });
    assert.equal(
      preRestore.prepare('SELECT value FROM proof WHERE id = 1').get().value,
      'pre-restore-value',
    );
    preRestore.close();
    assert.equal(fs.existsSync(restored.preRestoreManifest), true);
    assert.equal(fs.existsSync(stopReceipt), false);
    const consumed = JSON.parse(fs.readFileSync(
      path.join(options.stateDir, 'stop-authorization.json'),
      'utf8',
    ));
    assert.equal(consumed.status, 'consumed');
    fs.writeFileSync(stopReceipt, issuedReceiptBytes, { mode: 0o600, flag: 'wx' });
    const restoredSha = databaseSha256(databasePath);
    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: created.backupPath,
        stopReceipt,
      }),
      /consumed|已消费|授权状态/u,
    );
    assert.equal(databaseSha256(databasePath), restoredSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WAL restore success removes managed backup, stage, and rollback sidecars', async () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-wal-restore-success-'),
  );
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const databasePath = path.join(
      options.stateDir,
      'data',
      'memory-bridge.sqlite3',
    );
    initializeWalProofDatabase(databasePath, 'wal-backup-value');
    const candidate = await createDatabaseBackup({ source, ...options });

    const changed = new DatabaseSync(databasePath);
    changed.prepare('UPDATE proof SET value = ? WHERE id = 1')
      .run('wal-pre-restore-value');
    changed.close();
    const stopReceipt = await createVerifiedStopReceipt({ source, ...options });
    const restored = await restoreDatabaseBackup({
      source,
      ...options,
      backupPath: candidate.backupPath,
      stopReceipt,
    });

    const current = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      current.prepare('SELECT value FROM proof WHERE id = 1').get().value,
      'wal-backup-value',
    );
    current.close();
    assertNoSqliteSidecars(candidate.backupPath);
    assertNoSqliteSidecars(restored.preRestoreBackup);
    assertNoManagedRestoreResidue(options.stateDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WAL restore candidate validation failure removes its sidecars and preserves current family', async () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-wal-restore-invalid-'),
  );
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const databasePath = path.join(
      options.stateDir,
      'data',
      'memory-bridge.sqlite3',
    );
    initializeWalProofDatabase(databasePath, 'must-remain-current');
    const candidate = await createDatabaseBackup({ source, ...options });
    const invalid = new DatabaseSync(candidate.backupPath);
    invalid.prepare('PRAGMA journal_mode = DELETE').get();
    invalid.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES parent(id)
      );
      INSERT INTO child (id, parent_id) VALUES (1, 999);
    `);
    assert.equal(
      invalid.prepare('PRAGMA journal_mode = WAL').get().journal_mode,
      'wal',
    );
    invalid.close();
    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(`${candidate.backupPath}${suffix}`, { force: true });
    }
    const manifest = JSON.parse(fs.readFileSync(candidate.manifestPath, 'utf8'));
    manifest.bytes = fs.statSync(candidate.backupPath).size;
    manifest.sha256 = databaseSha256(candidate.backupPath);
    fs.writeFileSync(candidate.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const stopReceipt = await createVerifiedStopReceipt({ source, ...options });
    materializeClosedWalSidecars(databasePath);
    const before = sqliteFamilySnapshot(databasePath);
    assert.notEqual(before['-wal'], null);
    assert.notEqual(before['-shm'], null);

    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt,
      }),
      /foreign_key_check/u,
    );
    assert.deepEqual(sqliteFamilySnapshot(databasePath), before);
    assertNoSqliteSidecars(candidate.backupPath);
    assertNoManagedRestoreResidue(options.stateDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WAL restore switch failure rolls back the complete current family without residue', async () => {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-wal-restore-rollback-'),
  );
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const databasePath = path.join(
      options.stateDir,
      'data',
      'memory-bridge.sqlite3',
    );
    initializeWalProofDatabase(databasePath, 'restore-candidate');
    const candidate = await createDatabaseBackup({ source, ...options });
    const changed = new DatabaseSync(databasePath);
    changed.prepare('UPDATE proof SET value = ? WHERE id = 1')
      .run('must-survive-wal-rollback');
    changed.close();
    const stopReceipt = await createVerifiedStopReceipt({ source, ...options });
    materializeClosedWalSidecars(databasePath);
    const before = sqliteFamilySnapshot(databasePath);
    assert.notEqual(before['-wal'], null);
    assert.notEqual(before['-shm'], null);

    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt,
        testOnlyAfterRestoreSwitch: async () => {
          throw new Error('simulated WAL restore switch failure');
        },
      }),
      /simulated WAL restore switch failure/u,
    );
    const after = sqliteFamilySnapshot(databasePath);
    assert.equal(after.main, before.main);
    assert.notEqual(after['-wal'], null);
    assert.notEqual(after['-shm'], null);
    const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      rolledBack.prepare('SELECT value FROM proof WHERE id = 1').get().value,
      'must-survive-wal-rollback',
    );
    rolledBack.close();
    assertNoSqliteSidecars(candidate.backupPath);
    assertNoManagedRestoreResidue(options.stateDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore rejects tampering and atomically rolls back a failed switch', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-rollback-restore-test-'));
  try {
    const source = createFixture(root, '1.0.0', 'version-one');
    const options = testOptions(root);
    await installProject({ source, ...options });
    const databasePath = path.join(options.stateDir, 'data', 'memory-bridge.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA user_version = ${EXPECTED_SCHEMA};
      CREATE TABLE proof (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO proof (id, value) VALUES (1, 'restore-candidate');
    `);
    database.close();
    const candidate = await createDatabaseBackup({ source, ...options });

    const changed = new DatabaseSync(databasePath);
    changed.prepare('UPDATE proof SET value = ? WHERE id = 1').run('must-survive-failure');
    changed.close();
    const stopReceipt = await createVerifiedStopReceipt({ source, ...options });
    const issuedReceiptBytes = fs.readFileSync(stopReceipt);
    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt,
        testOnlyAfterRestoreSwitch: async () => {
          throw new Error('simulated restore switch failure');
        },
      }),
      /simulated restore switch failure/u,
    );
    const afterRollback = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      afterRollback.prepare('SELECT value FROM proof WHERE id = 1').get().value,
      'must-survive-failure',
    );
    afterRollback.close();

    assert.equal(fs.existsSync(stopReceipt), false);
    const consumed = JSON.parse(fs.readFileSync(
      path.join(options.stateDir, 'stop-authorization.json'),
      'utf8',
    ));
    assert.equal(consumed.status, 'consumed');
    fs.writeFileSync(stopReceipt, issuedReceiptBytes, { mode: 0o600, flag: 'wx' });
    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt,
      }),
      /consumed|已消费|授权状态/u,
    );

    fs.unlinkSync(stopReceipt);
    const tamperReceipt = await createVerifiedStopReceipt({ source, ...options });
    fs.appendFileSync(candidate.backupPath, 'tampered');
    await assert.rejects(
      restoreDatabaseBackup({
        source,
        ...options,
        backupPath: candidate.backupPath,
        stopReceipt: tamperReceipt,
      }),
      /manifest\/hash|SHA-256 mismatch/u,
    );
    const afterTamper = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(
      afterTamper.prepare('SELECT value FROM proof WHERE id = 1').get().value,
      'must-survive-failure',
    );
    afterTamper.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
