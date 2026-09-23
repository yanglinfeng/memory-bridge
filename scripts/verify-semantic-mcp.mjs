import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function createClient(directory) {
  const client = new Client({
    name: 'memory-bridge-semantic-mcp-qa',
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/server/mcp-stdio.js'],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || '',
      MEMORY_BRIDGE_DATA_DIR: directory,
      MEMORY_BRIDGE_USER_ID: 'semantic-mcp-qa',
      MEMORY_BRIDGE_NAMESPACE: 'qa',
      MEMORY_BRIDGE_SEMANTIC_MODE: 'required',
      MEMORY_BRIDGE_OLLAMA_URL:
        process.env.MEMORY_BRIDGE_OLLAMA_URL ||
        'http://127.0.0.1:11434',
      MEMORY_BRIDGE_EMBED_MODEL:
        process.env.MEMORY_BRIDGE_EMBED_MODEL ||
        'bge-m3:latest',
      MEMORY_BRIDGE_RERANK_MODEL:
        process.env.MEMORY_BRIDGE_RERANK_MODEL ||
        'qwen2.5:14b',
    },
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return { client, transport, stderr };
}

async function call(client, name, args) {
  const result = await client.callTool({
    name,
    arguments: args,
  });
  const item = result.content.find((content) => content.type === 'text');
  assert.ok(item && item.type === 'text');
  assert.equal(result.isError, undefined, item.text);
  return JSON.parse(item.text);
}

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'memory-bridge-semantic-mcp-'),
);
let first;
let restarted;
let passed = false;

try {
  first = createClient(directory);
  await first.client.connect(first.transport);
  const tools = await first.client.listTools();
  assert.deepEqual(
    new Set(tools.tools.map((tool) => tool.name)),
    new Set([
      'memory_remember',
      'memory_recall',
      'memory_get_context',
      'memory_update',
      'memory_forget',
      'memory_list',
      'memory_stats',
    ]),
  );

  const preference = await call(first.client, 'memory_remember', {
    kind: 'preference',
    content: '用户回答偏好是简洁直接。',
    idempotencyKey: 'semantic-mcp-preference',
  });
  const distractor = await call(first.client, 'memory_remember', {
    kind: 'knowledge',
    content: '精炼版项目总结已经归档。',
    importance: 1,
    confidence: 1,
    idempotencyKey: 'semantic-mcp-distractor',
  });
  const firstRecall = await call(
    first.client,
    'memory_get_context',
    { query: '回答应该详细还是精炼？' },
  );
  assert.deepEqual(
    firstRecall.memories.map((result) => result.memory.id),
    [preference.memory.id],
    'initial semantic recall',
  );
  assert.doesNotMatch(firstRecall.context, /项目总结/);
  await first.client.close();
  first = undefined;

  restarted = createClient(directory);
  await restarted.client.connect(restarted.transport);
  const afterRestart = await call(
    restarted.client,
    'memory_get_context',
    { query: '回复风格应该怎样？' },
  );
  assert.deepEqual(
    afterRestart.memories.map((result) => result.memory.id),
    [preference.memory.id],
    'cross-process semantic recall',
  );

  await call(restarted.client, 'memory_update', {
    id: preference.memory.id,
    content: '用户回答偏好是详细，并附带必要示例。',
  });
  const corrected = await call(
    restarted.client,
    'memory_get_context',
    { query: '用户偏好回答简洁还是详细？' },
  );
  assert.deepEqual(
    corrected.memories.map((result) => result.memory.id),
    [preference.memory.id],
    'corrected semantic recall',
  );
  assert.match(corrected.context, /偏好是详细/);

  await call(restarted.client, 'memory_forget', {
    id: preference.memory.id,
    reason: '语义 MCP 验收清理',
  });
  const forgotten = await call(
    restarted.client,
    'memory_get_context',
    { query: '用户偏好回答简洁还是详细？' },
  );
  assert.deepEqual(forgotten.memories, []);
  assert.match(forgotten.context, /没有找到/);

  console.log(
    JSON.stringify({
      passed: true,
      tools: tools.tools.length,
      rememberedId: preference.memory.id,
      distractorId: distractor.memory.id,
      crossProcessRecall: true,
      correction: true,
      forgetting: true,
    }),
  );
  passed = true;
} catch (error) {
  const stderr = [
    ...(first?.stderr || []),
    ...(restarted?.stderr || []),
  ].join('');
  throw new Error(`${String(error)}\nMCP stderr:\n${stderr}`);
} finally {
  await Promise.allSettled([
    first?.client.close() || Promise.resolve(),
    restarted?.client.close() || Promise.resolve(),
  ]);
  if (
    !passed &&
    process.env.MEMORY_BRIDGE_KEEP_FAILED_QA === '1'
  ) {
    console.error(
      `[semantic-mcp-qa] failed artifacts retained at ${directory}`,
    );
  } else {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
