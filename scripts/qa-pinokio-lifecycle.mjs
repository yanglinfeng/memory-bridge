#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  BUNDLE_MARKER,
  assertOwnedPinokioBundle,
  bundleFingerprint,
} from './build-pinokio-bundle-lib.mjs';
import { snapshotLifecycleBusinessState } from './lifecycle-business-hash-lib.mjs';
import { createPrivateQaRunRoot, createQaRunId } from './qa-receipt-lib.mjs';

const CHAT_MODEL = 'qwen2.5:14b';
const EMBEDDING_MODEL = 'bge-m3:latest';
const REQUIRED_TOOLS = Object.freeze([
  'memory_forget',
  'memory_get_context',
  'memory_list',
  'memory_recall',
  'memory_remember',
  'memory_stats',
  'memory_update',
]);

export const FORBIDDEN_PORTS = new Set([3789, 42003]);
export const LIFECYCLE_PHASES = Object.freeze([
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function boundedText(current, chunk) {
  return `${current}${String(chunk)}`.slice(-1_048_576);
}

function killProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export async function runWithWatchdog(command, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('watchdog timeout 必须是正整数');
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = boundedText(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = boundedText(stderr, chunk); });
  let timedOut = false;
  let timeout;
  let forceKill;
  try {
    const result = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, 'SIGTERM');
        forceKill = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 2_000);
      }, timeoutMs);
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (timedOut) throw new Error(`watchdog timeout: ${path.basename(command)}`);
    if (result.code !== 0 && options.rejectOnNonzero !== false) {
      throw new Error(
        `subprocess failed: ${path.basename(command)} code=${String(result.code)}`,
      );
    }
    return { ...result, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceKill);
    await options.cleanup?.();
  }
}

export function assertSafeLoopbackPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('loopback port invalid');
  }
  if (FORBIDDEN_PORTS.has(port)) throw new Error(`forbidden loopback port: ${port}`);
  return port;
}

async function availableLoopbackPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const selected = typeof address === 'object' && address ? address.port : 0;
        server.close((error) => error ? reject(error) : resolve(selected));
      });
    });
    try {
      return assertSafeLoopbackPort(port);
    } catch {
      // Ask the OS for another ephemeral port if it selected a protected fixture port.
    }
  }
  throw new Error('unable to allocate safe loopback port');
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

export function createLifecycleRunLayout(parentDirectory) {
  const runId = createQaRunId();
  const runRoot = createPrivateQaRunRoot(
    path.resolve(parentDirectory),
    `lifecycle-${runId}-`,
  );
  const launcherRoot = path.join(runRoot, 'launcher');
  const receiptsDir = path.join(runRoot, 'receipts');
  const workDir = path.join(runRoot, 'work');
  for (const directory of [launcherRoot, receiptsDir, workDir]) {
    ensurePrivateDirectory(directory);
  }
  return { runId, runRoot, launcherRoot, receiptsDir, workDir };
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(filePath, 0o600);
}

function assertSafeSummaryTree(value, key = '') {
  if (/token|secret|nonce|hmac|chat|content|message|credential|authkey/iu.test(key)) {
    throw new Error(`unsafe summary field: ${key}`);
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeSummaryTree(item, key);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      assertSafeSummaryTree(child, childKey);
    }
  }
}

export function publicLifecycleSummary(input) {
  const allowed = ['status', 'phaseStatuses', 'counts', 'hashes', 'p95Ms'];
  const extras = Object.keys(input || {}).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`unsafe summary field: ${extras.join(',')}`);
  const summary = {
    status: String(input.status || 'blocked'),
    phaseStatuses: { ...(input.phaseStatuses || {}) },
    counts: { ...(input.counts || {}) },
    hashes: { ...(input.hashes || {}) },
    p95Ms: { ...(input.p95Ms || {}) },
  };
  assertSafeSummaryTree(summary);
  return summary;
}

export function buildVNextBundle(sourceDirectory, destination, label) {
  const source = path.resolve(sourceDirectory);
  const target = path.resolve(destination);
  const before = assertOwnedPinokioBundle(source).fingerprint;
  if (fs.existsSync(target)) throw new Error('vNext destination already exists');
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
  });
  fs.unlinkSync(path.join(target, BUNDLE_MARKER));
  const safeLabel = String(label || '').replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 80);
  if (!safeLabel) throw new Error('vNext label invalid');
  const packagePath = path.join(target, 'package.json');
  const packageValue = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  packageValue.version = `${String(packageValue.version || '0.0.0').split('+')[0]}+qa.${safeLabel}`;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageValue, null, 2)}\n`);
  const lockPath = path.join(target, 'package-lock.json');
  const lockValue = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lockValue.version = packageValue.version;
  if (lockValue.packages?.['']) lockValue.packages[''].version = packageValue.version;
  fs.writeFileSync(lockPath, `${JSON.stringify(lockValue, null, 2)}\n`);
  const after = bundleFingerprint(target);
  if (after === before) throw new Error('vNext fingerprint did not change');
  fs.writeFileSync(
    path.join(target, BUNDLE_MARKER),
    `${JSON.stringify({
      format: 'memory-bridge-source-bundle:v1',
      package: 'mcp-memory-bridge',
      fingerprint: after,
    }, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 },
  );
  assertOwnedPinokioBundle(target);
  return { beforeFingerprint: before, afterFingerprint: after };
}

function parseTrailingJson(output) {
  const text = String(output || '').trim();
  for (let index = text.lastIndexOf('{'); index >= 0; index = text.lastIndexOf('{', index - 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Build output may precede the final lifecycle JSON object.
    }
  }
  throw new Error('subprocess returned no trailing JSON object');
}

function runtimeEnvironment(dataDir, port, bootstrapPrincipal, ollamaUrl) {
  return {
    ...process.env,
    MEMORY_BRIDGE_HOST: '127.0.0.1',
    MEMORY_BRIDGE_PORT: String(assertSafeLoopbackPort(port)),
    MEMORY_BRIDGE_DATA_DIR: dataDir,
    MEMORY_BRIDGE_USER_ID: bootstrapPrincipal,
    MEMORY_BRIDGE_NAMESPACE: 'lifecycle-qa',
    MEMORY_BRIDGE_SEMANTIC_MODE: 'required',
    MEMORY_BRIDGE_OLLAMA_URL: ollamaUrl,
    MEMORY_BRIDGE_AIRI_CHAT_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_EMBED_MODEL: EMBEDDING_MODEL,
    MEMORY_BRIDGE_QUERY_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_RERANK_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_EXTRACTION_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_RELATION_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_CONSOLIDATION_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_RETRIEVAL_JSONL: 'off',
  };
}

async function waitForHealth(runtime, maximumMs = 60_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    if (runtime.exited) throw new Error('runtime exited before health');
    try {
      const response = await fetch(`${runtime.origin}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      const body = response.ok ? await response.json() : null;
      if (
        body?.ok === true &&
        body?.service === 'memory-bridge' &&
        body?.mcpTransport === 'stdio'
      ) return;
    } catch {
      // Bounded retry while the real service initializes.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('runtime health watchdog timeout');
}

async function startRuntime({ installRoot, stateDir, port, bootstrapPrincipal, ollamaUrl }) {
  const child = spawn(process.execPath, [path.join(installRoot, 'dist', 'server', 'index.js')], {
    cwd: installRoot,
    env: runtimeEnvironment(
      path.join(stateDir, 'data'),
      port,
      bootstrapPrincipal,
      ollamaUrl,
    ),
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const runtime = {
    child,
    origin: `http://127.0.0.1:${assertSafeLoopbackPort(port)}`,
    exited: false,
    exitPromise: null,
    stdout: '',
    stderr: '',
    hardTimer: null,
  };
  child.stdout.on('data', (chunk) => { runtime.stdout = boundedText(runtime.stdout, chunk); });
  child.stderr.on('data', (chunk) => { runtime.stderr = boundedText(runtime.stderr, chunk); });
  runtime.exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      runtime.exited = true;
      resolve({ code, signal });
    });
  });
  runtime.hardTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 10 * 60_000);
  try {
    await waitForHealth(runtime);
    return runtime;
  } catch (error) {
    await emergencyStopRuntime(runtime);
    throw error;
  }
}

async function emergencyStopRuntime(runtime) {
  if (!runtime) return;
  clearTimeout(runtime.hardTimer);
  if (!runtime.exited) {
    killProcessGroup(runtime.child, 'SIGTERM');
    const outcome = await Promise.race([
      runtime.exitPromise,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);
    if (outcome === 'timeout') {
      killProcessGroup(runtime.child, 'SIGKILL');
      await runtime.exitPromise;
    }
  }
}

function safeFailure(error, safeCode) {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, 'safeCode', {
      value: safeCode,
      configurable: true,
      enumerable: false,
    });
    return error;
  }
  const wrapped = new Error(safeCode);
  Object.defineProperty(wrapped, 'safeCode', { value: safeCode, enumerable: false });
  return wrapped;
}

async function assertManagedRuntimeIdentity(runtime, installRoot) {
  if (!runtime || runtime.exited) {
    throw safeFailure(new Error('runtime unavailable'), 'runtime-exited');
  }
  const port = assertSafeLoopbackPort(new URL(runtime.origin).port);
  try {
    const response = await fetch(`${runtime.origin}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = response.ok ? await response.json() : null;
    if (
      body?.ok !== true ||
      body?.service !== 'memory-bridge' ||
      body?.mcpTransport !== 'stdio'
    ) throw new Error('health identity mismatch');
  } catch (error) {
    throw safeFailure(error, 'runtime-health-mismatch');
  }
  const command = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  const cwdResult = await runWithWatchdog(
    command,
    ['-a', '-p', String(runtime.child.pid), '-d', 'cwd', '-Fn'],
    { cwd: installRoot, timeoutMs: 5_000 },
  );
  const actualCwd = String(cwdResult.stdout)
    .split(/\r?\n/u)
    .find((line) => line.startsWith('n'))
    ?.slice(1);
  if (!actualCwd || fs.realpathSync(actualCwd) !== fs.realpathSync(installRoot)) {
    throw safeFailure(new Error('runtime cwd mismatch'), 'runtime-cwd-mismatch');
  }
  const listenerResult = await runWithWatchdog(
    command,
    ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t'],
    { cwd: installRoot, timeoutMs: 5_000 },
  );
  const listeners = [...new Set(String(listenerResult.stdout)
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (listeners.length !== 1 || listeners[0] !== runtime.child.pid) {
    throw safeFailure(new Error('runtime listener mismatch'), 'runtime-listener-mismatch');
  }
}

async function runLifecycle(layout, args, timeoutMs = 10 * 60_000, options = {}) {
  const cli = path.join(
    layout.launcherRoot,
    'bundle',
    'scripts',
    'memory-bridge-lifecycle.mjs',
  );
  const result = await runWithWatchdog(process.execPath, [cli, ...args], {
    cwd: layout.launcherRoot,
    timeoutMs,
    rejectOnNonzero: options.rejectOnNonzero,
  });
  return options.parseJson === false ? result : { ...result, json: parseTrailingJson(result.stdout) };
}

function lifecycleBase(layout) {
  return [
    '--source', path.join(layout.launcherRoot, 'bundle'),
    '--install-root', path.join(layout.launcherRoot, 'app'),
    '--state-dir', path.join(layout.launcherRoot, 'state'),
  ];
}

async function runDoctor(layout, port, label) {
  const result = await runLifecycle(layout, [
    'doctor',
    ...lifecycleBase(layout),
    '--strict',
    '--host', '127.0.0.1',
    '--port', String(assertSafeLoopbackPort(port)),
    '--receipt-dir', layout.receiptsDir,
  ], 180_000);
  assert.equal(result.json.passed, true, `${label} doctor failed`);
  return result.json;
}

async function stopManagedRuntime(layout, runtime, label) {
  const receiptPath = path.join(
    layout.launcherRoot,
    'state',
    'receipts',
    `${label}-${randomUUID()}.json`,
  );
  const identity = [
    ...lifecycleBase(layout),
    '--pid', String(runtime.child.pid),
    '--cwd', path.join(layout.launcherRoot, 'app'),
    '--ready-url', `${runtime.origin}/`,
  ];
  await assertManagedRuntimeIdentity(runtime, path.join(layout.launcherRoot, 'app'));
  try {
    await runLifecycle(layout, ['stop', '--phase', 'preflight', ...identity], 30_000);
  } catch (error) {
    throw safeFailure(error, 'stop-preflight-rejected');
  }
  killProcessGroup(runtime.child, 'SIGTERM');
  const outcome = await Promise.race([
    runtime.exitPromise,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
  ]);
  if (outcome === 'timeout') {
    killProcessGroup(runtime.child, 'SIGKILL');
    await runtime.exitPromise;
  }
  clearTimeout(runtime.hardTimer);
  try {
    await runLifecycle(layout, [
      'stop', '--phase', 'postflight', ...identity,
      '--verify-stopped', '--receipt-file', receiptPath,
    ], 30_000);
  } catch (error) {
    throw safeFailure(error, 'stop-postflight-rejected');
  }
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  return receiptPath;
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} watchdog timeout`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function mcpEnvironment(dataDir, token, namespace, ollamaUrl) {
  return {
    PATH: process.env.PATH || '',
    MEMORY_BRIDGE_DATA_DIR: dataDir,
    MEMORY_BRIDGE_MCP_TOKEN: token,
    MEMORY_BRIDGE_NAMESPACE: namespace,
    MEMORY_BRIDGE_SEMANTIC_MODE: 'required',
    MEMORY_BRIDGE_OLLAMA_URL: ollamaUrl,
    MEMORY_BRIDGE_AIRI_CHAT_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_EMBED_MODEL: EMBEDDING_MODEL,
    MEMORY_BRIDGE_QUERY_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_RERANK_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_EXTRACTION_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_RELATION_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_CONSOLIDATION_MODEL: CHAT_MODEL,
    MEMORY_BRIDGE_RETRIEVAL_JSONL: 'off',
  };
}

async function openMcpSession({ installRoot, dataDir, credential, namespace, ollamaUrl }) {
  const client = new Client({ name: 'memory-bridge-lifecycle-qa', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(installRoot, 'dist', 'server', 'mcp-stdio.js')],
    cwd: installRoot,
    env: mcpEnvironment(dataDir, credential.token, namespace, ollamaUrl),
    stderr: 'pipe',
  });
  const session = { client, transport, namespace, credential, closed: false };
  try {
    await withTimeout(client.connect(transport), 60_000, 'MCP connect');
    const listed = await withTimeout(client.listTools(), 30_000, 'MCP listTools');
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [...REQUIRED_TOOLS],
    );
    return session;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function closeMcpSession(session) {
  if (!session || session.closed) return;
  session.closed = true;
  await session.client.close().catch(() => undefined);
}

async function callMcp(session, tool, args, latencies) {
  const started = performance.now();
  const response = await withTimeout(
    session.client.callTool({ name: tool, arguments: args }),
    180_000,
    `MCP ${tool}`,
  );
  latencies.push(performance.now() - started);
  const text = response.content.find((item) => item.type === 'text');
  if (!text || response.isError === true) throw new Error(`MCP ${tool} failed`);
  return JSON.parse(text.text);
}

async function provisionIdentities(installRoot, databasePath, bootstrapPrincipal, runId) {
  const [{ openDatabase }, { IdentityService }] = await Promise.all([
    import(`${pathToFileURL(path.join(installRoot, 'dist', 'server', 'database.js')).href}?qa=${runId}`),
    import(`${pathToFileURL(path.join(installRoot, 'dist', 'server', 'identity.js')).href}?qa=${runId}`),
  ]);
  const database = openDatabase(databasePath);
  try {
    const identity = new IdentityService(database, { defaultPrincipalId: bootstrapPrincipal });
    const first = identity.initializeFirstAccount({
      principalId: bootstrapPrincipal,
      displayName: 'Lifecycle QA principal 0',
      label: 'lifecycle-qa-0',
    });
    const secondPrincipal = `lifecycle-qa-${runId}-p1`;
    identity.createPrincipal({ id: secondPrincipal, displayName: 'Lifecycle QA principal 1' });
    const second = identity.issueCredential({
      principalId: secondPrincipal,
      label: 'lifecycle-qa-1',
    });
    const credentials = [
      { principalId: first.principal.id, token: first.token },
      { principalId: secondPrincipal, token: second.token },
    ];
    for (const [principalIndex, credential] of credentials.entries()) {
      const trusted = identity.authenticate({ token: credential.token, isLoopback: true });
      for (let personaIndex = 0; personaIndex < 2; personaIndex += 1) {
        identity.bindPersona(trusted, {
          clientType: 'lifecycle-qa',
          clientInstanceId: `principal-${principalIndex}`,
          personaId: `persona-${principalIndex}-${personaIndex}`,
          displayName: `Persona ${principalIndex}-${personaIndex}`,
        });
      }
    }
    return credentials;
  } finally {
    database.close();
  }
}

function percentile95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] * 1000) / 1000;
}

function recalledId(result, id) {
  return Array.isArray(result) && result.some((item) => item?.memory?.id === id);
}

async function seedAndSmokeMcp({ installRoot, dataDir, credentials, runId, ollamaUrl, latencies }) {
  const sessionSpecs = credentials.flatMap((credential, principalIndex) =>
    [0, 1].map((personaIndex) => ({
      credential,
      namespace: `role/persona-${principalIndex}-${personaIndex}`,
    })));
  const sessions = [];
  const memories = [];
  const calledTools = new Set();
  try {
    for (const spec of sessionSpecs) {
      sessions.push(await openMcpSession({
        installRoot,
        dataDir,
        ollamaUrl,
        ...spec,
      }));
    }
    for (const [index, session] of sessions.entries()) {
      const marker = `LIFECYCLE-${runId}-${index}-${randomUUID()}`;
      const result = await callMcp(session, 'memory_remember', {
        content: `${marker} durable isolated lifecycle fact`,
        kind: 'knowledge',
        title: marker,
        namespace: session.namespace,
        source: 'lifecycle-qa',
        sourceRef: `lifecycle:${runId}:${index}`,
        idempotencyKey: `${runId}:${index}`,
      }, latencies);
      calledTools.add('memory_remember');
      memories.push({ id: result.memory.id, marker, namespace: session.namespace, sessionIndex: index });
    }
    return { sessions, memories, calledTools };
  } catch (error) {
    await Promise.allSettled(sessions.map(closeMcpSession));
    throw error;
  }
}

async function completeSevenToolSmoke(state, latencies, runId) {
  const { sessions, memories, calledTools } = state;
  const first = sessions[0];
  const firstMemory = memories[0];
  await callMcp(first, 'memory_update', {
    id: firstMemory.id,
    summary: 'isolated lifecycle update',
  }, latencies);
  calledTools.add('memory_update');
  const recall = await callMcp(first, 'memory_recall', {
    query: firstMemory.marker,
    namespace: firstMemory.namespace,
    limit: 5,
    minScore: 0,
  }, latencies);
  calledTools.add('memory_recall');
  assert.equal(recalledId(recall, firstMemory.id), true);
  const context = await callMcp(first, 'memory_get_context', {
    query: firstMemory.marker,
    namespace: firstMemory.namespace,
    limit: 5,
    minScore: 0,
  }, latencies);
  calledTools.add('memory_get_context');
  assert.equal(
    Array.isArray(context.memories) &&
      context.memories.some((item) => item?.memory?.id === firstMemory.id),
    true,
  );
  const listed = await callMcp(first, 'memory_list', {
    namespace: firstMemory.namespace,
    limit: 20,
  }, latencies);
  calledTools.add('memory_list');
  assert.equal(listed.items.some((item) => item.id === firstMemory.id), true);
  const stats = await callMcp(first, 'memory_stats', {}, latencies);
  calledTools.add('memory_stats');
  assert.equal(Number(stats.total) >= 1, true);
  const disposable = await callMcp(first, 'memory_remember', {
    content: `LIFECYCLE-${runId}-disposable-${randomUUID()}`,
    kind: 'knowledge',
    namespace: firstMemory.namespace,
    source: 'lifecycle-qa',
    idempotencyKey: `${runId}:disposable`,
  }, latencies);
  await callMcp(first, 'memory_forget', {
    id: disposable.memory.id,
    reason: 'lifecycle QA disposable cleanup',
  }, latencies);
  calledTools.add('memory_forget');
  const attacker = sessions[2];
  const crossPrincipal = await callMcp(attacker, 'memory_recall', {
    query: firstMemory.marker,
    namespace: firstMemory.namespace,
    limit: 10,
    minScore: 0,
  }, latencies);
  assert.equal(recalledId(crossPrincipal, firstMemory.id), false);
  assert.deepEqual([...calledTools].sort(), [...REQUIRED_TOOLS]);
  return { crossPrincipalLeakage: 0, toolCount: calledTools.size };
}

async function verifyMcpAfterRestore({ installRoot, dataDir, credentials, memories, ollamaUrl, latencies }) {
  const sessions = [];
  try {
    for (const [principalIndex, credential] of credentials.entries()) {
      for (let personaIndex = 0; personaIndex < 2; personaIndex += 1) {
        sessions.push(await openMcpSession({
          installRoot,
          dataDir,
          credential,
          namespace: `role/persona-${principalIndex}-${personaIndex}`,
          ollamaUrl,
        }));
      }
    }
    let recallHits = 0;
    let listHits = 0;
    let statsPasses = 0;
    for (const memory of memories) {
      const session = sessions[memory.sessionIndex];
      const recall = await callMcp(session, 'memory_recall', {
        query: memory.marker,
        namespace: memory.namespace,
        limit: 5,
        minScore: 0,
      }, latencies);
      if (recalledId(recall, memory.id)) recallHits += 1;
      const listed = await callMcp(session, 'memory_list', {
        namespace: memory.namespace,
        limit: 20,
      }, latencies);
      if (listed.items.some((item) => item.id === memory.id)) listHits += 1;
      const stats = await callMcp(session, 'memory_stats', {}, latencies);
      if (Number(stats.total) >= 1) statsPasses += 1;
    }
    assert.equal(recallHits, memories.length);
    assert.equal(listHits, memories.length);
    assert.equal(statsPasses, memories.length);
    return { recallHits, listHits, statsPasses };
  } finally {
    await Promise.allSettled(sessions.map(closeMcpSession));
  }
}

function tableExists(database, name) {
  return Boolean(database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name));
}

function scalar(database, sql) {
  return Number(Object.values(database.prepare(sql).get() || {})[0] || 0);
}

function finalDatabaseGates(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = String(Object.values(
      database.prepare('PRAGMA integrity_check').get() || {},
    )[0] || '');
    const gates = {
      integrityOk: integrity === 'ok' ? 1 : 0,
      foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all().length,
      openOutbox: tableExists(database, 'outbox_events')
        ? scalar(database, "SELECT COUNT(*) FROM outbox_events WHERE status != 'completed'")
        : 0,
      deadJobs: tableExists(database, 'memory_jobs')
        ? scalar(database, "SELECT COUNT(*) FROM memory_jobs WHERE status = 'dead'")
        : 0,
      deadLetterJobs: tableExists(database, 'dead_letter_jobs')
        ? scalar(database, 'SELECT COUNT(*) FROM dead_letter_jobs')
        : 0,
      quarantined: tableExists(database, 'derived_consolidations')
        ? scalar(database, "SELECT COUNT(*) FROM derived_consolidations WHERE status = 'quarantined'")
        : 0,
    };
    assert.equal(gates.integrityOk, 1);
    assert.equal(gates.foreignKeyViolations, 0);
    assert.equal(gates.openOutbox, 0);
    assert.equal(gates.deadJobs, 0);
    assert.equal(gates.deadLetterJobs, 0);
    assert.equal(gates.quarantined, 0);
    return gates;
  } finally {
    database.close();
  }
}

export function queueActivitySnapshot(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      openOutbox: tableExists(database, 'outbox_events')
        ? scalar(database, "SELECT COUNT(*) FROM outbox_events WHERE status != 'completed'")
        : 0,
      activeJobs: tableExists(database, 'memory_jobs')
        ? scalar(
            database,
            `SELECT COUNT(*) FROM memory_jobs
             WHERE status IN ('running', 'failed')
                OR (
                  status = 'pending'
                  AND julianday(available_at) <= julianday('now')
                )`,
          )
        : 0,
    };
  } finally {
    database.close();
  }
}

async function waitForQueueIdle(databasePath, maximumMs = 300_000) {
  const deadline = Date.now() + maximumMs;
  while (Date.now() < deadline) {
    const { openOutbox, activeJobs } = queueActivitySnapshot(databasePath);
    if (openOutbox === 0 && activeJobs === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('queue idle watchdog timeout');
}

async function databaseHolderCount(databasePath) {
  if (!fs.existsSync(databasePath)) return 0;
  const command = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
  const result = await runWithWatchdog(command, ['-t', databasePath], {
    cwd: path.dirname(databasePath),
    timeoutMs: 5_000,
    rejectOnNonzero: false,
  });
  if (result.code !== 0 && result.code !== 1) throw new Error('database holder check failed');
  return new Set(String(result.stdout).split(/\s+/u).filter(Boolean)).size;
}

export function transactionResidueCount(root) {
  let count = 0;
  const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const restoreTransactionPattern = new RegExp(
    `^\\.memory-bridge\\.(?:restore-stage|pre-restore-rollback)-${uuidPattern}\\.sqlite3(?:-(?:wal|shm))?$`,
    'u',
  );
  const backupSidecarPattern = new RegExp(
    `^(?:backup|pre-restore|pre-upgrade)-\\d{17}-${uuidPattern}\\.sqlite3-(?:wal|shm)$`,
    'u',
  );
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        restoreTransactionPattern.test(entry.name) ||
        backupSidecarPattern.test(entry.name)
      ) {
        count += 1;
      }
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  return count;
}

function privateReceiptFailures(runRoot) {
  const failures = [];
  const visit = (directory, insideReceipts = false) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const receiptTree = insideReceipts || entry.name === 'receipts';
      if (entry.isDirectory()) visit(absolute, receiptTree);
      else if (entry.isFile() && receiptTree && (fs.statSync(absolute).mode & 0o777) !== 0o600) {
        failures.push(absolute);
      }
    }
  };
  visit(runRoot);
  return failures;
}

export async function runLifecycleQa(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const parentRoot = path.resolve(
    options.parentRoot ||
      path.join(projectRoot, '.memory-bridge-private', 'system-simulation'),
  );
  const layout = createLifecycleRunLayout(parentRoot);
  const packagingRoot = path.join(projectRoot, 'packaging', 'pinokio', 'memory-bridge');
  fs.cpSync(packagingRoot, layout.launcherRoot, {
    recursive: true,
    dereference: false,
    force: false,
  });
  const installRoot = path.join(layout.launcherRoot, 'app');
  const stateDir = path.join(layout.launcherRoot, 'state');
  const dataDir = path.join(stateDir, 'data');
  const databasePath = path.join(dataDir, 'memory-bridge.sqlite3');
  const ollamaUrl = process.env.MEMORY_BRIDGE_OLLAMA_URL || 'http://127.0.0.1:11434';
  const bootstrapPrincipal = `lifecycle-qa-${layout.runId}-p0`;
  const port = await availableLoopbackPort();
  const phaseStatuses = Object.fromEntries(LIFECYCLE_PHASES.map((phase) => [phase, 'pending']));
  const counts = {};
  const hashes = {};
  const p95Ms = {};
  const latencies = [];
  let runtime = null;
  let mcpState = null;
  let credentials = [];
  let backupPath = null;
  let restoreReceipt = null;
  let summaryWritten = false;
  let activePhase = null;
  let finalStatus = 'blocked';
  const execute = async (phase, operation) => {
    activePhase = phase;
    const result = await operation();
    phaseStatuses[phase] = 'pass';
    activePhase = null;
    return result;
  };
  const summaryPath = path.join(layout.receiptsDir, 'lifecycle-summary.json');
  const persistSummary = () => {
    if (summaryWritten) return;
    const summary = publicLifecycleSummary({
      status: finalStatus,
      phaseStatuses,
      counts,
      hashes,
      p95Ms,
    });
    writePrivateJson(summaryPath, summary);
    summaryWritten = true;
  };
  try {
    const canonical = assertOwnedPinokioBundle(path.join(layout.launcherRoot, 'bundle'));
    hashes.bundleV1 = canonical.fingerprint;
    await execute('install', async () => {
      await runLifecycle(layout, ['install', ...lifecycleBase(layout)]);
    });
    const initialManifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'install.json'), 'utf8'));
    hashes.installLineageBefore = sha256(String(initialManifest.installId));
    await execute('start-v1', async () => {
      runtime = await startRuntime({
        installRoot, stateDir, port, bootstrapPrincipal, ollamaUrl,
      });
      await waitForQueueIdle(databasePath);
    });
    await execute('doctor-v1', () => runDoctor(layout, port, 'v1'));
    await execute('mcp-data', async () => {
      credentials = await provisionIdentities(
        installRoot,
        databasePath,
        bootstrapPrincipal,
        layout.runId,
      );
      mcpState = await seedAndSmokeMcp({
        installRoot,
        dataDir,
        credentials,
        runId: layout.runId,
        ollamaUrl,
        latencies,
      });
      counts.principals = credentials.length;
      counts.personas = mcpState.sessions.length;
      counts.businessMemories = mcpState.memories.length;
    });
    await execute('seven-tool-smoke', async () => {
      const smoke = await completeSevenToolSmoke(mcpState, latencies, layout.runId);
      counts.toolsInvoked = smoke.toolCount;
      counts.crossPrincipalLeakage = smoke.crossPrincipalLeakage;
      await Promise.allSettled(mcpState.sessions.map(closeMcpSession));
      mcpState.sessions = [];
      await waitForQueueIdle(databasePath);
    });
    const beforeHash = await execute('business-hash-before', async () =>
      snapshotLifecycleBusinessState(databasePath));
    hashes.businessBefore = beforeHash.hashes.overall;
    counts.businessRowsBefore = Object.values(beforeHash.counts)
      .reduce((sum, value) => sum + Number(value), 0);
    const backup = await execute('backup', async () =>
      (await runLifecycle(layout, ['backup', ...lifecycleBase(layout)])).json);
    backupPath = backup.backupPath;
    hashes.backup = String(backup.sha256);
    await execute('stop-v1', async () => {
      await stopManagedRuntime(layout, runtime, 'stop-v1');
      runtime = null;
    });
    await execute('local-update-vnext', async () => {
      const vnext = buildVNextBundle(
        path.join(layout.launcherRoot, 'bundle'),
        path.join(layout.workDir, 'vnext-bundle'),
        layout.runId,
      );
      hashes.bundleVNext = vnext.afterFingerprint;
      await runWithWatchdog(process.execPath, [
        path.join(layout.launcherRoot, 'update-source.js'),
        '--local-source', path.join(layout.workDir, 'vnext-bundle'),
      ], {
        cwd: layout.launcherRoot,
        timeoutMs: 120_000,
      });
      assert.equal(
        assertOwnedPinokioBundle(path.join(layout.launcherRoot, 'bundle')).fingerprint,
        vnext.afterFingerprint,
      );
      await runLifecycle(layout, ['upgrade', ...lifecycleBase(layout)]);
    });
    await execute('start-vnext', async () => {
      runtime = await startRuntime({
        installRoot, stateDir, port, bootstrapPrincipal, ollamaUrl,
      });
      await waitForQueueIdle(databasePath);
    });
    await execute('doctor-vnext', () => runDoctor(layout, port, 'vnext'));
    await execute('stop-vnext', async () => {
      restoreReceipt = await stopManagedRuntime(layout, runtime, 'stop-vnext');
      runtime = null;
    });
    await execute('uninstall-preserve-data', async () => {
      const uninstalled = (await runLifecycle(
        layout,
        ['uninstall', ...lifecycleBase(layout)],
      )).json;
      assert.equal(uninstalled.dataPreserved, true);
      assert.equal(fs.existsSync(databasePath), true);
      assert.equal(fs.existsSync(restoreReceipt), true);
    });
    await execute('reinstall-lineage', async () => {
      await runLifecycle(layout, ['install', ...lifecycleBase(layout)]);
      const reinstalled = JSON.parse(fs.readFileSync(path.join(stateDir, 'install.json'), 'utf8'));
      hashes.installLineageAfter = sha256(String(reinstalled.installId));
      assert.equal(hashes.installLineageAfter, hashes.installLineageBefore);
      assert.equal(fs.existsSync(restoreReceipt), true);
    });
    await execute('restore-one-shot', async () => {
      await runLifecycle(layout, [
        'restore',
        ...lifecycleBase(layout),
        '--backup', backupPath,
        '--stop-receipt', restoreReceipt,
      ]);
      assert.equal(fs.existsSync(restoreReceipt), false);
      const replay = await runLifecycle(layout, [
        'restore',
        ...lifecycleBase(layout),
        '--backup', backupPath,
        '--stop-receipt', restoreReceipt,
      ], 60_000, { rejectOnNonzero: false, parseJson: false });
      assert.notEqual(replay.code, 0);
      counts.restoreReplayRejected = 1;
    });
    await execute('start-restored', async () => {
      runtime = await startRuntime({
        installRoot, stateDir, port, bootstrapPrincipal, ollamaUrl,
      });
      await waitForQueueIdle(databasePath);
    });
    await execute('doctor-restored', () => runDoctor(layout, port, 'restored'));
    await execute('verify-restored', async () => {
      const verified = await verifyMcpAfterRestore({
        installRoot,
        dataDir,
        credentials,
        memories: mcpState.memories,
        ollamaUrl,
        latencies,
      });
      counts.recallHits = verified.recallHits;
      counts.listHits = verified.listHits;
      counts.statsPasses = verified.statsPasses;
      await waitForQueueIdle(databasePath);
      const afterHash = snapshotLifecycleBusinessState(databasePath);
      hashes.businessAfter = afterHash.hashes.overall;
      assert.equal(hashes.businessAfter, hashes.businessBefore);
      counts.businessRowsAfter = Object.values(afterHash.counts)
        .reduce((sum, value) => sum + Number(value), 0);
      Object.assign(counts, finalDatabaseGates(databasePath));
      counts.transactionResidue = transactionResidueCount(layout.launcherRoot);
      assert.equal(counts.transactionResidue, 0);
    });
    await execute('stop-restored', async () => {
      await stopManagedRuntime(layout, runtime, 'stop-restored');
      runtime = null;
      counts.liveFixtureProcesses = await databaseHolderCount(databasePath);
      assert.equal(counts.liveFixtureProcesses, 0);
    });
    counts.receiptPermissionFailures = privateReceiptFailures(layout.runRoot).length;
    counts.runRootModeOk = (fs.statSync(layout.runRoot).mode & 0o777) === 0o700 ? 1 : 0;
    assert.equal(counts.receiptPermissionFailures, 0);
    assert.equal(counts.runRootModeOk, 1);
    p95Ms.mcp = percentile95(latencies);
    finalStatus = 'done';
    persistSummary();
    console.log(`[lifecycle-qa] evidence: ${layout.runRoot}`);
    console.log(JSON.stringify(publicLifecycleSummary({
      status: finalStatus, phaseStatuses, counts, hashes, p95Ms,
    })));
    return { status: 'DONE', runRoot: layout.runRoot, summaryPath };
  } catch (error) {
    if (activePhase) {
      const safeCode = typeof error?.safeCode === 'string'
        ? error.safeCode
        : 'operation-failed';
      phaseStatuses[activePhase] = `blocked:${safeCode}`;
    }
    finalStatus = 'blocked';
    p95Ms.mcp = percentile95(latencies);
    persistSummary();
    console.error(`[lifecycle-qa] BLOCKED phase=${activePhase || 'unknown'}`);
    console.error(`[lifecycle-qa] evidence: ${layout.runRoot}`);
    return { status: 'BLOCKED', runRoot: layout.runRoot, summaryPath, error };
  } finally {
    await Promise.allSettled((mcpState?.sessions || []).map(closeMcpSession));
    await emergencyStopRuntime(runtime).catch(() => undefined);
    if (!summaryWritten) persistSummary();
  }
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const result = await runLifecycleQa();
  if (result.status !== 'DONE') process.exitCode = 2;
}
