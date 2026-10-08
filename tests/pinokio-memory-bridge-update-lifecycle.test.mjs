import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const updateSource = path.resolve('packaging/pinokio/memory-bridge/update-source.js');
const markerName = '.memory-bridge-source-bundle.json';

function fingerprint(directory) {
  const hash = createHash('sha256');
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (relative === markerName) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(relative).update('\0').update(fs.readFileSync(absolute)).update('\n');
      }
    }
  }
  visit(directory);
  return hash.digest('hex');
}

function fullTreeFingerprint(directory) {
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

function createSource(directory, version, content) {
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'mcp-memory-bridge',
    version,
  }));
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
    name: 'mcp-memory-bridge',
    version,
    lockfileVersion: 3,
  }));
  fs.writeFileSync(path.join(directory, 'src', 'index.ts'), content);
  fs.writeFileSync(path.join(directory, 'scripts', 'memory-bridge-lifecycle.mjs'), content);
  fs.writeFileSync(path.join(directory, 'scripts', 'memory-bridge-lifecycle-lib.mjs'), content);
}

function writeTrustedMarker(directory) {
  fs.writeFileSync(path.join(directory, markerName), `${JSON.stringify({
    format: 'memory-bridge-source-bundle:v1',
    package: 'mcp-memory-bridge',
    fingerprint: fingerprint(directory),
  })}\n`);
}

test('explicit update source must arrive pre-marked and preserves canonical fingerprint', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-update-hardening-'));
  try {
    const launcher = path.join(root, 'launcher');
    const bundle = path.join(launcher, 'bundle');
    const next = path.join(root, 'next');
    const later = path.join(root, 'later');
    fs.mkdirSync(launcher, { recursive: true });
    fs.copyFileSync(updateSource, path.join(launcher, 'update-source.js'));
    createSource(bundle, '1.0.0', 'version-one');
    createSource(next, '2.0.0', 'version-two');
    createSource(later, '3.0.0', 'version-three');
    fs.mkdirSync(path.join(bundle, 'third-person-rpg'), { recursive: true });
    fs.writeFileSync(
      path.join(bundle, 'third-person-rpg', 'project.godot'),
      'legacy-must-be-removed',
    );
    writeTrustedMarker(bundle);
    writeTrustedMarker(next);
    writeTrustedMarker(later);

    const synced = spawnSync(process.execPath, [
      path.join(launcher, 'update-source.js'), '--local-source', next,
    ], { cwd: launcher, encoding: 'utf8' });
    assert.equal(synced.status, 0, synced.stderr);
    assert.equal(fs.existsSync(path.join(bundle, 'third-person-rpg')), false);
    const marker = JSON.parse(fs.readFileSync(path.join(bundle, markerName), 'utf8'));
    assert.equal(marker.fingerprint, fingerprint(bundle));

    fs.appendFileSync(path.join(bundle, 'src', 'index.ts'), '\ntampered');
    const rejected = spawnSync(process.execPath, [
      path.join(launcher, 'update-source.js'), '--local-source', later,
    ], { cwd: launcher, encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /bundle.*fingerprint.*不匹配/u);
    assert.match(fs.readFileSync(path.join(bundle, 'src', 'index.ts'), 'utf8'), /tampered/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local update rejects unmarked, fake, and tampered candidates before bundle mutation', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-update-input-trust-'));
  try {
    const launcher = path.join(root, 'launcher');
    const bundle = path.join(launcher, 'bundle');
    fs.mkdirSync(launcher, { recursive: true });
    fs.copyFileSync(updateSource, path.join(launcher, 'update-source.js'));
    createSource(bundle, '1.0.0', 'current-version');
    writeTrustedMarker(bundle);
    const before = fullTreeFingerprint(bundle);

    const unmarked = path.join(root, 'unmarked');
    createSource(unmarked, '2.0.0', 'unmarked-version');
    const fake = path.join(root, 'fake-marker');
    createSource(fake, '2.0.0', 'fake-version');
    fs.writeFileSync(path.join(fake, markerName), JSON.stringify({
      format: 'memory-bridge-source-bundle:v1',
      package: 'mcp-memory-bridge',
      fingerprint: '0'.repeat(64),
    }));
    const tampered = path.join(root, 'tampered');
    createSource(tampered, '2.0.0', 'marked-version');
    writeTrustedMarker(tampered);
    fs.appendFileSync(path.join(tampered, 'src', 'index.ts'), '\ntampered-after-marker');
    const unknownRoot = path.join(root, 'unknown-root');
    createSource(unknownRoot, '2.0.0', 'unknown-root-version');
    fs.mkdirSync(path.join(unknownRoot, 'third-person-rpg'), { recursive: true });
    fs.writeFileSync(
      path.join(unknownRoot, 'third-person-rpg', 'project.godot'),
      'must-not-copy',
    );
    writeTrustedMarker(unknownRoot);

    for (const [label, candidate] of [
      ['unmarked', unmarked],
      ['fake', fake],
      ['tampered', tampered],
      ['unknown-root', unknownRoot],
    ]) {
      const rejected = spawnSync(process.execPath, [
        path.join(launcher, 'update-source.js'), '--local-source', candidate,
      ], { cwd: launcher, encoding: 'utf8' });
      assert.equal(rejected.status, 1, `${label}: ${rejected.stderr}`);
      assert.match(rejected.stderr, /所有权标记|fingerprint|非发布|不安全/u);
      assert.equal(fullTreeFingerprint(bundle), before, `${label} mutated current bundle`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('git update rejects a local or otherwise untrusted origin before pull', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memory-bridge-origin-hardening-'));
  try {
    const launcher = path.join(root, 'launcher');
    const bundle = path.join(launcher, 'bundle');
    const fakeBin = path.join(root, 'bin');
    const pullSentinel = path.join(root, 'pull-called');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(launcher, { recursive: true });
    fs.copyFileSync(updateSource, path.join(launcher, 'update-source.js'));
    createSource(bundle, '1.0.0', 'version-one');
    writeTrustedMarker(bundle);
    const gitStub = path.join(fakeBin, 'git');
    fs.writeFileSync(gitStub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'rev-parse') process.exit(0);
if (args[0] === 'remote') { console.log('/tmp/local-origin'); process.exit(0); }
if (args[0] === 'pull') { fs.writeFileSync(process.env.GIT_PULL_SENTINEL, 'called'); process.exit(0); }
process.exit(1);
`);
    fs.chmodSync(gitStub, 0o755);

    const result = spawnSync(process.execPath, [path.join(launcher, 'update-source.js')], {
      cwd: launcher,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
        GIT_PULL_SENTINEL: pullSentinel,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /可信 Git origin/u);
    assert.equal(fs.existsSync(pullSentinel), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
