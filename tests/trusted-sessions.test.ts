import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { IdentityService } from '../src/server/identity.js';
import { MemoryStore } from '../src/server/memory-store.js';
import {
  SessionScopeGrants,
  TrustedSessionService,
} from '../src/server/trusted-sessions.js';

interface TestHarness {
  base: string;
  close: () => Promise<void>;
  grantsFile: string;
  aliceToken: string;
  bobToken: string;
  database: ReturnType<typeof openDatabase>;
}

async function startHarness(
  grants: Record<string, { scopes: string[]; maxActiveSessions?: number }> | null,
): Promise<TestHarness> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-trusted-sessions-'),
  );
  const grantsFile = path.join(directory, 'session-scope-grants.json');
  if (grants) {
    fs.writeFileSync(
      grantsFile,
      JSON.stringify({ principals: grants }),
    );
  }
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const identity = new IdentityService(database);
  identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
  identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
  const aliceToken = identity.issueCredential({
    principalId: 'alice',
    label: 'alice test',
  }).token;
  const bobToken = identity.issueCredential({
    principalId: 'bob',
    label: 'bob test',
  }).token;
  const trustedSessions = new TrustedSessionService(
    database,
    new SessionScopeGrants(grants ? grantsFile : path.join(directory, 'missing.json')),
  );
  const server = createHttpServer(store, {
    identityService: identity,
    trustedSessions,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    base: `http://127.0.0.1:${address.port}`,
    grantsFile,
    aliceToken,
    bobToken,
    database,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          database.close();
          fs.rmSync(directory, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function issueSession(
  harness: TestHarness,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.base}/api/sessions`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function recall(
  harness: TestHarness,
  token: string,
  query: string,
  sessionId?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.base}/api/recall`, {
    method: 'POST',
    headers: {
      ...headers(token),
      ...(sessionId
        ? { 'x-memory-session-id': sessionId }
        : {}),
    },
    body: JSON.stringify({ query, limit: 8 }),
  });
  return { status: response.status, json: await response.json() };
}

async function writeMemory(
  harness: TestHarness,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${harness.base}/api/memories`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test('部门互不可见：签发→写入→召回全链路', async () => {
  const harness = await startHarness({
    alice: { scopes: ['project:dept-finance', 'project:shared'] },
    bob: { scopes: ['project:dept-hr'] },
  });
  try {
    const { base } = harness;

    // ── 未授权 scope 签发拒绝（逐项校验）─────────────────
    const ungranted = await issueSession(harness, harness.aliceToken, {
      scopes: [{ scopeType: 'project', scopeKey: 'dept-hr' }],
    });
    assert.equal(ungranted.status, 403);

    const illegalType = await issueSession(harness, harness.aliceToken, {
      scopes: [{ scopeType: 'session', scopeKey: 'whatever' }],
    });
    assert.equal(illegalType.status, 403);

    // ── 各自签发本部门会话 ───────────────────────────────
    const aliceSession = await issueSession(harness, harness.aliceToken, {
      scopes: [{ scopeType: 'project', scopeKey: 'dept-finance' }],
      ttlSeconds: 3_600,
    });
    assert.equal(aliceSession.status, 201);
    const aliceSessionId = aliceSession.json.sessionId as string;
    assert.ok(aliceSessionId);
    assert.equal((aliceSession.json.revokedAt as string | null), null);

    const bobSession = await issueSession(harness, harness.bobToken, {
      scopes: [{ scopeType: 'project', scopeKey: 'dept-hr' }],
    });
    assert.equal(bobSession.status, 201);

    // ── 写读同源：alice 不能写 HR 部门 scope ─────────────
    const financeDoc = await writeMemory(harness, harness.aliceToken, {
      kind: 'document_chunk',
      content:
        '财务部差旅报销标准：省内出差每人每天补贴四百元，需在返回后五个工作日内提交单据。',
      scopeType: 'project',
      scopeKey: 'dept-finance',
      sourceRef: 'finance-doc-1',
    });
    assert.equal(financeDoc.status, 201);

    const crossWrite = await writeMemory(harness, harness.aliceToken, {
      kind: 'document_chunk',
      content: '人力资源部考勤规定：迟到三次视为旷工半天。',
      scopeType: 'project',
      scopeKey: 'dept-hr',
    });
    assert.equal(crossWrite.status, 403);

    const hrDoc = await writeMemory(harness, harness.bobToken, {
      kind: 'document_chunk',
      content:
        '人力资源部年假规定：入职满一年享有五天带薪年假，需提前三个工作日申请。',
      scopeType: 'project',
      scopeKey: 'dept-hr',
      sourceRef: 'hr-doc-1',
    });
    assert.equal(hrDoc.status, 201);

    // ── 列侧同源：alice 不能按 HR scope 过滤列表 ─────────
    const listGate = await fetch(
      `${base}/api/memories?scopeType=project&scopeKey=dept-hr`,
      { headers: headers(harness.aliceToken) },
    );
    assert.equal(listGate.status, 403);

    // ── 召回隔离：alice 会话只见财务，bob 会话只见 HR ────
    const financeRecall = await recall(
      harness,
      harness.aliceToken,
      '差旅报销 每天补贴多少钱',
      aliceSessionId,
    );
    assert.equal(financeRecall.status, 200);
    const financeItems = (financeRecall.json.memories as Array<{
      memory: { scopeType: string; scopeKey: string; sourceRef?: string };
    }>).map((item) => item.memory);
    assert.ok(
      financeItems.some((m) => m.sourceRef === 'finance-doc-1'),
      '财务会话应召回到财务文档',
    );
    assert.ok(
      financeItems.every((m) => m.scopeKey !== 'dept-hr'),
      '财务会话不得召回 HR 文档',
    );

    const hrRecall = await recall(
      harness,
      harness.bobToken,
      '年假 有几天 提前申请',
      (bobSession.json.sessionId as string),
    );
    assert.equal(hrRecall.status, 200);
    const hrItems = (hrRecall.json.memories as Array<{
      memory: { scopeType: string; scopeKey: string; sourceRef?: string };
    }>).map((item) => item.memory);
    assert.ok(
      hrItems.some((m) => m.sourceRef === 'hr-doc-1'),
      'HR 会话应召回到 HR 文档',
    );
    assert.ok(
      hrItems.every((m) => m.scopeKey !== 'dept-finance'),
      'HR 会话不得召回财务文档',
    );

    // ── 无会话 = personal/self（默认收窄，零放大）────────
    const noSessionRecall = await recall(
      harness,
      harness.aliceToken,
      '差旅报销 每天补贴',
    );
    assert.equal(noSessionRecall.status, 200);
    const noSessionItems = (noSessionRecall.json.memories as Array<{
      memory: { scopeType: string; scopeKey: string };
    }>).map((item) => item.memory);
    assert.ok(
      noSessionItems.every(
        (m) => !(m.scopeType === 'project'),
      ),
      '无会话召回不得包含部门 scope 文档',
    );

    // ── 主体不符：bob 用 alice 的会话 → 401 ─────────────
    const foreign = await recall(
      harness,
      harness.bobToken,
      '差旅报销',
      aliceSessionId,
    );
    assert.equal(foreign.status, 401);

    // ── 吊销后召回 → 401（显式失败关闭）─────────────────
    const revoke = await fetch(
      `${base}/api/sessions/${aliceSessionId}`,
      { method: 'DELETE', headers: headers(harness.aliceToken) },
    );
    assert.equal(revoke.status, 200);
    const revokedRecall = await recall(
      harness,
      harness.aliceToken,
      '差旅报销',
      aliceSessionId,
    );
    assert.equal(revokedRecall.status, 401);

    // ── 过期会话 → 401 ──────────────────────────────────
    const bobSessionId = bobSession.json.sessionId as string;
    harness.database.prepare(`
      UPDATE trusted_sessions SET expires_at = ? WHERE session_id = ?
    `).run(
      new Date(Date.now() - 1_000).toISOString(),
      bobSessionId,
    );
    const expiredRecall = await recall(
      harness,
      harness.bobToken,
      '年假',
      bobSessionId,
    );
    assert.equal(expiredRecall.status, 401);
  } finally {
    await harness.close();
  }
});

test('失败关闭：未配置授权矩阵时签发 403，写闸不生效（零回归）', async () => {
  const harness = await startHarness(null);
  try {
    const denied = await issueSession(harness, harness.aliceToken, {
      scopes: [{ scopeType: 'project', scopeKey: 'dept-finance' }],
    });
    assert.equal(denied.status, 403);

    // 矩阵未配置 → 原有写入行为不变（任意 scope 可写）
    const legacyWrite = await writeMemory(harness, harness.aliceToken, {
      kind: 'profile',
      content: '矩阵未配置时保持原有写入行为。',
      scopeType: 'project',
      scopeKey: 'anywhere',
    });
    assert.equal(legacyWrite.status, 201);
  } finally {
    await harness.close();
  }
});

test('并发上限：maxActiveSessions=1 时第二次签发 429', async () => {
  const harness = await startHarness({
    alice: {
      scopes: ['project:dept-finance'],
      maxActiveSessions: 1,
    },
  });
  try {
    const first = await issueSession(harness, harness.aliceToken, {
      scopes: [{ scopeType: 'project', scopeKey: 'dept-finance' }],
    });
    assert.equal(first.status, 201);
    const second = await issueSession(harness, harness.aliceToken, {
      scopes: [{ scopeType: 'project', scopeKey: 'dept-finance' }],
    });
    assert.equal(second.status, 429);
  } finally {
    await harness.close();
  }
});

test('会话管理：GET 只能看到自己的会话，他人 404', async () => {
  const harness = await startHarness({
    alice: { scopes: ['project:dept-finance'] },
    bob: { scopes: ['project:dept-hr'] },
  });
  try {
    const session = await issueSession(harness, harness.aliceToken, {
      scopes: [{ scopeType: 'project', scopeKey: 'dept-finance' }],
    });
    const sessionId = session.json.sessionId as string;
    const owner = await fetch(
      `${harness.base}/api/sessions/${sessionId}`,
      { headers: headers(harness.aliceToken) },
    );
    assert.equal(owner.status, 200);
    const stranger = await fetch(
      `${harness.base}/api/sessions/${sessionId}`,
      { headers: headers(harness.bobToken) },
    );
    assert.equal(stranger.status, 404);
  } finally {
    await harness.close();
  }
});
