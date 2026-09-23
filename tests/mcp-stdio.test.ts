import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../src/server/database.js';
import { HybridRetrievalIndex } from '../src/server/hybrid-retrieval.js';
import { IdentityService } from '../src/server/identity.js';
import { createMcpServer } from '../src/server/mcp-server.js';
import { MemoryStore } from '../src/server/memory-store.js';

interface McpClientBinding {
  namespace?: string;
  personaId?: string;
  projectId?: string;
  sessionId?: string;
}

function createClient(
  directory: string,
  userId?: string,
  mcpToken?: string,
  binding: McpClientBinding = {},
): {
  client: Client;
  transport: StdioClientTransport;
  stderrText: () => string;
} {
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    MEMORY_BRIDGE_DATA_DIR: directory,
    MEMORY_BRIDGE_SEMANTIC_MODE: 'off',
  };
  if (userId !== undefined) {
    env.MEMORY_BRIDGE_USER_ID = userId;
  }
  if (mcpToken !== undefined) {
    env.MEMORY_BRIDGE_MCP_TOKEN = mcpToken;
  }
  if (binding.namespace !== undefined) {
    env.MEMORY_BRIDGE_NAMESPACE = binding.namespace;
  }
  if (binding.personaId !== undefined) {
    env.MEMORY_BRIDGE_MCP_PERSONA_ID = binding.personaId;
  }
  if (binding.projectId !== undefined) {
    env.MEMORY_BRIDGE_MCP_PROJECT_ID = binding.projectId;
  }
  if (binding.sessionId !== undefined) {
    env.MEMORY_BRIDGE_MCP_SESSION_ID = binding.sessionId;
  }
  const client = new Client({
    name: `memory-bridge-test-${userId || 'credential'}`,
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/server/mcp-stdio.js'],
    cwd: process.cwd(),
    env,
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return {
    client,
    transport,
    stderrText: () => stderr.join(''),
  };
}

async function clientListTools(client: Client) {
  const result = await client.listTools();
  return result.tools.map((tool) => ({
    serverName: 'memory-bridge',
    name: `memory-bridge::${tool.name}`,
    toolName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

async function clientCallTool(
  client: Client,
  name: string,
  argumentsJson: string,
) {
  const separator = name.indexOf('::');
  assert.ok(separator > 0, '客户端子工具名必须包含 serverName::toolName');
  assert.equal(name.slice(0, separator), 'memory-bridge');
  return client.callTool({
    name: name.slice(separator + 2),
    arguments: JSON.parse(argumentsJson) as Record<string, unknown>,
  });
}

function textResult(result: Awaited<ReturnType<Client['callTool']>>): string {
  const item = result.content.find((content) => content.type === 'text');
  assert.ok(item && item.type === 'text');
  return item.text;
}

function jsonTextResult<T>(
  result: Awaited<ReturnType<Client['callTool']>>,
): T {
  return JSON.parse(textResult(result)) as T;
}

test('旧 createMcpServer(store, principal) 兼容形式安全默认 personal/self', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-legacy-constructor-'),
  );
  const database = openDatabase(
    path.join(directory, 'memory-bridge.sqlite3'),
  );
  const server = createMcpServer(
    new MemoryStore(database),
    'legacy-constructor-user',
  );
  const client = new Client({
    name: 'memory-bridge-legacy-constructor-test',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const remembered = await client.callTool({
      name: 'memory_remember',
      arguments: {
        kind: 'preference',
        content: '旧构造方式默认写入个人作用域。',
      },
    });
    const value = jsonTextResult<{
      memory: {
        userId: string;
        scopeType: string;
        scopeKey: string;
      };
    }>(remembered);
    assert.equal(value.memory.userId, 'legacy-constructor-user');
    assert.equal(value.memory.scopeType, 'personal');
    assert.equal(value.memory.scopeKey, 'self');

    const unbound = await client.callTool({
      name: 'memory_remember',
      arguments: {
        kind: 'preference',
        content: '旧构造方式不得写入角色作用域。',
        scope: 'role',
      },
    });
    assert.equal(unbound.isError, true);
    assert.match(textResult(unbound), /role 作用域未绑定/u);
  } finally {
    await Promise.allSettled([
      client.close(),
      server.close(),
    ]);
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP stdio 缺少显式启动身份时拒绝连接', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-no-principal-'),
  );
  const connection = createClient(directory);

  try {
    await assert.rejects(
      connection.client.connect(connection.transport),
    );
    assert.match(
      connection.stderrText(),
      /MEMORY_BRIDGE_USER_ID 或 MEMORY_BRIDGE_MCP_TOKEN/u,
    );
  } finally {
    await Promise.allSettled([
      connection.client.close(),
      connection.transport.close(),
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP stdio 无效凭据拒绝启动且错误和日志不回显 Token', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-invalid-token-'),
  );
  const token = 'invalid-mcp-token-never-log-this-value';
  const connection = createClient(directory, undefined, token);
  let connectionError = '';

  try {
    await assert.rejects(
      connection.client.connect(connection.transport),
      (error: unknown) => {
        connectionError = String(error);
        return true;
      },
    );
    assert.equal(connectionError.includes(token), false);
    assert.equal(connection.stderrText().includes(token), false);
    assert.match(connection.stderrText(), /身份凭据无效/u);
  } finally {
    await Promise.allSettled([
      connection.client.close(),
      connection.transport.close(),
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('真实 MCP stdio 客户端可以列出、写入并召回记忆', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-'),
  );
  const { client, transport } = createClient(directory, 'test-user');

  try {
    await client.connect(transport);
    const tools = await clientListTools(client);
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes('memory-bridge::memory_remember'));
    assert.ok(names.includes('memory-bridge::memory_get_context'));
    assert.ok(names.includes('memory-bridge::memory_forget'));
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      assert.doesNotMatch(schema, /userId|principalId/);
      assert.equal(
        (tool.inputSchema as { additionalProperties?: unknown })
          .additionalProperties,
        false,
      );
    }
    for (const name of [
      'memory-bridge::memory_recall',
      'memory-bridge::memory_get_context',
    ]) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool);
      const recentTurns = (
        tool.inputSchema as {
          properties?: Record<string, {
            maxItems?: number;
            items?: { additionalProperties?: unknown };
          }>;
        }
      ).properties?.recentTurns;
      assert.equal(recentTurns?.maxItems, 12);
      assert.equal(recentTurns?.items?.additionalProperties, false);
    }

    const absentId = '00000000-0000-4000-8000-000000000000';
    const forgedCalls: Array<[
      string,
      Record<string, unknown>,
    ]> = [
      ['memory-bridge::memory_remember', {
        kind: 'knowledge',
        content: '不得写入的伪造身份测试。',
      }],
      ['memory-bridge::memory_recall', { query: '伪造身份' }],
      ['memory-bridge::memory_get_context', { query: '伪造身份' }],
      ['memory-bridge::memory_update', {
        id: absentId,
        content: '不得更新的伪造身份测试。',
      }],
      ['memory-bridge::memory_forget', { id: absentId }],
      ['memory-bridge::memory_list', {}],
      ['memory-bridge::memory_stats', {}],
    ];
    for (const field of ['userId', 'principalId']) {
      for (const [toolName, input] of forgedCalls) {
        const forgedIdentity = await clientCallTool(
          client,
          toolName,
          JSON.stringify({ ...input, [field]: 'another-user' }),
        );
        assert.equal(forgedIdentity.isError, true);
        assert.match(textResult(forgedIdentity), /Unrecognized key/);
      }
    }

    const created = await clientCallTool(
      client,
      'memory-bridge::memory_remember',
      JSON.stringify({
        kind: 'preference',
        content: '用户希望所有项目首次打开时保持空数据。',
        importance: 0.9,
      }),
    );
    assert.equal(created.isError, undefined);

    const recalled = await clientCallTool(
      client,
      'memory-bridge::memory_get_context',
      JSON.stringify({
        query: '项目初始数据应该是什么状态？',
      }),
    );
    assert.equal(recalled.isError, undefined);
    assert.match(textResult(recalled), /空数据/);
  } finally {
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('真实 MCP 空召回保持数组文本并通过元数据直接返回 traceId', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-empty-trace-'),
  );
  const { client, transport } = createClient(directory, 'trace-user');

  try {
    await client.connect(transport);
    const requestKey = 'empty-recall-correlation-key';
    const recalled = await clientCallTool(
      client,
      'memory-bridge::memory_recall',
      JSON.stringify({
        query: '完全不存在的记忆',
        _memoryRequestKey: requestKey,
      }),
    );

    assert.equal(textResult(recalled), '[]');
    const traceId = recalled._meta?.retrievalTraceId;
    assert.match(String(traceId), /^[0-9a-f-]{36}$/u);
    assert.match(
      String(recalled._meta?.qualityState),
      /^(?:full|degraded|unavailable)$/u,
    );
    assert.equal(
      recalled.structuredContent?.retrievalTraceId,
      traceId,
    );
    assert.equal(
      recalled.structuredContent?.qualityState,
      recalled._meta?.qualityState,
    );
    assert.equal(
      recalled.structuredContent?.errorCode,
      recalled._meta?.errorCode,
    );

    const database = new DatabaseSync(
      path.join(directory, 'memory-bridge.sqlite3'),
      { readOnly: true },
    );
    try {
      const row = database.prepare(
        `SELECT request_json AS requestJson,
                quality_state AS qualityState,
                error_code AS errorCode
         FROM retrieval_traces
         WHERE trace_id = ? AND user_id = ?`,
      ).get(traceId as string, 'trace-user') as {
        requestJson: string;
        qualityState: string;
        errorCode: string | null;
      };
      const request = JSON.parse(row.requestJson) as {
        correlationIdHash?: string;
      };
      assert.match(request.correlationIdHash || '', /^[0-9a-f]{64}$/u);
      assert.doesNotMatch(row.requestJson, new RegExp(requestKey, 'u'));
      assert.equal(recalled._meta?.qualityState, row.qualityState);
      assert.equal(recalled._meta?.errorCode, row.errorCode);
    } finally {
      database.close();
    }
  } finally {
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('真实 MCP 用 AIRI 请求键把同一个模型工具调用合并为一次执行', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-dedup-'),
  );
  const { client, transport } = createClient(
    directory,
    'dedup-user',
  );

  try {
    await client.connect(transport);
    const rememberArguments = JSON.stringify({
      kind: 'project',
      content: 'AIRI 重复执行保护代号是单桥。',
      _memoryRequestKey: 'same-model-call-remember',
    });
    const rememberResults = await Promise.all(
      Array.from({ length: 4 }, () =>
        clientCallTool(
          client,
          'memory-bridge::memory_remember',
          rememberArguments,
        ),
      ),
    );
    assert.equal(
      new Set(rememberResults.map(textResult)).size,
      1,
    );

    const recallArguments = JSON.stringify({
      query: 'AIRI 重复执行保护代号是什么？',
      _memoryRequestKey: 'same-model-call-recall',
    });
    const recallResults = await Promise.all(
      Array.from({ length: 4 }, () =>
        clientCallTool(
          client,
          'memory-bridge::memory_get_context',
          recallArguments,
        ),
      ),
    );
    assert.equal(new Set(recallResults.map(textResult)).size, 1);
    assert.match(textResult(recallResults[0]), /单桥/);

    const database = new DatabaseSync(
      path.join(directory, 'memory-bridge.sqlite3'),
      { readOnly: true },
    );
    try {
      const memory = database
        .prepare(
          `SELECT access_count AS accessCount
           FROM memories
           WHERE user_id = ?`,
        )
        .get('dedup-user') as { accessCount: number };
      assert.equal(memory.accessCount, 1);

      const actionCount = (action: string): number => {
        const row = database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM audit_log
             WHERE user_id = ? AND action = ?`,
          )
          .get('dedup-user', action) as { count: number };
        return row.count;
      };
      assert.equal(actionCount('remember'), 1);
      assert.equal(actionCount('deduplicate'), 0);
      assert.equal(actionCount('recall'), 1);
    } finally {
      database.close();
    }
  } finally {
    await client.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('两个真实 MCP Token 进程共享数据库时保持 principal 隔离并能跨进程重启召回', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-shared-mcp-'),
  );
  const credentialDatabase = openDatabase(
    path.join(directory, 'memory-bridge.sqlite3'),
  );
  let aliceToken = '';
  let bobToken = '';
  try {
    const identity = new IdentityService(credentialDatabase);
    identity.createPrincipal({ id: 'alice', displayName: 'Alice' });
    identity.createPrincipal({ id: 'bob', displayName: 'Bob' });
    aliceToken = identity.issueCredential({
      principalId: 'alice',
      label: 'Alice MCP acceptance',
    }).token;
    bobToken = identity.issueCredential({
      principalId: 'bob',
      label: 'Bob MCP acceptance',
    }).token;
  } finally {
    credentialDatabase.close();
  }

  // The deliberately conflicting startup user proves that the credential,
  // not a fallback process default, fixes the connection principal.
  const namespace = 'same-namespace';
  const alice = createClient(
    directory,
    'default',
    aliceToken,
    { namespace },
  );
  const bob = createClient(
    directory,
    'default',
    bobToken,
    { namespace },
  );
  let restartedAlice: ReturnType<typeof createClient> | null = null;

  try {
    await Promise.all([
      alice.client.connect(alice.transport),
      bob.client.connect(bob.transport),
    ]);
    const collisionContent =
      '两个账户故意保存完全相同的 MCP 隔离验收正文。';
    const aliceCreated = await clientCallTool(
      alice.client,
      'memory-bridge::memory_remember',
      JSON.stringify({
        kind: 'instruction',
        title: 'ALICEONLY7391',
        content: collisionContent,
        namespace,
        idempotencyKey: 'shared-key',
      }),
    );
    const bobCreated = await clientCallTool(
      bob.client,
      'memory-bridge::memory_remember',
      JSON.stringify({
        kind: 'instruction',
        title: 'BOBONLY2846',
        content: collisionContent,
        namespace,
        idempotencyKey: 'shared-key',
      }),
    );
    const aliceValue = jsonTextResult<{
      memory: {
        id: string;
        userId: string;
        namespace: string;
        title: string;
        content: string;
      };
    }>(aliceCreated);
    const bobValue = jsonTextResult<typeof aliceValue>(bobCreated);
    assert.notEqual(aliceValue.memory.id, bobValue.memory.id);
    assert.equal(aliceValue.memory.userId, 'alice');
    assert.equal(bobValue.memory.userId, 'bob');
    assert.equal(aliceValue.memory.namespace, namespace);
    assert.equal(bobValue.memory.namespace, namespace);
    assert.equal(aliceValue.memory.content, collisionContent);
    assert.equal(bobValue.memory.content, collisionContent);

    const aliceRepeated = await clientCallTool(
      alice.client,
      'memory-bridge::memory_remember',
      JSON.stringify({
        kind: 'instruction',
        title: 'ALICEONLY7391',
        content: collisionContent,
        namespace,
        idempotencyKey: 'shared-key',
      }),
    );
    const bobRepeated = await clientCallTool(
      bob.client,
      'memory-bridge::memory_remember',
      JSON.stringify({
        kind: 'instruction',
        title: 'BOBONLY2846',
        content: collisionContent,
        namespace,
        idempotencyKey: 'shared-key',
      }),
    );
    assert.equal(
      jsonTextResult<typeof aliceValue>(aliceRepeated).memory.id,
      aliceValue.memory.id,
    );
    assert.equal(
      jsonTextResult<typeof bobValue>(bobRepeated).memory.id,
      bobValue.memory.id,
    );

    const [
      aliceRecall,
      bobRecall,
      aliceList,
      bobList,
      aliceStats,
      bobStats,
    ] =
      await Promise.all([
        clientCallTool(
          alice.client,
          'memory-bridge::memory_recall',
          JSON.stringify({ query: collisionContent, namespace }),
        ),
        clientCallTool(
          bob.client,
          'memory-bridge::memory_recall',
          JSON.stringify({ query: collisionContent, namespace }),
        ),
        clientCallTool(
          alice.client,
          'memory-bridge::memory_list',
          JSON.stringify({ namespace }),
        ),
        clientCallTool(
          bob.client,
          'memory-bridge::memory_list',
          JSON.stringify({ namespace }),
        ),
        clientCallTool(
          alice.client,
          'memory-bridge::memory_stats',
          JSON.stringify({}),
        ),
        clientCallTool(
          bob.client,
          'memory-bridge::memory_stats',
          JSON.stringify({}),
        ),
      ]);
    type RecalledMemory = Array<{
      memory: {
        id: string;
        userId: string;
        title: string;
        content: string;
      };
    }>;
    const aliceRecallValue = jsonTextResult<RecalledMemory>(aliceRecall);
    const bobRecallValue = jsonTextResult<RecalledMemory>(bobRecall);
    assert.deepEqual(
      aliceRecallValue.map((item) => item.memory.id),
      [aliceValue.memory.id],
    );
    assert.deepEqual(
      bobRecallValue.map((item) => item.memory.id),
      [bobValue.memory.id],
    );
    assert.ok(
      aliceRecallValue.every(
        (item) => item.memory.userId === 'alice',
      ),
    );
    assert.ok(
      bobRecallValue.every((item) => item.memory.userId === 'bob'),
    );
    assert.equal(aliceRecallValue[0].memory.title, 'ALICEONLY7391');
    assert.equal(bobRecallValue[0].memory.title, 'BOBONLY2846');

    type ListedMemories = {
      items: Array<{
        id: string;
        userId: string;
        title: string;
        content: string;
        status: string;
      }>;
      total: number;
    };
    const aliceListValue = jsonTextResult<ListedMemories>(aliceList);
    const bobListValue = jsonTextResult<ListedMemories>(bobList);
    assert.equal(aliceListValue.total, 1);
    assert.equal(bobListValue.total, 1);
    assert.deepEqual(
      aliceListValue.items.map((item) => item.id),
      [aliceValue.memory.id],
    );
    assert.deepEqual(
      bobListValue.items.map((item) => item.id),
      [bobValue.memory.id],
    );
    assert.ok(
      aliceListValue.items.every((item) => item.userId === 'alice'),
    );
    assert.ok(
      bobListValue.items.every((item) => item.userId === 'bob'),
    );
    assert.equal(aliceListValue.items[0].title, 'ALICEONLY7391');
    assert.equal(bobListValue.items[0].title, 'BOBONLY2846');

    const aliceStatsValue = jsonTextResult<{
      total: number;
      userId: string;
    }>(aliceStats);
    const bobStatsValue = jsonTextResult<{
      total: number;
      userId: string;
    }>(bobStats);
    assert.equal(aliceStatsValue.total, 1);
    assert.equal(aliceStatsValue.userId, 'alice');
    assert.equal(bobStatsValue.total, 1);
    assert.equal(bobStatsValue.userId, 'bob');

    const absentId = '00000000-0000-4000-8000-000000000000';
    const [
      aliceCrossUpdate,
      aliceAbsentUpdate,
      bobCrossUpdate,
      bobAbsentUpdate,
      aliceCrossForget,
      aliceAbsentForget,
      bobCrossForget,
      bobAbsentForget,
    ] =
      await Promise.all([
        clientCallTool(
          alice.client,
          'memory-bridge::memory_update',
          JSON.stringify({
            id: bobValue.memory.id,
            content: 'Alice 不得改写 Bob 的记忆。',
          }),
        ),
        clientCallTool(
          alice.client,
          'memory-bridge::memory_update',
          JSON.stringify({
            id: absentId,
            content: '不存在的记忆。',
          }),
        ),
        clientCallTool(
          bob.client,
          'memory-bridge::memory_update',
          JSON.stringify({
            id: aliceValue.memory.id,
            content: 'Bob 不得改写 Alice 的记忆。',
          }),
        ),
        clientCallTool(
          bob.client,
          'memory-bridge::memory_update',
          JSON.stringify({
            id: absentId,
            content: '不存在的记忆。',
          }),
        ),
        clientCallTool(
          alice.client,
          'memory-bridge::memory_forget',
          JSON.stringify({ id: bobValue.memory.id }),
        ),
        clientCallTool(
          alice.client,
          'memory-bridge::memory_forget',
          JSON.stringify({ id: absentId }),
        ),
        clientCallTool(
          bob.client,
          'memory-bridge::memory_forget',
          JSON.stringify({ id: aliceValue.memory.id }),
        ),
        clientCallTool(
          bob.client,
          'memory-bridge::memory_forget',
          JSON.stringify({ id: absentId }),
        ),
      ]);
    for (const result of [
      aliceCrossUpdate,
      aliceAbsentUpdate,
      bobCrossUpdate,
      bobAbsentUpdate,
      aliceCrossForget,
      aliceAbsentForget,
      bobCrossForget,
      bobAbsentForget,
    ]) {
      assert.equal(result.isError, true);
    }
    assert.equal(
      textResult(aliceCrossUpdate),
      textResult(aliceAbsentUpdate),
    );
    assert.equal(
      textResult(bobCrossUpdate),
      textResult(bobAbsentUpdate),
    );
    assert.equal(
      textResult(aliceCrossForget),
      textResult(aliceAbsentForget),
    );
    assert.equal(
      textResult(bobCrossForget),
      textResult(bobAbsentForget),
    );

    const [aliceAfterCrossAccountAttempts, bobAfterCrossAccountAttempts] =
      await Promise.all([
        clientCallTool(
          alice.client,
          'memory-bridge::memory_list',
          JSON.stringify({ namespace }),
        ),
        clientCallTool(
          bob.client,
          'memory-bridge::memory_list',
          JSON.stringify({ namespace }),
        ),
      ]);
    const aliceAfterValue = jsonTextResult<ListedMemories>(
      aliceAfterCrossAccountAttempts,
    );
    const bobAfterValue = jsonTextResult<ListedMemories>(
      bobAfterCrossAccountAttempts,
    );
    assert.equal(aliceAfterValue.total, 1);
    assert.equal(bobAfterValue.total, 1);
    assert.equal(aliceAfterValue.items[0].id, aliceValue.memory.id);
    assert.equal(bobAfterValue.items[0].id, bobValue.memory.id);
    assert.equal(aliceAfterValue.items[0].status, 'active');
    assert.equal(bobAfterValue.items[0].status, 'active');

    const [bobCannotRecallAlice, aliceCannotRecallBob] =
      await Promise.all([
        clientCallTool(
          bob.client,
          'memory-bridge::memory_get_context',
          JSON.stringify({ query: 'ALICEONLY7391', namespace }),
        ),
        clientCallTool(
          alice.client,
          'memory-bridge::memory_get_context',
          JSON.stringify({ query: 'BOBONLY2846', namespace }),
        ),
      ]);
    const bobContext = JSON.parse(textResult(bobCannotRecallAlice)) as {
      memories: unknown[];
      context: string;
    };
    const aliceContext = JSON.parse(textResult(aliceCannotRecallBob)) as {
      memories: unknown[];
      context: string;
    };
    assert.deepEqual(bobContext.memories, []);
    assert.deepEqual(aliceContext.memories, []);
    assert.match(bobContext.context, /没有找到足够相关/);
    assert.match(aliceContext.context, /没有找到足够相关/);

    await alice.client.close();
    const restarted = createClient(
      directory,
      'default',
      aliceToken,
      { namespace },
    );
    restartedAlice = restarted;
    await restarted.client.connect(restarted.transport);
    const toolsAfterRestart = await clientListTools(restarted.client);
    assert.ok(
      toolsAfterRestart.some(
        (tool) => tool.name === 'memory-bridge::memory_get_context',
      ),
    );
    const recalledAfterRestart = await clientCallTool(
      restarted.client,
      'memory-bridge::memory_get_context',
      JSON.stringify({ query: collisionContent, namespace }),
    );
    const restartedContext = jsonTextResult<{
      memories: Array<{
        memory: { id: string; userId: string; title: string };
      }>;
      context: string;
    }>(recalledAfterRestart);
    assert.deepEqual(
      restartedContext.memories.map((item) => item.memory.id),
      [aliceValue.memory.id],
    );
    assert.ok(
      restartedContext.memories.every(
        (item) => item.memory.userId === 'alice',
      ),
    );
    assert.equal(
      restartedContext.memories[0].memory.title,
      'ALICEONLY7391',
    );

    assert.equal(alice.stderrText().includes(aliceToken), false);
    assert.equal(bob.stderrText().includes(bobToken), false);
    assert.equal(restarted.stderrText().includes(aliceToken), false);
  } catch (error) {
    const aliceStderr = alice
      .stderrText()
      .replaceAll(aliceToken, '[REDACTED]');
    const bobStderr = bob
      .stderrText()
      .replaceAll(bobToken, '[REDACTED]');
    assert.fail(
      `${String(error)}\nAlice stderr:\n${aliceStderr}\nBob stderr:\n${bobStderr}`,
    );
  } finally {
    await Promise.allSettled([
      alice.client.close(),
      bob.client.close(),
      restartedAlice?.client.close() || Promise.resolve(),
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP stdio 非法作用域身份拒绝启动', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-invalid-scope-id-'),
  );
  const connection = createClient(
    directory,
    'invalid-scope-user',
    undefined,
    {
      personaId: 'persona with spaces',
      sessionId: 'session-valid',
    },
  );

  try {
    await assert.rejects(
      connection.client.connect(connection.transport),
    );
    assert.match(
      connection.stderrText(),
      /MEMORY_BRIDGE_MCP_PERSONA_ID.*合法的稳定身份 ID/u,
    );
  } finally {
    await Promise.allSettled([
      connection.client.close(),
      connection.transport.close(),
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('同一 principal 的 MCP 连接严格绑定 namespace、role、project 和 session', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-bound-scopes-'),
  );
  const principalId = 'scope-user';
  const namespace = 'conversation-memory';
  const otherNamespace = 'other-memory';
  const first = createClient(
    directory,
    principalId,
    undefined,
    {
      namespace,
      personaId: 'persona-alpha',
      projectId: 'project-shared',
      sessionId: 'session-alpha',
    },
  );
  const second = createClient(
    directory,
    principalId,
    undefined,
    {
      namespace,
      personaId: 'persona-beta',
      projectId: 'project-shared',
      sessionId: 'session-beta',
    },
  );
  const other = createClient(
    directory,
    principalId,
    undefined,
    {
      namespace: otherNamespace,
      personaId: 'persona-alpha',
      projectId: 'project-shared',
      sessionId: 'session-alpha',
    },
  );
  const incomplete = createClient(
    directory,
    principalId,
    undefined,
    {
      namespace,
      personaId: 'persona-alpha',
      projectId: 'project-shared',
    },
  );

  type Remembered = {
    memory: {
      id: string;
      namespace: string;
      scopeType: string;
      scopeKey: string;
      content: string;
    };
  };
  type Listed = {
    items: Array<{
      id: string;
      namespace: string;
      scopeType: string;
      scopeKey: string;
      content: string;
      status: string;
    }>;
    total: number;
  };
  const remember = async (
    client: Client,
    content: string,
    scope?: 'personal' | 'project' | 'role' | 'session',
    idempotencyKey?: string,
  ): Promise<Remembered> => jsonTextResult<Remembered>(
    await clientCallTool(
      client,
      'memory-bridge::memory_remember',
      JSON.stringify({
        kind: 'preference',
        content,
        ...(scope ? { scope } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    ),
  );

  try {
    await first.client.connect(first.transport);
    await second.client.connect(second.transport);
    await other.client.connect(other.transport);
    await incomplete.client.connect(incomplete.transport);

    const tools = await clientListTools(first.client);
    const rememberTool = tools.find(
      (tool) => tool.name === 'memory-bridge::memory_remember',
    );
    assert.ok(rememberTool);
    const rememberProperties = (
      rememberTool.inputSchema as {
        properties?: Record<string, unknown>;
      }
    ).properties || {};
    assert.ok('scope' in rememberProperties);
    assert.equal('scopeKey' in rememberProperties, false);

    const personal = await remember(
      first.client,
      'PERSONAL_ONLY_7319 用户喜欢清淡口味。',
    );
    const project = await remember(
      first.client,
      'PROJECT_SHARED_8426 当前项目采用 SQLite。',
      'project',
    );
    const firstRole = await remember(
      first.client,
      'ROLE_ALPHA_1537 与角色甲使用简洁语气。',
      'role',
      'same-role-idempotency-key',
    );
    const firstSession = await remember(
      first.client,
      'SESSION_ALPHA_2648 本会话正在讨论部署。',
      'session',
    );
    const secondRole = await remember(
      second.client,
      'ROLE_BETA_3759 与角色乙使用详细语气。',
      'role',
      'same-role-idempotency-key',
    );
    const secondSession = await remember(
      second.client,
      'SESSION_BETA_4860 本会话正在讨论检索。',
      'session',
    );
    const otherPersonal = await remember(
      other.client,
      'OTHER_NAMESPACE_5971 只属于另一个 namespace。',
    );

    assert.equal(personal.memory.scopeType, 'personal');
    assert.equal(personal.memory.scopeKey, 'self');
    assert.equal(project.memory.scopeType, 'project');
    assert.equal(project.memory.scopeKey, 'project-shared');
    assert.equal(firstRole.memory.scopeKey, 'persona-alpha');
    assert.equal(firstSession.memory.scopeKey, 'session-alpha');
    assert.equal(secondRole.memory.scopeKey, 'persona-beta');
    assert.equal(secondSession.memory.scopeKey, 'session-beta');
    assert.notEqual(firstRole.memory.id, secondRole.memory.id);
    assert.equal(otherPersonal.memory.namespace, otherNamespace);

    const [firstList, secondList, otherList, incompleteList] =
      await Promise.all([
        clientCallTool(
          first.client,
          'memory-bridge::memory_list',
          JSON.stringify({ limit: 20 }),
        ),
        clientCallTool(
          second.client,
          'memory-bridge::memory_list',
          JSON.stringify({ limit: 20 }),
        ),
        clientCallTool(
          other.client,
          'memory-bridge::memory_list',
          JSON.stringify({ limit: 20 }),
        ),
        clientCallTool(
          incomplete.client,
          'memory-bridge::memory_list',
          JSON.stringify({ limit: 20 }),
        ),
      ]);
    const firstValue = jsonTextResult<Listed>(firstList);
    const secondValue = jsonTextResult<Listed>(secondList);
    const otherValue = jsonTextResult<Listed>(otherList);
    const incompleteValue = jsonTextResult<Listed>(incompleteList);
    assert.equal(firstValue.total, 4);
    assert.equal(secondValue.total, 4);
    assert.equal(otherValue.total, 1);
    assert.equal(incompleteValue.total, 1);
    assert.deepEqual(
      new Set(firstValue.items.map((item) => item.id)),
      new Set([
        personal.memory.id,
        project.memory.id,
        firstRole.memory.id,
        firstSession.memory.id,
      ]),
    );
    assert.deepEqual(
      new Set(secondValue.items.map((item) => item.id)),
      new Set([
        personal.memory.id,
        project.memory.id,
        secondRole.memory.id,
        secondSession.memory.id,
      ]),
    );
    assert.deepEqual(
      otherValue.items.map((item) => item.id),
      [otherPersonal.memory.id],
    );
    assert.deepEqual(
      incompleteValue.items.map((item) => item.id),
      [personal.memory.id],
    );

    const [firstStats, secondStats, otherStats, incompleteStats] =
      await Promise.all([
        clientCallTool(first.client, 'memory-bridge::memory_stats', '{}'),
        clientCallTool(second.client, 'memory-bridge::memory_stats', '{}'),
        clientCallTool(other.client, 'memory-bridge::memory_stats', '{}'),
        clientCallTool(incomplete.client, 'memory-bridge::memory_stats', '{}'),
      ]);
    for (const [result, expectedTotal, expectedNamespace] of [
      [firstStats, 4, namespace],
      [secondStats, 4, namespace],
      [otherStats, 1, otherNamespace],
      [incompleteStats, 1, namespace],
    ] as const) {
      const value = jsonTextResult<{
        total: number;
        active: number;
        defaultNamespace: string;
        byNamespace: Record<string, number>;
      }>(result);
      assert.equal(value.total, expectedTotal);
      assert.equal(value.active, expectedTotal);
      assert.equal(value.defaultNamespace, expectedNamespace);
      assert.deepEqual(value.byNamespace, {
        [expectedNamespace]: expectedTotal,
      });
    }

    const secondCannotRecallFirstRole = await clientCallTool(
      second.client,
      'memory-bridge::memory_recall',
      JSON.stringify({ query: 'ROLE_ALPHA_1537', minScore: 0.12 }),
    );
    assert.deepEqual(
      jsonTextResult<unknown[]>(secondCannotRecallFirstRole),
      [],
    );
    const otherCannotRecallMainNamespace = await clientCallTool(
      other.client,
      'memory-bridge::memory_get_context',
      JSON.stringify({ query: 'PERSONAL_ONLY_7319' }),
    );
    assert.deepEqual(
      jsonTextResult<{ memories: unknown[] }>(
        otherCannotRecallMainNamespace,
      ).memories,
      [],
    );

    for (const [toolName, input] of [
      ['memory-bridge::memory_remember', {
        kind: 'knowledge',
        content: '不得跨 namespace 写入。',
        namespace: otherNamespace,
      }],
      ['memory-bridge::memory_recall', {
        query: '测试',
        namespace: otherNamespace,
      }],
      ['memory-bridge::memory_get_context', {
        query: '测试',
        namespace: otherNamespace,
      }],
      ['memory-bridge::memory_list', { namespace: otherNamespace }],
      ['memory-bridge::memory_update', {
        id: personal.memory.id,
        content: '不得跨 namespace 更新。',
        namespace: otherNamespace,
      }],
    ] as const) {
      const result = await clientCallTool(
        first.client,
        toolName,
        JSON.stringify(input),
      );
      assert.equal(result.isError, true);
      assert.match(textResult(result), /namespace 不属于当前 MCP 连接/u);
    }

    for (const scope of ['role', 'project', 'session'] as const) {
      const result = await clientCallTool(
        incomplete.client,
        'memory-bridge::memory_remember',
        JSON.stringify({
          kind: 'knowledge',
          content: `不完整身份不得写入 ${scope}。`,
          scope,
        }),
      );
      assert.equal(result.isError, true);
      assert.match(textResult(result), new RegExp(`${scope} 作用域未绑定`, 'u'));
    }

    const absentId = '00000000-0000-4000-8000-000000000000';
    const crossUpdate = await clientCallTool(
      first.client,
      'memory-bridge::memory_update',
      JSON.stringify({
        id: secondRole.memory.id,
        content: '角色甲不得更新角色乙。',
      }),
    );
    const absentUpdate = await clientCallTool(
      first.client,
      'memory-bridge::memory_update',
      JSON.stringify({ id: absentId, content: '不存在。' }),
    );
    const crossForget = await clientCallTool(
      first.client,
      'memory-bridge::memory_forget',
      JSON.stringify({ id: secondRole.memory.id }),
    );
    const absentForget = await clientCallTool(
      first.client,
      'memory-bridge::memory_forget',
      JSON.stringify({ id: absentId }),
    );
    for (const result of [
      crossUpdate,
      absentUpdate,
      crossForget,
      absentForget,
    ]) {
      assert.equal(result.isError, true);
    }
    assert.equal(textResult(crossUpdate), textResult(absentUpdate));
    assert.equal(textResult(crossForget), textResult(absentForget));
    assert.match(textResult(crossUpdate), /当前 MCP 连接范围/u);

    const firstForget = await clientCallTool(
      first.client,
      'memory-bridge::memory_forget',
      JSON.stringify({ id: firstSession.memory.id, reason: '重复遗忘验收' }),
    );
    const repeatedForget = await clientCallTool(
      first.client,
      'memory-bridge::memory_forget',
      JSON.stringify({ id: firstSession.memory.id, reason: '重复遗忘验收' }),
    );
    const firstForgotten = jsonTextResult<{ id: string; status: string }>(
      firstForget,
    );
    const repeatedForgotten = jsonTextResult<{ id: string; status: string }>(
      repeatedForget,
    );
    assert.equal(firstForgotten.id, firstSession.memory.id);
    assert.equal(firstForgotten.status, 'deleted');
    assert.deepEqual(repeatedForgotten, firstForgotten);

    const crossSupersede = await clientCallTool(
      first.client,
      'memory-bridge::memory_remember',
      JSON.stringify({
        kind: 'preference',
        content: '不得用角色甲替代角色乙的记忆。',
        scope: 'role',
        supersedesId: secondRole.memory.id,
      }),
    );
    assert.equal(crossSupersede.isError, true);
    assert.match(textResult(crossSupersede), /当前 MCP 连接范围/u);

    const secondAfterAttempts = jsonTextResult<Listed>(
      await clientCallTool(
        second.client,
        'memory-bridge::memory_list',
        JSON.stringify({ status: 'active', limit: 20 }),
      ),
    );
    assert.equal(secondAfterAttempts.total, 4);
    assert.ok(
      secondAfterAttempts.items.some(
        (item) =>
          item.id === secondRole.memory.id && item.status === 'active',
      ),
    );
  } finally {
    await Promise.allSettled([
      first.client.close(),
      second.client.close(),
      other.client.close(),
      incomplete.client.close(),
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('两个真实 MCP 进程并发冷启动时分批修复部分索引且完整库不重复重建', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-mcp-cold-start-'),
  );
  const databasePath = path.join(directory, 'memory-bridge.sqlite3');
  const seeded = openDatabase(databasePath);
  const identity = new IdentityService(seeded);
  identity.createPrincipal({ id: 'cold-alice', displayName: 'Cold Alice' });
  identity.createPrincipal({ id: 'cold-bob', displayName: 'Cold Bob' });
  const aliceToken = identity.issueCredential({
    principalId: 'cold-alice',
    label: 'Concurrent cold start Alice',
  }).token;
  const bobToken = identity.issueCredential({
    principalId: 'cold-bob',
    label: 'Concurrent cold start Bob',
  }).token;
  const memoryCount = 640;
  const boundaryId = `cold-memory-${memoryCount - 1}`;
  const boundaryMarker = 'COLDCONCURRENT7391';
  const timestamp = '2026-08-11T00:00:00.000Z';
  const insert = seeded.prepare(
    `INSERT INTO memories (
       id, user_id, namespace, kind, title, content, summary,
       tags_json, importance, confidence, status, source, source_ref,
       occurred_at, valid_from, valid_to, created_at, updated_at,
       last_seen_at, access_count, checksum, embedding
     ) VALUES (
       ?, 'cold-alice', 'personal', 'knowledge', ?, ?, '', '[]',
       0.8, 1, 'active', 'cold-start-test', NULL,
       NULL, NULL, NULL, ?, ?, ?, 0, ?, ?
     )`,
  );
  const lexical = new HybridRetrievalIndex(seeded);
  try {
    seeded.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < memoryCount; index += 1) {
      const id = `cold-memory-${index}`;
      const title = `并发冷启动记忆 ${index}`;
      const content = index === memoryCount - 1
        ? `并发冷启动边界验收码是 ${boundaryMarker}。`
        : `并发冷启动合成记忆 ${index}，用于索引恢复测试。`;
      insert.run(
        id,
        title,
        content,
        timestamp,
        timestamp,
        timestamp,
        index.toString(16).padStart(64, '0'),
        new Uint8Array([0, 0, 0, 0]),
      );
      if (index % 2 === 0) {
        lexical.upsert(
          id,
          [title, content, '', '[]'].join('\n'),
          timestamp,
        );
      }
    }
    seeded
      .prepare(
        `DELETE FROM memory_ann_index
         WHERE memory_id = 'cold-memory-0' AND band = 7`,
      )
      .run();
    seeded
      .prepare(
        `DELETE FROM memory_term_index
         WHERE memory_id = 'cold-memory-2'`,
      )
      .run();
    seeded.exec('COMMIT');
  } catch (error) {
    seeded.exec('ROLLBACK');
    throw error;
  } finally {
    seeded.close();
  }

  const stderrByRound: string[][] = [];
  try {
    for (let round = 0; round < 3; round += 1) {
      const alice = createClient(
        directory,
        'conflicting-cold-alice',
        aliceToken,
      );
      const bob = createClient(
        directory,
        'conflicting-cold-bob',
        bobToken,
      );
      try {
        await Promise.all([
          alice.client.connect(alice.transport),
          bob.client.connect(bob.transport),
        ]);
        const [aliceTools, bobTools] = await Promise.all([
          alice.client.listTools(),
          bob.client.listTools(),
        ]);
        assert.ok(
          aliceTools.tools.some((tool) => tool.name === 'memory_recall'),
        );
        assert.ok(
          bobTools.tools.some((tool) => tool.name === 'memory_recall'),
        );
        const recalled = await alice.client.callTool({
          name: 'memory_recall',
          arguments: {
            query: '并发冷启动边界验收码',
            namespace: 'personal',
            limit: 3,
            minScore: 0,
          },
        });
        assert.equal(recalled.isError, undefined);
        assert.match(textResult(recalled), new RegExp(boundaryMarker, 'u'));
        assert.match(textResult(recalled), new RegExp(boundaryId, 'u'));
      } finally {
        await Promise.allSettled([
          alice.client.close(),
          bob.client.close(),
        ]);
        stderrByRound.push([alice.stderrText(), bob.stderrText()]);
      }
    }

    const allStderr = stderrByRound.flat().join('\n');
    assert.doesNotMatch(allStderr, /SQLITE_BUSY|database is locked/iu);
    assert.equal(allStderr.includes(aliceToken), false);
    assert.equal(allStderr.includes(bobToken), false);
    assert.ok(
      stderrByRound[0].some((stderr) =>
        stderr.includes('"component":"hybrid-index-repair"')
      ),
      '首轮冷启动必须留下索引修复 telemetry',
    );
    for (const stderr of stderrByRound.slice(1).flat()) {
      assert.equal(
        stderr.includes('"component":"hybrid-index-repair"'),
        false,
        '索引完整后的冷启动不得重复重建',
      );
    }

    const verified = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const incompleteAnn = Number(
        verified.prepare(
          `SELECT COUNT(*) AS count
           FROM (
             SELECT m.id
             FROM memories m
             LEFT JOIN memory_ann_index a
               ON a.memory_id = m.id
              AND a.index_model = 'local-hybrid-v2'
             WHERE m.status != 'deleted'
             GROUP BY m.id
             HAVING COUNT(DISTINCT a.band) != 16
           )`,
        ).get()?.count ?? 0,
      );
      const missingTerms = Number(
        verified.prepare(
          `SELECT COUNT(*) AS count
           FROM memories m
           WHERE m.status != 'deleted'
             AND NOT EXISTS (
               SELECT 1 FROM memory_term_index t
               WHERE t.memory_id = m.id
                 AND t.index_model = 'local-hybrid-v2'
             )`,
        ).get()?.count ?? 0,
      );
      const duplicateAnn = Number(
        verified.prepare(
          `SELECT COUNT(*) - COUNT(DISTINCT memory_id || ':' ||
             index_model || ':' || band) AS count
           FROM memory_ann_index`,
        ).get()?.count ?? 0,
      );
      const duplicateTerms = Number(
        verified.prepare(
          `SELECT COUNT(*) - COUNT(DISTINCT memory_id || ':' ||
             index_model || ':' || term) AS count
           FROM memory_term_index`,
        ).get()?.count ?? 0,
      );
      assert.equal(incompleteAnn, 0);
      assert.equal(missingTerms, 0);
      assert.equal(duplicateAnn, 0);
      assert.equal(duplicateTerms, 0);
      assert.equal(
        verified.prepare('PRAGMA integrity_check').get()?.integrity_check,
        'ok',
      );
      assert.equal(
        verified.prepare('PRAGMA foreign_key_check').all().length,
        0,
      );
    } finally {
      verified.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
