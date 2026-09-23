import { createHash, randomUUID } from 'node:crypto';
import type {
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import {
  IdentityBindingConflictError,
  type AuthenticatedPrincipal,
} from './identity.js';
import { isClientIdentityId } from './client-identity-contract.js';
import {
  ConversationIdentityConflictError,
} from './lifecycle-store.js';
import { parseCompatChatModel } from './config.js';

export const COMPAT_CHAT_MODEL = 'qwen2.5:14b';
export const OLLAMA_COMPAT_PREFIX = '/ollama-compat';
export const MEMORY_INTERNAL_CONTEXT_KEY =
  '_airiMemoryContextState';
export const MEMORY_INTERNAL_FACTS_KEY =
  '_airiMemoryGroundedFacts';
export const MEMORY_INTERNAL_CONTEXT_REASON_KEY =
  '_airiMemoryContextReason';
export const MEMORY_INTERNAL_TRACE_ID_KEY =
  '_airiMemoryTraceId';

export type MemoryContextReason =
  | 'explicit_query'
  | 'private_fact_query';

const COMPAT_CALL_TOOL = 'builtIn_mcpCallTool';
const COMPAT_LIST_TOOLS = 'builtIn_mcpListTools';
const AIRI_GENERIC_CALL_ALIAS = 'memory_mcp_call_tool';
const MEMORY_INTERNAL_REQUEST_KEY = '_memoryRequestKey';
const MEMORY_TOOL_PREFIX = 'memory-bridge::';
const MEMORY_ALIAS_PREFIX = 'memory_bridge_memory_';
const MAX_REQUEST_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

interface FieldRule {
  type:
    | 'string'
    | 'nullable-string'
    | 'number'
    | 'integer'
    | 'boolean'
    | 'string-array'
    | 'memory-kind-array';
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  itemMaxLength?: number;
  format?: 'uuid' | 'date-time';
}

interface ToolSpec {
  required: readonly string[];
  fields: Record<string, FieldRule>;
}

export interface OllamaCompatAuditEvent {
  action:
    | 'schema_rewrite'
    | 'memory_lifecycle'
    | 'memory_args_normalized'
    | 'response_tool_call_rewritten'
    | 'non_memory_args_rejected'
    | 'empty_completion_retry'
    | 'zero_recall_abstention'
    | 'grounded_recall_repair'
    | 'response_classification'
    | 'proxy_result';
  requestId: string;
  model: string;
  result: string;
  requestBytes: number;
  responseBytes: number;
  toolName?: string;
  argumentKeys?: string[];
  argumentsPresent?: boolean;
  argumentsType?: string;
  requestedStream?: boolean;
  responseMode?: 'json' | 'sse_replay';
  upstreamBytes?: number;
  downstreamBytes?: number;
  offeredToolCount?: number;
  memoryAliasCount?: number;
  choiceCount?: number;
  toolCallCount?: number;
  assistantContentBytes?: number;
  finishReasons?: string[];
  memoryContextReason?: MemoryContextReason;
  retrievalTraceId?: string;
}

export interface ChatLifecycle {
  beforeModel(
    input: Record<string, unknown>,
    requestId: string,
    identity?: LifecycleRequestContext,
  ):
    | Promise<Record<string, unknown>>
    | Record<string, unknown>;
  afterTurn(
    request: Record<string, unknown>,
    response: Record<string, unknown>,
    requestId: string,
    identity?: LifecycleRequestContext,
  ): Promise<void> | void;
  cancelTurn?(requestId: string): Promise<void> | void;
}

export interface AuthenticatedPrincipalContext {
  principalId: string;
  namespace: string;
  credentialId: string | null;
  authSource: string;
  trustedPrincipal?: AuthenticatedPrincipal;
}

export interface LifecycleRequestContext
  extends AuthenticatedPrincipalContext {
  clientName?: string;
  personaId: string | null;
  sessionId: string | null;
  roundId: string | null;
  projectId: string | null;
  identityStatus: 'complete' | 'degraded';
}

export interface OllamaProxyOptions {
  upstreamBaseUrl: string;
  chatModel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  audit?: (event: OllamaCompatAuditEvent) => void;
  lifecycle?: ChatLifecycle;
  authenticatedPrincipal?: AuthenticatedPrincipalContext;
}

function configuredChatModel(
  options: OllamaProxyOptions,
): string {
  return parseCompatChatModel(options.chatModel);
}

export class OllamaCompatibilityError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'OllamaCompatibilityError';
  }
}

function emitAudit(
  options: OllamaProxyOptions,
  event: OllamaCompatAuditEvent,
): void {
  try {
    if (options.audit) {
      options.audit(event);
      return;
    }
    console.info(
      `[ollama-compat] ${JSON.stringify(event)}`,
    );
  } catch {
    // 审计输出故障不能改变代理结果，且这里不得回退打印业务数据。
  }
}

const MEMORY_KINDS = [
  'profile',
  'preference',
  'project',
  'event',
  'knowledge',
  'relationship',
  'instruction',
] as const;

const stringRule = (
  constraints: Omit<FieldRule, 'type'> = {},
): FieldRule => ({ type: 'string', ...constraints });
const nullableStringRule = (
  constraints: Omit<FieldRule, 'type'> = {},
): FieldRule => ({ type: 'nullable-string', ...constraints });
const numberRule = (
  minimum?: number,
  maximum?: number,
): FieldRule => ({ type: 'number', minimum, maximum });
const integerRule = (
  minimum?: number,
  maximum?: number,
): FieldRule => ({ type: 'integer', minimum, maximum });
const booleanRule = (): FieldRule => ({ type: 'boolean' });
const stringArrayRule = (
  constraints: Omit<FieldRule, 'type'> = {},
): FieldRule => ({ type: 'string-array', ...constraints });
const memoryKindRule = (): FieldRule => ({
  type: 'string',
  enum: MEMORY_KINDS,
});
const memoryKindArrayRule = (): FieldRule => ({
  type: 'memory-kind-array',
});
const uuidRule = (): FieldRule =>
  stringRule({ format: 'uuid' });
const dateTimeRule = (): FieldRule =>
  stringRule({ format: 'date-time' });
const nullableDateTimeRule = (): FieldRule =>
  nullableStringRule({ format: 'date-time' });

const sharedMemoryFields = {
  namespace: stringRule({ maxLength: 100 }),
  kind: memoryKindRule(),
  title: stringRule({ maxLength: 100 }),
  summary: stringRule({ maxLength: 500 }),
  tags: stringArrayRule({
    maxItems: 30,
    itemMaxLength: 50,
  }),
  importance: numberRule(0, 1),
  confidence: numberRule(0, 1),
  source: stringRule({ maxLength: 100 }),
  sourceRef: stringRule({ maxLength: 500 }),
  occurredAt: dateTimeRule(),
  validFrom: dateTimeRule(),
  validTo: dateTimeRule(),
} satisfies Record<string, FieldRule>;

const MEMORY_TOOL_SPECS = {
  'memory-bridge::memory_remember': {
    required: ['content', 'kind'],
    fields: {
      content: stringRule({ minLength: 1 }),
      ...sharedMemoryFields,
      supersedesId: uuidRule(),
      idempotencyKey: stringRule({ maxLength: 200 }),
    },
  },
  'memory-bridge::memory_recall': {
    required: ['query'],
    fields: {
      query: stringRule({ minLength: 1 }),
      namespace: stringRule(),
      kinds: memoryKindArrayRule(),
      tags: stringArrayRule(),
      limit: integerRule(1, 30),
      minScore: numberRule(0, 1),
      includeArchived: booleanRule(),
    },
  },
  'memory-bridge::memory_get_context': {
    required: ['query'],
    fields: {
      query: stringRule({ minLength: 1 }),
      namespace: stringRule(),
      kinds: memoryKindArrayRule(),
      tags: stringArrayRule(),
      limit: integerRule(1, 20),
      minScore: numberRule(0, 1),
    },
  },
  'memory-bridge::memory_update': {
    required: ['id'],
    fields: {
      id: uuidRule(),
      content: stringRule({ minLength: 1 }),
      ...sharedMemoryFields,
      sourceRef: nullableStringRule({ maxLength: 500 }),
      occurredAt: nullableDateTimeRule(),
      validFrom: nullableDateTimeRule(),
      validTo: nullableDateTimeRule(),
      status: {
        type: 'string',
        enum: ['active', 'archived', 'superseded'],
      },
    },
  },
  'memory-bridge::memory_forget': {
    required: ['id'],
    fields: {
      id: uuidRule(),
      reason: stringRule({ maxLength: 300 }),
    },
  },
  'memory-bridge::memory_list': {
    required: [],
    fields: {
      query: stringRule(),
      namespace: stringRule(),
      kind: memoryKindRule(),
      status: {
        type: 'string',
        enum: ['active', 'superseded', 'archived', 'deleted'],
      },
      tag: stringRule(),
      limit: integerRule(1, 200),
      offset: integerRule(0),
    },
  },
  'memory-bridge::memory_stats': {
    required: [],
    fields: {},
  },
} satisfies Record<string, ToolSpec>;

type MemoryToolName = keyof typeof MEMORY_TOOL_SPECS;

const MEMORY_TOOL_ALIASES: Record<MemoryToolName, string> = {
  'memory-bridge::memory_remember':
    'memory_bridge_memory_remember',
  'memory-bridge::memory_recall':
    'memory_bridge_memory_recall',
  'memory-bridge::memory_get_context':
    'memory_bridge_memory_get_context',
  'memory-bridge::memory_update':
    'memory_bridge_memory_update',
  'memory-bridge::memory_forget':
    'memory_bridge_memory_forget',
  'memory-bridge::memory_list':
    'memory_bridge_memory_list',
  'memory-bridge::memory_stats':
    'memory_bridge_memory_stats',
};

const MEMORY_TOOL_DESCRIPTIONS: Record<MemoryToolName, string> = {
  'memory-bridge::memory_remember':
    'Store a durable user fact, preference, project detail, event, ' +
    'relationship, knowledge item, or instruction in long-term memory.',
  'memory-bridge::memory_recall':
    'Search long-term memory and return scored matching memory records.',
  'memory-bridge::memory_get_context':
    'Retrieve formatted long-term memory context relevant to the ' +
    'current user request before answering.',
  'memory-bridge::memory_update':
    'Correct or update an existing long-term memory identified by UUID.',
  'memory-bridge::memory_forget':
    'Forget an existing long-term memory identified by UUID when the ' +
    'user explicitly asks to remove it.',
  'memory-bridge::memory_list':
    'List long-term memories using optional filters and pagination.',
  'memory-bridge::memory_stats':
    'Return aggregate long-term memory statistics.',
};

const MEMORY_ALIAS_TO_TOOL = new Map<string, MemoryToolName>(
  Object.entries(MEMORY_TOOL_ALIASES).map(
    ([toolName, alias]) => [alias, toolName as MemoryToolName],
  ),
);

const MEMORY_QUERY_TOOLS = new Set<MemoryToolName>([
  'memory-bridge::memory_recall',
  'memory-bridge::memory_get_context',
  'memory-bridge::memory_list',
  'memory-bridge::memory_stats',
]);

const MEMORY_MUTATION_TOOLS = new Set<MemoryToolName>([
  'memory-bridge::memory_remember',
  'memory-bridge::memory_update',
  'memory-bridge::memory_forget',
]);

function isMemoryToolName(value: string): value is MemoryToolName {
  return hasOwn(MEMORY_TOOL_SPECS, value);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(
  record: JsonRecord,
  key: PropertyKey,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nullPrototypeRecord(
  source?: JsonRecord,
): JsonRecord {
  const result = Object.create(null) as JsonRecord;
  if (source) {
    for (const [key, value] of Object.entries(source)) {
      result[key] = value;
    }
  }
  return result;
}

function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (!isJsonRecord(value)) return value;
    return nullPrototypeRecord(value);
  }) as unknown;
}

function schemaForRule(rule: FieldRule): JsonRecord {
  const schema: JsonRecord = {};
  switch (rule.type) {
    case 'nullable-string':
      schema.type = ['string', 'null'];
      break;
    case 'string-array':
      schema.type = 'array';
      schema.items = {
        type: 'string',
        ...(rule.itemMaxLength === undefined
          ? {}
          : { maxLength: rule.itemMaxLength }),
      };
      break;
    case 'memory-kind-array':
      schema.type = 'array';
      schema.items = { type: 'string', enum: [...MEMORY_KINDS] };
      break;
    default:
      schema.type = rule.type;
  }
  if (rule.enum) schema.enum = [...rule.enum];
  if (rule.minimum !== undefined) schema.minimum = rule.minimum;
  if (rule.maximum !== undefined) schema.maximum = rule.maximum;
  if (rule.minLength !== undefined) {
    schema.minLength = rule.minLength;
  }
  if (rule.maxLength !== undefined) {
    schema.maxLength = rule.maxLength;
  }
  if (rule.maxItems !== undefined) schema.maxItems = rule.maxItems;
  if (rule.format !== undefined) schema.format = rule.format;
  return schema;
}

function memoryToolParameters(toolName: MemoryToolName): JsonRecord {
  const spec = MEMORY_TOOL_SPECS[toolName];
  const properties: JsonRecord = {};
  for (const [name, rule] of Object.entries(spec.fields)) {
    properties[name] = schemaForRule(rule);
  }
  return {
    type: 'object',
    properties,
    required: [...spec.required],
    additionalProperties: false,
  };
}

function memoryAliasTool(toolName: MemoryToolName): JsonRecord {
  return {
    type: 'function',
    function: {
      name: MEMORY_TOOL_ALIASES[toolName],
      description: MEMORY_TOOL_DESCRIPTIONS[toolName],
      parameters: memoryToolParameters(toolName),
    },
  };
}

function genericCallAliasTool(): JsonRecord {
  return {
    type: 'function',
    function: {
      name: AIRI_GENERIC_CALL_ALIAS,
      description:
        'Call an MCP tool that has no dedicated function. Do not use ' +
        'this fallback for memory-bridge tools.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Full MCP tool name in "<serverName>::<toolName>" format.',
          },
          arguments: {
            type: 'string',
            description: 'Serialized JSON object for the MCP tool.',
          },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
  };
}

function canonicalAliasTools(): JsonRecord[] {
  return [
    ...(Object.keys(MEMORY_TOOL_SPECS) as MemoryToolName[]).map(
      memoryAliasTool,
    ),
    genericCallAliasTool(),
  ];
}

function toolFunction(tool: unknown): JsonRecord | undefined {
  if (
    !isJsonRecord(tool) ||
    !hasOwn(tool, 'type') ||
    tool.type !== 'function' ||
    !hasOwn(tool, 'function') ||
    !isJsonRecord(tool.function)
  ) {
    return undefined;
  }
  return tool.function;
}

function toolFunctionName(tool: unknown): string | undefined {
  const fn = toolFunction(tool);
  return fn &&
    hasOwn(fn, 'name') &&
    typeof fn.name === 'string'
    ? fn.name
    : undefined;
}

const RESERVED_ALIAS_NAMES = new Set([
  ...Object.values(MEMORY_TOOL_ALIASES),
  AIRI_GENERIC_CALL_ALIAS,
]);

function hasCanonicalAliasSuite(tools: unknown[]): boolean {
  const expected = canonicalAliasTools();
  const reserved = tools.filter((tool) => {
    const name = toolFunctionName(tool);
    return name !== undefined && RESERVED_ALIAS_NAMES.has(name);
  });
  if (reserved.length !== expected.length) return false;

  return expected.every((expectedTool) => {
    const expectedName = toolFunctionName(expectedTool);
    const matches = reserved.filter(
      (tool) => toolFunctionName(tool) === expectedName,
    );
    return (
      matches.length === 1 &&
      JSON.stringify(matches[0]) === JSON.stringify(expectedTool)
    );
  });
}

function stripInternalMemoryRequestKey(
  outer: JsonRecord,
): JsonRecord {
  if (!hasOwn(outer, 'arguments')) return outer;
  const inner = parseFunctionArguments(outer.arguments);
  if (!hasOwn(inner, MEMORY_INTERNAL_REQUEST_KEY)) return outer;
  const requestKey = inner[MEMORY_INTERNAL_REQUEST_KEY];
  if (
    typeof requestKey !== 'string' ||
    requestKey.length === 0 ||
    requestKey.length > 128
  ) {
    throw new OllamaCompatibilityError(
      'AIRI 内部记忆请求键无效',
    );
  }
  delete inner[MEMORY_INTERNAL_REQUEST_KEY];
  const stripped = nullPrototypeRecord(outer);
  stripped.arguments = JSON.stringify(inner);
  return stripped;
}

function rewriteHistoricalToolCall(toolCall: unknown): void {
  validateToolCall(toolCall);
  const fn = toolCall.function;
  const functionName = fn.name as string;

  if (functionName === COMPAT_CALL_TOOL) {
    const outer = parseFunctionArguments(fn.arguments);
    if (!hasOwn(outer, 'name') || typeof outer.name !== 'string') {
      throw new OllamaCompatibilityError(
        '历史 builtIn_mcpCallTool 缺少字符串类型的 name',
        400,
      );
    }
    if (outer.name.startsWith(MEMORY_TOOL_PREFIX)) {
      const stripped = stripInternalMemoryRequestKey(outer);
      const normalized = normalizeMemoryToolArguments(
        outer.name,
        stripped,
      );
      fn.name =
        MEMORY_TOOL_ALIASES[outer.name as MemoryToolName];
      fn.arguments = normalized.serialized;
      return;
    }
    validateNonMemoryOuterArguments(outer);
    fn.name = AIRI_GENERIC_CALL_ALIAS;
    fn.arguments = JSON.stringify(outer);
    return;
  }

  const memoryToolName = MEMORY_ALIAS_TO_TOOL.get(functionName);
  if (memoryToolName !== undefined) {
    const stripped = stripInternalMemoryRequestKey({
      name: memoryToolName,
      arguments: fn.arguments,
    });
    const normalized = normalizeMemoryToolArguments(
      memoryToolName,
      stripped,
    );
    fn.arguments = normalized.serialized;
    return;
  }

  if (functionName === AIRI_GENERIC_CALL_ALIAS) {
    const outer = parseFunctionArguments(fn.arguments);
    if (
      hasOwn(outer, 'name') &&
      typeof outer.name === 'string' &&
      outer.name.startsWith(MEMORY_TOOL_PREFIX)
    ) {
      throw new OllamaCompatibilityError(
        '非忆桥回退工具不能调用忆桥',
      );
    }
    validateNonMemoryOuterArguments(outer);
    fn.arguments = JSON.stringify(outer);
    return;
  }

  if (functionName.startsWith(MEMORY_ALIAS_PREFIX)) {
    throw new OllamaCompatibilityError(
      `不支持的忆桥工具别名：${functionName}`,
    );
  }
}

function rewriteHistoricalToolCalls(body: JsonRecord): void {
  if (!hasOwn(body, 'messages')) return;
  if (!Array.isArray(body.messages)) {
    throw new OllamaCompatibilityError(
      'AIRI 聊天请求的 messages 必须是数组',
      400,
    );
  }
  for (const message of body.messages) {
    if (
      !isJsonRecord(message) ||
      message.role !== 'assistant' ||
      !hasOwn(message, 'tool_calls')
    ) {
      continue;
    }
    if (!Array.isArray(message.tool_calls)) {
      throw new OllamaCompatibilityError(
        'AIRI 历史 tool_calls 必须是数组',
        400,
      );
    }
    for (const toolCall of message.tool_calls) {
      try {
        rewriteHistoricalToolCall(toolCall);
      } catch (error) {
        if (error instanceof OllamaCompatibilityError) {
          throw new OllamaCompatibilityError(
            `AIRI 历史工具调用无效：${error.message}`,
            400,
          );
        }
        throw error;
      }
    }
  }
}

function historicalMemoryTools(
  body: JsonRecord,
): Set<MemoryToolName> {
  const result = new Set<MemoryToolName>();
  if (!Array.isArray(body.messages)) return result;
  let currentTurnStart = 0;
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index];
    if (isJsonRecord(message) && message.role === 'user') {
      currentTurnStart = index + 1;
      break;
    }
  }
  for (const message of body.messages.slice(currentTurnStart)) {
    if (
      !isJsonRecord(message) ||
      message.role !== 'assistant' ||
      !Array.isArray(message.tool_calls)
    ) {
      continue;
    }
    for (const toolCall of message.tool_calls) {
      if (!isJsonRecord(toolCall)) continue;
      const fn = toolFunction(toolCall);
      if (!fn || typeof fn.name !== 'string') continue;
      const toolName = MEMORY_ALIAS_TO_TOOL.get(fn.name);
      if (toolName !== undefined) result.add(toolName);
    }
  }
  return result;
}

function restrictRepeatedMemoryTools(body: JsonRecord): void {
  if (!Array.isArray(body.tools)) return;
  const history = historicalMemoryTools(body);
  if (history.size === 0) return;
  const hasMutation = [...history].some((toolName) =>
    MEMORY_MUTATION_TOOLS.has(toolName),
  );
  const blocked = hasMutation
    ? new Set<MemoryToolName>(
        Object.keys(MEMORY_TOOL_SPECS) as MemoryToolName[],
      )
    : MEMORY_QUERY_TOOLS;

  body.tools = body.tools.filter((tool) => {
    const functionName = toolFunctionName(tool);
    if (functionName === COMPAT_LIST_TOOLS) return false;
    if (functionName === undefined) return true;
    const memoryToolName =
      MEMORY_ALIAS_TO_TOOL.get(functionName);
    return (
      memoryToolName === undefined ||
      !blocked.has(memoryToolName)
    );
  });
}

export function rewriteChatRequest(input: unknown): {
  body: JsonRecord;
  adapted: boolean;
} {
  if (!isJsonRecord(input)) {
    throw new OllamaCompatibilityError(
      'AIRI 聊天请求必须是 JSON 对象',
      400,
    );
  }

  const body = structuredClone(input);
  if (!hasOwn(body, 'tools')) {
    return { body, adapted: false };
  }
  if (!Array.isArray(body.tools)) {
    throw new OllamaCompatibilityError(
      'AIRI 聊天请求的 tools 必须是数组',
      400,
    );
  }

  const callToolIndexes = body.tools.flatMap((tool, index) =>
    toolFunctionName(tool) === COMPAT_CALL_TOOL ? [index] : [],
  );
  const reservedAliasCount = body.tools.filter((tool) => {
    const name = toolFunctionName(tool);
    return name !== undefined && RESERVED_ALIAS_NAMES.has(name);
  }).length;

  if (callToolIndexes.length === 0) {
    if (reservedAliasCount === 0) {
      return { body, adapted: false };
    }
    if (!hasCanonicalAliasSuite(body.tools)) {
      throw new OllamaCompatibilityError(
        'AIRI 请求包含忆桥保留工具别名冲突',
        400,
      );
    }
    rewriteHistoricalToolCalls(body);
    restrictRepeatedMemoryTools(body);
    return { body, adapted: true };
  }

  if (callToolIndexes.length !== 1 || reservedAliasCount > 0) {
    throw new OllamaCompatibilityError(
      'AIRI 请求包含忆桥保留工具别名冲突',
      400,
    );
  }

  const callToolIndex = callToolIndexes[0];
  body.tools.splice(callToolIndex, 1, ...canonicalAliasTools());
  rewriteHistoricalToolCalls(body);
  restrictRepeatedMemoryTools(body);
  return { body, adapted: true };
}

function suppressLifecycleMemoryAliases(
  body: JsonRecord,
  contextState: 'grounded' | 'empty' | null,
): void {
  if (!Array.isArray(body.tools)) return;
  if (contextState === 'empty') {
    body.tools = [];
    body.tool_choice = 'none';
    return;
  }
  body.tools = body.tools.filter((tool) => {
    const name = toolFunctionName(tool);
    if (name !== undefined && MEMORY_ALIAS_TO_TOOL.has(name)) {
      return false;
    }
    if (
      contextState === 'grounded' &&
      (name === AIRI_GENERIC_CALL_ALIAS || name === COMPAT_LIST_TOOLS)
    ) {
      return false;
    }
    return true;
  });
}

function parseFunctionArguments(value: unknown): JsonRecord {
  if (isJsonRecord(value)) return nullPrototypeRecord(value);
  if (typeof value !== 'string') {
    throw new OllamaCompatibilityError(
      '模型返回的工具参数不是 JSON 对象或 JSON 字符串',
    );
  }
  try {
    const parsed = parseJson(value);
    if (!isJsonRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new OllamaCompatibilityError(
      '模型返回的工具参数不是有效的 JSON 对象',
    );
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UTC_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u;

function isValidUtcDateTime(value: string): boolean {
  const match = UTC_DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(value);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour) &&
    parsed.getUTCMinutes() === Number(minute) &&
    parsed.getUTCSeconds() === Number(second)
  );
}

function fieldValueIsValid(value: unknown, rule: FieldRule): boolean {
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') return false;
      break;
    case 'nullable-string':
      if (value === null) return true;
      if (typeof value !== 'string') return false;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return false;
      }
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return false;
      }
      break;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string-array':
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === 'string')
      ) {
        return false;
      }
      break;
    case 'memory-kind-array':
      if (
        !Array.isArray(value) ||
        !value.every(
          (item) =>
            typeof item === 'string' &&
            MEMORY_KINDS.includes(item as typeof MEMORY_KINDS[number]),
        )
      ) {
        return false;
      }
      break;
  }

  if (typeof value === 'string') {
    if (
      rule.minLength !== undefined &&
      value.length < rule.minLength
    ) {
      return false;
    }
    if (
      rule.maxLength !== undefined &&
      value.length > rule.maxLength
    ) {
      return false;
    }
    if (rule.format === 'uuid' && !UUID_PATTERN.test(value)) {
      return false;
    }
    if (
      rule.format === 'date-time' &&
      !isValidUtcDateTime(value)
    ) {
      return false;
    }
  }
  if (Array.isArray(value)) {
    if (
      rule.maxItems !== undefined &&
      value.length > rule.maxItems
    ) {
      return false;
    }
    if (
      rule.itemMaxLength !== undefined &&
      value.some(
        (item) =>
          typeof item !== 'string' ||
          item.length > rule.itemMaxLength!,
      )
    ) {
      return false;
    }
  }
  if (
    rule.enum &&
    !rule.enum.includes(value as string)
  ) {
    return false;
  }
  if (
    typeof value === 'number' &&
    rule.minimum !== undefined &&
    value < rule.minimum
  ) {
    return false;
  }
  if (
    typeof value === 'number' &&
    rule.maximum !== undefined &&
    value > rule.maximum
  ) {
    return false;
  }
  return true;
}

type ToolRewriteObserver = (
  action:
    | 'memory_args_normalized'
    | 'response_tool_call_rewritten'
    | 'non_memory_args_rejected',
  detail: {
    toolName: string;
    argumentKeys: string[];
    argumentsPresent?: boolean;
    argumentsType?: string;
  },
) => void;

function jsonValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (isJsonRecord(value)) return 'object';
  return typeof value;
}

function normalizeMemoryToolArguments(
  toolName: string,
  outer: JsonRecord,
  observer?: ToolRewriteObserver,
): {
  serialized: string;
  argumentKeys: string[];
} {
  if (!isMemoryToolName(toolName)) {
    throw new OllamaCompatibilityError(
      `不支持的忆桥工具：${toolName}`,
    );
  }
  const spec = MEMORY_TOOL_SPECS[toolName];
  const fields = spec.fields as Record<string, FieldRule>;

  const flatKeys = Object.keys(outer).filter(
    (key) => key !== 'name' && key !== 'arguments',
  );
  let inner: JsonRecord;

  if (hasOwn(outer, 'arguments')) {
    if (flatKeys.length > 0) {
      throw new OllamaCompatibilityError(
        '模型同时返回了 arguments 和扁平参数，已拒绝猜测合并',
      );
    }
    inner = parseFunctionArguments(outer.arguments);
  } else {
    inner = nullPrototypeRecord();
    for (const key of flatKeys) {
      inner[key] = outer[key];
    }
  }

  for (const key of Object.keys(inner)) {
    if (!hasOwn(fields, key)) {
      throw new OllamaCompatibilityError(
        `${toolName} 包含未知参数：${key}`,
      );
    }
    const rule = fields[key];
    if (!fieldValueIsValid(inner[key], rule)) {
      throw new OllamaCompatibilityError(
        `${toolName} 的参数 ${key} 类型或范围无效`,
      );
    }
  }

  for (const required of spec.required) {
    if (!hasOwn(inner, required)) {
      throw new OllamaCompatibilityError(
        `${toolName} 缺少必填参数：${required}`,
      );
    }
  }

  const argumentKeys = Object.keys(inner).sort();
  observer?.('memory_args_normalized', {
    toolName,
    argumentKeys,
  });
  return {
    serialized: JSON.stringify(inner),
    argumentKeys,
  };
}

function validateToolCall(
  toolCall: unknown,
): asserts toolCall is JsonRecord & { function: JsonRecord } {
  if (
    !isJsonRecord(toolCall) ||
    (hasOwn(toolCall, 'type') && toolCall.type !== 'function') ||
    !hasOwn(toolCall, 'function') ||
    !isJsonRecord(toolCall.function) ||
    !hasOwn(toolCall.function, 'name') ||
    typeof toolCall.function.name !== 'string' ||
    !hasOwn(toolCall.function, 'arguments') ||
    (typeof toolCall.function.arguments !== 'string' &&
      !isJsonRecord(toolCall.function.arguments))
  ) {
    throw new OllamaCompatibilityError(
      'Ollama 返回的 tool_calls 结构无效',
    );
  }
}

function validateNonMemoryOuterArguments(
  outer: JsonRecord,
  observer?: ToolRewriteObserver,
): void {
  const keys = Object.keys(outer);
  const argumentsValue = outer.arguments;
  if (
    !hasOwn(outer, 'name') ||
    typeof outer.name !== 'string' ||
    !hasOwn(outer, 'arguments') ||
    (typeof argumentsValue !== 'string' &&
      !isJsonRecord(argumentsValue)) ||
    keys.some((key) => key !== 'name' && key !== 'arguments')
  ) {
    observer?.('non_memory_args_rejected', {
      toolName:
        typeof outer.name === 'string'
          ? outer.name.slice(0, 128)
          : '<non-string>',
      argumentKeys: keys.sort().slice(0, 64),
      argumentsPresent: hasOwn(outer, 'arguments'),
      argumentsType: jsonValueType(argumentsValue),
    });
    throw new OllamaCompatibilityError(
      '非忆桥 MCP 工具必须包含字符串 name 和 JSON 字符串或对象 arguments',
    );
  }
  if (isJsonRecord(argumentsValue)) {
    outer.arguments = JSON.stringify(argumentsValue);
  }
}

function rewriteToolCall(
  toolCall: unknown,
  observer?: ToolRewriteObserver,
): boolean {
  validateToolCall(toolCall);
  const fn = toolCall.function;
  const functionName = fn.name as string;
  const aliasedMemoryTool =
    MEMORY_ALIAS_TO_TOOL.get(functionName);

  if (aliasedMemoryTool !== undefined) {
    const normalized = normalizeMemoryToolArguments(
      aliasedMemoryTool,
      {
        name: aliasedMemoryTool,
        arguments: fn.arguments,
      },
      observer,
    );
    fn.name = COMPAT_CALL_TOOL;
    fn.arguments = JSON.stringify({
      name: aliasedMemoryTool,
      arguments: normalized.serialized,
    });
    observer?.('response_tool_call_rewritten', {
      toolName: aliasedMemoryTool,
      argumentKeys: normalized.argumentKeys,
    });
    return true;
  }

  if (
    functionName !== COMPAT_CALL_TOOL &&
    functionName !== AIRI_GENERIC_CALL_ALIAS
  ) {
    if (functionName.startsWith(MEMORY_ALIAS_PREFIX)) {
      throw new OllamaCompatibilityError(
        `不支持的忆桥工具别名：${functionName}`,
      );
    }
    return false;
  }

  const outer = parseFunctionArguments(fn.arguments);
  if (!hasOwn(outer, 'name') || typeof outer.name !== 'string') {
    throw new OllamaCompatibilityError(
      `${functionName} 缺少字符串类型的 name`,
    );
  }
  if (
    functionName === AIRI_GENERIC_CALL_ALIAS &&
    outer.name.startsWith(MEMORY_TOOL_PREFIX)
  ) {
    throw new OllamaCompatibilityError(
      '非忆桥回退工具不能调用忆桥',
    );
  }

  if (!outer.name.startsWith(MEMORY_TOOL_PREFIX)) {
    validateNonMemoryOuterArguments(outer, observer);
    fn.name = COMPAT_CALL_TOOL;
    fn.arguments = JSON.stringify(outer);
    return true;
  }

  const normalized = normalizeMemoryToolArguments(
    outer.name,
    outer,
    observer,
  );
  fn.name = COMPAT_CALL_TOOL;
  fn.arguments = JSON.stringify({
    name: outer.name,
    arguments: normalized.serialized,
  });
  observer?.('response_tool_call_rewritten', {
    toolName: outer.name,
    argumentKeys: normalized.argumentKeys,
  });
  return true;
}

function validateChatCompletion(
  input: unknown,
  expectedModel = COMPAT_CHAT_MODEL,
): asserts input is JsonRecord & { choices: unknown[] } {
  if (
    !isJsonRecord(input) ||
    !hasOwn(input, 'model') ||
    input.model !== expectedModel ||
    !hasOwn(input, 'choices') ||
    !Array.isArray(input.choices) ||
    input.choices.length === 0
  ) {
    throw new OllamaCompatibilityError(
      'Ollama 返回的聊天响应结构无效',
    );
  }

  for (const choice of input.choices) {
    if (
      !isJsonRecord(choice) ||
      !hasOwn(choice, 'message') ||
      !isJsonRecord(choice.message)
    ) {
      throw new OllamaCompatibilityError(
        '聊天响应 choice 缺少有效 message',
      );
    }
    if (!hasOwn(choice.message, 'tool_calls')) continue;
    const toolCalls = choice.message.tool_calls;
    if (toolCalls === null) continue;
    if (!Array.isArray(toolCalls)) {
      throw new OllamaCompatibilityError(
        'Ollama 返回的 tool_calls 结构无效',
      );
    }
    for (const toolCall of toolCalls) {
      validateToolCall(toolCall);
    }
  }
}

function validateCompletionUsesOfferedTools(
  input: unknown,
  offeredToolNames: ReadonlySet<string>,
  expectedModel = COMPAT_CHAT_MODEL,
): void {
  validateChatCompletion(input, expectedModel);
  for (const choice of input.choices) {
    if (
      !isJsonRecord(choice) ||
      !isJsonRecord(choice.message) ||
      !Array.isArray(choice.message.tool_calls)
    ) {
      continue;
    }
    for (const toolCall of choice.message.tool_calls) {
      validateToolCall(toolCall);
      const functionName = toolCall.function.name as string;
      if (!offeredToolNames.has(functionName)) {
        throw new OllamaCompatibilityError(
          'Ollama 返回了本轮没有提供的工具调用',
        );
      }
    }
  }
}

export function rewriteChatResponse(
  input: unknown,
  observer?: ToolRewriteObserver,
  expectedModel = COMPAT_CHAT_MODEL,
): JsonRecord {
  validateChatCompletion(input, expectedModel);
  const body = structuredClone(input);
  for (const choice of body.choices as unknown[]) {
    if (!isJsonRecord(choice) || !isJsonRecord(choice.message)) continue;
    if (!Array.isArray(choice.message.tool_calls)) continue;
    let rewroteAiriToolCall = false;
    for (const toolCall of choice.message.tool_calls) {
      rewroteAiriToolCall =
        rewriteToolCall(toolCall, observer) ||
        rewroteAiriToolCall;
    }
    if (
      rewroteAiriToolCall &&
      (!hasOwn(choice, 'finish_reason') ||
        choice.finish_reason === null ||
        choice.finish_reason === 'stop')
    ) {
      choice.finish_reason = 'tool_calls';
    }
  }
  return body;
}

function attachMemoryRequestKeys(
  input: JsonRecord,
  proxyRequestId: string,
  expectedModel = COMPAT_CHAT_MODEL,
): void {
  validateChatCompletion(input, expectedModel);
  for (const choice of input.choices) {
    if (
      !isJsonRecord(choice) ||
      !isJsonRecord(choice.message) ||
      !Array.isArray(choice.message.tool_calls)
    ) {
      continue;
    }
    for (const toolCall of choice.message.tool_calls) {
      validateToolCall(toolCall);
      const fn = toolCall.function;
      if (fn.name !== COMPAT_CALL_TOOL) continue;
      const outer = parseFunctionArguments(fn.arguments);
      if (
        !hasOwn(outer, 'name') ||
        typeof outer.name !== 'string' ||
        !isMemoryToolName(outer.name)
      ) {
        continue;
      }
      const inner = parseFunctionArguments(outer.arguments);
      if (hasOwn(inner, MEMORY_INTERNAL_REQUEST_KEY)) {
        throw new OllamaCompatibilityError(
          '模型不得提供 AIRI 内部记忆请求键',
        );
      }
      const toolCallId =
        hasOwn(toolCall, 'id') &&
        typeof toolCall.id === 'string' &&
        toolCall.id.length > 0
          ? toolCall.id
          : randomUUID();
      inner[MEMORY_INTERNAL_REQUEST_KEY] = createHash('sha256')
        .update(proxyRequestId)
        .update('\0')
        .update(toolCallId)
        .digest('hex');
      outer.arguments = JSON.stringify(inner);
      fn.arguments = JSON.stringify(outer);
    }
  }
}

type ResponseClassification =
  | 'plain_completion'
  | 'list_tools'
  | 'memory_alias_call'
  | 'non_memory_call';

interface CompletionAuditSummary {
  classification: ResponseClassification;
  choiceCount: number;
  toolCallCount: number;
  assistantContentBytes: number;
  finishReasons: string[];
}

function safeFinishReason(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (
    value === 'stop' ||
    value === 'tool_calls' ||
    value === 'length' ||
    value === 'content_filter' ||
    value === 'function_call'
  ) {
    return value;
  }
  return 'other';
}

function classifyChatCompletion(
  input: unknown,
  expectedModel = COMPAT_CHAT_MODEL,
): CompletionAuditSummary {
  validateChatCompletion(input, expectedModel);
  let toolCallCount = 0;
  let assistantContentBytes = 0;
  let memoryCalls = 0;
  let listCalls = 0;
  let nonMemoryCalls = 0;
  const finishReasons: string[] = [];

  for (const choice of input.choices) {
    if (!isJsonRecord(choice) || !isJsonRecord(choice.message)) {
      continue;
    }
    finishReasons.push(
      safeFinishReason(
        hasOwn(choice, 'finish_reason')
          ? choice.finish_reason
          : undefined,
      ),
    );
    if (typeof choice.message.content === 'string') {
      assistantContentBytes += Buffer.byteLength(
        choice.message.content,
      );
    }
    if (!Array.isArray(choice.message.tool_calls)) continue;

    for (const toolCall of choice.message.tool_calls) {
      validateToolCall(toolCall);
      toolCallCount += 1;
      const functionName = toolCall.function.name as string;
      if (functionName === COMPAT_LIST_TOOLS) {
        listCalls += 1;
        continue;
      }
      if (MEMORY_ALIAS_TO_TOOL.has(functionName)) {
        memoryCalls += 1;
        continue;
      }
      if (functionName === COMPAT_CALL_TOOL) {
        const outer = parseFunctionArguments(
          toolCall.function.arguments,
        );
        if (
          hasOwn(outer, 'name') &&
          typeof outer.name === 'string' &&
          isMemoryToolName(outer.name)
        ) {
          memoryCalls += 1;
        } else {
          nonMemoryCalls += 1;
        }
        continue;
      }
      nonMemoryCalls += 1;
    }
  }

  const classification: ResponseClassification =
    memoryCalls > 0
      ? 'memory_alias_call'
      : listCalls > 0
        ? 'list_tools'
        : nonMemoryCalls > 0
          ? 'non_memory_call'
          : 'plain_completion';

  return {
    classification,
    choiceCount: input.choices.length,
    toolCallCount,
    assistantContentBytes,
    finishReasons,
  };
}

function emptyPlainCompletion(
  summary: CompletionAuditSummary,
): boolean {
  return (
    summary.classification === 'plain_completion' &&
    summary.toolCallCount === 0 &&
    summary.assistantContentBytes === 0
  );
}

function forceZeroRecallAbstention(
  input: JsonRecord,
  expectedModel = COMPAT_CHAT_MODEL,
): JsonRecord {
  validateChatCompletion(input, expectedModel);
  const body = structuredClone(input);
  for (const choice of body.choices as JsonRecord[]) {
    if (!isJsonRecord(choice.message)) continue;
    choice.message.content = '不知道。';
    delete choice.message.tool_calls;
    delete choice.message.function_call;
    choice.finish_reason = 'stop';
  }
  return body;
}

const GROUNDED_MEMORY_CONTRADICTION_PATTERNS = [
  /(?:看来|抱歉|目前)?(?:我)?(?:还)?(?:不知道|不清楚|无法确定)(?:这个问题)?(?:的答案)?/iu,
  /(?:根据|从).{0,24}(?:长期)?记忆.{0,80}(?:没|未|没有|并未)(?:能)?(?:找到|查到|检索到)/iu,
  /(?:没|未|没有|并未)(?:能)?(?:找到|查到|检索到).{0,80}(?:长期)?记忆/iu,
  /(?:<\/?tool_call>|\bmemory_(?:recall|get_context|list)\b)/iu,
] as const;

function completionContradictsGroundedRecall(
  input: JsonRecord,
  expectedModel = COMPAT_CHAT_MODEL,
): boolean {
  validateChatCompletion(input, expectedModel);
  return (input.choices as JsonRecord[]).some((choice) => {
    if (!isJsonRecord(choice.message)) return false;
    const content = choice.message.content;
    return typeof content === 'string' &&
      GROUNDED_MEMORY_CONTRADICTION_PATTERNS.some(
        (pattern) => pattern.test(content),
      );
  });
}

function forceGroundedMemoryAnswer(
  input: JsonRecord,
  facts: readonly string[],
  expectedModel = COMPAT_CHAT_MODEL,
): JsonRecord {
  validateChatCompletion(input, expectedModel);
  const body = structuredClone(input);
  const content = facts.length === 1
    ? `根据长期记忆：${facts[0]}`
    : `根据长期记忆：\n${facts.map((fact) => `- ${fact}`).join('\n')}`;
  for (const choice of body.choices as JsonRecord[]) {
    if (!isJsonRecord(choice.message)) continue;
    choice.message.content = content;
    delete choice.message.tool_calls;
    delete choice.message.function_call;
    choice.finish_reason = 'stop';
  }
  return body;
}

export function completionToSse(
  input: unknown,
  expectedModel = COMPAT_CHAT_MODEL,
): string {
  validateChatCompletion(input, expectedModel);

  const base = {
    id: hasOwn(input, 'id') ? input.id : undefined,
    object: 'chat.completion.chunk',
    created: hasOwn(input, 'created') ? input.created : undefined,
    model: input.model,
    system_fingerprint: hasOwn(input, 'system_fingerprint')
      ? input.system_fingerprint
      : undefined,
  };
  const firstChoices: JsonRecord[] = [];
  const finalChoices: JsonRecord[] = [];

  for (const rawChoice of input.choices) {
    if (!isJsonRecord(rawChoice) || !isJsonRecord(rawChoice.message)) {
      continue;
    }
    const index =
      hasOwn(rawChoice, 'index') &&
      typeof rawChoice.index === 'number'
        ? rawChoice.index
        : 0;
    const delta: JsonRecord = {
      role:
        hasOwn(rawChoice.message, 'role') &&
        typeof rawChoice.message.role === 'string'
          ? rawChoice.message.role
          : 'assistant',
    };
    if (hasOwn(rawChoice.message, 'content')) {
      delta.content = rawChoice.message.content;
    }
    if (Array.isArray(rawChoice.message.tool_calls)) {
      delta.tool_calls = rawChoice.message.tool_calls.map(
        (toolCall, toolIndex) => {
          if (!isJsonRecord(toolCall)) {
            throw new OllamaCompatibilityError(
              'Ollama 返回的 tool_calls 结构无效',
            );
          }
          return {
            ...toolCall,
            index:
              hasOwn(toolCall, 'index') &&
              typeof toolCall.index === 'number'
                ? toolCall.index
                : toolIndex,
          };
        },
      );
    }
    firstChoices.push({
      index,
      delta,
      finish_reason: null,
    });
    finalChoices.push({
      index,
      delta: {},
      finish_reason:
        hasOwn(rawChoice, 'finish_reason') &&
        rawChoice.finish_reason !== null &&
        rawChoice.finish_reason !== undefined
          ? rawChoice.finish_reason
          : 'stop',
    });
  }

  const first = { ...base, choices: firstChoices };
  const final = {
    ...base,
    choices: finalChoices,
    usage: hasOwn(input, 'usage') ? input.usage : undefined,
  };
  const body =
    `data: ${JSON.stringify(first)}\n\n` +
    `data: ${JSON.stringify(final)}\n\n` +
    'data: [DONE]\n\n';
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
    throw new OllamaCompatibilityError(
      'AIRI 代理响应超过 10 MB 限制',
    );
  }
  return body;
}

function isLoopback(address: string | undefined): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

const AIRI_IDENTITY_HEADER_NAMES = {
  contextVersion: 'x-memory-bridge-context-version',
  personaId: 'x-airi-character-id',
  sessionId: 'x-airi-session-id',
  roundId: 'x-airi-round-id',
  projectId: 'x-airi-project-id',
} as const;
function rawHeaderValues(
  request: IncomingMessage,
  headerName: string,
): string[] {
  const values: string[] = [];
  for (
    let index = 0;
    index < request.rawHeaders.length;
    index += 2
  ) {
    if (
      request.rawHeaders[index]?.toLowerCase() ===
      headerName
    ) {
      values.push(request.rawHeaders[index + 1] || '');
    }
  }
  return values;
}

function singleAiriIdentityHeader(
  request: IncomingMessage,
  headerName: string,
): string | null {
  const values = rawHeaderValues(request, headerName);
  if (values.length > 1) {
    throw new OllamaCompatibilityError(
      `AIRI 身份头 ${headerName} 不能重复`,
      400,
    );
  }
  if (values.length === 0) return null;
  const value = values[0].trim();
  if (!isClientIdentityId(value)) {
    throw new OllamaCompatibilityError(
      `AIRI 身份头 ${headerName} 格式无效`,
      400,
    );
  }
  return value;
}

export function resolveLifecycleRequestContext(
  request: IncomingMessage,
  principal: AuthenticatedPrincipalContext,
): LifecycleRequestContext {
  const contextVersion = singleAiriIdentityHeader(
    request,
    AIRI_IDENTITY_HEADER_NAMES.contextVersion,
  );
  const personaId = singleAiriIdentityHeader(
    request,
    AIRI_IDENTITY_HEADER_NAMES.personaId,
  );
  const sessionId = singleAiriIdentityHeader(
    request,
    AIRI_IDENTITY_HEADER_NAMES.sessionId,
  );
  const roundId = singleAiriIdentityHeader(
    request,
    AIRI_IDENTITY_HEADER_NAMES.roundId,
  );
  const projectId = singleAiriIdentityHeader(
    request,
    AIRI_IDENTITY_HEADER_NAMES.projectId,
  );
  if (contextVersion !== null && contextVersion !== '1') {
    throw new OllamaCompatibilityError(
      'AIRI 身份上下文版本不受支持',
      400,
    );
  }
  const versionAccepted = contextVersion === '1';
  const complete = Boolean(
    versionAccepted && personaId && sessionId && roundId,
  );
  return Object.freeze({
    principalId: principal.principalId,
    namespace: principal.namespace,
    credentialId: principal.credentialId,
    authSource: principal.authSource,
    ...(principal.trustedPrincipal
      ? { trustedPrincipal: principal.trustedPrincipal }
      : {}),
    personaId: versionAccepted ? personaId : null,
    sessionId: versionAccepted ? sessionId : null,
    roundId: versionAccepted ? roundId : null,
    projectId: versionAccepted ? projectId : null,
    identityStatus: complete ? 'complete' : 'degraded',
  });
}

async function readRequestJson(
  request: IncomingMessage,
): Promise<{ body: JsonRecord; bytes: number }> {
  const declaredLength = Number(request.headers['content-length']);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_BYTES
  ) {
    throw new OllamaCompatibilityError(
      'AIRI 代理请求不能超过 5 MB',
      413,
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new OllamaCompatibilityError(
        'AIRI 代理请求不能超过 5 MB',
        413,
      );
    }
    chunks.push(buffer);
  }
  try {
    const parsed = parseJson(
      Buffer.concat(chunks).toString('utf8'),
    );
    if (!isJsonRecord(parsed)) throw new Error('not an object');
    return { body: parsed, bytes: total };
  } catch {
    throw new OllamaCompatibilityError(
      'AIRI 代理请求不是有效的 JSON 对象',
      400,
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('AIRI 客户端已断开');
}

function declaredResponseLength(upstream: Response): number | undefined {
  const value = upstream.headers.get('content-length');
  if (value === null) return undefined;
  const length = Number(value);
  return Number.isFinite(length) && length >= 0
    ? length
    : undefined;
}

async function cancelReaderOnAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  operation: () => Promise<void>,
): Promise<void> {
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAborted(signal);
    await operation();
    throwIfAborted(signal);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readLimitedResponse(
  upstream: Response,
  signal: AbortSignal,
): Promise<Buffer> {
  const declaredLength = declaredResponseLength(upstream);
  if (
    declaredLength !== undefined &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new OllamaCompatibilityError(
      'Ollama 响应超过 10 MB 限制',
    );
  }
  if (!upstream.body) {
    throwIfAborted(signal);
    return Buffer.alloc(0);
  }
  const reader = upstream.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  await cancelReaderOnAbort(reader, signal, async () => {
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      const buffer = Buffer.from(value);
      total += buffer.length;
      if (total > MAX_RESPONSE_BYTES) {
        throw new OllamaCompatibilityError(
          'Ollama 响应超过 10 MB 限制',
        );
      }
      chunks.push(buffer);
    }
  });
  return Buffer.concat(chunks);
}

function waitForDrain(
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const succeed = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => succeed();
    const onClose = () => fail(new Error('AIRI 客户端已断开'));
    const onError = (error: Error) => fail(error);
    const onAbort = () =>
      fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('AIRI 客户端已断开'),
      );

    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (response.destroyed || response.writableEnded) onClose();
    else if (signal.aborted) onAbort();
  });
}

async function writeResponseChunk(
  response: ServerResponse,
  chunk: Buffer | string,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (response.destroyed || response.writableEnded) {
    throw new Error('AIRI 客户端已断开');
  }
  if (!response.write(chunk)) {
    await waitForDrain(response, signal);
  }
}

async function pipeResponse(
  upstream: Response,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  const declaredLength = declaredResponseLength(upstream);
  if (
    declaredLength !== undefined &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new OllamaCompatibilityError(
      'Ollama 响应超过 10 MB 限制',
    );
  }
  response.writeHead(upstream.status, {
    'Content-Type':
      upstream.headers.get('content-type') ||
      'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (!upstream.body) {
    throwIfAborted(signal);
    response.end();
    return;
  }
  const reader = upstream.body.getReader();
  let total = 0;
  await cancelReaderOnAbort(reader, signal, async () => {
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      const buffer = Buffer.from(value);
      total += buffer.length;
      if (total > MAX_RESPONSE_BYTES) {
        throw new OllamaCompatibilityError(
          'Ollama 响应超过 10 MB 限制',
        );
      }
      await writeResponseChunk(response, buffer, signal);
    }
  });
  response.end();
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  const length = Buffer.byteLength(body);
  if (length > MAX_RESPONSE_BYTES) {
    throw new OllamaCompatibilityError(
      'AIRI 代理响应超过 10 MB 限制',
    );
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function endDelivered(
  response: ServerResponse,
  body: string | Buffer,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      response.off('close', onClose);
      response.off('error', onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => {
      if (!response.writableFinished) {
        finish(new Error('AIRI 客户端在响应完成前断开'));
      }
    };
    const onError = (error: Error) => finish(error);
    response.once('close', onClose);
    response.once('error', onError);
    try {
      throwIfAborted(signal);
      response.end(body, () => {
        try {
          throwIfAborted(signal);
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function sendJsonDelivered(
  response: ServerResponse,
  status: number,
  value: unknown,
  signal: AbortSignal,
): Promise<number> {
  const body = JSON.stringify(value);
  const length = Buffer.byteLength(body);
  if (length > MAX_RESPONSE_BYTES) {
    throw new OllamaCompatibilityError(
      'AIRI 代理响应超过 10 MB 限制',
    );
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': length,
    'Cache-Control': 'no-store',
  });
  await endDelivered(response, body, signal);
  return length;
}

function sendBuffer(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
): void {
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new OllamaCompatibilityError(
      'AIRI 代理响应超过 10 MB 限制',
    );
  }
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function safeUpstreamUrl(baseUrl: string, pathname: string): URL {
  const base = new URL(baseUrl);
  if (
    base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
      base.hostname,
    )
  ) {
    throw new OllamaCompatibilityError(
      'AIRI 代理上游必须是本机 HTTP Ollama',
      500,
    );
  }
  return new URL(pathname, `${base.origin}/`);
}

async function withUpstream<T>(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  init: RequestInit,
  options: OllamaProxyOptions,
  consume: (
    upstream: Response,
    signal: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let clientClosed = false;
  const abort = (reason: Error) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onRequestAborted = () => {
    clientClosed = true;
    abort(new Error('AIRI 客户端已中止请求'));
  };
  const onResponseClose = () => {
    if (response.writableFinished) return;
    clientClosed = true;
    abort(new Error('AIRI 客户端已断开'));
  };
  const timeout = setTimeout(
    () => {
      timedOut = true;
      abort(new Error('等待本机 Ollama 响应超时'));
    },
    options.timeoutMs ?? 120_000,
  );
  timeout.unref();
  request.once('aborted', onRequestAborted);
  response.once('close', onResponseClose);
  if (request.aborted) onRequestAborted();
  if (response.destroyed && !response.writableFinished) {
    onResponseClose();
  }

  try {
    throwIfAborted(controller.signal);
    const upstream = await (options.fetchImpl ?? fetch)(url, {
      ...init,
      signal: controller.signal,
      redirect: 'error',
    });
    return await consume(upstream, controller.signal);
  } catch (error) {
    if (error instanceof OllamaCompatibilityError) throw error;
    if (clientClosed) throw error;
    if (timedOut) {
      throw new OllamaCompatibilityError(
        '等待本机 Ollama 响应超时',
        504,
      );
    }
    const message =
      error instanceof Error ? error.message : '未知网络错误';
    throw new OllamaCompatibilityError(
      `无法连接本机 Ollama：${message}`,
    );
  } finally {
    clearTimeout(timeout);
    request.off('aborted', onRequestAborted);
    response.off('close', onResponseClose);
  }
}

function validateSseChunk(
  value: unknown,
  expectedModel = COMPAT_CHAT_MODEL,
): void {
  if (
    !isJsonRecord(value) ||
    !hasOwn(value, 'model') ||
    value.model !== expectedModel ||
    !hasOwn(value, 'choices') ||
    !Array.isArray(value.choices)
  ) {
    throw new OllamaCompatibilityError(
      `Ollama 流式响应仅允许模型 ${expectedModel}`,
    );
  }
  for (const choice of value.choices) {
    if (!isJsonRecord(choice)) {
      throw new OllamaCompatibilityError(
        'Ollama 流式响应 choice 结构无效',
      );
    }
    if (!hasOwn(choice, 'delta')) continue;
    if (!isJsonRecord(choice.delta)) {
      throw new OllamaCompatibilityError(
        'Ollama 流式响应 delta 结构无效',
      );
    }
    if (!hasOwn(choice.delta, 'tool_calls')) continue;
    if (
      !Array.isArray(choice.delta.tool_calls) ||
      !choice.delta.tool_calls.every(isJsonRecord)
    ) {
      throw new OllamaCompatibilityError(
        'Ollama 流式响应 tool_calls 结构无效',
      );
    }
  }
}

async function pipeValidatedSse(
  upstream: Response,
  response: ServerResponse,
  signal: AbortSignal,
  expectedModel = COMPAT_CHAT_MODEL,
): Promise<number> {
  const declaredLength = declaredResponseLength(upstream);
  if (
    declaredLength !== undefined &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new OllamaCompatibilityError(
      'Ollama 响应超过 10 MB 限制',
    );
  }
  if (!upstream.body) {
    throw new OllamaCompatibilityError(
      'Ollama 流式响应没有响应体',
    );
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let textBuffer = '';
  let eventLines: string[] = [];
  let inputBytes = 0;
  let outputBytes = 0;
  let headersSent = false;
  let sawDone = false;

  const sendEvent = async () => {
    if (eventLines.length === 0) return;
    const data = eventLines
      .filter((line) => line === 'data' || line.startsWith('data:'))
      .map((line) => {
        if (line === 'data') return '';
        const value = line.slice('data:'.length);
        return value.startsWith(' ') ? value.slice(1) : value;
      })
      .join('\n');
    if (data === '[DONE]') {
      sawDone = true;
    } else if (data.length > 0) {
      let parsed: unknown;
      try {
        parsed = parseJson(data);
      } catch {
        throw new OllamaCompatibilityError(
          'Ollama 返回了无效 SSE JSON',
        );
      }
      validateSseChunk(parsed, expectedModel);
    }

    const serialized = `${eventLines.join('\n')}\n\n`;
    outputBytes += Buffer.byteLength(serialized);
    if (outputBytes > MAX_RESPONSE_BYTES) {
      throw new OllamaCompatibilityError(
        'AIRI 代理响应超过 10 MB 限制',
      );
    }
    if (!headersSent) {
      response.writeHead(upstream.status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      headersSent = true;
    }
    await writeResponseChunk(response, serialized, signal);
    eventLines = [];
  };

  const processLines = async (final: boolean) => {
    while (true) {
      const match = /[\r\n]/u.exec(textBuffer);
      if (!match) break;
      const index = match.index;
      const delimiter = textBuffer[index];
      if (
        delimiter === '\r' &&
        index === textBuffer.length - 1 &&
        !final
      ) {
        break;
      }
      const consume =
        delimiter === '\r' && textBuffer[index + 1] === '\n'
          ? 2
          : 1;
      const line = textBuffer.slice(0, index);
      textBuffer = textBuffer.slice(index + consume);
      if (line.length === 0) await sendEvent();
      else eventLines.push(line);
      if (sawDone) return;
    }
  };

  await cancelReaderOnAbort(reader, signal, async () => {
    while (!sawDone) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        textBuffer += decoder.decode();
        await processLines(true);
        break;
      }
      inputBytes += value.byteLength;
      if (inputBytes > MAX_RESPONSE_BYTES) {
        throw new OllamaCompatibilityError(
          'Ollama 响应超过 10 MB 限制',
        );
      }
      textBuffer += decoder.decode(value, { stream: true });
      await processLines(false);
    }
    if (sawDone) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    if (textBuffer.length > 0 || eventLines.length > 0) {
      throw new OllamaCompatibilityError(
        'Ollama 流式响应意外中断',
      );
    }
    throw new OllamaCompatibilityError(
      'Ollama 流式响应缺少 [DONE]',
    );
  });
  response.end();
  return outputBytes;
}

async function proxyModels(
  request: IncomingMessage,
  response: ServerResponse,
  options: OllamaProxyOptions,
): Promise<void> {
  const expectedModel = configuredChatModel(options);
  await withUpstream(
    request,
    response,
    safeUpstreamUrl(options.upstreamBaseUrl, '/v1/models'),
    { method: 'GET' },
    options,
    async (upstream, signal) => {
      if (!upstream.ok) {
        await pipeResponse(upstream, response, signal);
        return;
      }
      const raw = await readLimitedResponse(upstream, signal);
      let payload: JsonRecord;
      try {
        const parsed = parseJson(raw.toString('utf8'));
        if (
          !isJsonRecord(parsed) ||
          !hasOwn(parsed, 'data') ||
          !Array.isArray(parsed.data)
        ) {
          throw new Error('invalid models response');
        }
        payload = parsed;
      } catch {
        throw new OllamaCompatibilityError(
          'Ollama 模型列表响应无效',
        );
      }

      const canonicalModels: JsonRecord[] = [];
      for (const entry of payload.data as unknown[]) {
        if (!isJsonRecord(entry)) continue;
        const hasId = hasOwn(entry, 'id');
        const hasModel = hasOwn(entry, 'model');
        if (
          (!hasId && !hasModel) ||
          (hasId && typeof entry.id !== 'string') ||
          (hasModel && typeof entry.model !== 'string') ||
          (hasId && hasModel && entry.id !== entry.model)
        ) {
          continue;
        }
        const identifier = hasId ? entry.id : entry.model;
        if (
          identifier !== expectedModel ||
          canonicalModels.length > 0
        ) {
          continue;
        }
        const canonical: JsonRecord = {
          ...entry,
          id: expectedModel,
        };
        if (hasModel) canonical.model = expectedModel;
        canonicalModels.push(canonical);
      }
      payload.data = canonicalModels;
      sendJson(response, 200, payload);
    },
  );
}

async function proxyChat(
  request: IncomingMessage,
  response: ServerResponse,
  options: OllamaProxyOptions,
): Promise<void> {
  const expectedModel = configuredChatModel(options);
  const requestId = randomUUID();
  response.setHeader('x-memory-bridge-request-id', requestId);
  const declaredLength = Number(request.headers['content-length']);
  let requestBytes =
    Number.isFinite(declaredLength) && declaredLength >= 0
      ? declaredLength
      : 0;
  let responseBytes = 0;
  let upstreamBytes = 0;
  let downstreamBytes = 0;
  let model = 'rejected';
  let result = 'success';
  let lifecycleTraceId: string | null = null;

  try {
    const lifecycleIdentity = options.authenticatedPrincipal
      ? resolveLifecycleRequestContext(
          request,
          options.authenticatedPrincipal,
        )
      : undefined;
    const requestBody = await readRequestJson(request);
    const original = requestBody.body;
    delete original[MEMORY_INTERNAL_CONTEXT_KEY];
    delete original[MEMORY_INTERNAL_FACTS_KEY];
    delete original[MEMORY_INTERNAL_CONTEXT_REASON_KEY];
    delete original[MEMORY_INTERNAL_TRACE_ID_KEY];
    requestBytes = requestBody.bytes;
    if (
      !hasOwn(original, 'model') ||
      original.model !== expectedModel
    ) {
      throw new OllamaCompatibilityError(
        `AIRI 聊天仅允许使用 ${expectedModel}`,
        400,
      );
    }
    model = expectedModel;

    const requestedStream =
      hasOwn(original, 'stream') && original.stream === true;
    let lifecycleRequest = original;
    if (options.lifecycle) {
      try {
        const prepared = await options.lifecycle.beforeModel(
          structuredClone(original),
          requestId,
          lifecycleIdentity,
        );
        if (!isJsonRecord(prepared)) {
          throw new Error('生命周期适配器返回了无效请求');
        }
        lifecycleRequest = prepared;
        emitAudit(options, {
          action: 'memory_lifecycle',
          requestId,
          model,
          result: 'before_model_completed',
          requestBytes,
          responseBytes,
        });
      } catch (error) {
        emitAudit(options, {
          action: 'memory_lifecycle',
          requestId,
          model,
          result: 'before_model_failed',
          requestBytes,
          responseBytes,
        });
        if (
          error instanceof ConversationIdentityConflictError ||
          error instanceof IdentityBindingConflictError
        ) {
          throw new OllamaCompatibilityError(
            error.message,
            409,
          );
        }
      }
    }
    if (
      !hasOwn(lifecycleRequest, 'model') ||
      lifecycleRequest.model !== expectedModel
    ) {
      throw new OllamaCompatibilityError(
        '生命周期适配器不得更改 AIRI 聊天模型',
      );
    }
    const rawLifecycleContextState =
      lifecycleRequest[MEMORY_INTERNAL_CONTEXT_KEY];
    const lifecycleContextState =
      rawLifecycleContextState === 'grounded' ||
        rawLifecycleContextState === 'empty'
        ? rawLifecycleContextState
        : null;
    const rawLifecycleGroundedFacts =
      lifecycleRequest[MEMORY_INTERNAL_FACTS_KEY];
    const rawLifecycleContextReason =
      lifecycleRequest[MEMORY_INTERNAL_CONTEXT_REASON_KEY];
    const rawLifecycleTraceId =
      lifecycleRequest[MEMORY_INTERNAL_TRACE_ID_KEY];
    const lifecycleContextReason: MemoryContextReason | null =
      rawLifecycleContextReason === 'explicit_query' ||
        rawLifecycleContextReason === 'private_fact_query'
        ? rawLifecycleContextReason
        : null;
    lifecycleTraceId =
      typeof rawLifecycleTraceId === 'string' &&
        UUID_PATTERN.test(rawLifecycleTraceId)
        ? rawLifecycleTraceId
        : null;
    if (lifecycleTraceId) {
      response.setHeader(
        'x-memory-bridge-trace-id',
        lifecycleTraceId,
      );
    }
    const lifecycleGroundedFacts = Array.isArray(
      rawLifecycleGroundedFacts,
    )
      ? rawLifecycleGroundedFacts.flatMap((value) => {
          if (typeof value !== 'string') return [];
          const fact = value.replace(/\s+/gu, ' ').trim().slice(0, 2_000);
          return fact ? [fact] : [];
        }).slice(0, 8)
      : [];
    delete lifecycleRequest[MEMORY_INTERNAL_CONTEXT_KEY];
    delete lifecycleRequest[MEMORY_INTERNAL_FACTS_KEY];
    delete lifecycleRequest[MEMORY_INTERNAL_CONTEXT_REASON_KEY];
    delete lifecycleRequest[MEMORY_INTERNAL_TRACE_ID_KEY];
    const rewritten = rewriteChatRequest(lifecycleRequest);
    if (options.lifecycle) {
      suppressLifecycleMemoryAliases(
        rewritten.body,
        lifecycleContextState,
      );
    }
    const offeredTools = Array.isArray(rewritten.body.tools)
      ? rewritten.body.tools
      : [];
    const offeredToolNames = new Set(
      offeredTools.flatMap((tool) => {
        const name = toolFunctionName(tool);
        return name === undefined ? [] : [name];
      }),
    );
    const offeredToolCount = offeredTools.length;
    const memoryAliasCount = offeredTools.filter((tool) => {
      const name = toolFunctionName(tool);
      return (
        name !== undefined &&
        MEMORY_ALIAS_TO_TOOL.has(name)
      );
    }).length;
    if (rewritten.adapted) {
      emitAudit(options, {
        action: 'schema_rewrite',
        requestId,
        model,
        result: 'rewritten',
        requestBytes,
        responseBytes,
        offeredToolCount,
        memoryAliasCount,
      });
    }
    const inspectResponse =
      rewritten.adapted || options.lifecycle !== undefined;
    const upstreamBody = inspectResponse
      ? { ...rewritten.body, stream: false }
      : rewritten.body;
    const chatUpstreamUrl = safeUpstreamUrl(
      options.upstreamBaseUrl,
      '/v1/chat/completions',
    );
    await withUpstream(
      request,
      response,
      chatUpstreamUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upstreamBody),
      },
      options,
      async (upstream, signal) => {
        if (!upstream.ok) {
          responseBytes = declaredResponseLength(upstream) ?? 0;
          upstreamBytes = responseBytes;
          result = `upstream_${upstream.status}`;
          await pipeResponse(upstream, response, signal);
          try {
            await options.lifecycle?.cancelTurn?.(requestId);
          } catch {
            // 上游错误响应已经交付，生命周期清理失败不能覆盖它。
          }
          return;
        }

        if (!inspectResponse) {
          const contentType =
            upstream.headers.get('content-type') ||
            'application/octet-stream';
          if (/text\/event-stream/iu.test(contentType)) {
            responseBytes = await pipeValidatedSse(
              upstream,
            response,
            signal,
            expectedModel,
            );
            downstreamBytes = responseBytes;
            return;
          }
          const raw = await readLimitedResponse(upstream, signal);
          responseBytes = raw.length;
          upstreamBytes = raw.length;
          downstreamBytes = raw.length;
          let parsed: unknown;
          try {
            parsed = parseJson(raw.toString('utf8'));
          } catch {
            throw new OllamaCompatibilityError(
              'Ollama 返回了无效 JSON',
            );
          }
          validateChatCompletion(parsed, expectedModel);
          sendBuffer(response, 200, contentType, raw);
          return;
        }

        const raw = await readLimitedResponse(upstream, signal);
        responseBytes = raw.length;
        upstreamBytes = raw.length;
        let parsed: unknown;
        try {
          parsed = parseJson(raw.toString('utf8'));
        } catch {
          throw new OllamaCompatibilityError(
            'Ollama 返回了无效 JSON',
          );
        }
        const normalizeCompletion = (
          value: unknown,
          allowedToolNames: ReadonlySet<string>,
        ): JsonRecord => {
          if (!rewritten.adapted) {
            validateChatCompletion(value, expectedModel);
            return structuredClone(value);
          }
          validateCompletionUsesOfferedTools(
            value,
            allowedToolNames,
            expectedModel,
          );
          const completion = rewriteChatResponse(
            value,
            (action, detail) => {
              emitAudit(options, {
                action,
                requestId,
                model,
                result:
                  action === 'memory_args_normalized'
                    ? 'normalized'
                    : action === 'response_tool_call_rewritten'
                      ? 'rewritten'
                      : 'rejected_shape',
                requestBytes,
                responseBytes,
                toolName: detail.toolName,
                argumentKeys: detail.argumentKeys,
                argumentsPresent: detail.argumentsPresent,
                argumentsType: detail.argumentsType,
              });
            },
            expectedModel,
          );
          attachMemoryRequestKeys(
            completion,
            requestId,
            expectedModel,
          );
          return completion;
        };
        let normalized = normalizeCompletion(
          parsed,
          offeredToolNames,
        );
        let summary = classifyChatCompletion(
          normalized,
          expectedModel,
        );
        if (emptyPlainCompletion(summary)) {
          emitAudit(options, {
            action: 'empty_completion_retry',
            requestId,
            model,
            result: 'started',
            requestBytes,
            responseBytes,
            offeredToolCount,
            memoryAliasCount,
          });
          const retryBody = structuredClone(upstreamBody);
          retryBody.tools = [];
          retryBody.tool_choice = 'none';
          if (Array.isArray(retryBody.messages)) {
            let latestUserIndex = retryBody.messages.length;
            for (
              let index = retryBody.messages.length - 1;
              index >= 0;
              index -= 1
            ) {
              const message = retryBody.messages[index];
              if (isJsonRecord(message) && message.role === 'user') {
                latestUserIndex = index;
                break;
              }
            }
            retryBody.messages.splice(latestUserIndex, 0, {
              role: 'system',
              content:
                '[AIRI 空回复恢复] 上一次生成没有正文。' +
                '本次必须直接返回非空的文字答案，不得调用工具。',
            });
          }
          const retryResponse = await (options.fetchImpl ?? fetch)(
            chatUpstreamUrl,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(retryBody),
              signal,
              redirect: 'error',
            },
          );
          if (!retryResponse.ok) {
            await retryResponse.body?.cancel().catch(() => undefined);
            throw new OllamaCompatibilityError(
              `本机 Ollama 空回复重试失败：HTTP ${retryResponse.status}`,
            );
          }
          const retryRaw = await readLimitedResponse(
            retryResponse,
            signal,
          );
          upstreamBytes += retryRaw.length;
          responseBytes = retryRaw.length;
          let retryParsed: unknown;
          try {
            retryParsed = parseJson(retryRaw.toString('utf8'));
          } catch {
            throw new OllamaCompatibilityError(
              '本机 Ollama 空回复重试返回了无效 JSON',
            );
          }
          normalized = normalizeCompletion(
            retryParsed,
            new Set<string>(),
          );
          summary = classifyChatCompletion(
            normalized,
            expectedModel,
          );
          if (emptyPlainCompletion(summary)) {
            throw new OllamaCompatibilityError(
              '本机 Ollama 连续两次返回空回复',
            );
          }
          emitAudit(options, {
            action: 'empty_completion_retry',
            requestId,
            model,
            result: 'recovered',
            requestBytes,
            responseBytes,
            offeredToolCount: 0,
            memoryAliasCount: 0,
          });
        }
        if (lifecycleContextState === 'empty') {
          normalized = forceZeroRecallAbstention(
            normalized,
            expectedModel,
          );
          summary = classifyChatCompletion(
            normalized,
            expectedModel,
          );
          emitAudit(options, {
            action: 'zero_recall_abstention',
            requestId,
            model,
            result: 'forced',
            requestBytes,
            responseBytes,
            offeredToolCount,
            memoryAliasCount,
            choiceCount: summary.choiceCount,
            toolCallCount: summary.toolCallCount,
            assistantContentBytes: summary.assistantContentBytes,
            finishReasons: summary.finishReasons,
            memoryContextReason: lifecycleContextReason || undefined,
            retrievalTraceId: lifecycleTraceId || undefined,
          });
        } else if (
          lifecycleContextState === 'grounded' &&
          lifecycleGroundedFacts.length > 0 &&
          (
            lifecycleContextReason === 'private_fact_query' ||
            completionContradictsGroundedRecall(
              normalized,
              expectedModel,
            )
          )
        ) {
          normalized = forceGroundedMemoryAnswer(
            normalized,
            lifecycleGroundedFacts,
            expectedModel,
          );
          summary = classifyChatCompletion(
            normalized,
            expectedModel,
          );
          emitAudit(options, {
            action: 'grounded_recall_repair',
            requestId,
            model,
            result: 'forced',
            requestBytes,
            responseBytes,
            offeredToolCount,
            memoryAliasCount,
            choiceCount: summary.choiceCount,
            toolCallCount: summary.toolCallCount,
            assistantContentBytes: summary.assistantContentBytes,
            finishReasons: summary.finishReasons,
            memoryContextReason: lifecycleContextReason || undefined,
            retrievalTraceId: lifecycleTraceId || undefined,
          });
        }
        const completeLifecycle = async () => {
          if (!options.lifecycle) return;
          try {
            await options.lifecycle.afterTurn(
              structuredClone(lifecycleRequest),
              structuredClone(normalized),
              requestId,
              lifecycleIdentity,
            );
            emitAudit(options, {
              action: 'memory_lifecycle',
              requestId,
              model,
              result: 'after_turn_completed',
              requestBytes,
              responseBytes,
            });
          } catch {
            emitAudit(options, {
              action: 'memory_lifecycle',
              requestId,
              model,
              result: 'after_turn_failed',
              requestBytes,
              responseBytes,
            });
          }
        };
        if (!requestedStream) {
          responseBytes = Buffer.byteLength(
            JSON.stringify(normalized),
          );
          downstreamBytes = responseBytes;
          emitAudit(options, {
            action: 'response_classification',
            requestId,
            model,
            result: summary.classification,
            requestBytes,
            responseBytes,
            requestedStream,
            responseMode: 'json',
            upstreamBytes,
            downstreamBytes,
            offeredToolCount,
            memoryAliasCount,
            choiceCount: summary.choiceCount,
            toolCallCount: summary.toolCallCount,
            assistantContentBytes:
              summary.assistantContentBytes,
            finishReasons: summary.finishReasons,
          });
          await sendJsonDelivered(
            response,
            200,
            normalized,
            signal,
          );
          await completeLifecycle();
          return;
        }

        const body = completionToSse(normalized, expectedModel);
        responseBytes = Buffer.byteLength(body);
        downstreamBytes = responseBytes;
        emitAudit(options, {
          action: 'response_classification',
          requestId,
          model,
          result: summary.classification,
          requestBytes,
          responseBytes,
          requestedStream,
          responseMode: 'sse_replay',
          upstreamBytes,
          downstreamBytes,
          offeredToolCount,
          memoryAliasCount,
          choiceCount: summary.choiceCount,
          toolCallCount: summary.toolCallCount,
          assistantContentBytes: summary.assistantContentBytes,
          finishReasons: summary.finishReasons,
        });
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        await endDelivered(response, body, signal);
        await completeLifecycle();
      },
    );
    emitAudit(options, {
      action: 'proxy_result',
      requestId,
      model,
      result,
      requestBytes,
      responseBytes,
      upstreamBytes,
      downstreamBytes,
      retrievalTraceId: lifecycleTraceId || undefined,
    });
  } catch (error) {
    try {
      await options.lifecycle?.cancelTurn?.(requestId);
    } catch {
      // 失败清理不能覆盖代理的原始错误。
    }
    emitAudit(options, {
      action: 'proxy_result',
      requestId,
      model,
      result:
        request.aborted || response.destroyed
          ? 'client_closed'
          : error instanceof OllamaCompatibilityError
            ? `error_${error.status}`
            : 'error',
      requestBytes,
      responseBytes,
      upstreamBytes,
      downstreamBytes,
      retrievalTraceId: lifecycleTraceId || undefined,
    });
    throw error;
  }
}

export async function handleOllamaCompatibilityProxy(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: OllamaProxyOptions,
): Promise<boolean> {
  if (!url.pathname.startsWith(`${OLLAMA_COMPAT_PREFIX}/`)) {
    return false;
  }
  if (!isLoopback(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: 'AIRI 代理仅允许本机访问' });
    return true;
  }

  try {
    if (
      request.method === 'GET' &&
      url.pathname === `${OLLAMA_COMPAT_PREFIX}/v1/models`
    ) {
      await proxyModels(request, response, options);
      return true;
    }
    if (
      request.method === 'POST' &&
      url.pathname ===
        `${OLLAMA_COMPAT_PREFIX}/v1/chat/completions`
    ) {
      await proxyChat(request, response, options);
      return true;
    }
    sendJson(response, 404, {
      error: 'AIRI 代理仅提供 /v1/models 和 /v1/chat/completions',
    });
    return true;
  } catch (error) {
    if (response.destroyed || response.headersSent) {
      if (!response.destroyed) {
        response.destroy(error instanceof Error ? error : undefined);
      }
      return true;
    }
    const status =
      error instanceof OllamaCompatibilityError
        ? error.status
        : 502;
    const message =
      error instanceof Error ? error.message : 'AIRI 代理失败';
    sendJson(response, status, { error: message });
    return true;
  }
}
