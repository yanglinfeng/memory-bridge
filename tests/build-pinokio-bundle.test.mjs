import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertOwnedPinokioBundle,
  buildPinokioBundle,
  bundleFingerprint,
  checkPinokioBundle,
} from '../scripts/build-pinokio-bundle-lib.mjs';

const cli = path.resolve('scripts/build-pinokio-bundle.mjs');

function write(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value);
}

function createSource(root, version = '1.0.0') {
  const source = path.join(root, 'source');
  write(path.join(source, 'package.json'), JSON.stringify({
    name: 'mcp-memory-bridge',
    version,
  }));
  write(path.join(source, 'package-lock.json'), JSON.stringify({
    name: 'mcp-memory-bridge',
    version,
    lockfileVersion: 3,
  }));
  write(path.join(source, 'src', 'index.ts'), `export const version = '${version}';\n`);
  write(path.join(source, 'scripts', 'memory-bridge-lifecycle.mjs'), 'export {};\n');
  write(path.join(source, 'scripts', 'memory-bridge-lifecycle-lib.mjs'), 'export {};\n');
  write(path.join(source, 'README.md'), '# fixture\n');
  write(path.join(source, '.gitignore'), 'data/\n');

  for (const root of [
    'action-game',
    'side-scroller-game',
    'third-person-rpg',
    'unknown-large-project',
  ]) {
    write(path.join(source, root, 'project.godot'), 'must-not-copy');
  }

  for (const relative of [
    '.env',
    '.npmrc',
    'private.key',
    'data/private.sqlite3',
    'node_modules/package/index.js',
    '.git/config',
    'tests/private-output.json',
    'state/receipts/latest.json',
    'receipts/latest.json',
    'backups/private.sqlite3',
    'logs/private.log',
    '.memory-bridge-private/private.json',
    'src/.DS_Store',
    'src/nested/private.pem',
  ]) {
    write(path.join(source, relative), 'fixture-private-value');
  }
  fs.symlinkSync(path.join(source, '.env'), path.join(source, 'src', 'private-link'));
  return source;
}

function directoryDigest(directory) {
  const hash = createHash('sha256');
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(relative).update('\0').update(fs.readFileSync(absolute)).update('\n');
      }
    }
  }
  visit(directory);
  return hash.digest('hex');
}

function independentCanonicalFingerprint(directory) {
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

function assertNoTransactionResidue(parent) {
  const residue = fs.readdirSync(parent).filter((name) =>
    /^\.bundle\.(?:stage|rollback|quarantine)-/u.test(name));
  assert.deepEqual(residue, []);
}

test('root source builds and atomically refreshes a canonical private-safe bundle', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pinokio-bundle-build-'));
  try {
    const source = createSource(root);
    const destination = path.join(source, 'packaging', 'pinokio', 'memory-bridge', 'bundle');
    const created = buildPinokioBundle({ source, destination });
    assert.equal(created.status, 'built');
    assert.equal(created.fingerprint, bundleFingerprint(destination));
    const marker = JSON.parse(fs.readFileSync(
      path.join(destination, '.memory-bridge-source-bundle.json'),
      'utf8',
    ));
    assert.deepEqual(marker, {
      format: 'memory-bridge-source-bundle:v1',
      package: 'mcp-memory-bridge',
      fingerprint: created.fingerprint,
    });
    assert.equal(marker.fingerprint, independentCanonicalFingerprint(destination));
    for (const relative of [
      'package.json',
      'package-lock.json',
      'README.md',
      '.gitignore',
      'src/index.ts',
      'scripts/memory-bridge-lifecycle.mjs',
      'scripts/memory-bridge-lifecycle-lib.mjs',
    ]) {
      assert.equal(fs.existsSync(path.join(destination, relative)), true, relative);
    }
    for (const relative of [
      '.env', '.npmrc', 'private.key', 'data', 'node_modules', '.git', 'tests',
      'state', 'receipts', 'backups', 'logs', '.memory-bridge-private',
      'src/.DS_Store', 'src/nested/private.pem', 'src/private-link',
      'action-game', 'side-scroller-game', 'third-person-rpg',
      'unknown-large-project',
    ]) {
      assert.equal(fs.existsSync(path.join(destination, relative)), false, relative);
    }
    assertNoTransactionResidue(path.dirname(destination));

    write(path.join(source, 'src', 'index.ts'), "export const version = '2.0.0';\n");
    const refreshed = buildPinokioBundle({ source, destination });
    assert.equal(refreshed.status, 'refreshed');
    assert.notEqual(refreshed.fingerprint, created.fingerprint);
    assert.equal(checkPinokioBundle({ source, destination }).status, 'current');

    const cliCheck = spawnSync(process.execPath, [
      cli, '--check', '--source', source, '--bundle', destination,
    ], { encoding: 'utf8' });
    assert.equal(cliCheck.status, 0, cliCheck.stderr);
    assert.equal(JSON.parse(cliCheck.stdout).status, 'current');

    const beforeMismatch = directoryDigest(destination);
    write(path.join(source, 'src', 'index.ts'), "export const version = '3.0.0';\n");
    assert.throws(
      () => checkPinokioBundle({ source, destination }),
      /不一致|out of date/u,
    );
    assert.equal(directoryDigest(destination), beforeMismatch);
    assertNoTransactionResidue(path.dirname(destination));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('owned bundle rejects an unknown top-level directory even with a matching fingerprint', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pinokio-bundle-boundary-'));
  try {
    const source = createSource(root);
    const destination = path.join(source, 'packaging', 'pinokio', 'memory-bridge', 'bundle');
    buildPinokioBundle({ source, destination });
    write(path.join(destination, 'unknown-large-project', 'payload.bin'), 'unexpected');
    const markerPath = path.join(destination, '.memory-bridge-source-bundle.json');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    marker.fingerprint = bundleFingerprint(destination);
    fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
    assert.throws(
      () => assertOwnedPinokioBundle(destination),
      /非发布|不安全/u,
    );
    write(path.join(source, 'src', 'index.ts'), "export const version = 'clean-next';\n");
    const refreshed = buildPinokioBundle({ source, destination });
    assert.equal(refreshed.status, 'refreshed');
    assert.equal(
      fs.existsSync(path.join(destination, 'unknown-large-project')),
      false,
    );
    assert.doesNotThrow(() => assertOwnedPinokioBundle(destination));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed refresh restores the owned bundle and leaves no half-product', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pinokio-bundle-rollback-'));
  try {
    const source = createSource(root);
    const destination = path.join(source, 'packaging', 'pinokio', 'memory-bridge', 'bundle');
    buildPinokioBundle({ source, destination });
    const before = directoryDigest(destination);
    write(path.join(source, 'src', 'index.ts'), "export const version = 'next';\n");
    assert.throws(
      () => buildPinokioBundle({
        source,
        destination,
        testOnlyAfterSwitch() {
          throw new Error('simulated bundle switch failure');
        },
      }),
      /simulated bundle switch failure/u,
    );
    assert.equal(directoryDigest(destination), before);
    assertNoTransactionResidue(path.dirname(destination));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupted switched destination is quarantined before restoring the valid rollback', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pinokio-bundle-corrupt-'));
  try {
    const source = createSource(root);
    const destination = path.join(source, 'packaging', 'pinokio', 'memory-bridge', 'bundle');
    buildPinokioBundle({ source, destination });
    const before = directoryDigest(destination);
    write(path.join(source, 'src', 'index.ts'), "export const version = 'v2';\n");

    assert.throws(
      () => buildPinokioBundle({
        source,
        destination,
        testOnlyAfterSwitch() {
          write(path.join(destination, 'src', 'index.ts'), 'corrupted after switch\n');
          throw new Error('simulated corrupted destination failure');
        },
      }),
      /simulated corrupted destination failure/u,
    );

    assert.equal(directoryDigest(destination), before);
    assert.doesNotThrow(() => assertOwnedPinokioBundle(destination));
    assertNoTransactionResidue(path.dirname(destination));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
