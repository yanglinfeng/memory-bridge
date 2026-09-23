import { spawn, spawnSync } from 'node:child_process';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export const DATA_PURGE_CONFIRMATION = 'DELETE-MEMORY-BRIDGE-DATA';
const EXPECTED_PACKAGE = 'memory-bridge';
export const EXPECTED_SCHEMA = 44;
const INSTALL_MANIFEST = 'install.json';
const LOCK_FILE = 'lifecycle.lock';
const MANAGED_MARKER = '.memory-bridge-managed.json';
const LIFECYCLE_AUTH_KEY = 'lifecycle-auth.key';
const STOP_AUTHORIZATION_FILE = 'stop-authorization.json';
const STOP_AUTHORIZATION_FORMAT = 'memory-bridge-stop-authorization:v1';
const STOP_RECEIPT_FORMAT = 'memory-bridge-stop-postflight:v2';
const STOP_RECEIPT_MAX_AGE_MS = 10 * 60 * 1_000;
const SQLITE_TRANSACTION_UUID =
  '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const MANAGED_BACKUP_DATABASE_NAME_PATTERN = new RegExp(
  `^(?:backup|pre-restore|pre-upgrade)-[0-9]{17}-${SQLITE_TRANSACTION_UUID}` +
    '\\.sqlite3$',
  'u',
);
const MANAGED_DATA_TRANSACTION_NAME_PATTERN = new RegExp(
  `^\\.memory-bridge\\.(?:restore-stage|pre-restore-rollback)-` +
    `${SQLITE_TRANSACTION_UUID}\\.sqlite3$`,
  'u',
);
const SQLITE_FAMILY_SUFFIXES = Object.freeze(['', '-wal', '-shm']);
const STOP_RECEIPT_PAYLOAD_KEYS = Object.freeze([
  'format',
  'package',
  'verifiedAt',
  'installId',
  'pid',
  'cwd',
  'readyUrl',
  'databasePath',
  'nonce',
]);
const STOP_RECEIPT_KEYS = Object.freeze([
  ...STOP_RECEIPT_PAYLOAD_KEYS,
  'hmacSha256',
]);
const REQUIRED_ARTIFACTS = Object.freeze([
  'dist/server/index.js',
  'dist/server/mcp-stdio.js',
  'dist/web/index.html',
]);
const REQUIRED_MCP_TOOLS = Object.freeze([
  'memory_forget',
  'memory_get_context',
  'memory_list',
  'memory_recall',
  'memory_remember',
  'memory_stats',
  'memory_update',
]);
const RELEASE_REQUIRED_CHECKS = Object.freeze([
  'runtime.node',
  'install.ownership',
  'install.artifacts',
  'install.fingerprints',
  'install.permissions',
  'database.integrity',
  'jobs.health',
  'ollama.models',
  'service.identity',
  'mcp.stdio',
]);
const SOURCE_BUNDLE_MARKER = '.memory-bridge-source-bundle.json';
const ALLOWED_SOURCE_ROOT_FILES = new Set([
  '.gitignore',
  SOURCE_BUNDLE_MARKER,
  'README.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'vite.config.ts',
]);
const ALLOWED_SOURCE_ROOT_DIRECTORIES = new Set(['src', 'scripts']);
const EXCLUDED_SOURCE_NAMES = new Set([
  '.DS_Store',
  'AGENTS.md',
]);
const SENSITIVE_SOURCE_NAMES = new Set([
  '.env',
  '.npmrc',
  'acceptance-secrets.json',
]);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertNotBroad(target, label) {
  const resolved = path.resolve(target);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} 不能是文件系统根目录`);
  }
  if (resolved === path.resolve(homedir())) {
    throw new Error(`${label} 不能是用户主目录`);
  }
  if (resolved.split(path.sep).filter(Boolean).length < 3) {
    throw new Error(`${label} 路径层级过宽`);
  }
}

function assertNoSymlinkComponents(target, label) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} 的现有路径组件不能是符号链接：${current}`);
    }
  }
}

function readPackage(source) {
  const packagePath = path.join(source, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error('源码缺少 package.json');
  const value = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (value.name !== EXPECTED_PACKAGE) {
    throw new Error(`源码包必须是 ${EXPECTED_PACKAGE}`);
  }
  return value;
}

export function assertManagedLayout({ source, installRoot, stateDir }) {
  const layout = {
    source: path.resolve(source),
    installRoot: path.resolve(installRoot),
    stateDir: path.resolve(stateDir),
  };
  for (const [label, value] of Object.entries(layout)) {
    assertNotBroad(value, label);
    assertNoSymlinkComponents(value, label);
  }
  if (!fs.existsSync(layout.source) || !fs.statSync(layout.source).isDirectory()) {
    throw new Error('source 必须是现有目录');
  }
  if (
    isInside(layout.source, layout.installRoot) ||
    isInside(layout.installRoot, layout.source)
  ) {
    throw new Error('源码与安装目录不能相同或重叠');
  }
  if (
    isInside(layout.installRoot, layout.stateDir) ||
    isInside(layout.stateDir, layout.installRoot)
  ) {
    throw new Error('安装目录与状态目录不能相同或重叠');
  }
  if (
    isInside(layout.source, layout.stateDir) ||
    isInside(layout.stateDir, layout.source)
  ) {
    throw new Error('源码与状态目录不能相同或重叠');
  }
  readPackage(layout.source);
  return layout;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`必须是非符号链接目录：${directory}`);
  }
}

function removeManaged(target) {
  if (!fs.existsSync(target)) return;
  assertNotBroad(target, '删除目标');
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`拒绝删除符号链接：${target}`);
  fs.rmSync(target, { recursive: true, force: false });
}

function acquireLock(stateDir) {
  ensurePrivateDirectory(stateDir);
  const lockPath = path.join(stateDir, LOCK_FILE);
  const descriptor = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(descriptor, `${process.pid} ${new Date().toISOString()}\n`);
  fs.closeSync(descriptor);
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  };
}

function writePrivateJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} 不是有效 JSON：${filePath}`);
  }
}

function assertPrivateRegularFile(filePath, label) {
  assertNoSymlinkComponents(filePath, label);
  if (!fs.existsSync(filePath)) throw new Error(`${label} 不存在`);
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} 必须是非符号链接普通文件`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error(`${label} 权限必须是 0600`);
  }
}

function readLifecycleAuthKey(layout) {
  const keyPath = path.join(layout.stateDir, LIFECYCLE_AUTH_KEY);
  assertPrivateRegularFile(keyPath, 'lifecycle auth key');
  const key = fs.readFileSync(keyPath);
  if (key.length !== 32) {
    throw new Error('lifecycle auth key 必须恰好是 256 bit');
  }
  return key;
}

function ensureLifecycleAuthKey(layout, requireNew) {
  const keyPath = path.join(layout.stateDir, LIFECYCLE_AUTH_KEY);
  if (fs.existsSync(keyPath)) {
    if (requireNew) {
      throw new Error('新安装发现残留 lifecycle auth key，拒绝复用未知 lineage');
    }
    readLifecycleAuthKey(layout);
    return false;
  }
  const descriptor = fs.openSync(keyPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, randomBytes(32));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(keyPath, 0o600);
  readLifecycleAuthKey(layout);
  return true;
}

function readPrivateJson(filePath, label) {
  assertPrivateRegularFile(filePath, label);
  return readJson(filePath, label);
}

function removePrivateLifecyclePath(filePath, label) {
  if (!fs.existsSync(filePath)) return;
  assertNoSymlinkComponents(filePath, label);
  removeManaged(filePath);
}

function assertManagedSqliteTransactionBasePath(stateDir, basePath) {
  const stateRoot = path.resolve(String(stateDir || ''));
  const resolved = path.resolve(String(basePath || ''));
  const parent = path.dirname(resolved);
  const name = path.basename(resolved);
  const backups = path.join(stateRoot, 'backups');
  const data = path.join(stateRoot, 'data');
  const owned =
    (parent === backups && MANAGED_BACKUP_DATABASE_NAME_PATTERN.test(name)) ||
    (parent === data && MANAGED_DATA_TRANSACTION_NAME_PATTERN.test(name));
  if (!owned) {
    throw new Error('SQLite transaction base path 不是受管 UUID-owned 路径');
  }
  assertNotBroad(resolved, 'SQLite transaction base path');
  assertNoSymlinkComponents(stateRoot, 'SQLite transaction state');
  assertNoSymlinkComponents(resolved, 'SQLite transaction base path');
  return resolved;
}

export function removeManagedSqliteTransactionFiles(input) {
  if (typeof input?.preserveBase !== 'undefined' &&
      typeof input.preserveBase !== 'boolean') {
    throw new Error('preserveBase 必须是 boolean');
  }
  const basePath = assertManagedSqliteTransactionBasePath(
    input?.stateDir,
    input?.basePath,
  );
  const suffixes = input?.preserveBase
    ? SQLITE_FAMILY_SUFFIXES.slice(1)
    : SQLITE_FAMILY_SUFFIXES;
  for (const suffix of suffixes) {
    const candidate = `${basePath}${suffix}`;
    if (!fs.existsSync(candidate)) continue;
    assertNoSymlinkComponents(candidate, 'SQLite transaction file');
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('SQLite transaction file 必须是非符号链接普通文件');
    }
    fs.unlinkSync(candidate);
  }
}

function renameSqliteFamily(sourceBase, targetBase) {
  const sourcePaths = SQLITE_FAMILY_SUFFIXES
    .map((suffix) => `${sourceBase}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate));
  if (sourcePaths[0] !== sourceBase) {
    throw new Error('SQLite family 缺少主数据库');
  }
  const targets = new Map(sourcePaths.map((sourcePath) => [
    sourcePath,
    `${targetBase}${sourcePath.slice(sourceBase.length)}`,
  ]));
  for (const [sourcePath, targetPath] of targets) {
    assertNoSymlinkComponents(sourcePath, 'SQLite family source');
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('SQLite family source 必须是非符号链接普通文件');
    }
    assertNoSymlinkComponents(targetPath, 'SQLite family target');
    if (fs.existsSync(targetPath)) {
      throw new Error('SQLite family target 已存在');
    }
  }
  const moved = [];
  try {
    for (const [sourcePath, targetPath] of targets) {
      fs.renameSync(sourcePath, targetPath);
      moved.push([sourcePath, targetPath]);
    }
  } catch (error) {
    for (const [sourcePath, targetPath] of moved.reverse()) {
      if (fs.existsSync(targetPath) && !fs.existsSync(sourcePath)) {
        fs.renameSync(targetPath, sourcePath);
      }
    }
    throw error;
  }
}

function clearStopLifecycleArtifacts(layout, options = {}) {
  removePrivateLifecyclePath(
    path.join(layout.stateDir, STOP_AUTHORIZATION_FILE),
    'Stop authorization',
  );
  removePrivateLifecyclePath(
    path.join(layout.stateDir, 'receipts'),
    'Stop receipts',
  );
  if (options.removeKey) {
    removePrivateLifecyclePath(
      path.join(layout.stateDir, LIFECYCLE_AUTH_KEY),
      'lifecycle auth key',
    );
  }
  if (options.recreateReceipts) {
    ensurePrivateDirectory(path.join(layout.stateDir, 'receipts'));
  }
}

function regularFiles(root, filter = () => true) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (!filter(relative, entry)) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
    }
  }
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function hashFiles(root, relativePaths) {
  const hashes = {};
  for (const relativePath of relativePaths) {
    hashes[relativePath] = createHash('sha256')
      .update(fs.readFileSync(path.join(root, relativePath)))
      .digest('hex');
  }
  return hashes;
}

function artifactFingerprints(root) {
  const distRoot = path.join(root, 'dist');
  if (!fs.existsSync(distRoot)) return {};
  return hashFiles(root, regularFiles(distRoot).map(
    (relativePath) => path.join('dist', relativePath),
  ));
}

function assertManagedManifest(layout, allowedStatuses = ['installed']) {
  const manifestPath = path.join(layout.stateDir, INSTALL_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error('缺少受管安装 manifest，拒绝修改');
  }
  const manifest = readJson(manifestPath, '安装 manifest');
  const expectedDataDir = path.join(layout.stateDir, 'data');
  if (
    manifest.format !== 'memory-bridge-install:v1' ||
    !allowedStatuses.includes(manifest.status) ||
    path.resolve(String(manifest.installRoot || '')) !== layout.installRoot ||
    path.resolve(String(manifest.dataDir || '')) !== expectedDataDir ||
    typeof manifest.installId !== 'string' ||
    !manifest.installId
  ) {
    throw new Error('安装 manifest 与受管目录所有权不匹配');
  }
  return { manifest, manifestPath };
}

function assertOwnedRelease(releaseRoot, installId, label) {
  const markerPath = path.join(releaseRoot, MANAGED_MARKER);
  if (!fs.existsSync(markerPath)) {
    throw new Error(`${label} 缺少所有权标记，拒绝删除`);
  }
  const marker = readJson(markerPath, `${label}所有权标记`);
  if (
    marker.format !== 'memory-bridge-managed-install:v1' ||
    marker.package !== EXPECTED_PACKAGE ||
    marker.installId !== installId
  ) {
    throw new Error(`${label}所有权与 installId 不匹配，拒绝删除`);
  }
  if (readPackage(releaseRoot).name !== EXPECTED_PACKAGE) {
    throw new Error(`${label}包标识无效，拒绝删除`);
  }
  return { marker, markerPath };
}

function removeOwnedRelease(releaseRoot, installId, label) {
  if (!fs.existsSync(releaseRoot)) return;
  assertOwnedRelease(releaseRoot, installId, label);
  removeManaged(releaseRoot);
}

function assertManagedInstallation(layout) {
  const managed = assertManagedManifest(layout);
  if (!fs.existsSync(layout.installRoot)) {
    throw new Error('受管安装目录缺失');
  }
  const owned = assertOwnedRelease(
    layout.installRoot,
    managed.manifest.installId,
    '安装目录',
  );
  return { ...managed, ...owned };
}

function stopProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function assertStopOwnership(input, managedOverride = null) {
  const layout = assertManagedLayout(input);
  const managed = managedOverride || assertManagedInstallation(layout);
  const pid = Number(input.pid);
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error('stop PID 必须是正整数');
  }
  let readyUrl;
  try {
    readyUrl = new URL(String(input.readyUrl || ''));
  } catch {
    throw new Error('stop ready URL 无效');
  }
  const port = Number(readyUrl.port);
  if (port === 3789) {
    throw new Error('stop ready URL 使用受保护端口 3789，拒绝停止');
  }
  if (
    readyUrl.protocol !== 'http:' ||
    readyUrl.hostname !== '127.0.0.1' ||
    readyUrl.username ||
    readyUrl.password ||
    readyUrl.pathname !== '/' ||
    readyUrl.search ||
    readyUrl.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('stop ready URL 必须是严格的 127.0.0.1 HTTP origin');
  }
  let ownedRoot;
  let runtimeCwd;
  try {
    ownedRoot = fs.realpathSync(layout.installRoot);
    runtimeCwd = fs.realpathSync(String(input.cwd || ''));
  } catch {
    throw new Error('stop cwd 必须是受管安装内的现有真实路径');
  }
  if (!isInside(ownedRoot, runtimeCwd)) {
    throw new Error('stop cwd 不属于受管安装，拒绝停止 foreign owner');
  }
  return { layout, managed, pid, port, ownedRoot, runtimeCwd, readyUrl };
}

function inspectStopProcess(args, label, allowNoMatch = false) {
  const command = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 2_000,
  });
  if (result.error) {
    throw new Error(`${label} 检查失败，拒绝停止：${result.error.code || 'unknown'}`);
  }
  if (result.status !== 0 && !(allowNoMatch && result.status === 1)) {
    throw new Error(`${label} 检查失败，拒绝停止：status=${String(result.status)}`);
  }
  return String(result.stdout || '');
}

function actualStopProcessCwd(pid) {
  const procCwd = `/proc/${pid}/cwd`;
  if (fs.existsSync(procCwd)) {
    try {
      return fs.realpathSync(procCwd);
    } catch {
      throw new Error('无法读取 stop PID 的真实 cwd，拒绝停止');
    }
  }
  const output = inspectStopProcess(
    ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    'stop PID 真实 cwd',
  );
  const cwd = output.split(/\r?\n/u).find((line) => line.startsWith('n'))?.slice(1);
  if (!cwd) throw new Error('无法读取 stop PID 的真实 cwd，拒绝停止');
  return fs.realpathSync(cwd);
}

function stopListenerPids(port) {
  const output = inspectStopProcess(
    ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t'],
    'stop ready URL listener PID',
    true,
  );
  return [...new Set(output.split(/\s+/u)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

function databaseHolderPids(databasePath) {
  if (!fs.existsSync(databasePath)) return [];
  const output = inspectStopProcess(
    ['-t', databasePath],
    'Memory Bridge 数据库 holder PID',
    true,
  );
  return [...new Set(output.split(/\s+/u)
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

async function assertRuntimeFullyStopped(ownership) {
  if (stopProcessAlive(ownership.pid)) {
    throw new Error(`受管 PID ${ownership.pid} 仍存活，拒绝 Restore`);
  }
  const listenerPids = stopListenerPids(ownership.port);
  if (listenerPids.length > 0) {
    throw new Error(`ready URL listener 仍在监听，PID=${listenerPids.join(',')}`);
  }
  if (await stopUrlReachable(ownership.readyUrl)) {
    throw new Error('ready URL 仍可达，拒绝 Restore');
  }
  const databasePath = path.join(
    ownership.layout.stateDir,
    'data',
    'memory-bridge.sqlite3',
  );
  const holderPids = databaseHolderPids(databasePath);
  if (holderPids.length > 0) {
    throw new Error(`Memory Bridge 数据库仍被 holder PID 占用：${holderPids.join(',')}`);
  }
  return databasePath;
}

function managedReceiptPath(layout, candidate, label) {
  const receiptDir = path.resolve(layout.stateDir, 'receipts');
  const receiptPath = path.resolve(String(candidate || ''));
  if (receiptPath === receiptDir || !isInside(receiptDir, receiptPath)) {
    throw new Error(`${label} 必须位于受管 state/receipts 目录内`);
  }
  assertNoSymlinkComponents(receiptPath, label);
  return receiptPath;
}

function canonicalStopReceiptPayload(receipt) {
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

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expected = [...expectedKeys].sort((left, right) => left.localeCompare(right));
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function stopIdentityFields(ownership, databasePath) {
  return {
    installId: ownership.managed.manifest.installId,
    pid: ownership.pid,
    cwd: ownership.ownedRoot,
    readyUrl: ownership.readyUrl.origin,
    databasePath,
  };
}

function writeStopAuthorization(layout, authorization) {
  const authorizationPath = path.join(layout.stateDir, STOP_AUTHORIZATION_FILE);
  if (fs.existsSync(authorizationPath)) {
    assertPrivateRegularFile(authorizationPath, 'Stop authorization');
  }
  writePrivateJson(authorizationPath, authorization);
  fs.chmodSync(authorizationPath, 0o600);
  return authorizationPath;
}

function readStopAuthorization(layout) {
  return readPrivateJson(
    path.join(layout.stateDir, STOP_AUTHORIZATION_FILE),
    'Stop authorization',
  );
}

function assertStopAuthorization(authorization, ownership, databasePath, status) {
  const baseKeys = [
    'format', 'package', 'status', 'createdAt', 'installId', 'pid', 'cwd',
    'readyUrl', 'databasePath', 'nonce',
  ];
  const expectedKeys = status === 'pending'
    ? baseKeys
    : status === 'issued'
      ? [...baseKeys, 'issuedAt', 'receiptPath']
      : [...baseKeys, 'issuedAt', 'receiptPath', 'consumedAt'];
  const identity = stopIdentityFields(ownership, databasePath);
  if (
    !hasExactKeys(authorization, expectedKeys) ||
    authorization.format !== STOP_AUTHORIZATION_FORMAT ||
    authorization.package !== EXPECTED_PACKAGE ||
    authorization.status !== status ||
    authorization.installId !== identity.installId ||
    authorization.pid !== identity.pid ||
    authorization.cwd !== identity.cwd ||
    authorization.readyUrl !== identity.readyUrl ||
    authorization.databasePath !== identity.databasePath ||
    !/^[a-f0-9]{64}$/u.test(String(authorization.nonce || ''))
  ) {
    throw new Error(`Stop authorization 身份或授权状态无效（expected=${status}）`);
  }
  const createdAt = Date.parse(String(authorization.createdAt || ''));
  const age = Date.now() - createdAt;
  if (!Number.isFinite(createdAt) || age < -5_000 || age > STOP_RECEIPT_MAX_AGE_MS) {
    throw new Error('Stop authorization 已过期，必须重新执行 Stop preflight');
  }
  return authorization;
}

function writePendingStopAuthorization(ownership) {
  readLifecycleAuthKey(ownership.layout);
  const databasePath = path.join(
    ownership.layout.stateDir,
    'data',
    'memory-bridge.sqlite3',
  );
  writeStopAuthorization(ownership.layout, {
    format: STOP_AUTHORIZATION_FORMAT,
    package: EXPECTED_PACKAGE,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...stopIdentityFields(ownership, databasePath),
    nonce: randomBytes(32).toString('hex'),
  });
}

function writeStopPostflightReceipt(ownership, databasePath, candidate, authorization) {
  ensurePrivateDirectory(path.join(ownership.layout.stateDir, 'receipts'));
  const receiptPath = managedReceiptPath(
    ownership.layout,
    candidate,
    'Stop postflight receipt',
  );
  if (fs.existsSync(receiptPath)) {
    assertPrivateRegularFile(receiptPath, 'Stop postflight receipt');
  }
  const key = readLifecycleAuthKey(ownership.layout);
  const receipt = {
    format: STOP_RECEIPT_FORMAT,
    package: EXPECTED_PACKAGE,
    verifiedAt: new Date().toISOString(),
    ...stopIdentityFields(ownership, databasePath),
    nonce: authorization.nonce,
  };
  const hmacSha256 = createHmac('sha256', key)
    .update(canonicalStopReceiptPayload(receipt))
    .digest('hex');
  writePrivateJson(receiptPath, { ...receipt, hmacSha256 });
  fs.chmodSync(receiptPath, 0o600);
  writeStopAuthorization(ownership.layout, {
    ...authorization,
    status: 'issued',
    issuedAt: receipt.verifiedAt,
    receiptPath,
  });
  return receiptPath;
}

function assertStopRuntimeBinding(ownership) {
  const actualCwd = actualStopProcessCwd(ownership.pid);
  if (actualCwd !== ownership.runtimeCwd || actualCwd !== ownership.ownedRoot) {
    throw new Error('stop PID 的真实 cwd 与受管安装 process cwd 不匹配');
  }
  const listenerPids = stopListenerPids(ownership.port);
  if (listenerPids.length !== 1 || listenerPids[0] !== ownership.pid) {
    throw new Error('stop PID 与 ready URL listener PID 不一致，拒绝停止');
  }
}

async function fetchStopHealth(readyUrl) {
  const response = await fetch(new URL('/api/health', readyUrl), {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error(`Memory Bridge health HTTP ${response.status}`);
  const body = await response.json();
  if (
    body?.ok !== true ||
    body?.service !== EXPECTED_PACKAGE ||
    body?.mcpTransport !== 'stdio'
  ) {
    throw new Error('ready URL 的服务身份不是 Memory Bridge');
  }
}

async function stopUrlReachable(readyUrl) {
  try {
    await fetch(new URL('/api/health', readyUrl), {
      signal: AbortSignal.timeout(500),
    });
    return true;
  } catch {
    return false;
  }
}

export async function verifyStopLifecycle(input) {
  const layout = assertManagedLayout(input);
  ensurePrivateDirectory(layout.stateDir);
  const releaseLock = acquireLock(layout.stateDir);
  try {
    const ownership = assertStopOwnership(input);
    if (input.phase === 'preflight') {
      if (!stopProcessAlive(ownership.pid)) throw new Error('stop PID 当前不存活');
      assertStopRuntimeBinding(ownership);
      await fetchStopHealth(ownership.readyUrl);
      writePendingStopAuthorization(ownership);
      return {
        status: 'stop-preflight-passed',
        ownership: 'verified',
        pid: ownership.pid,
        readyUrl: ownership.readyUrl.origin,
      };
    }
    if (input.phase !== 'postflight' || input.verifyStopped !== true) {
      throw new Error('stop phase 必须是 preflight，或带 --verify-stopped 的 postflight');
    }
    const expectedDatabasePath = path.join(
      ownership.layout.stateDir,
      'data',
      'memory-bridge.sqlite3',
    );
    const authorization = assertStopAuthorization(
      readStopAuthorization(ownership.layout),
      ownership,
      expectedDatabasePath,
      'pending',
    );
    readLifecycleAuthKey(ownership.layout);
    const deadline = Date.now() + 5_000;
    do {
      try {
        const databasePath = await assertRuntimeFullyStopped(ownership);
        const receiptPath = writeStopPostflightReceipt(
          ownership,
          databasePath,
          input.receiptFile,
          authorization,
        );
        return {
          status: 'stop-postflight-verified',
          ownership: 'verified',
          stopped: true,
          pid: ownership.pid,
          receiptPath,
        };
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`postflight verify failed：PID ${ownership.pid} 或 ready URL 仍存活`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (true);
  } finally {
    releaseLock();
  }
}

function sensitiveSourcePath(relative) {
  const parts = relative.split(path.sep);
  return parts.some((part) =>
    SENSITIVE_SOURCE_NAMES.has(part) ||
    part.startsWith('.env.') ||
    /\.(?:key|pem|p12|pfx)$/iu.test(part));
}

function allowedProjectSourcePath(relative, options = {}) {
  if (!relative) return true;
  const parts = relative.split(path.sep);
  const first = parts[0];
  return ALLOWED_SOURCE_ROOT_DIRECTORIES.has(first) ||
    (options.includeDist === true && first === 'dist') ||
    (parts.length === 1 && ALLOWED_SOURCE_ROOT_FILES.has(first));
}

function copyProjectSource(source, destination, options = {}) {
  const root = path.resolve(source);
  fs.cpSync(root, destination, {
    recursive: true,
    dereference: false,
    filter(candidate) {
      const relative = path.relative(root, candidate);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      if (
        !allowedProjectSourcePath(relative, options) ||
        parts.some((part) => EXCLUDED_SOURCE_NAMES.has(part))
      ) return false;
      if (sensitiveSourcePath(relative)) return false;
      if (fs.lstatSync(candidate).isSymbolicLink()) return false;
      return true;
    },
  });
}

function defaultCommandRunner(command, args, options) {
  return new Promise((resolve, reject) => {
    const stdio = options.stdio || 'inherit';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    const appendBounded = (current, chunk) => `${current}${String(chunk)}`.slice(-1_048_576);
    child.stdout?.on('data', (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback(value);
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          finish(reject, new Error(`${command} 执行超时`));
        }, options.timeoutMs)
      : null;
    child.once('error', (error) => finish(reject, error));
    child.once('exit', (code, signal) => {
      if (code === 0) finish(resolve, { code, signal, stdout, stderr });
      else finish(reject, new Error(
        `${command} 执行失败：code=${String(code)} signal=${String(signal)}`,
      ));
    });
  });
}

async function prepareRelease(source, stageRoot, options) {
  copyProjectSource(source, stageRoot, { includeDist: options.skipBuild === true });
  const runner = options.commandRunner || defaultCommandRunner;
  if (!options.skipDependencies) {
    await runner('npm', ['ci', '--no-audit', '--no-fund'], { cwd: stageRoot });
  }
  if (!options.skipBuild) {
    await runner('npm', ['run', 'build'], { cwd: stageRoot });
  }
  for (const relativePath of REQUIRED_ARTIFACTS) {
    const artifact = path.join(stageRoot, relativePath);
    if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) {
      throw new Error(`安装产物缺失：${relativePath}`);
    }
  }
}

function sourceFingerprint(source) {
  const hash = createHash('sha256');
  const relativePaths = regularFiles(source, (relativePath, entry) => {
    const parts = relativePath.split(path.sep);
    if (!allowedProjectSourcePath(relativePath, { includeDist: true })) return false;
    if (parts.some((part) => EXCLUDED_SOURCE_NAMES.has(part))) return false;
    if (relativePath === MANAGED_MARKER || sensitiveSourcePath(relativePath)) {
      return false;
    }
    return true;
  });
  for (const relativePath of relativePaths) {
    const filePath = path.join(source, relativePath);
    hash.update(relativePath).update('\0').update(fs.readFileSync(filePath)).update('\n');
  }
  return hash.digest('hex');
}

async function backupCurrentDatabase(stateDir) {
  const databasePath = path.join(stateDir, 'data', 'memory-bridge.sqlite3');
  if (!fs.existsSync(databasePath)) return null;
  const backups = path.join(stateDir, 'backups');
  ensurePrivateDirectory(backups);
  const stamp = new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 17);
  const target = path.join(
    backups,
    `pre-upgrade-${stamp}-${randomUUID()}.sqlite3`,
  );
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(database, target);
    } finally {
      database.close();
    }
    removeManagedSqliteTransactionFiles({
      stateDir,
      basePath: target,
      preserveBase: true,
    });
    fs.chmodSync(target, 0o600);
    return target;
  } catch (error) {
    removeManagedSqliteTransactionFiles({ stateDir, basePath: target });
    throw error;
  }
}

function databaseSha256(databasePath) {
  return createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex');
}

function inspectBackupDatabase(databasePath, label) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = String(Object.values(
      database.prepare('PRAGMA integrity_check').get() || {},
    )[0] || '');
    const foreignKeyViolations = database.prepare('PRAGMA foreign_key_check').all().length;
    if (integrity !== 'ok') throw new Error(`${label} integrity_check 失败：${integrity}`);
    if (foreignKeyViolations !== 0) {
      throw new Error(`${label} foreign_key_check 发现 ${foreignKeyViolations} 条违规`);
    }
    return {
      schemaVersion: scalar(database, 'PRAGMA user_version'),
      integrity,
      foreignKeyViolations,
    };
  } finally {
    database.close();
  }
}

function inspectManagedTransactionDatabase(stateDir, databasePath, label) {
  try {
    return inspectBackupDatabase(databasePath, label);
  } finally {
    removeManagedSqliteTransactionFiles({
      stateDir,
      basePath: databasePath,
      preserveBase: true,
    });
  }
}

function writeBackupManifestExclusive(manifestPath, manifest) {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(manifestPath, 0o600);
}

function backupDirectory(layout) {
  return path.join(layout.stateDir, 'backups');
}

function assertBackupFilePath(layout, candidate) {
  const backups = path.resolve(backupDirectory(layout));
  const backupPath = path.resolve(String(candidate || ''));
  if (backupPath === backups || !isInside(backups, backupPath)) {
    throw new Error('备份文件必须位于受管 state/backups 目录内');
  }
  assertNoSymlinkComponents(backupPath, '备份文件');
  return backupPath;
}

async function createDatabaseBackupUnlocked(layout, managed, kind) {
  const databasePath = path.join(layout.stateDir, 'data', 'memory-bridge.sqlite3');
  if (!fs.existsSync(databasePath)) throw new Error('当前 Memory Bridge 数据库不存在');
  inspectBackupDatabase(databasePath, '当前数据库');
  const backups = backupDirectory(layout);
  ensurePrivateDirectory(backups);
  const stamp = new Date().toISOString().replace(/[^0-9]/gu, '').slice(0, 17);
  const backupPath = path.join(backups, `${kind}-${stamp}-${randomUUID()}.sqlite3`);
  const manifestPath = `${backupPath}.manifest.json`;
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      await backup(database, backupPath);
    } finally {
      database.close();
    }
    removeManagedSqliteTransactionFiles({
      stateDir: layout.stateDir,
      basePath: backupPath,
      preserveBase: true,
    });
    fs.chmodSync(backupPath, 0o600);
    const verification = inspectManagedTransactionDatabase(
      layout.stateDir,
      backupPath,
      '备份数据库',
    );
    const bytes = fs.statSync(backupPath).size;
    const sha256 = databaseSha256(backupPath);
    const manifest = {
      format: 'memory-bridge-backup-manifest:v1',
      package: EXPECTED_PACKAGE,
      kind,
      createdAt: new Date().toISOString(),
      installId: managed.manifest.installId,
      databaseFile: path.basename(backupPath),
      bytes,
      sha256,
      schemaVersion: verification.schemaVersion,
    };
    writeBackupManifestExclusive(manifestPath, manifest);
    return { status: 'backed-up', backupPath, manifestPath, ...manifest };
  } catch (error) {
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    removeManagedSqliteTransactionFiles({
      stateDir: layout.stateDir,
      basePath: backupPath,
    });
    throw error;
  }
}

export async function createDatabaseBackup(input) {
  const layout = assertManagedLayout(input);
  const managed = assertManagedInstallation(layout);
  ensurePrivateDirectory(layout.stateDir);
  const releaseLock = acquireLock(layout.stateDir);
  try {
    return await createDatabaseBackupUnlocked(layout, managed, 'backup');
  } finally {
    releaseLock();
  }
}

async function assertVerifiedStopReceipt(input, layout, managed) {
  const receiptPath = managedReceiptPath(
    layout,
    input.stopReceipt,
    'Restore Stop receipt',
  );
  if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
    throw new Error('Restore 缺少可验证 Stop postflight receipt');
  }
  const receipt = readPrivateJson(receiptPath, 'Restore Stop receipt');
  if (
    !hasExactKeys(receipt, STOP_RECEIPT_KEYS) ||
    receipt.format !== STOP_RECEIPT_FORMAT ||
    receipt.package !== EXPECTED_PACKAGE ||
    typeof receipt.verifiedAt !== 'string' ||
    typeof receipt.installId !== 'string' ||
    !Number.isInteger(receipt.pid) ||
    receipt.pid < 1 ||
    typeof receipt.cwd !== 'string' ||
    typeof receipt.readyUrl !== 'string' ||
    typeof receipt.databasePath !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(String(receipt.nonce || '')) ||
    !/^[a-f0-9]{64}$/u.test(String(receipt.hmacSha256 || ''))
  ) {
    throw new Error('Restore Stop receipt HMAC 签名结构无效');
  }
  const key = readLifecycleAuthKey(layout);
  const expectedHmac = createHmac('sha256', key)
    .update(canonicalStopReceiptPayload(receipt))
    .digest();
  const suppliedHmac = Buffer.from(receipt.hmacSha256, 'hex');
  if (
    suppliedHmac.length !== expectedHmac.length ||
    !timingSafeEqual(suppliedHmac, expectedHmac)
  ) {
    throw new Error('Restore Stop receipt HMAC 签名认证失败');
  }
  const verifiedAt = Date.parse(String(receipt.verifiedAt || ''));
  const age = Date.now() - verifiedAt;
  const expectedDatabasePath = path.join(
    layout.stateDir,
    'data',
    'memory-bridge.sqlite3',
  );
  if (
    receipt.installId !== managed.manifest.installId ||
    !Number.isFinite(verifiedAt) ||
    age < -5_000 ||
    age > STOP_RECEIPT_MAX_AGE_MS ||
    receipt.databasePath !== expectedDatabasePath
  ) {
    if (Number.isFinite(verifiedAt) && age > STOP_RECEIPT_MAX_AGE_MS) {
      throw new Error('Restore Stop receipt 已过期，必须重新执行 stopped postflight');
    }
    throw new Error('Restore Stop receipt 身份、installId 或路径无效');
  }
  const ownership = assertStopOwnership({
    source: layout.source,
    installRoot: layout.installRoot,
    stateDir: layout.stateDir,
    pid: receipt.pid,
    cwd: receipt.cwd,
    readyUrl: receipt.readyUrl,
  }, managed);
  const authorization = readStopAuthorization(layout);
  if (authorization.status === 'consumed') {
    throw new Error('Restore Stop authorization 已消费（consumed），拒绝 replay');
  }
  assertStopAuthorization(
    authorization,
    ownership,
    expectedDatabasePath,
    'issued',
  );
  if (
    authorization.nonce !== receipt.nonce ||
    authorization.issuedAt !== receipt.verifiedAt ||
    authorization.receiptPath !== receiptPath
  ) {
    throw new Error('Restore Stop receipt 与 issued authorization 不匹配');
  }
  const verifiedDatabasePath = await assertRuntimeFullyStopped(ownership);
  if (verifiedDatabasePath !== expectedDatabasePath) {
    throw new Error('Restore Stop receipt 数据库路径复核失败');
  }
  return { authorization, receiptPath, ownership };
}

async function issuedStopArtifactsArePreservable(layout, managed) {
  try {
    const authorization = readStopAuthorization(layout);
    if (authorization.status !== 'issued') return false;
    assertOwnedRelease(
      layout.installRoot,
      managed.manifest.installId,
      'Stop proof 受管安装',
    );
    await assertVerifiedStopReceipt(
      { stopReceipt: authorization.receiptPath },
      layout,
      managed,
    );
    return true;
  } catch {
    return false;
  }
}

function consumeVerifiedStopReceipt(layout, verified) {
  writeStopAuthorization(layout, {
    ...verified.authorization,
    status: 'consumed',
    consumedAt: new Date().toISOString(),
  });
  try {
    fs.unlinkSync(verified.receiptPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function verifyBackupManifest(layout, managed, candidate) {
  const backupPath = assertBackupFilePath(layout, candidate);
  assertManagedSqliteTransactionBasePath(layout.stateDir, backupPath);
  const manifestPath = `${backupPath}.manifest.json`;
  try {
    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
      throw new Error('Restore 备份数据库不存在');
    }
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
      throw new Error('Restore 缺少专用 backup manifest');
    }
    const manifest = readJson(manifestPath, 'backup manifest');
    const bytes = fs.statSync(backupPath).size;
    const sha256 = databaseSha256(backupPath);
    if (
      manifest.format !== 'memory-bridge-backup-manifest:v1' ||
      manifest.package !== EXPECTED_PACKAGE ||
      manifest.installId !== managed.manifest.installId ||
      manifest.databaseFile !== path.basename(backupPath) ||
      manifest.bytes !== bytes ||
      manifest.sha256 !== sha256
    ) {
      throw new Error('Restore backup manifest/hash 验证失败（SHA-256 mismatch）');
    }
    const privateMode = (filePath) => fs.statSync(filePath).mode & 0o777;
    if (privateMode(backupPath) !== 0o600 || privateMode(manifestPath) !== 0o600) {
      throw new Error('Restore 备份或 manifest 权限不是 0600');
    }
    const verification = inspectBackupDatabase(
      backupPath,
      'Restore 备份数据库',
    );
    return { backupPath, manifestPath, manifest, verification };
  } finally {
    removeManagedSqliteTransactionFiles({
      stateDir: layout.stateDir,
      basePath: backupPath,
      preserveBase: true,
    });
  }
}

export async function restoreDatabaseBackup(input) {
  const layout = assertManagedLayout(input);
  const managed = assertManagedInstallation(layout);
  ensurePrivateDirectory(layout.stateDir);
  const releaseLock = acquireLock(layout.stateDir);
  const databasePath = path.join(layout.stateDir, 'data', 'memory-bridge.sqlite3');
  let stagePath = null;
  let preRestoreRollbackPath = null;
  let currentMoved = false;
  let restoredSwitched = false;
  try {
    const verifiedStop = await assertVerifiedStopReceipt(input, layout, managed);
    consumeVerifiedStopReceipt(layout, verifiedStop);
    if (!fs.existsSync(databasePath)) throw new Error('当前数据库不存在，无法创建 pre-restore 备份');
    const selected = verifyBackupManifest(layout, managed, input.backupPath);
    const preRestore = await createDatabaseBackupUnlocked(layout, managed, 'pre-restore');
    stagePath = assertManagedSqliteTransactionBasePath(
      layout.stateDir,
      path.join(
        path.dirname(databasePath),
        `.memory-bridge.restore-stage-${randomUUID()}.sqlite3`,
      ),
    );
    preRestoreRollbackPath = assertManagedSqliteTransactionBasePath(
      layout.stateDir,
      path.join(
        path.dirname(databasePath),
        `.memory-bridge.pre-restore-rollback-${randomUUID()}.sqlite3`,
      ),
    );
    fs.copyFileSync(selected.backupPath, stagePath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stagePath, 0o600);
    inspectManagedTransactionDatabase(
      layout.stateDir,
      stagePath,
      'Restore staged 数据库',
    );
    if (databaseSha256(stagePath) !== selected.manifest.sha256) {
      throw new Error('Restore staged 数据库 SHA-256 verify mismatch');
    }
    const verifiedDatabasePath = await assertRuntimeFullyStopped(verifiedStop.ownership);
    if (verifiedDatabasePath !== databasePath) {
      throw new Error('Restore Stop authorization 数据库路径复核失败');
    }
    renameSqliteFamily(databasePath, preRestoreRollbackPath);
    currentMoved = true;
    renameSqliteFamily(stagePath, databasePath);
    restoredSwitched = true;
    if (input.testOnlyAfterRestoreSwitch) await input.testOnlyAfterRestoreSwitch();
    inspectBackupDatabase(databasePath, 'Restore 已切换数据库');
    if (databaseSha256(databasePath) !== selected.manifest.sha256) {
      throw new Error('Restore 已切换数据库 SHA-256 verify mismatch');
    }
    removeManagedSqliteTransactionFiles({
      stateDir: layout.stateDir,
      basePath: preRestoreRollbackPath,
    });
    currentMoved = false;
    preRestoreRollbackPath = null;
    stagePath = null;
    return {
      status: 'restored',
      backupPath: selected.backupPath,
      backupManifest: selected.manifestPath,
      preRestoreBackup: preRestore.backupPath,
      preRestoreManifest: preRestore.manifestPath,
      sha256: selected.manifest.sha256,
    };
  } catch (error) {
    let recoveryError = null;
    try {
      if (restoredSwitched && stagePath && fs.existsSync(databasePath)) {
        renameSqliteFamily(databasePath, stagePath);
        restoredSwitched = false;
      }
      if (
        currentMoved &&
        preRestoreRollbackPath &&
        fs.existsSync(preRestoreRollbackPath)
      ) {
        renameSqliteFamily(preRestoreRollbackPath, databasePath);
        currentMoved = false;
      }
    } catch (caught) {
      recoveryError = caught;
    }
    if (stagePath) {
      removeManagedSqliteTransactionFiles({
        stateDir: layout.stateDir,
        basePath: stagePath,
      });
    }
    if (!currentMoved && preRestoreRollbackPath) {
      removeManagedSqliteTransactionFiles({
        stateDir: layout.stateDir,
        basePath: preRestoreRollbackPath,
      });
    }
    if (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        'Restore 失败且 WAL family 回滚未确认完成',
      );
    }
    throw error;
  } finally {
    releaseLock();
  }
}

async function deployProject(mode, input) {
  const layout = assertManagedLayout(input);
  const packageValue = readPackage(layout.source);
  ensurePrivateDirectory(layout.stateDir);
  ensurePrivateDirectory(path.join(layout.stateDir, 'data'));
  ensurePrivateDirectory(path.join(layout.stateDir, 'receipts'));
  const releaseLock = acquireLock(layout.stateDir);
  const parent = path.dirname(layout.installRoot);
  const base = path.basename(layout.installRoot);
  const stageRoot = path.join(parent, `.${base}.stage-${randomUUID()}`);
  const rollbackRoot = path.join(parent, `.${base}.rollback`);
  let currentMoved = false;
  let newReleaseDeployed = false;
  let installId = null;
  let lifecycleKeyCreated = false;
  try {
    if (mode === 'install' && fs.existsSync(layout.installRoot)) {
      throw new Error('安装目录已存在，请使用 upgrade');
    }
    const previous = mode === 'upgrade'
      ? assertManagedInstallation(layout)
      : null;
    const priorManifestPath = path.join(layout.stateDir, INSTALL_MANIFEST);
    const preserved = mode === 'install' && fs.existsSync(priorManifestPath)
      ? assertManagedManifest(layout, ['uninstalled'])
      : null;
    const preservedLineage = preserved?.manifest.dataPreserved === true
      ? preserved
      : null;
    if (mode === 'upgrade' && !fs.existsSync(layout.installRoot)) {
      throw new Error('升级要求已存在的受管安装');
    }
    fs.mkdirSync(parent, { recursive: true });
    await prepareRelease(layout.source, stageRoot, input);
    lifecycleKeyCreated = ensureLifecycleAuthKey(
      layout,
      !previous && !preservedLineage,
    );
    installId = previous?.manifest.installId ||
      preservedLineage?.manifest.installId ||
      randomUUID();
    writePrivateJson(path.join(stageRoot, MANAGED_MARKER), {
      format: 'memory-bridge-managed-install:v1',
      package: EXPECTED_PACKAGE,
      installId,
    });
    const artifacts = artifactFingerprints(stageRoot);
    const databaseBackup = mode === 'upgrade'
      ? await backupCurrentDatabase(layout.stateDir)
      : null;
    if (mode === 'upgrade' && fs.existsSync(layout.installRoot)) {
      removeOwnedRelease(rollbackRoot, installId, '旧回滚目录');
      fs.renameSync(layout.installRoot, rollbackRoot);
      currentMoved = true;
    }
    fs.renameSync(stageRoot, layout.installRoot);
    newReleaseDeployed = true;
    if (input.testOnlyAfterSwitch) await input.testOnlyAfterSwitch();
    const preserveStopArtifacts = mode === 'install' && preservedLineage
      ? await issuedStopArtifactsArePreservable(
          layout,
          { manifest: { installId } },
        )
      : false;
    if (!preserveStopArtifacts) {
      clearStopLifecycleArtifacts(layout, { recreateReceipts: true });
    }
    const now = new Date().toISOString();
    writePrivateJson(path.join(layout.stateDir, INSTALL_MANIFEST), {
      format: 'memory-bridge-install:v1',
      status: 'installed',
      installId,
      version: String(packageValue.version || '0.0.0'),
      installedAt: previous?.manifest.installedAt ||
        preservedLineage?.manifest.installedAt ||
        now,
      updatedAt: now,
      installRoot: layout.installRoot,
      dataDir: path.join(layout.stateDir, 'data'),
      rollbackRoot: currentMoved ? rollbackRoot : null,
      databaseBackup,
      sourceFingerprint: sourceFingerprint(layout.installRoot),
      artifacts,
      nodeVersion: process.version,
    });
    return {
      status: mode === 'upgrade' ? 'upgraded' : 'installed',
      version: String(packageValue.version || '0.0.0'),
      installRoot: layout.installRoot,
      stateDir: layout.stateDir,
      dataDir: path.join(layout.stateDir, 'data'),
      rollbackRoot: currentMoved ? rollbackRoot : null,
      databaseBackup,
    };
  } catch (error) {
    try {
      if (fs.existsSync(stageRoot)) removeManaged(stageRoot);
      if (newReleaseDeployed && fs.existsSync(layout.installRoot) && installId) {
        removeOwnedRelease(layout.installRoot, installId, '失败的新发布目录');
      }
      if (currentMoved && fs.existsSync(rollbackRoot)) {
        fs.renameSync(rollbackRoot, layout.installRoot);
      }
    } finally {
      if (lifecycleKeyCreated) {
        removePrivateLifecyclePath(
          path.join(layout.stateDir, LIFECYCLE_AUTH_KEY),
          '失败部署 lifecycle auth key',
        );
      }
    }
    throw error;
  } finally {
    releaseLock();
  }
}

export async function installProject(input) {
  return deployProject('install', input);
}

export async function upgradeProject(input) {
  return deployProject('upgrade', input);
}

export async function uninstallProject(input) {
  const source = input.source || process.cwd();
  const layout = assertManagedLayout({ ...input, source });
  ensurePrivateDirectory(layout.stateDir);
  const releaseLock = acquireLock(layout.stateDir);
  try {
    if (input.purgeData && input.purgeConfirmation !== DATA_PURGE_CONFIRMATION) {
      throw new Error(`清除数据需要确认串 ${DATA_PURGE_CONFIRMATION}`);
    }
    const managed = fs.existsSync(layout.installRoot)
      ? assertManagedInstallation(layout)
      : assertManagedManifest(layout, ['installed', 'uninstalled']);
    const preserveStopArtifacts = !input.purgeData && fs.existsSync(layout.installRoot)
      ? await issuedStopArtifactsArePreservable(layout, managed)
      : false;
    if (!preserveStopArtifacts) {
      clearStopLifecycleArtifacts(layout, { removeKey: input.purgeData });
    }
    if (fs.existsSync(layout.installRoot)) {
      removeOwnedRelease(layout.installRoot, managed.manifest.installId, '安装目录');
    }
    const rollbackRoot = path.join(
      path.dirname(layout.installRoot),
      `.${path.basename(layout.installRoot)}.rollback`,
    );
    removeOwnedRelease(rollbackRoot, managed.manifest.installId, '回滚目录');
    if (input.purgeData) removeManaged(path.join(layout.stateDir, 'data'));
    const manifestPath = path.join(layout.stateDir, INSTALL_MANIFEST);
    const previous = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : {};
    writePrivateJson(manifestPath, {
      ...previous,
      status: 'uninstalled',
      uninstalledAt: new Date().toISOString(),
      dataPreserved: !input.purgeData,
    });
    return {
      status: 'uninstalled',
      installRoot: layout.installRoot,
      stateDir: layout.stateDir,
      dataPreserved: !input.purgeData,
    };
  } finally {
    releaseLock();
  }
}

function check(id, status, summary, details = {}) {
  return { id, status, summary, ...details };
}

function hasTable(database, name) {
  return Boolean(database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

function scalar(database, sql) {
  return Number(Object.values(database.prepare(sql).get() || {})[0] || 0);
}

async function inspectOllama(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return check('ollama.service', 'fail', `HTTP ${response.status}`);
    const body = await response.json();
    const names = new Set((body.models || []).map((item) => String(item.name)));
    const missing = ['qwen2.5:14b', 'bge-m3:latest'].filter((name) => !names.has(name));
    return missing.length === 0
      ? check('ollama.models', 'pass', 'Ollama 与固定模型可用', {
          models: ['qwen2.5:14b', 'bge-m3:latest'],
        })
      : check('ollama.models', 'fail', '缺少固定模型', { missing });
  } catch (error) {
    return check('ollama.service', 'fail', 'Ollama 不可达', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function inspectService(host, port) {
  const endpoint = `http://${host}:${port}/api/health`;
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return check('service.identity', 'fail', '端口服务不是可识别的 Memory Bridge', {
        host,
        port,
        httpStatus: response.status,
      });
    }
    const body = await response.json();
    const identified = body?.ok === true &&
      body?.service === EXPECTED_PACKAGE &&
      body?.mcpTransport === 'stdio';
    return check(
      'service.identity',
      identified ? 'pass' : 'fail',
      identified ? 'Memory Bridge 服务身份验证通过' : '端口服务身份不匹配',
      { host, port, service: String(body?.service || 'unknown') },
    );
  } catch (error) {
    const causeCode = error?.cause?.code || error?.code;
    if (causeCode === 'ECONNREFUSED') {
      return check('service.identity', 'info', '服务未启动，未执行运行态身份校验', {
        host,
        port,
      });
    }
    return check('service.identity', 'warn', '服务身份探测失败', {
      host,
      port,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function inspectMcp(installRoot, stateDir, runner) {
  const serverPath = path.join(installRoot, 'dist', 'server', 'mcp-stdio.js');
  const smokePath = path.join(installRoot, 'scripts', 'mcp-doctor-smoke.mjs');
  if (!fs.existsSync(smokePath)) {
    return check('mcp.stdio', 'fail', 'MCP doctor smoke 脚本缺失');
  }
  try {
    const result = await (runner || defaultCommandRunner)(
      process.execPath,
      [smokePath, '--server', serverPath],
      {
        cwd: installRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: 30_000,
        env: { ...process.env, MEMORY_BRIDGE_DOCTOR_STATE_DIR: stateDir },
      },
    );
    const lines = String(result?.stdout || '')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) throw new Error('MCP smoke 未返回结果');
    let response;
    try {
      response = JSON.parse(lines.at(-1));
    } catch {
      throw new Error('MCP smoke 返回了无效 JSON');
    }
    if (
      response?.passed !== true ||
      response?.isolated !== true ||
      response?.cleanupComplete !== true ||
      !Array.isArray(response?.tools) ||
      !Array.isArray(response?.calledTools)
    ) {
      throw new Error('MCP smoke 结果格式无效');
    }
    const names = response.tools.map((name) => String(name));
    const called = response.calledTools.map((name) => String(name));
    const missing = REQUIRED_MCP_TOOLS.filter(
      (name) => !names.includes(name) || !called.includes(name),
    );
    return missing.length === 0
      ? check('mcp.stdio', 'pass', 'MCP stdio 七工具隔离调用通过', {
          tools: names,
          calledTools: called,
          smokeRunId: String(response.runId || ''),
          isolated: true,
          cleanupComplete: true,
        })
      : check('mcp.stdio', 'fail', 'MCP 工具缺失或未被真实调用', {
          missing,
          tools: names,
          calledTools: called,
        });
  } catch (error) {
    return check('mcp.stdio', 'fail', 'MCP stdio smoke 失败', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function diagnoseInstallation(input) {
  if (
    input.strict === true &&
    (input.checkOllama === false || input.checkPort === false || input.mcpSmoke === false)
  ) {
    throw new Error('strict Doctor 禁止跳过 Ollama、服务身份或 MCP smoke 检查');
  }
  const source = input.source || process.cwd();
  const layout = assertManagedLayout({ ...input, source });
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check(
    'runtime.node',
    nodeMajor >= 24 ? 'pass' : 'fail',
    `Node ${process.version}`,
  ));
  let managed = null;
  try {
    managed = assertManagedInstallation(layout);
    checks.push(check(
      'install.ownership',
      'pass',
      '安装 manifest 与受管目录所有权匹配',
      { installId: managed.manifest.installId },
    ));
  } catch (error) {
    checks.push(check('install.ownership', 'fail', '安装所有权验证失败', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  const missingArtifacts = REQUIRED_ARTIFACTS.filter(
    (relativePath) => !fs.existsSync(path.join(layout.installRoot, relativePath)),
  );
  checks.push(check(
    'install.artifacts',
    missingArtifacts.length === 0 ? 'pass' : 'fail',
    missingArtifacts.length === 0 ? '构建产物完整' : '构建产物缺失',
    missingArtifacts.length > 0 ? { missing: missingArtifacts } : {},
  ));
  if (managed && missingArtifacts.length === 0) {
    const installedSourceFingerprint = sourceFingerprint(layout.installRoot);
    const installedArtifacts = artifactFingerprints(layout.installRoot);
    const fingerprintsMatch =
      managed.manifest.sourceFingerprint === installedSourceFingerprint &&
      JSON.stringify(managed.manifest.artifacts || {}) ===
        JSON.stringify(installedArtifacts);
    checks.push(check(
      'install.fingerprints',
      fingerprintsMatch ? 'pass' : 'fail',
      fingerprintsMatch ? '安装源码与产物指纹匹配' : '安装指纹不匹配',
      fingerprintsMatch ? {} : {
        sourceFingerprintMatch:
          managed.manifest.sourceFingerprint === installedSourceFingerprint,
        artifactFingerprintsMatch:
          JSON.stringify(managed.manifest.artifacts || {}) ===
            JSON.stringify(installedArtifacts),
      },
    ));
    const mode = (filePath) => fs.statSync(filePath).mode & 0o777;
    const permissions = {
      stateDir: mode(layout.stateDir),
      dataDir: mode(path.join(layout.stateDir, 'data')),
      manifest: mode(managed.manifestPath),
      marker: mode(managed.markerPath),
    };
    const privatePermissions =
      permissions.stateDir === 0o700 &&
      permissions.dataDir === 0o700 &&
      permissions.manifest === 0o600 &&
      permissions.marker === 0o600;
    checks.push(check(
      'install.permissions',
      privatePermissions ? 'pass' : 'fail',
      privatePermissions ? '状态、数据与 manifest 权限为私有' : '安装权限过宽',
      permissions,
    ));
  }

  const dataDir = path.join(layout.stateDir, 'data');
  const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
  if (!fs.existsSync(databasePath)) {
    checks.push(check('database.state', 'info', '尚未创建数据库（首次启动前正常）'));
  } else {
    try {
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const integrity = String(Object.values(
          database.prepare('PRAGMA integrity_check').get() || {},
        )[0] || '');
        const foreignKeys = database.prepare('PRAGMA foreign_key_check').all().length;
        const schemaVersion = scalar(database, 'PRAGMA user_version');
        const health = {
          schemaVersion,
          integrity,
          foreignKeys,
          openOutbox: hasTable(database, 'outbox_events')
            ? scalar(database, `SELECT COUNT(*) FROM outbox_events WHERE status != 'completed'`)
            : 0,
          retryingJobs: hasTable(database, 'memory_jobs')
            ? scalar(database, `SELECT COUNT(*) FROM memory_jobs WHERE status = 'failed'`)
            : 0,
          runningJobs: hasTable(database, 'memory_jobs')
            ? scalar(database, `SELECT COUNT(*) FROM memory_jobs WHERE status = 'running'`)
            : 0,
          deadJobs: hasTable(database, 'memory_jobs')
            ? scalar(database, `SELECT COUNT(*) FROM memory_jobs WHERE status = 'dead'`)
            : 0,
        };
        const passed = integrity === 'ok' && foreignKeys === 0 && schemaVersion === EXPECTED_SCHEMA;
        checks.push(check(
          'database.integrity',
          passed ? 'pass' : 'fail',
          passed ? 'SQLite 与 schema 正常' : 'SQLite/schema 异常',
          health,
        ));
        const jobStatus = health.deadJobs > 0
          ? 'fail'
          : health.openOutbox > 0 || health.retryingJobs > 0 || health.runningJobs > 0
            ? 'warn'
            : 'pass';
        checks.push(check(
          'jobs.health',
          jobStatus,
          jobStatus === 'pass'
            ? '后台任务和 outbox 已收敛'
            : jobStatus === 'warn'
              ? '存在尚未收敛的后台任务'
              : '存在 dead job，需要修复或补偿',
          {
            openOutbox: health.openOutbox,
            retryingJobs: health.retryingJobs,
            runningJobs: health.runningJobs,
            deadJobs: health.deadJobs,
            unhealthyJobs:
              health.retryingJobs + health.runningJobs + health.deadJobs,
          },
        ));
      } finally {
        database.close();
      }
    } catch (error) {
      checks.push(check('database.integrity', 'fail', '数据库无法只读检查', {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  if (input.checkOllama !== false) {
    checks.push(await inspectOllama(input.ollamaUrl || 'http://127.0.0.1:11434'));
  }
  if (input.checkPort !== false) {
    checks.push(await inspectService(input.host || '127.0.0.1', Number(input.port || 3789)));
  }
  if (input.mcpSmoke !== false) {
    checks.push(await inspectMcp(
      layout.installRoot,
      layout.stateDir,
      input.mcpSmokeRunner,
    ));
  }
  const releaseBlockingChecks = RELEASE_REQUIRED_CHECKS.filter((id) =>
    checks.find((item) => item.id === id)?.status !== 'pass');
  if (input.strict === true && releaseBlockingChecks.length > 0) {
    checks.push(check(
      'release.gate',
      'fail',
      '严格发布门槛未通过',
      { blockingChecks: releaseBlockingChecks },
    ));
  }
  const counts = Object.fromEntries(
    ['pass', 'fail', 'warn', 'info'].map((status) => [
      status,
      checks.filter((item) => item.status === status).length,
    ]),
  );
  const releaseReady =
    counts.fail === 0 &&
    counts.warn === 0 &&
    releaseBlockingChecks.length === 0;
  return {
    format: 'memory-bridge-doctor:v1',
    completedAt: new Date().toISOString(),
    strict: input.strict === true,
    passed: input.strict === true ? releaseReady : counts.fail === 0,
    releaseReady,
    installRoot: layout.installRoot,
    stateDir: layout.stateDir,
    checks,
    counts,
  };
}

export function writeDoctorReceipt(receiptDir, report) {
  ensurePrivateDirectory(receiptDir);
  const timestamp = report.completedAt.replace(/[^0-9]/gu, '').slice(0, 17);
  const receiptPath = path.join(receiptDir, `doctor.${timestamp}-${randomUUID().slice(0, 8)}.json`);
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(receiptPath, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(receiptPath, 0o600);
  return {
    path: receiptPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
