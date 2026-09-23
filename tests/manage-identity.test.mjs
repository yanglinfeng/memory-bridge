import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/server/database.js';
import {
  parseIdentityArguments,
  runIdentityCommand,
} from '../scripts/manage-identity.mjs';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const IDENTITY_SCRIPT = path.join(
  PROJECT_ROOT,
  'scripts',
  'manage-identity.mjs',
);

function temporaryDatabase(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(directory, 'identity.sqlite3');
}

function runIdentityProcess(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', IDENTITY_SCRIPT, ...args],
      {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('identity CLI 严格解析 init/overview 且不接受 userId 冒用参数', () => {
  const database = temporaryDatabase('memory-bridge-cli-parse-');
  assert.deepEqual(
    parseIdentityArguments([
      'init',
      '--database',
      database,
      '--id',
      'alice',
      '--display-name',
      'Alice',
      '--label',
      'AIRI desktop',
    ]),
    {
      help: false,
      command: 'init',
      database,
      id: 'alice',
      displayName: 'Alice',
      label: 'AIRI desktop',
      expiresAt: undefined,
    },
  );
  assert.deepEqual(
    parseIdentityArguments([
      'overview',
      '--database',
      database,
      '--principal',
      'alice',
    ]),
    {
      help: false,
      command: 'overview',
      database,
      principalId: 'alice',
    },
  );
  assert.throws(
    () =>
      parseIdentityArguments([
        'init',
        '--database',
        database,
        '--userId',
        'bob',
        '--display-name',
        'Alice',
        '--label',
        'bad',
      ]),
    /未知参数：--userId/u,
  );
});

test('identity CLI 完成首账户、签发、脱敏概览、persona 列表与归属撤销', () => {
  const databasePath = temporaryDatabase(
    'memory-bridge-cli-lifecycle-',
  );
  const initialized = runIdentityCommand([
    'init',
    '--database',
    databasePath,
    '--id',
    'alice',
    '--display-name',
    'Alice',
    '--label',
    'AIRI desktop',
  ]);
  assert.equal(initialized.principal.id, 'alice');
  assert.match(
    initialized.token,
    /^mb1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u,
  );

  const overview = runIdentityCommand([
    'overview',
    '--database',
    databasePath,
    '--principal',
    'alice',
  ]);
  assert.equal(overview.overview.principal.id, 'alice');
  assert.equal(overview.overview.credential, null);
  assert.equal(overview.credentials.length, 1);
  assert.equal(
    JSON.stringify(overview).includes(initialized.token),
    false,
  );
  assert.equal(
    JSON.stringify(overview).includes('secret_hash'),
    false,
  );

  assert.deepEqual(
    runIdentityCommand([
      'list-personas',
      '--database',
      databasePath,
      '--principal',
      'alice',
    ]),
    { principalId: 'alice', personas: [] },
  );
  runIdentityCommand([
    'create-principal',
    '--database',
    databasePath,
    '--id',
    'bob',
    '--display-name',
    'Bob',
  ]);
  const bobIssued = runIdentityCommand([
    'issue-token',
    '--database',
    databasePath,
    '--principal',
    'bob',
    '--label',
    'Bob desktop',
  ]);
  assert.throws(
    () =>
      runIdentityCommand([
        'revoke-credential',
        '--database',
        databasePath,
        '--principal',
        'alice',
        '--credential',
        bobIssued.credential.id,
      ]),
    /身份凭据不存在/u,
  );
  const revoked = runIdentityCommand([
    'revoke-credential',
    '--database',
    databasePath,
    '--principal',
    'bob',
    '--credential',
    bobIssued.credential.id,
    '--reason',
    'rotation complete',
  ]);
  assert.equal(revoked.credential.status, 'revoked');
  assert.throws(
    () =>
      runIdentityCommand([
        'init',
        '--database',
        databasePath,
        '--id',
        'charlie',
        '--display-name',
        'Charlie',
        '--label',
        'must fail',
      ]),
    /首个账户初始化已经永久关闭/u,
  );
});

test('identity CLI 并发双 init 只有一个原子成功', async () => {
  const databasePath = temporaryDatabase(
    'memory-bridge-cli-concurrent-',
  );
  openDatabase(databasePath).close();
  const common = ['--database', databasePath];
  const results = await Promise.all([
    runIdentityProcess([
      'init',
      ...common,
      '--id',
      'alice',
      '--display-name',
      'Alice',
      '--label',
      'Alice first',
    ]),
    runIdentityProcess([
      'init',
      ...common,
      '--id',
      'bob',
      '--display-name',
      'Bob',
      '--label',
      'Bob first',
    ]),
  ]);
  const successes = results.filter((result) => result.code === 0);
  const failures = results.filter((result) => result.code !== 0);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.match(
    failures[0].stderr,
    /首个账户初始化已经永久关闭/u,
  );

  const winner = JSON.parse(successes[0].stdout);
  const database = openDatabase(databasePath);
  try {
    assert.equal(
      database.prepare(
        'SELECT COUNT(*) AS count FROM auth_credentials',
      ).get()?.count,
      1,
    );
    assert.equal(
      database.prepare(
        'SELECT principal_id FROM auth_credentials',
      ).get()?.principal_id,
      winner.principal.id,
    );
    const principals = database
      .prepare(
        `SELECT id FROM account_principals
         WHERE id != 'default'
         ORDER BY id`,
      )
      .all()
      .map((row) => row.id);
    assert.deepEqual(principals, [winner.principal.id]);
    const persisted = JSON.stringify({
      credentials: database
        .prepare(
          `SELECT id, principal_id, label, secret_hint, status
           FROM auth_credentials`,
        )
        .all(),
      audit: database
        .prepare(
          `SELECT action, principal_id, credential_id, detail_json
           FROM identity_audit_log`,
        )
        .all(),
    });
    assert.equal(persisted.includes(winner.token), false);
  } finally {
    database.close();
  }
});
