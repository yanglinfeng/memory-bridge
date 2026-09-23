import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CandidateResolver } from '../src/server/candidate-resolver.js';
import { openDatabase } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { IdentityService } from '../src/server/identity.js';
import {
  deadLetterRecoveryJobId,
  LifecycleStore,
} from '../src/server/lifecycle-store.js';
import { MemoryAdminService } from '../src/server/memory-admin.js';
import { MemoryGovernance } from '../src/server/memory-governance.js';
import { MemoryStore } from '../src/server/memory-store.js';

test('HTTP Token 绑定 principal 且核心记忆 API 不接受 userId 冒用', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-http-principal-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
  const aliceCredential = identity.issueCredential({
    principalId: 'alice',
    label: 'Alice test',
  });
  const bobCredential = identity.issueCredential({
    principalId: 'bob',
    label: 'Bob test',
  });
  identity.bindPersona(identity.trustPrincipal('alice'), {
    clientType: 'airi',
    clientInstanceId: 'alice-http',
    personaId: 'persona-alice-http',
    displayName: 'Alice HTTP Persona',
  });
  identity.bindPersona(identity.trustPrincipal('bob'), {
    clientType: 'airi',
    clientInstanceId: 'bob-http',
    personaId: 'persona-bob-http',
    displayName: 'Bob HTTP Persona',
  });
  const server = createHttpServer(store, {
    identityService: identity,
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  try {
    assert.equal((await fetch(`${base}/api/memories`)).status, 401);

    const spoofed = await fetch(`${base}/api/memories`, {
      method: 'POST',
      headers: headers(aliceCredential.token),
      body: JSON.stringify({
        userId: 'bob',
        kind: 'profile',
        content: 'Alice 试图冒用 Bob。',
      }),
    });
    assert.equal(spoofed.status, 400);

    const create = async (token: string, marker: string) => {
      const response = await fetch(`${base}/api/memories`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({
          kind: 'profile',
          content: `相同主题下的 ${marker} 私有事实。`,
        }),
      });
      assert.equal(response.status, 201);
      return await response.json() as {
        memory: { id: string; userId: string };
      };
    };
    const aliceMemory = await create(
      aliceCredential.token,
      'Alice',
    );
    const bobMemory = await create(bobCredential.token, 'Bob');
    assert.equal(aliceMemory.memory.userId, 'alice');
    assert.equal(bobMemory.memory.userId, 'bob');

    const aliceList = await fetch(`${base}/api/memories`, {
      headers: headers(aliceCredential.token),
    });
    const bobList = await fetch(`${base}/api/memories`, {
      headers: headers(bobCredential.token),
    });
    assert.deepEqual(
      (await aliceList.json() as {
        items: Array<{ userId: string }>;
      }).items.map((memory) => memory.userId),
      ['alice'],
    );
    assert.deepEqual(
      (await bobList.json() as {
        items: Array<{ userId: string }>;
      }).items.map((memory) => memory.userId),
      ['bob'],
    );

    const aliceIdentityResponse = await fetch(
      `${base}/api/identity`,
      { headers: headers(aliceCredential.token) },
    );
    assert.equal(aliceIdentityResponse.status, 200);
    const aliceIdentity = await aliceIdentityResponse.json() as {
      principal: { id: string };
      credential: { id: string; label: string } | null;
      personas: Array<{ personaId: string }>;
      personalMemoryCount: number;
    };
    assert.equal(aliceIdentity.principal.id, 'alice');
    assert.equal(
      aliceIdentity.credential?.id,
      aliceCredential.credential.id,
    );
    assert.equal(aliceIdentity.credential?.label, 'Alice test');
    assert.deepEqual(
      aliceIdentity.personas.map((persona) => persona.personaId),
      ['persona-alice-http'],
    );
    assert.equal(aliceIdentity.personalMemoryCount, 1);
    const aliceIdentityText = JSON.stringify(aliceIdentity);
    assert.equal(aliceIdentityText.includes('secret_hash'), false);
    assert.equal(aliceIdentityText.includes(aliceCredential.token), false);
    assert.equal(aliceIdentityText.includes(bobCredential.token), false);
    assert.equal(
      aliceIdentityText.includes(bobCredential.credential.id),
      false,
    );
    assert.equal(
      aliceIdentityText.includes('persona-bob-http'),
      false,
    );

    const bobBorrowAttempt = await fetch(
      `${base}/api/identity?principalId=alice`,
      { headers: headers(bobCredential.token) },
    );
    assert.equal(bobBorrowAttempt.status, 400);
    assert.match(
      await bobBorrowAttempt.text(),
      /userId\/principalId/u,
    );

    for (const [method, body] of [
      ['GET', undefined],
      ['PATCH', JSON.stringify({ importance: 0.99 })],
      ['DELETE', JSON.stringify({ reason: '越权删除' })],
    ] as const) {
      const response = await fetch(
        `${base}/api/memories/${bobMemory.memory.id}`,
        {
          method,
          headers: headers(aliceCredential.token),
          body,
        },
      );
      assert.equal(response.status, 404);
    }
    assert.equal(
      store.get(bobMemory.memory.id, true, 'bob')?.status,
      'active',
    );
    assert.notEqual(
      store.get(bobMemory.memory.id, true, 'bob')?.importance,
      0.99,
    );

    const spoofedRecall = await fetch(`${base}/api/recall`, {
      method: 'POST',
      headers: headers(aliceCredential.token),
      body: JSON.stringify({
        userId: 'bob',
        query: 'Bob 私有事实',
      }),
    });
    assert.equal(spoofedRecall.status, 400);

    const aliceConfig = await fetch(`${base}/api/config`, {
      headers: headers(aliceCredential.token),
    });
    assert.equal(
      (await aliceConfig.json() as { userId: string }).userId,
      'alice',
    );

    identity.revokeCredential(
      aliceCredential.credential.id,
      'test complete',
    );
    assert.equal(
      (
        await fetch(`${base}/api/memories`, {
          headers: headers(aliceCredential.token),
        })
      ).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 管理 API 全量绑定认证 principal 并对跨账户对象统一返回 404', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-http-admin-principal-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const lifecycle = new LifecycleStore(database);
  const resolver = new CandidateResolver(
    database,
    lifecycle,
    store,
    { mode: 'shadow' },
  );
  const governance = new MemoryGovernance(
    database,
    lifecycle,
    store,
  );
  const admin = new MemoryAdminService(
    database,
    store,
    lifecycle,
    resolver,
    governance,
  );
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
  const aliceCredential = identity.issueCredential({
    principalId: 'alice',
    label: 'Alice admin test',
  });
  const bobCredential = identity.issueCredential({
    principalId: 'bob',
    label: 'Bob admin test',
  });
  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  const aliceMemory = store.remember({
    userId: 'alice',
    kind: 'profile',
    content: 'Alice 的管理面边界记忆。',
  }).memory;
  const aliceDeleted = store.remember({
    userId: 'alice',
    kind: 'preference',
    content: 'Alice 待恢复的记忆。',
  }).memory;
  store.forget(aliceDeleted.id, 'alice deleted', 'alice');
  const bobMemory = store.remember({
    userId: 'bob',
    kind: 'profile',
    content: 'Bob 的管理面边界记忆。',
  }).memory;
  store.remember({
    userId: 'bob',
    kind: 'knowledge',
    content: 'Bob 的第二条活跃记忆用于区分健康统计。',
  });
  const bobDeleted = store.remember({
    userId: 'bob',
    kind: 'preference',
    content: 'Bob 待恢复的记忆。',
  }).memory;
  store.forget(bobDeleted.id, 'bob deleted', 'bob');
  const alicePurge = store.remember({
    userId: 'alice',
    kind: 'event',
    content: 'Alice 的物理清除队列夹具。',
  }).memory;
  const bobPurge = store.remember({
    userId: 'bob',
    kind: 'event',
    content: 'Bob 的物理清除队列夹具。',
  }).memory;
  governance.queuePurge(alicePurge.id, 'alice purge', 'alice');
  governance.queuePurge(bobPurge.id, 'bob purge', 'bob');

  const createCandidate = (
    userId: 'alice' | 'bob',
    marker: string,
  ) => {
    const turn = lifecycle.recordTurn({
      userId,
      clientName: 'http-admin-test',
      sessionExternalId: `${userId}-${marker}-session`,
      turnExternalId: `${userId}-${marker}-turn`,
      role: 'user',
      content: `${userId} ${marker} 候选内容`,
    }).turn;
    const runId = lifecycle.startExtraction(
      turn.id,
      'qwen2.5:14b',
      'http-admin-principal-v1',
    );
    return lifecycle.completeExtraction(runId, [{
      kind: 'preference',
      subject: '用户',
      predicate: `${marker}偏好`,
      value: marker,
      content: `${userId} 的 ${marker} 偏好。`,
      confidence: 0.95,
      importance: 0.8,
    }])[0];
  };
  const aliceCandidate = createCandidate('alice', 'Alice');
  const bobCandidate = createCandidate('bob', 'Bob-1');
  createCandidate('bob', 'Bob-2');

  const aliceActionId = randomUUID();
  const bobActionId = randomUUID();
  const timestamp = new Date().toISOString();
  const insertAction = database.prepare(
    `INSERT INTO memory_action_requests (
       id, user_id, namespace, request_key, action, status,
       model, prompt_version, rationale, created_at
     ) VALUES (?, ?, 'personal', ?, 'forget', 'failed',
       'qwen2.5:14b', 'http-admin-principal-v1', ?, ?)`,
  );
  insertAction.run(
    aliceActionId,
    'alice',
    `alice-action-${aliceActionId}`,
    'alice action',
    timestamp,
  );
  insertAction.run(
    bobActionId,
    'bob',
    `bob-action-${bobActionId}`,
    'bob action',
    timestamp,
  );

  const createDeadLetter = (
    userId: 'alice' | 'bob',
    jobId: string,
  ) => {
    lifecycle.enqueueJob({
      id: jobId,
      jobType: 'extract_turn',
      userId,
      namespace: 'personal',
      payload: { turnId: `${userId}-dead-letter-turn` },
      priority: 10_000,
      maxAttempts: 1,
    });
    assert.equal(
      lifecycle.claimJob(
        `${userId}-dead-letter-worker`,
        30,
        ['extract_turn'],
      )?.id,
      jobId,
    );
    assert.equal(
      lifecycle.failJob(
        jobId,
        `${userId}-dead-letter-worker`,
        `${userId} 历史提取失败`,
      ).status,
      'dead',
    );
  };
  const aliceDeadLetterJobId = 'alice-dead-letter-recovery';
  const bobDeadLetterJobId = 'bob-dead-letter-recovery';
  createDeadLetter('alice', aliceDeadLetterJobId);
  createDeadLetter('bob', bobDeadLetterJobId);

  const aliceConsolidationId = randomUUID();
  const bobConsolidationId = randomUUID();
  const insertConsolidation = database.prepare(
    `INSERT INTO derived_consolidations (
       id, user_id, namespace, scope_type, scope_key,
       source_set_hash, model, prompt_version, status, generated_at
     ) VALUES (?, ?, 'personal', 'topic', ?, ?, 'qwen2.5:14b',
       'http-admin-principal-v1', 'active', ?)`,
  );
  insertConsolidation.run(
    aliceConsolidationId,
    'alice',
    'alice-topic',
    'alice-source-set',
    timestamp,
  );
  insertConsolidation.run(
    bobConsolidationId,
    'bob',
    'bob-topic',
    'bob-source-set',
    timestamp,
  );

  store.recall({
    userId: 'alice',
    query: 'alice-recall-explanation',
  });
  store.recall({
    userId: 'bob',
    query: 'bob-recall-explanation',
  });

  const server = createHttpServer(store, {
    adminService: admin,
    identityService: identity,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }),
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
  const aliceHeaders = headers(aliceCredential.token);
  const bobHeaders = headers(bobCredential.token);
  const randomId = '00000000-0000-4000-8000-000000000000';
  const bobVersionId = store.history(bobMemory.id, 'bob')[0].id;

  try {
    const aliceCandidates = await (
      await fetch(`${base}/api/candidates`, {
        headers: aliceHeaders,
      })
    ).json() as Array<{ id: string; userId: string }>;
    const bobCandidates = await (
      await fetch(`${base}/api/candidates`, {
        headers: bobHeaders,
      })
    ).json() as Array<{ id: string; userId: string }>;
    assert.deepEqual(
      aliceCandidates.map((candidate) => candidate.userId),
      ['alice'],
    );
    assert.deepEqual(
      bobCandidates.map((candidate) => candidate.userId),
      ['bob', 'bob'],
    );

    const aliceActions = await (
      await fetch(`${base}/api/action-requests`, {
        headers: aliceHeaders,
      })
    ).json() as Array<{ id: string; userId: string }>;
    const bobActions = await (
      await fetch(`${base}/api/action-requests`, {
        headers: bobHeaders,
      })
    ).json() as Array<{ id: string; userId: string }>;
    assert.deepEqual(
      aliceActions.map((action) => action.id),
      [aliceActionId],
    );
    assert.deepEqual(
      bobActions.map((action) => action.id),
      [bobActionId],
    );

    const crossMemoryRequests = [
      {
        suffix: '',
        method: 'GET',
        body: undefined,
        crossId: bobMemory.id,
      },
      {
        suffix: '',
        method: 'PATCH',
        body: { importance: 0.99 },
        crossId: bobMemory.id,
      },
      {
        suffix: '',
        method: 'DELETE',
        body: { reason: 'cross-account delete' },
        crossId: bobMemory.id,
      },
      {
        suffix: '/restore',
        method: 'POST',
        body: {},
        crossId: bobDeleted.id,
      },
      {
        suffix: '/revert',
        method: 'POST',
        body: { versionId: bobVersionId },
        crossId: bobMemory.id,
      },
      {
        suffix: '/pin',
        method: 'POST',
        body: { pinned: true },
        crossId: bobMemory.id,
      },
      {
        suffix: '/archive',
        method: 'POST',
        body: { reason: 'cross-account archive' },
        crossId: bobMemory.id,
      },
      {
        suffix: '/unarchive',
        method: 'POST',
        body: {},
        crossId: bobMemory.id,
      },
      {
        suffix: '/ttl',
        method: 'POST',
        body: { expiresAt: '2027-08-01T00:00:00.000Z' },
        crossId: bobMemory.id,
      },
      {
        suffix: '/purge',
        method: 'POST',
        body: { reason: 'cross-account purge' },
        crossId: bobMemory.id,
      },
    ] as const;
    for (const requestCase of crossMemoryRequests) {
      for (const id of [requestCase.crossId, randomId]) {
        const response = await fetch(
          `${base}/api/memories/${id}${requestCase.suffix}`,
          {
            method: requestCase.method,
            headers: aliceHeaders,
            body: requestCase.body === undefined
              ? undefined
              : JSON.stringify(requestCase.body),
          },
        );
        assert.equal(
          response.status,
          404,
          `${requestCase.method} ${requestCase.suffix || '/:id'} ${id}`,
        );
      }
    }

    for (const versionId of [bobVersionId, randomId]) {
      const response = await fetch(
        `${base}/api/memories/${aliceMemory.id}/revert`,
        {
          method: 'POST',
          headers: aliceHeaders,
          body: JSON.stringify({ versionId }),
        },
      );
      assert.equal(response.status, 404);
    }

    for (const memoryId of [bobMemory.id, randomId]) {
      const response = await fetch(`${base}/api/feedback`, {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          memoryId,
          feedback: 'confirmed',
        }),
      });
      assert.equal(response.status, 404);
    }
    for (const candidateId of [bobCandidate.id, randomId]) {
      for (const action of ['accept', 'reject']) {
        const response = await fetch(
          `${base}/api/candidates/${candidateId}/${action}`,
          {
            method: 'POST',
            headers: aliceHeaders,
            body: '{}',
          },
        );
        assert.equal(response.status, 404);
      }
    }
    for (const actionId of [bobActionId, randomId]) {
      for (const action of ['accept', 'reject']) {
        const response = await fetch(
          `${base}/api/action-requests/${actionId}/${action}`,
          {
            method: 'POST',
            headers: aliceHeaders,
            body: '{}',
          },
        );
        assert.equal(response.status, 404);
      }
    }
    assert.equal(
      lifecycle.getCandidate(bobCandidate.id)?.state,
      'pending',
    );
    assert.equal(
      database
        .prepare(
          'SELECT status FROM memory_action_requests WHERE id = ?',
        )
        .get(bobActionId)?.status,
      'failed',
    );

    const spoofCases = [
      {
        path: `/api/memories/${aliceMemory.id}`,
        method: 'PATCH',
        body: { importance: 0.9, userId: 'bob' },
      },
      {
        path: `/api/memories/${aliceMemory.id}`,
        method: 'DELETE',
        body: { reason: 'spoof', userId: 'bob' },
      },
      {
        path: `/api/memories/${aliceDeleted.id}/restore`,
        method: 'POST',
        body: { userId: 'bob' },
      },
      {
        path: `/api/memories/${aliceMemory.id}/revert`,
        method: 'POST',
        body: {
          versionId: store.history(aliceMemory.id, 'alice')[0].id,
          userId: 'bob',
        },
      },
      {
        path: `/api/memories/${aliceMemory.id}/pin`,
        method: 'POST',
        body: { pinned: true, userId: 'bob' },
      },
      {
        path: `/api/memories/${aliceMemory.id}/archive`,
        method: 'POST',
        body: { reason: 'spoof', principalId: 'bob' },
      },
      {
        path: `/api/memories/${aliceMemory.id}/unarchive`,
        method: 'POST',
        body: { userId: 'bob' },
      },
      {
        path: `/api/memories/${aliceMemory.id}/ttl`,
        method: 'POST',
        body: { expiresAt: null, userId: 'bob' },
      },
      {
        path: `/api/memories/${aliceMemory.id}/purge`,
        method: 'POST',
        body: { reason: 'spoof', userId: 'bob' },
      },
      {
        path: `/api/candidates/${aliceCandidate.id}/accept`,
        method: 'POST',
        body: { userId: 'bob' },
      },
      {
        path: `/api/action-requests/${aliceActionId}/reject`,
        method: 'POST',
        body: { userId: 'bob' },
      },
      {
        path: '/api/feedback',
        method: 'POST',
        body: {
          memoryId: aliceMemory.id,
          feedback: 'confirmed',
          principalId: 'bob',
        },
      },
      {
        path: '/api/retention-policies',
        method: 'PUT',
        body: { namespace: 'spoofed', userId: 'bob' },
      },
    ] as const;
    for (const spoofCase of spoofCases) {
      const response = await fetch(`${base}${spoofCase.path}`, {
        method: spoofCase.method,
        headers: aliceHeaders,
        body: JSON.stringify(spoofCase.body),
      });
      assert.equal(response.status, 400, spoofCase.path);
    }

    const aliceDetail = await fetch(
      `${base}/api/memories/${aliceMemory.id}`,
      { headers: aliceHeaders },
    );
    assert.equal(aliceDetail.status, 200);
    assert.equal(
      (await aliceDetail.json() as {
        memory: { userId: string };
        governance: { userId: string };
      }).governance.userId,
      'alice',
    );

    const crossAccountDeadLetterRecovery = await fetch(
      `${base}/api/dead-letters/recover`,
      {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          jobId: bobDeadLetterJobId,
          mode: 'recompute',
        }),
      },
    );
    assert.equal(crossAccountDeadLetterRecovery.status, 404);

    const spoofedDeadLetterRecovery = await fetch(
      `${base}/api/dead-letters/recover`,
      {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          jobId: aliceDeadLetterJobId,
          mode: 'recompute',
          userId: 'bob',
        }),
      },
    );
    assert.equal(spoofedDeadLetterRecovery.status, 400);

    const recoverAliceDeadLetter = async () => {
      const response = await fetch(
        `${base}/api/dead-letters/recover`,
        {
          method: 'POST',
          headers: aliceHeaders,
          body: JSON.stringify({
            jobId: aliceDeadLetterJobId,
            mode: 'recompute',
          }),
        },
      );
      assert.equal(response.status, 202);
      return await response.json() as {
        id: string;
        userId: string;
        status: string;
      };
    };
    const aliceRecovery = await recoverAliceDeadLetter();
    const replayedAliceRecovery = await recoverAliceDeadLetter();
    assert.equal(
      aliceRecovery.id,
      deadLetterRecoveryJobId(aliceDeadLetterJobId),
    );
    assert.equal(aliceRecovery.userId, 'alice');
    assert.equal(aliceRecovery.status, 'pending');
    assert.equal(replayedAliceRecovery.id, aliceRecovery.id);

    const healthAlice = await (
      await fetch(`${base}/api/system-health`, {
        headers: aliceHeaders,
      })
    ).json() as {
      candidateCounts: Record<string, number>;
      index: { activeMemories: number };
      deadLetterCount: number;
      deadLetterHistoryCount: number;
      deadLetters: Array<{
        jobId: string;
        resolved: boolean;
        recoveryJobId: string | null;
        recoveryMode: string | null;
      }>;
    };
    const healthBob = await (
      await fetch(`${base}/api/system-health`, {
        headers: bobHeaders,
      })
    ).json() as {
      candidateCounts: Record<string, number>;
      index: { activeMemories: number };
      deadLetterCount: number;
      deadLetterHistoryCount: number;
      deadLetters: Array<{
        jobId: string;
        resolved: boolean;
        recoveryJobId: string | null;
        recoveryMode: string | null;
      }>;
    };
    assert.equal(healthAlice.candidateCounts.pending, 1);
    assert.equal(healthBob.candidateCounts.pending, 2);
    assert.equal(
      healthAlice.index.activeMemories,
      store.stats('alice').active,
    );
    assert.equal(
      healthBob.index.activeMemories,
      store.stats('bob').active,
    );
    assert.notEqual(
      healthAlice.index.activeMemories,
      healthBob.index.activeMemories,
    );
    assert.equal(healthAlice.deadLetterCount, 1);
    assert.equal(healthAlice.deadLetterHistoryCount, 1);
    assert.equal(healthAlice.deadLetters.length, 1);
    assert.equal(
      healthAlice.deadLetters[0]?.jobId,
      aliceDeadLetterJobId,
    );
    assert.equal(healthAlice.deadLetters[0]?.resolved, false);
    assert.equal(
      healthAlice.deadLetters[0]?.recoveryJobId,
      aliceRecovery.id,
    );
    assert.equal(
      healthAlice.deadLetters[0]?.recoveryMode,
      'recompute',
    );
    assert.equal(healthBob.deadLetterCount, 1);
    assert.equal(healthBob.deadLetterHistoryCount, 1);
    assert.equal(healthBob.deadLetters[0]?.jobId, bobDeadLetterJobId);
    assert.equal(healthBob.deadLetters[0]?.resolved, false);
    assert.equal(healthBob.deadLetters[0]?.recoveryJobId, null);
    assert.equal(healthBob.deadLetters[0]?.recoveryMode, null);

    const aliceStats = await (
      await fetch(`${base}/api/stats`, { headers: aliceHeaders })
    ).json();
    const bobStats = await (
      await fetch(`${base}/api/stats`, { headers: bobHeaders })
    ).json();
    assert.deepEqual(aliceStats, store.stats('alice'));
    assert.deepEqual(bobStats, store.stats('bob'));

    const listByPrincipal = async <T>(
      route: string,
      tokenHeaders: Record<string, string>,
    ): Promise<T> =>
      await (
        await fetch(`${base}${route}`, { headers: tokenHeaders })
      ).json() as T;
    const aliceTombstones = await listByPrincipal<
      Array<{ reason: string }>
    >('/api/tombstones', aliceHeaders);
    const bobTombstones = await listByPrincipal<
      Array<{ reason: string }>
    >('/api/tombstones', bobHeaders);
    assert.ok(aliceTombstones.every((row) => !row.reason.includes('bob')));
    assert.ok(bobTombstones.every((row) => !row.reason.includes('alice')));
    assert.ok(aliceTombstones.some((row) => row.reason === 'alice deleted'));
    assert.ok(bobTombstones.some((row) => row.reason === 'bob deleted'));

    assert.deepEqual(
      (
        await listByPrincipal<Array<{ id: string }>>(
          '/api/consolidations',
          aliceHeaders,
        )
      ).map((row) => row.id),
      [aliceConsolidationId],
    );
    assert.deepEqual(
      (
        await listByPrincipal<Array<{ id: string }>>(
          '/api/consolidations',
          bobHeaders,
        )
      ).map((row) => row.id),
      [bobConsolidationId],
    );
    assert.ok(
      (
        await listByPrincipal<Array<{ userId: string }>>(
          '/api/purge-jobs',
          aliceHeaders,
        )
      ).every((row) => row.userId === 'alice'),
    );
    assert.ok(
      (
        await listByPrincipal<Array<{ userId: string }>>(
          '/api/purge-jobs',
          bobHeaders,
        )
      ).every((row) => row.userId === 'bob'),
    );

    for (const [tokenHeaders, namespace] of [
      [aliceHeaders, 'alice-policy'],
      [bobHeaders, 'bob-policy'],
    ] as const) {
      const response = await fetch(
        `${base}/api/retention-policies`,
        {
          method: 'PUT',
          headers: tokenHeaders,
          body: JSON.stringify({ namespace, halfLifeDays: 30 }),
        },
      );
      assert.equal(response.status, 200);
    }
    assert.deepEqual(
      (
        await listByPrincipal<Array<{
          userId: string;
          namespace: string;
        }>>('/api/retention-policies', aliceHeaders)
      ).map((row) => [row.userId, row.namespace]),
      [['alice', 'alice-policy']],
    );
    assert.deepEqual(
      (
        await listByPrincipal<Array<{
          userId: string;
          namespace: string;
        }>>('/api/retention-policies', bobHeaders)
      ).map((row) => [row.userId, row.namespace]),
      [['bob', 'bob-policy']],
    );

    const aliceRecalls = await listByPrincipal<Array<{
      query?: string;
      queryHash: string;
    }>>('/api/recalls', aliceHeaders);
    const bobRecalls = await listByPrincipal<Array<{
      query?: string;
      queryHash: string;
    }>>('/api/recalls', bobHeaders);
    assert.equal(aliceRecalls.length, 1);
    assert.equal(bobRecalls.length, 1);
    assert.equal(aliceRecalls[0].query, undefined);
    assert.equal(bobRecalls[0].query, undefined);
    assert.match(aliceRecalls[0].queryHash, /^[0-9a-f]{64}$/u);
    assert.match(bobRecalls[0].queryHash, /^[0-9a-f]{64}$/u);
    assert.notEqual(aliceRecalls[0].queryHash, bobRecalls[0].queryHash);

    assert.equal(
      (
        await fetch(
          `${base}/api/memories/${aliceDeleted.id}/restore`,
          {
            method: 'POST',
            headers: aliceHeaders,
            body: '{}',
          },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/memories/${aliceMemory.id}/pin`,
          {
            method: 'POST',
            headers: aliceHeaders,
            body: JSON.stringify({ pinned: true }),
          },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/api/feedback`, {
          method: 'POST',
          headers: aliceHeaders,
          body: JSON.stringify({
            memoryId: aliceMemory.id,
            feedback: 'confirmed',
          }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/candidates/${aliceCandidate.id}/accept`,
          {
            method: 'POST',
            headers: aliceHeaders,
            body: '{}',
          },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `${base}/api/action-requests/${aliceActionId}/reject`,
          {
            method: 'POST',
            headers: aliceHeaders,
            body: '{}',
          },
        )
      ).status,
      200,
    );

    const aliceBackup = await (
      await fetch(`${base}/api/export`, {
        headers: aliceHeaders,
      })
    ).json() as ReturnType<MemoryStore['exportAll']>;
    const bobBackup = await (
      await fetch(`${base}/api/export`, {
        headers: bobHeaders,
      })
    ).json() as ReturnType<MemoryStore['exportAll']>;
    assert.equal(aliceBackup.userId, 'alice');
    assert.equal(bobBackup.userId, 'bob');
    assert.ok(
      aliceBackup.memories.every((memory) => memory.userId === 'alice'),
    );
    assert.ok(
      bobBackup.memories.every((memory) => memory.userId === 'bob'),
    );

    const sentinel = store.remember({
      userId: 'alice',
      kind: 'knowledge',
      content: '失败导入后必须仍存在，成功导入后必须被备份替换。',
    }).memory;
    const bobIdsBeforeImport = store
      .exportAll('bob')
      .memories.map((memory) => memory.id)
      .sort();
    const crossImport = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: aliceHeaders,
      body: JSON.stringify(bobBackup),
    });
    assert.equal(crossImport.status, 400);
    assert.equal(store.get(sentinel.id, true, 'alice')?.id, sentinel.id);

    const mixedBackup = structuredClone(aliceBackup);
    assert.ok(mixedBackup.state?.jobs[0]);
    mixedBackup.state.jobs[0].user_id = 'bob';
    const mixedImport = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: aliceHeaders,
      body: JSON.stringify(mixedBackup),
    });
    assert.equal(mixedImport.status, 400);
    assert.equal(store.get(sentinel.id, true, 'alice')?.id, sentinel.id);

    const ownImport = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: aliceHeaders,
      body: JSON.stringify(aliceBackup),
    });
    const ownImportPayload = await ownImport.json() as {
      error?: string;
    };
    assert.equal(
      ownImport.status,
      200,
      JSON.stringify(ownImportPayload),
    );
    assert.equal(store.get(sentinel.id, true, 'alice'), null);
    assert.ok(
      store
        .exportAll('alice')
        .memories.every((memory) => memory.userId === 'alice'),
    );
    assert.deepEqual(
      store
        .exportAll('bob')
        .memories.map((memory) => memory.id)
        .sort(),
      bobIdsBeforeImport,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
