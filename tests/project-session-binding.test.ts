import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryLifecycle } from '../src/server/memory-lifecycle.js';
import {
  COMPAT_CHAT_MODEL,
  handleOllamaCompatibilityProxy,
} from '../src/server/ollama-compat.js';
import { openDatabase } from '../src/server/database.js';
import { IdentityService } from '../src/server/identity.js';
import {
  ConversationIdentityConflictError,
  LifecycleStore,
  type EnsureConversationSessionInput,
} from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';
import type {
  NamespaceRecallCoordinator,
} from '../src/server/namespace-quality.js';
import type { RecallInput } from '../src/server/types.js';

function createFixture() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-project-binding-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const lifecycleStore = new LifecycleStore(database);
  return {
    database,
    lifecycleStore,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function binding(
  sessionExternalId: string,
  projectId: string | null,
  overrides: Partial<EnsureConversationSessionInput> = {},
): EnsureConversationSessionInput {
  return {
    userId: 'alice',
    namespace: 'personal',
    personaId: 'persona-A',
    projectId,
    identitySource: 'credential',
    identityStatus: 'complete',
    roundId: 'round-1',
    clientName: 'ollama-compat',
    sessionExternalId,
    ...overrides,
  };
}

function assertProjectConflict(action: () => unknown): void {
  assert.throws(
    action,
    (error) =>
      error instanceof ConversationIdentityConflictError &&
      /不能切换 project 绑定/u.test(error.message),
  );
}

test('project 首次绑定原子且 session 内 A→A 幂等、A→B/A→null 均拒绝', () => {
  const fixture = createFixture();
  try {
    const initial = binding('session-project-A', 'project-A');
    fixture.lifecycleStore.ensureSessionIdentityBinding(initial);
    fixture.lifecycleStore.ensureSessionIdentityBinding({
      ...initial,
      roundId: 'round-2',
    });

    assertProjectConflict(() =>
      fixture.lifecycleStore.ensureSessionIdentityBinding({
        ...initial,
        projectId: 'project-B',
        roundId: 'round-3',
      }),
    );
    assertProjectConflict(() =>
      fixture.lifecycleStore.ensureSessionIdentityBinding({
        ...initial,
        projectId: null,
        roundId: 'round-4',
      }),
    );

    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT external_id, project_id
           FROM conversation_sessions
           WHERE user_id = 'alice'`,
        )
        .all()
        .map((row) => ({ ...row })),
      [{ external_id: 'session-project-A', project_id: 'project-A' }],
    );
  } finally {
    fixture.close();
  }
});

test('null 也是不可变 project 绑定：null→null 幂等且 null→A 拒绝', () => {
  const fixture = createFixture();
  try {
    const initial = binding('session-without-project', null);
    fixture.lifecycleStore.ensureSessionIdentityBinding(initial);
    fixture.lifecycleStore.ensureSessionIdentityBinding({
      ...initial,
      roundId: 'round-2',
    });
    assertProjectConflict(() =>
      fixture.lifecycleStore.ensureSessionIdentityBinding({
        ...initial,
        projectId: 'project-A',
        roundId: 'round-3',
      }),
    );

    const row = fixture.database
      .prepare(
        `SELECT project_id
         FROM conversation_sessions
         WHERE external_id = 'session-without-project'`,
      )
      .get();
    assert.equal(row?.project_id, null);
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_sessions')
        .get()?.count,
      1,
    );
  } finally {
    fixture.close();
  }
});

test('同一 round 重放幂等，S1/A 与 S2/B 独立落账并独立提取 project scope', () => {
  const fixture = createFixture();
  try {
    const record = (
      sessionExternalId: string,
      projectId: string,
      roundId: string,
    ) => fixture.lifecycleStore.recordCompletedExchange({
      ...binding(sessionExternalId, projectId, { roundId }),
      userTurnExternalId: `user:${roundId}`,
      userContent: `${projectId} 的项目约定。`,
      assistantTurnExternalId: `assistant:${roundId}`,
      assistantContent: '已记录。',
    });

    const s1 = record('session-1', 'project-A', 'round-A');
    const s1Replay = record('session-1', 'project-A', 'round-A');
    const s2 = record('session-2', 'project-B', 'round-B');
    assert.equal(s1.created, true);
    assert.equal(s1Replay.created, false);
    assert.equal(s1Replay.userTurn.id, s1.userTurn.id);
    assert.notEqual(s1.sessionId, s2.sessionId);

    const extractProjectCandidate = (
      turnId: string,
      promptVersion: string,
      modelScopeGuess: string,
    ) => {
      const runId = fixture.lifecycleStore.startExtraction(
        turnId,
        'qwen2.5:14b',
        promptVersion,
      );
      return fixture.lifecycleStore.completeExtraction(
        runId,
        [{
          kind: 'project',
          subject: '当前项目',
          predicate: '项目约定',
          value: '只属于当前项目',
          content: '当前项目约定只属于当前项目。',
          confidence: 0.99,
          importance: 0.9,
          scopeType: 'project',
          scopeKey: modelScopeGuess,
        }],
        { enqueueResolution: false },
      )[0];
    };

    const candidateA = extractProjectCandidate(
      s1.userTurn.id,
      'project-binding-A-v1',
      'project-B',
    );
    const candidateB = extractProjectCandidate(
      s2.userTurn.id,
      'project-binding-B-v1',
      'project-A',
    );
    assert.equal(candidateA?.scopeKey, 'project-A');
    assert.equal(candidateB?.scopeKey, 'project-B');
    assert.match(candidateA?.stableKey || '', /^project::project-A::/u);
    assert.match(candidateB?.stableKey || '', /^project::project-B::/u);
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT external_id, project_id
           FROM conversation_sessions
           ORDER BY external_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { external_id: 'session-1', project_id: 'project-A' },
        { external_id: 'session-2', project_id: 'project-B' },
      ],
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      4,
    );
  } finally {
    fixture.close();
  }
});

test('completeExtraction 只信结构化 session.project_id，忽略 turn metadata 伪造 project', () => {
  const fixture = createFixture();
  try {
    const recorded = fixture.lifecycleStore.recordTurn({
      ...binding('metadata-spoof-session', 'project-A'),
      turnExternalId: 'user:metadata-spoof',
      role: 'user',
      content: '当前项目要求首次打开保持空数据。',
      metadata: { trustedProjectId: 'project-B' },
    });
    const runId = fixture.lifecycleStore.startExtraction(
      recorded.turn.id,
      'qwen2.5:14b',
      'metadata-spoof-v1',
    );
    const [candidate] = fixture.lifecycleStore.completeExtraction(
      runId,
      [{
        kind: 'project',
        subject: '当前项目',
        predicate: '首次打开数据',
        value: '保持空数据',
        content: '当前项目首次打开保持空数据。',
        confidence: 1,
        importance: 1,
        scopeType: 'project',
        scopeKey: 'project-C',
        sourceExcerpt: '首次打开保持空数据',
      }],
      { enqueueResolution: false },
    );

    const persisted = fixture.database
      .prepare(
        `SELECT s.project_id, t.metadata_json
         FROM conversation_turns t
         JOIN conversation_sessions s ON s.id = t.session_id
         WHERE t.id = ?`,
      )
      .get(recorded.turn.id);
    assert.equal(persisted?.project_id, 'project-A');
    assert.equal(
      JSON.parse(String(persisted?.metadata_json)).trustedProjectId,
      'project-B',
    );
    assert.equal(candidate?.scopeType, 'project');
    assert.equal(candidate?.scopeKey, 'project-A');
    assert.match(candidate?.stableKey || '', /^project::project-A::/u);
    assert.doesNotMatch(candidate?.stableKey || '', /project-B|project-C/u);
  } finally {
    fixture.close();
  }
});

test('用户明确项目专属时覆盖 14B 的 personal 误判并绑定可信 project', () => {
  const fixture = createFixture();
  try {
    const extract = (
      sessionExternalId: string,
      projectId: string | null,
      roundId: string,
    ) => {
      const exchange = fixture.lifecycleStore.recordCompletedExchange({
        ...binding(sessionExternalId, projectId, { roundId }),
        userTurnExternalId: `user:${roundId}`,
        userContent:
          '验收项目A的项目专属代号是青铜海燕，只属于当前项目。',
        assistantTurnExternalId: `assistant:${roundId}`,
        assistantContent: '知道了。',
      });
      const runId = fixture.lifecycleStore.startExtraction(
        exchange.userTurn.id,
        'qwen2.5:14b',
        `project-exclusive-${roundId}`,
      );
      return fixture.lifecycleStore.completeExtraction(
        runId,
        [{
          kind: 'knowledge',
          subject: '验收项目A',
          predicate: '项目专属代号',
          value: '青铜海燕',
          content: '验收项目A的项目专属代号是青铜海燕。',
          confidence: 1,
          importance: 1,
          scopeType: 'personal',
          scopeKey: 'self',
          sourceExcerpt: '青铜海燕',
        }],
        { enqueueResolution: false },
      )[0];
    };

    const bound = extract(
      'exclusive-project-session',
      'project-A',
      'round-exclusive-bound',
    );
    const unbound = extract(
      'exclusive-no-project-session',
      null,
      'round-exclusive-unbound',
    );

    assert.deepEqual(
      [bound?.scopeType, bound?.scopeKey, bound?.state],
      ['project', 'project-A', 'pending'],
    );
    assert.match(bound?.stableKey || '', /^project::project-A::/u);
    assert.deepEqual(
      [unbound?.scopeType, unbound?.state, unbound?.decisionReason],
      ['project', 'rejected', 'trusted_project_scope_required'],
    );
    assert.notEqual(unbound?.scopeKey, 'self');
  } finally {
    fixture.close();
  }
});

test('project kind 不能伪装成宽 scope，且大小写不同的 project 不碰撞', () => {
  const fixture = createFixture();
  try {
    const extract = (
      sessionExternalId: string,
      projectId: string | null,
      roundId: string,
      requestedScope: 'personal' | 'role',
    ) => {
      const turn = fixture.lifecycleStore.recordTurn({
        ...binding(sessionExternalId, projectId, { roundId }),
        turnExternalId: `user:${roundId}`,
        role: 'user',
        content: '这个项目有独立约定。',
      }).turn;
      const runId = fixture.lifecycleStore.startExtraction(
        turn.id,
        'qwen2.5:14b',
        `scope-coercion-${roundId}`,
      );
      return fixture.lifecycleStore.completeExtraction(
        runId,
        [{
          kind: 'project',
          subject: '当前项目',
          predicate: '独立约定',
          value: '只属于当前项目',
          content: '当前项目有独立约定。',
          confidence: 1,
          importance: 1,
          scopeType: requestedScope,
          scopeKey: 'attacker-wide-scope',
        }],
        { enqueueResolution: false },
      )[0];
    };

    const upper = extract('case-upper', 'Project-A', 'round-upper', 'personal');
    const lower = extract('case-lower', 'project-a', 'round-lower', 'role');
    const unbound = extract('case-unbound', null, 'round-unbound', 'personal');

    assert.deepEqual(
      [upper?.scopeType, upper?.scopeKey, upper?.state],
      ['project', 'Project-A', 'pending'],
    );
    assert.deepEqual(
      [lower?.scopeType, lower?.scopeKey, lower?.state],
      ['project', 'project-a', 'pending'],
    );
    assert.notEqual(upper?.stableKey, lower?.stableKey);
    assert.deepEqual(
      [unbound?.scopeType, unbound?.state, unbound?.decisionReason],
      ['project', 'rejected', 'trusted_project_scope_required'],
    );
  } finally {
    fixture.close();
  }
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  const closing = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closing;
}

test('HTTP project 冲突在 recall 与 Ollama 前返回 409 且零落账', async () => {
  const fixture = createFixture();
  const memoryStore = new MemoryStore(fixture.database);
  let recallCalls = 0;
  let upstreamCalls = 0;
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      recallCalls += 1;
      return {
        query: input.query,
        memories: [],
        context: '没有找到与当前问题相关的长期记忆。',
        qualityState: 'full',
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    memoryStore,
    fixture.lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
  );
  fixture.lifecycleStore.ensureSessionIdentityBinding(
    binding('http-conflict-session', 'project-A'),
  );

  const server = http.createServer(async (request, response) => {
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || '127.0.0.1'}`,
    );
    await handleOllamaCompatibilityProxy(
      request,
      response,
      url,
      {
        upstreamBaseUrl: 'http://127.0.0.1:11434',
        lifecycle,
        authenticatedPrincipal: {
          principalId: 'alice',
          namespace: 'personal',
          credentialId: 'credential-alice',
          authSource: 'credential',
        },
        fetchImpl: async () => {
          upstreamCalls += 1;
          return new Response(
            JSON.stringify({
              model: COMPAT_CHAT_MODEL,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: '不应调用。' },
                finish_reason: 'stop',
              }],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        },
        audit: () => undefined,
      },
    );
  });
  let baseUrl = '';
  try {
    baseUrl = await listen(server);
    const response = await fetch(
      `${baseUrl}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-memory-bridge-context-version': '1',
          'x-airi-character-id': 'persona-A',
          'x-airi-session-id': 'http-conflict-session',
          'x-airi-round-id': 'round-conflict',
          'x-airi-project-id': 'project-B',
        },
        body: JSON.stringify({
          model: COMPAT_CHAT_MODEL,
          messages: [{ role: 'user', content: '读取项目记忆。' }],
          stream: false,
        }),
      },
    );
    assert.equal(response.status, 409);
    assert.match(await response.text(), /不能切换 project 绑定/u);
    assert.equal(recallCalls, 0);
    assert.equal(upstreamCalls, 0);
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      0,
    );
    assert.equal(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM outbox_events')
        .get()?.count,
      0,
    );
    assert.equal(
      fixture.database
        .prepare(
          `SELECT project_id
           FROM conversation_sessions
           WHERE external_id = 'http-conflict-session'`,
        )
        .get()?.project_id,
      'project-A',
    );
  } finally {
    if (baseUrl) await close(server);
    else server.close();
    fixture.close();
  }
});

test('HTTP 同名 persona 按账户隔离并允许请求各自进入 Ollama', async () => {
  const fixture = createFixture();
  const identityService = new IdentityService(fixture.database);
  identityService.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identityService.createPrincipal({ id: 'bob', displayName: 'Bob' });
  identityService.bindPersona(
    identityService.trustPrincipal('alice'),
    {
      clientType: 'airi',
      clientInstanceId: 'local-airi-v1',
      personaId: 'persona-A',
    },
  );
  let recallCalls = 0;
  let upstreamCalls = 0;
  const lifecycle = new MemoryLifecycle(
    new MemoryStore(fixture.database),
    fixture.lifecycleStore,
    'default',
    'personal',
    undefined,
    {
      async recallForLifecycle(input: RecallInput) {
        recallCalls += 1;
        return {
          query: input.query,
          memories: [],
          context: '',
          qualityState: 'full',
        };
      },
    } as unknown as NamespaceRecallCoordinator,
    identityService,
  );
  const trustedBob = identityService.trustPrincipal('bob');
  const server = http.createServer(async (request, response) => {
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || '127.0.0.1'}`,
    );
    await handleOllamaCompatibilityProxy(
      request,
      response,
      url,
      {
        upstreamBaseUrl: 'http://127.0.0.1:11434',
        lifecycle,
        authenticatedPrincipal: {
          principalId: 'bob',
          namespace: 'personal',
          credentialId: 'credential-bob',
          authSource: 'credential',
          trustedPrincipal: trustedBob,
        },
        fetchImpl: async () => {
          upstreamCalls += 1;
          return new Response(
            JSON.stringify({
              model: COMPAT_CHAT_MODEL,
              choices: [{
                index: 0,
                message: { role: 'assistant', content: 'Bob 已隔离。' },
                finish_reason: 'stop',
              }],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        },
        audit: () => undefined,
      },
    );
  });
  let baseUrl = '';
  try {
    baseUrl = await listen(server);
    const response = await fetch(
      `${baseUrl}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-memory-bridge-context-version': '1',
          'x-airi-character-id': 'persona-A',
          'x-airi-session-id': 'persona-owner-conflict-session',
          'x-airi-round-id': 'round-persona-conflict',
          'x-airi-project-id': 'project-A',
        },
        body: JSON.stringify({
          model: COMPAT_CHAT_MODEL,
          messages: [{ role: 'user', content: 'Bob 的独立请求。' }],
          stream: false,
        }),
      },
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Bob 已隔离/u);
    assert.equal(recallCalls, 1);
    assert.equal(upstreamCalls, 1);
    assert.equal(
      fixture.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM conversation_sessions
           WHERE user_id = 'bob'`,
        )
        .get()?.count,
      1,
    );
    assert.deepEqual(
      fixture.database
        .prepare(
          `SELECT principal_id, persona_id
           FROM client_persona_bindings
           ORDER BY principal_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { principal_id: 'alice', persona_id: 'persona-A' },
        { principal_id: 'bob', persona_id: 'persona-A' },
      ],
    );
  } finally {
    if (baseUrl) await close(server);
    else server.close();
    fixture.close();
  }
});
