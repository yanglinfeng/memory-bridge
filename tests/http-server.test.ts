import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import {
  ContextualQueryUnderstandingService,
  type ContextualQueryUnderstandingProvider,
  type QueryUnderstandingInput,
} from '../src/server/contextual-query-understanding.js';
import { config } from '../src/server/config.js';
import { openDatabase } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryAdminService } from '../src/server/memory-admin.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';
import { OllamaSemanticRanker } from '../src/server/semantic-ranker.js';

test('HTTP API 支持健康检查、写入、召回和删除', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-http-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycleStore,
    memoryStore,
    { mode: 'auto' },
  );
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
  );
  const adminService = new MemoryAdminService(
    database,
    memoryStore,
    lifecycleStore,
    resolver,
    governance,
  );
  const missingChatModel = adminService.systemHealth({
    ollamaAvailable: true,
    availableModels: ['bge-m3:latest'],
  });
  assert.equal(missingChatModel.quality, 'unavailable');
  assert.ok(missingChatModel.missingModels.includes('qwen2.5:14b'));
  assert.equal(missingChatModel.models.chat, 'qwen2.5:14b');
  assert.equal(missingChatModel.models.query, config.queryModel);
  assert.equal(
    missingChatModel.modelRuntime.foregroundQuietMs,
    config.foregroundQuietMs,
  );
  const server = createHttpServer(memoryStore, { adminService });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'memory-bridge',
      version: '1.0.0',
      mcpTransport: 'stdio',
    });

    const configResponse = await fetch(`${base}/api/config`);
    assert.equal(configResponse.status, 200);
    const configBody = await configResponse.json() as {
      queryModel: string;
      modelKeepAlive: string;
      foregroundQuietMs: number;
    };
    assert.equal(configBody.queryModel, config.queryModel);
    assert.equal(configBody.modelKeepAlive, config.modelKeepAlive);
    assert.equal(configBody.foregroundQuietMs, config.foregroundQuietMs);

    const createdResponse = await fetch(`${base}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'profile',
        content: '用户使用中文交流。',
        importance: 0.8,
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as {
      memory: { id: string };
    };

    const recalledResponse = await fetch(`${base}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '用户使用什么语言？' }),
    });
    const recalled = await recalledResponse.json() as {
      memories: unknown[];
    };
    assert.equal(recalled.memories.length, 1);

    const deleted = await fetch(
      `${base}/api/memories/${created.memory.id}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '测试清理' }),
      },
    );
    assert.equal(deleted.status, 200);

    const restoreResponse = await fetch(
      `${base}/api/memories/${created.memory.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(restoreResponse.status, 200);
    const restored = await restoreResponse.json() as {
      status: string;
      memory: { id: string; status: string };
    };
    assert.equal(restored.status, 'restored');
    assert.equal(restored.memory.id, created.memory.id);
    assert.equal(restored.memory.status, 'active');

    const illegalConfirmation = await fetch(
      `${base}/api/memories/${created.memory.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'coexist' }),
      },
    );
    assert.equal(illegalConfirmation.status, 400);
    assert.match(
      (
        await illegalConfirmation.json() as { error: string }
      ).error,
      /只允许 replace/,
    );

    const unknownRestoreField = await fetch(
      `${base}/api/memories/${created.memory.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      },
    );
    assert.equal(unknownRestoreField.status, 400);
    assert.match(
      (
        await unknownRestoreField.json() as { error: string }
      ).error,
      /未知恢复字段/,
    );

    const invalidToken = await fetch(
      `${base}/api/memories/${created.memory.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: 'replace',
          confirmationToken: 'A'.repeat(64),
        }),
      },
    );
    assert.equal(invalidToken.status, 400);
    assert.match(
      (
        await invalidToken.json() as { error: string }
      ).error,
      /64 位小写十六进制/,
    );

    const missingRestore = await fetch(
      `${base}/api/memories/00000000-0000-4000-8000-000000000000/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(missingRestore.status, 404);

    const staleSource = memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 VS Code。',
      stableKey: 'http-restore-old',
      predicateKey: '用户::主要编辑器',
      normalizedValueHash: 'editor-vscode',
      normalizedValue: 'VS Code',
      predicateCardinality: 'single',
    }).memory;
    memoryStore.forget(staleSource.id);
    const staleTarget = memoryStore.remember({
      kind: 'preference',
      content: '用户主要使用 Cursor。',
      stableKey: 'http-restore-current',
      predicateKey: '用户::主要编辑器',
      normalizedValueHash: 'editor-cursor',
      normalizedValue: 'Cursor',
      predicateCardinality: 'single',
    }).memory;
    const previewResponse = await fetch(
      `${base}/api/memories/${staleSource.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    const preview = await previewResponse.json() as {
      confirmationToken: string;
    };
    memoryStore.update(staleTarget.id, { importance: 0.9 });
    const staleConfirmation = await fetch(
      `${base}/api/memories/${staleSource.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmation: 'replace',
          confirmationToken: preview.confirmationToken,
        }),
      },
    );
    assert.equal(staleConfirmation.status, 409);

    const list = await fetch(`${base}/api/memories`);
    assert.equal(
      (await list.json() as { total: number }).total,
      2,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP recall 只接受服务端绑定的 namespace 与可信会话作用域', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-http-scope-boundary-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycleStore,
    memoryStore,
    { mode: 'auto' },
  );
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
  );
  const adminService = new MemoryAdminService(
    database,
    memoryStore,
    lifecycleStore,
    resolver,
    governance,
  );
  const sessions = [
    {
      suffix: 'a',
      personaId: 'ChXvr-B7s8qFvnyrlNYhP',
      projectId: 'project-A',
      sessionId: 'z6e2a07YMRX6pY-p4TUy-',
    },
    {
      suffix: 'b',
      personaId: 'DhXvr-B7s8qFvnyrlNYhQ',
      projectId: 'project-B',
      sessionId: 'a6e2a07YMRX6pY-p4TUy_',
    },
  ] as const;
  for (const session of sessions) {
    lifecycleStore.recordCompletedExchange({
      userId: 'default',
      namespace: 'personal',
      clientName: 'trusted-http-client',
      sessionExternalId: session.sessionId,
      personaId: session.personaId,
      projectId: session.projectId,
      identitySource: 'credential',
      identityStatus: 'complete',
      roundId: `round-${session.suffix}`,
      userTurnExternalId: `user-${session.suffix}`,
      userContent: `会话 ${session.suffix} 的可信上下文。`,
      assistantTurnExternalId: `assistant-${session.suffix}`,
      assistantContent: '收到。',
    });
  }
  const rememberBoundary = (
    label: string,
    scopeType: 'personal' | 'role' | 'project' | 'session',
    scopeKey: string,
    namespace = 'personal',
  ) => memoryStore.remember({
    userId: 'default',
    namespace,
    scopeType,
    scopeKey,
    kind: 'knowledge',
    content: `HTTP 作用域边界标记 ${label}`,
  }).memory;
  const personal = rememberBoundary('personal', 'personal', 'self');
  const roleA = rememberBoundary('role-a', 'role', sessions[0].personaId);
  const roleB = rememberBoundary('role-b', 'role', sessions[1].personaId);
  const projectA = rememberBoundary('project-a', 'project', 'project-A');
  const projectB = rememberBoundary('project-b', 'project', 'project-B');
  const sessionA = rememberBoundary('session-a', 'session', sessions[0].sessionId);
  const sessionB = rememberBoundary('session-b', 'session', sessions[1].sessionId);
  const otherNamespace = rememberBoundary(
    'other-namespace',
    'personal',
    'self',
    'other',
  );
  const server = createHttpServer(memoryStore, { adminService });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const recall = async (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => fetch(`${base}/api/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  try {
    const unbound = await recall({ query: 'HTTP 作用域边界标记' });
    assert.equal(unbound.status, 200);
    const unboundIds = (await unbound.json() as {
      memories: Array<{ memory: { id: string } }>;
    }).memories.map((item) => item.memory.id);
    assert.deepEqual(unboundIds, [personal.id]);
    assert.ok(!unboundIds.includes(otherNamespace.id));

    for (const override of [
      { namespace: 'other' },
      { scopes: [{ scopeType: 'role', scopeKey: sessions[1].personaId }] },
      { scopeType: 'role', scopeKey: sessions[1].personaId },
    ]) {
      const response = await recall({
        query: 'HTTP 作用域边界标记',
        ...override,
      });
      assert.equal(response.status, 400);
    }

    const unknown = await recall(
      { query: 'HTTP 作用域边界标记' },
      {
        'x-memory-session-id': 'unknown-session',
        'x-memory-client-name': 'trusted-http-client',
      },
    );
    assert.equal(unknown.status, 404);

    const bound = await recall(
      { query: 'HTTP 作用域边界标记' },
      {
        'x-memory-session-id': sessions[0].sessionId,
        'x-memory-client-name': 'trusted-http-client',
      },
    );
    assert.equal(bound.status, 200);
    const boundIds = new Set((await bound.json() as {
      memories: Array<{ memory: { id: string } }>;
    }).memories.map((item) => item.memory.id));
    for (const allowed of [personal, roleA, projectA, sessionA]) {
      assert.ok(boundIds.has(allowed.id));
    }
    for (const blocked of [roleB, projectB, sessionB, otherNamespace]) {
      assert.ok(!boundIds.has(blocked.id));
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP recall 接收有界不可信 recentTurns 且不能夹带身份字段', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-http-context-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const calls: QueryUnderstandingInput[] = [];
  const provider: ContextualQueryUnderstandingProvider = {
    model: 'qwen2.5:14b-test',
    promptVersion: 'context-http-test-v1',
    async understand(input) {
      calls.push(input);
      return {
        status: 'ambiguous',
        standaloneQuery: null,
        variants: [],
        resolvedReferences: [],
        constraints: {
          temporal: [], negative: [], modal: [], frequency: [],
          conditional: [], subject: [], object: [],
        },
        unresolvedReferences: ['她'],
        clarificationQuestion: '你说的是妹妹还是同事小林？',
        confidence: 0.3,
      };
    },
  };
  const server = createHttpServer(memoryStore, {
    queryUnderstandingService:
      new ContextualQueryUnderstandingService(provider, { mode: 'auto' }),
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '她喜欢什么？',
        recentTurns: [{
          role: 'user',
          content: '妹妹喜欢桂花乌龙。',
        }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      memories: unknown[];
      queryUnderstanding: {
        status: string;
        clarificationQuestion: string;
      };
    };
    assert.deepEqual(body.memories, []);
    assert.equal(body.queryUnderstanding.status, 'ambiguous');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].principalId, 'default');
    assert.equal(calls[0].recentTurns[0].source, 'request_untrusted');

    const forged = await fetch(`${base}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '她喜欢什么？',
        recentTurns: [{
          role: 'user',
          content: '妹妹喜欢桂花乌龙。',
          userId: 'bob',
        }],
      }),
    });
    assert.equal(forged.status, 400);
    assert.match(await forged.text(), /未知字段|userId/u);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 检索 trace、反馈难例、日志健康和 Memory Doctor 可追溯', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-http-trace-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycleStore,
    memoryStore,
    { mode: 'auto' },
  );
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
  );
  const adminService = new MemoryAdminService(
    database,
    memoryStore,
    lifecycleStore,
    resolver,
    governance,
  );
  const memory = memoryStore.remember({
    kind: 'preference',
    content: '用户偏好的终端主题是深色主题。',
  }).memory;
  const server = createHttpServer(memoryStore, { adminService });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const recallResponse = await fetch(`${base}/api/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '终端主题偏好是什么？' }),
    });
    assert.equal(recallResponse.status, 200);
    const recall = await recallResponse.json() as {
      traceId: string;
      memories: Array<{ memory: { id: string } }>;
      grounding: Array<{ memoryId: string; versionId: string }>;
    };
    assert.equal(recall.memories[0].memory.id, memory.id);
    assert.equal(recall.grounding[0].memoryId, memory.id);

    const tracesResponse = await fetch(
      `${base}/api/retrieval-traces?resultId=${memory.id}`,
    );
    const traces = await tracesResponse.json() as Array<{
      traceId: string;
      query: string | null;
    }>;
    assert.equal(traces.length, 1);
    assert.equal(traces[0].traceId, recall.traceId);
    assert.equal(traces[0].query, null);

    const detailResponse = await fetch(
      `${base}/api/retrieval-traces/${recall.traceId}`,
    );
    const detail = await detailResponse.json() as {
      events: Array<{ stage: string }>;
    };
    assert.deepEqual(
      detail.events.map((event) => event.stage),
      [
        'request', 'rewrite', 'channels', 'fusion', 'semantic',
        'rerank', 'selection', 'context', 'result',
      ],
    );

    const feedbackResponse = await fetch(`${base}/api/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        memoryId: memory.id,
        feedback: 'rejected',
        traceId: recall.traceId,
      }),
    });
    assert.equal(feedbackResponse.status, 200);
    const examplesResponse = await fetch(
      `${base}/api/feedback-examples?feedback=rejected`,
    );
    const examples = await examplesResponse.json() as Array<{
      traceId: string;
      memoryId: string;
      feedback: string;
    }>;
    assert.deepEqual(examples.map((example) => ({
      traceId: example.traceId,
      memoryId: example.memoryId,
      feedback: example.feedback,
    })), [{
      traceId: recall.traceId,
      memoryId: memory.id,
      feedback: 'rejected',
    }]);

    const logHealthResponse = await fetch(
      `${base}/api/retrieval-log/health`,
    );
    const logHealth = await logHealthResponse.json() as {
      logMode: string;
      consecutiveFailures: number;
    };
    assert.equal(logHealth.logMode, 'metadata');
    assert.equal(logHealth.consecutiveFailures, 0);

    const doctorResponse = await fetch(`${base}/api/memory-doctor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sampleLimit: 5 }),
    });
    assert.equal(doctorResponse.status, 200);
    const doctor = await doctorResponse.json() as {
      issues: Array<{ category: string }>;
      destructiveActionsTaken: number;
    };
    assert.ok(
      doctor.issues.some(
        (issue) => issue.category === 'zero_result_hotspot',
      ),
    );
    assert.equal(doctor.destructiveActionsTaken, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 记忆库在服务端按 persona/session scope 筛选', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-scope-list-http-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const server = createHttpServer(memoryStore);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const roleA = memoryStore.remember({
      kind: 'relationship',
      content: '只属于 persona A 的记忆。',
      scopeType: 'role',
      scopeKey: 'persona-a',
    }).memory;
    memoryStore.remember({
      kind: 'relationship',
      content: '只属于 persona B 的记忆。',
      scopeType: 'role',
      scopeKey: 'persona-b',
    });
    const sessionA = memoryStore.remember({
      kind: 'project',
      content: '只属于 session A 的记忆。',
      scopeType: 'session',
      scopeKey: 'session-a',
    }).memory;

    const roleResponse = await fetch(
      `${base}/api/memories?scopeType=role&scopeKey=persona-a`,
    );
    assert.equal(roleResponse.status, 200);
    assert.deepEqual(
      (await roleResponse.json() as {
        items: Array<{ id: string }>;
      }).items.map((memory) => memory.id),
      [roleA.id],
    );

    const sessionResponse = await fetch(
      `${base}/api/memories?scopeType=session&scopeKey=session-a`,
    );
    assert.equal(sessionResponse.status, 200);
    assert.deepEqual(
      (await sessionResponse.json() as {
        items: Array<{ id: string }>;
      }).items.map((memory) => memory.id),
      [sessionA.id],
    );

    assert.equal(
      (
        await fetch(`${base}/api/memories?scopeKey=persona-a`)
      ).status,
      400,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Restore 的真实 embedding provider 故障返回 503 且不改状态', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-restore-provider-http-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const semanticRanker = new OllamaSemanticRanker({
    baseUrl: 'http://127.0.0.1:11434',
    embeddingModel: 'bge-m3',
    rerankModel: 'qwen2.5:14b',
    embedBatchSize: 8,
    rerankBatchSize: 8,
    timeoutMs: 1_000,
    fetchImpl: async () =>
      new Response('provider unavailable', { status: 503 }),
  });
  const resolver = new CandidateResolver(
    database,
    lifecycleStore,
    memoryStore,
    {
      mode: 'auto',
      embeddingProvider: semanticRanker,
    },
  );
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
  );
  const adminService = new MemoryAdminService(
    database,
    memoryStore,
    lifecycleStore,
    resolver,
    governance,
  );
  const deleted = memoryStore.remember({
    kind: 'preference',
    content: '用户常用的开发工具是 VS Code。',
    stableKey: 'http-provider-failure-old',
    predicateKey: '用户::常用开发工具',
    normalizedValueHash: 'tool-vscode',
    normalizedValue: 'VS Code',
    predicateCardinality: 'single',
  }).memory;
  memoryStore.forget(deleted.id);
  memoryStore.remember({
    kind: 'preference',
    content: '用户当前的主要编辑器是 Cursor。',
    stableKey: 'http-provider-failure-current',
    predicateKey: '用户::主要编辑器',
    normalizedValueHash: 'editor-cursor',
    normalizedValue: 'Cursor',
    predicateCardinality: 'single',
  });
  const server = createHttpServer(memoryStore, { adminService });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}` +
        `/api/memories/${deleted.id}/restore`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(response.status, 503);
    assert.match(
      (await response.json() as { error: string }).error,
      /embedding 请求失败/,
    );
    assert.equal(
      memoryStore.get(deleted.id, true)?.status,
      'deleted',
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_tombstones
           WHERE memory_item_id = ? AND restored_at IS NULL`,
        )
        .get(deleted.id)?.count,
      1,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('治理 API 支持候选与动作审核、版本证据、Pin、TTL 和健康状态', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-admin-http-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycleStore,
    memoryStore,
    { mode: 'shadow' },
  );
  const governance = new MemoryGovernance(
    database,
    lifecycleStore,
    memoryStore,
  );
  const adminService = new MemoryAdminService(
    database,
    memoryStore,
    lifecycleStore,
    resolver,
    governance,
  );
  const turn = lifecycleStore.recordTurn({
    clientName: 'client',
    sessionExternalId: 'admin-session',
    turnExternalId: 'admin-turn',
    role: 'user',
    content: '我主要使用 VS Code。',
  }).turn;
  const runId = lifecycleStore.startExtraction(
    turn.id,
    'qwen2.5:14b',
    'extract-v1',
  );
  const candidate = lifecycleStore.completeExtraction(
    runId,
    [{
      kind: 'preference',
      subject: '用户',
      predicate: '主要编辑器',
      value: 'VS Code',
      content: '用户主要使用 VS Code。',
      confidence: 0.99,
      importance: 0.8,
    }],
  )[0];
  const actionTurn = lifecycleStore.recordTurn({
    clientName: 'client',
    sessionExternalId: 'admin-action-session',
    turnExternalId: 'admin-action-turn',
    role: 'user',
    content: '请记住，我需要每年复诊。',
    metadata: { skipAutoExtraction: true },
  }).turn;
  const actionRunId = lifecycleStore.startExtraction(
    actionTurn.id,
    'qwen2.5:14b',
    'explicit-memory-intent-v1',
    'explicit-memory-intent',
    'v1',
  );
  const actionCandidate = lifecycleStore.completeExtraction(
    actionRunId,
    [{
      kind: 'profile',
      subject: '用户',
      predicate: '健康安排',
      value: '每年复诊',
      content: '用户需要每年复诊。',
      confidence: 0.99,
      importance: 0.9,
      sensitivity: 'sensitive',
      sourceExcerpt: '需要每年复诊',
    }],
  )[0];
  const actionRequestId = randomUUID();
  database
    .prepare(
      `INSERT INTO memory_action_requests (
         id, user_id, namespace, request_key, action, status,
         candidate_id, turn_id, candidate_json, confidence,
         sensitivity, model, prompt_version, rationale, created_at
       ) VALUES (
         ?, 'default', 'personal', ?, 'remember', 'pending',
         ?, ?, ?, 0.99, 'sensitive', 'qwen2.5:14b',
         'explicit-memory-intent-v1', '需要人工确认敏感记忆', ?
       )`,
    )
    .run(
      actionRequestId,
      `admin-action\n${actionTurn.externalId}`,
      actionCandidate.id,
      actionTurn.id,
      JSON.stringify({
        kind: 'profile',
        subject: '用户',
        predicate: '健康安排',
        value: '每年复诊',
        content: '用户需要每年复诊。',
      }),
      new Date().toISOString(),
    );
  const server = createHttpServer(memoryStore, {
    adminService,
    compatChatModel: 'custom-airi-chat:latest',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          models: [
            { name: 'custom-airi-chat:latest' },
            { name: 'qwen2.5:14b' },
            { name: 'bge-m3:latest' },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const inbox = await fetch(`${base}/api/candidates`);
    const candidates = await inbox.json() as Array<{ id: string }>;
    assert.ok(
      candidates.some((entry) => entry.id === candidate.id),
      JSON.stringify({
        expectedCandidateId: candidate.id,
        candidates,
      }),
    );

    const acceptedResponse = await fetch(
      `${base}/api/candidates/${candidate.id}/accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(acceptedResponse.status, 200);
    const accepted = await acceptedResponse.json() as {
      memoryId: string;
      reason: string;
    };
    assert.equal(accepted.reason, 'manual_review_accepted');

    const actionInboxResponse = await fetch(
      `${base}/api/action-requests`,
    );
    assert.equal(actionInboxResponse.status, 200);
    const actionInbox = await actionInboxResponse.json() as Array<{
      id: string;
      action: string;
      candidate: { value?: string } | null;
    }>;
    assert.equal(actionInbox[0]?.id, actionRequestId);
    assert.equal(actionInbox[0]?.action, 'remember');
    assert.equal(actionInbox[0]?.candidate?.value, '每年复诊');

    const actionAcceptedResponse = await fetch(
      `${base}/api/action-requests/${actionRequestId}/accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          value: '每年定期复诊',
          content: '用户需要每年定期复诊。',
        }),
      },
    );
    assert.equal(actionAcceptedResponse.status, 200);
    const actionAccepted = await actionAcceptedResponse.json() as {
      status: string;
      memoryId: string;
    };
    assert.equal(actionAccepted.status, 'completed');
    assert.match(
      memoryStore.get(actionAccepted.memoryId)?.content || '',
      /每年定期复诊/,
    );

    const unknownActionField = await fetch(
      `${base}/api/action-requests/${actionRequestId}/accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      },
    );
    assert.equal(unknownActionField.status, 400);
    assert.match(
      (
        await unknownActionField.json() as { error: string }
      ).error,
      /未知记忆动作审核字段/,
    );

    const rejectedActionId = randomUUID();
    database
      .prepare(
        `INSERT INTO memory_action_requests (
           id, user_id, namespace, request_key, action, status,
           model, prompt_version, rationale, created_at
         ) VALUES (
           ?, 'default', 'personal', ?, 'forget', 'failed',
           'qwen2.5:14b', 'explicit-memory-intent-v1',
           'provider unavailable', ?
         )`,
      )
      .run(
        rejectedActionId,
        `admin-reject\n${rejectedActionId}`,
        new Date().toISOString(),
      );
    const rejectedActionResponse = await fetch(
      `${base}/api/action-requests/${rejectedActionId}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    assert.equal(rejectedActionResponse.status, 200);
    assert.equal(
      (
        await rejectedActionResponse.json() as { status: string }
      ).status,
      'rejected',
    );

    const pinned = await fetch(
      `${base}/api/memories/${accepted.memoryId}/pin`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      },
    );
    assert.equal(
      (await pinned.json() as { pinned: boolean }).pinned,
      true,
    );
    const ttl = await fetch(
      `${base}/api/memories/${accepted.memoryId}/ttl`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expiresAt: '2027-07-29T00:00:00.000Z',
        }),
      },
    );
    assert.equal(
      (await ttl.json() as { expiresAt: string }).expiresAt,
      '2027-07-29T00:00:00.000Z',
    );
    const archivedResponse = await fetch(
      `${base}/api/memories/${accepted.memoryId}/archive`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'HTTP 手动归档测试' }),
      },
    );
    assert.equal(archivedResponse.status, 200);
    const archived = await archivedResponse.json() as {
      status: string;
      archiveReason: string;
    };
    assert.equal(archived.status, 'archived');
    assert.equal(archived.archiveReason, 'HTTP 手动归档测试');
    assert.equal(
      memoryStore.get(accepted.memoryId, true)?.status,
      'archived',
    );
    const unarchivedResponse = await fetch(
      `${base}/api/memories/${accepted.memoryId}/unarchive`,
      { method: 'POST' },
    );
    assert.equal(unarchivedResponse.status, 200);
    assert.equal(
      (
        await unarchivedResponse.json() as { status: string }
      ).status,
      'active',
    );
    assert.equal(
      memoryStore.get(accepted.memoryId, true)?.status,
      'active',
    );
    const invalidArchiveReason = await fetch(
      `${base}/api/memories/${accepted.memoryId}/archive`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '' }),
      },
    );
    assert.equal(invalidArchiveReason.status, 400);

    const detailResponse = await fetch(
      `${base}/api/memories/${accepted.memoryId}`,
    );
    const detail = await detailResponse.json() as {
      governance: { pinned: boolean };
      versions: Array<{ evidence: unknown[] }>;
      events: unknown[];
    };
    assert.equal(detail.governance.pinned, true);
    assert.equal(detail.versions.length, 1);
    assert.equal(detail.versions[0].evidence.length, 1);
    assert.ok(detail.events.length >= 3);

    const deadSweep = lifecycleStore.enqueueConsolidationSweep();
    database
      .prepare(
        `UPDATE memory_jobs
         SET attempts = max_attempts - 1
         WHERE id = ?`,
      )
      .run(deadSweep.id);
    assert.equal(
      lifecycleStore.claimJob(
        'http-dead-sweep-worker',
        30,
        ['consolidation_sweep'],
      )?.id,
      deadSweep.id,
    );
    assert.equal(
      lifecycleStore.failJob(
        deadSweep.id,
        'http-dead-sweep-worker',
        '模拟历史巩固配置漂移',
      ).status,
      'dead',
    );
    const recoveredSweep =
      lifecycleStore.ensureConsolidationSweep();

    const health = await fetch(`${base}/api/system-health`);
    const healthPayload = await health.json() as {
      quality: string;
      ollamaAvailable: boolean;
      deadLetterCount: number;
      deadLetterHistoryCount: number;
      deadLetters: Array<{
        resolved: boolean;
        recoveryJobId: string | null;
      }>;
      jobAttempts: Array<{
        jobId: string;
        outcome: string;
        failureClass: string | null;
        compensationAction: string | null;
        nextState: string;
      }>;
      missingModels: string[];
      models: {
        chat: string;
        extraction: string;
        consolidation: string;
      };
    };
    assert.equal(healthPayload.quality, 'unavailable');
    assert.equal(healthPayload.ollamaAvailable, true);
    assert.equal(healthPayload.deadLetterCount, 1);
    assert.equal(healthPayload.deadLetterHistoryCount, 1);
    assert.deepEqual(healthPayload.missingModels, []);
    assert.equal(healthPayload.deadLetters[0]?.resolved, false);
    assert.ok(healthPayload.jobAttempts.some(
      (attempt) =>
        attempt.jobId === deadSweep.id &&
        attempt.outcome === 'failed' &&
        attempt.failureClass === 'unknown' &&
        attempt.nextState === 'dead',
    ));
    assert.equal(
      healthPayload.deadLetters[0]?.recoveryJobId,
      recoveredSweep.id,
    );
    assert.equal(healthPayload.models.extraction, 'qwen2.5:14b');
    assert.equal(
      healthPayload.models.chat,
      'custom-airi-chat:latest',
    );
    assert.equal(
      healthPayload.models.consolidation,
      'qwen2.5:14b',
    );

    const claimedRecovery = lifecycleStore.claimJob(
      'http-recovered-sweep-worker',
      30,
      ['consolidation_sweep'],
    );
    assert.equal(claimedRecovery?.id, recoveredSweep.id);
    lifecycleStore.completeJob(
      recoveredSweep.id,
      'http-recovered-sweep-worker',
      {
        resultStatus: 'completed_noop',
        compensationAction: 'system_takeover_noop',
        recoveryStrategy: 'recompute_eligible_clusters_only',
        noopReason: 'already_consolidated',
        modelDurationMs: 12,
      },
    );
    const recoveredHealthResponse = await fetch(
      `${base}/api/system-health`,
    );
    const recoveredHealth = await recoveredHealthResponse.json() as {
      quality: string;
      deadLetterCount: number;
      deadLetterHistoryCount: number;
      deadLetters: Array<{
        resolved: boolean;
        recoveryJobId: string | null;
      }>;
      jobAttempts: Array<{
        jobId: string;
        outcome: string;
        resultStatus: string | null;
        compensationAction: string | null;
        recoveryStrategy: string | null;
        noopReason: string | null;
        modelDurationMs: number | null;
      }>;
    };
    assert.equal(recoveredHealth.quality, 'full');
    assert.equal(recoveredHealth.deadLetterCount, 0);
    assert.equal(recoveredHealth.deadLetterHistoryCount, 1);
    assert.equal(recoveredHealth.deadLetters[0]?.resolved, true);
    assert.ok(recoveredHealth.jobAttempts.some(
      (attempt) =>
        attempt.jobId === recoveredSweep.id &&
        attempt.outcome === 'completed' &&
        attempt.resultStatus === 'completed_noop' &&
        attempt.compensationAction === 'system_takeover_noop' &&
        attempt.recoveryStrategy === 'recompute_eligible_clusters_only' &&
        attempt.noopReason === 'already_consolidated' &&
        attempt.modelDurationMs === 12,
    ));
    assert.equal(
      recoveredHealth.deadLetters[0]?.recoveryJobId,
      recoveredSweep.id,
    );

    const purgeTarget = memoryStore.remember({
      kind: 'event',
      content: '这条记忆用于验证物理清除 API 的边界说明。',
      stableKey: '用户::物理清除API边界',
    }).memory;
    const purgeResponse = await fetch(
      `${base}/api/memories/${purgeTarget.id}/purge`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'HTTP 物理清除测试' }),
      },
    );
    assert.equal(purgeResponse.status, 202);
    const purgePayload = await purgeResponse.json() as {
      purgeBoundary: {
        managedMigrationBackups: boolean;
        externalExportCopies: boolean;
        notice: string;
      };
    };
    assert.equal(
      purgePayload.purgeBoundary.managedMigrationBackups,
      true,
    );
    assert.equal(
      purgePayload.purgeBoundary.externalExportCopies,
      false,
    );
    assert.match(purgePayload.purgeBoundary.notice, /自行下载/u);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
