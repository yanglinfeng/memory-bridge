import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BUNDLE_MARKER = '.memory-bridge-source-bundle.json';
const EXPECTED_PACKAGE = 'memory-bridge';
const REQUIRED_BUNDLE_FILES = [
  'package.json',
  'package-lock.json',
  path.join('scripts', 'memory-bridge-lifecycle.mjs'),
  path.join('scripts', 'memory-bridge-lifecycle-lib.mjs'),
];
const REQUIRED_BUNDLE_DIRECTORIES = ['src', 'scripts'];

// Fail closed at the project root. Keep this explicit boundary aligned with
// memory-bridge-lifecycle-lib.mjs and packaging/.../update-source.js.
export const ALLOWED_BUNDLE_ROOT_FILES = new Set([
  '.gitignore',
  BUNDLE_MARKER,
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'vite.config.ts',
]);
export const ALLOWED_BUNDLE_ROOT_DIRECTORIES = new Set(['src', 'scripts']);
const EXCLUDED_NAMES = new Set(['.DS_Store', 'AGENTS.md']);
const PRIVATE_DIRECTORY_NAMES = new Set([
  '.git', '.memory-bridge-private', 'backups', 'node_modules', 'receipts',
]);

function allowedBundlePath(relative) {
  if (!relative) return true;
  const parts = relative.split(path.sep);
  return ALLOWED_BUNDLE_ROOT_DIRECTORIES.has(parts[0]) ||
    (parts.length === 1 && ALLOWED_BUNDLE_ROOT_FILES.has(parts[0]));
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sensitive(relative) {
  return relative.split(path.sep).some((part) =>
    part === '.env' || part.startsWith('.env.') || part === '.npmrc' ||
    part === 'acceptance-secrets.json' || part === 'secrets.json' ||
    part === 'credentials.json' || part === 'tokens.json' ||
    /\.(?:key|pem|p12|pfx)$/iu.test(part) ||
    /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/iu.test(part) ||
    /\.log$/iu.test(part));
}

function readPackage(directory) {
  const packagePath = path.join(directory, 'package.json');
  if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()) {
    throw new Error('bundle source 缺少 package.json');
  }
  const value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (value.name !== EXPECTED_PACKAGE) {
    throw new Error(`bundle source 必须是 ${EXPECTED_PACKAGE}`);
  }
  return value;
}

function assertBundleStructure(directory) {
  for (const relative of REQUIRED_BUNDLE_FILES) {
    const candidate = path.join(directory, relative);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`bundle 结构缺少文件：${relative}`);
    }
  }
  for (const relative of REQUIRED_BUNDLE_DIRECTORIES) {
    const candidate = path.join(directory, relative);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      throw new Error(`bundle 结构缺少目录：${relative}`);
    }
  }
}

function assertSafeBundleTree(directory) {
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      const parts = relative.split(path.sep);
      if (
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !entry.isFile()) ||
        !allowedBundlePath(relative) ||
        parts.some((part) => EXCLUDED_NAMES.has(part) || PRIVATE_DIRECTORY_NAMES.has(part)) ||
        sensitive(relative)
      ) {
        throw new Error(`bundle 含非发布、私有或不安全路径：${relative}`);
      }
      if (entry.isDirectory()) visit(absolute);
    }
  }
  visit(directory);
}

function shouldCopy(source, candidate) {
  const relative = path.relative(source, candidate);
  if (!relative) return true;
  if (relative === BUNDLE_MARKER) return false;
  const parts = relative.split(path.sep);
  if (!allowedBundlePath(relative)) return false;
  if (parts.some((part) => EXCLUDED_NAMES.has(part) || PRIVATE_DIRECTORY_NAMES.has(part))) {
    return false;
  }
  if (sensitive(relative)) return false;
  const stat = fs.lstatSync(candidate);
  return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile());
}

function copyCanonicalSource(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    filter: (candidate) => shouldCopy(source, candidate),
  });
}

export function bundleFingerprint(directory) {
  const hash = createHash('sha256');
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute);
      if (relative === BUNDLE_MARKER) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(relative).update('\0').update(fs.readFileSync(absolute)).update('\n');
      }
    }
  }
  visit(directory);
  return hash.digest('hex');
}

function assertBundleOwnership(directory) {
  readPackage(directory);
  assertBundleStructure(directory);
  const markerPath = path.join(directory, BUNDLE_MARKER);
  if (!fs.existsSync(markerPath) || !fs.statSync(markerPath).isFile()) {
    throw new Error('bundle 缺少 canonical marker，拒绝覆盖');
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const fingerprint = bundleFingerprint(directory);
  if (
    marker.format !== 'memory-bridge-source-bundle:v1' ||
    marker.package !== EXPECTED_PACKAGE ||
    !/^[a-f0-9]{64}$/u.test(String(marker.fingerprint || '')) ||
    marker.fingerprint !== fingerprint
  ) {
    throw new Error('bundle canonical marker 或 fingerprint 无效');
  }
  return { marker, fingerprint };
}

export function assertOwnedPinokioBundle(directory) {
  const owned = assertBundleOwnership(directory);
  assertSafeBundleTree(directory);
  return owned;
}

function assertSourceAndDestination(source, destination) {
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error('bundle source 必须是现有目录');
  }
  readPackage(source);
  assertBundleStructure(source);
  if (source === destination || isInside(destination, source)) {
    throw new Error('bundle source 不能等于或位于 destination 内');
  }
  if (isInside(source, destination)) {
    const first = path.relative(source, destination).split(path.sep)[0];
    if (ALLOWED_BUNDLE_ROOT_DIRECTORIES.has(first)) {
      throw new Error('source 内的 bundle destination 必须位于非发布根目录');
    }
  }
}

function prepareBundle(source, destination) {
  copyCanonicalSource(source, destination);
  readPackage(destination);
  assertBundleStructure(destination);
  assertSafeBundleTree(destination);
  const fingerprint = bundleFingerprint(destination);
  fs.writeFileSync(
    path.join(destination, BUNDLE_MARKER),
    `${JSON.stringify({
      format: 'memory-bridge-source-bundle:v1',
      package: EXPECTED_PACKAGE,
      fingerprint,
    }, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 },
  );
  assertOwnedPinokioBundle(destination);
  return fingerprint;
}

function removeOwnedCandidate(directory) {
  if (!fs.existsSync(directory)) return;
  assertBundleOwnership(directory);
  fs.rmSync(directory, { recursive: true, force: false });
}

function transactionPath(parent, kind, identifier) {
  if (
    !['stage', 'rollback', 'quarantine'].includes(kind) ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(identifier)
  ) {
    throw new Error('bundle transaction identity 无效');
  }
  const resolvedParent = path.resolve(parent);
  const candidate = path.join(resolvedParent, `.bundle.${kind}-${identifier}`);
  if (path.dirname(candidate) !== resolvedParent || !isInside(resolvedParent, candidate)) {
    throw new Error('bundle transaction path 越界');
  }
  return candidate;
}

function removeTransactionCandidate(directory, parent, kind, identifier) {
  if (path.resolve(directory) !== transactionPath(parent, kind, identifier)) {
    throw new Error('bundle transaction cleanup path 不匹配');
  }
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: false });
}

export function checkPinokioBundle(input = {}) {
  const source = path.resolve(String(input.source || ''));
  const destination = path.resolve(String(input.destination || ''));
  assertSourceAndDestination(source, destination);
  const current = assertOwnedPinokioBundle(destination);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bridge-bundle-check-'));
  const prepared = path.join(temporaryRoot, 'bundle');
  try {
    const expectedFingerprint = prepareBundle(source, prepared);
    if (expectedFingerprint !== current.fingerprint) {
      throw new Error('Pinokio bundle 与 root source 不一致（out of date）');
    }
    return { status: 'current', fingerprint: current.fingerprint };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: false });
  }
}

export function buildPinokioBundle(input = {}) {
  const source = path.resolve(String(input.source || ''));
  const destination = path.resolve(String(input.destination || ''));
  assertSourceAndDestination(source, destination);
  const parent = path.dirname(destination);
  const identifier = randomUUID();
  const stage = transactionPath(parent, 'stage', identifier);
  const rollback = transactionPath(parent, 'rollback', identifier);
  const quarantine = transactionPath(parent, 'quarantine', identifier);
  const existed = fs.existsSync(destination);
  // A previously generated v1 bundle may predate the allowlist. Its exact
  // marker/fingerprint proves ownership so it can be replaced, but it can
  // never be accepted by checkPinokioBundle or used as the next bundle.
  const previous = existed ? assertBundleOwnership(destination) : null;
  fs.mkdirSync(parent, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bridge-bundle-build-'));
  const prepared = path.join(temporaryRoot, 'bundle');
  let currentMoved = false;
  let nextSwitched = false;
  try {
    const fingerprint = prepareBundle(source, prepared);
    if (previous?.fingerprint === fingerprint) {
      return { status: 'current', fingerprint };
    }
    fs.cpSync(prepared, stage, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
    });
    assertOwnedPinokioBundle(stage);
    if (existed) {
      fs.renameSync(destination, rollback);
      currentMoved = true;
    }
    fs.renameSync(stage, destination);
    nextSwitched = true;
    assertOwnedPinokioBundle(destination);
    input.testOnlyAfterSwitch?.();
    if (currentMoved) {
      removeOwnedCandidate(rollback);
      currentMoved = false;
    }
    return { status: existed ? 'refreshed' : 'built', fingerprint };
  } catch (error) {
    let quarantineCreated = false;
    try {
      if (nextSwitched && fs.existsSync(destination)) {
        fs.renameSync(destination, quarantine);
        quarantineCreated = true;
        nextSwitched = false;
      }
      if (currentMoved) {
        if (!fs.existsSync(rollback) || fs.existsSync(destination)) {
          throw new Error('bundle rollback 无法原子恢复');
        }
        fs.renameSync(rollback, destination);
        assertBundleOwnership(destination);
        currentMoved = false;
      }
      if (quarantineCreated) {
        removeTransactionCandidate(quarantine, parent, 'quarantine', identifier);
      }
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'bundle switch 失败且旧 bundle 未确认恢复；已保留事务证据',
      );
    }
    throw error;
  } finally {
    removeTransactionCandidate(stage, parent, 'stage', identifier);
    fs.rmSync(temporaryRoot, { recursive: true, force: false });
  }
}
