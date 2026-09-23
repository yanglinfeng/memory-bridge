import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT,
} from '../dist/server/memory-extractor.js';
import {
  NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256,
} from '../dist/server/namespace-quality.js';
import {
  buildMcpModelEnvironment,
  verifyModelPreflight,
} from './qa-model-preflight-lib.mjs';
import {
  createQaRunId,
  immutableQaPath,
  writeImmutableQaFile,
} from './qa-receipt-lib.mjs';

const acceptanceRoot = process.env.MEMORY_BRIDGE_ACCEPTANCE_ROOT;
const bridgeBaseUrl = process.env.MEMORY_BRIDGE_QA_BASE_URL || 'http://127.0.0.1:3791';
const timeoutMs = Number(process.env.MEMORY_BRIDGE_QA_TIMEOUT_MS || 180_000);

if (!acceptanceRoot) {
  throw new Error('必须设置 MEMORY_BRIDGE_ACCEPTANCE_ROOT');
}

const secretsPath = path.join(acceptanceRoot, 'acceptance-secrets.json');
const manifestPath = path.join(acceptanceRoot, 'acceptance-manifest.json');
const databasePath = path.join(acceptanceRoot, 'memory-data', 'memory-bridge.sqlite3');
const receiptsDir = path.join(acceptanceRoot, 'receipts');
const runId = createQaRunId();
const reportPath = immutableQaPath(
  receiptsDir,
  'multiuser-long-chat',
  runId,
  'json',
);
const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const manifestModels = manifest.models;
const chatModel = process.env.MEMORY_BRIDGE_QA_CHAT_MODEL === undefined
  ? manifestModels?.chat
  : process.env.MEMORY_BRIDGE_QA_CHAT_MODEL.trim();
const mcpModelEnvironment = buildMcpModelEnvironment(manifestModels);
const namespace =
  process.env.MEMORY_BRIDGE_QA_NAMESPACE || manifest.namespace;

const startedAt = new Date().toISOString();
const checks = [];
const chatReceipts = [];
const mcpReceipts = [];
const latencyMs = [];

function recordCheck(name, passed, details = {}) {
  checks.push({ name, passed: Boolean(passed), ...details });
  console.log(`[check] ${passed ? 'PASS' : 'FAIL'} ${name}`);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index];
}

function includesAll(text, expected) {
  return expected.every((token) => text.includes(token));
}

function includesNone(text, forbidden) {
  return forbidden.every((token) => !text.includes(token));
}

function createMcpClient(label, token) {
  const client = new Client({
    name: `memory-bridge-${label}-long-chat-qa`,
    version: '1.0.0',
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/server/mcp-stdio.js'],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || '',
      MEMORY_BRIDGE_DATA_DIR: path.dirname(databasePath),
      MEMORY_BRIDGE_MCP_TOKEN: token,
      MEMORY_BRIDGE_NAMESPACE: namespace,
      MEMORY_BRIDGE_SEMANTIC_MODE: 'required',
      MEMORY_BRIDGE_OLLAMA_URL: 'http://127.0.0.1:11434',
      ...mcpModelEnvironment,
    },
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  return { client, transport, stderr };
}

async function callMcp(connection, name, args) {
  const started = Date.now();
  const result = await connection.client.callTool({ name, arguments: args });
  const item = result.content.find((content) => content.type === 'text');
  assert.ok(item && item.type === 'text', `${name} 缺少文本结果`);
  if (result.isError) {
    throw new Error(`${name} 失败：${item.text}`);
  }
  const parsed = JSON.parse(item.text);
  mcpReceipts.push({
    principal: connection.label,
    tool: name,
    durationMs: Date.now() - started,
    resultCount: Array.isArray(parsed)
      ? parsed.length
      : Array.isArray(parsed?.memories)
        ? parsed.memories.length
        : Array.isArray(parsed?.items)
          ? parsed.items.length
          : null,
    qualityState: parsed?.qualityState || null,
  });
  return parsed;
}

function makeConversation({ principal, personaId, sessionId, projectId, system }) {
  return {
    principal,
    personaId,
    sessionId,
    projectId,
    round: 0,
    messages: [{ role: 'system', content: system }],
  };
}

async function chat(actor, conversation, userText, phase) {
  conversation.round += 1;
  conversation.messages.push({ role: 'user', content: userText });
  const headers = {
    Authorization: `Bearer ${actor.token}`,
    'Content-Type': 'application/json',
    'x-memory-bridge-context-version': '1',
    'x-airi-character-id': conversation.personaId,
    'x-airi-session-id': conversation.sessionId,
    'x-airi-round-id': `${conversation.sessionId}-round-${conversation.round}`,
  };
  if (conversation.projectId) {
    headers['x-airi-project-id'] = conversation.projectId;
  }
  const started = Date.now();
  const response = await fetch(`${bridgeBaseUrl}/ollama-compat/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: chatModel,
      messages: conversation.messages,
      stream: false,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `chat ${actor.label}/${conversation.personaId} HTTP ${response.status}: ${responseText.slice(0, 500)}`,
    );
  }
  const body = JSON.parse(responseText);
  const assistantText = String(body?.choices?.[0]?.message?.content || '');
  if (!assistantText) throw new Error('聊天响应缺少 assistant content');
  conversation.messages.push({ role: 'assistant', content: assistantText });
  const durationMs = Date.now() - started;
  latencyMs.push(durationMs);
  chatReceipts.push({
    principal: actor.label,
    personaId: conversation.personaId,
    sessionId: conversation.sessionId,
    projectId: conversation.projectId || null,
    round: conversation.round,
    phase,
    durationMs,
    userText,
    assistantText,
  });
  console.log(
    `[chat] ${phase} ${actor.label}/${conversation.personaId}/${conversation.sessionId} ` +
    `round=${conversation.round} ${durationMs}ms`,
  );
  return assistantText;
}

function queueState(database) {
  const scalar = (sql) => Number(Object.values(database.prepare(sql).get() || {})[0] || 0);
  return {
    outboxOpen: scalar(
      `SELECT COUNT(*) AS count FROM outbox_events
       WHERE status IN ('pending', 'processing', 'failed')`,
    ),
    dueJobs: scalar(
      `SELECT COUNT(*) AS count FROM memory_jobs
       WHERE status IN ('running', 'failed', 'dead')
          OR (status = 'pending' AND julianday(available_at) <= julianday('now'))`,
    ),
  };
}

async function waitForIdle(label, maximumMs = 900_000) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const deadline = Date.now() + maximumMs;
  try {
    let last = null;
    while (Date.now() < deadline) {
      const current = queueState(database);
      if (!last || current.outboxOpen !== last.outboxOpen || current.dueJobs !== last.dueJobs) {
        console.log(`[worker] ${label} outbox=${current.outboxOpen} dueJobs=${current.dueJobs}`);
        last = current;
      }
      if (current.outboxOpen === 0 && current.dueJobs === 0) return current;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const current = queueState(database);
    throw new Error(`${label} 等待 Worker 空闲超时：${JSON.stringify(current)}`);
  } finally {
    database.close();
  }
}

function databaseSnapshot() {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const scalar = (sql, ...parameters) =>
    Number(Object.values(database.prepare(sql).get(...parameters) || {})[0] || 0);
  try {
    const integrity = String(
      Object.values(database.prepare('PRAGMA integrity_check').get() || {})[0] || '',
    );
    const byPrincipal = {};
    for (const principal of [secrets.alice.principalId, secrets.bob.principalId]) {
      byPrincipal[principal] = {
        turns: scalar('SELECT COUNT(*) AS count FROM conversation_turns WHERE user_id = ?', principal),
        sessions: scalar('SELECT COUNT(*) AS count FROM conversation_sessions WHERE user_id = ?', principal),
        activeMemories: scalar(
          `SELECT COUNT(*) AS count FROM memory_items
           WHERE user_id = ? AND status = 'active'`,
          principal,
        ),
        deletedMemories: scalar(
          `SELECT COUNT(*) AS count FROM memory_items
           WHERE user_id = ? AND status = 'deleted'`,
          principal,
        ),
        versions: scalar(
          `SELECT COUNT(*) AS count FROM memory_versions v
           JOIN memory_items m ON m.id = v.memory_item_id
           WHERE m.user_id = ?`,
          principal,
        ),
      };
    }
    return {
      schemaVersion: scalar('PRAGMA user_version'),
      integrity,
      foreignKeyViolations: database.prepare('PRAGMA foreign_key_check').all().length,
      outboxOpen: scalar(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE status IN ('pending', 'processing', 'failed')`,
      ),
      deadJobs: scalar(`SELECT COUNT(*) AS count FROM memory_jobs WHERE status = 'dead'`),
      byPrincipal,
    };
  } finally {
    database.close();
  }
}

async function preflightBridgeRuntime(actor) {
  const response = await fetch(`${bridgeBaseUrl}/api/config`, {
    headers: { Authorization: `Bearer ${actor.token}` },
    signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `验收启动预检无法读取运行时配置：HTTP ${response.status} ` +
      responseText.slice(0, 300),
    );
  }
  const runtime = JSON.parse(responseText);
  const modelPreflight = verifyModelPreflight({
    manifestModels,
    runtime,
    requestedChatModel: chatModel,
  });
  const expectedDataDir = path.resolve(path.dirname(databasePath));
  const mismatches = [
    manifest?.namespace === namespace
      ? null
      : `manifestNamespace=${String(manifest?.namespace)}`,
    runtime.automationMode === 'auto'
      ? null
      : `automationMode=${String(runtime.automationMode)}`,
    runtime.semanticMode === 'required'
      ? null
      : `semanticMode=${String(runtime.semanticMode)}`,
    runtime.defaultNamespace === namespace
      ? null
      : `namespace=${String(runtime.defaultNamespace)}`,
    path.resolve(String(runtime.dataDir || '')) === expectedDataDir
      ? null
      : '数据目录不是本次隔离验收库',
    runtime.extractorImplementation ===
      MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT
      ? null
      : `extractorImplementation=${String(
        runtime.extractorImplementation,
      )}`,
    runtime.qualityPipelineImplementation ===
      NAMESPACE_QUALITY_PIPELINE_IMPLEMENTATION_SHA256
      ? null
      : '检索质量流水线指纹不是当前构建',
  ].filter(Boolean);
  if (mismatches.length > 0) {
    throw new Error(
      `验收启动预检失败：${mismatches.join('；')}`,
    );
  }
  console.log(
    '[preflight] PASS isolated-data auto required current-build ' +
    `${MEMORY_EXTRACTOR_IMPLEMENTATION_CONTRACT}`,
  );
  return modelPreflight;
}

const actors = {
  alice: {
    label: 'alice',
    principalId: secrets.alice.principalId,
    token: secrets.alice.token,
  },
  bob: {
    label: 'bob',
    principalId: secrets.bob.principalId,
    token: secrets.bob.token,
  },
};

const mcpConnections = {
  alice: { ...createMcpClient('alice', actors.alice.token), label: 'alice' },
  bob: { ...createMcpClient('bob', actors.bob.token), label: 'bob' },
};

const systems = {
  star: '你是星璃，温柔、耐心的陪伴型角色。先倾听，再给简短可执行的建议。',
  ink: '你是墨言，冷静、专业的工作伙伴。回答先给结论，再给必要依据。',
  boat: '你是小舟，轻松自然的生活伙伴。不要假装知道用户没有说过的事实。',
  pine: '你是松岚，专注兴趣与计划的伙伴。尊重用户边界，未知时明确说不知道。',
};

async function main() {
  fs.mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
  const modelPreflight = await preflightBridgeRuntime(actors.alice);
  const initialSnapshot = databaseSnapshot();
  recordCheck('隔离库初始无对话和规范记忆',
    Object.values(initialSnapshot.byPrincipal).every(
      (state) => state.turns === 0 && state.activeMemories === 0,
    ),
    { initialSnapshot },
  );

  for (const connection of Object.values(mcpConnections)) {
    await connection.client.connect(connection.transport);
    const tools = await connection.client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    recordCheck(`${connection.label} MCP 暴露完整 7 工具`, names.length === 7, { names });
  }

  const aliceManual = await callMcp(mcpConnections.alice, 'memory_remember', {
    kind: 'preference',
    namespace,
    content: 'Alice 的测试提醒色是雾蓝色，标识词为 A-雾蓝-771。',
    idempotencyKey: 'long-chat-qa-alice-manual',
  });
  const bobManual = await callMcp(mcpConnections.bob, 'memory_remember', {
    kind: 'preference',
    namespace,
    content: 'Bob 的测试提醒色是松石绿色，标识词为 B-松绿-284。',
    idempotencyKey: 'long-chat-qa-bob-manual',
  });
  recordCheck('MCP 为两个 principal 创建不同 UUID',
    aliceManual.memory.id !== bobManual.memory.id,
  );

  const aliceOwn = await callMcp(mcpConnections.alice, 'memory_get_context', {
    namespace,
    query: 'Alice 的测试提醒色和标识词是什么？',
  });
  recordCheck('Alice MCP 正向召回自己的记忆',
    aliceOwn.context.includes('A-雾蓝-771') &&
    !aliceOwn.context.includes('B-松绿-284'),
    { qualityState: aliceOwn.qualityState },
  );
  const bobCross = await callMcp(mcpConnections.bob, 'memory_get_context', {
    namespace,
    query: 'Alice 的标识词 A-雾蓝-771 是什么？',
  });
  recordCheck('Bob MCP 不召回 Alice 记忆',
    !bobCross.context.includes('A-雾蓝-771'),
    { returnedMemories: bobCross.memories.length, qualityState: bobCross.qualityState },
  );

  const disposable = await callMcp(mcpConnections.alice, 'memory_remember', {
    kind: 'event',
    namespace: `${namespace}-disposable`,
    content: '一次性测试暗号是纸鸢-909，验收后必须遗忘。',
    idempotencyKey: 'long-chat-qa-disposable',
  });
  await callMcp(mcpConnections.alice, 'memory_update', {
    id: disposable.memory.id,
    content: '一次性测试暗号已修正为纸鸢-910，验收后必须遗忘。',
  });
  await callMcp(mcpConnections.alice, 'memory_forget', {
    id: disposable.memory.id,
    reason: '隔离验收自然清理',
  });
  const disposableAfterForget = await callMcp(
    mcpConnections.alice,
    'memory_get_context',
    { namespace: `${namespace}-disposable`, query: '一次性测试暗号是什么？' },
  );
  recordCheck('MCP 修正后遗忘不再返回目标记忆',
    disposableAfterForget.memories.length === 0,
    { returnedMemories: disposableAfterForget.memories.length },
  );

  const baselineConversations = [
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-star', sessionId: 'alice-star-baseline',
      projectId: 'alice-starport', system: systems.star,
    }), '星港项目的代号是什么？', ['蓝鲸17', '银鸥29']],
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-ink', sessionId: 'alice-ink-baseline',
      projectId: 'alice-morningboat', system: systems.ink,
    }), '我早上习惯喝什么？', ['桂花乌龙']],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-boat', sessionId: 'bob-boat-baseline',
      projectId: 'bob-greenmist', system: systems.boat,
    }), '青岚项目的代号是什么？', ['绿松石33']],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-pine', sessionId: 'bob-pine-baseline',
      projectId: 'bob-northlight', system: systems.pine,
    }), '我晚上习惯喝什么？', ['玄米茶']],
  ];
  for (const [actor, conversation, question, forbidden] of baselineConversations) {
    const answer = await chat(actor, conversation, question, 'baseline');
    recordCheck(`基线未知：${conversation.sessionId}`,
      includesNone(answer, forbidden),
      { forbidden, answer },
    );
  }

  const training = [
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-star', sessionId: 'alice-star-train',
      projectId: 'alice-starport', system: systems.star,
    }), [
      '我早上只喝桂花乌龙，下午通常不喝咖啡。今天起得有点早。',
      '只在和星璃这个角色聊天时，请叫我小枫；我难过时先让我把话说完。',
      '星港项目目前的代号是蓝鲸17，界面主色定为靛青。',
      '今天工作比较多，我想先安静十分钟，再处理最难的事情。',
      '刚才喝了桂花乌龙，确实比咖啡更适合我的早晨。',
    ]],
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-ink', sessionId: 'alice-ink-train',
      projectId: 'alice-morningboat', system: systems.ink,
    }), [
      '和墨言这个角色聊工作时称呼我林总，回答先给结论再给依据。',
      '晨舟项目代号是赤狐42，固定发布窗口是星期三晚上九点。',
      '我做决策时喜欢先看风险最大的两项，不需要堆很多背景。',
      '今天把发布清单按风险排序，先不讨论视觉细节。',
      '早上还是桂花乌龙，这个习惯在工作日也一样。',
    ]],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-boat', sessionId: 'bob-boat-train',
      projectId: 'bob-greenmist', system: systems.boat,
    }), [
      '我晚上习惯喝玄米茶，而且不喝牛奶。',
      '只在和小舟这个角色聊天时叫我阿北，聊天语气可以轻松一点。',
      '青岚项目代号是绿松石33，计划在星期六早上验收。',
      '我把香菜叫作翠叶禁区，看到就完全不吃。',
      '今晚还是玄米茶，喝完我准备读二十分钟书。',
    ]],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-pine', sessionId: 'bob-pine-train',
      projectId: 'bob-northlight', system: systems.pine,
    }), [
      '和松岚这个角色聊天时请叫我北辰，做计划时一次只列三步。',
      '北光收藏项目的编号是白桦58，标签统一使用暖灰色。',
      '我的周末一般先整理书架，再去散步，晚上喝玄米茶。',
      '这周想整理科幻小说，不需要安排购物任务。',
      '三步计划对我最有用，超过三步我容易不想开始。',
    ]],
  ];

  for (const [actor, conversation, turns] of training) {
    for (const turn of turns) {
      await chat(actor, conversation, turn, 'training');
    }
  }
  await waitForIdle('首轮训练');

  const positiveProbes = [
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-star', sessionId: 'alice-star-probe-1',
      projectId: 'alice-starport', system: systems.star,
    }), '星港项目现在的代号和主色是什么？', ['蓝鲸17', '靛青']],
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-star', sessionId: 'alice-star-probe-2',
      projectId: 'alice-starport', system: systems.star,
    }), '你在这个角色里应该怎么称呼我？', ['小枫']],
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-ink', sessionId: 'alice-ink-probe-1',
      projectId: 'alice-morningboat', system: systems.ink,
    }), '晨舟项目的代号和发布时间是什么？', ['赤狐42', '星期三']],
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-ink', sessionId: 'alice-morning-probe',
      projectId: 'alice-morningboat', system: systems.ink,
    }), '我工作日早上一般喝什么？', ['桂花乌龙']],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-boat', sessionId: 'bob-boat-probe-1',
      projectId: 'bob-greenmist', system: systems.boat,
    }), '青岚项目的代号和验收时间是什么？', ['绿松石33', '星期六']],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-boat', sessionId: 'bob-boat-probe-2',
      projectId: 'bob-greenmist', system: systems.boat,
    }), '你在这个角色里应该怎么称呼我？', ['阿北']],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-pine', sessionId: 'bob-pine-probe-1',
      projectId: 'bob-northlight', system: systems.pine,
    }), '北光收藏项目的编号和标签颜色是什么？', ['白桦58', '暖灰']],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-pine', sessionId: 'bob-evening-probe',
      projectId: 'bob-northlight', system: systems.pine,
    }), '我晚上一般喝什么？', ['玄米茶']],
  ];
  for (const [actor, conversation, question, expected] of positiveProbes) {
    const answer = await chat(actor, conversation, question, 'positive-probe');
    recordCheck(`正向召回：${conversation.sessionId}`,
      includesAll(answer, expected),
      { expected, answer },
    );
  }

  const isolationProbes = [
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-ink', sessionId: 'alice-cross-role',
      projectId: 'alice-morningboat', system: systems.ink,
    }), '星璃那个角色平时怎么称呼我？', ['小枫', '蓝鲸17', '银鸥29']],
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-ink', sessionId: 'alice-cross-project',
      projectId: 'alice-morningboat', system: systems.ink,
    }), '星港项目的代号是什么？', ['蓝鲸17', '银鸥29']],
    [actors.bob, makeConversation({
      principal: 'bob', personaId: 'bob-boat', sessionId: 'bob-cross-account',
      projectId: 'bob-greenmist', system: systems.boat,
    }), 'Alice 的星港项目代号是什么？', ['蓝鲸17', '银鸥29', '赤狐42']],
    [actors.alice, makeConversation({
      principal: 'alice', personaId: 'alice-star', sessionId: 'alice-cross-account',
      projectId: 'alice-starport', system: systems.star,
    }), 'Bob 的青岚项目代号是什么？', ['绿松石33', '白桦58']],
  ];
  for (const [actor, conversation, question, forbidden] of isolationProbes) {
    const answer = await chat(actor, conversation, question, 'isolation-probe');
    recordCheck(`隔离负例：${conversation.sessionId}`,
      includesNone(answer, forbidden),
      { forbidden, answer },
    );
  }

  const correctionConversation = makeConversation({
    principal: 'alice', personaId: 'alice-star', sessionId: 'alice-star-correction',
    projectId: 'alice-starport', system: systems.star,
  });
  await chat(
    actors.alice,
    correctionConversation,
    '星港项目刚刚调整：现在的代号改为银鸥29，之前的蓝鲸17已经作废，主色仍是靛青。',
    'correction',
  );
  const forgetConversation = makeConversation({
    principal: 'bob', personaId: 'bob-boat', sessionId: 'bob-boat-forget',
    projectId: 'bob-greenmist', system: systems.boat,
  });
  await chat(
    actors.bob,
    forgetConversation,
    '关于我把香菜叫作翠叶禁区、完全不吃香菜这件事，不需要继续保留了，把它忘掉吧。',
    'forget',
  );
  await waitForIdle('修正与遗忘');

  const correctedProbe = makeConversation({
    principal: 'alice', personaId: 'alice-star', sessionId: 'alice-star-corrected-probe',
    projectId: 'alice-starport', system: systems.star,
  });
  const correctedAnswer = await chat(
    actors.alice,
    correctedProbe,
    '星港项目现在的代号是什么？',
    'corrected-probe',
  );
  recordCheck('自然纠正后只返回新值',
    correctedAnswer.includes('银鸥29') && !correctedAnswer.includes('蓝鲸17'),
    { answer: correctedAnswer },
  );

  const forgottenProbe = makeConversation({
    principal: 'bob', personaId: 'bob-boat', sessionId: 'bob-boat-forgotten-probe',
    projectId: 'bob-greenmist', system: systems.boat,
  });
  const forgottenAnswer = await chat(
    actors.bob,
    forgottenProbe,
    '我以前怎么称呼香菜？',
    'forgotten-probe',
  );
  recordCheck('自然遗忘后不再泄露旧值',
    !forgottenAnswer.includes('翠叶禁区'),
    { answer: forgottenAnswer },
  );

  const compositeConversation = makeConversation({
    principal: 'alice', personaId: 'alice-ink', sessionId: 'alice-composite-probe',
    projectId: 'alice-morningboat', system: systems.ink,
  });
  const compositeAnswer = await chat(
    actors.alice,
    compositeConversation,
    '根据你长期了解的我的习惯和工作偏好，给我一个今天早上的三句话安排。',
    'personalization-probe',
  );
  const compositeSignals = ['桂花乌龙', '风险', '结论', '林总'];
  const compositeMatches = compositeSignals.filter((token) => compositeAnswer.includes(token));
  recordCheck('累积记忆产生多事实个性化回答',
    compositeMatches.length >= 2,
    { expectedSignals: compositeSignals, matchedSignals: compositeMatches, answer: compositeAnswer },
  );

  await waitForIdle('最终探针');
  const finalSnapshot = databaseSnapshot();
  const aliceStats = await callMcp(mcpConnections.alice, 'memory_stats', {});
  const bobStats = await callMcp(mcpConnections.bob, 'memory_stats', {});
  recordCheck('最终 SQLite 完整且队列收敛',
    finalSnapshot.integrity === 'ok' &&
    finalSnapshot.foreignKeyViolations === 0 &&
    finalSnapshot.outboxOpen === 0 &&
    finalSnapshot.deadJobs === 0,
    { finalSnapshot },
  );
  recordCheck('两个账户均形成独立长期记忆',
    finalSnapshot.byPrincipal[actors.alice.principalId].activeMemories > 0 &&
    finalSnapshot.byPrincipal[actors.bob.principalId].activeMemories > 0,
    {
      aliceActive: finalSnapshot.byPrincipal[actors.alice.principalId].activeMemories,
      bobActive: finalSnapshot.byPrincipal[actors.bob.principalId].activeMemories,
    },
  );

  const passedChecks = checks.filter((check) => check.passed).length;
  const failedChecks = checks.length - passedChecks;
  const report = {
    format: 'memory-bridge-multiuser-long-chat-qa:v2',
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    environment: {
      bridgeBaseUrl,
      namespace,
      chatModel,
      embeddingModel: manifestModels.embedding,
      models: manifestModels,
      schemaVersion: finalSnapshot.schemaVersion,
      isolatedDatabase: true,
    },
    modelPreflight,
    summary: {
      passed: failedChecks === 0,
      checks: checks.length,
      passedChecks,
      failedChecks,
      chatTurns: chatReceipts.length,
      mcpCalls: mcpReceipts.length,
      latencyMs: {
        min: latencyMs.length ? Math.min(...latencyMs) : null,
        average: latencyMs.length
          ? Math.round(latencyMs.reduce((sum, value) => sum + value, 0) / latencyMs.length)
          : null,
        p50: percentile(latencyMs, 0.5),
        p95: percentile(latencyMs, 0.95),
        max: latencyMs.length ? Math.max(...latencyMs) : null,
      },
    },
    checks,
    mcpReceipts,
    chatReceipts,
    initialSnapshot,
    finalSnapshot,
    stats: {
      alice: aliceStats,
      bob: bobStats,
    },
  };
  const reportReceipt = writeImmutableQaFile(
    reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    `[report] ${reportPath} sha256=${reportReceipt.sha256}`,
  );
  console.log(JSON.stringify(report.summary));
  if (failedChecks > 0) process.exitCode = 2;
}

try {
  await main();
} finally {
  await Promise.allSettled(
    Object.values(mcpConnections).map((connection) => connection.client.close()),
  );
}
