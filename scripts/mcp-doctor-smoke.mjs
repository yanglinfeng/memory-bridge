import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverIndex = process.argv.indexOf('--server');
const server = serverIndex >= 0 ? process.argv[serverIndex + 1] : '';
if (!server || !path.isAbsolute(server)) throw new Error('--server 必须是绝对路径');

const runId = randomUUID();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bridge-mcp-doctor-'));
const namespace = `doctor-smoke-${runId}`;
const marker = `DOCTOR${runId.replaceAll('-', '').slice(0, 20)}`;
const client = new Client({ name: 'memory-bridge-doctor', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  cwd: path.dirname(path.dirname(path.dirname(server))),
  env: {
    PATH: process.env.PATH || '',
    MEMORY_BRIDGE_DATA_DIR: root,
    MEMORY_BRIDGE_USER_ID: `doctor-probe-${runId}`,
    MEMORY_BRIDGE_NAMESPACE: namespace,
    MEMORY_BRIDGE_SEMANTIC_MODE: 'off',
    MEMORY_BRIDGE_AUTOMATION_MODE: 'off',
    MEMORY_BRIDGE_RETRIEVAL_JSONL: 'off',
  },
  stderr: 'pipe',
});

const calledTools = [];

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text && text.type === 'text', `${name} 缺少文本结果`);
  if (result.isError === true) {
    throw new Error(`${name} 返回 MCP error：${text.text.slice(0, 500)}`);
  }
  calledTools.push(name);
  return JSON.parse(text.text);
}

let output = null;
try {
  await client.connect(transport);
  const response = await client.listTools();
  const tools = response.tools.map((tool) => tool.name).sort();
  assert.ok(tools.length >= 7, 'MCP 工具数量不足');
  const remembered = await call('memory_remember', {
    content: `${marker} isolated doctor probe`,
    kind: 'knowledge',
    title: marker,
    namespace,
    source: 'doctor-smoke',
    sourceRef: `doctor:${runId}`,
    idempotencyKey: runId,
  });
  const memoryId = remembered?.memory?.id;
  assert.match(String(memoryId), /^[0-9a-f-]{36}$/u, 'remember 未返回记忆 ID');

  await call('memory_update', {
    id: memoryId,
    summary: `${marker} updated`,
  });
  const recalled = await call('memory_recall', {
    query: `${marker} isolated doctor probe`,
    namespace,
    limit: 5,
    minScore: 0,
  });
  assert.ok(
    Array.isArray(recalled) && recalled.some((item) => item?.memory?.id === memoryId),
    'recall 未命中隔离测试记忆',
  );
  const context = await call('memory_get_context', {
    query: `${marker} isolated doctor probe`,
    namespace,
    limit: 5,
    minScore: 0,
  });
  assert.ok(
    Array.isArray(context?.memories) &&
      context.memories.some((item) => item?.memory?.id === memoryId),
    'get_context 未命中隔离测试记忆',
  );
  const listed = await call('memory_list', { namespace, limit: 10 });
  assert.ok(
    Array.isArray(listed?.items) && listed.items.some((item) => item?.id === memoryId),
    'list 未列出隔离测试记忆',
  );
  const stats = await call('memory_stats', {});
  assert.ok(Number(stats?.total) >= 1, 'stats 未统计隔离测试记忆');
  await call('memory_forget', { id: memoryId, reason: 'doctor smoke cleanup' });
  output = { passed: true, tools, calledTools, runId, isolated: true };
} finally {
  await client.close().catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ...output,
  cleanupComplete: !fs.existsSync(root),
}));
