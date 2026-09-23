import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COMPAT_CHAT_MODEL,
  type OllamaCompatAuditEvent,
  type OllamaProxyOptions,
  OllamaCompatibilityError,
  completionToSse,
  handleOllamaCompatibilityProxy,
  rewriteChatRequest,
  rewriteChatResponse,
} from '../src/server/ollama-compat.js';
import { MemoryLifecycle } from '../src/server/memory-lifecycle.js';
import { openDatabase } from '../src/server/database.js';
import { createHttpServer } from '../src/server/http-server.js';
import { LifecycleStore } from '../src/server/lifecycle-store.js';
import { MemoryStore } from '../src/server/memory-store.js';
import type {
  NamespaceRecallCoordinator,
} from '../src/server/namespace-quality.js';
import type { RecallInput } from '../src/server/types.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  assert.ok(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value),
  );
  return value as JsonRecord;
}

function baseRequest(stream = false): JsonRecord {
  return {
    model: COMPAT_CHAT_MODEL,
    stream,
    messages: [
      {
        role: 'user',
        content: '请记住验收代号。',
      },
    ],
    temperature: 0,
    tool_choice: 'auto',
    custom_future_field: { preserved: true },
    tools: [
      {
        type: 'function',
        function: {
          name: 'builtIn_mcpListTools',
          description: 'list',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'builtIn_mcpCallTool',
          description: 'original',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              arguments: { type: 'string' },
            },
            required: ['name', 'arguments'],
            additionalProperties: false,
          },
        },
      },
    ],
  };
}

function passThroughRequest(stream = false): JsonRecord {
  const request = baseRequest(stream);
  request.tools = [(request.tools as unknown[])[0]];
  return request;
}

function completionWithContent(
  content: string,
  model = COMPAT_CHAT_MODEL,
): JsonRecord {
  return {
    id: 'chatcmpl-content',
    object: 'chat.completion',
    created: 123,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
  };
}

function completionWithToolArguments(
  outerArguments: JsonRecord,
  options: {
    choiceIndex?: number;
    toolIndex?: number;
    id?: string;
  } = {},
): JsonRecord {
  return completionWithNamedToolArguments(
    'builtIn_mcpCallTool',
    outerArguments,
    options,
  );
}

function completionWithNamedToolArguments(
  functionName: string,
  toolArguments: JsonRecord,
  options: {
    choiceIndex?: number;
    toolIndex?: number;
    id?: string;
    finishReason?: string;
  } = {},
): JsonRecord {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 123,
    model: COMPAT_CHAT_MODEL,
    system_fingerprint: 'fp_ollama',
    choices: [
      {
        index: options.choiceIndex ?? 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              index: options.toolIndex ?? 0,
              id: options.id ?? 'call-1',
              type: 'function',
              function: {
                name: functionName,
                arguments: JSON.stringify(toolArguments),
              },
            },
          ],
        },
        finish_reason: options.finishReason ?? 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

function normalizedCallArguments(
  completion: JsonRecord,
  choiceIndex = 0,
  toolIndex = 0,
): JsonRecord {
  const choices = completion.choices as JsonRecord[];
  const message = choices[choiceIndex].message as JsonRecord;
  const toolCalls = message.tool_calls as JsonRecord[];
  const fn = toolCalls[toolIndex].function as JsonRecord;
  return asRecord(JSON.parse(fn.arguments as string));
}

test('请求把 AIRI 通用 MCP 调用工具展开为 7 个严格记忆别名和非忆桥回退', () => {
  const original = baseRequest(true);
  const snapshot = structuredClone(original);
  const first = rewriteChatRequest(original);

  assert.equal(first.adapted, true);
  assert.deepEqual(original, snapshot);
  assert.equal(first.body.model, COMPAT_CHAT_MODEL);
  assert.equal(first.body.stream, true);
  assert.equal(first.body.temperature, 0);
  assert.equal(first.body.tool_choice, 'auto');
  assert.deepEqual(first.body.custom_future_field, {
    preserved: true,
  });

  const tools = first.body.tools as JsonRecord[];
  assert.deepEqual(tools[0], (snapshot.tools as JsonRecord[])[0]);
  const functions = tools.map((tool) => asRecord(tool.function));
  const names = functions.map((fn) => fn.name);
  assert.deepEqual(names, [
    'builtIn_mcpListTools',
    'memory_bridge_memory_remember',
    'memory_bridge_memory_recall',
    'memory_bridge_memory_get_context',
    'memory_bridge_memory_update',
    'memory_bridge_memory_forget',
    'memory_bridge_memory_list',
    'memory_bridge_memory_stats',
    'memory_mcp_call_tool',
  ]);
  assert.ok(!names.includes('builtIn_mcpCallTool'));

  const remember = functions.find(
    (fn) => fn.name === 'memory_bridge_memory_remember',
  );
  assert.ok(remember);
  const rememberParameters = asRecord(remember.parameters);
  const rememberProperties = asRecord(
    rememberParameters.properties,
  );
  assert.deepEqual(rememberParameters.required, [
    'content',
    'kind',
  ]);
  assert.equal(rememberParameters.additionalProperties, false);
  assert.equal(
    asRecord(rememberProperties.content).minLength,
    1,
  );
  assert.equal(
    asRecord(rememberProperties.tags).maxItems,
    30,
  );
  assert.equal(
    asRecord(asRecord(rememberProperties.tags).items).maxLength,
    50,
  );
  assert.equal(
    asRecord(rememberProperties.occurredAt).format,
    'date-time',
  );

  const update = functions.find(
    (fn) => fn.name === 'memory_bridge_memory_update',
  );
  assert.ok(update);
  const updateParameters = asRecord(update.parameters);
  assert.deepEqual(updateParameters.required, ['id']);
  assert.equal(
    asRecord(
      asRecord(updateParameters.properties).id,
    ).format,
    'uuid',
  );

  const fallback = functions.find(
    (fn) => fn.name === 'memory_mcp_call_tool',
  );
  assert.ok(fallback);
  const fallbackParameters = asRecord(fallback.parameters);
  assert.deepEqual(fallbackParameters.required, [
    'name',
    'arguments',
  ]);
  assert.deepEqual(
    Object.keys(asRecord(fallbackParameters.properties)),
    ['name', 'arguments'],
  );

  const second = rewriteChatRequest(first.body);
  assert.equal(second.adapted, true);
  assert.deepEqual(second.body, first.body);
});

test('请求改写历史中的忆桥包装调用并保留 call id 与 tool result 关联', () => {
  const request = baseRequest();
  request.messages = [
    { role: 'user', content: '先查长期记忆' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'memory-call',
          index: 0,
          type: 'function',
          function: {
            name: 'builtIn_mcpCallTool',
            arguments: JSON.stringify({
              name: 'memory-bridge::memory_get_context',
              arguments: JSON.stringify({
                query: '正在做的项目',
                limit: 8,
                _memoryRequestKey: 'proxy-call-key',
              }),
            }),
          },
        },
        {
          id: 'other-call',
          index: 1,
          type: 'function',
          function: {
            name: 'builtIn_mcpCallTool',
            arguments: JSON.stringify({
              name: 'other-server::other_tool',
              arguments: '{"query":"hello"}',
            }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'memory-call',
      content: '{"content":[]}',
    },
  ];
  const snapshot = structuredClone(request);

  const rewritten = rewriteChatRequest(request);
  const messages = rewritten.body.messages as JsonRecord[];
  const assistant = messages[1];
  const calls = assistant.tool_calls as JsonRecord[];
  const memoryFn = asRecord(calls[0].function);
  const otherFn = asRecord(calls[1].function);

  assert.equal(calls[0].id, 'memory-call');
  assert.equal(calls[0].index, 0);
  assert.equal(
    memoryFn.name,
    'memory_bridge_memory_get_context',
  );
  assert.deepEqual(JSON.parse(memoryFn.arguments as string), {
    query: '正在做的项目',
    limit: 8,
  });
  assert.equal(otherFn.name, 'memory_mcp_call_tool');
  assert.deepEqual(JSON.parse(otherFn.arguments as string), {
    name: 'other-server::other_tool',
    arguments: '{"query":"hello"}',
  });
  assert.deepEqual(messages[2], {
    role: 'tool',
    tool_call_id: 'memory-call',
    content: '{"content":[]}',
  });
  assert.deepEqual(request, snapshot);
});

test('同一生成轮次已查询后禁止重复查询，已变更后禁止重复记忆操作', () => {
  const withHistory = (
    toolName: string,
    argumentsValue: JsonRecord,
  ): JsonRecord => {
    const request = baseRequest();
    request.messages = [
      { role: 'user', content: '执行长期记忆操作' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'history-call',
            type: 'function',
            function: {
              name: 'builtIn_mcpCallTool',
              arguments: JSON.stringify({
                name: toolName,
                arguments: JSON.stringify(argumentsValue),
              }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'history-call',
        content: '{"isError":false}',
      },
    ];
    return request;
  };

  const queried = rewriteChatRequest(
    withHistory(
      'memory-bridge::memory_get_context',
      { query: '项目代号' },
    ),
  );
  const queryNames = (queried.body.tools as JsonRecord[]).map(
    (tool) => asRecord(tool.function).name,
  );
  assert.ok(!queryNames.includes('builtIn_mcpListTools'));
  assert.ok(
    !queryNames.includes('memory_bridge_memory_get_context'),
  );
  assert.ok(!queryNames.includes('memory_bridge_memory_recall'));
  assert.ok(!queryNames.includes('memory_bridge_memory_list'));
  assert.ok(!queryNames.includes('memory_bridge_memory_stats'));
  assert.ok(queryNames.includes('memory_bridge_memory_update'));
  assert.ok(queryNames.includes('memory_bridge_memory_forget'));
  assert.ok(queryNames.includes('memory_bridge_memory_remember'));

  const remembered = rewriteChatRequest(
    withHistory(
      'memory-bridge::memory_remember',
      { content: '项目代号是晨桥', kind: 'project' },
    ),
  );
  const mutationNames = (
    remembered.body.tools as JsonRecord[]
  ).map((tool) => asRecord(tool.function).name);
  assert.ok(!mutationNames.includes('builtIn_mcpListTools'));
  assert.ok(
    !mutationNames.some(
      (name) =>
        typeof name === 'string' &&
        name.startsWith('memory_bridge_memory_'),
    ),
  );
  assert.ok(mutationNames.includes('memory_mcp_call_tool'));
});

test('旧轮次记忆调用不会限制最后一条用户消息开始的新轮次', () => {
  const request = baseRequest();
  request.messages = [
    { role: 'user', content: '上一轮先查询长期记忆' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'old-call',
          type: 'function',
          function: {
            name: 'builtIn_mcpCallTool',
            arguments: JSON.stringify({
              name: 'memory-bridge::memory_get_context',
              arguments: '{"query":"旧问题"}',
            }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'old-call',
      content: '{"isError":false}',
    },
    { role: 'assistant', content: '上一轮回答完成' },
    { role: 'user', content: '这是全新的用户轮次' },
  ];

  const rewritten = rewriteChatRequest(request);
  const names = (rewritten.body.tools as JsonRecord[]).map(
    (tool) => asRecord(tool.function).name,
  );
  assert.ok(names.includes('builtIn_mcpListTools'));
  assert.ok(names.includes('memory_bridge_memory_remember'));
  assert.ok(names.includes('memory_bridge_memory_recall'));
  assert.ok(names.includes('memory_bridge_memory_get_context'));
  assert.ok(names.includes('memory_bridge_memory_update'));
  assert.ok(names.includes('memory_bridge_memory_forget'));
  assert.ok(names.includes('memory_bridge_memory_list'));
  assert.ok(names.includes('memory_bridge_memory_stats'));
});

test('请求中的保留别名冲突和无效历史调用全部 fail closed', () => {
  const malformedTools = baseRequest();
  malformedTools.tools = {};
  assert.throws(
    () => rewriteChatRequest(malformedTools),
    /tools 必须是数组/,
  );

  const collision = baseRequest();
  (collision.tools as JsonRecord[]).push({
    type: 'function',
    function: {
      name: 'memory_bridge_memory_remember',
      parameters: { type: 'object' },
    },
  });
  assert.throws(
    () => rewriteChatRequest(collision),
    /工具别名冲突/,
  );

  const invalidHistory = baseRequest();
  invalidHistory.messages = [
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'bad-call',
          type: 'function',
          function: {
            name: 'builtIn_mcpCallTool',
            arguments: JSON.stringify({
              name: 'memory-bridge::memory_update',
              arguments: '{"id":"not-a-uuid"}',
            }),
          },
        },
      ],
    },
  ];
  assert.throws(
    () => rewriteChatRequest(invalidHistory),
    /参数 id 类型或范围无效/,
  );

  assert.throws(
    () =>
      rewriteChatResponse(
        completionWithNamedToolArguments(
          'memory_bridge_memory_hallucinated',
          { query: '项目' },
        ),
      ),
    /不支持的忆桥工具别名/,
  );

  assert.throws(
    () =>
      rewriteChatResponse(
        completionWithNamedToolArguments(
          'memory_mcp_call_tool',
          {
            name: 'memory-bridge::memory_recall',
            arguments: '{"query":"项目"}',
          },
        ),
      ),
    /非忆桥回退工具不能调用忆桥/,
  );
});

test('没有目标工具时请求保持不变', () => {
  const request = baseRequest();
  request.tools = [(request.tools as unknown[])[0]];
  const result = rewriteChatRequest(request);
  assert.equal(result.adapted, false);
  assert.deepEqual(result.body, request);
});

test('响应把扁平记忆参数单次编码为 AIRI JSON 字符串', () => {
  const inner = {
    content: '中文、引号"、反斜杠\\和换行\n均需保留',
    kind: 'project',
    tags: ['AIRI', '长期记忆'],
    importance: 1,
    confidence: 0.9,
  };
  const response = completionWithToolArguments({
    name: 'memory-bridge::memory_remember',
    ...inner,
  });

  const normalized = rewriteChatResponse(response);
  const outer = normalizedCallArguments(normalized);
  assert.equal(outer.name, 'memory-bridge::memory_remember');
  assert.equal(typeof outer.arguments, 'string');
  assert.deepEqual(JSON.parse(outer.arguments as string), inner);

  const originalCall = normalizedCallArguments(response);
  assert.equal(originalCall.arguments, undefined);
  assert.equal(originalCall.content, inner.content);
});

test('7 个语义记忆别名响应全部折回 AIRI 双层 MCP 调用并修正 finish_reason', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const cases: Array<{
    alias: string;
    toolName: string;
    arguments: JsonRecord;
  }> = [
    {
      alias: 'memory_bridge_memory_remember',
      toolName: 'memory-bridge::memory_remember',
      arguments: { content: '项目代号是晨星', kind: 'project' },
    },
    {
      alias: 'memory_bridge_memory_recall',
      toolName: 'memory-bridge::memory_recall',
      arguments: { query: '项目代号' },
    },
    {
      alias: 'memory_bridge_memory_get_context',
      toolName: 'memory-bridge::memory_get_context',
      arguments: { query: '正在做的项目', limit: 8 },
    },
    {
      alias: 'memory_bridge_memory_update',
      toolName: 'memory-bridge::memory_update',
      arguments: { id, content: '项目代号已修正为启明' },
    },
    {
      alias: 'memory_bridge_memory_forget',
      toolName: 'memory-bridge::memory_forget',
      arguments: { id, reason: '用户明确要求遗忘' },
    },
    {
      alias: 'memory_bridge_memory_list',
      toolName: 'memory-bridge::memory_list',
      arguments: { limit: 10 },
    },
    {
      alias: 'memory_bridge_memory_stats',
      toolName: 'memory-bridge::memory_stats',
      arguments: {},
    },
  ];

  for (const entry of cases) {
    const response = completionWithNamedToolArguments(
      entry.alias,
      entry.arguments,
      {
        choiceIndex: 2,
        toolIndex: 3,
        id: `call-${entry.alias}`,
        finishReason: 'stop',
      },
    );
    const snapshot = structuredClone(response);
    const normalized = rewriteChatResponse(response);
    const choice = (normalized.choices as JsonRecord[])[0];
    const message = asRecord(choice.message);
    const call = (message.tool_calls as JsonRecord[])[0];
    const fn = asRecord(call.function);
    const outer = asRecord(JSON.parse(fn.arguments as string));

    assert.equal(choice.index, 2);
    assert.equal(choice.finish_reason, 'tool_calls');
    assert.equal(call.index, 3);
    assert.equal(call.id, `call-${entry.alias}`);
    assert.equal(fn.name, 'builtIn_mcpCallTool');
    assert.equal(outer.name, entry.toolName);
    assert.deepEqual(
      JSON.parse(outer.arguments as string),
      entry.arguments,
    );
    assert.deepEqual(response, snapshot);
  }
});

test('非忆桥回退别名折回原始 AIRI 包装器，未知记忆别名参数 fail closed', () => {
  const fallback = rewriteChatResponse(
    completionWithNamedToolArguments(
      'memory_mcp_call_tool',
      {
        name: 'other-server::other_tool',
        arguments: '{"query":"hello"}',
      },
      { finishReason: 'stop' },
    ),
  );
  const choice = (fallback.choices as JsonRecord[])[0];
  const message = asRecord(choice.message);
  const call = (message.tool_calls as JsonRecord[])[0];
  const fn = asRecord(call.function);
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(fn.name, 'builtIn_mcpCallTool');
  assert.deepEqual(JSON.parse(fn.arguments as string), {
    name: 'other-server::other_tool',
    arguments: '{"query":"hello"}',
  });

  assert.throws(
    () =>
      rewriteChatResponse(
        completionWithNamedToolArguments(
          'memory_bridge_memory_recall',
          { query: '项目', unknown: true },
        ),
      ),
    /包含未知参数/,
  );
});

test('响应支持多个 choice、多个工具调用及 nullable 更新字段', () => {
  const response = completionWithToolArguments({
    name: 'memory-bridge::memory_remember',
    content: '第一条',
    kind: 'knowledge',
  });
  const choices = response.choices as JsonRecord[];
  const firstMessage = choices[0].message as JsonRecord;
  (firstMessage.tool_calls as JsonRecord[]).push({
    index: 1,
    id: 'call-non-target',
    type: 'function',
    function: {
      name: 'unrelatedTool',
      arguments: '{"untouched":true}',
    },
  });
  choices.push(
    (completionWithToolArguments(
      {
        name: 'memory-bridge::memory_update',
        id: '11111111-1111-4111-8111-111111111111',
        content: '修正后的完整事实',
        sourceRef: null,
        occurredAt: null,
      },
      { choiceIndex: 1, id: 'call-2' },
    ).choices as JsonRecord[])[0],
  );

  const normalized = rewriteChatResponse(response);
  const first = normalizedCallArguments(normalized, 0, 0);
  const second = normalizedCallArguments(normalized, 1, 0);
  assert.deepEqual(JSON.parse(first.arguments as string), {
    content: '第一条',
    kind: 'knowledge',
  });
  assert.deepEqual(JSON.parse(second.arguments as string), {
    id: '11111111-1111-4111-8111-111111111111',
    content: '修正后的完整事实',
    sourceRef: null,
    occurredAt: null,
  });

  const normalizedChoices = normalized.choices as JsonRecord[];
  const normalizedMessage = normalizedChoices[0]
    .message as JsonRecord;
  const unrelated = (
    normalizedMessage.tool_calls as JsonRecord[]
  )[1];
  assert.deepEqual(unrelated, {
    index: 1,
    id: 'call-non-target',
    type: 'function',
    function: {
      name: 'unrelatedTool',
      arguments: '{"untouched":true}',
    },
  });
});

test('非忆桥 MCP 工具保留原始 arguments 字符串', () => {
  const rawArguments =
    '{"query":"hello","nested":{"preserved":true},"list":[1,2]}';
  const response = completionWithToolArguments({
    name: 'other-server::other_tool',
    arguments: rawArguments,
  });
  const normalized = rewriteChatResponse(response);
  assert.deepEqual(normalizedCallArguments(normalized), {
    name: 'other-server::other_tool',
    arguments: rawArguments,
  });
});

test('非忆桥 MCP 工具兼容模型返回的 arguments 对象', () => {
  const response = completionWithToolArguments({
    name: 'builtIn_debugRandomNumber',
    arguments: {
      minimum: 1,
      maximum: 10,
      nested: { preserved: true },
    },
  });
  const normalized = rewriteChatResponse(response);
  assert.deepEqual(normalizedCallArguments(normalized), {
    name: 'builtIn_debugRandomNumber',
    arguments: JSON.stringify({
      minimum: 1,
      maximum: 10,
      nested: { preserved: true },
    }),
  });
});

test('非法或含糊的模型工具参数显式失败', () => {
  const invalidCases: Array<{
    outer: JsonRecord;
    message: RegExp;
  }> = [
    {
      outer: {
        name: 'memory-bridge::memory_remember',
        content: '缺少类型',
      },
      message: /缺少必填参数：kind/,
    },
    {
      outer: {
        name: 'memory-bridge::memory_remember',
        content: '范围错误',
        kind: 'project',
        importance: 5,
      },
      message: /importance 类型或范围无效/,
    },
    {
      outer: {
        name: 'memory-bridge::memory_recall',
        query: '问题',
        __proto_pollution: true,
      },
      message: /包含未知参数/,
    },
    {
      outer: {
        name: 'memory-bridge::memory_recall',
        arguments: '{"query":"问题"}',
        query: '重复问题',
      },
      message: /同时返回了 arguments 和扁平参数/,
    },
    {
      outer: {
        name: 'other-server::tool',
        query: '不允许扁平',
      },
      message: /非忆桥 MCP 工具必须包含字符串 name/,
    },
  ];

  for (const testCase of invalidCases) {
    assert.throws(
      () =>
        rewriteChatResponse(
          completionWithToolArguments(testCase.outer),
        ),
      (error) =>
        error instanceof OllamaCompatibilityError &&
        testCase.message.test(error.message),
    );
  }
});

test('真实 JSON __proto__ 与继承属性不能绕过参数白名单', () => {
  const outer = asRecord(
    JSON.parse(
      '{"name":"memory-bridge::memory_recall","query":"安全查询","__proto__":{"query":"继承污染"}}',
    ),
  );
  assert.equal(Object.hasOwn(outer, '__proto__'), true);
  assert.throws(
    () =>
      rewriteChatResponse(
        completionWithToolArguments(outer),
      ),
    (error) =>
      error instanceof OllamaCompatibilityError &&
      /包含未知参数：__proto__/.test(error.message),
  );

  const inheritedOuter = Object.create({
    query: '不能作为必填参数',
  }) as JsonRecord;
  inheritedOuter.name = 'memory-bridge::memory_recall';
  const inheritedResponse = completionWithToolArguments({
    name: 'placeholder',
  });
  const choice = (inheritedResponse.choices as JsonRecord[])[0];
  const message = asRecord(choice.message);
  const call = (message.tool_calls as JsonRecord[])[0];
  const fn = asRecord(call.function);
  fn.arguments = inheritedOuter;
  assert.throws(
    () => rewriteChatResponse(inheritedResponse),
    /tool_calls|工具参数不是 JSON 对象/,
  );
});

test('忆桥扁平参数执行 MCP 的空值、UUID、日期、长度、数组与 enum 约束', () => {
  const invalidCases: JsonRecord[] = [
    {
      name: 'memory-bridge::memory_remember',
      content: '',
      kind: 'project',
    },
    {
      name: 'memory-bridge::memory_update',
      id: 'not-a-uuid',
    },
    {
      name: 'memory-bridge::memory_remember',
      content: '日期错误',
      kind: 'event',
      occurredAt: '2026-99-99',
    },
    {
      name: 'memory-bridge::memory_remember',
      content: '日历日期错误',
      kind: 'event',
      occurredAt: '2026-02-30T10:00:00Z',
    },
    {
      name: 'memory-bridge::memory_remember',
      content: '标题过长',
      kind: 'knowledge',
      title: '题'.repeat(101),
    },
    {
      name: 'memory-bridge::memory_remember',
      content: '数组过长',
      kind: 'knowledge',
      tags: Array.from({ length: 31 }, () => 'tag'),
    },
    {
      name: 'memory-bridge::memory_remember',
      content: '数组成员过长',
      kind: 'knowledge',
      tags: ['x'.repeat(51)],
    },
    {
      name: 'memory-bridge::memory_remember',
      content: '枚举错误',
      kind: 'unknown',
    },
    {
      name: 'memory-bridge::memory_update',
      id: '11111111-1111-4111-8111-111111111111',
      sourceRef: 42,
    },
  ];

  for (const outer of invalidCases) {
    assert.throws(
      () =>
        rewriteChatResponse(
          completionWithToolArguments(outer),
        ),
      (error) =>
        error instanceof OllamaCompatibilityError &&
        /类型或范围无效/.test(error.message),
    );
  }

  const valid = rewriteChatResponse(
    completionWithToolArguments({
      name: 'memory-bridge::memory_remember',
      content: '约束内',
      kind: 'event',
      occurredAt: '2026-07-28T10:00:00.000Z',
      supersedesId: '11111111-1111-4111-8111-111111111111',
      tags: ['tag'],
    }),
  );
  assert.equal(
    JSON.parse(
      normalizedCallArguments(valid).arguments as string,
    ).occurredAt,
    '2026-07-28T10:00:00.000Z',
  );
});

test('malformed choices/tool_calls 与非预期模型 completion 全部 fail closed', () => {
  const malformed: unknown[] = [
    {
      ...completionWithContent('x'),
      choices: [null],
    },
    {
      ...completionWithContent('x'),
      choices: [{ index: 0 }],
    },
    {
      ...completionWithContent('x'),
      choices: [
        {
          index: 0,
          message: { role: 'assistant', tool_calls: {} },
        },
      ],
    },
    {
      ...completionWithContent('x'),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [{ type: 'function', function: {} }],
          },
        },
      ],
    },
  ];
  for (const value of malformed) {
    assert.throws(
      () => rewriteChatResponse(value),
      OllamaCompatibilityError,
    );
  }

  const wrongModel = completionWithContent(
    '不应透传',
    'unexpected-chat-model',
  );
  assert.throws(
    () => rewriteChatResponse(wrongModel),
    OllamaCompatibilityError,
  );
  assert.throws(
    () => completionToSse(wrongModel),
    OllamaCompatibilityError,
  );
});

test('SSE 重放保留工具、choice、finish_reason、模型和 usage', () => {
  const normalized = rewriteChatResponse(
    completionWithToolArguments({
      name: 'memory-bridge::memory_get_context',
      query: '我的软件初始数据要求是什么？',
      limit: 8,
    }),
  );
  const events = completionToSse(normalized)
    .split('\n\n')
    .filter(Boolean);
  assert.equal(events.length, 3);
  assert.equal(events[2], 'data: [DONE]');

  const first = asRecord(
    JSON.parse(events[0].slice('data: '.length)),
  );
  const final = asRecord(
    JSON.parse(events[1].slice('data: '.length)),
  );
  assert.equal(first.object, 'chat.completion.chunk');
  assert.equal(first.model, COMPAT_CHAT_MODEL);
  assert.equal(
    (first.choices as JsonRecord[])[0].finish_reason,
    null,
  );
  assert.equal(
    (final.choices as JsonRecord[])[0].finish_reason,
    'tool_calls',
  );
  assert.deepEqual(final.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });

  const delta = (first.choices as JsonRecord[])[0]
    .delta as JsonRecord;
  const call = (delta.tool_calls as JsonRecord[])[0];
  assert.equal(call.id, 'call-1');
  assert.equal(call.index, 0);
  const fn = call.function as JsonRecord;
  const outer = asRecord(JSON.parse(fn.arguments as string));
  assert.deepEqual(JSON.parse(outer.arguments as string), {
    query: '我的软件初始数据要求是什么？',
    limit: 8,
  });
});

test('SSE 重放保留多个 choice 与多个 tool_calls，并限制最终编码为 10 MB', () => {
  const response = completionWithToolArguments({
    name: 'memory-bridge::memory_recall',
    query: '第一项',
  });
  const firstChoice = (response.choices as JsonRecord[])[0];
  const firstMessage = asRecord(firstChoice.message);
  (firstMessage.tool_calls as JsonRecord[]).push({
    index: 1,
    id: 'call-other',
    type: 'function',
    function: {
      name: 'otherTool',
      arguments: '{"unchanged":true}',
    },
  });
  (response.choices as JsonRecord[]).push(
    (completionWithContent('第二个 choice').choices as JsonRecord[])[0],
  );
  const normalized = rewriteChatResponse(response);
  const firstEvent = completionToSse(normalized)
    .split('\n\n')
    .find((event) => event.startsWith('data: {'));
  assert.ok(firstEvent);
  const chunk = asRecord(
    JSON.parse(firstEvent.slice('data: '.length)),
  );
  assert.equal((chunk.choices as JsonRecord[]).length, 2);
  const firstDelta = asRecord(
    (chunk.choices as JsonRecord[])[0].delta,
  );
  assert.equal((firstDelta.tool_calls as JsonRecord[]).length, 2);

  assert.throws(
    () =>
      completionToSse(
        completionWithContent('中'.repeat(4 * 1024 * 1024)),
      ),
    /10 MB/,
  );
});

async function listen(
  server: http.Server,
): Promise<string> {
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

function createCompatServer(
  options: OllamaProxyOptions,
): http.Server {
  return http.createServer(async (request, response) => {
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || '127.0.0.1'}`,
    );
    await handleOllamaCompatibilityProxy(
      request,
      response,
      url,
      options,
    );
  });
}

async function rawPostAllowDisconnect(
  url: URL,
  body: string,
): Promise<{
  status: number | undefined;
  body: string;
  completed: boolean;
}> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    const chunks: Buffer[] = [];
    const finish = (
      status: number | undefined,
      completed: boolean,
    ) => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        body: Buffer.concat(chunks).toString('utf8'),
        completed,
      });
    };
    const request = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        responseStarted = true;
        response.on('data', (chunk) =>
          chunks.push(Buffer.from(chunk)),
        );
        response.once('end', () =>
          finish(response.statusCode, true),
        );
        response.once('aborted', () =>
          finish(response.statusCode, false),
        );
        response.once('error', () =>
          finish(response.statusCode, false),
        );
        response.once('close', () => {
          if (!response.complete) {
            finish(response.statusCode, false);
          }
        });
      },
    );
    request.once('error', (error) => {
      if (responseStarted) finish(undefined, false);
      else reject(error);
    });
    request.end(body);
  });
}

async function readBody(
  request: http.IncomingMessage,
): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return asRecord(
    JSON.parse(Buffer.concat(chunks).toString('utf8')),
  );
}

test('HTTP 生命周期只沉淀已交付的最终回复，错误与断开均不排提取任务', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-airi-http-lifecycle-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const lifecycle = new MemoryLifecycle(
    memoryStore,
    lifecycleStore,
  );
  let mode: 'success' | 'upstream-error' | 'wait' = 'upstream-error';
  let successfulUpstreamRequest: JsonRecord | null = null;
  let startedResolve!: () => void;
  let abortedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abortedResolve = resolve;
  });
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (mode === 'upstream-error') {
      return new Response('offline', { status: 503 });
    }
    if (mode === 'wait') {
      const signal = init?.signal;
      assert.ok(signal);
      startedResolve();
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            abortedResolve();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
    successfulUpstreamRequest = asRecord(
      JSON.parse(String(init?.body)),
    );
    return new Response(
      JSON.stringify(completionWithContent('最终回复已交付。')),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 5_000,
    fetchImpl,
    lifecycle,
  });
  const bridgeBase = await listen(bridge);
  const endpoint =
    `${bridgeBase}/ollama-compat/v1/chat/completions`;
  const request = baseRequest();
  request.messages = [
    { role: 'user', content: '自然聊天形成长期偏好。' },
  ];

  let disconnected: http.ClientRequest | null = null;
  try {
    const failed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(failed.status, 503);
    await failed.arrayBuffer();
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      0,
    );

    mode = 'wait';
    const body = JSON.stringify(request);
    disconnected = http.request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    disconnected.on('error', () => undefined);
    disconnected.end(body);
    await started;
    disconnected.destroy();
    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('客户端断开后上游没有被取消')),
          1_000,
        ),
      ),
    ]);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      0,
    );

    mode = 'success';
    const succeeded = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(succeeded.status, 200);
    assert.match(await succeeded.text(), /最终回复已交付/u);
    const offeredToolNames = (
      successfulUpstreamRequest?.tools as JsonRecord[]
    ).map((tool) => asRecord(tool.function).name);
    assert.deepEqual(offeredToolNames, [
      'builtIn_mcpListTools',
      'memory_mcp_call_tool',
    ]);
    assert.equal(
      database
        .prepare('SELECT COUNT(*) AS count FROM conversation_turns')
        .get()?.count,
      2,
    );
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memory_jobs
           WHERE job_type = 'extract_turn'`,
        )
        .get()?.count,
      0,
    );
    assert.equal(
      database
        .prepare(
          `SELECT status
           FROM outbox_events
           WHERE aggregate_type = 'turn'`,
        )
        .get()?.status,
      'pending',
    );
  } finally {
    disconnected?.destroy();
    await close(bridge);
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 代理把 unavailable 召回状态实际发送给上游模型', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-airi-unavailable-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      return {
        query: input.query,
        memories: [],
        context: '长期记忆语义服务当前不可用，本轮未注入记忆。',
        qualityState: 'unavailable',
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    memoryStore,
    lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
  );
  let upstreamRequest: JsonRecord | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    upstreamRequest = asRecord(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify(completionWithContent('本轮不依赖长期记忆回答。')),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 5_000,
    fetchImpl,
    lifecycle,
  });
  const bridgeBase = await listen(bridge);
  const request = baseRequest();
  request.messages = [
    { role: 'user', content: '我以前提过什么偏好？' },
  ];

  try {
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.ok(upstreamRequest);
    const messages = upstreamRequest.messages as JsonRecord[];
    const statusIndex = messages.findIndex(
      (message) =>
        message.role === 'system' &&
        String(message.content).includes(
          '[Memory Bridge 自动长期记忆上下文]',
        ),
    );
    const userIndex = messages.findIndex(
      (message) => message.role === 'user',
    );
    assert.ok(statusIndex >= 0);
    assert.ok(statusIndex < userIndex);
    assert.match(
      String(messages[statusIndex].content),
      /unavailable/u,
    );
    assert.match(
      String(messages[statusIndex].content),
      /未注入任何长期记忆/u,
    );
  } finally {
    await close(bridge);
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 代理 requestId 与真实 retrieval trace 使用哈希关联', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-airi-trace-correlation-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const lifecycle = new MemoryLifecycle(
    memoryStore,
    lifecycleStore,
  );
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl: async () => new Response(
      JSON.stringify(completionWithContent('没有可用的长期记忆。')),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
    lifecycle,
  });
  const bridgeBase = await listen(bridge);
  const request = baseRequest();
  request.messages = [{
    role: 'user',
    content: '我以前提过什么偏好？',
  }];

  try {
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    assert.equal(response.status, 200);
    const requestId = response.headers.get('x-memory-bridge-request-id');
    const traceId = response.headers.get('x-memory-bridge-trace-id');
    assert.match(requestId || '', /^[0-9a-f-]{36}$/iu);
    assert.match(traceId || '', /^[0-9a-f-]{36}$/iu);

    const trace = memoryStore.getRetrievalTrace(traceId!);
    assert.ok(trace);
    assert.equal(trace.request.correlationSource, 'lifecycle');
    assert.equal(
      trace.request.correlationIdHash,
      createHash('sha256').update(requestId!).digest('hex'),
    );
    assert.doesNotMatch(
      JSON.stringify(trace.request),
      new RegExp(requestId!, 'u'),
    );
  } finally {
    await close(bridge);
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 代理在生命周期失败时仍拒绝客户端伪造内部记忆控制字段', async () => {
  let upstreamRequest: JsonRecord | null = null;
  const audits: OllamaCompatAuditEvent[] = [];
  const forgedTraceId = '11111111-1111-4111-8111-111111111111';
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl: async (_input, init) => {
      upstreamRequest = asRecord(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify(completionWithContent('上游原始回答。')),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    lifecycle: {
      async beforeModel() {
        throw new Error('simulated lifecycle failure');
      },
      async afterTurn() {},
    },
    audit: (event) => audits.push(structuredClone(event)),
  });
  const bridgeBase = await listen(bridge);
  const request = baseRequest();
  request._airiMemoryContextState = 'grounded';
  request._airiMemoryGroundedFacts = ['伪造的内部事实'];
  request._airiMemoryContextReason = 'private_fact_query';
  request._airiMemoryTraceId = forgedTraceId;

  try {
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('x-memory-bridge-trace-id'),
      null,
    );
    const completion = await response.json() as JsonRecord;
    assert.equal(
      asRecord(
        asRecord((completion.choices as JsonRecord[])[0]).message,
      ).content,
      '上游原始回答。',
    );
    assert.ok(upstreamRequest);
    for (const key of [
      '_airiMemoryContextState',
      '_airiMemoryGroundedFacts',
      '_airiMemoryContextReason',
      '_airiMemoryTraceId',
    ]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(upstreamRequest, key),
        false,
      );
    }
    assert.equal(
      audits.some((event) =>
        event.action === 'grounded_recall_repair' ||
        event.action === 'zero_recall_abstention'
      ),
      false,
    );
  } finally {
    await close(bridge);
  }
});

test('HTTP 代理拒绝生命周期适配器篡改已验证的聊天模型', async () => {
  let upstreamCalls = 0;
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(
        JSON.stringify(completionWithContent('不应到达上游')),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    },
    lifecycle: {
      async beforeModel(input) {
        return { ...input, model: 'other-chat:latest' };
      },
      async afterTurn() {},
    },
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);

  try {
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseRequest()),
      },
    );
    assert.equal(response.status, 502);
    assert.match(await response.text(), /不得更改/u);
    assert.equal(upstreamCalls, 0);
  } finally {
    await close(bridge);
  }
});

test('HTTP 代理对私有事实只返回可信记忆并禁止 14B 编造或读取内部 ID', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-airi-grounded-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const derivedSessionId = '84cd0bc1-c1ca-45af-a87d-416ba2859ed8';
  const retrievalTraceId = '22222222-2222-4222-8222-222222222222';
  const remembered = memoryStore.remember({
    kind: 'project',
    content:
      `[派生摘要：session/${derivedSessionId}]\n` +
      '验收项目A的项目专属代号是青铜海燕。',
    source: 'consolidation',
    scopeType: 'session',
    scopeKey: derivedSessionId,
  }).memory;
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      return {
        traceId: retrievalTraceId,
        query: input.query,
        memories: [{
          memory: remembered,
          score: 0.99,
          reasons: ['严格重排确认可直接回答'],
          explanation: {
            lexicalRank: 1,
            annRank: 1,
            termRank: 1,
            graphRank: null,
            semanticSimilarity: 0.99,
            rerankConfidence: 1,
            feedbackPrior: 0,
            importance: remembered.importance,
            memoryConfidence: remembered.confidence,
            recency: 1,
            status: remembered.status,
            conflictState: 'none',
            diversityPenalty: 0,
          },
        }],
        context: `memory_id: ${remembered.id}`,
        qualityState: 'full',
        grounding: [],
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    memoryStore,
    lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
  );
  let upstreamRequest: JsonRecord | null = null;
  const audits: OllamaCompatAuditEvent[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    upstreamRequest = asRecord(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify(completionWithContent(
        '当前项目的项目专属代号是海蓝信天翁。',
      )),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    lifecycle,
    audit: (event) => audits.push(structuredClone(event)),
  });
  const bridgeBase = await listen(bridge);
  const request = baseRequest();
  request.messages = [{
    role: 'user',
    content: '当前项目的项目专属代号是什么？',
  }];

  try {
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('x-memory-bridge-request-id') || '',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    assert.equal(
      response.headers.get('x-memory-bridge-trace-id'),
      retrievalTraceId,
    );
    const completion = await response.json() as JsonRecord;
    assert.equal(
      asRecord(
        asRecord((completion.choices as JsonRecord[])[0]).message,
      ).content,
      '根据长期记忆：验收项目A的项目专属代号是青铜海燕。',
    );
    assert.ok(
      audits.some(
        (event) => event.action === 'grounded_recall_repair' &&
          event.result === 'forced' &&
          event.memoryContextReason === 'private_fact_query' &&
          event.retrievalTraceId === retrievalTraceId,
      ),
    );
    assert.ok(
      audits.some(
        (event) => event.action === 'proxy_result' &&
          event.result === 'success' &&
          event.retrievalTraceId === retrievalTraceId,
      ),
    );
    assert.ok(upstreamRequest);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        upstreamRequest,
        '_airiMemoryContextState',
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        upstreamRequest,
        '_airiMemoryGroundedFacts',
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        upstreamRequest,
        '_airiMemoryContextReason',
      ),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        upstreamRequest,
        '_airiMemoryTraceId',
      ),
      false,
    );
    assert.deepEqual(
      (upstreamRequest.tools as JsonRecord[]).map(
        (tool) => asRecord(tool.function).name,
      ),
      [],
    );
    const systemMessage = (
      upstreamRequest.messages as JsonRecord[]
    ).find((message) =>
      message.role === 'system' &&
      String(message.content).includes(
        '[Memory Bridge 自动长期记忆上下文]',
      )
    );
    assert.ok(systemMessage);
    assert.match(
      String(systemMessage.content),
      /青铜海燕/u,
    );
    assert.doesNotMatch(
      String(systemMessage.content),
      /memory_id|knowledge::get_memory/u,
    );
    assert.doesNotMatch(
      String(systemMessage.content),
      new RegExp(remembered.id, 'u'),
    );
    assert.doesNotMatch(
      String(systemMessage.content),
      new RegExp(derivedSessionId, 'u'),
    );
  } finally {
    await close(bridge);
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 代理对私有事实零召回强制弃答且不误伤世界知识', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-airi-zero-recall-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const memoryStore = new MemoryStore(database);
  const lifecycleStore = new LifecycleStore(database);
  const coordinator = {
    async recallForLifecycle(input: RecallInput) {
      return {
        traceId: 'zero-recall-trace',
        query: input.query,
        memories: [],
        context: '',
        qualityState: 'full',
        grounding: [],
      };
    },
  } as unknown as NamespaceRecallCoordinator;
  const lifecycle = new MemoryLifecycle(
    memoryStore,
    lifecycleStore,
    'default',
    'personal',
    undefined,
    coordinator,
  );
  let upstreamRequest: JsonRecord | null = null;
  const audits: OllamaCompatAuditEvent[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    upstreamRequest = asRecord(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify(completionWithContent(
        '我自己的话喜欢茉莉花，幸运数字是 7。',
      )),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    lifecycle,
    audit: (event) => audits.push(structuredClone(event)),
  });
  const bridgeBase = await listen(bridge);
  const request = baseRequest();
  request.messages = [{
    role: 'user',
    content: 'Alice 的星港项目现在代号是什么？',
  }];

  try {
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    assert.equal(response.status, 200);
    const completion = await response.json() as JsonRecord;
    assert.equal(
      asRecord(
        asRecord((completion.choices as JsonRecord[])[0]).message,
      ).content,
      '不知道。',
    );
    assert.ok(upstreamRequest);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        upstreamRequest,
        '_airiMemoryContextReason',
      ),
      false,
    );
    assert.deepEqual(upstreamRequest.tools, []);
    assert.equal(upstreamRequest.tool_choice, 'none');
    const systemMessage = (
      upstreamRequest.messages as JsonRecord[]
    ).find((message) =>
      message.role === 'system' &&
      String(message.content).includes(
        '[Memory Bridge 自动长期记忆上下文]',
      )
    );
    assert.ok(systemMessage);
    assert.match(String(systemMessage.content), /full/u);
    assert.match(String(systemMessage.content), /没有找到相关事实/u);
    assert.match(String(systemMessage.content), /回答“不知道”/u);
    assert.match(String(systemMessage.content), /不得调用工具/u);
    assert.ok(
      audits.some(
        (event) => event.action === 'zero_recall_abstention' &&
          event.result === 'forced' &&
          event.memoryContextReason === 'private_fact_query',
      ),
    );

    for (const generalQuery of [
      '什么是向量数据库？',
      'Linux 项目现在的负责人是谁？',
      '哪个开源项目现在状态最好？',
    ]) {
      request.messages = [{ role: 'user', content: generalQuery }];
      const generalResponse = await fetch(
        `${bridgeBase}/ollama-compat/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
      );
      assert.equal(generalResponse.status, 200);
      const generalCompletion = await generalResponse.json() as JsonRecord;
      assert.equal(
        asRecord(
          asRecord((generalCompletion.choices as JsonRecord[])[0]).message,
        ).content,
        '我自己的话喜欢茉莉花，幸运数字是 7。',
      );
      assert.ok(upstreamRequest);
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          upstreamRequest,
          '_airiMemoryContextReason',
        ),
        false,
      );
      assert.equal(
        (upstreamRequest.messages as JsonRecord[]).some((message) =>
          String(message.content).includes(
            '[Memory Bridge 自动长期记忆上下文]',
          )
        ),
        false,
      );
    }
    assert.equal(
      audits.filter(
        (event) => event.action === 'zero_recall_abstention',
      ).length,
      1,
    );
  } finally {
    await close(bridge);
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 代理自动恢复一次空正文并在连续空回复时明确失败', async () => {
  const upstreamRequests: JsonRecord[] = [];
  const attempts = new Map<string, number>();
  const audits: OllamaCompatAuditEvent[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = asRecord(JSON.parse(String(init?.body)));
    upstreamRequests.push(request);
    const messages = request.messages as JsonRecord[];
    const userContent = String(
      [...messages].reverse().find(
        (message) => message.role === 'user',
      )?.content,
    );
    const attempt = (attempts.get(userContent) || 0) + 1;
    attempts.set(userContent, attempt);
    const content =
      userContent === 'recover-empty' && attempt === 2
        ? '自动重试后恢复了非空回答。'
        : '';
    return new Response(
      JSON.stringify(completionWithContent(content)),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: (event) => audits.push(structuredClone(event)),
  });
  const bridgeBase = await listen(bridge);
  const endpoint =
    `${bridgeBase}/ollama-compat/v1/chat/completions`;

  try {
    const recoveredRequest = baseRequest();
    recoveredRequest.messages = [
      { role: 'user', content: 'recover-empty' },
    ];
    const recovered = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recoveredRequest),
    });
    assert.equal(recovered.status, 200);
    assert.match(
      await recovered.text(),
      /自动重试后恢复了非空回答/u,
    );

    const failedRequest = baseRequest();
    failedRequest.messages = [
      { role: 'user', content: 'fail-empty' },
    ];
    const failed = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(failedRequest),
    });
    assert.equal(failed.status, 502);
    assert.match(await failed.text(), /连续两次返回空回复/u);

    assert.equal(upstreamRequests.length, 4);
    for (const retryRequest of [
      upstreamRequests[1],
      upstreamRequests[3],
    ]) {
      assert.deepEqual(retryRequest.tools, []);
      assert.equal(retryRequest.tool_choice, 'none');
      assert.ok(
        (retryRequest.messages as JsonRecord[]).some(
          (message) =>
            message.role === 'system' &&
            String(message.content).includes('AIRI 空回复恢复'),
        ),
      );
    }
    assert.deepEqual(
      audits
        .filter((event) => event.action === 'empty_completion_retry')
        .map((event) => event.result),
      ['started', 'recovered', 'started'],
    );
  } finally {
    await close(bridge);
  }
});

test('HTTP 代理固定 14B、过滤模型、缓冲上游并向 AIRI 重放 SSE', async () => {
  const upstreamRequests: JsonRecord[] = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
      });
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            { id: COMPAT_CHAT_MODEL, object: 'model' },
            {
              id: 'unexpected-upstream-model',
              model: COMPAT_CHAT_MODEL,
              object: 'model',
            },
            {
              id: COMPAT_CHAT_MODEL,
              model: 'unexpected-upstream-model',
              object: 'model',
            },
            { id: 'unexpected-upstream-model', object: 'model' },
          ],
        }),
      );
      return;
    }
    if (
      request.url === '/v1/chat/completions' &&
      request.method === 'POST'
    ) {
      const body = await readBody(request);
      upstreamRequests.push(body);
      const content =
        (body.messages as JsonRecord[])[0].content as string;
      const bad = content.includes('bad-output');
      const wrongResponseModel = content.includes(
        'wrong-response-model',
      );
      const completion = completionWithNamedToolArguments(
        'memory_bridge_memory_remember',
        {
          content: '验收代号是 AIRI-E2E-LPE3SH',
          kind: 'project',
          ...(bad ? { importance: 5 } : {}),
        },
      );
      if (wrongResponseModel) completion.model = 'unexpected-upstream-model';
      response.writeHead(200, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify(completion));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const upstreamBase = await listen(upstream);

  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-airi-proxy-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const bridge = createHttpServer(store, {
    ollamaBaseUrl: upstreamBase,
    compatProxyTimeoutMs: 5_000,
  });
  const bridgeBase = await listen(bridge);

  try {
    const modelsResponse = await fetch(
      `${bridgeBase}/ollama-compat/v1/models`,
    );
    assert.equal(modelsResponse.status, 200);
    const models = asRecord(await modelsResponse.json());
    assert.deepEqual(models.data, [
      { id: COMPAT_CHAT_MODEL, object: 'model' },
    ]);

    const request = baseRequest(true);
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') || '',
      /text\/event-stream/,
    );
    const text = await response.text();
    assert.match(text, /data: \[DONE\]/);

    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].model, COMPAT_CHAT_MODEL);
    assert.equal(upstreamRequests[0].stream, false);
    const tools = upstreamRequests[0].tools as JsonRecord[];
    const names = tools.map(
      (tool) => asRecord(tool.function).name,
    );
    assert.deepEqual(names, [
      'builtIn_mcpListTools',
      'memory_bridge_memory_remember',
      'memory_bridge_memory_recall',
      'memory_bridge_memory_get_context',
      'memory_bridge_memory_update',
      'memory_bridge_memory_forget',
      'memory_bridge_memory_list',
      'memory_bridge_memory_stats',
      'memory_mcp_call_tool',
    ]);

    const firstEvent = text
      .split('\n\n')
      .find((event) => event.startsWith('data: {'));
    assert.ok(firstEvent);
    const chunk = asRecord(
      JSON.parse(firstEvent.slice('data: '.length)),
    );
    const delta = (chunk.choices as JsonRecord[])[0]
      .delta as JsonRecord;
    const call = (delta.tool_calls as JsonRecord[])[0];
    const callFn = call.function as JsonRecord;
    const outer = asRecord(
      JSON.parse(callFn.arguments as string),
    );
    assert.equal(
      outer.name,
      'memory-bridge::memory_remember',
    );
    const inner = asRecord(
      JSON.parse(outer.arguments as string),
    );
    assert.match(
      String(inner._memoryRequestKey),
      /^[0-9a-f]{64}$/u,
    );
    delete inner._memoryRequestKey;
    assert.deepEqual(inner, {
      content: '验收代号是 AIRI-E2E-LPE3SH',
      kind: 'project',
    });

    const wrongModel = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseRequest(),
          model: 'unexpected-chat-model',
        }),
      },
    );
    assert.equal(wrongModel.status, 400);
    assert.equal(upstreamRequests.length, 1);

    const wrongResponseModel = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseRequest(),
          messages: [
            { role: 'user', content: 'wrong-response-model' },
          ],
        }),
      },
    );
    assert.equal(wrongResponseModel.status, 502);
    assert.doesNotMatch(
      await wrongResponseModel.text(),
      /AIRI-E2E-LPE3SH/,
    );

    const invalidOutput = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseRequest(),
          messages: [{ role: 'user', content: 'bad-output' }],
        }),
      },
    );
    assert.equal(invalidOutput.status, 502);
    assert.match(
      JSON.stringify(await invalidOutput.json()),
      /importance/,
    );
    assert.equal(store.stats().total, 0);
    assert.equal(store.audits(20, 0).length, 0);
  } finally {
    await close(bridge);
    await close(upstream);
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 代理支持独立配置 AIRI 聊天模型并如实暴露运行时配置', async () => {
  const customModel = 'custom-chat:latest';
  const upstreamRequests: JsonRecord[] = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify({
        object: 'list',
        data: [
          { id: COMPAT_CHAT_MODEL, object: 'model' },
          { id: customModel, object: 'model' },
        ],
      }));
      return;
    }
    if (
      request.url === '/v1/chat/completions' &&
      request.method === 'POST'
    ) {
      const body = await readBody(request);
      upstreamRequests.push(body);
      if (body.stream === true) {
        const chunk = {
          id: 'chatcmpl-custom-stream',
          object: 'chat.completion.chunk',
          created: 123,
          model: customModel,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: '自定义流式回复' },
            finish_reason: null,
          }],
        };
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
        });
        response.end(
          `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
      });
      response.end(JSON.stringify(
        completionWithContent('自定义模型回复', customModel),
      ));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const upstreamBase = await listen(upstream);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'memory-bridge-airi-custom-model-'),
  );
  const database = openDatabase(path.join(directory, 'test.sqlite3'));
  const store = new MemoryStore(database);
  const bridge = createHttpServer(store, {
    ollamaBaseUrl: upstreamBase,
    compatChatModel: customModel,
    compatProxyTimeoutMs: 5_000,
  });
  const bridgeBase = await listen(bridge);

  try {
    const healthResponse = await fetch(`${bridgeBase}/api/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      ok: true,
      service: 'memory-bridge',
      version: '1.0.0',
      mcpTransport: 'stdio',
    });
    const configResponse = await fetch(`${bridgeBase}/api/config`);
    assert.equal(configResponse.status, 200);
    const configPayload = asRecord(await configResponse.json());
    assert.equal(configPayload.compatChatModel, customModel);

    const modelsResponse = await fetch(
      `${bridgeBase}/ollama-compat/v1/models`,
    );
    assert.equal(modelsResponse.status, 200);
    const models = asRecord(await modelsResponse.json());
    assert.deepEqual(models.data, [
      { id: customModel, object: 'model' },
    ]);

    const request = {
      ...baseRequest(true),
      model: customModel,
    };
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    assert.equal(response.status, 200);
    const events = (await response.text()).split('\n\n');
    const firstEvent = events.find((event) => event.startsWith('data: {'));
    assert.ok(firstEvent);
    assert.equal(
      asRecord(JSON.parse(firstEvent.slice('data: '.length))).model,
      customModel,
    );
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].model, customModel);

    const directJson = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: customModel,
          stream: false,
          messages: [{ role: 'user', content: '直接 JSON' }],
        }),
      },
    );
    assert.equal(directJson.status, 200);
    assert.equal(asRecord(await directJson.json()).model, customModel);

    const directSse = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: customModel,
          stream: true,
          messages: [{ role: 'user', content: '直接 SSE' }],
        }),
      },
    );
    assert.equal(directSse.status, 200);
    const directSseText = await directSse.text();
    assert.match(directSseText, /自定义流式回复/u);
    assert.match(directSseText, /data: \[DONE\]/u);

    const rejected = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseRequest()),
      },
    );
    assert.equal(rejected.status, 400);
    assert.equal(upstreamRequests.length, 3);
  } finally {
    await close(bridge);
    await close(upstream);
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 代理拒绝模型调用本轮没有提供的记忆工具', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const completions = [
    completionWithNamedToolArguments(
      'memory_bridge_memory_recall',
      { query: '项目代号' },
    ),
    completionWithNamedToolArguments(
      'memory_bridge_memory_update',
      { id, content: '不应执行的修正' },
    ),
    completionWithNamedToolArguments(
      'builtIn_mcpCallTool',
      {
        name: 'memory-bridge::memory_recall',
        arguments: '{"query":"项目代号"}',
      },
    ),
  ];
  const upstreamRequests: JsonRecord[] = [];
  let completionIndex = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    upstreamRequests.push(
      asRecord(JSON.parse(String(init?.body))),
    );
    return new Response(
      JSON.stringify(completions[completionIndex++]),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  const endpoint =
    `${bridgeBase}/ollama-compat/v1/chat/completions`;

  const withCurrentRoundHistory = (
    toolName: string,
    argumentsValue: JsonRecord,
  ): JsonRecord => {
    const request = baseRequest();
    request.messages = [
      { role: 'user', content: '当前轮次执行长期记忆操作' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'current-call',
            type: 'function',
            function: {
              name: 'builtIn_mcpCallTool',
              arguments: JSON.stringify({
                name: toolName,
                arguments: JSON.stringify(argumentsValue),
              }),
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'current-call',
        content: '{"isError":false}',
      },
    ];
    return request;
  };

  try {
    const cases = [
      withCurrentRoundHistory(
        'memory-bridge::memory_get_context',
        { query: '项目代号' },
      ),
      withCurrentRoundHistory(
        'memory-bridge::memory_remember',
        { content: '项目代号是晨桥', kind: 'project' },
      ),
      withCurrentRoundHistory(
        'memory-bridge::memory_remember',
        { content: '项目代号是晨桥', kind: 'project' },
      ),
    ];

    for (const request of cases) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 502);
      assert.match(await response.text(), /本轮没有提供/);
    }

    assert.equal(upstreamRequests.length, 3);
    const offeredNames = upstreamRequests.map((request) =>
      (request.tools as JsonRecord[]).map(
        (tool) => asRecord(tool.function).name,
      ),
    );
    assert.ok(
      !offeredNames[0].includes(
        'memory_bridge_memory_recall',
      ),
    );
    assert.ok(
      !offeredNames[1].includes(
        'memory_bridge_memory_update',
      ),
    );
    assert.ok(!offeredNames[2].includes('builtIn_mcpCallTool'));
  } finally {
    await close(bridge);
  }
});

test('模型列表把 model-only 条目 canonical，并丢弃冲突标识', async () => {
  let redirectMode: RequestRedirect | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    redirectMode = init?.redirect;
    return new Response(
      JSON.stringify({
        object: 'list',
        data: [
          {
            model: COMPAT_CHAT_MODEL,
            object: 'model',
            owned_by: 'local',
          },
          {
            id: 'unexpected-upstream-model',
            model: COMPAT_CHAT_MODEL,
            object: 'model',
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  try {
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/models`,
    );
    assert.equal(response.status, 200);
    const payload = asRecord(await response.json());
    assert.deepEqual(payload.data, [
      {
        model: COMPAT_CHAT_MODEL,
        id: COMPAT_CHAT_MODEL,
        object: 'model',
        owned_by: 'local',
      },
    ]);
    assert.equal(redirectMode, 'error');
  } finally {
    await close(bridge);
  }
});

test('上游重定向 fail closed 且重定向目标未被访问', async () => {
  let targetVisits = 0;
  const upstream = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(302, {
        Location: '/redirect-target',
      });
      response.end();
      return;
    }
    if (request.url === '/redirect-target') targetVisits += 1;
    response.writeHead(200, {
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify({ object: 'list', data: [] }));
  });
  const upstreamBase = await listen(upstream);
  const bridge = createCompatServer({
    upstreamBaseUrl: upstreamBase,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  try {
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/models`,
    );
    assert.equal(response.status, 502);
    assert.equal(targetVisits, 0);
  } finally {
    await close(bridge);
    await close(upstream);
  }
});

test('请求、上游响应和改写后最终 JSON 分别执行 5/10/10 MB 限制', async () => {
  let fetchCalls = 0;
  let mode: 'oversized-upstream' | 'expanded-final' =
    'oversized-upstream';
  const expandedContent = '\\'.repeat(1_500_000);
  const fetchImpl: typeof fetch = async () => {
    fetchCalls += 1;
    if (mode === 'oversized-upstream') {
      const oversized = 'x'.repeat(10 * 1024 * 1024 + 1);
      return new Response(oversized, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(oversized)),
        },
      });
    }
    return new Response(
      JSON.stringify(
        completionWithNamedToolArguments(
          'memory_bridge_memory_remember',
          {
            content: expandedContent,
            kind: 'project',
          },
        ),
      ),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  const endpoint =
    `${bridgeBase}/ollama-compat/v1/chat/completions`;

  try {
    const oversizedRequest = passThroughRequest();
    oversizedRequest.messages = [
      {
        role: 'user',
        content: 'x'.repeat(5 * 1024 * 1024),
      },
    ];
    const requestResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(oversizedRequest),
    });
    assert.equal(requestResponse.status, 413);
    assert.equal(fetchCalls, 0);

    const upstreamResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(passThroughRequest()),
    });
    assert.equal(upstreamResponse.status, 502);
    assert.match(await upstreamResponse.text(), /10 MB/);
    assert.equal(fetchCalls, 1);

    mode = 'expanded-final';
    const finalResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseRequest()),
    });
    assert.equal(finalResponse.status, 502);
    assert.match(await finalResponse.text(), /10 MB/);
    assert.equal(fetchCalls, 2);
  } finally {
    await close(bridge);
  }
});

test('结构化审计证明 schema/参数/响应改写且不泄露 prompt 或参数值', async () => {
  const requestSecret = 'PROMPT-SECRET-DO-NOT-LOG';
  const responseSecret = 'MEMORY-SECRET-DO-NOT-LOG';
  const audits: OllamaCompatAuditEvent[] = [];
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify(
        completionWithNamedToolArguments(
          'memory_bridge_memory_remember',
          {
            content: responseSecret,
            kind: 'project',
          },
        ),
      ),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: (event) => audits.push(structuredClone(event)),
  });
  const bridgeBase = await listen(bridge);
  try {
    const request = baseRequest();
    request.messages = [
      { role: 'user', content: requestSecret },
    ];
    const response = await fetch(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
    );
    assert.equal(response.status, 200);
    await response.arrayBuffer();

    assert.deepEqual(
      audits.map((event) => event.action),
      [
        'schema_rewrite',
        'memory_args_normalized',
        'response_tool_call_rewritten',
        'response_classification',
        'proxy_result',
      ],
    );
    assert.equal(new Set(audits.map((event) => event.requestId)).size, 1);
    assert.ok(
      audits.every(
        (event) =>
          event.model === COMPAT_CHAT_MODEL &&
          event.requestBytes > 0 &&
          event.responseBytes >= 0,
      ),
    );
    const normalize = audits.find(
      (event) => event.action === 'memory_args_normalized',
    );
    assert.deepEqual(normalize?.argumentKeys, ['content', 'kind']);
    assert.equal(
      normalize?.toolName,
      'memory-bridge::memory_remember',
    );
    const classification = audits.find(
      (event) => event.action === 'response_classification',
    );
    assert.equal(classification?.result, 'memory_alias_call');
    assert.equal(classification?.requestedStream, false);
    assert.equal(classification?.responseMode, 'json');
    assert.equal(classification?.offeredToolCount, 9);
    assert.equal(classification?.memoryAliasCount, 7);
    assert.equal(classification?.choiceCount, 1);
    assert.equal(classification?.toolCallCount, 1);
    assert.equal(classification?.assistantContentBytes, 0);
    assert.deepEqual(classification?.finishReasons, [
      'tool_calls',
    ]);
    assert.ok((classification?.upstreamBytes ?? 0) > 0);
    assert.ok((classification?.downstreamBytes ?? 0) > 0);
    const serializedAudits = JSON.stringify(audits);
    assert.doesNotMatch(serializedAudits, new RegExp(requestSecret));
    assert.doesNotMatch(serializedAudits, new RegExp(responseSecret));
  } finally {
    await close(bridge);
  }
});

test('脱敏响应分类区分普通回复、工具发现、记忆调用和非忆桥调用', async () => {
  const audits: OllamaCompatAuditEvent[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = asRecord(JSON.parse(String(init?.body)));
    const content = String(
      (request.messages as JsonRecord[])[0].content,
    );
    let completion: JsonRecord;
    if (content === 'plain') {
      completion = completionWithContent('普通回复');
    } else if (content === 'list') {
      completion = completionWithNamedToolArguments(
        'builtIn_mcpListTools',
        {},
      );
    } else if (content === 'memory') {
      completion = completionWithNamedToolArguments(
        'memory_bridge_memory_get_context',
        { query: '项目' },
      );
    } else {
      completion = completionWithNamedToolArguments(
        'memory_mcp_call_tool',
        {
          name: 'other-server::other_tool',
          arguments: '{"value":true}',
        },
      );
    }
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: (event) => audits.push(structuredClone(event)),
  });
  const bridgeBase = await listen(bridge);
  const endpoint =
    `${bridgeBase}/ollama-compat/v1/chat/completions`;

  try {
    for (const [content, stream] of [
      ['plain', false],
      ['list', false],
      ['memory', true],
      ['other', false],
    ] as const) {
      const request = baseRequest(stream);
      request.messages = [{ role: 'user', content }];
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }

    const classifications = audits.filter(
      (event) => event.action === 'response_classification',
    );
    assert.deepEqual(
      classifications.map((event) => event.result),
      [
        'plain_completion',
        'list_tools',
        'memory_alias_call',
        'non_memory_call',
      ],
    );
    assert.deepEqual(
      classifications.map((event) => event.toolCallCount),
      [0, 1, 1, 1],
    );
    assert.equal(
      classifications[0].assistantContentBytes,
      Buffer.byteLength('普通回复'),
    );
    assert.equal(classifications[2].responseMode, 'sse_replay');
    assert.equal(classifications[2].requestedStream, true);
  } finally {
    await close(bridge);
  }
});

test('SSE 任意单字节分片可跨 UTF-8 还原中文、多 choice/tool_calls，并拒绝非预期模型 chunk', async () => {
  let redirectMode: RequestRedirect | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    redirectMode = init?.redirect;
    const request = asRecord(JSON.parse(String(init?.body)));
    const content = String(
      (request.messages as JsonRecord[])[0].content,
    );
    const model = content.includes('return-unexpected-model')
      ? 'unexpected-upstream-model'
      : COMPAT_CHAT_MODEL;
    const chunk = {
      id: 'chunk-fragmented',
      object: 'chat.completion.chunk',
      created: 123,
      model,
      choices: [
        {
          index: 0,
          delta: { content: '中文跨 UTF-8🙂' },
          finish_reason: null,
        },
        {
          index: 1,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-other',
                type: 'function',
                function: {
                  name: 'otherTool',
                  arguments: '{"value":"中文"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
    const bytes = Buffer.from(
      `data: ${JSON.stringify(chunk)}\r\n\r\n` +
        'data: [DONE]\r\n\r\n',
      'utf8',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  const endpoint =
    `${bridgeBase}/ollama-compat/v1/chat/completions`;
  try {
    const request = passThroughRequest(true);
    request.messages = [
      { role: 'user', content: 'fragment-ok' },
    ];
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /中文跨 UTF-8🙂/u);
    assert.match(text, /data: \[DONE\]/u);
    const firstEvent = text
      .split(/\r?\n\r?\n/u)
      .find((event) => event.startsWith('data: {'));
    assert.ok(firstEvent);
    const parsed = asRecord(
      JSON.parse(firstEvent.slice('data: '.length)),
    );
    assert.equal((parsed.choices as JsonRecord[]).length, 2);
    const secondDelta = asRecord(
      (parsed.choices as JsonRecord[])[1].delta,
    );
    assert.equal(
      (secondDelta.tool_calls as JsonRecord[]).length,
      1,
    );
    assert.equal(redirectMode, 'error');

    const wrongRequest = passThroughRequest(true);
    wrongRequest.messages = [
      { role: 'user', content: 'return-unexpected-model' },
    ];
    const wrong = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wrongRequest),
    });
    assert.equal(wrong.status, 502);
    assert.doesNotMatch(await wrong.text(), /\[DONE\]/u);
  } finally {
    await close(bridge);
  }
});

test('并发请求的模型响应和审计 requestId 相互隔离', async () => {
  const audits: OllamaCompatAuditEvent[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = asRecord(JSON.parse(String(init?.body)));
    const content = String(
      (request.messages as JsonRecord[])[0].content,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, content === 'alpha' ? 30 : 1),
    );
    return new Response(
      JSON.stringify(completionWithContent(`reply:${content}`)),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: (event) => audits.push(structuredClone(event)),
  });
  const bridgeBase = await listen(bridge);
  const endpoint =
    `${bridgeBase}/ollama-compat/v1/chat/completions`;
  try {
    const makeRequest = (content: string) => {
      const request = passThroughRequest();
      request.messages = [{ role: 'user', content }];
      return request;
    };
    const [alphaResponse, betaResponse] = await Promise.all([
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeRequest('alpha')),
      }),
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makeRequest('beta')),
      }),
    ]);
    const alpha = asRecord(await alphaResponse.json());
    const beta = asRecord(await betaResponse.json());
    assert.equal(
      asRecord(
        (alpha.choices as JsonRecord[])[0].message,
      ).content,
      'reply:alpha',
    );
    assert.equal(
      asRecord(
        (beta.choices as JsonRecord[])[0].message,
      ).content,
      'reply:beta',
    );
    const results = audits.filter(
      (event) => event.action === 'proxy_result',
    );
    assert.equal(results.length, 2);
    assert.equal(
      new Set(results.map((event) => event.requestId)).size,
      2,
    );
  } finally {
    await close(bridge);
  }
});

test('上游 SSE 断流会关闭客户端且绝不伪造 [DONE]', async () => {
  const event = Buffer.from(
    `data: ${JSON.stringify({
      id: 'chunk-before-cut',
      object: 'chat.completion.chunk',
      created: 123,
      model: COMPAT_CHAT_MODEL,
      choices: [
        {
          index: 0,
          delta: { content: '断流前片段' },
          finish_reason: null,
        },
      ],
    })}\n\n`,
    'utf8',
  );
  let sent = false;
  const fetchImpl: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(event);
            await new Promise((resolve) =>
              setTimeout(resolve, 20),
            );
            return;
          }
          controller.error(new Error('upstream cut'));
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    fetchImpl,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  try {
    const result = await rawPostAllowDisconnect(
      new URL(
        '/ollama-compat/v1/chat/completions',
        bridgeBase,
      ),
      JSON.stringify(passThroughRequest(true)),
    );
    assert.equal(result.status, 200);
    assert.equal(result.completed, false);
    assert.match(result.body, /断流前片段/u);
    assert.doesNotMatch(result.body, /\[DONE\]/u);
  } finally {
    await close(bridge);
  }
});

test('客户端断开会立即取消仍在等待的上游 fetch', async () => {
  let startedResolve!: () => void;
  let abortedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    abortedResolve = resolve;
  });
  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    startedResolve();
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          abortedResolve();
          reject(signal.reason);
        },
        { once: true },
      );
    });
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 5_000,
    fetchImpl,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  const body = JSON.stringify(passThroughRequest());
  const client = http.request(
    `${bridgeBase}/ollama-compat/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
  );
  client.on('error', () => undefined);
  client.end(body);
  try {
    await started;
    client.destroy();
    await Promise.race([
      aborted,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('上游未因客户端断开而取消')),
          1_000,
        ),
      ),
    ]);
  } finally {
    client.destroy();
    await close(bridge);
  }
});

test('响应写入期间客户端 close 会取消上游 body，并唤醒 backpressure 等待', async () => {
  let cancelledResolve!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    cancelledResolve = resolve;
  });
  const largeChunk = {
    id: 'chunk-backpressure',
    object: 'chat.completion.chunk',
    created: 123,
    model: COMPAT_CHAT_MODEL,
    choices: [
      {
        index: 0,
        delta: { content: '流'.repeat(128 * 1024) },
        finish_reason: null,
      },
    ],
  };
  const event = Buffer.from(
    `data: ${JSON.stringify(largeChunk)}\n\n`,
    'utf8',
  );
  const fetchImpl: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(event);
        },
        cancel() {
          cancelledResolve();
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 5_000,
    fetchImpl,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  const body = JSON.stringify(passThroughRequest(true));
  let client: http.ClientRequest | undefined;
  try {
    client = http.request(
      `${bridgeBase}/ollama-compat/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.once('data', () => response.destroy());
      },
    );
    client.on('error', () => undefined);
    client.end(body);
    await Promise.race([
      cancelled,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                '响应 close 后上游 body 未取消或 backpressure 未唤醒',
              ),
            ),
          1_000,
        ),
      ),
    ]);
  } finally {
    client?.destroy();
    await close(bridge);
  }
});

test('timeout 会取消上游并返回 504，成功请求的 timer 会在 finally 清除', async () => {
  let fastSignal: AbortSignal | undefined;
  let slowSignal: AbortSignal | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    const request = asRecord(JSON.parse(String(init?.body)));
    const content = String(
      (request.messages as JsonRecord[])[0].content,
    );
    if (content === 'fast') {
      fastSignal = signal;
      return new Response(
        JSON.stringify(completionWithContent('fast-ok')),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    slowSignal = signal;
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(signal.reason),
        { once: true },
      );
    });
  };
  const bridge = createCompatServer({
    upstreamBaseUrl: 'http://127.0.0.1:11434',
    timeoutMs: 30,
    fetchImpl,
    audit: () => undefined,
  });
  const bridgeBase = await listen(bridge);
  const endpoint =
    `${bridgeBase}/ollama-compat/v1/chat/completions`;
  const requestFor = (content: string) => {
    const request = passThroughRequest();
    request.messages = [{ role: 'user', content }];
    return request;
  };
  try {
    const fast = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestFor('fast')),
    });
    assert.equal(fast.status, 200);
    await fast.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fastSignal?.aborted, false);

    const slow = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestFor('slow')),
    });
    assert.equal(slow.status, 504);
    assert.match(await slow.text(), /超时/u);
    assert.equal(slowSignal?.aborted, true);
  } finally {
    await close(bridge);
  }
});
